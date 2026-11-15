import type { User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from '../constants';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  ReportStatus,
  StationId,
  TeamMember,
  Workspace,
  Workstation,
} from '../types';
import { clampNumber, clampString } from './shared';

export class ConcurrencyConflictError extends Error {
  readonly reason: 'completed_locked' | 'concurrent_create' | 'concurrent_update';
  readonly serverUpdatedByName?: string;
  readonly serverStatus?: ReportStatus;

  constructor(
    message: string,
    reason: 'completed_locked' | 'concurrent_create' | 'concurrent_update',
    details?: { serverUpdatedByName?: string; serverStatus?: ReportStatus },
  ) {
    super(message);
    this.name = 'ConcurrencyConflictError';
    this.reason = reason;
    this.serverUpdatedByName = details?.serverUpdatedByName;
    this.serverStatus = details?.serverStatus;
  }
}

export class DiagnosticSaveError extends Error {
  readonly title: string;
  readonly detail: string;
  readonly failedDocumentPath: string;
  readonly code?: string;

  constructor(params: {
    title: string;
    detail: string;
    failedDocumentPath: string;
    code?: string;
  }) {
    super(`${params.title}: ${params.detail}`);
    this.name = 'DiagnosticSaveError';
    this.title = params.title;
    this.detail = params.detail;
    this.failedDocumentPath = params.failedDocumentPath;
    this.code = params.code;
  }
}

export function evaluateReportSaveGuard(params: {
  mode: 'opening' | 'closing';
  canManage: boolean;
  expectedUpdatedAtMs?: number | null;
  forceOverwrite?: boolean;
  serverExists: boolean;
  serverStatus?: ReportStatus;
  serverUpdatedAtMs?: number | null;
  serverUpdatedByName?: string;
}):
  | {
      ok: true;
      effectiveStatus: ReportStatus;
    }
  | {
      ok: false;
      reason: 'completed_locked' | 'concurrent_create' | 'concurrent_update';
      message: string;
    } {
  const {
    mode,
    canManage,
    expectedUpdatedAtMs,
    forceOverwrite,
    serverExists,
    serverStatus,
    serverUpdatedAtMs,
    serverUpdatedByName,
  } = params;

  const requestedStatus: ReportStatus = mode === 'closing' ? 'completed' : 'opening_saved';

  if (serverExists && serverStatus === 'completed') {
    if (!canManage) {
      return {
        ok: false,
        reason: 'completed_locked',
        message:
          'Este cierre ya fue enviado al jefe. Pídele que reabra la planilla si necesitas corregirlo.',
      };
    }
  }

  const effectiveStatus: ReportStatus =
    serverExists && serverStatus === 'completed' ? 'completed' : requestedStatus;

  if (!forceOverwrite && expectedUpdatedAtMs !== undefined) {
    if (expectedUpdatedAtMs === null && serverExists) {
      return {
        ok: false,
        reason: 'concurrent_create',
        message: `${serverUpdatedByName || 'Otra persona'} acaba de guardar esta planilla desde otro dispositivo. Revisa los cambios antes de sobrescribir.`,
      };
    }

    if (
      typeof expectedUpdatedAtMs === 'number' &&
      serverExists &&
      typeof serverUpdatedAtMs === 'number' &&
      serverUpdatedAtMs !== expectedUpdatedAtMs
    ) {
      return {
        ok: false,
        reason: 'concurrent_update',
        message: `${serverUpdatedByName || 'Otra persona'} actualizó esta planilla después de que la abriste. Revisa los cambios o confirma si deseas sobrescribir.`,
      };
    }
  }

  return {
    ok: true,
    effectiveStatus,
  };
}

