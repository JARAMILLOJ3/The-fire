import type { User } from 'firebase/auth';
import {
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocFromServer,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_TIME_LABEL_LENGTH,
  MAX_UNIT_LENGTH,
  MAX_WORKER_NOTE_LENGTH,
} from '../constants';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  ReportStatus,
  ShiftSchedule,
  StationId,
  TeamMember,
  Workspace,
  Workstation,
} from '../types';
import {
  formatBogotaTimeExact,
  getOperationalDateStr,
  getServerNow,
  syncServerClockOffset,
} from '../utils/date';
import { MAX_BATCH_SIZE } from '../utils/batch';
import { getEffectiveItemUnit } from '../utils/inventory';
import { perfMetrics } from '../utils/perfMetrics';
import { resolveWorkerScheduleStatus } from '../utils/schedule';
import { clampNumber, clampString, makeCleanId } from './shared';

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
  readonly rawDetail?: string;

  constructor(params: {
    title: string;
    detail: string;
    failedDocumentPath: string;
    code?: string;
    rawDetail?: string;
  }) {
    super(`${params.title}: ${params.detail}`);
    this.name = 'DiagnosticSaveError';
    this.title = params.title;
    this.detail = params.detail;
    this.failedDocumentPath = params.failedDocumentPath;
    this.code = params.code;
    this.rawDetail = params.rawDetail;
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

export interface ServerItemsFetchResult {
  itemsById: Record<string, InventoryItem>;
  removedOrMovedIds: Set<string>;
  offlineFallback: boolean;
}

function isFirebaseOfflineError(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : '';
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err ?? '').toLowerCase();
  return (
    code === 'unavailable' ||
    msg.includes('offline') ||
    msg.includes('unavailable') ||
    msg.includes('failed to get document because the client is offline')
  );
}

function isFirebasePermissionDeniedError(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : '';
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err ?? '').toLowerCase();
  return code === 'permission-denied' || msg.includes('permission-denied') || msg.includes('insufficient permissions');
}

export async function fetchStationItemsFromServerMap(
  workspaceId: string,
  stationId: StationId,
  itemIds: string[],
): Promise<ServerItemsFetchResult> {
  const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
  const itemsById: Record<string, InventoryItem> = {};
  const removedOrMovedIds = new Set<string>();
  let offlineFallback = false;

  if (uniqueIds.length === 0) {
    return { itemsById, removedOrMovedIds, offlineFallback };
  }

  perfMetrics.recordRead('items_server', uniqueIds.length);
  await Promise.all(
    uniqueIds.map(async (itemId) => {
      const ref = doc(db, 'items', itemId);
      try {
        const snap = await getDocFromServer(ref);
        if (!snap.exists()) {
          removedOrMovedIds.add(itemId);
          return;
        }
        const raw = snap.data() as Omit<InventoryItem, 'id'>;
        const normalizedStation = raw.station === 'hamburguesas' ? 'comida_rapida' : raw.station;
        if (raw.workspaceId !== workspaceId || normalizedStation !== stationId || !raw.active) {
          removedOrMovedIds.add(itemId);
          return;
        }
        itemsById[snap.id] = {
          ...raw,
          id: snap.id,
          station: normalizedStation,
        };
      } catch (err) {
        if (isFirebasePermissionDeniedError(err)) {
          // Item may have been reassigned to another station or deleted without legacy ID prefix
          removedOrMovedIds.add(itemId);
          return;
        }
        if (isFirebaseOfflineError(err)) {
          offlineFallback = true;
          try {
            const cachedSnap = await getDoc(ref);
            if (cachedSnap.exists()) {
              const raw = cachedSnap.data() as Omit<InventoryItem, 'id'>;
              const normalizedStation = raw.station === 'hamburguesas' ? 'comida_rapida' : raw.station;
              if (raw.workspaceId === workspaceId && normalizedStation === stationId && raw.active) {
                itemsById[cachedSnap.id] = {
                  ...raw,
                  id: cachedSnap.id,
                  station: normalizedStation,
                };
              }
            }
          } catch {
            // Keep existing row data if both server and cache fail offline
          }
          return;
        }
        handleFirestoreError(err, OperationType.GET, `items/${itemId}`);
      }
    }),
  );

  return { itemsById, removedOrMovedIds, offlineFallback };
}

