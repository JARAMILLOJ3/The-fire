import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  Lock,
  Moon,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  StickyNote,
  Sun,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { MAX_NOTES_LENGTH } from '../constants';
import {
  ConcurrencyConflictError,
  DiagnosticSaveError,
  fetchStationEntriesWithStatusOnce,
  PartialBatchSaveError,
  saveStationReportBatch,
  type WorkerSaveProgress,
} from '../services/workerService';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  OpeningAuditStatus,
  WorkerNote,
  Workspace,
  Workstation,
} from '../types';
import {
  buildStationSaveErrorCopyText,
  computeOpeningStatusForValue,
  confirmAllPendingOpeningRows,
  confirmPreloadedOpeningRow,
  detectReportAnomalies,
  formatDateHuman,
  formatItemStockDisplay,
  formatStationSaveError,
  formatTimeShort,
  getItemInputType,
  getOpeningRowState,
  getPreviousDateStr,
  getStockLevel,
  getStockLevelMeta,
  sanitizeStockQuantity,
  summarizeStationCatalogDiff,
  type EntryAnomaly,
  type SavedItemOutcome,
  type StationSaveErrorInfo,
} from '../utils/inventory';
import { formatTime12h, type WorkerScheduleStatus } from '../utils/schedule';
import {
  formatWorkerNoteContextLabel,
  sortWorkerNotesNewestFirst,
} from '../utils/workerNotes';
import { perfMetrics } from '../utils/perfMetrics';
import { readWorkerSnapshotCache, writeWorkerSnapshotCache } from '../utils/workerCache';
import { ShiftDesktopItemRow } from './shift/ShiftDesktopItemRow';
import { ShiftMobileItemCard } from './shift/ShiftMobileItemCard';
import { ShiftOutsideHoursView } from './shift/ShiftOutsideHoursView';
import { copyErrorTextToClipboard, ShiftSaveErrorModal } from './shift/ShiftSaveErrorModal';
import { ShiftSubmitConfirmModal } from './shift/ShiftSubmitConfirmModal';
import { WorkerNotesModal } from './shift/WorkerNotesModal';

interface StationShiftViewProps {
  workspace: Workspace;
  user: User;
  canManage: boolean;
  isPreviewMode?: boolean;
  scheduleStatus: WorkerScheduleStatus;
  station: Workstation;
  selectedDate: string;
  items: InventoryItem[];
  report: DailyReport | undefined;
  entriesByItemId: Record<string, DailyReportEntry>;
  workerNotes?: WorkerNote[];
  isOnline?: boolean;
  hasPendingWrites?: boolean;
  reportsLoaded?: boolean;
  isCacheHydrated?: boolean;
  onSaved?: () => void;
  onCatalogSynced?: (freshItems: InventoryItem[]) => void;
  onBackToDashboard?: () => void;
}

type ItemFilter = 'todos' | 'pendientes' | 'bajos';
type YesterdayLoadStatus = 'idle' | 'loading' | 'found' | 'none';

interface TouchedFlags {
  opening?: boolean;
  added?: boolean;
  closing?: boolean;
  notApplicable?: boolean;
}

interface StoredRowDraft {
  opening: number;
  added: number;
  closing: number;
  hasOpening: boolean;
  hasClosing: boolean;
  notApplicable: boolean;
  previousClosing?: number;
  openingStatus?: OpeningAuditStatus;
}

interface StoredDraftPayload {
  rows: Record<string, StoredRowDraft>;
  touched: Record<string, TouchedFlags>;
  notes: string;
  notesTouched: boolean;
  baselineUpdatedAtMs?: number | null;
  savedAt: number;
}

function getDraftStorageKey(
  workspaceId: string,
  stationId: string,
  dateStr: string,
  mode: 'opening' | 'closing',
): string {
  return `thefire_draft:${workspaceId}:${stationId}:${dateStr}:${mode}`;
}

function readStoredDraft(key: string): StoredDraftPayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraftPayload> | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.rows || typeof parsed.rows !== 'object') {
      return null;
    }
    return {
      rows: parsed.rows,
      touched: parsed.touched && typeof parsed.touched === 'object' ? parsed.touched : {},
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      notesTouched: Boolean(parsed.notesTouched),
      baselineUpdatedAtMs:
        parsed.baselineUpdatedAtMs === null || typeof parsed.baselineUpdatedAtMs === 'number'
          ? parsed.baselineUpdatedAtMs
          : undefined,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeStoredDraft(key: string, payload: StoredDraftPayload): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage quota / private browsing errors
  }
}