export async function loadWorkerStationFallback(params: {
  workspaceId: string;
  stationId: string;
  dateStr: string;
}): Promise<{
  station: Workstation | null;
  items: InventoryItem[];
  report: DailyReport | undefined;
  entries: Record<string, DailyReportEntry>;
}> {
  const { workspaceId, stationId, dateStr } = params;
  try {
    const stSnap = await getDoc(doc(db, 'stations', stationId));
    const station = stSnap.exists()
      ? ({ id: stSnap.id, ...stSnap.data() } as Workstation)
      : null;

    const itemIdsToFetch: string[] = [];
    if (station && Array.isArray(station.assignedItemIds)) {
      station.assignedItemIds.forEach((id) => {
        if (id && !itemIdsToFetch.includes(id)) {
          itemIdsToFetch.push(id);
        }
      });
    } else {
      const maxSlot = station ? Math.min(200, station.nextItemSlot) : 40;
      for (let slot = 1; slot < maxSlot; slot++) {
        itemIdsToFetch.push(`${stationId}_${slot}`);
      }
    }

    const itemPromises = itemIdsToFetch.map((id) =>
      getDoc(doc(db, 'items', id)).then((snap) =>
        snap.exists() ? ({ id: snap.id, ...snap.data() } as InventoryItem) : null,
      ),
    );
    const fetchedItems = (await Promise.all(itemPromises)).filter(
      (it): it is InventoryItem => Boolean(it && it.active && it.station === stationId),
    );
    fetchedItems.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    const reportId = `${workspaceId}_${dateStr}_${stationId}`;
    const repSnap = await getDoc(doc(db, 'dailyReports', reportId));
    const report = repSnap.exists()
      ? ({ id: repSnap.id, ...repSnap.data() } as DailyReport)
      : undefined;

    const entries: Record<string, DailyReportEntry> = {};
    if (report) {
      const entrySnaps = await Promise.all(
        fetchedItems.map((it) =>
          getDoc(doc(db, 'dailyReports', reportId, 'entries', it.id)),
        ),
      );
      entrySnaps.forEach((snap) => {
        if (snap.exists()) {
          const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
          entries[entry.itemId] = entry;
        }
      });
    }

    return { station, items: fetchedItems, report, entries };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `stations/${stationId}`);
  }
}