export async function fetchStationItemsOnce(
  workspaceId: string,
  stationId: StationId,
  itemIds: string[],
  options?: { fromServer?: boolean },
): Promise<InventoryItem[]> {
  if (itemIds.length === 0) return [];
  if (options?.fromServer) {
    const { itemsById } = await fetchStationItemsFromServerMap(workspaceId, stationId, itemIds);
    const list = Object.values(itemsById);
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return list;
  }

  perfMetrics.recordRead('items', itemIds.length);
  const snaps = await Promise.all(
    itemIds.map((itemId) =>
      getDoc(doc(db, 'items', itemId)).catch((err) => {
        handleFirestoreError(err, OperationType.GET, `items/${itemId}`);
      }),
    ),
  );

  const list: InventoryItem[] = [];
  snaps.forEach((snap) => {
    if (!snap.exists()) return;
    const raw = snap.data() as Omit<InventoryItem, 'id'>;
    const normalizedStation = raw.station === 'hamburguesas' ? 'comida_rapida' : raw.station;
    if (raw.workspaceId === workspaceId && normalizedStation === stationId) {
      list.push({
        ...raw,
        id: snap.id,
        station: normalizedStation,
      });
    }
  });
  list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return list;
}

export async function fetchReportEntriesOnce(
  reportId: string,
  itemIds: string[],
): Promise<Record<string, DailyReportEntry>> {
  if (!reportId || itemIds.length === 0) return {};
  perfMetrics.recordRead('todayEntries', itemIds.length);
  const snaps = await Promise.all(
    itemIds.map((itemId) =>
      getDoc(doc(db, 'dailyReports', reportId, 'entries', itemId)).catch((err) => {
        handleFirestoreError(
          err,
          OperationType.GET,
          `dailyReports/${reportId}/entries/${itemId}`,
        );
      }),
    ),
  );
  const map: Record<string, DailyReportEntry> = {};
  snaps.forEach((snap) => {
    if (snap.exists()) {
      const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
      map[entry.itemId] = entry;
    }
  });
  return map;
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
    perfMetrics.recordRead('stations');
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

    const reportId = `${workspaceId}_${dateStr}_${stationId}`;
    perfMetrics.recordRead('dailyReports');
    const [fetchedItems, repSnap] = await Promise.all([
      fetchStationItemsOnce(workspaceId, stationId, itemIdsToFetch).then((items) =>
        items.filter((it) => it.active),
      ),
      getDoc(doc(db, 'dailyReports', reportId)),
    ]);

    const report = repSnap.exists()
      ? ({ id: repSnap.id, ...repSnap.data() } as DailyReport)
      : undefined;

    const entries = report
      ? await fetchReportEntriesOnce(
          reportId,
          fetchedItems.map((it) => it.id),
        )
      : {};

    return { station, items: fetchedItems, report, entries };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `stations/${stationId}`);
  }
}

