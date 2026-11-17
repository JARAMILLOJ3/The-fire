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
  DATE_PATTERN,
  DEFAULT_SHIFT_SCHEDULE,
  ID_PATTERN,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_STOCK_VALUE,
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
  getBogotaNowParts,
  getOperationalDateStr,
  getPreviousDateStr,
  getServerNow,
  syncServerClockOffset,
} from '../utils/date';
import {
  chunkArrayWithLimit,
  WORKER_ENTRY_BATCH_SIZE,
} from '../utils/batch';
import {
  formatAttemptedValuesSummary,
  getEffectiveItemUnit,
  type FailedItemOutcome,
  type SavedItemOutcome,
  type SaveItemAttemptValues,
} from '../utils/inventory';
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

export interface WorkerSaveProgress {
  savedCount: number;
  totalCount: number;
  phase: 'preparing' | 'entries' | 'report';
}

export class PartialBatchSaveError extends Error {
  readonly title: string;
  readonly detail: string;
  readonly failedDocumentPath: string;
  readonly code?: string;
  readonly rawDetail?: string;
  readonly savedItems: SavedItemOutcome[];
  readonly failedItems: FailedItemOutcome[];
  readonly remainingRows: DraftEntryRow[];
  readonly catalogUpdatedDuringSave: boolean;