export async function fetchStationEntriesOnce(
  workspaceId: string,
  dateStr: string,
  station: StationId,
  itemIds: string[],
): Promise<Record<string, DailyReportEntry>> {
  const reportId = `${workspaceId}_${dateStr}_${station}`;
  const path = `dailyReports/${reportId}`;
  try {
    const repSnap = await getDoc(doc(db, 'dailyReports', reportId));
    if (!repSnap.exists()) return {};

    const snaps = await Promise.all(
      itemIds.map((itemId) => getDoc(doc(db, 'dailyReports', reportId, 'entries', itemId))),
    );
    const map: Record<string, DailyReportEntry> = {};
    snaps.forEach((snap) => {
      if (snap.exists()) {
        const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
        map[entry.itemId] = entry;
      }
    });
    return map;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveStationReportBatch(params: {
  workspace: Workspace;
  user: User;
  canManage: boolean;
  date: string;
  station: StationId;
  mode: 'opening' | 'closing';
  notes: string;
  rows: DraftEntryRow[];
  existingReport: DailyReport | undefined;
  existingEntries: Record<string, DailyReportEntry>;
  expectedUpdatedAtMs?: number | null;
  forceOverwrite?: boolean;
}): Promise<{ queuedOffline: boolean }> {
  const {
    workspace,
    user,
    canManage,
    date,
    station,
    mode,
    notes,
    rows,
    existingReport,
    existingEntries,
    expectedUpdatedAtMs,
    forceOverwrite,
  } = params;
  const reportId = `${workspace.id}_${date}_${station}`;
  const reporterName = clampString(
    user.displayName || user.email?.split('@')[0] || 'Encargada',
    MAX_NAME_LENGTH,
  );
  const cleanNotes = clampString(notes, MAX_NOTES_LENGTH);
  const rawAuthorizedEmails = (workspace.authorizedEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length >= 3 && e.length <= 120 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    .slice(0, 15);
  const authorizedEmails =
    rawAuthorizedEmails.length > 0
      ? rawAuthorizedEmails
      : [workspace.ownerEmail.trim().toLowerCase()];
  const reportRef = doc(db, 'dailyReports', reportId);

  let detectedOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  let serverExists = Boolean(existingReport);
  let serverStatus: ReportStatus | undefined = existingReport?.status;
  let serverUpdatedAtMs: number | null = existingReport?.updatedAt?.toMillis?.() ?? null;
  let serverUpdatedByName: string | undefined = existingReport?.reportedByName;

  if (!detectedOffline) {
    try {
      const serverSnap = await getDoc(reportRef);
      serverExists = serverSnap.exists();
      if (serverExists) {
        const data = serverSnap.data() as Partial<DailyReport>;
        serverStatus = data.status;
        serverUpdatedAtMs =
          data.updatedAt && typeof data.updatedAt.toMillis === 'function'
            ? data.updatedAt.toMillis()
            : null;
        serverUpdatedByName = data.reportedByName;
      } else {
        serverStatus = undefined;
        serverUpdatedAtMs = null;
        serverUpdatedByName = undefined;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      const isOffline = msg.includes('offline') || msg.includes('unavailable');
      if (isOffline) {
        detectedOffline = true;
      } else {
        handleFirestoreError(err, OperationType.GET, `dailyReports/${reportId}`);
      }
    }
  }

  const guard = evaluateReportSaveGuard({
    mode,
    canManage,
    expectedUpdatedAtMs,
    forceOverwrite,
    serverExists,
    serverStatus,
    serverUpdatedAtMs,
    serverUpdatedByName,
  });

  if (!guard.ok) {
    throw new ConcurrencyConflictError(guard.message, guard.reason, {
      serverUpdatedByName,
      serverStatus,
    });
  }

  const mergedExistingEntries: Record<string, DailyReportEntry> = { ...existingEntries };
  if (!detectedOffline && serverExists) {
    const missingIds = rows
      .map((r) => r.itemId)
      .filter((id) => !mergedExistingEntries[id]);
    if (missingIds.length > 0) {
      try {
        const fetched = await Promise.all(
          missingIds.map((itemId) => getDoc(doc(db, 'dailyReports', reportId, 'entries', itemId))),
        );
        fetched.forEach((snap) => {
          if (snap.exists()) {
            const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
            mergedExistingEntries[entry.itemId] = entry;
          }
        });
      } catch {
        // Proceed with client snapshot if offline
      }
    }
  }

  interface EntryWriteOp {
    itemId: string;
    itemName: string;
    ref: ReturnType<typeof doc>;
    kind: 'update' | 'set';
    payload: Record<string, unknown>;
    updatePayload: Record<string, unknown>;
    createPayload: Record<string, unknown>;
  }

  const entryOperations: EntryWriteOp[] = [];

  rows.forEach((row) => {
    const prev = mergedExistingEntries[row.itemId];
    const notApplicable = Boolean(row.notApplicable);
    const hasOpening = notApplicable
      ? false
      : row.hasOpening || Boolean(prev?.hasOpening && mode === 'closing');
    const hasClosing = notApplicable
      ? false
      : row.hasClosing || Boolean(prev?.hasClosing && mode === 'opening');
    const addedVal = clampNumber(row.added);

    if (!prev && !hasOpening && !hasClosing && !notApplicable && addedVal === 0) {
      return;
    }

    const entryRef = doc(db, 'dailyReports', reportId, 'entries', row.itemId);
    const openingVal =
      !row.hasOpening && prev?.hasOpening ? clampNumber(prev.opening) : clampNumber(row.opening);
    const effectiveAdded =
      !row.hasOpening && prev && row.added === 0 ? clampNumber(prev.added) : addedVal;
    const closingVal =
      !row.hasClosing && prev?.hasClosing ? clampNumber(prev.closing) : clampNumber(row.closing);

    const previousClosingVal =
      typeof row.previousClosing === 'number'
        ? clampNumber(row.previousClosing)
        : typeof prev?.previousClosing === 'number'
          ? clampNumber(prev.previousClosing)
          : undefined;
    const derivedOpeningStatus =
      notApplicable
        ? undefined
        : row.openingStatus ??
          (hasOpening && previousClosingVal !== undefined
            ? openingVal === previousClosingVal
              ? 'confirmed_match'
              : 'adjusted'
            : hasOpening
              ? prev?.openingStatus ?? 'manual'
              : prev?.openingStatus);

    const updatePayload: Record<string, unknown> = {
      opening: openingVal,
      added: effectiveAdded,
      closing: closingVal,
      hasOpening,
      hasClosing,
      notApplicable,
      updatedByUid: user.uid,
      updatedByName: reporterName,
      updatedAt: serverTimestamp(),
    };
    if (previousClosingVal !== undefined) {
      updatePayload.previousClosing = previousClosingVal;
    }
    if (derivedOpeningStatus !== undefined) {
      updatePayload.openingStatus = derivedOpeningStatus;
    }
    if (canManage) {
      updatePayload.itemName = row.itemName;
      updatePayload.unit = row.unit;
      updatePayload.minStock = clampNumber(row.minStock);
      updatePayload.targetStock = clampNumber(row.targetStock);
    }

    const createPayload: Record<string, unknown> = {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      authorizedEmails,
      reportId,
      itemId: row.itemId,
      station,
      date,
      itemName: row.itemName,
      unit: row.unit,
      minStock: canManage ? clampNumber(row.minStock) : Number(row.minStock),
      targetStock: canManage ? clampNumber(row.targetStock) : Number(row.targetStock),
      opening: openingVal,
      added: effectiveAdded,
      closing: closingVal,
      hasOpening,
      hasClosing,
      notApplicable,
      updatedByUid: user.uid,
      updatedByName: reporterName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (previousClosingVal !== undefined) {
      createPayload.previousClosing = previousClosingVal;
    }
    if (derivedOpeningStatus !== undefined) {
      createPayload.openingStatus = derivedOpeningStatus;
    }

    entryOperations.push({
      itemId: row.itemId,
      itemName: row.itemName,
      ref: entryRef,
      kind: prev ? 'update' : 'set',
      payload: prev ? updatePayload : createPayload,
      updatePayload,
      createPayload,
    });
  });

  const MAX_ENTRIES_PER_BATCH = 8;
  const entryChunks: EntryWriteOp[][] = [];
  if (entryOperations.length === 0) {
    entryChunks.push([]);
  } else {
    for (let i = 0; i < entryOperations.length; i += MAX_ENTRIES_PER_BATCH) {
      entryChunks.push(entryOperations.slice(i, i + MAX_ENTRIES_PER_BATCH));
    }
  }

  const intermediateStatus: ReportStatus =
    serverExists && serverStatus === 'completed' ? 'completed' : 'opening_saved';

  const batches = entryChunks.map((chunk, chunkIdx) => {
    const chunkBatch = writeBatch(db);
    const isFirst = chunkIdx === 0;
    const isLast = chunkIdx === entryChunks.length - 1;
    const chunkStatus = isLast ? guard.effectiveStatus : intermediateStatus;

    if (isFirst) {
      if (serverExists) {
        chunkBatch.update(reportRef, {
          status: chunkStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          updatedAt: serverTimestamp(),
        });
      } else {
        chunkBatch.set(reportRef, {
          workspaceId: workspace.id,
          ownerUid: workspace.ownerUid,
          authorizedEmails,
          date,
          station,
          status: chunkStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } else if (isLast) {
      chunkBatch.update(reportRef, {
        status: guard.effectiveStatus,
        reportedByUid: user.uid,
        reportedByName: reporterName,
        notes: cleanNotes,
        updatedAt: serverTimestamp(),
      });
    }

    chunk.forEach((op) => {
      if (op.kind === 'update') {
        chunkBatch.update(op.ref, op.payload);
      } else {
        chunkBatch.set(op.ref, op.payload);
      }
    });

    return chunkBatch;
  });

  if (detectedOffline) {
    Promise.all(batches.map((b) => b.commit())).catch((error) => {
      console.error('Error al sincronizar envío offline al reconectar:', error);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    return { queuedOffline: true };
  }

  const extractFirebaseCode = (error: unknown): string | undefined =>
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;

  try {
    for (const b of batches) {
      await b.commit();
    }
    return { queuedOffline: false };
  } catch (batchError) {
    console.warn(
      `[saveStationReportBatch] Lote rechazado (${extractFirebaseCode(batchError) ?? 'error'}). Iniciando diagnóstico documento por documento...`,
      batchError,
    );

    let liveReportExists = serverExists;
    try {
      const liveReportSnap = await getDoc(reportRef);
      liveReportExists = liveReportSnap.exists();
    } catch {
      // Keep prior knowledge if read fails
    }

    const firstStepReportStatus: ReportStatus =
      entryOperations.length === 0 ? guard.effectiveStatus : intermediateStatus;

    try {
      if (liveReportExists) {
        await updateDoc(reportRef, {
          status: firstStepReportStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(reportRef, {
          workspaceId: workspace.id,
          ownerUid: workspace.ownerUid,
          authorizedEmails,
          date,
          station,
          status: firstStepReportStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (reportWriteError) {
      const errCode = extractFirebaseCode(reportWriteError) ?? extractFirebaseCode(batchError);
      const reasons: string[] = [];

      if (!user.emailVerified) {
        reasons.push('tu cuenta de Google no tiene email verificado');
      }
      if (!canManage) {
        try {
          const [memSnap, wsSnap, repSnap] = await Promise.all([
            getDoc(doc(db, 'teamMembers', user.uid)),
            getDoc(doc(db, 'workspaces', workspace.id)),
            getDoc(reportRef),
          ]);
          if (!memSnap.exists()) {
            reasons.push(`no existe teamMembers/${user.uid}`);
          } else {
            const m = memSnap.data() as Partial<TeamMember>;
            if (!m.active) reasons.push('tu acceso en teamMembers está desactivado (active: false)');
            if (m.workspaceId !== workspace.id) {
              reasons.push(`teamMembers.workspaceId (${m.workspaceId}) no coincide con ${workspace.id}`);
            }
            if (m.station !== station) {
              reasons.push(`teamMembers.station (${m.station}) no coincide con ${station}`);
            }
          }
          if (wsSnap.exists()) {
            const ws = wsSnap.data() as Partial<Workspace>;
            if (ws.ownerUid !== workspace.ownerUid) {
              reasons.push('el ownerUid del restaurante cambió en el servidor');
            }
            if (ws.shiftSchedule?.enabled) {
              reasons.push(
                `horario servidor habilitado (${ws.shiftSchedule.openingStart}–${ws.shiftSchedule.openingEnd} / ${ws.shiftSchedule.closingStart}–${ws.shiftSchedule.closingEnd}), fecha reporte: ${date}`,
              );
            }
          }
          if (repSnap.exists()) {
            const r = repSnap.data() as Partial<DailyReport>;
            if (r.status === 'completed') {
              reasons.push('el reporte ya está marcado como completed');
            }
          }
        } catch {
          // Ignore secondary diagnostic read errors
        }
      }

      const opLabel = liveReportExists ? 'actualización' : 'creación';
      const detail =
        reasons.length > 0
          ? `Documento rechazado: dailyReports/${reportId} (${opLabel}). Motivo: ${reasons.join('; ')}.`
          : `Documento rechazado: dailyReports/${reportId} (${opLabel}). Verifica el horario permitido, la fecha operativa (${date}) o que el reporte no esté bloqueado.`;

      console.error('Firestore Diagnostic Report Error:', {
        path: `dailyReports/${reportId}`,
        code: errCode,
        reasons,
        reportWriteError,
      });

      throw new DiagnosticSaveError({
        title: 'Firebase rechazó el encabezado del reporte',
        detail,
        failedDocumentPath: `dailyReports/${reportId}`,
        code: errCode,
      });
    }

    for (const op of entryOperations) {
      let liveEntryExists = op.kind === 'update';
      try {
        const entrySnap = await getDoc(op.ref);
        liveEntryExists = entrySnap.exists();
      } catch {
        // Use expected op kind if pre-read fails
      }

      try {
        if (liveEntryExists) {
          await updateDoc(op.ref, op.updatePayload);
        } else {
          await setDoc(op.ref, op.createPayload);
        }
      } catch (entryWriteError) {
        const errCode = extractFirebaseCode(entryWriteError) ?? extractFirebaseCode(batchError);
        const reasons: string[] = [];

        try {
          const [itemSnap, repSnap, wsSnap] = await Promise.all([
            getDoc(doc(db, 'items', op.itemId)),
            getDoc(reportRef),
            getDoc(doc(db, 'workspaces', workspace.id)),
          ]);

          if (!itemSnap.exists()) {
            reasons.push(`el insumo items/${op.itemId} no existe en el servidor`);
          } else {
            const it = itemSnap.data() as Partial<InventoryItem>;
            if (it.workspaceId !== workspace.id) {
              reasons.push(`workspaceId del catálogo (${it.workspaceId}) ≠ ${workspace.id}`);
            }
            if (it.station !== station && !(it.station === 'hamburguesas' && station === 'comida_rapida')) {
              reasons.push(`puesto en catálogo (${it.station}) ≠ ${station}`);
            }
            if (it.name !== op.createPayload.itemName) {
              reasons.push(`nombre en catálogo ("${it.name}") ≠ "${String(op.createPayload.itemName)}"`);
            }
            if (it.unit !== op.createPayload.unit) {
              reasons.push(`unidad en catálogo ("${it.unit}") ≠ "${String(op.createPayload.unit)}"`);
            }
            if (it.minStock !== op.createPayload.minStock) {
              reasons.push(`minStock en catálogo (${it.minStock}) ≠ ${String(op.createPayload.minStock)}`);
            }
            if (it.targetStock !== op.createPayload.targetStock) {
              reasons.push(`targetStock en catálogo (${it.targetStock}) ≠ ${String(op.createPayload.targetStock)}`);
            }
          }

          if (repSnap.exists()) {
            const rep = repSnap.data() as Partial<DailyReport>;
            if (rep.status === 'completed') {
              reasons.push(`dailyReports/${reportId} está en estado completed`);
            }
            if (rep.ownerUid && rep.ownerUid !== workspace.ownerUid) {
              reasons.push(`ownerUid del reporte (${rep.ownerUid}) ≠ ${workspace.ownerUid}`);
            }
          } else {
            reasons.push(`no existe dailyReports/${reportId}`);
          }

          if (wsSnap.exists()) {
            const ws = wsSnap.data() as Partial<Workspace>;
            if (ws.ownerUid !== workspace.ownerUid) {
              reasons.push(`ownerUid del restaurante (${ws.ownerUid}) ≠ ${workspace.ownerUid}`);
            }
            if (ws.shiftSchedule?.enabled) {
              reasons.push(
                `ventana configurada en servidor (${ws.shiftSchedule.openingStart}–${ws.shiftSchedule.openingEnd} / ${ws.shiftSchedule.closingStart}–${ws.shiftSchedule.closingEnd}), fecha: ${date}`,
              );
            }
          }
        } catch {
          // Ignore secondary diagnostic read errors
        }

        const entryPath = `dailyReports/${reportId}/entries/${op.itemId}`;
        const opLabel = liveEntryExists ? 'actualización' : 'creación';
        const detail =
          reasons.length > 0
            ? `Documento rechazado: ${entryPath} ("${op.itemName}", ${opLabel}). Motivo: ${reasons.join('; ')}.`
            : `Documento rechazado: ${entryPath} ("${op.itemName}", ${opLabel}). Revisa que el insumo coincida con el catálogo o que el horario siga activo.`;

        console.error('Firestore Diagnostic Entry Error:', {
          path: entryPath,
          itemName: op.itemName,
          code: errCode,
          reasons,
          entryWriteError,
        });

        throw new DiagnosticSaveError({
          title: `Error al guardar insumo "${op.itemName}"`,
          detail,
          failedDocumentPath: entryPath,
          code: errCode,
        });
      }
    }

    if (guard.effectiveStatus !== firstStepReportStatus) {
      try {
        await updateDoc(reportRef, {
          status: guard.effectiveStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          updatedAt: serverTimestamp(),
        });
      } catch (finalizeError) {
        const errCode = extractFirebaseCode(finalizeError) ?? extractFirebaseCode(batchError);
        throw new DiagnosticSaveError({
          title: 'Error al finalizar el cierre del reporte',
          detail: `Se guardaron los insumos, pero Firebase rechazó cerrar dailyReports/${reportId}.`,
          failedDocumentPath: `dailyReports/${reportId}`,
          code: errCode,
        });
      }
    }

    return { queuedOffline: false };
  }
}