export async function fetchStationEntriesWithStatusOnce(
  workspaceId: string,
  dateStr: string,
  station: StationId,
  itemIds: string[],
): Promise<{ reportExists: boolean; entries: Record<string, DailyReportEntry> }> {
  const reportId = `${workspaceId}_${dateStr}_${station}`;
  const path = `dailyReports/${reportId}`;
  try {
    perfMetrics.recordRead('yesterdayReport');
    const repSnap = await getDoc(doc(db, 'dailyReports', reportId));
    if (!repSnap.exists() || itemIds.length === 0) {
      return { reportExists: repSnap.exists(), entries: {} };
    }

    perfMetrics.recordRead('yesterdayEntries', itemIds.length);
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
    return { reportExists: true, entries: map };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function fetchStationEntriesOnce(
  workspaceId: string,
  dateStr: string,
  station: StationId,
  itemIds: string[],
): Promise<Record<string, DailyReportEntry>> {
  const result = await fetchStationEntriesWithStatusOnce(workspaceId, dateStr, station, itemIds);
  return result.entries;
}

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function buildNormalizedAuthorizedEmails(
  workspace: Pick<Workspace, 'ownerEmail' | 'authorizedEmails'>,
): string[] {
  const ownerEmail = (workspace.ownerEmail ?? '').trim().toLowerCase();
  const rawList = (workspace.authorizedEmails ?? []).map((e) => e.trim().toLowerCase());
  const candidates = ownerEmail ? [ownerEmail, ...rawList] : rawList;
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const email of candidates) {
    if (email.length >= 3 && email.length <= 120 && EMAIL_REGEX.test(email) && !seen.has(email)) {
      seen.add(email);
      deduped.push(email);
      if (deduped.length >= 15) break;
    }
  }
  return deduped;
}

export function validateWorkerSubmitPhase(params: {
  canManage: boolean;
  mode: 'opening' | 'closing';
  schedule?: ShiftSchedule;
  now: Date;
  reportPath: string;
}): void {
  const { canManage, mode, schedule, now, reportPath } = params;
  if (canManage || !schedule?.enabled) return;

  const status = resolveWorkerScheduleStatus(now, schedule);
  if (status.phase === 'outside') {
    throw new DiagnosticSaveError({
      title: 'Cambio de horario detectado',
      detail: 'El horario de captura ya terminó. Recarga la pantalla para ver el próximo horario.',
      failedDocumentPath: reportPath,
      code: 'phase-mismatch',
    });
  }
  if (mode === 'opening' && status.phase === 'closing') {
    throw new DiagnosticSaveError({
      title: 'Cambio de horario detectado',
      detail: 'Ya empezó el cierre, recarga la pantalla para pasar al inventario de cierre.',
      failedDocumentPath: reportPath,
      code: 'phase-mismatch',
    });
  }
  if (mode === 'closing' && status.phase === 'opening') {
    throw new DiagnosticSaveError({
      title: 'Cambio de horario detectado',
      detail: 'Todavía estás en horario de apertura, recarga la pantalla para guardar el inicio.',
      failedDocumentPath: reportPath,
      code: 'phase-mismatch',
    });
  }
}

export interface PreparedEntryOp {
  itemId: string;
  itemName: string;
  kind: 'update' | 'set';
  hasOpening: boolean;
  hasClosing: boolean;
  notApplicable: boolean;
  updateFields: Record<string, unknown>;
  createFields: Record<string, unknown>;
}

export function prepareStationReportEntries(params: {
  workspace: Workspace;
  userUid: string;
  reporterName: string;
  canManage: boolean;
  date: string;
  station: StationId;
  reportId: string;
  mode: 'opening' | 'closing';
  rows: DraftEntryRow[];
  mergedExistingEntries: Record<string, DailyReportEntry>;
  authorizedEmails: string[];
  timestampValue: unknown;
}): PreparedEntryOp[] {
  const {
    workspace,
    userUid,
    reporterName,
    canManage,
    date,
    station,
    reportId,
    mode,
    rows,
    mergedExistingEntries,
    authorizedEmails,
    timestampValue,
  } = params;

  const ops: PreparedEntryOp[] = [];

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

    const updateFields: Record<string, unknown> = {
      opening: openingVal,
      added: effectiveAdded,
      closing: closingVal,
      hasOpening,
      hasClosing,
      notApplicable,
      updatedByUid: userUid,
      updatedByName: reporterName,
      updatedAt: timestampValue,
    };
    if (previousClosingVal !== undefined) {
      updateFields.previousClosing = previousClosingVal;
    }
    if (derivedOpeningStatus !== undefined) {
      updateFields.openingStatus = derivedOpeningStatus;
    }
    if (canManage) {
      updateFields.authorizedEmails = authorizedEmails;
      updateFields.itemName = row.itemName;
      updateFields.unit = row.unit;
      updateFields.minStock = clampNumber(row.minStock);
      updateFields.targetStock = clampNumber(row.targetStock);
    }

    const createFields: Record<string, unknown> = {
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
      updatedByUid: userUid,
      updatedByName: reporterName,
      createdAt: timestampValue,
      updatedAt: timestampValue,
    };
    if (previousClosingVal !== undefined) {
      createFields.previousClosing = previousClosingVal;
    }
    if (derivedOpeningStatus !== undefined) {
      createFields.openingStatus = derivedOpeningStatus;
    }

    ops.push({
      itemId: row.itemId,
      itemName: row.itemName,
      kind: prev ? 'update' : 'set',
      hasOpening,
      hasClosing,
      notApplicable,
      updateFields,
      createFields,
    });
  });

  if (
    mode === 'opening' &&
    !ops.some((op) => op.hasOpening || op.notApplicable)
  ) {
    throw new DiagnosticSaveError({
      title: 'Falta contar al menos un insumo',
      detail:
        'No hay insumos contados para guardar la apertura. Cuenta o confirma al menos un insumo antes de enviar.',
      failedDocumentPath: `dailyReports/${reportId}`,
      code: 'no-opening-items',
    });
  }

  return ops;
}

export interface CatalogSyncRowResult {
  rows: DraftEntryRow[];
  updatedItemIds: string[];
  removedItemIds: string[];
  serverItems: InventoryItem[];
}