  constructor(params: {
    title: string;
    detail: string;
    failedDocumentPath: string;
    code?: string;
    rawDetail?: string;
    savedItems: SavedItemOutcome[];
    failedItems: FailedItemOutcome[];
    remainingRows: DraftEntryRow[];
    catalogUpdatedDuringSave: boolean;
  }) {
    super(`${params.title}: ${params.detail}`);
    this.name = 'PartialBatchSaveError';
    this.title = params.title;
    this.detail = params.detail;
    this.failedDocumentPath = params.failedDocumentPath;
    this.code = params.code;
    this.rawDetail = params.rawDetail;
    this.savedItems = params.savedItems;
    this.failedItems = params.failedItems;
    this.remainingRows = params.remainingRows;
    this.catalogUpdatedDuringSave = params.catalogUpdatedDuringSave;
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
  const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (uniqueIds.length === 0) return [];
  if (options?.fromServer) {
    const { itemsById } = await fetchStationItemsFromServerMap(workspaceId, stationId, uniqueIds);
    const list = Object.values(itemsById);
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return list;
  }

  perfMetrics.recordRead('items', uniqueIds.length);
  const snaps = await Promise.all(
    uniqueIds.map((itemId) =>
      getDoc(doc(db, 'items', itemId)).catch((err) => {
        if (isFirebasePermissionDeniedError(err) || isFirebaseOfflineError(err)) {
          return null;
        }
        handleFirestoreError(err, OperationType.GET, `items/${itemId}`);
      }),
    ),
  );

  const list: InventoryItem[] = [];
  snaps.forEach((snap) => {
    if (!snap || !snap.exists()) return;
    const raw = snap.data() as Omit<InventoryItem, 'id'>;
    const normalizedStation = raw.station === 'hamburguesas' ? 'comida_rapida' : raw.station;
    if (raw.workspaceId === workspaceId && normalizedStation === stationId && raw.active) {
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
  const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (!reportId || uniqueIds.length === 0) return {};
  perfMetrics.recordRead('todayEntries', uniqueIds.length);
  const snaps = await Promise.all(
    uniqueIds.map((itemId) =>
      getDoc(doc(db, 'dailyReports', reportId, 'entries', itemId)).catch((err) => {
        if (isFirebasePermissionDeniedError(err) || isFirebaseOfflineError(err)) {
          return null;
        }
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
    if (snap && snap.exists()) {
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
      getDoc(doc(db, 'dailyReports', reportId)).catch((err) => {
        if (isFirebasePermissionDeniedError(err) || isFirebaseOfflineError(err)) {
          return null;
        }
        throw err;
      }),
    ]);

    const report =
      repSnap && repSnap.exists()
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
    const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
    if (!repSnap.exists() || uniqueIds.length === 0) {
      return { reportExists: repSnap.exists(), entries: {} };
    }

    perfMetrics.recordRead('yesterdayEntries', uniqueIds.length);
    const snaps = await Promise.all(
      uniqueIds.map((itemId) =>
        getDoc(doc(db, 'dailyReports', reportId, 'entries', itemId)).catch((err) => {
          if (isFirebasePermissionDeniedError(err) || isFirebaseOfflineError(err)) {
            return null;
          }
          throw err;
        }),
      ),
    );
    const map: Record<string, DailyReportEntry> = {};
    snaps.forEach((snap) => {
      if (snap && snap.exists()) {
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
  attemptedValues: SaveItemAttemptValues;
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
  skipEmptyOpeningGuard?: boolean;
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
    skipEmptyOpeningGuard,
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

    const VALID_OPENING_STATUSES = new Set(['confirmed_match', 'adjusted', 'manual']);
    const normalizeOpeningStatus = (
      val: unknown,
    ): DailyReportEntry['openingStatus'] | undefined =>
      typeof val === 'string' && VALID_OPENING_STATUSES.has(val)
        ? (val as DailyReportEntry['openingStatus'])
        : undefined;

    const rawPrevClosing =
      typeof row.previousClosing === 'number' && Number.isFinite(row.previousClosing)
        ? clampNumber(row.previousClosing)
        : typeof prev?.previousClosing === 'number' && Number.isFinite(prev.previousClosing)
          ? clampNumber(prev.previousClosing)
          : undefined;
    const previousClosingVal = rawPrevClosing;
    const explicitOpeningStatus = normalizeOpeningStatus(row.openingStatus);
    const prevOpeningStatus = normalizeOpeningStatus(prev?.openingStatus);
    const derivedOpeningStatus = notApplicable
      ? undefined
      : explicitOpeningStatus ??
        (hasOpening && previousClosingVal !== undefined
          ? openingVal === previousClosingVal
            ? 'confirmed_match'
            : 'adjusted'
          : hasOpening
            ? prevOpeningStatus ?? 'manual'
            : prevOpeningStatus);

    const safeReporterName = clampString(reporterName, MAX_NAME_LENGTH) || 'Encargada';

    const updateFields: Record<string, unknown> = {
      opening: openingVal,
      added: effectiveAdded,
      closing: closingVal,
      hasOpening,
      hasClosing,
      notApplicable,
      updatedByUid: userUid,
      updatedByName: safeReporterName,
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

    const effectiveMinStock = canManage
      ? clampNumber(row.minStock)
      : Number.isFinite(Number(row.minStock))
        ? Number(row.minStock)
        : clampNumber(row.minStock);
    const effectiveTargetStock = canManage
      ? clampNumber(row.targetStock)
      : Number.isFinite(Number(row.targetStock))
        ? Number(row.targetStock)
        : clampNumber(row.targetStock);

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
      minStock: effectiveMinStock,
      targetStock: effectiveTargetStock,
      opening: openingVal,
      added: effectiveAdded,
      closing: closingVal,
      hasOpening,
      hasClosing,
      notApplicable,
      updatedByUid: userUid,
      updatedByName: safeReporterName,
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
      attemptedValues: {
        unit: row.unit,
        minStock: effectiveMinStock,
        targetStock: effectiveTargetStock,
        opening: openingVal,
        added: effectiveAdded,
        closing: closingVal,
        notApplicable,
      },
      updateFields,
      createFields,
    });
  });

  if (
    !skipEmptyOpeningGuard &&
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

export interface SingleEntryDiagnosisInput {
  entryError: unknown;
  workspace: Workspace;
  user: User;
  canManage: boolean;
  date: string;
  station: StationId;
  reportId: string;
  op: PreparedEntryOp;
}

export interface WorkerSaveIO {
  syncClock: () => Promise<void>;
  getServerTimestampValue: () => unknown;
  fetchServerWorkspace?: (workspaceId: string) => Promise<Workspace | null>;
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
  diagnoseSingleEntryFailure?: (input: SingleEntryDiagnosisInput) => Promise<DiagnosticSaveError>;
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

export interface ServerDocProbe<T> {
  exists: boolean;
  data?: T;
  errorCode?: string;
  errorMessage?: string;
}

async function probeServerDoc<T>(
  ref: ReturnType<typeof doc>,
): Promise<ServerDocProbe<T>> {
  try {
    const snap = await getDocFromServer(ref);
    if (!snap.exists()) {
      return { exists: false };
    }
    return {
      exists: true,
      data: snap.data() as T,
    };
  } catch (err) {
    return {
      exists: false,
      errorCode: extractFirebaseCode(err) ?? 'read-error',
      errorMessage: extractRawErrorText(err),
    };
  }
}

export interface EntryRuleDiagnosisContext {
  entryError: unknown;
  workspace: Workspace;
  user: User;
  canManage: boolean;
  date: string;
  station: StationId;
  reportId: string;
  op: PreparedEntryOp;
  now?: Date;
  itemProbe: ServerDocProbe<Partial<InventoryItem>>;
  reportProbe: ServerDocProbe<Partial<DailyReport>>;
  workspaceProbe: ServerDocProbe<Partial<Workspace>>;
  entryProbe: ServerDocProbe<Partial<DailyReportEntry>>;
  memberProbe: ServerDocProbe<Partial<TeamMember>> | null;
}

export interface EntryRuleConditionEvaluation {
  condition: string;
  passed: boolean;
  summary: string;
}

export interface EntryRuleDiagnosisResult {
  error: DiagnosticSaveError;
  reasons: string[];
  evaluations: EntryRuleConditionEvaluation[];
  catalogMismatchDetected: boolean;
  workspaceMismatchDetected: boolean;
  existingEntryDetected: boolean;
}

function isValidEmailListForRules(emails: unknown): boolean {
  if (!Array.isArray(emails) || emails.length < 1 || emails.length > 15) {
    return false;
  }
  return emails.every(
    (email) =>
      typeof email === 'string' &&
      email.length >= 3 &&
      email.length <= MAX_EMAIL_LENGTH &&
      EMAIL_REGEX.test(email),
  );
}

function isFiniteStockBound(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= MAX_STOCK_VALUE;
}

const STRICT_HHMM_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function diagnoseEntryRuleViolations(
  ctx: EntryRuleDiagnosisContext,
): EntryRuleDiagnosisResult {
  const {
    entryError,
    workspace,
    user,
    canManage,
    date,
    station,
    reportId,
    op,
    now = getServerNow(),
    itemProbe,
    reportProbe,
    workspaceProbe,
    entryProbe,
    memberProbe,
  } = ctx;

  const entryPath = `dailyReports/${reportId}/entries/${op.itemId}`;
  const errCode = extractFirebaseCode(entryError);
  const rawEntryText = extractRawErrorText(entryError);
  const reasons: string[] = [];
  const evaluations: EntryRuleConditionEvaluation[] = [];
  let catalogMismatchDetected = false;
  let workspaceMismatchDetected = false;
  let existingEntryDetected = false;

  // 1. Auth checks (isVerifiedUser)
  const authFailures: string[] = [];
  if (!user.emailVerified) {
    const msg = 'tu cuenta de Google no tiene email verificado';
    reasons.push(msg);
    authFailures.push(msg);
  }
  if (!user.email || user.email.length > MAX_EMAIL_LENGTH) {
    const msg = 'tu cuenta de Google no tiene un email válido';
    reasons.push(msg);
    authFailures.push(msg);
  }
  evaluations.push({
    condition: '1. Usuario verificado (isVerifiedUser)',
    passed: authFailures.length === 0,
    summary:
      authFailures.length === 0
        ? `OK (uid=${user.uid}, email=${user.email ?? '?'})`
        : `FALLÓ (${authFailures.join('; ')})`,
  });

  // 2. Entry schema & path consistency (isValidDailyReportEntry)
  const schemaFailures: string[] = [];
  const expectedReportId = `${workspace.id}_${date}_${station}`;
  if (reportId !== expectedReportId) {
    const msg = `reportId ("${reportId}") ≠ esperado ("${expectedReportId}")`;
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (!ID_PATTERN.test(reportId)) {
    const msg = `reportId ("${reportId}") contiene caracteres inválidos`;
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (!ID_PATTERN.test(op.itemId)) {
    const msg = `itemId ("${op.itemId}") contiene caracteres inválidos`;
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (!DATE_PATTERN.test(date)) {
    const msg = `fecha ("${date}") no tiene formato YYYY-MM-DD`;
    reasons.push(msg);
    schemaFailures.push(msg);
  }

  const createFields = op.createFields;
  if (
    typeof createFields.itemName !== 'string' ||
    createFields.itemName.length < 1 ||
    createFields.itemName.length > MAX_NAME_LENGTH
  ) {
    const msg = `itemName inválido ("${String(createFields.itemName ?? '')}")`;
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (
    typeof createFields.unit !== 'string' ||
    createFields.unit.length < 1 ||
    createFields.unit.length > MAX_UNIT_LENGTH
  ) {
    const msg = `unidad inválida ("${String(createFields.unit ?? '')}")`;
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (
    typeof createFields.updatedByName !== 'string' ||
    createFields.updatedByName.length < 1 ||
    createFields.updatedByName.length > MAX_NAME_LENGTH
  ) {
    const msg = 'nombre de quien reporta vacío o demasiado largo';
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (op.kind === 'set' && !isValidEmailListForRules(createFields.authorizedEmails)) {
    workspaceMismatchDetected = true;
    const msg = 'lista authorizedEmails vacía o con correo inválido en el intento';
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (
    'openingStatus' in createFields &&
    createFields.openingStatus !== undefined &&
    createFields.openingStatus !== 'confirmed_match' &&
    createFields.openingStatus !== 'adjusted' &&
    createFields.openingStatus !== 'manual'
  ) {
    const msg = `openingStatus inválido ("${String(createFields.openingStatus)}")`;
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (
    !isFiniteStockBound(createFields.minStock) ||
    !isFiniteStockBound(createFields.targetStock) ||
    !isFiniteStockBound(createFields.opening) ||
    !isFiniteStockBound(createFields.added) ||
    !isFiniteStockBound(createFields.closing)
  ) {
    const msg =
      'algún valor numérico (mínimo/ideal/apertura/surtido/cierre) está fuera de 0..100000';
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  if (
    'previousClosing' in createFields &&
    createFields.previousClosing !== undefined &&
    !isFiniteStockBound(createFields.previousClosing)
  ) {
    const msg = `previousClosing fuera de rango (${String(createFields.previousClosing)})`;
    reasons.push(msg);
    schemaFailures.push(msg);
  }
  evaluations.push({
    condition: '2. Validez de campos (isValidDailyReportEntry)',
    passed: schemaFailures.length === 0,
    summary:
      schemaFailures.length === 0
        ? `OK (op=${op.kind}, unidad="${String(createFields.unit)}", rangos válidos)`
        : `FALLÓ (${schemaFailures.join('; ')})`,
  });

  // 3. Entry existence vs op.kind
  const entryStateFailures: string[] = [];
  if (entryProbe.errorCode) {
    const msg = `no se pudo verificar entrada en servidor (${entryProbe.errorCode}: ${entryProbe.errorMessage ?? ''})`;
    reasons.push(msg);
    entryStateFailures.push(msg);
  } else if (op.kind === 'set' && entryProbe.exists) {
    existingEntryDetected = true;
    const msg = 'este insumo ya existía en el reporte del servidor';
    reasons.push(msg);
    entryStateFailures.push(msg);
  } else if (op.kind === 'update' && !entryProbe.exists) {
    const msg = 'este insumo aún no existe como entrada en el reporte del servidor';
    reasons.push(msg);
    entryStateFailures.push(msg);
  } else if (op.kind === 'update' && !canManage && entryProbe.exists && entryProbe.data) {
    const existingEntry = entryProbe.data;
    if (existingEntry.itemName !== createFields.itemName) {
      catalogMismatchDetected = true;
      const msg = `nombre en entrada previa ("${existingEntry.itemName}") ≠ "${String(createFields.itemName)}"`;
      reasons.push(msg);
      entryStateFailures.push(msg);
    }
    if (existingEntry.unit !== createFields.unit) {
      catalogMismatchDetected = true;
      const msg = `unidad en entrada previa ("${existingEntry.unit}") ≠ "${String(createFields.unit)}"`;
      reasons.push(msg);
      entryStateFailures.push(msg);
    }
    if (existingEntry.minStock !== createFields.minStock) {
      catalogMismatchDetected = true;
      const msg = `minStock en entrada previa (${existingEntry.minStock}) ≠ ${String(createFields.minStock)}`;
      reasons.push(msg);
      entryStateFailures.push(msg);
    }
    if (existingEntry.targetStock !== createFields.targetStock) {
      catalogMismatchDetected = true;
      const msg = `targetStock en entrada previa (${existingEntry.targetStock}) ≠ ${String(createFields.targetStock)}`;
      reasons.push(msg);
      entryStateFailures.push(msg);
    }
  }
  evaluations.push({
    condition: '3. Estado previo de entrada (entries/{itemId})',
    passed: entryStateFailures.length === 0,
    summary:
      entryStateFailures.length === 0
        ? `OK (op=${op.kind}, existeEnServidor=${String(entryProbe.exists)})`
        : `FALLÓ (${entryStateFailures.join('; ')})`,
  });

  // 4. Item catalog check (entryMatchesItem)
  const catalogFailures: string[] = [];
  if (itemProbe.errorCode) {
    if (itemProbe.errorCode === 'permission-denied') {
      catalogMismatchDetected = true;
      const msg = `el insumo items/${op.itemId} ya no pertenece a este puesto o fue desasignado en el catálogo`;
      reasons.push(msg);
      catalogFailures.push(msg);
    } else {
      const msg = `no se pudo leer items/${op.itemId} (${itemProbe.errorCode}: ${itemProbe.errorMessage ?? ''})`;
      reasons.push(msg);
      catalogFailures.push(msg);
    }
  } else if (!itemProbe.exists) {
    catalogMismatchDetected = true;
    const msg = `el insumo items/${op.itemId} no existe en el servidor`;
    reasons.push(msg);
    catalogFailures.push(msg);
  } else if (itemProbe.data) {
    const it = itemProbe.data;
    const requiredItemFields: Array<keyof InventoryItem> = [
      'workspaceId',
      'station',
      'name',
      'unit',
      'minStock',
      'targetStock',
    ];
    for (const f of requiredItemFields) {
      if (!(f in it) || it[f] === undefined) {
        catalogMismatchDetected = true;
        const msg = `items/${op.itemId} no tiene el campo obligatorio "${f}"`;
        reasons.push(msg);
        catalogFailures.push(msg);
      }
    }
    if (it.workspaceId !== workspace.id) {
      catalogMismatchDetected = true;
      const msg = `workspaceId del catálogo (${it.workspaceId}) ≠ ${workspace.id}`;
      reasons.push(msg);
      catalogFailures.push(msg);
    }
    if (
      it.station !== station &&
      !(it.station === 'hamburguesas' && station === 'comida_rapida')
    ) {
      catalogMismatchDetected = true;
      const msg = `puesto en catálogo (${it.station}) ≠ ${station}`;
      reasons.push(msg);
      catalogFailures.push(msg);
    }
    if (it.name !== createFields.itemName) {
      catalogMismatchDetected = true;
      const msg = `nombre en catálogo ("${it.name}") ≠ "${String(createFields.itemName)}"`;
      reasons.push(msg);
      catalogFailures.push(msg);
    }
    const unitMatches =
      it.unit === createFields.unit ||
      (typeof it.unitLabel === 'string' && it.unitLabel === createFields.unit);
    if (!unitMatches) {
      catalogMismatchDetected = true;
      const msg = `unidad en catálogo ("${it.unit}"${it.unitLabel ? ` / unitLabel="${it.unitLabel}"` : ''}) ≠ "${String(createFields.unit)}"`;
      reasons.push(msg);
      catalogFailures.push(msg);
    }
    if (it.minStock !== createFields.minStock) {
      catalogMismatchDetected = true;
      const msg = `minStock en catálogo (${it.minStock}) ≠ ${String(createFields.minStock)}`;
      reasons.push(msg);
      catalogFailures.push(msg);
    }
    if (it.targetStock !== createFields.targetStock) {
      catalogMismatchDetected = true;
      const msg = `targetStock en catálogo (${it.targetStock}) ≠ ${String(createFields.targetStock)}`;
      reasons.push(msg);
      catalogFailures.push(msg);
    }
  }
  evaluations.push({
    condition: '4. Coincidencia con catálogo (entryMatchesItem en items/{itemId})',
    passed: catalogFailures.length === 0,
    summary:
      catalogFailures.length === 0
        ? `OK (items/${op.itemId} coincide en station=${station}, unidad="${String(createFields.unit)}", min=${String(createFields.minStock)}, ideal=${String(createFields.targetStock)})`
        : `FALLÓ (${catalogFailures.join('; ')})`,
  });

  // 5. Team member check (isActiveStationWorker)
  const memberFailures: string[] = [];
  if (memberProbe) {
    if (memberProbe.errorCode) {
      const msg = `no se pudo leer teamMembers/${user.uid} (${memberProbe.errorCode}: ${memberProbe.errorMessage ?? ''})`;
      reasons.push(msg);
      memberFailures.push(msg);
    } else if (!memberProbe.exists) {
      const msg = `no existe teamMembers/${user.uid}`;
      reasons.push(msg);
      memberFailures.push(msg);
    } else if (memberProbe.data) {
      const m = memberProbe.data;
      if (!m.active) {
        const msg = 'tu acceso en teamMembers está desactivado (active: false)';
        reasons.push(msg);
        memberFailures.push(msg);
      }
      if (m.workspaceId !== workspace.id) {
        const msg = `teamMembers.workspaceId (${m.workspaceId}) ≠ ${workspace.id}`;
        reasons.push(msg);
        memberFailures.push(msg);
      }
      if (
        m.station !== station &&
        !(m.station === 'hamburguesas' && station === 'comida_rapida')
      ) {
        const msg = `teamMembers.station (${m.station}) ≠ ${station}`;
        reasons.push(msg);
        memberFailures.push(msg);
      }
    }
  }
  evaluations.push({
    condition: '5. Membresía y puesto (isActiveStationWorker en teamMembers/{uid})',
    passed: memberFailures.length === 0,
    summary: !memberProbe
      ? 'OK (modo administrador/jefe)'
      : memberFailures.length === 0
        ? `OK (active=${String(memberProbe.data?.active)}, station=${String(memberProbe.data?.station)})`
        : `FALLÓ (${memberFailures.join('; ')})`,
  });

  // 6. Parent report check (reportAfterMatchesEntry & status != completed)
  const reportFailures: string[] = [];
  if (reportProbe.errorCode) {
    const msg = `no se pudo leer dailyReports/${reportId} (${reportProbe.errorCode}: ${reportProbe.errorMessage ?? ''})`;
    reasons.push(msg);
    reportFailures.push(msg);
  } else if (!reportProbe.exists) {
    const msg = `no existe dailyReports/${reportId} en el servidor`;
    reasons.push(msg);
    reportFailures.push(msg);
  } else if (reportProbe.data) {
    const rep = reportProbe.data;
    if (rep.status === 'completed') {
      const msg = `dailyReports/${reportId} está en estado completed`;
      reasons.push(msg);
      reportFailures.push(msg);
    }
    if (!rep.ownerUid) {
      const msg = `dailyReports/${reportId} no tiene ownerUid`;
      reasons.push(msg);
      reportFailures.push(msg);
    } else if (rep.ownerUid !== createFields.ownerUid) {
      workspaceMismatchDetected = true;
      const msg = `ownerUid del reporte (${rep.ownerUid}) ≠ "${String(createFields.ownerUid)}"`;
      reasons.push(msg);
      reportFailures.push(msg);
    }
    if (rep.workspaceId !== workspace.id) {
      const msg = `workspaceId del reporte (${rep.workspaceId}) ≠ ${workspace.id}`;
      reasons.push(msg);
      reportFailures.push(msg);
    }
    if (rep.date !== date) {
      const msg = `fecha del reporte (${rep.date}) ≠ ${date}`;
      reasons.push(msg);
      reportFailures.push(msg);
    }
    if (rep.station !== station) {
      const msg = `puesto del reporte (${rep.station}) ≠ ${station}`;
      reasons.push(msg);
      reportFailures.push(msg);
    }
  }
  evaluations.push({
    condition: '6. Estado del reporte padre (dailyReports/{reportId})',
    passed: reportFailures.length === 0,
    summary:
      reportFailures.length === 0
        ? `OK (status=${String(reportProbe.data?.status ?? '?')}, date=${date}, station=${station})`
        : `FALLÓ (${reportFailures.join('; ')})`,
  });

  // 7. Operational date check for workers (isValidWorkerOperationalDate)
  const dateFailures: string[] = [];
  const serverTodayOp = getOperationalDateStr(now);
  const serverPrevOp = getPreviousDateStr(serverTodayOp);
  if (!canManage) {
    if (date !== serverTodayOp && date !== serverPrevOp) {
      const msg = `fecha "${date}" fuera de ventana operativa del servidor (permitido: ${serverTodayOp} o ${serverPrevOp})`;
      reasons.push(msg);
      dateFailures.push(msg);
    }
  }
  evaluations.push({
    condition: '7. Fecha operativa (isValidWorkerOperationalDate)',
    passed: dateFailures.length === 0,
    summary:
      dateFailures.length === 0
        ? `OK (fecha=${date}, hoyOp=${serverTodayOp}, ayerOp=${serverPrevOp})`
        : `FALLÓ (${dateFailures.join('; ')})`,
  });

  // 8. Workspace & exact schedule evaluation (isWorkerWithinSchedule)
  const scheduleFailures: string[] = [];
  const bogotaTime = getBogotaNowParts(now).hhmm;
  if (workspaceProbe.errorCode) {
    const msg = `no se pudo leer workspaces/${workspace.id} (${workspaceProbe.errorCode}: ${workspaceProbe.errorMessage ?? ''})`;
    reasons.push(msg);
    scheduleFailures.push(msg);
  } else if (!workspaceProbe.exists) {
    const msg = `no existe workspaces/${workspace.id} en el servidor`;
    reasons.push(msg);
    scheduleFailures.push(msg);
  } else if (workspaceProbe.data) {
    const ws = workspaceProbe.data;
    if (ws.ownerUid !== createFields.ownerUid) {
      workspaceMismatchDetected = true;
      const msg = `ownerUid del restaurante en servidor (${ws.ownerUid}) ≠ "${String(createFields.ownerUid)}"`;
      reasons.push(msg);
      scheduleFailures.push(msg);
    }
    if (!canManage) {
      const rawSchedule = ws.shiftSchedule;
      const effectiveSchedule = rawSchedule ?? DEFAULT_SHIFT_SCHEDULE;
      if (rawSchedule) {
        const timeKeys: Array<
          'openingStart' | 'openingEnd' | 'closingStart' | 'closingEnd'
        > = ['openingStart', 'openingEnd', 'closingStart', 'closingEnd'];
        for (const tk of timeKeys) {
          const rawVal = rawSchedule[tk];
          if (typeof rawVal !== 'string' || !STRICT_HHMM_REGEX.test(rawVal)) {
            const msg = `workspaces/${workspace.id}.shiftSchedule.${tk} tiene formato "${String(rawVal)}" (se espera HH:mm de 5 caracteres, ej. "01:00")`;
            reasons.push(msg);
            scheduleFailures.push(msg);
          }
        }
      }
      if (!rawSchedule) {
        const evalRes = resolveWorkerScheduleStatus(now, DEFAULT_SHIFT_SCHEDULE);
        if (evalRes.phase === 'outside') {
          const msg = `workspaces/${workspace.id} no tiene shiftSchedule guardado y la hora servidor (${bogotaTime} Bogotá) está fuera del horario por defecto (${DEFAULT_SHIFT_SCHEDULE.openingStart}–${DEFAULT_SHIFT_SCHEDULE.openingEnd} / ${DEFAULT_SHIFT_SCHEDULE.closingStart}–${DEFAULT_SHIFT_SCHEDULE.closingEnd})`;
          reasons.push(msg);
          scheduleFailures.push(msg);
        }
      } else if (effectiveSchedule.enabled) {
        const evalRes = resolveWorkerScheduleStatus(now, effectiveSchedule);
        if (evalRes.phase === 'outside') {
          const msg = `hora servidor (${bogotaTime} Bogotá) fuera de horario (${effectiveSchedule.openingStart}–${effectiveSchedule.openingEnd} / ${effectiveSchedule.closingStart}–${effectiveSchedule.closingEnd}), fecha: ${date}`;
          reasons.push(msg);
          scheduleFailures.push(msg);
        }
      }
    }
  }
  evaluations.push({
    condition: '8. Horario y restaurante (isWorkerWithinSchedule en workspaces/{id})',
    passed: scheduleFailures.length === 0,
    summary:
      scheduleFailures.length === 0
        ? `OK (horaBogotá=${bogotaTime}, enabled=${String(workspaceProbe.data?.shiftSchedule?.enabled ?? 'default(true)')})`
        : `FALLÓ (${scheduleFailures.join('; ')})`,
  });

  const probeStatusSummary = [
    `item=${itemProbe.errorCode ?? (itemProbe.exists ? 'ok' : 'missing')}`,
    `report=${reportProbe.errorCode ?? (reportProbe.exists ? `ok(${reportProbe.data?.status ?? '?'})` : 'missing')}`,
    `workspace=${workspaceProbe.errorCode ?? (workspaceProbe.exists ? `ok(sched=${workspaceProbe.data?.shiftSchedule?.enabled ? 'on' : 'off'})` : 'missing')}`,
    `entry=${entryProbe.errorCode ?? (entryProbe.exists ? 'exists' : 'absent')}`,
    memberProbe
      ? `member=${memberProbe.errorCode ?? (memberProbe.exists ? `ok(active=${String(memberProbe.data?.active)},station=${String(memberProbe.data?.station)})` : 'missing')}`
      : 'member=manager',
  ].join(', ');

  const checklistLines = evaluations
    .map((ev) => `- ${ev.condition}: ${ev.summary}`)
    .join('\n');

  const valuesSummary = formatAttemptedValuesSummary(op.attemptedValues);
  const opLabel = op.kind === 'update' ? 'actualización' : 'creación';
  const detail =
    reasons.length > 0
      ? `"${op.itemName}" (${opLabel}): ${reasons.join('; ')}. Valores intentados: ${valuesSummary}.`
      : `"${op.itemName}" (${opLabel}) fue rechazado por las reglas de Firestore (${errCode ?? 'permission-denied'}) aunque las 8 condiciones verificadas en servidor dieron OK (posible límite de expresiones CEL o regla desactualizada en Firebase). Estado servidor: [${probeStatusSummary}]. Valores intentados: ${valuesSummary}.`;
  const rawDetail = `${detail}\nDocumento: ${entryPath}\nEstado servidor: [${probeStatusSummary}]\nEvaluación por condición de regla:\n${checklistLines}\nFirebase (${errCode ?? 'sin código'}): ${rawEntryText}`;

  const errorCode = catalogMismatchDetected
    ? 'catalog-mismatch'
    : workspaceMismatchDetected
      ? 'workspace-mismatch'
      : existingEntryDetected
        ? 'existing-entry'
        : errCode;

  return {
    error: new DiagnosticSaveError({
      title: catalogMismatchDetected
        ? `El catálogo de "${op.itemName}" cambió en el servidor`
        : `Error al guardar insumo "${op.itemName}"`,
      detail,
      rawDetail,
      failedDocumentPath: entryPath,
      code: errorCode,
    }),
    reasons,
    evaluations,
    catalogMismatchDetected,
    workspaceMismatchDetected,
    existingEntryDetected,
  };
}

async function inspectSingleEntryMismatchFromServer(
  input: SingleEntryDiagnosisInput,
): Promise<DiagnosticSaveError> {
  const { workspace, user, canManage, reportId, op } = input;
  const [itemProbe, reportProbe, workspaceProbe, entryProbe, memberProbe] = await Promise.all([
    probeServerDoc<Partial<InventoryItem>>(doc(db, 'items', op.itemId)),
    probeServerDoc<Partial<DailyReport>>(doc(db, 'dailyReports', reportId)),
    probeServerDoc<Partial<Workspace>>(doc(db, 'workspaces', workspace.id)),
    probeServerDoc<Partial<DailyReportEntry>>(
      doc(db, 'dailyReports', reportId, 'entries', op.itemId),
    ),
    !canManage
      ? probeServerDoc<Partial<TeamMember>>(doc(db, 'teamMembers', user.uid))
      : Promise.resolve(null),
  ]);

  const result = diagnoseEntryRuleViolations({
    ...input,
    itemProbe,
    reportProbe,
    workspaceProbe,
    entryProbe,
    memberProbe,
  });
  return result.error;
}

function createDefaultWorkerSaveIO(): WorkerSaveIO {
  return {
    syncClock: async () => {
      await syncServerClockOffset();
    },
    getServerTimestampValue: () => serverTimestamp(),
    fetchServerWorkspace: async (workspaceId) => {
      const wsRef = doc(db, 'workspaces', workspaceId);
      try {
        const snap = await getDocFromServer(wsRef);
        return snap.exists() ? ({ id: snap.id, ...snap.data() } as Workspace) : null;
      } catch (err) {
        if (isFirebaseOfflineError(err)) {
          const cached = await getDoc(wsRef).catch(() => null);
          return cached?.exists() ? ({ id: cached.id, ...cached.data() } as Workspace) : null;
        }
        return null;
      }
    },
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
      await Promise.all(
        itemIds.map(async (itemId) => {
          const ref = doc(db, 'dailyReports', reportId, 'entries', itemId);
          try {
            let snap;
            try {
              snap = await getDocFromServer(ref);
            } catch (serverErr) {
              if (isFirebaseOfflineError(serverErr)) {
                snap = await getDoc(ref);
              } else {
                return;
              }
            }
            if (snap.exists()) {
              const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
              map[entry.itemId] = entry;
            }
          } catch {
            // Proceed with local entries if offline or inaccessible
          }
        }),
      );
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
    diagnoseSingleEntryFailure: inspectSingleEntryMismatchFromServer,
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

      if (entryOps.length === 0) {
        try {
          if (liveReportExists) {
            await updateDoc(reportRef, {
              status: effectiveStatus,
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
          if (!liveReportExists && !isValidEmailListForRules(authorizedEmails)) {
            reasons.push('lista authorizedEmails vacía o con correo inválido en el encabezado');
          }

          const now = getServerNow();
          const [memProbe, wsProbe, repProbe] = await Promise.all([
            !canManage
              ? probeServerDoc<Partial<TeamMember>>(doc(db, 'teamMembers', user.uid))
              : Promise.resolve(null),
            probeServerDoc<Partial<Workspace>>(doc(db, 'workspaces', workspace.id)),
            probeServerDoc<Partial<DailyReport>>(reportRef),
          ]);

          if (memProbe) {
            if (memProbe.errorCode) {
              reasons.push(
                `no se pudo leer teamMembers/${user.uid} (${memProbe.errorCode}: ${memProbe.errorMessage ?? ''})`,
              );
            } else if (!memProbe.exists) {
              reasons.push(`no existe teamMembers/${user.uid}`);
            } else if (memProbe.data) {
              const m = memProbe.data;
              if (!m.active) reasons.push('tu acceso en teamMembers está desactivado (active: false)');
              if (m.workspaceId !== workspace.id) {
                reasons.push(`teamMembers.workspaceId (${m.workspaceId}) no coincide con ${workspace.id}`);
              }
              if (
                m.station !== station &&
                !(m.station === 'hamburguesas' && station === 'comida_rapida')
              ) {
                reasons.push(`teamMembers.station (${m.station}) no coincide con ${station}`);
              }
            }
          }

          if (!canManage) {
            const serverTodayOp = getOperationalDateStr(now);
            const serverPrevOp = getPreviousDateStr(serverTodayOp);
            if (date !== serverTodayOp && date !== serverPrevOp) {
              reasons.push(
                `fecha "${date}" fuera de ventana operativa del servidor (permitido: ${serverTodayOp} o ${serverPrevOp})`,
              );
            }
          }

          if (wsProbe.errorCode) {
            reasons.push(
              `no se pudo leer workspaces/${workspace.id} (${wsProbe.errorCode}: ${wsProbe.errorMessage ?? ''})`,
            );
          } else if (!wsProbe.exists) {
            reasons.push(`no existe workspaces/${workspace.id} en el servidor`);
          } else if (wsProbe.data) {
            const ws = wsProbe.data;
            if (ws.ownerUid !== workspace.ownerUid) {
              reasons.push(
                `ownerUid del restaurante en servidor (${ws.ownerUid}) ≠ ${workspace.ownerUid}`,
              );
            }
            if (!canManage) {
              const effSchedule = ws.shiftSchedule ?? DEFAULT_SHIFT_SCHEDULE;
              const bogotaTime = getBogotaNowParts(now).hhmm;
              if (!ws.shiftSchedule || effSchedule.enabled) {
                const evalRes = resolveWorkerScheduleStatus(now, effSchedule);
                if (evalRes.phase === 'outside') {
                  reasons.push(
                    `hora servidor (${bogotaTime} Bogotá) fuera de horario (${effSchedule.openingStart}–${effSchedule.openingEnd} / ${effSchedule.closingStart}–${effSchedule.closingEnd}), fecha reporte: ${date}`,
                  );
                }
              }
            }
          }

          if (repProbe.errorCode) {
            reasons.push(
              `no se pudo leer dailyReports/${reportId} (${repProbe.errorCode}: ${repProbe.errorMessage ?? ''})`,
            );
          } else if (repProbe.exists && repProbe.data?.status === 'completed') {
            reasons.push('el reporte ya está marcado como completed');
          }

          const probeSummary = [
            `report=${repProbe.errorCode ?? (repProbe.exists ? `ok(${repProbe.data?.status ?? '?'})` : 'absent')}`,
            `workspace=${wsProbe.errorCode ?? (wsProbe.exists ? `ok(sched=${wsProbe.data?.shiftSchedule?.enabled ? 'on' : 'off'})` : 'missing')}`,
            memProbe
              ? `member=${memProbe.errorCode ?? (memProbe.exists ? `ok(active=${String(memProbe.data?.active)},station=${String(memProbe.data?.station)})` : 'missing')}`
              : 'member=manager',
          ].join(', ');

          const opLabel = liveReportExists ? 'actualización' : 'creación';
          const detail =
            reasons.length > 0
              ? `Documento rechazado: dailyReports/${reportId} (${opLabel}). Motivo: ${reasons.join('; ')}.`
              : `Documento rechazado: dailyReports/${reportId} (${opLabel}). Estado servidor: [${probeSummary}].`;
          const rawDetail = `${detail}\nEstado servidor: [${probeSummary}]\nFirebase (${errCode ?? 'sin código'}): ${extractRawErrorText(reportWriteError) || batchRawText}`;

          throw new DiagnosticSaveError({
            title: 'Firebase rechazó el encabezado del reporte',
            detail,
            rawDetail,
            failedDocumentPath: `dailyReports/${reportId}`,
            code: errCode,
          });
        }
        return;
      }

      if (entryOps.length === 1) {
        const diag = await inspectSingleEntryMismatchFromServer({
          entryError: batchError,
          workspace,
          user,
          canManage,
          date,
          station,
          reportId,
          op: entryOps[0],
        });
        throw diag;
      }
    },
  };
}

function buildEntrySnapshotFromOp(
  op: PreparedEntryOp,
  reportId: string,
  userUid: string,
  reporterName: string,
): DailyReportEntry {
  return {
    id: op.itemId,
    workspaceId: String(op.createFields.workspaceId ?? ''),
    ownerUid: String(op.createFields.ownerUid ?? ''),
    authorizedEmails: Array.isArray(op.createFields.authorizedEmails)
      ? (op.createFields.authorizedEmails as string[])
      : [],
    reportId,
    itemId: op.itemId,
    station: String(op.createFields.station ?? ''),
    date: String(op.createFields.date ?? ''),
    itemName: op.itemName,
    unit: op.attemptedValues.unit,
    minStock: op.attemptedValues.minStock,
    targetStock: op.attemptedValues.targetStock,
    opening: op.attemptedValues.opening,
    added: op.attemptedValues.added,
    closing: op.attemptedValues.closing,
    hasOpening: op.hasOpening,
    hasClosing: op.hasClosing,
    notApplicable: op.notApplicable,
    previousClosing:
      typeof op.createFields.previousClosing === 'number'
        ? op.createFields.previousClosing
        : undefined,
    openingStatus:
      typeof op.createFields.openingStatus === 'string'
        ? (op.createFields.openingStatus as DailyReportEntry['openingStatus'])
        : undefined,
    updatedByUid: userUid,
    updatedByName: reporterName,
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
  previousSavedItems?: SavedItemOutcome[];
  skipEmptyOpeningGuard?: boolean;
  now?: Date;
  onStatusMessage?: (message: string) => void;
  onProgress?: (progress: WorkerSaveProgress) => void;
  onPartialSaved?: (savedEntries: Record<string, DailyReportEntry>) => void;
  onCatalogSynced?: (items: InventoryItem[]) => void;
  io?: Partial<WorkerSaveIO>;
}): Promise<{ queuedOffline: boolean; catalogUpdatedDuringSave?: boolean; savedCount: number }> {
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
    previousSavedItems = [],
    skipEmptyOpeningGuard,
    now: providedNow,
    onStatusMessage,
    onProgress,
    onPartialSaved,
    onCatalogSynced,
    io: customIO,
  } = params;

  const defaultIO = createDefaultWorkerSaveIO();
  const io: WorkerSaveIO = {
    syncClock: customIO?.syncClock ?? defaultIO.syncClock,
    getServerTimestampValue: customIO?.getServerTimestampValue ?? defaultIO.getServerTimestampValue,
    fetchServerWorkspace: customIO?.fetchServerWorkspace ?? (customIO ? undefined : defaultIO.fetchServerWorkspace),
    fetchServerItems: customIO?.fetchServerItems ?? defaultIO.fetchServerItems,
    fetchServerReport: customIO?.fetchServerReport ?? defaultIO.fetchServerReport,
    fetchServerEntries: customIO?.fetchServerEntries ?? defaultIO.fetchServerEntries,
    commitChunks: customIO?.commitChunks ?? defaultIO.commitChunks,
    diagnoseSingleEntryFailure: customIO?.diagnoseSingleEntryFailure,
    diagnoseChunkFailure: customIO?.diagnoseChunkFailure ?? defaultIO.diagnoseChunkFailure,
  };

  let effectiveWorkspace = workspace;
  const reportId = `${effectiveWorkspace.id}_${date}_${station}`;
  const reporterName =
    clampString(
      (user.displayName ?? '').trim() ||
        (user.email?.split('@')[0] ?? '').trim() ||
        'Encargada',
      MAX_NAME_LENGTH,
    ) || 'Encargada';
  const cleanNotes = clampString(notes, MAX_NOTES_LENGTH);
  let authorizedEmails = buildNormalizedAuthorizedEmails(effectiveWorkspace);

  let detectedOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (!detectedOffline && !providedNow) {
    await io.syncClock();
  }
  if (
    !detectedOffline &&
    io.fetchServerWorkspace &&
    (authorizedEmails.length === 0 || !effectiveWorkspace.ownerUid)
  ) {
    const serverWs = await io.fetchServerWorkspace(effectiveWorkspace.id);
    if (serverWs) {
      effectiveWorkspace = serverWs;
      authorizedEmails = buildNormalizedAuthorizedEmails(effectiveWorkspace);
    }
  }
  const effectiveNow = providedNow ?? getServerNow();
  validateWorkerSubmitPhase({
    canManage,
    mode,
    schedule: effectiveWorkspace.shiftSchedule,
    now: effectiveNow,
    reportPath: `dailyReports/${reportId}`,
  });

  let catalogUpdatedDuringSave = false;
  let activeRows = rows;
  const mergedExistingEntries: Record<string, DailyReportEntry> = { ...existingEntries };

  // Step 1: Read station items directly from the server (never from cache)
  if (!detectedOffline && activeRows.length > 0) {
    const serverCatalog = await io.fetchServerItems(
      effectiveWorkspace.id,
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
      if (reconciled.updatedItemIds.length > 0 || reconciled.removedItemIds.length > 0) {
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
        if (
          io.fetchServerWorkspace &&
          serverRep.data.ownerUid &&
          serverRep.data.ownerUid !== effectiveWorkspace.ownerUid
        ) {
          const serverWs = await io.fetchServerWorkspace(effectiveWorkspace.id);
          if (serverWs) {
            effectiveWorkspace = serverWs;
            authorizedEmails = buildNormalizedAuthorizedEmails(effectiveWorkspace);
          }
        }
      } else {
        serverStatus = undefined;
        serverUpdatedAtMs = null;
        serverUpdatedByName = undefined;
        serverReportedByUid = undefined;
      }
    }
  }

  // If retrying after a previous partial save where this same worker created/updated the 'open'/'opening_saved' header,
  // allow finishing pending entries without tripping against our own prior header write.
  const sameWorkerRetryAfterPartial =
    previousSavedItems.length > 0 &&
    serverExists &&
    serverReportedByUid === user.uid &&
    serverStatus !== 'completed';

  const guard = evaluateReportSaveGuard({
    mode,
    canManage,
    expectedUpdatedAtMs,
    forceOverwrite: Boolean(forceOverwrite || sameWorkerRetryAfterPartial),
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

  const hasSavedOpeningFromPrevious =
    previousSavedItems.length > 0 ||
    Object.values(mergedExistingEntries).some((e) => e.hasOpening || e.notApplicable);

  const preparedOps = prepareStationReportEntries({
    workspace: effectiveWorkspace,
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
    skipEmptyOpeningGuard: Boolean(skipEmptyOpeningGuard || hasSavedOpeningFromPrevious),
  });

  const entryChunks = chunkArrayWithLimit(preparedOps, WORKER_ENTRY_BATCH_SIZE);

  // Offline mode: enqueue all small <=4-item batches + final report update batch
  if (detectedOffline) {
    const offlineChunks: BatchChunkCommitInput[] = [];
    if (entryChunks.length === 0) {
      offlineChunks.push({
        reportId,
        reportWrite: serverExists
          ? {
              kind: 'update',
              payload: {
                status: guard.effectiveStatus,
                reportedByUid: user.uid,
                reportedByName: reporterName,
                notes: cleanNotes,
                updatedAt: io.getServerTimestampValue(),
              },
            }
          : {
              kind: 'set',
              payload: {
                workspaceId: effectiveWorkspace.id,
                ownerUid: effectiveWorkspace.ownerUid,
                authorizedEmails,
                date,
                station,
                status: guard.effectiveStatus,
                reportedByUid: user.uid,
                reportedByName: reporterName,
                notes: cleanNotes,
                createdAt: io.getServerTimestampValue(),
                updatedAt: io.getServerTimestampValue(),
              },
            },
        entryOps: [],
      });
    } else {
      entryChunks.forEach((chunk, idx) => {
        const isFirst = idx === 0;
        offlineChunks.push({
          reportId,
          reportWrite:
            isFirst && !serverExists
              ? {
                  kind: 'set',
                  payload: {
                    workspaceId: effectiveWorkspace.id,
                    ownerUid: effectiveWorkspace.ownerUid,
                    authorizedEmails,
                    date,
                    station,
                    status: 'open',
                    reportedByUid: user.uid,
                    reportedByName: reporterName,
                    notes: cleanNotes,
                    createdAt: io.getServerTimestampValue(),
                    updatedAt: io.getServerTimestampValue(),
                  },
                }
              : undefined,
          entryOps: chunk,
        });
      });

      offlineChunks.push({
        reportId,
        reportWrite: {
          kind: 'update',
          payload: {
            status: guard.effectiveStatus,
            reportedByUid: user.uid,
            reportedByName: reporterName,
            notes: cleanNotes,
            updatedAt: io.getServerTimestampValue(),
          },
        },
        entryOps: [],
      });
    }

    const res = await io.commitChunks(offlineChunks, true);
    return {
      queuedOffline: res.queuedOffline,
      catalogUpdatedDuringSave,
      savedCount: previousSavedItems.length + preparedOps.length,
    };
  }

  // Carry over items already saved before a retry (excluding those being re-sent now)
  const pendingIdsSet = new Set(preparedOps.map((op) => op.itemId));
  const savedItems: SavedItemOutcome[] = previousSavedItems.filter(
    (item) => !pendingIdsSet.has(item.itemId),
  );
  const failedItems: FailedItemOutcome[] = [];
  const newlySavedEntries: Record<string, DailyReportEntry> = {};

  let savedCount = savedItems.length;
  const totalCount = savedItems.length + preparedOps.length;
  onProgress?.({ savedCount, totalCount, phase: 'preparing' });

  const buildReportSetPayload = (statusValue: ReportStatus): Record<string, unknown> => ({
    workspaceId: effectiveWorkspace.id,
    ownerUid: effectiveWorkspace.ownerUid,
    authorizedEmails,
    date,
    station,
    status: statusValue,
    reportedByUid: user.uid,
    reportedByName: reporterName,
    notes: cleanNotes,
    createdAt: io.getServerTimestampValue(),
    updatedAt: io.getServerTimestampValue(),
  });

  const buildReportUpdatePayload = (statusValue: ReportStatus): Record<string, unknown> => ({
    status: statusValue,
    reportedByUid: user.uid,
    reportedByName: reporterName,
    notes: cleanNotes,
    updatedAt: io.getServerTimestampValue(),
  });

  // If no entry mutations are needed (e.g., all rows unchanged or boss notes update), commit final report directly
  if (entryChunks.length === 0) {
    onProgress?.({ savedCount, totalCount, phase: 'report' });
    const finalReportChunk: BatchChunkCommitInput = {
      reportId,
      reportWrite: serverExists
        ? { kind: 'update', payload: buildReportUpdatePayload(guard.effectiveStatus) }
        : { kind: 'set', payload: buildReportSetPayload(guard.effectiveStatus) },
      entryOps: [],
    };
    try {
      await io.commitChunks([finalReportChunk], false);
      return { queuedOffline: false, catalogUpdatedDuringSave, savedCount };
    } catch (reportErr) {
      await io.diagnoseChunkFailure({
        batchError: reportErr,
        workspace: effectiveWorkspace,
        user,
        canManage,
        date,
        station,
        reportId,
        reporterName,
        cleanNotes,
        authorizedEmails,
        serverExists,
        firstStepReportStatus: guard.effectiveStatus,
        effectiveStatus: guard.effectiveStatus,
        entryOps: [],
      });
      throw reportErr;
    }
  }

  // Online Step A: Ensure parent dailyReport exists in 'open' status BEFORE entries so entry chunks never mark completed/opening_saved prematurely
  if (!serverExists) {
    const initHeaderChunk: BatchChunkCommitInput = {
      reportId,
      reportWrite: { kind: 'set', payload: buildReportSetPayload('open') },
      entryOps: [],
    };
    try {
      await io.commitChunks([initHeaderChunk], false);
      serverExists = true;
    } catch (headerErr) {
      await io.diagnoseChunkFailure({
        batchError: headerErr,
        workspace: effectiveWorkspace,
        user,
        canManage,
        date,
        station,
        reportId,
        reporterName,
        cleanNotes,
        authorizedEmails,
        serverExists: false,
        firstStepReportStatus: 'open',
        effectiveStatus: 'open',
        entryOps: [],
      });
      throw headerErr;
    }
  }

  onProgress?.({ savedCount, totalCount, phase: 'entries' });

  const diagnoseSingleOp = async (
    op: PreparedEntryOp,
    entryError: unknown,
  ): Promise<DiagnosticSaveError> => {
    const input: SingleEntryDiagnosisInput = {
      entryError,
      workspace: effectiveWorkspace,
      user,
      canManage,
      date,
      station,
      reportId,
      op,
    };
    if (customIO?.diagnoseSingleEntryFailure) {
      return await customIO.diagnoseSingleEntryFailure(input);
    }
    if (customIO?.diagnoseChunkFailure) {
      try {
        await customIO.diagnoseChunkFailure({
          batchError: entryError,
          workspace: effectiveWorkspace,
          user,
          canManage,
          date,
          station,
          reportId,
          reporterName,
          cleanNotes,
          authorizedEmails,
          serverExists,
          firstStepReportStatus: 'open',
          effectiveStatus: guard.effectiveStatus,
          entryOps: [op],
        });
      } catch (diagnosed) {
        if (diagnosed instanceof DiagnosticSaveError) {
          return diagnosed;
        }
        return new DiagnosticSaveError({
          title: `Error al guardar insumo "${op.itemName}"`,
          detail: `${extractRawErrorText(diagnosed)}. Valores intentados: ${formatAttemptedValuesSummary(op.attemptedValues)}.`,
          rawDetail: extractRawErrorText(diagnosed),
          failedDocumentPath: `dailyReports/${reportId}/entries/${op.itemId}`,
          code: extractFirebaseCode(diagnosed) ?? extractFirebaseCode(entryError),
        });
      }
    }
    return await inspectSingleEntryMismatchFromServer(input);
  };

  const refreshSingleOpFromServer = async (
    op: PreparedEntryOp,
  ): Promise<{ refreshedOp: PreparedEntryOp | null; omitted: boolean }> => {
    const singleCatalog = await io.fetchServerItems(effectiveWorkspace.id, station, [op.itemId]);
    if (singleCatalog.offlineFallback) {
      return { refreshedOp: null, omitted: false };
    }
    const sourceRow = activeRows.find((r) => r.itemId === op.itemId);
    if (!sourceRow) {
      return { refreshedOp: null, omitted: false };
    }
    const reconciled = reconcileRowsWithServerCatalog({
      rows: [sourceRow],
      serverItemsById: singleCatalog.itemsById,
      removedOrMovedIds: singleCatalog.removedOrMovedIds,
      existingEntries: mergedExistingEntries,
    });
    if (reconciled.removedItemIds.length > 0 || reconciled.rows.length === 0) {
      return { refreshedOp: null, omitted: true };
    }
    if (reconciled.serverItems.length > 0) {
      onCatalogSynced?.(reconciled.serverItems);
    }
    const rebuiltOps = prepareStationReportEntries({
      workspace: effectiveWorkspace,
      userUid: user.uid,
      reporterName,
      canManage,
      date,
      station,
      reportId,
      mode,
      rows: reconciled.rows,
      mergedExistingEntries,
      authorizedEmails,
      timestampValue: io.getServerTimestampValue(),
      skipEmptyOpeningGuard: true,
    });
    return { refreshedOp: rebuiltOps[0] ?? null, omitted: rebuiltOps.length === 0 };
  };

  const recordOpSaved = (op: PreparedEntryOp) => {
    savedItems.push({ itemId: op.itemId, itemName: op.itemName });
    const entrySnap = buildEntrySnapshotFromOp(op, reportId, user.uid, reporterName);
    newlySavedEntries[op.itemId] = entrySnap;
    mergedExistingEntries[op.itemId] = entrySnap;
    savedCount += 1;
    onProgress?.({ savedCount, totalCount, phase: 'entries' });
  };

  const handleFailedSingleOp = async (op: PreparedEntryOp, err: unknown) => {
    let diag = await diagnoseSingleOp(op, err);
    let workingOp = op;

    // Single automatic retry for catalog mismatch, stale client workspace cache, or pre-existing server entry
    if (
      !canManage &&
      (diag.code === 'catalog-mismatch' ||
        diag.code === 'workspace-mismatch' ||
        diag.code === 'existing-entry')
    ) {
      if (diag.code === 'workspace-mismatch' && io.fetchServerWorkspace) {
        const freshWs = await io.fetchServerWorkspace(effectiveWorkspace.id);
        if (freshWs) {
          effectiveWorkspace = freshWs;
          authorizedEmails = buildNormalizedAuthorizedEmails(freshWs);
        }
      }
      if (diag.code === 'existing-entry') {
        const freshEntries = await io.fetchServerEntries(reportId, [op.itemId]);
        if (freshEntries[op.itemId]) {
          mergedExistingEntries[op.itemId] = freshEntries[op.itemId];
        }
      } else {
        catalogUpdatedDuringSave = true;
      }
      onStatusMessage?.(
        diag.code === 'workspace-mismatch'
          ? 'Actualizando configuración del restaurante…'
          : diag.code === 'existing-entry'
            ? 'Sincronizando entrada existente…'
            : 'El jefe actualizó los insumos, actualizando…',
      );
      const refreshRes = await refreshSingleOpFromServer(op);
      if (refreshRes.omitted) {
        return;
      }
      if (refreshRes.refreshedOp) {
        workingOp = refreshRes.refreshedOp;
        try {
          await io.commitChunks([{ reportId, entryOps: [workingOp] }], false);
          recordOpSaved(workingOp);
          return;
        } catch (retryErr) {
          diag = await diagnoseSingleOp(workingOp, retryErr);
        }
      }
    }

    const valuesSummary = formatAttemptedValuesSummary(workingOp.attemptedValues);
    const reasonWithValues = diag.detail.includes('Valores intentados:')
      ? diag.detail
      : `${diag.detail} Valores intentados: ${valuesSummary}.`;

    failedItems.push({
      itemId: workingOp.itemId,
      itemName: workingOp.itemName,
      reason: reasonWithValues,
      code: diag.code,
      rawDetail: diag.rawDetail,
      failedDocumentPath: diag.failedDocumentPath || `dailyReports/${reportId}/entries/${workingOp.itemId}`,
      attemptedValues: workingOp.attemptedValues,
    });
  };

  // Online Step B: Commit entries in small <=4-item batches; isolate item-by-item on chunk rejection
  for (const chunk of entryChunks) {
    try {
      await io.commitChunks([{ reportId, entryOps: chunk }], false);
      chunk.forEach((op) => recordOpSaved(op));
    } catch (chunkErr) {
      if (chunk.length === 1) {
        await handleFailedSingleOp(chunk[0], chunkErr);
      } else {
        for (const op of chunk) {
          try {
            await io.commitChunks([{ reportId, entryOps: [op] }], false);
            recordOpSaved(op);
          } catch (singleErr) {
            await handleFailedSingleOp(op, singleErr);
          }
        }
      }
    }
  }

  if (Object.keys(newlySavedEntries).length > 0) {
    onPartialSaved?.(newlySavedEntries);
  }

  // Online Step C: If ANY item failed, do NOT mark report completed/opening_saved; return structured partial failure
  if (failedItems.length > 0) {
    const failedIdsSet = new Set(failedItems.map((f) => f.itemId));
    const remainingRows = activeRows.filter((r) => failedIdsSet.has(r.itemId));
    const firstFail = failedItems[0];
    const totalAttempted = savedItems.length + failedItems.length;

    const title =
      failedItems.length === 1
        ? savedItems.length > 0
          ? `Se guardaron ${savedItems.length} de ${totalAttempted} insumos (faltó "${firstFail.itemName}")`
          : `No se pudo guardar "${firstFail.itemName}"`
        : `Se guardaron ${savedItems.length} de ${totalAttempted} insumos (${failedItems.length} con error)`;

    const detailLines = [
      savedItems.length > 0
        ? `Se guardaron ${savedItems.length} insumos correctamente, pero ${failedItems.length} ${failedItems.length === 1 ? 'falló' : 'fallaron'}. El reporte no se cerró para que puedas reintentar los pendientes.`
        : `No se pudo guardar ${failedItems.length === 1 ? 'el insumo' : 'ninguno de los insumos'} y el reporte no se marcó como ${guard.effectiveStatus === 'completed' ? 'cerrado' : 'apertura guardada'}.`,
      ...failedItems.map((f) => `• ${f.itemName}: ${f.reason}`),
    ];

    const rawDetailLines = failedItems.map((f) => f.rawDetail || f.reason);

    throw new PartialBatchSaveError({
      title,
      detail: detailLines.join('\n'),
      failedDocumentPath: firstFail.failedDocumentPath,
      code: firstFail.code,
      rawDetail: rawDetailLines.join('\n---\n'),
      savedItems,
      failedItems,
      remainingRows,
      catalogUpdatedDuringSave,
    });
  }

  // Online Step D: Final separate report update batch ONLY after 100% of items succeeded
  onProgress?.({ savedCount, totalCount, phase: 'report' });
  const finalReportChunk: BatchChunkCommitInput = {
    reportId,
    reportWrite: {
      kind: 'update',
      payload: buildReportUpdatePayload(guard.effectiveStatus),
    },
    entryOps: [],
  };
  try {
    await io.commitChunks([finalReportChunk], false);
  } catch (finalizeErr) {
    await io.diagnoseChunkFailure({
      batchError: finalizeErr,
      workspace,
      user,
      canManage,
      date,
      station,
      reportId,
      reporterName,
      cleanNotes,
      authorizedEmails,
      serverExists: true,
      firstStepReportStatus: 'open',
      effectiveStatus: guard.effectiveStatus,
      entryOps: [],
    });
    throw finalizeErr;
  }

  return {
    queuedOffline: false,
    catalogUpdatedDuringSave,
    savedCount,
  };
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
