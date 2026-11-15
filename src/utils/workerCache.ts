import type { Timestamp } from 'firebase/firestore';
import type {
  DailyReport,
  DailyReportEntry,
  InventoryItem,
  StationLink,
  TeamStationId,
  WorkerNote,
  Workspace,
  Workstation,
} from '../types';

const LINK_PREVIEW_PREFIX = 'thefire_link_preview:v1:';
const WORKER_SNAPSHOT_PREFIX = 'thefire_worker_snapshot:v1:';
const LAST_WORKER_UID_KEY = 'thefire_last_worker_uid:v1';

const LINK_PREVIEW_TTL_MS = 15 * 60 * 1000;
const WORKER_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

interface SerializedTimestamp {
  __tfTsMs: number;
}

export interface CachedWorkerSnapshot {
  version: 1;
  uid: string;
  savedAt: number;
  workspace: Workspace;
  workspaceUpdatedAtMs: number | null;
  role: TeamStationId;
  isOwner: boolean;
  station: Workstation | null;
  stationUpdatedAtMs: number | null;
  items: InventoryItem[];
  dateStr: string;
  todayReport: DailyReport | null;
  todayReportUpdatedAtMs: number | null;
  todayEntries: Record<string, DailyReportEntry>;
  yesterdayDateStr?: string;
  yesterdayStatus?: 'found' | 'none';
  yesterdayEntries?: Record<string, DailyReportEntry>;
  workerNotes: WorkerNote[];
}

function getSafeStorage(kind: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getTimestampMs(ts: unknown): number | null {
  if (!ts) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'object') {
    const candidate = ts as {
      toMillis?: () => number;
      __tfTsMs?: unknown;
      seconds?: unknown;
      nanoseconds?: unknown;
    };
    if (typeof candidate.toMillis === 'function') {
      try {
        const ms = candidate.toMillis();
        return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (typeof candidate.__tfTsMs === 'number' && Number.isFinite(candidate.__tfTsMs)) {
      return candidate.__tfTsMs;
    }
    if (typeof candidate.seconds === 'number' && Number.isFinite(candidate.seconds)) {
      const ns = typeof candidate.nanoseconds === 'number' ? candidate.nanoseconds : 0;
      return Math.round(candidate.seconds * 1000 + ns / 1e6);
    }
  }
  return null;
}

export function makeSerializedTimestamp(ms: number): Timestamp {
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = Math.max(0, Math.round((ms - seconds * 1000) * 1e6));
  return {
    seconds,
    nanoseconds,
    toMillis: () => ms,
    toDate: () => new Date(ms),
    isEqual: (other: Timestamp) => getTimestampMs(other) === ms,
    toJSON: () => ({ seconds, nanoseconds }),
    valueOf: () => String(ms),
  } as unknown as Timestamp;
}

function serializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(serializeValue);

  const ms = getTimestampMs(val);
  if (ms !== null && ('toMillis' in val || 'seconds' in val || '__tfTsMs' in val)) {
    const marker: SerializedTimestamp = { __tfTsMs: ms };
    return marker;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (v !== undefined) {
      out[k] = serializeValue(v);
    }
  }
  return out;
}

function deserializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(deserializeValue);

  const obj = val as Record<string, unknown>;
  if (typeof obj.__tfTsMs === 'number' && Object.keys(obj).length === 1) {
    return makeSerializedTimestamp(obj.__tfTsMs);
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = deserializeValue(v);
  }
  return out;
}

export function readCachedStationLinkPreview(
  accessCode: string | null | undefined,
  nowMs: number = Date.now(),
): StationLink | null {
  if (!accessCode || accessCode.length < 6) return null;
  const key = `${LINK_PREVIEW_PREFIX}${accessCode}`;
  const storages = [getSafeStorage('session'), getSafeStorage('local')];

  for (const store of storages) {
    if (!store) continue;
    try {
      const raw = store.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { savedAt?: number; link?: unknown } | null;
      if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.link) continue;
      if (nowMs - parsed.savedAt > LINK_PREVIEW_TTL_MS) {
        store.removeItem(key);
        continue;
      }
      const link = deserializeValue(parsed.link) as StationLink;
      if (link && link.id === accessCode && link.active && link.workspaceId && link.stationId) {
        return link;
      }
    } catch {
      // Ignore corrupt storage entries
    }
  }
  return null;
}