function clearStoredDraft(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

function buildRowFromSources(
  item: InventoryItem,
  existing: DailyReportEntry | undefined,
  storedRow: StoredRowDraft | undefined,
  storedTouched: TouchedFlags | undefined,
): DraftEntryRow {
  const notApplicable = storedTouched?.notApplicable
    ? Boolean(storedRow?.notApplicable)
    : Boolean(existing?.notApplicable);

  const previousClosing =
    typeof storedRow?.previousClosing === 'number'
      ? storedRow.previousClosing
      : typeof existing?.previousClosing === 'number'
        ? existing.previousClosing
        : undefined;

  const opening = storedTouched?.opening
    ? storedRow?.opening ?? 0
    : existing
      ? existing.opening
      : typeof previousClosing === 'number'
        ? previousClosing
        : 0;
  const hasOpening = notApplicable
    ? false
    : storedTouched?.opening
      ? Boolean(storedRow?.hasOpening)
      : Boolean(existing?.hasOpening);
  const openingStatus = storedTouched?.opening
    ? storedRow?.openingStatus
    : existing?.openingStatus;

  const added = storedTouched?.added
    ? storedRow?.added ?? 0
    : existing
      ? existing.added
      : 0;

  const closing = storedTouched?.closing
    ? storedRow?.closing ?? 0
    : existing
      ? existing.closing
      : 0;
  const hasClosing = notApplicable
    ? false
    : storedTouched?.closing
      ? Boolean(storedRow?.hasClosing)
      : Boolean(existing?.hasClosing);

  return {
    itemId: item.id,
    itemName: item.name,
    unit: item.unit,
    minStock: item.minStock,
    targetStock: item.targetStock,
    opening,
    added,
    closing,
    hasOpening,
    hasClosing,
    notApplicable,
    previousClosing,
    openingStatus,
  };
}

function hasAnyTouchedFlags(
  touched: Record<string, TouchedFlags>,
  notesTouched: boolean,
): boolean {
  return (
    notesTouched ||
    Object.values(touched).some(
      (t) => t.opening || t.added || t.closing || t.notApplicable,
    )
  );
}

export function StationShiftView({
  workspace,
  user,
  canManage,
  isPreviewMode = false,
  scheduleStatus,
  station,
  selectedDate,
  items,
  report,
  entriesByItemId,
  workerNotes = [],
  isOnline = true,
  hasPendingWrites = false,
  reportsLoaded = true,
  isCacheHydrated = false,
  onSaved,
  onCatalogSynced,
  onBackToDashboard,
}: StationShiftViewProps) {
  const stationItems = useMemo(
    () => items.filter((it) => it.active && it.station === station.id),
    [items, station.id],
  );

  const stationItemsById = useMemo(() => {
    const map: Record<string, InventoryItem> = {};
    stationItems.forEach((it) => {
      map[it.id] = it;
    });
    return map;
  }, [stationItems]);

  const isCompleted = report?.status === 'completed';
  const isLocked = isCompleted && !canManage;
  const isWorkerOpeningPhase = !canManage && scheduleStatus.phase === 'opening';
  const isWorkerClosingPhase = !canManage && scheduleStatus.phase === 'closing';
  const isWorkerOutsideHours = !canManage && scheduleStatus.phase === 'outside';
  const draftMode: 'opening' | 'closing' = isWorkerOpeningPhase ? 'opening' : 'closing';
  const storageKey = getDraftStorageKey(workspace.id, station.id, selectedDate, draftMode);

  const [isBossEditing, setIsBossEditing] = useState(false);
  const isBossReadOnly = canManage && !isBossEditing;
  const [drafts, setDrafts] = useState<Record<string, DraftEntryRow>>({});
  const [notes, setNotes] = useState('');
  const [savingMode, setSavingMode] = useState<'opening' | 'closing' | null>(null);
  const [savingStatusText, setSavingStatusText] = useState<string | null>(null);
  const [savingProgress, setSavingProgress] = useState<WorkerSaveProgress | null>(null);
  const [partiallySavedEntries, setPartiallySavedEntries] = useState<Record<string, DailyReportEntry>>({});
  const [failedRetryContext, setFailedRetryContext] = useState<{
    mode: 'opening' | 'closing';
    pendingItemIds: string[];
    previousSavedItems: SavedItemOutcome[];
  } | null>(null);
  const [yesterdayStatus, setYesterdayStatus] = useState<YesterdayLoadStatus>('idle');
  const [yesterdayDateStr, setYesterdayDateStr] = useState<string>(() =>
    getPreviousDateStr(selectedDate),
  );
  const [restoredFromLocal, setRestoredFromLocal] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [submittedThankYouMode, setSubmittedThankYouMode] = useState<'opening' | 'closing' | null>(null);
  const [submittedOfflineQueued, setSubmittedOfflineQueued] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [itemFilter, setItemFilter] = useState<ItemFilter>('todos');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saveError, setSaveError] = useState<StationSaveErrorInfo | null>(null);
  const [saveErrorModalOpen, setSaveErrorModalOpen] = useState(false);
  const [copiedInlineError, setCopiedInlineError] = useState(false);
  const [catalogUpdateNotice, setCatalogUpdateNotice] = useState<string | null>(null);
  const [remoteChangedBy, setRemoteChangedBy] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{
    mode: 'opening' | 'closing';
    message: string;
  } | null>(null);
  const [confirmModalState, setConfirmModalState] = useState<{
    mode: 'opening' | 'closing';
    anomalies: EntryAnomaly[];
  } | null>(null);
  const [isTextInputFocused, setIsTextInputFocused] = useState(false);
  const [notesModalOpen, setNotesModalOpen] = useState(false);
  const [bossConfirmDeleteNoteId, setBossConfirmDeleteNoteId] = useState<string | null>(null);
  const [bossDeletingNoteId, setBossDeletingNoteId] = useState<string | null>(null);

  const sortedStationWorkerNotes = useMemo(
    () => sortWorkerNotesNewestFirst(workerNotes),
    [workerNotes],
  );

  const handleBossDeleteNote = useCallback(async (noteId: string) => {
    setBossDeletingNoteId(noteId);
    try {
      const { deleteWorkerNoteByBoss } = await import('../services/bossService');
      await deleteWorkerNoteByBoss(noteId);
      setBossConfirmDeleteNoteId(null);
    } catch (err) {
      console.error('Error al borrar nota del puesto:', err);
    } finally {
      setBossDeletingNoteId(null);
    }
  }, []);

  const touchedRef = useRef<Record<string, TouchedFlags>>({});
  const notesTouchedRef = useRef(false);
  const baselineUpdatedAtRef = useRef<number | null>(
    report?.updatedAt && typeof report.updatedAt.toMillis === 'function'
      ? report.updatedAt.toMillis()
      : null,
  );
  const latestEntriesRef = useRef(entriesByItemId);
  const latestItemsRef = useRef(stationItems);
  const latestNotesRef = useRef(notes);
  const latestReportNotesRef = useRef(report?.notes ?? '');
  const latestReportUpdatedAtMsRef = useRef<number | null>(null);
  const yesterdayPreloadKeyRef = useRef<string>('');
  const prevCatalogItemsRef = useRef<{ scopeKey: string; items: InventoryItem[] } | null>(null);
  const listSectionRef = useRef<HTMLDivElement | null>(null);
  const viewContainerRef = useRef<HTMLDivElement | null>(null);
  const blurCheckTimerRef = useRef<number | null>(null);

  latestEntriesRef.current = entriesByItemId;
  latestItemsRef.current = stationItems;
  latestNotesRef.current = notes;
  latestReportNotesRef.current = report?.notes ?? '';
  latestReportUpdatedAtMsRef.current =
    report?.updatedAt && typeof report.updatedAt.toMillis === 'function'
      ? report.updatedAt.toMillis()
      : null;

  useEffect(() => {
    if (!canManage) {
      perfMetrics.mark('firstSheetPaint', {
        paintSource: isCacheHydrated ? 'cache' : 'network',
      });
      if (isCacheHydrated) {
        perfMetrics.logSummary('worker-cache-paint');
      }
    }
  }, [canManage, isCacheHydrated]);

  useEffect(() => {
    return () => {
      if (blurCheckTimerRef.current !== null) {
        window.clearTimeout(blurCheckTimerRef.current);
      }
    };
  }, []);

  const isVirtualKeyboardTarget = (el: EventTarget | null): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const inputType = (el as HTMLInputElement).type;
      return inputType !== 'range' && inputType !== 'checkbox' && inputType !== 'radio';
    }
    return false;
  };

  const handleContainerFocusCapture = (e: React.FocusEvent<HTMLDivElement>) => {
    if (blurCheckTimerRef.current !== null) {
      window.clearTimeout(blurCheckTimerRef.current);
      blurCheckTimerRef.current = null;
    }
    if (isVirtualKeyboardTarget(e.target)) {
      setIsTextInputFocused(true);
    }
  };

  const handleContainerBlurCapture = () => {
    if (blurCheckTimerRef.current !== null) {
      window.clearTimeout(blurCheckTimerRef.current);
    }
    blurCheckTimerRef.current = window.setTimeout(() => {
      blurCheckTimerRef.current = null;
      const activeEl = document.activeElement;
      const stillFocusedInside =
        Boolean(activeEl) &&
        Boolean(viewContainerRef.current?.contains(activeEl)) &&
        isVirtualKeyboardTarget(activeEl);
      setIsTextInputFocused(stillFocusedInside);
    }, 90);
  };

  const persistLocalDraft = useCallback(
    (nextDrafts: Record<string, DraftEntryRow>, nextNotes: string) => {
      if (!hasAnyTouchedFlags(touchedRef.current, notesTouchedRef.current)) {
        clearStoredDraft(storageKey);
        return;
      }

      const rowsPayload: Record<string, StoredRowDraft> = {};
      Object.entries(nextDrafts).forEach(([id, row]) => {
        const t = touchedRef.current[id];
        if (t && (t.opening || t.added || t.closing || t.notApplicable)) {
          rowsPayload[id] = {
            opening: row.opening,
            added: row.added,
            closing: row.closing,
            hasOpening: row.hasOpening,
            hasClosing: row.hasClosing,
            notApplicable: Boolean(row.notApplicable),
            previousClosing: row.previousClosing,
            openingStatus: row.openingStatus,
          };
        }
      });

      writeStoredDraft(storageKey, {
        rows: rowsPayload,
        touched: touchedRef.current,
        notes: nextNotes,
        notesTouched: notesTouchedRef.current,
        baselineUpdatedAtMs: baselineUpdatedAtRef.current,
        savedAt: Date.now(),
      });
    },
    [storageKey],
  );

  // 1. Initialize / Reset ONLY when station, date, report identity, or mode changes
  useEffect(() => {
    const stored = readStoredDraft(storageKey);
    const nextTouched: Record<string, TouchedFlags> = stored?.touched ? { ...stored.touched } : {};
    touchedRef.current = nextTouched;
    notesTouchedRef.current = Boolean(stored?.notesTouched);

    const entries = latestEntriesRef.current;
    const currentItems = latestItemsRef.current;
    const nextDrafts: Record<string, DraftEntryRow> = {};

    currentItems.forEach((item) => {
      nextDrafts[item.id] = buildRowFromSources(
        item,
        entries[item.id],
        stored?.rows?.[item.id],
        nextTouched[item.id],
      );
    });

    const hasRestoredEdits = hasAnyTouchedFlags(nextTouched, Boolean(stored?.notesTouched));
    baselineUpdatedAtRef.current =
      hasRestoredEdits && stored?.baselineUpdatedAtMs !== undefined
        ? stored.baselineUpdatedAtMs
        : latestReportUpdatedAtMsRef.current;

    yesterdayPreloadKeyRef.current = '';
    setYesterdayStatus('idle');
    setYesterdayDateStr(getPreviousDateStr(selectedDate));
    setDrafts(nextDrafts);
    setNotes(stored?.notesTouched ? stored.notes : latestReportNotesRef.current);
    setRestoredFromLocal(hasRestoredEdits);
    setRemoteChangedBy(null);
    setPendingConflict(null);
    setConfirmModalState(null);
    setSubmittedThankYouMode(null);
    setSubmittedOfflineQueued(false);
    setFeedback(null);
    setSaveError(null);
    setSavingProgress(null);
    setPartiallySavedEntries({});
    setFailedRetryContext(null);
  }, [workspace.id, station.id, selectedDate, report?.id, draftMode, storageKey]);

  useEffect(() => {
    setIsBossEditing(false);
  }, [workspace.id, station.id, selectedDate]);

  // Notify worker immediately when boss updates any item in this open station
  useEffect(() => {
    const scopeKey = `${workspace.id}:${station.id}`;
    const prev = prevCatalogItemsRef.current;

    if (!prev || prev.scopeKey !== scopeKey) {
      if (stationItems.length > 0) {
        prevCatalogItemsRef.current = { scopeKey, items: stationItems };
      } else {
        prevCatalogItemsRef.current = null;
      }
      setCatalogUpdateNotice(null);
      return;
    }

    const diff = summarizeStationCatalogDiff(prev.items, stationItems);
    prevCatalogItemsRef.current = { scopeKey, items: stationItems };

    if (diff.changed && !canManage && !submittedThankYouMode && !isLocked) {
      const label =
        diff.changedCount === 1
          ? `Se actualizó un insumo (${diff.changedNames[0]}). Ya ves los datos más recientes.`
          : `Se actualizó un insumo (${diff.changedCount} cambios del jefe). Ya ves los datos más recientes.`;
      setCatalogUpdateNotice(label);
    }
  }, [workspace.id, station.id, stationItems, canManage, submittedThankYouMode, isLocked]);

  // 2. Merge remote snapshot updates WITHOUT overwriting touched local fields or preloaded previousClosing
  useEffect(() => {
    const stored = readStoredDraft(storageKey);
    const currentRemoteUpdatedAtMs =
      report?.updatedAt && typeof report.updatedAt.toMillis === 'function'
        ? report.updatedAt.toMillis()
        : null;
    const hasTouchedEdits = hasAnyTouchedFlags(touchedRef.current, notesTouchedRef.current);

    if (!hasTouchedEdits) {
      baselineUpdatedAtRef.current = currentRemoteUpdatedAtMs;
      setRemoteChangedBy(null);
    } else if (currentRemoteUpdatedAtMs !== baselineUpdatedAtRef.current) {
      setRemoteChangedBy(report?.reportedByName || 'Otro dispositivo');
    }

    setDrafts((prev) => {
      let changed = false;
      const next: Record<string, DraftEntryRow> = { ...prev };
      const activeIds = new Set(stationItems.map((i) => i.id));

      Object.keys(next).forEach((id) => {
        if (!activeIds.has(id)) {
          delete next[id];
          changed = true;
        }
      });

      stationItems.forEach((item) => {
        const existing = entriesByItemId[item.id];
        const cur = next[item.id];
        const touched = touchedRef.current[item.id];

        if (!cur) {
          next[item.id] = buildRowFromSources(
            item,
            existing,
            stored?.rows?.[item.id],
            touched ?? stored?.touched?.[item.id],
          );
          changed = true;
          return;
        }

        let updatedRow = cur;
        if (
          cur.itemName !== item.name ||
          cur.unit !== item.unit ||
          cur.minStock !== item.minStock ||
          cur.targetStock !== item.targetStock
        ) {
          updatedRow = {
            ...updatedRow,
            itemName: item.name,
            unit: item.unit,
            minStock: item.minStock,
            targetStock: item.targetStock,
          };
        }

        if (existing) {
          if (
            typeof existing.previousClosing === 'number' &&
            updatedRow.previousClosing !== existing.previousClosing
          ) {
            updatedRow = {
              ...updatedRow,
              previousClosing: existing.previousClosing,
            };
          }
          if (
            !touched?.notApplicable &&
            Boolean(existing.notApplicable) !== Boolean(updatedRow.notApplicable)
          ) {
            updatedRow = {
              ...updatedRow,
              notApplicable: Boolean(existing.notApplicable),
            };
          }
          if (
            !touched?.opening &&
            !touched?.notApplicable &&
            (updatedRow.opening !== existing.opening ||
              updatedRow.hasOpening !== existing.hasOpening ||
              updatedRow.openingStatus !== existing.openingStatus)
          ) {
            updatedRow = {
              ...updatedRow,
              opening: existing.opening,
              hasOpening: existing.hasOpening,
              openingStatus: existing.openingStatus,
            };
          }
          if (!touched?.added && updatedRow.added !== existing.added) {
            updatedRow = {
              ...updatedRow,
              added: existing.added,
            };
          }
          if (
            !touched?.closing &&
            !touched?.notApplicable &&
            (updatedRow.closing !== existing.closing || updatedRow.hasClosing !== existing.hasClosing)
          ) {
            updatedRow = {
              ...updatedRow,
              closing: existing.closing,
              hasClosing: existing.hasClosing,
            };
          }
        }

        if (updatedRow !== cur) {
          next[item.id] = updatedRow;
          changed = true;
        }
      });

      return changed ? next : prev;
    });

    if (!notesTouchedRef.current) {
      setNotes(report?.notes ?? '');
    }
  }, [stationItems, entriesByItemId, report?.notes, report?.updatedAt, report?.reportedByName, storageKey]);

  // 3. Auto-preload yesterday's closing as "Por confirmar" (skipping opening-saved / closing / read-only views)
  useEffect(() => {
    if (isWorkerOutsideHours || isWorkerClosingPhase || !reportsLoaded || stationItems.length === 0) return;
    const itemSignature = stationItems.map((i) => i.id).join(',');
    const key = `${workspace.id}_${selectedDate}_${station.id}_${itemSignature}`;
    if (yesterdayPreloadKeyRef.current === key) return;
    yesterdayPreloadKeyRef.current = key;

    const prevDate = getPreviousDateStr(selectedDate);
    setYesterdayDateStr(prevDate);

    const itemsMissingPrev = stationItems.filter((it) => {
      const entry = latestEntriesRef.current[it.id];
      return (
        !entry?.hasOpening &&
        !entry?.notApplicable &&
        typeof entry?.previousClosing !== 'number'
      );
    });

    if (itemsMissingPrev.length === 0) {
      const anyExistingPrevClosing = Object.values(latestEntriesRef.current).some(
        (e) => typeof e?.previousClosing === 'number',
      );
      setYesterdayStatus(anyExistingPrevClosing ? 'found' : 'none');
      return;
    }

    const applyPrevEntriesToDrafts = (prevEntries: Record<string, DailyReportEntry>) => {
      const validClosings = Object.values(prevEntries).filter(
        (e) => e && e.hasClosing && !e.notApplicable,
      );
      const anyExistingPrevClosing = Object.values(latestEntriesRef.current).some(
        (e) => typeof e?.previousClosing === 'number',
      );

      if (validClosings.length === 0 && !anyExistingPrevClosing) {
        setYesterdayStatus('none');
        return;
      }

      setYesterdayStatus('found');
      setDrafts((prev) => {
        let changed = false;
        const updated = { ...prev };

        Object.keys(updated).forEach((itemId) => {
          const cur = updated[itemId];
          const prevEntry = prevEntries[itemId];
          if (!prevEntry || !prevEntry.hasClosing || prevEntry.notApplicable) return;

          const touched = touchedRef.current[itemId];
          const remoteEntry = latestEntriesRef.current[itemId];
          const nextPrevClosing = prevEntry.closing;

          if (
            !cur.hasOpening &&
            !cur.notApplicable &&
            !touched?.opening &&
            !touched?.notApplicable &&
            !remoteEntry?.hasOpening
          ) {
            if (cur.opening !== nextPrevClosing || cur.previousClosing !== nextPrevClosing) {
              updated[itemId] = {
                ...cur,
                opening: nextPrevClosing,
                hasOpening: false,
                previousClosing: nextPrevClosing,
              };
              changed = true;
            }
          } else if (cur.previousClosing === undefined) {
            updated[itemId] = {
              ...cur,
              previousClosing: nextPrevClosing,
            };
            changed = true;
          }
        });

        return changed ? updated : prev;
      });
    };

    if (!canManage) {
      const cached = readWorkerSnapshotCache(user.uid);
      if (
        cached &&
        cached.workspace.id === workspace.id &&
        cached.role === station.id &&
        cached.yesterdayDateStr === prevDate &&
        cached.yesterdayStatus
      ) {
        if (cached.yesterdayStatus === 'none') {
          setYesterdayStatus('none');
          return;
        }
        if (cached.yesterdayEntries) {
          applyPrevEntriesToDrafts(cached.yesterdayEntries);
          return;
        }
      }
    }

    let cancelled = false;
    setYesterdayStatus('loading');

    fetchStationEntriesWithStatusOnce(
      workspace.id,
      prevDate,
      station.id,
      itemsMissingPrev.map((i) => i.id),
    )
      .then((result) => {
        if (cancelled) return;
        applyPrevEntriesToDrafts(result.entries);
        if (!canManage) {
          writeWorkerSnapshotCache(user.uid, {
            workspace,
            role: station.id,
            yesterdayDateStr: prevDate,
            yesterdayStatus: result.reportExists ? 'found' : 'none',
            yesterdayEntries: result.entries,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setYesterdayStatus('none');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    isWorkerOutsideHours,
    isWorkerClosingPhase,
    reportsLoaded,
    canManage,
    user.uid,
    workspace,
    selectedDate,
    station.id,
    stationItems,
  ]);

  const applyRowMutation = useCallback(
    (
      itemId: string,
      mutator: (current: DraftEntryRow) => DraftEntryRow,
      touchedUpdate: TouchedFlags,
    ) => {
      if (isLocked) return;
      touchedRef.current = {
        ...touchedRef.current,
        [itemId]: {
          ...(touchedRef.current[itemId] ?? {}),
          ...touchedUpdate,
        },
      };
      setDrafts((prev) => {
        const current = prev[itemId];
        if (!current) return prev;
        const next = {
          ...prev,
          [itemId]: mutator(current),
        };
        persistLocalDraft(next, latestNotesRef.current);
        return next;
      });
    },
    [isLocked, persistLocalDraft],
  );

  const commitFieldValue = useCallback(
    (
      itemId: string,
      field: 'opening' | 'added' | 'closing',
      nextRawValue: number,
    ) => {
      const nextVal = sanitizeStockQuantity(nextRawValue);
      applyRowMutation(
        itemId,
        (row) => ({
          ...row,
          [field]: nextVal,
          notApplicable: field === 'added' ? row.notApplicable : false,
          hasOpening: field === 'opening' ? true : row.hasOpening,
          hasClosing: field === 'closing' ? true : row.hasClosing,
          openingStatus:
            field === 'opening'
              ? computeOpeningStatusForValue(nextVal, row.previousClosing)
              : row.openingStatus,
        }),
        {
          [field]: true,
          ...(field !== 'added' ? { notApplicable: true } : {}),
        },
      );
    },
    [applyRowMutation],
  );

  const clearFieldValue = useCallback(
    (itemId: string, field: 'opening' | 'added' | 'closing') => {
      applyRowMutation(
        itemId,
        (current) => ({
          ...current,
          [field]: 0,
          hasOpening: field === 'opening' ? false : current.hasOpening,
          hasClosing: field === 'closing' ? false : current.hasClosing,
          openingStatus: field === 'opening' ? undefined : current.openingStatus,
        }),
        { [field]: true },
      );
    },
    [applyRowMutation],
  );

  const confirmSingleOpening = useCallback(
    (itemId: string) => {
      applyRowMutation(
        itemId,
        (row) => confirmPreloadedOpeningRow(row),
        { opening: true, notApplicable: true },
      );
    },
    [applyRowMutation],
  );

  const handleConfirmAllUntouched = () => {
    if (isLocked) return;
    const { nextRows, confirmedIds } = confirmAllPendingOpeningRows(drafts, touchedRef.current);
    if (confirmedIds.length === 0) return;

    const nextTouched = { ...touchedRef.current };
    confirmedIds.forEach((id) => {
      nextTouched[id] = { ...(nextTouched[id] ?? {}), opening: true };
    });
    touchedRef.current = nextTouched;
    setDrafts(nextRows);
    persistLocalDraft(nextRows, notes);
    setFeedback({
      type: 'success',
      text: `Confirmaste ${confirmedIds.length} ${confirmedIds.length === 1 ? 'insumo' : 'insumos'} sin cambios respecto al cierre de ayer.`,
    });
  };

  const markZeroExplicit = useCallback(
    (itemId: string, field: 'opening' | 'closing') => {
      applyRowMutation(
        itemId,
        (row) => ({
          ...row,
          [field]: 0,
          notApplicable: false,
          hasOpening: field === 'opening' ? true : row.hasOpening,
          hasClosing: field === 'closing' ? true : row.hasClosing,
          openingStatus:
            field === 'opening'
              ? computeOpeningStatusForValue(0, row.previousClosing)
              : row.openingStatus,
        }),
        { [field]: true, notApplicable: true },
      );
    },
    [applyRowMutation],
  );

  const toggleNotApplicable = useCallback(
    (itemId: string) => {
      applyRowMutation(
        itemId,
        (row) => {
          const nextNA = !row.notApplicable;
          return {
            ...row,
            notApplicable: nextNA,
            opening: nextNA ? 0 : typeof row.previousClosing === 'number' ? row.previousClosing : row.opening,
            added: nextNA ? 0 : row.added,
            closing: nextNA ? 0 : row.closing,
            hasOpening: false,
            hasClosing: false,
            openingStatus: undefined,
          };
        },
        { notApplicable: true, opening: true, closing: true },
      );
    },
    [applyRowMutation],
  );

  const handleNotesChange = (nextNotes: string) => {
    notesTouchedRef.current = true;
    setNotes(nextNotes);
    persistLocalDraft(drafts, nextNotes);
  };

  // Counters & blocking evaluation
  const counts = useMemo(() => {
    let pendingConfirm = 0;
    let missingOpening = 0;
    let missingClosing = 0;
    let confirmedMatch = 0;
    let adjusted = 0;
    let manualOpening = 0;
    let naCount = 0;
    let zeroClosing = 0;
    let zeroOpening = 0;
    let accounted = 0;
    let lowCount = 0;

    stationItems.forEach((item) => {
      const row = drafts[item.id];
      const openingState = getOpeningRowState(row);
      const isNA = Boolean(row?.notApplicable);

      if (isNA) {
        naCount += 1;
        accounted += 1;
        return;
      }

      if (!isWorkerClosingPhase && openingState === 'pending_confirm') pendingConfirm += 1;
      if (openingState === 'uncounted') missingOpening += 1;
      if (openingState === 'confirmed') confirmedMatch += 1;
      if (openingState === 'adjusted') adjusted += 1;
      if (openingState === 'manual') manualOpening += 1;
      if (row?.hasOpening && row.opening === 0) zeroOpening += 1;

      if (!row?.hasClosing) missingClosing += 1;
      if (row?.hasClosing && row.closing === 0) zeroClosing += 1;

      if (isWorkerOpeningPhase) {
        if (row?.hasOpening) {
          accounted += 1;
          const lvl = getStockLevel(row.opening + row.added, item.minStock);
          if (lvl === 'agotado' || lvl === 'comprar' || lvl === 'medio') lowCount += 1;
        }
      } else if (isWorkerClosingPhase) {
        if (row?.hasClosing) {
          accounted += 1;
          const lvl = getStockLevel(row.closing, item.minStock);
          if (lvl === 'agotado' || lvl === 'comprar' || lvl === 'medio') lowCount += 1;
        }
      } else {
        // Boss / unrestricted edit requires closing value AND no unconfirmed yesterday preload
        if (row?.hasClosing && openingState !== 'pending_confirm') {
          accounted += 1;
          const lvl = getStockLevel(row.closing, item.minStock);
          if (lvl === 'agotado' || lvl === 'comprar' || lvl === 'medio') lowCount += 1;
        }
      }
    });

    const missingCount = Math.max(0, stationItems.length - accounted);
    return {
      total: stationItems.length,
      pendingConfirm,
      missingOpening,
      missingClosing,
      confirmedMatch,
      adjusted,
      manualOpening,
      naCount,
      zeroClosing,
      zeroOpening,
      accounted,
      missingCount,
      lowCount,
    };
  }, [stationItems, drafts, isWorkerOpeningPhase, isWorkerClosingPhase]);

  const canSubmitMode = useCallback(
    (mode: 'opening' | 'closing'): { ok: boolean; reasonText?: string } => {
      if (counts.total === 0) return { ok: false, reasonText: 'No hay insumos activos.' };
      if (!isWorkerClosingPhase && counts.pendingConfirm > 0) {
        return {
          ok: false,
          reasonText: `Tienes ${counts.pendingConfirm} ${
            counts.pendingConfirm === 1 ? 'insumo por confirmar' : 'insumos por confirmar'
          } respecto al cierre de ayer. Toca "✓ Está bien", corrige el valor o pulsa "Todo coincide".`,
        };
      }
      if (mode === 'opening' && counts.missingOpening > 0) {
        return {
          ok: false,
          reasonText: `Faltan ${counts.missingOpening} ${
            counts.missingOpening === 1 ? 'insumo' : 'insumos'
          } por contar en el inicio del día.`,
        };
      }
      if (mode === 'closing' && counts.missingClosing > 0) {
        return {
          ok: false,
          reasonText: `Faltan ${counts.missingClosing} ${
            counts.missingClosing === 1 ? 'insumo' : 'insumos'
          } por contar en el cierre.`,
        };
      }
      return { ok: true };
    },
    [counts, isWorkerClosingPhase],
  );

  const primaryBlockStatus = useMemo(
    () => canSubmitMode(draftMode),
    [canSubmitMode, draftMode],
  );

  const progressPct =
    counts.total > 0 ? Math.round((counts.accounted / counts.total) * 100) : 0;

  const syncDraftsWithServer = () => {
    clearStoredDraft(storageKey);
    touchedRef.current = {};
    notesTouchedRef.current = false;
    baselineUpdatedAtRef.current = latestReportUpdatedAtMsRef.current;

    const syncedDrafts: Record<string, DraftEntryRow> = {};
    stationItems.forEach((item) => {
      syncedDrafts[item.id] = buildRowFromSources(
        item,
        entriesByItemId[item.id],
        undefined,
        undefined,
      );
    });
    yesterdayPreloadKeyRef.current = '';
    setDrafts(syncedDrafts);
    setNotes(report?.notes ?? '');
    setRestoredFromLocal(false);
    setRemoteChangedBy(null);
    setPendingConflict(null);
    setSaveError(null);
    setFeedback({
      type: 'success',
      text: 'Planilla sincronizada con los últimos datos guardados en el servidor.',
    });
  };

  const buildRowsForSubmit = () =>
    stationItems
      .map((it) => {
        const d = drafts[it.id];
        if (!d) return null;
        return {
          ...d,
          itemName: it.name,
          unit: it.unit,
          minStock: it.minStock,
          targetStock: it.targetStock,
        };
      })
      .filter((r): r is DraftEntryRow => r !== null);

  const requestSaveWithConfirmation = (mode: 'opening' | 'closing') => {
    setSaveError(null);
    if (mode === 'opening') {
      const openingSavedCount = stationItems.reduce((acc, it) => {
        const r = drafts[it.id];
        return r && (r.notApplicable || r.hasOpening) ? acc + 1 : acc;
      }, 0);
      if (openingSavedCount === 0) {
        setItemFilter('pendientes');
        setSaveError({
          title: 'Faltan insumos por contar',
          detail: 'Cuenta al menos un insumo (o márcalo como "0" o "No aplica") antes de guardar la apertura.',
        });
        listSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }

    const check = canSubmitMode(mode);
    if (!check.ok && (mode === 'closing' || isWorkerOpeningPhase)) {
      setItemFilter('pendientes');
      const reasonMsg =
        check.reasonText ?? 'Completa los conteos faltantes antes de enviar.';
      setSaveError({
        title: 'Faltan insumos por revisar o contar',
        detail: reasonMsg,
      });
      listSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const rows = buildRowsForSubmit();
    const anomalies = detectReportAnomalies(rows, mode, stationItemsById);
    setConfirmModalState({ mode, anomalies });
  };

  const handleCopyInlineSaveError = async () => {
    if (!saveError) return;
    const ok = await copyErrorTextToClipboard(buildStationSaveErrorCopyText(saveError));
    if (ok) {
      setCopiedInlineError(true);
      window.setTimeout(() => setCopiedInlineError(false), 2500);
    }
  };

  const executeSave = async (
    mode: 'opening' | 'closing',
    options?: { forceOverwrite?: boolean; pendingOnly?: boolean },
  ) => {
    if (stationItems.length === 0) return;

    const allRows = buildRowsForSubmit();
    const isPendingRetry =
      Boolean(options?.pendingOnly) &&
      Boolean(failedRetryContext) &&
      failedRetryContext?.mode === mode;
    const pendingIdSet = isPendingRetry ? new Set(failedRetryContext!.pendingItemIds) : null;
    const rows = pendingIdSet
      ? allRows.filter((r) => pendingIdSet.has(r.itemId))
      : allRows;
    const previousSavedItems = isPendingRetry ? failedRetryContext!.previousSavedItems : [];
    const mergedExistingEntries = {
      ...entriesByItemId,
      ...partiallySavedEntries,
    };

    setConfirmModalState(null);
    setPendingConflict(null);
    setSavingMode(mode);
    setSavingStatusText(null);
    setSavingProgress({
      savedCount: previousSavedItems.length,
      totalCount: previousSavedItems.length + rows.length,
      phase: 'preparing',
    });
    setFeedback(null);
    setSaveError(null);
    setSaveErrorModalOpen(false);
    setCopiedInlineError(false);

    try {
      const saveResult = await saveStationReportBatch({
        workspace,
        user,
        canManage,
        date: selectedDate,
        station: station.id,
        mode,
        notes,
        rows,
        existingReport: report,
        existingEntries: mergedExistingEntries,
        expectedUpdatedAtMs: baselineUpdatedAtRef.current,
        forceOverwrite: options?.forceOverwrite || isPendingRetry,
        previousSavedItems,
        skipEmptyOpeningGuard: isPendingRetry && previousSavedItems.length > 0,
        onStatusMessage: (msg) => setSavingStatusText(msg),
        onProgress: (progress) => setSavingProgress(progress),
        onPartialSaved: (newlySaved) => {
          setPartiallySavedEntries((prev) => ({ ...prev, ...newlySaved }));
        },
        onCatalogSynced: (freshItems) => {
          onCatalogSynced?.(freshItems);
        },
      });

      clearStoredDraft(storageKey);
      touchedRef.current = {};
      notesTouchedRef.current = false;
      setRestoredFromLocal(false);
      setRemoteChangedBy(null);
      setSaveError(null);
      setSaveErrorModalOpen(false);
      setFailedRetryContext(null);
      setPartiallySavedEntries({});

      if (!canManage) {
        setSubmittedOfflineQueued(saveResult.queuedOffline);
        setSubmittedThankYouMode(mode);
      } else {
        setFeedback({
          type: 'success',
          text: saveResult.queuedOffline
            ? mode === 'opening'
              ? 'Sin conexión — apertura guardada localmente. Se subirá al volver internet.'
              : 'Sin conexión — cierre guardado localmente. Se subirá al volver internet.'
            : mode === 'opening'
              ? '¡Apertura guardada correctamente!'
              : '¡Cierre guardado correctamente!',
        });
      }
      onSaved?.();
    } catch (err) {
      if (err instanceof PartialBatchSaveError) {
        setFailedRetryContext({
          mode,
          pendingItemIds: err.failedItems.map((f) => f.itemId),
          previousSavedItems: err.savedItems,
        });
        setSaveError({
          title: err.title,
          detail: err.detail,
          code: err.code,
          rawDetail: err.rawDetail,
          failedDocumentPath: err.failedDocumentPath,
          savedItems: err.savedItems,
          failedItems: err.failedItems,
        });
        setSaveErrorModalOpen(true);
        return;
      }

      if (err instanceof DiagnosticSaveError) {
        setSaveError({
          title: err.title,
          detail: err.detail,
          code: err.code,
          rawDetail: err.rawDetail,
          failedDocumentPath: err.failedDocumentPath,
        });
        setSaveErrorModalOpen(true);
        return;
      }

      if (err instanceof ConcurrencyConflictError) {
        if (err.reason === 'completed_locked') {
          setSaveError({
            title: 'Planilla ya enviada y bloqueada',
            detail: err.message,
            code: 'completed_locked',
          });
          setSaveErrorModalOpen(true);
        } else {
          setPendingConflict({ mode, message: err.message });
          setSaveError({
            title: 'Otro dispositivo actualizó esta planilla',
            detail: err.message,
            code: err.reason,
          });
        }
        return;
      }

      const formatted = formatStationSaveError(err, {
        schedulePhase: scheduleStatus.phase,
        inGracePeriod: scheduleStatus.inGracePeriod,
        isOnline,
      });
      setSaveError(formatted);
      setSaveErrorModalOpen(true);
    } finally {
      setSavingMode(null);
      setSavingStatusText(null);
      setSavingProgress(null);
    }
  };

  const handleReopen = async () => {
    if (!report) return;
    setReopening(true);
    setFeedback(null);
    try {
      const { reopenStationReport } = await import('../services/bossService');
      await reopenStationReport(report.id, user);
      setFeedback({
        type: 'success',
        text: 'Planilla reabierta para ajustes.',
      });
      onSaved?.();
    } catch {
      setFeedback({
        type: 'error',
        text: 'No se pudo reabrir la planilla.',
      });
    } finally {
      setReopening(false);
    }
  };

  const filteredItems = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return stationItems.filter((item) => {
      if (q && !item.name.toLowerCase().includes(q)) return false;
      const row = drafts[item.id];
      const openingState = getOpeningRowState(row);
      const isNA = Boolean(row?.notApplicable);

      if (itemFilter === 'pendientes') {
        if (isNA) return false;
        if (!isWorkerClosingPhase && openingState === 'pending_confirm') return true;
        return isWorkerOpeningPhase ? !row?.hasOpening : !row?.hasClosing;
      }
      if (itemFilter === 'bajos') {
        if (!row || isNA) return false;
        const isCounted = isWorkerOpeningPhase ? row.hasOpening : row.hasClosing;
        if (!isCounted) return false;
        const val = isWorkerOpeningPhase ? row.opening + row.added : row.closing;
        const lvl = getStockLevel(val, item.minStock);
        return lvl === 'agotado' || lvl === 'comprar' || lvl === 'medio';
      }
      return true;
    });
  }, [stationItems, searchTerm, itemFilter, drafts, isWorkerOpeningPhase, isWorkerClosingPhase]);

  const closingTime = report?.status === 'completed' ? formatTimeShort(report?.updatedAt) : null;
  const draftTime = report?.status === 'opening_saved' ? formatTimeShort(report?.updatedAt) : null;

  const headerStatusSummary = useMemo(() => {
    const savedEntries = Object.values(entriesByItemId);
    const openingEntries = savedEntries.filter((e) => e.hasOpening || (report?.status === 'opening_saved' && e.notApplicable));
    const hasSavedOpening =
      report?.status === 'opening_saved' ||
      report?.status === 'completed' ||
      openingEntries.some((e) => e.hasOpening);
    const hasSavedClosing =
      report?.status === 'completed' ||
      savedEntries.some((e) => e.hasClosing);

    const openingSourceEntry = openingEntries.find((e) => e.hasOpening) ?? openingEntries[0];
    const openingTimeLabel = hasSavedOpening
      ? report?.status === 'opening_saved'
        ? formatTimeShort(report.updatedAt) ?? formatTimeShort(openingSourceEntry?.updatedAt)
        : formatTimeShort(report?.createdAt) ?? formatTimeShort(openingSourceEntry?.updatedAt)
      : null;
    const openingAuthor =
      (report?.status === 'opening_saved' ? report.reportedByName : openingSourceEntry?.updatedByName) ||
      report?.reportedByName ||
      station.workerName;

    const closingSourceEntry = savedEntries.find((e) => e.hasClosing);
    const closingTimeLabel = hasSavedClosing
      ? formatTimeShort(report?.updatedAt) ?? formatTimeShort(closingSourceEntry?.updatedAt)
      : null;
    const closingAuthor =
      report?.reportedByName || closingSourceEntry?.updatedByName || station.workerName;

    return {
      hasSavedOpening,
      openingTimeLabel,
      openingAuthor,
      hasSavedClosing,
      closingTimeLabel,
      closingAuthor,
    };
  }, [entriesByItemId, report, station.workerName]);

  const showClosingThankYou =
    !canManage && (submittedThankYouMode === 'closing' || isLocked);
  const showOpeningThankYou =
    !canManage &&
    !showClosingThankYou &&
    (submittedThankYouMode === 'opening' ||
      (isWorkerOpeningPhase && report?.status === 'opening_saved' && !isCompleted));

  const hasMobileBottomCtaBar =
    !canManage &&
    !isWorkerOutsideHours &&
    !showClosingThankYou &&
    !showOpeningThankYou &&
    stationItems.length > 0 &&
    !isLocked &&
    !isTextInputFocused;

  const workerNotesFloatingUi = !canManage ? (
    <>
      <button
        type="button"
        onClick={() => setNotesModalOpen(true)}
        className={`fixed right-4 z-40 min-h-[46px] inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-stone-950 border border-stone-800 rounded-2xl shadow-lg hover:bg-stone-900 active:scale-[0.98] transition-all no-print cursor-pointer ${
          hasMobileBottomCtaBar
            ? 'bottom-[calc(5rem+env(safe-area-inset-bottom))] lg:bottom-6'
            : 'bottom-[calc(1rem+env(safe-area-inset-bottom))] lg:bottom-6'
        }`}
      >
        <StickyNote className="w-4 h-4 text-orange-400 shrink-0" />
        <span>
          Mis notas
          {sortedStationWorkerNotes.length > 0 ? ` (${sortedStationWorkerNotes.length})` : ''}
        </span>
      </button>

      <WorkerNotesModal
        open={notesModalOpen}
        onClose={() => setNotesModalOpen(false)}
        workspace={workspace}
        user={user}
        station={station}
        operationalDate={selectedDate}
        stationItems={stationItems}
        notes={sortedStationWorkerNotes}
      />
    </>
  ) : null;

  // Outside Allowed Shift Schedule (Workers only)
  if (isWorkerOutsideHours) {
    return (
      <>
        <div className="pb-20 lg:pb-8">
          <ShiftOutsideHoursView
            station={station}
            selectedDate={selectedDate}
            scheduleStatus={scheduleStatus}
          />
        </div>
        {workerNotesFloatingUi}
      </>
    );
  }

  // Full-screen non-editable thank-you view after successful save (apertura or cierre)
  if (showClosingThankYou || showOpeningThankYou) {
    const closingStart12h = formatTime12h(scheduleStatus.schedule.closingStart);
    const openingStart12h = formatTime12h(scheduleStatus.schedule.openingStart);

    return (
      <>
        <div className="min-h-[65dvh] pt-6 pb-24 sm:py-12 flex items-center justify-center">
        <div className="w-full max-w-lg bg-white border border-emerald-200 rounded-2xl p-5 sm:p-8 text-center space-y-5 shadow-xs animate-tf-fade-up">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-9 h-9" />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-emerald-700">
              {station.name} · {formatDateHuman(selectedDate)}
            </p>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-stone-900 [text-wrap:balance]">
              {showClosingThankYou
                ? '¡Gracias por hacer el inventario de cierre!'
                : '¡Gracias por hacer el inventario de apertura!'}
            </h1>
            <p className="text-base font-medium text-stone-700 leading-relaxed">
              {showClosingThankYou
                ? `La próxima apertura es a las ${openingStart12h}.`
                : `Podrás hacer el cierre a las ${closingStart12h}.`}
            </p>
            {submittedOfflineQueued && (
              <p className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                Sin conexión — tu inventario quedó guardado en este celular y se sincronizará al volver internet.
              </p>
            )}
          </div>

          {showClosingThankYou ? (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 sm:p-3 rounded-xl bg-stone-50 border border-stone-200">
                <p className="text-[11px] font-medium text-stone-500">Insumos</p>
                <p className="font-mono tabular-nums text-lg font-bold text-stone-900 mt-0.5">
                  {counts.total - counts.naCount}
                </p>
              </div>
              <div className="p-2.5 sm:p-3 rounded-xl bg-red-50/70 border border-red-200">
                <p className="text-[11px] font-medium text-red-700">En cero</p>
                <p className="font-mono tabular-nums text-lg font-bold text-red-700 mt-0.5">
                  {counts.zeroClosing}
                </p>
              </div>
              <div className="p-2.5 sm:p-3 rounded-xl bg-emerald-50/70 border border-emerald-200">
                <p className="text-[11px] font-medium text-emerald-700">Coincidieron</p>
                <p className="font-mono tabular-nums text-lg font-bold text-emerald-700 mt-0.5">
                  {counts.confirmedMatch}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 sm:p-3 rounded-xl bg-stone-50 border border-stone-200">
                <p className="text-[11px] font-medium text-stone-500">Insumos</p>
                <p className="font-mono tabular-nums text-lg font-bold text-stone-900 mt-0.5">
                  {counts.total - counts.naCount}
                </p>
              </div>
              <div className="p-2.5 sm:p-3 rounded-xl bg-emerald-50/70 border border-emerald-200">
                <p className="text-[11px] font-medium text-emerald-700">Confirmados</p>
                <p className="font-mono tabular-nums text-lg font-bold text-emerald-700 mt-0.5">
                  {counts.confirmedMatch + counts.manualOpening}
                </p>
              </div>
              <div className="p-2.5 sm:p-3 rounded-xl bg-amber-50/70 border border-amber-200">
                <p className="text-[11px] font-medium text-amber-800">Corregidos</p>
                <p className="font-mono tabular-nums text-lg font-bold text-amber-800 mt-0.5">
                  {counts.adjusted}
                </p>
              </div>
            </div>
          )}

          <div className="p-3.5 rounded-xl bg-stone-50 border border-stone-200 text-xs text-stone-600 flex items-center justify-center gap-2">
            <Lock className="w-4 h-4 text-stone-500 shrink-0" />
            <span>
              {showClosingThankYou
                ? `Registro cerrado${closingTime ? ` (${closingTime})` : ''}. Si necesitas corregir algo, pídele al jefe que lo reabra.`
                : `Apertura registrada${draftTime ? ` (${draftTime})` : ''}. Ya puedes cerrar esta ventana hasta la hora del cierre.`}
            </span>
          </div>
        </div>
        </div>
        {workerNotesFloatingUi}
      </>
    );
  }

  return (
    <>
      <div
        ref={viewContainerRef}
      onFocusCapture={handleContainerFocusCapture}
      onBlurCapture={handleContainerBlurCapture}
      className="space-y-4 sm:space-y-5 pb-32 lg:pb-8 min-w-0"
    >
      {/* Boss Read-Only / Edit Banner */}
      {canManage && (
        <div
          className={`rounded-2xl border px-4 py-3 flex flex-wrap items-center justify-between gap-2.5 ${
            isBossReadOnly
              ? 'bg-stone-100/90 border-stone-300 text-stone-900'
              : 'bg-orange-50/80 border-orange-200 text-orange-950'
          }`}
        >
          <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold min-w-0">
            {isBossReadOnly ? (
              <Eye className="w-4 h-4 text-stone-700 shrink-0" />
            ) : (
              <Pencil className="w-4 h-4 text-orange-700 shrink-0" />
            )}
            <span className="truncate">
              {isBossReadOnly
                ? isPreviewMode
                  ? 'Vista del jefe (solo lectura) · Estás en modo vista previa'
                  : 'Vista del jefe (solo lectura)'
                : isPreviewMode
                  ? 'Modo edición del jefe · Vista previa del enlace'
                  : 'Modo edición del jefe'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {onBackToDashboard && (
              <button
                type="button"
                onClick={onBackToDashboard}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-stone-700 bg-white border border-stone-300 rounded-xl hover:bg-stone-50 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Volver al panel
              </button>
            )}
            {isBossReadOnly ? (
              <button
                type="button"
                onClick={() => setIsBossEditing(true)}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-stone-950 rounded-xl hover:bg-stone-800 cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5" />
                Editar
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsBossEditing(false)}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-stone-800 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 cursor-pointer"
              >
                <Eye className="w-3.5 h-3.5" />
                Volver a solo lectura
              </button>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3.5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-orange-600">
            {canManage
              ? `Encargada: ${station.workerName} · ${station.area || 'Puesto'} · ${formatDateHuman(selectedDate)}`
              : `¡Hola, ${station.workerName}! · ${station.area || 'Tu puesto'} · ${formatDateHuman(selectedDate)}`}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-0.5 [text-wrap:balance]">
            {station.name}
          </h1>
          <p className="text-sm text-stone-600 mt-1">
            {isWorkerOpeningPhase
              ? `Apertura (${scheduleStatus.openingRangeLabel}): confirma el inicio respecto a ayer y anota si llegó mercancía.`
              : isWorkerClosingPhase
                ? `Cierre (${scheduleStatus.closingRangeLabel}): registra únicamente cuánto quedó hoy al terminar el turno.`
                : isBossReadOnly
                  ? 'Planilla guardada del puesto en modo solo lectura.'
                  : 'Inicio, surtido y cierre del día.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isCompleted && canManage && (
            <button
              type="button"
              onClick={handleReopen}
              disabled={reopening}
              className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-xl hover:bg-amber-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              {reopening ? 'Reabriendo...' : 'Reabrir cierre'}
            </button>
          )}
        </div>
      </div>

      {/* Boss Opening/Closing Save Status Header Cards */}
      {canManage && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <div
            className={`rounded-xl border px-3.5 py-2.5 text-xs flex items-center gap-2 ${
              headerStatusSummary.hasSavedOpening
                ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                : 'bg-white border-stone-200 text-stone-600'
            }`}
          >
            <Sun
              className={`w-4 h-4 shrink-0 ${
                headerStatusSummary.hasSavedOpening ? 'text-emerald-600' : 'text-stone-400'
              }`}
            />
            <span>
              {headerStatusSummary.hasSavedOpening
                ? headerStatusSummary.openingTimeLabel
                  ? `Apertura guardada a las ${headerStatusSummary.openingTimeLabel} por ${headerStatusSummary.openingAuthor}`
                  : `Apertura guardada por ${headerStatusSummary.openingAuthor}`
                : 'Apertura pendiente'}
            </span>
          </div>
          <div
            className={`rounded-xl border px-3.5 py-2.5 text-xs flex items-center gap-2 ${
              headerStatusSummary.hasSavedClosing
                ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                : 'bg-white border-stone-200 text-stone-600'
            }`}
          >
            <Moon
              className={`w-4 h-4 shrink-0 ${
                headerStatusSummary.hasSavedClosing ? 'text-emerald-600' : 'text-stone-400'
              }`}
            />
            <span>
              {headerStatusSummary.hasSavedClosing
                ? headerStatusSummary.closingTimeLabel
                  ? `Cierre guardado a las ${headerStatusSummary.closingTimeLabel} por ${headerStatusSummary.closingAuthor}`
                  : `Cierre guardado por ${headerStatusSummary.closingAuthor}`
                : 'Cierre pendiente'}
            </span>
          </div>
        </div>
      )}

      {/* Offline / Pending sync banner */}
      {(!isOnline || hasPendingWrites) && (
        <div
          role="status"
          className="px-4 py-3 rounded-2xl bg-stone-900 text-stone-100 text-xs sm:text-sm flex items-center gap-2.5"
        >
          <WifiOff className="w-4 h-4 text-orange-400 shrink-0" />
          <span>
            {!isOnline
              ? 'Sin conexión — puedes seguir contando; al enviar se guardará aquí y se subirá solo cuando regrese internet.'
              : 'Sincronizando cambios guardados sin conexión con el servidor...'}
          </span>
        </div>
      )}

      {/* Live Catalog Update Notice (Worker screen auto-updated by boss) */}
      {catalogUpdateNotice && !isBossReadOnly && (
        <div
          role="status"
          className="px-4 py-3 rounded-2xl bg-sky-50 border border-sky-300 text-sky-950 text-xs sm:text-sm flex items-center justify-between gap-2.5 animate-tf-fade-in"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <RefreshCw className="w-4 h-4 text-sky-700 shrink-0" />
            <span className="font-semibold">{catalogUpdateNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setCatalogUpdateNotice(null)}
            aria-label="Cerrar aviso de actualización"
            className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-xl text-sky-800 hover:bg-sky-100 shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 10-minute grace period banner */}
      {!canManage && scheduleStatus.inGracePeriod && !isLocked && (
        <div className="px-4 py-3 rounded-2xl bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-900 flex items-center gap-2.5">
          <Clock className="w-4 h-4 text-amber-600 shrink-0" />
          <span>
            Estás en tiempo de tolerancia (
            <strong>
              {scheduleStatus.graceRemainingMinutes !== null
                ? `quedan ${scheduleStatus.graceRemainingMinutes} min`
                : 'últimos minutos'}
            </strong>
            ). Envía tu registro antes de que cierre la ventana.
          </span>
        </div>
      )}

      {/* No yesterday closing warning (only in opening / editable mode, never during closing or boss read-only) */}
      {!isBossReadOnly && !isWorkerClosingPhase && yesterdayStatus === 'none' && !isLocked && (
        <div
          role="alert"
          className="px-4 py-3.5 rounded-2xl bg-amber-50 border border-amber-300 text-xs sm:text-sm text-amber-950 flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <span>
            <strong>Ayer no se registró cierre, cuenta cada insumo</strong> ({formatDateHuman(yesterdayDateStr)} sin cierre guardado). Los campos están vacíos para que ingreses el conteo real.
          </span>
        </div>
      )}

      {/* Bulk confirmation bar for preloaded yesterday closings */}
      {!isBossReadOnly && !isWorkerClosingPhase && counts.pendingConfirm > 0 && !isLocked && (
        <div className="px-4 py-3.5 rounded-2xl bg-sky-50 border border-sky-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs sm:text-sm text-sky-950 min-w-0">
            <Clock className="w-4 h-4 text-sky-700 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">
                <span className="font-mono tabular-nums">{counts.pendingConfirm}</span> por confirmar respecto a ayer ({formatDateHuman(yesterdayDateStr)})
              </p>
              <p className="text-sky-800 text-xs mt-0.5">
                Los valores precargados están marcados en azul. Confirma cada uno con &ldquo;✓ Está bien&rdquo;, corrígelo o confirma los que no has tocado de una vez.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleConfirmAllUntouched}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-sky-700 rounded-xl hover:bg-sky-800 active:scale-[0.99] transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            <CheckCheck className="w-4 h-4 shrink-0" />
            Todo coincide ({counts.pendingConfirm})
          </button>
        </div>
      )}

      {/* Remote concurrent edit notice */}
      {!isBossReadOnly && remoteChangedBy && !isLocked && (
        <div className="px-4 py-3 rounded-2xl bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-900 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              <strong>{remoteChangedBy}</strong> actualizó esta planilla desde otro dispositivo. Tus cambios locales siguen protegidos.
            </span>
          </div>
          <button
            type="button"
            onClick={syncDraftsWithServer}
            className="text-xs font-bold text-orange-700 underline hover:text-orange-900 cursor-pointer"
          >
            Cargar datos del servidor
          </button>
        </div>
      )}

      {/* Progress & Status Card (shown in worker / boss edit views) */}
      {!isBossReadOnly && (
        <div
          className={`rounded-2xl border p-4 sm:p-5 space-y-3 transition-colors ${
            isCompleted
              ? 'bg-emerald-50/70 border-emerald-200'
              : counts.pendingConfirm > 0
                ? 'bg-sky-50/40 border-sky-200'
                : 'bg-white border-stone-200'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 text-sm min-w-0">
              {report?.status === 'completed' ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <span className="font-semibold text-emerald-900">
                    Cierre enviado{closingTime ? ` (${closingTime})` : ''}
                  </span>
                </>
              ) : isWorkerOpeningPhase ? (
                <>
                  <Sun className="w-5 h-5 text-orange-600 shrink-0" />
                  <span className="font-semibold text-stone-900">
                    {report?.status === 'opening_saved'
                      ? `Apertura guardada${draftTime ? ` (${draftTime})` : ''}`
                      : 'Apertura y llegada de productos'}
                  </span>
                </>
              ) : isWorkerClosingPhase ? (
                <>
                  <Moon className="w-5 h-5 text-orange-600 shrink-0" />
                  <span className="font-semibold text-stone-900">
                    Cierre del día
                    {report?.status === 'opening_saved' && draftTime
                      ? ` · Apertura guardada (${draftTime})`
                      : ''}
                  </span>
                </>
              ) : report?.status === 'opening_saved' ? (
                <>
                  <Save className="w-5 h-5 text-amber-600 shrink-0" />
                  <span className="font-semibold text-amber-900">
                    Apertura guardada{draftTime ? ` (${draftTime})` : ''} · Cierre del día
                  </span>
                </>
              ) : (
                <>
                  <Moon className="w-5 h-5 text-orange-600 shrink-0" />
                  <span className="font-semibold text-stone-900">
                    Inicio, surtido y cierre del día
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center gap-2.5 font-mono tabular-nums text-xs sm:text-sm font-bold shrink-0">
              {counts.pendingConfirm > 0 && (
                <span className="text-sky-700">{counts.pendingConfirm} por confirmar</span>
              )}
              <span className="text-stone-800">
                {counts.accounted} de {counts.total} listos
              </span>
            </div>
          </div>

          <div className="w-full h-2.5 bg-stone-200/80 rounded-full overflow-hidden">
            <div
              style={{ width: `${progressPct}%` }}
              className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                isCompleted
                  ? 'bg-emerald-600'
                  : counts.pendingConfirm > 0
                    ? 'bg-sky-600'
                    : 'bg-orange-600'
              }`}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-600">
            <span>
              {restoredFromLocal
                ? 'Borrador recuperado en este dispositivo.'
                : isWorkerClosingPhase
                  ? 'Cuenta cuánto quedó de cada insumo al cierre, toca "0 / No queda" o "No aplica hoy".'
                  : yesterdayStatus === 'loading'
                    ? 'Cargando cierre de ayer para comparar...'
                    : yesterdayStatus === 'found'
                      ? `Precargado con cierre de ${formatDateHuman(yesterdayDateStr)}. Revisa o confirma cada insumo.`
                      : 'Cuenta cada insumo, toca "0" si no hay o "No aplica hoy".'}
            </span>
            {!isWorkerClosingPhase && (counts.confirmedMatch > 0 || counts.adjusted > 0) && (
              <span className="font-mono tabular-nums text-stone-700">
                {counts.confirmedMatch} coinciden · {counts.adjusted} corregidos
              </span>
            )}
          </div>
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className={`px-4 py-3.5 text-sm font-medium rounded-2xl border animate-tf-fade-in ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Search & Filter Toolbar */}
      {!isBossReadOnly && stationItems.length > 0 && (
        <div
          ref={listSectionRef}
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-center gap-1 p-1 bg-stone-200/70 rounded-xl w-full sm:w-auto overflow-x-auto">
            <button
              type="button"
              onClick={() => setItemFilter('todos')}
              className={`min-h-[40px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                itemFilter === 'todos'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              Todos ({counts.total})
            </button>
            <button
              type="button"
              onClick={() => setItemFilter('pendientes')}
              className={`min-h-[40px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                itemFilter === 'pendientes'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              {counts.pendingConfirm > 0
                ? `Pendientes (${counts.missingCount})`
                : `Faltan (${counts.missingCount})`}
            </button>
            {!isWorkerClosingPhase && (
              <button
                type="button"
                onClick={() => setItemFilter('bajos')}
                className={`min-h-[40px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                  itemFilter === 'bajos'
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-700 hover:text-stone-900'
                }`}
              >
                Bajos ({counts.lowCount})
              </button>
            )}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar insumo..."
              aria-label="Buscar insumo"
              className="w-full min-h-[44px] pl-10 pr-3 py-2 text-base sm:text-sm bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>
      )}

      {/* Main Inventory List */}
      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
        {stationItems.length === 0 ? (
          <div className="p-10 text-center text-sm text-stone-600">
            No hay insumos activos en este puesto. El jefe puede agregarlos desde &ldquo;Insumos&rdquo;.
          </div>
        ) : isBossReadOnly ? (
          <>
            {/* Boss Read-Only Mobile Cards (< lg) */}
            <div className="lg:hidden divide-y divide-stone-200">
              {stationItems.map((item) => {
                const entry = entriesByItemId[item.id];
                const isNA = Boolean(entry?.notApplicable);
                const hasOpen = Boolean(entry?.hasOpening) && !isNA;
                const hasClose = Boolean(entry?.hasClosing) && !isNA;
                const isLevelRestock =
                  getItemInputType(item) === 'level' &&
                  hasOpen &&
                  hasClose &&
                  entry.closing > sanitizeStockQuantity(entry.opening + entry.added);
                const consumed =
                  hasOpen && hasClose
                    ? sanitizeStockQuantity(Math.max(0, entry.opening + entry.added - entry.closing))
                    : null;
                const meta = hasClose ? getStockLevelMeta(getStockLevel(entry.closing, item.minStock)) : null;

                return (
                  <div key={item.id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-base font-semibold text-stone-900">{item.name}</p>
                      <span
                        className={`text-xs font-semibold shrink-0 ${
                          isNA
                            ? 'text-stone-600'
                            : meta
                              ? meta.textClass
                              : 'text-stone-400'
                        }`}
                      >
                        {isNA ? 'No aplica' : meta ? meta.label : '—'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono tabular-nums text-stone-700">
                      <div>
                        <span className="text-stone-500 font-sans">Inicio:</span>{' '}
                        {isNA ? 'No aplica' : hasOpen ? formatItemStockDisplay(entry.opening, item) : '—'}
                      </div>
                      <div>
                        <span className="text-stone-500 font-sans">Surtido:</span>{' '}
                        {!isNA && entry && entry.added > 0
                          ? `+${formatItemStockDisplay(entry.added, item)}`
                          : '—'}
                      </div>
                      <div>
                        <span className="text-stone-500 font-sans">Cierre:</span>{' '}
                        {isNA ? 'No aplica' : hasClose ? formatItemStockDisplay(entry.closing, item) : '—'}
                      </div>
                      <div>
                        <span className="text-stone-500 font-sans">Consumo:</span>{' '}
                        {isNA
                          ? '—'
                          : isLevelRestock
                            ? 'Reposición'
                            : consumed !== null
                              ? formatItemStockDisplay(consumed, item)
                              : '—'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Boss Read-Only Desktop Table (>= lg) */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th className="py-3.5 px-5 min-w-[200px]">Insumo</th>
                    <th className="py-3.5 px-4 text-right whitespace-nowrap">Inicio</th>
                    <th className="py-3.5 px-4 text-right whitespace-nowrap">Surtido</th>
                    <th className="py-3.5 px-4 text-right whitespace-nowrap">Cierre</th>
                    <th className="py-3.5 px-4 text-right whitespace-nowrap">Consumo</th>
                    <th className="py-3.5 px-5 whitespace-nowrap">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-sm">
                  {stationItems.map((item) => {
                    const entry = entriesByItemId[item.id];
                    const isNA = Boolean(entry?.notApplicable);
                    const hasOpen = Boolean(entry?.hasOpening) && !isNA;
                    const hasClose = Boolean(entry?.hasClosing) && !isNA;
                    const isLevelRestock =
                      getItemInputType(item) === 'level' &&
                      hasOpen &&
                      hasClose &&
                      entry.closing > sanitizeStockQuantity(entry.opening + entry.added);
                    const consumed =
                      hasOpen && hasClose
                        ? sanitizeStockQuantity(Math.max(0, entry.opening + entry.added - entry.closing))
                        : null;
                    const meta = hasClose ? getStockLevelMeta(getStockLevel(entry.closing, item.minStock)) : null;

                    return (
                      <tr key={item.id} className="hover:bg-stone-50/70 transition-colors">
                        <td className="py-3.5 px-5">
                          <div className="font-semibold text-stone-900">{item.name}</div>
                          <div className="text-xs text-stone-500 font-mono tabular-nums">
                            Mín: {formatItemStockDisplay(item.minStock, item)}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-800 whitespace-nowrap">
                          {isNA
                            ? 'No aplica'
                            : hasOpen
                              ? formatItemStockDisplay(entry.opening, item)
                              : '—'}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-700 whitespace-nowrap">
                          {!isNA && entry && entry.added > 0
                            ? `+${formatItemStockDisplay(entry.added, item)}`
                            : '—'}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-stone-900 whitespace-nowrap">
                          {isNA
                            ? 'No aplica'
                            : hasClose
                              ? formatItemStockDisplay(entry.closing, item)
                              : '—'}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-700 whitespace-nowrap">
                          {isNA ? (
                            '—'
                          ) : isLevelRestock ? (
                            <span className="text-sky-700 font-semibold">Reposición</span>
                          ) : consumed !== null ? (
                            formatItemStockDisplay(consumed, item)
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-3.5 px-5 whitespace-nowrap">
                          <span
                            className={`text-xs font-semibold ${
                              isNA
                                ? 'text-stone-600'
                                : meta
                                  ? meta.textClass
                                  : 'text-stone-400 font-normal'
                            }`}
                          >
                            {isNA ? 'No aplica' : meta ? meta.label : '—'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : filteredItems.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm font-semibold text-stone-800">
              No hay insumos que coincidan con este filtro.
            </p>
            <button
              type="button"
              onClick={() => {
                setSearchTerm('');
                setItemFilter('todos');
              }}
              className="min-h-[44px] px-3 text-sm font-semibold text-orange-600 hover:text-orange-700 cursor-pointer"
            >
              Ver todos los insumos
            </button>
          </div>
        ) : (
          <>
            {/* Mobile / Tablet Touch-First Cards (< lg) */}
            <div className="lg:hidden divide-y divide-stone-200">
              {filteredItems.map((item) => {
                const row: DraftEntryRow = drafts[item.id] ?? {
                  itemId: item.id,
                  itemName: item.name,
                  unit: item.unit,
                  minStock: item.minStock,
                  targetStock: item.targetStock,
                  opening: 0,
                  added: 0,
                  closing: 0,
                  hasOpening: false,
                  hasClosing: false,
                  notApplicable: false,
                };
                return (
                  <ShiftMobileItemCard
                    key={item.id}
                    item={item}
                    row={row}
                    isLocked={isLocked}
                    isWorkerOpeningPhase={isWorkerOpeningPhase}
                    isWorkerClosingPhase={isWorkerClosingPhase}
                    draftMode={draftMode}
                    onCommitField={commitFieldValue}
                    onClearField={clearFieldValue}
                    onConfirmSingleOpening={confirmSingleOpening}
                    onMarkZeroExplicit={markZeroExplicit}
                    onToggleNotApplicable={toggleNotApplicable}
                  />
                );
              })}
            </div>

            {/* Desktop Table (>= lg) */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th className="py-3.5 px-5 min-w-[210px]">Insumo</th>
                    {isWorkerOpeningPhase ? (
                      <>
                        <th className="py-3.5 px-3 text-center">Inicio del día</th>
                        <th className="py-3.5 px-3 text-center">Surtido (+)</th>
                        <th className="py-3.5 px-4 text-center">Confirmación y opciones</th>
                        <th className="py-3.5 px-5 text-right">Total disponible</th>
                      </>
                    ) : isWorkerClosingPhase ? (
                      <>
                        <th className="py-3.5 px-4 text-center">¿Cuánto quedó hoy?</th>
                        <th className="py-3.5 px-4 text-center">Opciones</th>
                      </>
                    ) : (
                      <>
                        <th className="py-3.5 px-3 text-center">Inicio del día</th>
                        <th className="py-3.5 px-3 text-center">Surtido (+)</th>
                        <th className="py-3.5 px-4 text-center">¿Cuánto quedó hoy? (Cierre)</th>
                        <th className="py-3.5 px-3 text-center">Opciones</th>
                        <th className="py-3.5 px-4 text-right">Consumo</th>
                        <th className="py-3.5 px-5">Estado / Alerta</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-sm">
                  {filteredItems.map((item) => {
                    const row: DraftEntryRow = drafts[item.id] ?? {
                      itemId: item.id,
                      itemName: item.name,
                      unit: item.unit,
                      minStock: item.minStock,
                      targetStock: item.targetStock,
                      opening: 0,
                      added: 0,
                      closing: 0,
                      hasOpening: false,
                      hasClosing: false,
                      notApplicable: false,
                    };
                    return (
                      <ShiftDesktopItemRow
                        key={item.id}
                        item={item}
                        row={row}
                        isLocked={isLocked}
                        isWorkerOpeningPhase={isWorkerOpeningPhase}
                        isWorkerClosingPhase={isWorkerClosingPhase}
                        draftMode={draftMode}
                        onCommitField={commitFieldValue}
                        onClearField={clearFieldValue}
                        onConfirmSingleOpening={confirmSingleOpening}
                        onMarkZeroExplicit={markZeroExplicit}
                        onToggleNotApplicable={toggleNotApplicable}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Boss-Visible Station Worker Notes */}
      {canManage && sortedStationWorkerNotes.length > 0 && (
        <div className="bg-amber-50/70 border border-amber-200 rounded-2xl p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-amber-950">
              <StickyNote className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                Notas rápidas de la trabajadora ({sortedStationWorkerNotes.length})
              </span>
            </div>
            <span className="text-[11px] text-amber-800">No modifican el inventario</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {sortedStationWorkerNotes.map((note) => {
              const contextLabel = formatWorkerNoteContextLabel(note);
              const isConfirming = bossConfirmDeleteNoteId === note.id;
              return (
                <div
                  key={note.id}
                  className="bg-white/95 border border-amber-200/90 rounded-xl px-3.5 py-2.5 space-y-1.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-stone-900">
                        {note.authorName}{' '}
                        <span className="font-mono tabular-nums font-normal text-stone-500">
                          · {note.timeLabel}
                        </span>
                      </p>
                      {contextLabel && (
                        <p className="text-[11px] font-semibold text-orange-800 mt-0.5">
                          {contextLabel}
                        </p>
                      )}
                    </div>
                    {isConfirming ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={bossDeletingNoteId === note.id}
                          onClick={() => handleBossDeleteNote(note.id)}
                          className="min-h-[32px] px-2 py-1 text-[11px] font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                        >
                          {bossDeletingNoteId === note.id ? '...' : 'Eliminar'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setBossConfirmDeleteNoteId(null)}
                          className="min-h-[32px] px-2 py-1 text-[11px] font-semibold text-stone-700 bg-stone-100 rounded-lg hover:bg-stone-200 cursor-pointer"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setBossConfirmDeleteNoteId(note.id)}
                        aria-label={`Borrar nota de ${note.authorName}`}
                        className="min-w-[32px] min-h-[32px] flex items-center justify-center text-stone-400 hover:text-red-700 hover:bg-red-50 rounded-lg shrink-0 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-stone-800 leading-relaxed break-words">
                    {note.text}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Read-only shift note when saved */}
      {isBossReadOnly && Boolean(report?.notes?.trim()) && (
        <div className="bg-white border border-stone-200 rounded-2xl p-4 sm:p-5 space-y-1.5">
          <p className="text-xs font-semibold text-stone-600">Notas del turno</p>
          <p className="text-sm text-stone-800 whitespace-pre-wrap">{report?.notes}</p>
        </div>
      )}

      {/* Notes & Desktop Save Section (hidden in Boss read-only mode) */}
      {!isBossReadOnly && stationItems.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-2xl p-4 sm:p-5 space-y-4">
          <div>
            <label
              htmlFor={`notes-${station.id}`}
              className="block text-sm font-semibold text-stone-800 mb-1.5"
            >
              {isWorkerOpeningPhase
                ? 'Notas de apertura o llegada de mercancía (opcional)'
                : 'Notas del cierre para el jefe (opcional)'}
            </label>
            <textarea
              id={`notes-${station.id}`}
              rows={2}
              maxLength={MAX_NOTES_LENGTH}
              disabled={isLocked}
              value={notes}
              onChange={(e) => handleNotesChange(e.target.value)}
              placeholder={
                isWorkerOpeningPhase
                  ? 'Ej: Llegaron 2 cajas de gaseosa y 3 bolsas de papa...'
                  : 'Ej: Llegó pedido de gaseosas hoy, o falta comprar hielo urgente...'
              }
              className="w-full min-h-[44px] scroll-mb-36 px-3.5 py-2.5 text-base sm:text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white disabled:opacity-60"
            />
          </div>

          {pendingConflict && !isLocked && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-red-900">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Conflicto de edición concurrente</p>
                  <p className="text-xs text-red-800 mt-0.5">{pendingConflict.message}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={syncDraftsWithServer}
                  className="min-h-[44px] px-3.5 py-2 text-xs font-semibold text-stone-800 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  Aceptar versión del servidor
                </button>
                <button
                  type="button"
                  disabled={savingMode !== null}
                  onClick={() => executeSave(pendingConflict.mode, { forceOverwrite: true })}
                  className="min-h-[44px] px-3.5 py-2 text-xs font-semibold text-white bg-red-700 rounded-xl hover:bg-red-800 disabled:opacity-50 cursor-pointer"
                >
                  Sobrescribir con mis conteos
                </button>
              </div>
            </div>
          )}

          {!isLocked && !primaryBlockStatus.ok && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
              <span>
                {counts.pendingConfirm > 0 ? (
                  <>
                    <strong>{counts.pendingConfirm} por confirmar</strong> respecto a ayer. Confírmalos o corrígelos para habilitar el envío.
                  </>
                ) : (
                  <>
                    <strong>{counts.accounted} de {counts.total} listos.</strong> Faltan{' '}
                    {counts.missingCount} {counts.missingCount === 1 ? 'insumo' : 'insumos'} por contar.
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => {
                  setItemFilter('pendientes');
                  listSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className="min-h-[40px] px-2 font-bold text-orange-700 underline hover:text-orange-900 cursor-pointer"
              >
                Ver pendientes
              </button>
            </div>
          )}

          {/* Live batch save progress ("Guardando X de Y…") */}
          {savingMode !== null && savingProgress && (
            <div
              role="status"
              aria-live="polite"
              className="p-3.5 rounded-xl bg-orange-50/90 border border-orange-200 space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs sm:text-sm font-semibold text-orange-950">
                <span className="flex items-center gap-2 min-w-0">
                  <RefreshCw className="w-4 h-4 text-orange-600 animate-spin shrink-0" />
                  <span className="truncate">
                    {savingProgress.phase === 'report'
                      ? `Finalizando reporte (${savingProgress.savedCount} de ${savingProgress.totalCount})…`
                      : `Guardando ${savingProgress.savedCount} de ${savingProgress.totalCount}…`}
                  </span>
                </span>
                <span className="font-mono tabular-nums text-xs text-orange-800 shrink-0">
                  {savingProgress.totalCount > 0
                    ? Math.round((savingProgress.savedCount / savingProgress.totalCount) * 100)
                    : 0}
                  %
                </span>
              </div>
              <div className="w-full h-2 bg-orange-200/80 rounded-full overflow-hidden">
                <div
                  style={{
                    width: `${
                      savingProgress.totalCount > 0
                        ? Math.round((savingProgress.savedCount / savingProgress.totalCount) * 100)
                        : 0
                    }%`,
                  }}
                  className="h-full bg-orange-600 rounded-full transition-[width] duration-200 ease-out"
                />
              </div>
            </div>
          )}

          {/* Retry-once live catalog sync notice during save */}
          {savingMode !== null && savingStatusText && (
            <div
              role="status"
              className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-300 text-xs sm:text-sm font-semibold text-amber-950"
            >
              <RefreshCw className="w-4 h-4 text-amber-700 animate-spin shrink-0" />
              <span>{savingStatusText}</span>
            </div>
          )}

          {/* Save error inline right beside Action Row */}
          {saveError && !isLocked && (
            <div
              role="alert"
              className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 p-3.5 rounded-xl bg-red-50 border border-red-300 text-red-950"
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div className="text-xs space-y-1 min-w-0">
                  <p className="font-bold">
                    {saveError.title}
                    {saveError.code ? (
                      <span className="ml-2 font-mono font-semibold text-red-700">
                        ({saveError.code})
                      </span>
                    ) : null}
                  </p>
                  <p className="text-red-900 leading-relaxed whitespace-pre-wrap break-words">
                    {saveError.detail}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {saveError.failedItems && saveError.failedItems.length > 0 && failedRetryContext && (
                      <button
                        type="button"
                        disabled={savingMode !== null}
                        onClick={() =>
                          void executeSave(failedRetryContext.mode, {
                            pendingOnly: true,
                            forceOverwrite: true,
                          })
                        }
                        className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-white bg-orange-600 rounded-lg hover:bg-orange-700 disabled:opacity-50 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                        Reintentar los que faltan ({saveError.failedItems.length})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setSaveErrorModalOpen(true)}
                      className="min-h-[36px] inline-flex items-center px-2.5 py-1 text-xs font-semibold text-red-900 bg-white border border-red-200 rounded-lg hover:bg-red-100 cursor-pointer"
                    >
                      Ver motivo completo
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyInlineSaveError}
                      className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-stone-900 rounded-lg hover:bg-stone-800 cursor-pointer"
                    >
                      {copiedInlineError ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ¡Error copiado!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copiar error
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSaveError(null);
                  setSaveErrorModalOpen(false);
                }}
                aria-label="Cerrar error de guardado"
                className="self-end sm:self-start min-w-[44px] min-h-[44px] flex items-center justify-center text-red-700 hover:bg-red-100 rounded-xl shrink-0 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Mobile inline CTA backup (visible when keyboard hides fixed bottom bar) */}
          {!isLocked && (
            <div className="lg:hidden pt-1">
              <button
                type="button"
                disabled={savingMode !== null || !primaryBlockStatus.ok}
                onClick={() => requestSaveWithConfirmation(draftMode)}
                className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {isWorkerOpeningPhase ? <Save className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                {savingMode !== null
                  ? savingProgress
                    ? `Guardando ${savingProgress.savedCount} de ${savingProgress.totalCount}…`
                    : 'Guardando...'
                  : counts.pendingConfirm > 0
                    ? `${counts.pendingConfirm} por confirmar`
                    : counts.missingCount > 0
                      ? `Faltan ${counts.missingCount} por contar`
                      : isWorkerOpeningPhase
                        ? 'Guardar apertura y surtido'
                        : 'Enviar cierre del día'}
              </button>
            </div>
          )}

          {/* Desktop Action Row */}
          <div className="hidden lg:flex items-center justify-end gap-3">
            {isWorkerOpeningPhase ? (
              <button
                type="button"
                disabled={isLocked || savingMode !== null || !primaryBlockStatus.ok}
                onClick={() => requestSaveWithConfirmation('opening')}
                className="min-h-[48px] inline-flex items-center justify-center gap-2 px-6 py-3 text-base font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Save className="w-5 h-5" />
                {savingMode === 'opening'
                  ? savingProgress
                    ? `Guardando ${savingProgress.savedCount} de ${savingProgress.totalCount}…`
                    : 'Guardando apertura...'
                  : counts.pendingConfirm > 0
                    ? `${counts.pendingConfirm} por confirmar`
                    : counts.missingOpening > 0
                      ? `Faltan ${counts.missingOpening} por contar`
                      : 'Guardar apertura y surtido'}
              </button>
            ) : (
              <>
                {(canManage || scheduleStatus.phase === 'unrestricted') && (
                  <button
                    type="button"
                    disabled={isLocked || savingMode !== null}
                    onClick={() => requestSaveWithConfirmation('opening')}
                    className="min-h-[48px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Save className="w-4 h-4" />
                    {savingMode === 'opening' ? 'Guardando avance...' : 'Guardar avance'}
                  </button>
                )}

                <button
                  type="button"
                  disabled={isLocked || savingMode !== null || !primaryBlockStatus.ok}
                  onClick={() => requestSaveWithConfirmation('closing')}
                  className="min-h-[48px] inline-flex items-center justify-center gap-2 px-6 py-3 text-base font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <CheckCircle2 className="w-5 h-5" />
                  {savingMode === 'closing'
                    ? savingProgress
                      ? `Guardando ${savingProgress.savedCount} de ${savingProgress.totalCount}…`
                      : 'Enviando cierre...'
                    : counts.pendingConfirm > 0
                      ? `${counts.pendingConfirm} por confirmar`
                      : counts.missingClosing > 0
                        ? `Faltan ${counts.missingClosing} por contar`
                        : 'Enviar cierre del día al jefe'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Mobile Sticky Bottom CTA Bar (auto-hidden when virtual keyboard is open or boss read-only) */}
      {!isBossReadOnly && stationItems.length > 0 && !isLocked && !isTextInputFocused && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-stone-200 shadow-lg no-print pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {pendingConflict && (
            <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-amber-950">
              <div className="max-w-lg mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold">Otro dispositivo editó esta planilla.</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={syncDraftsWithServer}
                    className="min-h-[40px] px-2.5 py-1 font-semibold text-stone-800 bg-white border border-stone-300 rounded-lg cursor-pointer"
                  >
                    Cargar servidor
                  </button>
                  <button
                    type="button"
                    disabled={savingMode !== null}
                    onClick={() => executeSave(pendingConflict.mode, { forceOverwrite: true })}
                    className="min-h-[40px] px-2.5 py-1 font-semibold text-white bg-red-700 rounded-lg disabled:opacity-50 cursor-pointer"
                  >
                    Sobrescribir
                  </button>
                </div>
              </div>
            </div>
          )}

          {savingMode !== null && savingProgress && (
            <div
              role="status"
              aria-live="polite"
              className="px-4 py-2 bg-orange-50 border-b border-orange-200 text-orange-950"
            >
              <div className="max-w-lg mx-auto space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <RefreshCw className="w-3.5 h-3.5 text-orange-600 animate-spin shrink-0" />
                    <span className="truncate">
                      {savingProgress.phase === 'report'
                        ? `Finalizando reporte (${savingProgress.savedCount} de ${savingProgress.totalCount})…`
                        : `Guardando ${savingProgress.savedCount} de ${savingProgress.totalCount}…`}
                    </span>
                  </span>
                  <span className="font-mono tabular-nums text-[11px] text-orange-800 shrink-0">
                    {savingProgress.totalCount > 0
                      ? Math.round((savingProgress.savedCount / savingProgress.totalCount) * 100)
                      : 0}
                    %
                  </span>
                </div>
                <div className="w-full h-1.5 bg-orange-200 rounded-full overflow-hidden">
                  <div
                    style={{
                      width: `${
                        savingProgress.totalCount > 0
                          ? Math.round((savingProgress.savedCount / savingProgress.totalCount) * 100)
                          : 0
                      }%`,
                    }}
                    className="h-full bg-orange-600 rounded-full transition-[width] duration-200 ease-out"
                  />
                </div>
              </div>
            </div>
          )}

          {savingMode !== null && savingStatusText && (
            <div
              role="status"
              className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-950"
            >
              <div className="max-w-lg mx-auto flex items-center gap-2 text-xs font-semibold">
                <RefreshCw className="w-3.5 h-3.5 text-amber-700 animate-spin shrink-0" />
                <span>{savingStatusText}</span>
              </div>
            </div>
          )}

          {saveError && (
            <div
              role="alert"
              className="px-4 py-2.5 bg-red-50 border-b border-red-200 text-red-950"
            >
              <div className="max-w-lg mx-auto flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <div className="text-xs min-w-0 space-y-1">
                    <p className="font-bold leading-snug">
                      {saveError.title}
                      {saveError.code ? (
                        <span className="ml-1.5 font-mono text-red-700">({saveError.code})</span>
                      ) : null}
                    </p>
                    <p className="text-red-900 leading-snug break-words">{saveError.detail}</p>
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      {saveError.failedItems && saveError.failedItems.length > 0 && failedRetryContext && (
                        <button
                          type="button"
                          disabled={savingMode !== null}
                          onClick={() =>
                            void executeSave(failedRetryContext.mode, {
                              pendingOnly: true,
                              forceOverwrite: true,
                            })
                          }
                          className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-orange-600 rounded-lg cursor-pointer disabled:opacity-50"
                        >
                          Reintentar faltantes ({saveError.failedItems.length})
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setSaveErrorModalOpen(true)}
                        className="min-h-[34px] px-2.5 py-1 text-[11px] font-semibold text-red-900 bg-white border border-red-200 rounded-lg cursor-pointer"
                      >
                        Ver motivo completo
                      </button>
                      <button
                        type="button"
                        onClick={handleCopyInlineSaveError}
                        className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-stone-900 rounded-lg cursor-pointer"
                      >
                        {copiedInlineError ? '¡Copiado!' : 'Copiar error'}
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSaveError(null);
                    setSaveErrorModalOpen(false);
                  }}
                  aria-label="Cerrar error de guardado"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center text-red-700 hover:bg-red-100 rounded-xl shrink-0 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          <div className="px-4 py-2.5">
            <div className="max-w-lg mx-auto flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-mono tabular-nums font-bold text-stone-900 truncate">
                  {savingMode !== null && savingProgress
                    ? `Guardando ${savingProgress.savedCount} de ${savingProgress.totalCount}…`
                    : savingMode !== null && savingStatusText
                      ? savingStatusText
                      : counts.pendingConfirm > 0
                        ? `${counts.pendingConfirm} por confirmar`
                        : counts.missingCount > 0
                          ? `Faltan ${counts.missingCount} por contar`
                          : `${counts.total} de ${counts.total} listos`}
                </p>
                <p className="text-[11px] text-stone-500 truncate">
                  {isWorkerOpeningPhase ? 'Apertura del día' : 'Cierre del día'}
                </p>
              </div>

              <button
                type="button"
                disabled={savingMode !== null || !primaryBlockStatus.ok}
                onClick={() => requestSaveWithConfirmation(draftMode)}
                className="min-h-[46px] px-4 py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap shrink-0 cursor-pointer"
              >
                {savingMode !== null
                  ? savingProgress
                    ? `${savingProgress.savedCount}/${savingProgress.totalCount}…`
                    : 'Guardando...'
                  : counts.pendingConfirm > 0
                    ? `${counts.pendingConfirm} por confirmar`
                    : counts.missingCount > 0
                      ? `Faltan ${counts.missingCount}`
                      : isWorkerOpeningPhase
                        ? 'Guardar apertura'
                        : 'Enviar cierre'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-Submit Summary Confirmation Dialog */}
      <ShiftSubmitConfirmModal
        open={confirmModalState !== null}
        mode={confirmModalState?.mode ?? draftMode}
        stationName={station.name}
        totalItems={counts.total}
        confirmedMatchCount={counts.confirmedMatch}
        adjustedCount={counts.adjusted}
        zeroCount={
          confirmModalState?.mode === 'opening' ? counts.zeroOpening : counts.zeroClosing
        }
        naCount={counts.naCount}
        anomalies={confirmModalState?.anomalies ?? []}
        saving={savingMode !== null}
        onCancel={() => setConfirmModalState(null)}
        onConfirm={() =>
          confirmModalState && executeSave(confirmModalState.mode)
        }
      />

      {/* Full Uncut Save Error Modal with Copy & Retry Pending buttons */}
      <ShiftSaveErrorModal
        open={saveError !== null && saveErrorModalOpen}
        error={saveError}
        retrying={savingMode !== null}
        onRetryFailed={
          failedRetryContext
            ? () =>
                void executeSave(failedRetryContext.mode, {
                  pendingOnly: true,
                  forceOverwrite: true,
                })
            : undefined
        }
        onClose={() => setSaveErrorModalOpen(false)}
      />
      </div>
      {workerNotesFloatingUi}
    </>
  );
}