export function reconcileRowsWithServerCatalog(params: {
  rows: DraftEntryRow[];
  serverItemsById: Record<string, InventoryItem>;
  removedOrMovedIds?: ReadonlySet<string>;
  existingEntries: Record<string, DailyReportEntry>;
}): CatalogSyncRowResult {
  const { rows, serverItemsById, removedOrMovedIds, existingEntries } = params;
  const updatedItemIds: string[] = [];
  const removedItemIds: string[] = [];
  const nextRows: DraftEntryRow[] = [];

  rows.forEach((row) => {
    if (removedOrMovedIds?.has(row.itemId) && !existingEntries[row.itemId]) {
      removedItemIds.push(row.itemId);
      return;
    }
    const serverItem = serverItemsById[row.itemId];
    if (!serverItem) {
      nextRows.push(row);
      return;
    }

    const changed =
      row.itemName !== serverItem.name ||
      row.unit !== serverItem.unit ||
      row.minStock !== serverItem.minStock ||
      row.targetStock !== serverItem.targetStock;
    if (changed) {
      updatedItemIds.push(row.itemId);
    }

    nextRows.push({
      ...row,
      itemName: serverItem.name,
      unit: serverItem.unit,
      minStock: serverItem.minStock,
      targetStock: serverItem.targetStock,
    });
  });

  const serverItems = Object.values(serverItemsById).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );

  return {
    rows: nextRows,
    updatedItemIds,
    removedItemIds,
    serverItems,
  };
}

export interface ServerReportReadResult {
  exists: boolean;
  data?: Partial<DailyReport>;
  updatedAtMs: number | null;
  offline?: boolean;
}

export interface BatchChunkReportWrite {
  kind: 'set' | 'update';
  payload: Record<string, unknown>;
}

export interface BatchChunkCommitInput {
  reportId: string;
  reportWrite?: BatchChunkReportWrite;
  entryOps: PreparedEntryOp[];
}

export interface WorkerSaveIO {
  syncClock: () => Promise<void>;
  getServerTimestampValue: () => unknown;
  fetchServerItems: (
    workspaceId: string,
    stationId: StationId,
    itemIds: string[],
  ) => Promise<ServerItemsFetchResult>;
  fetchServerReport: (reportId: string) => Promise<ServerReportReadResult>;
  fetchServerEntries: (
    reportId: string,
    itemIds: string[],
  ) => Promise<Record<string, DailyReportEntry>>;
  commitChunks: (chunks: BatchChunkCommitInput[], offline: boolean) => Promise<{ queuedOffline: boolean }>;
  diagnoseChunkFailure: (params: {
    batchError: unknown;
    workspace: Workspace;
    user: User;
    canManage: boolean;
    date: string;
    station: StationId;
    reportId: string;
    reporterName: string;
    cleanNotes: string;
    authorizedEmails: string[];
    serverExists: boolean;
    firstStepReportStatus: ReportStatus;
    effectiveStatus: ReportStatus;
    entryOps: PreparedEntryOp[];
  }) => Promise<void>;
}