export function writeCachedStationLinkPreview(
  link: StationLink,
  nowMs: number = Date.now(),
): void {
  if (!link.id || !link.active) return;
  const key = `${LINK_PREVIEW_PREFIX}${link.id}`;
  const payload = JSON.stringify({
    savedAt: nowMs,
    link: serializeValue(link),
  });
  for (const store of [getSafeStorage('session'), getSafeStorage('local')]) {
    try {
      store?.setItem(key, payload);
    } catch {
      // Ignore quota / privacy mode errors
    }
  }
}

export function readWorkerSnapshotCache(
  uid: string | null | undefined,
  nowMs: number = Date.now(),
): CachedWorkerSnapshot | null {
  if (!uid) return null;
  const store = getSafeStorage('local');
  if (!store) return null;

  try {
    const raw = store.getItem(`${WORKER_SNAPSHOT_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = deserializeValue(JSON.parse(raw)) as Partial<CachedWorkerSnapshot> | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      parsed.uid !== uid ||
      typeof parsed.savedAt !== 'number' ||
      !parsed.workspace?.id ||
      !parsed.role ||
      parsed.role === 'jefe' ||
      parsed.isOwner
    ) {
      return null;
    }
    if (nowMs - parsed.savedAt > WORKER_SNAPSHOT_TTL_MS) {
      store.removeItem(`${WORKER_SNAPSHOT_PREFIX}${uid}`);
      return null;
    }
    return {
      version: 1,
      uid: parsed.uid,
      savedAt: parsed.savedAt,
      workspace: parsed.workspace,
      workspaceUpdatedAtMs:
        typeof parsed.workspaceUpdatedAtMs === 'number' ? parsed.workspaceUpdatedAtMs : null,
      role: parsed.role,
      isOwner: false,
      station: parsed.station ?? null,
      stationUpdatedAtMs:
        typeof parsed.stationUpdatedAtMs === 'number' ? parsed.stationUpdatedAtMs : null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      dateStr: typeof parsed.dateStr === 'string' ? parsed.dateStr : '',
      todayReport: parsed.todayReport ?? null,
      todayReportUpdatedAtMs:
        typeof parsed.todayReportUpdatedAtMs === 'number' ? parsed.todayReportUpdatedAtMs : null,
      todayEntries:
        parsed.todayEntries && typeof parsed.todayEntries === 'object' ? parsed.todayEntries : {},
      yesterdayDateStr:
        typeof parsed.yesterdayDateStr === 'string' ? parsed.yesterdayDateStr : undefined,
      yesterdayStatus:
        parsed.yesterdayStatus === 'found' || parsed.yesterdayStatus === 'none'
          ? parsed.yesterdayStatus
          : undefined,
      yesterdayEntries:
        parsed.yesterdayEntries && typeof parsed.yesterdayEntries === 'object'
          ? parsed.yesterdayEntries
          : undefined,
      workerNotes: Array.isArray(parsed.workerNotes) ? parsed.workerNotes : [],
    };
  } catch {
    return null;
  }
}

export function writeWorkerSnapshotCache(
  uid: string,
  partial: Omit<Partial<CachedWorkerSnapshot>, 'version' | 'uid' | 'savedAt'> & {
    workspace: Workspace;
    role: TeamStationId;
  },
  nowMs: number = Date.now(),
): void {
  if (!uid || !partial.workspace?.id || !partial.role || partial.role === 'jefe') return;
  const store = getSafeStorage('local');
  if (!store) return;

  const existing = readWorkerSnapshotCache(uid, nowMs);
  const sameContext =
    existing &&
    existing.workspace.id === partial.workspace.id &&
    existing.role === partial.role;
  const sameDate = sameContext && existing.dateStr === (partial.dateStr ?? existing.dateStr);

  const next: CachedWorkerSnapshot = {
    version: 1,
    uid,
    savedAt: nowMs,
    workspace: partial.workspace,
    workspaceUpdatedAtMs:
      partial.workspaceUpdatedAtMs !== undefined
        ? partial.workspaceUpdatedAtMs
        : getTimestampMs(partial.workspace.updatedAt) ??
          (sameContext ? existing.workspaceUpdatedAtMs : null),
    role: partial.role,
    isOwner: false,
    station:
      partial.station !== undefined ? partial.station : sameContext ? existing.station : null,
    stationUpdatedAtMs:
      partial.stationUpdatedAtMs !== undefined
        ? partial.stationUpdatedAtMs
        : getTimestampMs(partial.station?.updatedAt) ??
          (sameContext ? existing.stationUpdatedAtMs : null),
    items: partial.items !== undefined ? partial.items : sameContext ? existing.items : [],
    dateStr: partial.dateStr ?? (sameContext ? existing.dateStr : ''),
    todayReport:
      partial.todayReport !== undefined
        ? partial.todayReport
        : sameDate
          ? existing.todayReport
          : null,
    todayReportUpdatedAtMs:
      partial.todayReportUpdatedAtMs !== undefined
        ? partial.todayReportUpdatedAtMs
        : sameDate
          ? existing.todayReportUpdatedAtMs
          : null,
    todayEntries:
      partial.todayEntries !== undefined
        ? partial.todayEntries
        : sameDate
          ? existing.todayEntries
          : {},
    yesterdayDateStr:
      partial.yesterdayDateStr !== undefined
        ? partial.yesterdayDateStr
        : sameContext
          ? existing.yesterdayDateStr
          : undefined,
    yesterdayStatus:
      partial.yesterdayStatus !== undefined
        ? partial.yesterdayStatus
        : sameContext
          ? existing.yesterdayStatus
          : undefined,
    yesterdayEntries:
      partial.yesterdayEntries !== undefined
        ? partial.yesterdayEntries
        : sameContext
          ? existing.yesterdayEntries
          : undefined,
    workerNotes:
      partial.workerNotes !== undefined
        ? partial.workerNotes
        : sameContext
          ? existing.workerNotes
          : [],
  };

  try {
    store.setItem(`${WORKER_SNAPSHOT_PREFIX}${uid}`, JSON.stringify(serializeValue(next)));
    store.setItem(LAST_WORKER_UID_KEY, uid);
  } catch {
    // Ignore storage quota errors
  }
}

export function clearWorkerSnapshotCache(uid?: string | null): void {
  const store = getSafeStorage('local');
  if (!store) return;
  try {
    const targetUid = uid ?? store.getItem(LAST_WORKER_UID_KEY);
    if (targetUid) {
      store.removeItem(`${WORKER_SNAPSHOT_PREFIX}${targetUid}`);
    }
    store.removeItem(LAST_WORKER_UID_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function hasCachedWorkerHint(nowMs: number = Date.now()): boolean {
  const store = getSafeStorage('local');
  if (!store) return false;
  try {
    const lastUid = store.getItem(LAST_WORKER_UID_KEY);
    if (!lastUid) return false;
    return readWorkerSnapshotCache(lastUid, nowMs) !== null;
  } catch {
    return false;
  }
}

export function isSnapshotCompatibleWithLink(
  snapshot: CachedWorkerSnapshot | null,
  linkParams: { stationId: string | null; accessCode: string | null },
  pendingLink: StationLink | null,
): snapshot is CachedWorkerSnapshot {
  if (!snapshot) return false;
  if (pendingLink) {
    return (
      snapshot.workspace.id === pendingLink.workspaceId &&
      snapshot.role === pendingLink.stationId
    );
  }
  if (linkParams.stationId && snapshot.role !== linkParams.stationId) {
    return false;
  }
  return true;
}