function extractFirebaseCode(error: unknown): string | undefined {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function extractRawErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

function createDefaultWorkerSaveIO(): WorkerSaveIO {
  return {
    syncClock: async () => {
      await syncServerClockOffset();
    },
    getServerTimestampValue: () => serverTimestamp(),
    fetchServerItems: (workspaceId, stationId, itemIds) =>
      fetchStationItemsFromServerMap(workspaceId, stationId, itemIds),
    fetchServerReport: async (reportId) => {
      const reportRef = doc(db, 'dailyReports', reportId);
      try {
        let serverSnap;
        try {
          serverSnap = await getDocFromServer(reportRef);
        } catch (serverErr) {
          if (isFirebaseOfflineError(serverErr)) {
            serverSnap = await getDoc(reportRef);
          } else {
            throw serverErr;
          }
        }
        if (!serverSnap.exists()) {
          return { exists: false, updatedAtMs: null };
        }
        const data = serverSnap.data() as Partial<DailyReport>;
        const updatedAtMs =
          data.updatedAt && typeof data.updatedAt.toMillis === 'function'
            ? data.updatedAt.toMillis()
            : null;
        return { exists: true, data, updatedAtMs };
      } catch (err) {
        if (isFirebaseOfflineError(err)) {
          return { exists: false, updatedAtMs: null, offline: true };
        }
        handleFirestoreError(err, OperationType.GET, `dailyReports/${reportId}`);
      }
    },
    fetchServerEntries: async (reportId, itemIds) => {
      if (itemIds.length === 0) return {};
      const map: Record<string, DailyReportEntry> = {};
      try {
        const fetched = await Promise.all(
          itemIds.map((itemId) => getDoc(doc(db, 'dailyReports', reportId, 'entries', itemId))),
        );
        fetched.forEach((snap) => {
          if (snap.exists()) {
            const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
            map[entry.itemId] = entry;
          }
        });
      } catch {
        // Proceed with existing entries if offline
      }
      return map;
    },
    commitChunks: async (chunks, offline) => {
      const batches = chunks.map((chunk) => {
        const b = writeBatch(db);
        const reportRef = doc(db, 'dailyReports', chunk.reportId);
        if (chunk.reportWrite) {
          if (chunk.reportWrite.kind === 'update') {
            b.update(reportRef, chunk.reportWrite.payload);
          } else {
            b.set(reportRef, chunk.reportWrite.payload);
          }
        }
        chunk.entryOps.forEach((op) => {
          const ref = doc(db, 'dailyReports', chunk.reportId, 'entries', op.itemId);
          if (op.kind === 'update') {
            b.update(ref, op.updateFields);
          } else {
            b.set(ref, op.createFields);
          }
        });
        return b;
      });

      if (offline) {
        Promise.all(batches.map((b) => b.commit())).catch((error) => {
          console.error('Error al sincronizar envío offline al reconectar:', error);
        });
        return { queuedOffline: true };
      }

      for (const b of batches) {
        await b.commit();
      }
      return { queuedOffline: false };
    },
    diagnoseChunkFailure: async ({
      batchError,
      workspace,
      user,
      canManage,
      date,
      station,
      reportId,
      reporterName,
      cleanNotes,
      authorizedEmails,
      serverExists,
      firstStepReportStatus,
      effectiveStatus,
      entryOps,
    }) => {
      const reportRef = doc(db, 'dailyReports', reportId);
      const batchRawText = extractRawErrorText(batchError);

      let liveReportExists = serverExists;
      try {
        const liveReportSnap = await getDocFromServer(reportRef);
        liveReportExists = liveReportSnap.exists();
      } catch {
        // Keep prior knowledge if read fails
      }

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
              getDocFromServer(doc(db, 'teamMembers', user.uid)),
              getDocFromServer(doc(db, 'workspaces', workspace.id)),
              getDocFromServer(reportRef),
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
        const rawDetail = `${detail}\nFirebase (${errCode ?? 'sin código'}): ${extractRawErrorText(reportWriteError) || batchRawText}`;

        throw new DiagnosticSaveError({
          title: 'Firebase rechazó el encabezado del reporte',
          detail,
          rawDetail,
          failedDocumentPath: `dailyReports/${reportId}`,
          code: errCode,
        });
      }

      for (const op of entryOps) {
        const entryRef = doc(db, 'dailyReports', reportId, 'entries', op.itemId);
        let liveEntryExists = op.kind === 'update';
        try {
          const entrySnap = await getDocFromServer(entryRef);
          liveEntryExists = entrySnap.exists();
        } catch {
          // Use expected op kind if pre-read fails
        }

        try {
          if (liveEntryExists) {
            await updateDoc(entryRef, op.updateFields);
          } else {
            await setDoc(entryRef, op.createFields);
          }
        } catch (entryWriteError) {
          const errCode = extractFirebaseCode(entryWriteError) ?? extractFirebaseCode(batchError);
          const reasons: string[] = [];
          let catalogMismatchDetected = false;

          try {
            let itemMissingOrDenied = false;
            const itemPromise = getDocFromServer(doc(db, 'items', op.itemId)).catch((itemErr) => {
              if (isFirebasePermissionDeniedError(itemErr)) {
                itemMissingOrDenied = true;
                return null;
              }
              return null;
            });
            const [itemSnap, repSnap, wsSnap] = await Promise.all([
              itemPromise,
              getDocFromServer(reportRef).catch(() => null),
              getDocFromServer(doc(db, 'workspaces', workspace.id)).catch(() => null),
            ]);

            if (itemMissingOrDenied) {
              catalogMismatchDetected = true;
              reasons.push(`el insumo items/${op.itemId} ya no pertenece a este puesto o fue desasignado en el catálogo`);
            } else if (itemSnap && !itemSnap.exists()) {
              catalogMismatchDetected = true;
              reasons.push(`el insumo items/${op.itemId} no existe en el servidor`);
            } else if (itemSnap?.exists()) {
              const it = itemSnap.data() as Partial<InventoryItem>;
              if (it.workspaceId !== workspace.id) {
                catalogMismatchDetected = true;
                reasons.push(`workspaceId del catálogo (${it.workspaceId}) ≠ ${workspace.id}`);
              }
              if (it.station !== station && !(it.station === 'hamburguesas' && station === 'comida_rapida')) {
                catalogMismatchDetected = true;
                reasons.push(`puesto en catálogo (${it.station}) ≠ ${station}`);
              }
              if (it.name !== op.createFields.itemName) {
                catalogMismatchDetected = true;
                reasons.push(`nombre en catálogo ("${it.name}") ≠ "${String(op.createFields.itemName)}"`);
              }
              if (it.unit !== op.createFields.unit) {
                catalogMismatchDetected = true;
                reasons.push(`unidad en catálogo ("${it.unit}") ≠ "${String(op.createFields.unit)}"`);
              }
              if (it.minStock !== op.createFields.minStock) {
                catalogMismatchDetected = true;
                reasons.push(`minStock en catálogo (${it.minStock}) ≠ ${String(op.createFields.minStock)}`);
              }
              if (it.targetStock !== op.createFields.targetStock) {
                catalogMismatchDetected = true;
                reasons.push(`targetStock en catálogo (${it.targetStock}) ≠ ${String(op.createFields.targetStock)}`);
              }
            }

            if (repSnap?.exists()) {
              const rep = repSnap.data() as Partial<DailyReport>;
              if (rep.status === 'completed') {
                reasons.push(`dailyReports/${reportId} está en estado completed`);
              }
              if (rep.ownerUid && rep.ownerUid !== workspace.ownerUid) {
                reasons.push(`ownerUid del reporte (${rep.ownerUid}) ≠ ${workspace.ownerUid}`);
              }
            } else if (repSnap) {
              reasons.push(`no existe dailyReports/${reportId}`);
            }

            if (wsSnap?.exists()) {
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
          const rawEntryText = extractRawErrorText(entryWriteError) || batchRawText;
          const rawDetail = `${detail}\nFirebase (${errCode ?? 'sin código'}): ${rawEntryText}`;

          throw new DiagnosticSaveError({
            title: catalogMismatchDetected
              ? `El catálogo de "${op.itemName}" cambió en el servidor`
              : `Error al guardar insumo "${op.itemName}"`,
            detail,
            rawDetail,
            failedDocumentPath: entryPath,
            code: catalogMismatchDetected ? 'catalog-mismatch' : errCode,
          });
        }
      }

      if (effectiveStatus !== firstStepReportStatus) {
        try {
          await updateDoc(reportRef, {
            status: effectiveStatus,
            reportedByUid: user.uid,
            reportedByName: reporterName,
            notes: cleanNotes,
            updatedAt: serverTimestamp(),
          });
        } catch (finalizeError) {
          const errCode = extractFirebaseCode(finalizeError) ?? extractFirebaseCode(batchError);
          const rawDetail = `No se pudo marcar el cierre de dailyReports/${reportId}.\nFirebase (${errCode ?? 'sin código'}): ${extractRawErrorText(finalizeError) || batchRawText}`;
          throw new DiagnosticSaveError({
            title: 'Error al finalizar el cierre del reporte',
            detail: `Se guardaron los insumos, pero Firebase rechazó cerrar dailyReports/${reportId}.`,
            rawDetail,
            failedDocumentPath: `dailyReports/${reportId}`,
            code: errCode,
          });
        }
      }
    },
  };
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
  now?: Date;
  onStatusMessage?: (message: string) => void;
  onCatalogSynced?: (items: InventoryItem[]) => void;
  io?: Partial<WorkerSaveIO>;
}): Promise<{ queuedOffline: boolean; catalogUpdatedDuringSave?: boolean }> {
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
    now: providedNow,
    onStatusMessage,
    onCatalogSynced,
    io: customIO,
  } = params;

  const defaultIO = createDefaultWorkerSaveIO();
  const io: WorkerSaveIO = {
    syncClock: customIO?.syncClock ?? defaultIO.syncClock,
    getServerTimestampValue: customIO?.getServerTimestampValue ?? defaultIO.getServerTimestampValue,
    fetchServerItems: customIO?.fetchServerItems ?? defaultIO.fetchServerItems,
    fetchServerReport: customIO?.fetchServerReport ?? defaultIO.fetchServerReport,
    fetchServerEntries: customIO?.fetchServerEntries ?? defaultIO.fetchServerEntries,
    commitChunks: customIO?.commitChunks ?? defaultIO.commitChunks,
    diagnoseChunkFailure: customIO?.diagnoseChunkFailure ?? defaultIO.diagnoseChunkFailure,
  };

  const reportId = `${workspace.id}_${date}_${station}`;
  const reporterName = clampString(
    user.displayName || user.email?.split('@')[0] || 'Encargada',
    MAX_NAME_LENGTH,
  );
  const cleanNotes = clampString(notes, MAX_NOTES_LENGTH);
  const authorizedEmails = buildNormalizedAuthorizedEmails(workspace);

  let detectedOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (!detectedOffline && !providedNow) {
    await io.syncClock();
  }
  const effectiveNow = providedNow ?? getServerNow();
  validateWorkerSubmitPhase({
    canManage,
    mode,
    schedule: workspace.shiftSchedule,
    now: effectiveNow,
    reportPath: `dailyReports/${reportId}`,
  });

  let catalogUpdatedDuringSave = false;
  let activeRows = rows;
  const mergedExistingEntries: Record<string, DailyReportEntry> = { ...existingEntries };
  let retriedAfterCatalogMismatch = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    // Step 1: Read the station items being saved directly from the server (never from cache)
    if (!detectedOffline && activeRows.length > 0) {
      const serverCatalog = await io.fetchServerItems(
        workspace.id,
        station,
        activeRows.map((r) => r.itemId),
      );
      if (serverCatalog.offlineFallback) {
        detectedOffline = true;
      } else {
        const reconciled = reconcileRowsWithServerCatalog({
          rows: activeRows,
          serverItemsById: serverCatalog.itemsById,
          removedOrMovedIds: serverCatalog.removedOrMovedIds,
          existingEntries: mergedExistingEntries,
        });
        activeRows = reconciled.rows;
        if (
          attempt > 0 ||
          reconciled.updatedItemIds.length > 0 ||
          reconciled.removedItemIds.length > 0
        ) {
          catalogUpdatedDuringSave = true;
          if (reconciled.serverItems.length > 0) {
            onCatalogSynced?.(reconciled.serverItems);
          }
        }
      }
    }

    let serverExists = Boolean(existingReport);
    let serverStatus: ReportStatus | undefined = existingReport?.status;
    let serverUpdatedAtMs: number | null = existingReport?.updatedAt?.toMillis?.() ?? null;
    let serverUpdatedByName: string | undefined = existingReport?.reportedByName;
    let serverReportedByUid: string | undefined = existingReport?.reportedByUid;

    if (!detectedOffline) {
      const serverRep = await io.fetchServerReport(reportId);
      if (serverRep.offline) {
        detectedOffline = true;
      } else {
        serverExists = serverRep.exists;
        if (serverRep.exists && serverRep.data) {
          serverStatus = serverRep.data.status;
          serverUpdatedAtMs = serverRep.updatedAtMs;
          serverUpdatedByName = serverRep.data.reportedByName;
          serverReportedByUid = serverRep.data.reportedByUid;
        } else {
          serverStatus = undefined;
          serverUpdatedAtMs = null;
          serverUpdatedByName = undefined;
          serverReportedByUid = undefined;
        }
      }
    }

    // If our own diagnostic pass in attempt 0 touched the report header before failing on a catalog mismatch,
    // allow attempt 1 (same user retry) to continue instead of tripping our own concurrent_create/update guard.
    const selfDiagnosticHeaderTouched =
      retriedAfterCatalogMismatch && serverExists && serverReportedByUid === user.uid;

    const guard = evaluateReportSaveGuard({
      mode,
      canManage,
      expectedUpdatedAtMs,
      forceOverwrite: Boolean(forceOverwrite || selfDiagnosticHeaderTouched),
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

    if (!detectedOffline && serverExists) {
      const missingIds = activeRows
        .map((r) => r.itemId)
        .filter((id) => !mergedExistingEntries[id]);
      if (missingIds.length > 0) {
        const fetchedEntries = await io.fetchServerEntries(reportId, missingIds);
        Object.assign(mergedExistingEntries, fetchedEntries);
      }
    }

    const preparedOps = prepareStationReportEntries({
      workspace,
      userUid: user.uid,
      reporterName,
      canManage,
      date,
      station,
      reportId,
      mode,
      rows: activeRows,
      mergedExistingEntries,
      authorizedEmails,
      timestampValue: io.getServerTimestampValue(),
    });

    const entryChunks: PreparedEntryOp[][] = [];
    if (preparedOps.length === 0) {
      entryChunks.push([]);
    } else {
      for (let i = 0; i < preparedOps.length; i += MAX_BATCH_SIZE) {
        entryChunks.push(preparedOps.slice(i, i + MAX_BATCH_SIZE));
      }
    }

    const intermediateStatus: ReportStatus =
      serverExists && serverStatus === 'completed' ? 'completed' : 'opening_saved';

    const chunkInputs: BatchChunkCommitInput[] = entryChunks.map((chunk, chunkIdx) => {
      const isFirst = chunkIdx === 0;
      const isLast = chunkIdx === entryChunks.length - 1;
      const chunkStatus = isLast ? guard.effectiveStatus : intermediateStatus;

      let reportWrite: BatchChunkReportWrite | undefined;
      if (isFirst) {
        reportWrite = serverExists
          ? {
              kind: 'update',
              payload: {
                status: chunkStatus,
                reportedByUid: user.uid,
                reportedByName: reporterName,
                notes: cleanNotes,
                updatedAt: io.getServerTimestampValue(),
              },
            }
          : {
              kind: 'set',
              payload: {
                workspaceId: workspace.id,
                ownerUid: workspace.ownerUid,
                authorizedEmails,
                date,
                station,
                status: chunkStatus,
                reportedByUid: user.uid,
                reportedByName: reporterName,
                notes: cleanNotes,
                createdAt: io.getServerTimestampValue(),
                updatedAt: io.getServerTimestampValue(),
              },
            };
      } else if (isLast) {
        reportWrite = {
          kind: 'update',
          payload: {
            status: guard.effectiveStatus,
            reportedByUid: user.uid,
            reportedByName: reporterName,
            notes: cleanNotes,
            updatedAt: io.getServerTimestampValue(),
          },
        };
      }

      return {
        reportId,
        reportWrite,
        entryOps: chunk,
      };
    });

    try {
      const commitRes = await io.commitChunks(chunkInputs, detectedOffline);
      return {
        queuedOffline: commitRes.queuedOffline,
        catalogUpdatedDuringSave,
      };
    } catch (batchError) {
      const firstStepReportStatus: ReportStatus =
        preparedOps.length === 0 ? guard.effectiveStatus : intermediateStatus;

      try {
        await io.diagnoseChunkFailure({
          batchError,
          workspace,
          user,
          canManage,
          date,
          station,
          reportId,
          reporterName,
          cleanNotes,
          authorizedEmails,
          serverExists,
          firstStepReportStatus,
          effectiveStatus: guard.effectiveStatus,
          entryOps: preparedOps,
        });
        return {
          queuedOffline: false,
          catalogUpdatedDuringSave,
        };
      } catch (diagnosedError) {
        const isCatalogMismatch =
          diagnosedError instanceof DiagnosticSaveError && diagnosedError.code === 'catalog-mismatch';

        // Step 2: If save failed due to catalog mismatch, refresh items & retry ONCE automatically
        if (attempt === 0 && !detectedOffline && isCatalogMismatch) {
          retriedAfterCatalogMismatch = true;
          catalogUpdatedDuringSave = true;
          onStatusMessage?.('El jefe actualizó los insumos, actualizando…');
          continue;
        }

        throw diagnosedError;
      }
    }
  }

  return { queuedOffline: false, catalogUpdatedDuringSave };
}

export async function createWorkerNote(params: {
  workspace: Workspace;
  user: User;
  station: Workstation;
  text: string;
  item?: InventoryItem;
  quantity?: number;
  now?: Date;
}): Promise<string> {
  const { workspace, user, station, text, item, quantity, now = new Date() } = params;
  const noteId = makeCleanId('nota');
  const cleanText = clampString(text, MAX_WORKER_NOTE_LENGTH);
  if (!cleanText) {
    throw new Error('Escribe una nota antes de guardar.');
  }

  const authorName = clampString(
    user.displayName || user.email?.split('@')[0] || station.workerName || 'Encargada',
    MAX_NAME_LENGTH,
  );
  const authorizedEmails = buildNormalizedAuthorizedEmails(workspace);

  const payload: Record<string, unknown> = {
    workspaceId: workspace.id,
    ownerUid: workspace.ownerUid,
    authorizedEmails,
    station: station.id,
    authorUid: user.uid,
    authorName,
    date: getOperationalDateStr(now),
    timeLabel: clampString(formatBogotaTimeExact(now), MAX_TIME_LABEL_LENGTH),
    text: cleanText,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (item) {
    payload.itemId = item.id;
    payload.itemName = clampString(item.name, MAX_NAME_LENGTH);
    payload.itemUnit = clampString(getEffectiveItemUnit(item), MAX_UNIT_LENGTH);
  }
  if (typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 0) {
    payload.quantity = clampNumber(quantity);
  }

  try {
    await setDoc(doc(db, 'workerNotes', noteId), payload);
    return noteId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `workerNotes/${noteId}`);
  }
}

export async function updateWorkerNote(params: {
  noteId: string;
  text: string;
  item?: InventoryItem;
  quantity?: number;
}): Promise<void> {
  const { noteId, text, item, quantity } = params;
  const cleanText = clampString(text, MAX_WORKER_NOTE_LENGTH);
  if (!cleanText) {
    throw new Error('Escribe una nota antes de guardar.');
  }

  const updates: Record<string, unknown> = {
    text: cleanText,
    updatedAt: serverTimestamp(),
  };

  if (item) {
    updates.itemId = item.id;
    updates.itemName = clampString(item.name, MAX_NAME_LENGTH);
    updates.itemUnit = clampString(getEffectiveItemUnit(item), MAX_UNIT_LENGTH);
  } else {
    updates.itemId = deleteField();
    updates.itemName = deleteField();
    updates.itemUnit = deleteField();
  }

  if (typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 0) {
    updates.quantity = clampNumber(quantity);
  } else {
    updates.quantity = deleteField();
  }

  try {
    await updateDoc(doc(db, 'workerNotes', noteId), updates);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workerNotes/${noteId}`);
  }
}

export async function deleteWorkerNote(noteId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'workerNotes', noteId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `workerNotes/${noteId}`);
  }
}
