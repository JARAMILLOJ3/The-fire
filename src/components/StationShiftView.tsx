import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Clock,
  Lock,
  Minus,
  Moon,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sun,
  WifiOff,
  X,
} from 'lucide-react';
import { MAX_NOTES_LENGTH } from '../constants';
import {
  ConcurrencyConflictError,
  DiagnosticSaveError,
  fetchStationEntriesOnce,
  reopenStationReport,
  saveStationReportBatch,
} from '../services/inventoryService';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  OpeningAuditStatus,
  Workspace,
  Workstation,
} from '../types';
import {
  computeOpeningStatusForValue,
  confirmAllPendingOpeningRows,
  confirmPreloadedOpeningRow,
  detectEntryAnomalies,
  detectReportAnomalies,
  formatDateHuman,
  formatStationSaveError,
  formatTimeShort,
  getOpeningRowState,
  getPreviousDateStr,
  getStockLevel,
  getStockLevelMeta,
  getSuggestedPurchase,
  parseQuantityInput,
  sanitizeStockQuantity,
  type EntryAnomaly,
  type StationSaveErrorInfo,
} from '../utils/inventory';
import { formatTime12h, type WorkerScheduleStatus } from '../utils/schedule';
import { ShiftOutsideHoursView } from './shift/ShiftOutsideHoursView';
import { ShiftSubmitConfirmModal } from './shift/ShiftSubmitConfirmModal';

interface StationShiftViewProps {
  workspace: Workspace;
  user: User;
  canManage: boolean;
  scheduleStatus: WorkerScheduleStatus;
  station: Workstation;
  selectedDate: string;
  items: InventoryItem[];
  report: DailyReport | undefined;
  entriesByItemId: Record<string, DailyReportEntry>;
  isOnline?: boolean;
  hasPendingWrites?: boolean;
  onSaved?: () => void;
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
  scheduleStatus,
  station,
  selectedDate,
  items,
  report,
  entriesByItemId,
  isOnline = true,
  hasPendingWrites = false,
  onSaved,
}: StationShiftViewProps) {
  const stationItems = useMemo(
    () => items.filter((it) => it.active && it.station === station.id),
    [items, station.id],
  );

  const isCompleted = report?.status === 'completed';
  const isLocked = isCompleted && !canManage;
  const isWorkerOpeningPhase = !canManage && scheduleStatus.phase === 'opening';
  const isWorkerOutsideHours = !canManage && scheduleStatus.phase === 'outside';
  const draftMode: 'opening' | 'closing' = isWorkerOpeningPhase ? 'opening' : 'closing';
  const storageKey = getDraftStorageKey(workspace.id, station.id, selectedDate, draftMode);

  const [drafts, setDrafts] = useState<Record<string, DraftEntryRow>>({});
  const [notes, setNotes] = useState('');
  const [savingMode, setSavingMode] = useState<'opening' | 'closing' | null>(null);
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
  const [remoteChangedBy, setRemoteChangedBy] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{
    mode: 'opening' | 'closing';
    message: string;
  } | null>(null);
  const [confirmModalState, setConfirmModalState] = useState<{
    mode: 'opening' | 'closing';
    anomalies: EntryAnomaly[];
  } | null>(null);

  const touchedRef = useRef<Record<string, TouchedFlags>>({});
  const notesTouchedRef = useRef(false);
  const baselineUpdatedAtRef = useRef<number | null>(
    report?.updatedAt && typeof report.updatedAt.toMillis === 'function'
      ? report.updatedAt.toMillis()
      : null,
  );
  const latestEntriesRef = useRef(entriesByItemId);
  const latestItemsRef = useRef(stationItems);
  const latestReportNotesRef = useRef(report?.notes ?? '');
  const latestReportUpdatedAtMsRef = useRef<number | null>(null);
  const yesterdayPreloadKeyRef = useRef<string>('');
  const listSectionRef = useRef<HTMLDivElement | null>(null);

  latestEntriesRef.current = entriesByItemId;
  latestItemsRef.current = stationItems;
  latestReportNotesRef.current = report?.notes ?? '';
  latestReportUpdatedAtMsRef.current =
    report?.updatedAt && typeof report.updatedAt.toMillis === 'function'
      ? report.updatedAt.toMillis()
      : null;

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
  }, [workspace.id, station.id, selectedDate, report?.id, draftMode, storageKey]);

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

  // 3. Auto-preload yesterday's closing as "Por confirmar" (hasOpening remains false until confirmed or edited)
  useEffect(() => {
    if (isWorkerOutsideHours || stationItems.length === 0) return;
    const itemSignature = stationItems.map((i) => i.id).join(',');
    const key = `${workspace.id}_${selectedDate}_${station.id}_${itemSignature}`;
    if (yesterdayPreloadKeyRef.current === key) return;
    yesterdayPreloadKeyRef.current = key;

    let cancelled = false;
    const prevDate = getPreviousDateStr(selectedDate);
    setYesterdayDateStr(prevDate);
    setYesterdayStatus('loading');

    fetchStationEntriesOnce(
      workspace.id,
      prevDate,
      station.id,
      stationItems.map((i) => i.id),
    )
      .then((prevEntries) => {
        if (cancelled) return;
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

            // Only attach previousClosing + prefill opening as "Por confirmar" when not yet saved/edited
            if (!cur.hasOpening && !cur.notApplicable && !touched?.opening && !touched?.notApplicable && !remoteEntry?.hasOpening) {
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
      })
      .catch(() => {
        if (!cancelled) {
          setYesterdayStatus('none');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isWorkerOutsideHours, workspace.id, selectedDate, station.id, stationItems]);

  const applyRowMutation = (
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
      persistLocalDraft(next, notes);
      return next;
    });
  };

  const handleNumberInput = (
    itemId: string,
    field: 'opening' | 'added' | 'closing',
    rawValue: string,
    badInput: boolean,
  ) => {
    if (badInput) return;
    const parsed = parseQuantityInput(rawValue);
    if (!parsed.valid) return;

    if (parsed.empty) {
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
      return;
    }

    applyRowMutation(
      itemId,
      (current) => ({
        ...current,
        [field]: parsed.value,
        notApplicable: field === 'added' ? current.notApplicable : false,
        hasOpening: field === 'opening' ? true : current.hasOpening,
        hasClosing: field === 'closing' ? true : current.hasClosing,
        openingStatus:
          field === 'opening'
            ? computeOpeningStatusForValue(parsed.value, current.previousClosing)
            : current.openingStatus,
      }),
      {
        [field]: true,
        ...(field !== 'added' ? { notApplicable: true } : {}),
      },
    );
  };

  const stepField = (itemId: string, field: 'opening' | 'added' | 'closing', delta: number) => {
    const current = drafts[itemId];
    if (!current) return;
    const base =
      field === 'closing'
        ? current.hasClosing
          ? current.closing
          : 0
        : field === 'opening'
          ? current.hasOpening || typeof current.previousClosing === 'number'
            ? current.opening
            : 0
          : current.added;
    const nextVal = sanitizeStockQuantity(base + delta);
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
  };

  const confirmSingleOpening = (itemId: string) => {
    applyRowMutation(
      itemId,
      (row) => confirmPreloadedOpeningRow(row),
      { opening: true, notApplicable: true },
    );
  };

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

  const markZeroExplicit = (itemId: string, field: 'opening' | 'closing') => {
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
  };

  const toggleNotApplicable = (itemId: string) => {
    const current = drafts[itemId];
    if (!current) return;
    const nextNA = !current.notApplicable;
    applyRowMutation(
      itemId,
      (row) => ({
        ...row,
        notApplicable: nextNA,
        opening: nextNA ? 0 : typeof row.previousClosing === 'number' ? row.previousClosing : row.opening,
        added: nextNA ? 0 : row.added,
        closing: nextNA ? 0 : row.closing,
        hasOpening: false,
        hasClosing: false,
        openingStatus: undefined,
      }),
      { notApplicable: true, opening: true, closing: true },
    );
  };

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

      if (openingState === 'pending_confirm') pendingConfirm += 1;
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
      } else {
        // Closing requires closing value AND no preloaded opening waiting confirmation
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
  }, [stationItems, drafts, isWorkerOpeningPhase]);

  const canSubmitMode = useCallback(
    (mode: 'opening' | 'closing'): { ok: boolean; reasonText?: string } => {
      if (counts.total === 0) return { ok: false, reasonText: 'No hay insumos activos.' };
      if (counts.pendingConfirm > 0) {
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
    [counts],
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
    const anomalies = detectReportAnomalies(rows, mode);
    setConfirmModalState({ mode, anomalies });
  };

  const executeSave = async (
    mode: 'opening' | 'closing',
    options?: { forceOverwrite?: boolean },
  ) => {
    if (stationItems.length === 0) return;

    const rows = buildRowsForSubmit();
    setConfirmModalState(null);
    setPendingConflict(null);
    setSavingMode(mode);
    setFeedback(null);
    setSaveError(null);

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
        existingEntries: entriesByItemId,
        expectedUpdatedAtMs: baselineUpdatedAtRef.current,
        forceOverwrite: options?.forceOverwrite,
      });

      clearStoredDraft(storageKey);
      touchedRef.current = {};
      notesTouchedRef.current = false;
      setRestoredFromLocal(false);
      setRemoteChangedBy(null);
      setSaveError(null);

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
      if (err instanceof DiagnosticSaveError) {
        setSaveError({
          title: err.title,
          detail: err.detail,
          code: err.code,
        });
        return;
      }

      if (err instanceof ConcurrencyConflictError) {
        if (err.reason === 'completed_locked') {
          setSaveError({
            title: 'Planilla ya enviada y bloqueada',
            detail: err.message,
          });
        } else {
          setPendingConflict({ mode, message: err.message });
          setSaveError({
            title: 'Otro dispositivo actualizó esta planilla',
            detail: err.message,
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
    } finally {
      setSavingMode(null);
    }
  };

  const handleReopen = async () => {
    if (!report) return;
    setReopening(true);
    setFeedback(null);
    try {
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
        if (openingState === 'pending_confirm') return true;
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
  }, [stationItems, searchTerm, itemFilter, drafts, isWorkerOpeningPhase]);

  const closingTime = report?.status === 'completed' ? formatTimeShort(report?.updatedAt) : null;
  const draftTime = report?.status === 'opening_saved' ? formatTimeShort(report?.updatedAt) : null;

  // Outside Allowed Shift Schedule (Workers only)
  if (isWorkerOutsideHours) {
    return (
      <ShiftOutsideHoursView
        station={station}
        selectedDate={selectedDate}
        scheduleStatus={scheduleStatus}
      />
    );
  }

  const showClosingThankYou =
    !canManage && (submittedThankYouMode === 'closing' || isLocked);
  const showOpeningThankYou =
    !canManage &&
    !showClosingThankYou &&
    (submittedThankYouMode === 'opening' ||
      (isWorkerOpeningPhase && report?.status === 'opening_saved' && !isCompleted));

  // Full-screen non-editable thank-you view after successful save (apertura or cierre)
  if (showClosingThankYou || showOpeningThankYou) {
    const closingStart12h = formatTime12h(scheduleStatus.schedule.closingStart);
    const openingStart12h = formatTime12h(scheduleStatus.schedule.openingStart);

    return (
      <div className="min-h-[65vh] py-8 sm:py-12 flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="w-full max-w-lg bg-white border border-emerald-200 rounded-2xl p-6 sm:p-8 text-center space-y-5 shadow-xs"
        >
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
              <div className="p-3 rounded-xl bg-stone-50 border border-stone-200">
                <p className="text-[11px] font-medium text-stone-500">Insumos</p>
                <p className="font-mono tabular-nums text-lg font-bold text-stone-900 mt-0.5">
                  {counts.total - counts.naCount}
                </p>
              </div>
              <div className="p-3 rounded-xl bg-red-50/70 border border-red-200">
                <p className="text-[11px] font-medium text-red-700">En cero</p>
                <p className="font-mono tabular-nums text-lg font-bold text-red-700 mt-0.5">
                  {counts.zeroClosing}
                </p>
              </div>
              <div className="p-3 rounded-xl bg-emerald-50/70 border border-emerald-200">
                <p className="text-[11px] font-medium text-emerald-700">Coincidieron</p>
                <p className="font-mono tabular-nums text-lg font-bold text-emerald-700 mt-0.5">
                  {counts.confirmedMatch}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-3 rounded-xl bg-stone-50 border border-stone-200">
                <p className="text-[11px] font-medium text-stone-500">Insumos</p>
                <p className="font-mono tabular-nums text-lg font-bold text-stone-900 mt-0.5">
                  {counts.total - counts.naCount}
                </p>
              </div>
              <div className="p-3 rounded-xl bg-emerald-50/70 border border-emerald-200">
                <p className="text-[11px] font-medium text-emerald-700">Confirmados</p>
                <p className="font-mono tabular-nums text-lg font-bold text-emerald-700 mt-0.5">
                  {counts.confirmedMatch + counts.manualOpening}
                </p>
              </div>
              <div className="p-3 rounded-xl bg-amber-50/70 border border-amber-200">
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
        </motion.div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5 pb-28 lg:pb-8 min-w-0">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3.5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-orange-600">
            ¡Hola, {station.workerName}! · {station.area || 'Tu puesto'} ·{' '}
            {formatDateHuman(selectedDate)}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-0.5 [text-wrap:balance]">
            {station.name}
          </h1>
          <p className="text-sm text-stone-600 mt-1">
            {isWorkerOpeningPhase
              ? `Apertura (${scheduleStatus.openingRangeLabel}): confirma el inicio respecto a ayer y anota si llegó mercancía.`
              : !canManage && scheduleStatus.phase === 'closing'
                ? `Cierre (${scheduleStatus.closingRangeLabel}): revisa inicio/surtido y cuenta cuánto quedó al terminar el turno.`
                : 'Paso 1: Inicio y surtido del día · Paso 2: Cierre del día.'}
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

      {/* No yesterday closing warning */}
      {yesterdayStatus === 'none' && !isLocked && (
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
      {counts.pendingConfirm > 0 && !isLocked && (
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
      {remoteChangedBy && !isLocked && (
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

      {/* Progress & Status Card */}
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
                    : 'Paso 1: Apertura y llegada de productos'}
                </span>
              </>
            ) : report?.status === 'opening_saved' ? (
              <>
                <Save className="w-5 h-5 text-amber-600 shrink-0" />
                <span className="font-semibold text-amber-900">
                  Apertura lista{draftTime ? ` (${draftTime})` : ''} · Paso 2: Cierre del día
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
          <motion.div
            initial={false}
            animate={{ width: `${progressPct}%` }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className={`h-full rounded-full ${
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
              : yesterdayStatus === 'loading'
                ? 'Cargando cierre de ayer para comparar...'
                : yesterdayStatus === 'found'
                  ? `Precargado con cierre de ${formatDateHuman(yesterdayDateStr)}. Revisa o confirma cada insumo.`
                  : 'Cuenta cada insumo, toca "0" si no hay o "No aplica hoy".'}
          </span>
          {(counts.confirmedMatch > 0 || counts.adjusted > 0) && (
            <span className="font-mono tabular-nums text-stone-700">
              {counts.confirmedMatch} coinciden · {counts.adjusted} corregidos
            </span>
          )}
        </div>
      </div>

      <AnimatePresence>
        {feedback && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            role="status"
            className={`px-4 py-3.5 text-sm font-medium rounded-2xl border ${
              feedback.type === 'success'
                ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                : 'bg-red-50 text-red-900 border-red-200'
            }`}
          >
            {feedback.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search & Filter Toolbar */}
      {stationItems.length > 0 && (
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
            No hay insumos activos en este puesto. El jefe puede agregarlos desde &ldquo;Catálogo de Insumos&rdquo;.
          </div>
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
              className="text-sm font-semibold text-orange-600 hover:text-orange-700 cursor-pointer"
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

                const isNA = Boolean(row.notApplicable);
                const openingState = getOpeningRowState(row);
                const isPendingConfirm = openingState === 'pending_confirm';
                const showOpeningNumber =
                  !isNA && (row.hasOpening || isPendingConfirm);
                const hasClosingVal = row.hasClosing && !isNA;

                const level = getStockLevel(row.closing, item.minStock);
                const meta = getStockLevelMeta(level);
                const suggestBuy = getSuggestedPurchase(
                  row.closing,
                  item.minStock,
                  item.targetStock,
                );
                const rowAnomalies = detectEntryAnomalies(row, draftMode);

                const cardSurface = isNA
                  ? 'bg-stone-100/80'
                  : isPendingConfirm
                    ? 'bg-sky-50/50'
                    : isWorkerOpeningPhase && row.hasOpening
                      ? 'bg-emerald-50/25'
                      : !isWorkerOpeningPhase && hasClosingVal
                        ? 'bg-white'
                        : 'bg-white';

                return (
                  <div key={item.id} className={`p-4 sm:p-5 space-y-4 ${cardSurface}`}>
                    {/* Item Title + Status */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-base font-bold text-stone-900 leading-snug">
                          {item.name}
                        </h3>
                        <p className="text-xs text-stone-500 mt-0.5 font-mono tabular-nums">
                          {item.unit} · Mín: {item.minStock}
                          {typeof row.previousClosing === 'number' && (
                            <> · <span className="text-sky-800 font-semibold">Ayer quedó: {row.previousClosing}</span></>
                          )}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        {isNA ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-stone-500">
                            <Ban className="w-3.5 h-3.5 shrink-0" />
                            No aplica
                          </span>
                        ) : isPendingConfirm ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-sky-100 text-sky-800 border border-sky-300 text-xs font-bold">
                            <Clock className="w-3.5 h-3.5 shrink-0" />
                            Por confirmar
                          </span>
                        ) : openingState === 'adjusted' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-700">
                            <Check className="w-3.5 h-3.5 shrink-0" />
                            Corregido
                          </span>
                        ) : openingState === 'confirmed' || openingState === 'manual' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            Inicio OK
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-stone-500">
                            <Clock className="w-3.5 h-3.5 shrink-0" />
                            Por contar
                          </span>
                        )}
                      </div>
                    </div>

                    {rowAnomalies.length > 0 && (
                      <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                        <span>{rowAnomalies[0].message}</span>
                      </div>
                    )}

                    {/* PASO 1: Inicio del día y Surtido (+) — ALWAYS VISIBLE */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-stone-700">
                          Paso 1 · Inicio y surtido
                        </span>
                        {!isNA && (row.hasOpening || isPendingConfirm) && (
                          <span className="font-mono tabular-nums font-semibold text-stone-600">
                            Disponible: {sanitizeStockQuantity(row.opening + row.added)} {item.unit}
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label
                            htmlFor={`m-open-${item.id}`}
                            className="flex items-center justify-between gap-2 text-xs font-semibold text-stone-700"
                          >
                            <span>Inicio del día ({item.unit})</span>
                            {typeof row.previousClosing === 'number' && (
                              <span className="font-mono tabular-nums text-sky-800">
                                Ayer quedó: {row.previousClosing}
                              </span>
                            )}
                          </label>
                          <div className="flex items-center gap-2">
                            <motion.button
                              whileTap={{ scale: 0.94 }}
                              type="button"
                              disabled={isLocked || isNA}
                              onClick={() => stepField(item.id, 'opening', -1)}
                              aria-label={`Restar inicio ${item.name}`}
                              className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                            >
                              <Minus className="w-5 h-5" />
                            </motion.button>
                            <input
                              id={`m-open-${item.id}`}
                              type="number"
                              inputMode="decimal"
                              min={0}
                              step="any"
                              disabled={isLocked || isNA}
                              placeholder="—"
                              value={showOpeningNumber ? row.opening : ''}
                              onChange={(e) =>
                                handleNumberInput(
                                  item.id,
                                  'opening',
                                  e.target.value,
                                  e.target.validity.badInput,
                                )
                              }
                              className={`min-w-0 flex-1 h-12 text-center font-mono tabular-nums text-xl font-bold rounded-xl border placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-stone-100 ${
                                isPendingConfirm
                                  ? 'bg-sky-50 border-sky-400 text-sky-950'
                                  : openingState === 'adjusted'
                                    ? 'bg-orange-50/40 border-orange-400 text-stone-900'
                                    : row.hasOpening
                                      ? 'bg-emerald-50/40 border-emerald-500 text-stone-900'
                                      : 'bg-white border-stone-300 text-stone-900'
                              }`}
                            />
                            <motion.button
                              whileTap={{ scale: 0.94 }}
                              type="button"
                              disabled={isLocked || isNA}
                              onClick={() => stepField(item.id, 'opening', 1)}
                              aria-label={`Sumar inicio ${item.name}`}
                              className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                            >
                              <Plus className="w-5 h-5" />
                            </motion.button>
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <label
                            htmlFor={`m-add-${item.id}`}
                            className="block text-xs font-semibold text-orange-700"
                          >
                            Surtido / llegó hoy (+)
                          </label>
                          <div className="flex items-center gap-2">
                            <motion.button
                              whileTap={{ scale: 0.94 }}
                              type="button"
                              disabled={isLocked || isNA}
                              onClick={() => stepField(item.id, 'added', -1)}
                              aria-label={`Restar surtido ${item.name}`}
                              className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100 disabled:opacity-40 cursor-pointer"
                            >
                              <Minus className="w-5 h-5" />
                            </motion.button>
                            <input
                              id={`m-add-${item.id}`}
                              type="number"
                              inputMode="decimal"
                              min={0}
                              step="any"
                              disabled={isLocked || isNA}
                              value={isNA ? '' : row.added}
                              onChange={(e) =>
                                handleNumberInput(
                                  item.id,
                                  'added',
                                  e.target.value,
                                  e.target.validity.badInput,
                                )
                              }
                              className="min-w-0 flex-1 h-12 text-center font-mono tabular-nums text-xl font-bold rounded-xl border border-orange-300 bg-orange-50/40 text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-stone-100"
                            />
                            <motion.button
                              whileTap={{ scale: 0.94 }}
                              type="button"
                              disabled={isLocked || isNA}
                              onClick={() => stepField(item.id, 'added', 1)}
                              aria-label={`Sumar surtido ${item.name}`}
                              className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100 disabled:opacity-40 cursor-pointer"
                            >
                              <Plus className="w-5 h-5" />
                            </motion.button>
                          </div>
                        </div>
                      </div>

                      {!isLocked && (
                        <div className="flex flex-wrap gap-2">
                          {isPendingConfirm && (
                            <button
                              type="button"
                              onClick={() => confirmSingleOpening(item.id)}
                              className="flex-1 min-w-[140px] min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs sm:text-sm font-bold rounded-xl bg-sky-600 text-white hover:bg-sky-700 active:scale-[0.99] transition-all cursor-pointer"
                            >
                              <Check className="w-4 h-4 shrink-0" />
                              ✓ Está bien
                            </button>
                          )}
                          {isWorkerOpeningPhase && (
                            <button
                              type="button"
                              onClick={() => markZeroExplicit(item.id, 'opening')}
                              className={`flex-1 min-h-[44px] px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                                row.hasOpening && !isNA && row.opening === 0
                                  ? 'bg-stone-900 text-white border-stone-900'
                                  : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                              }`}
                            >
                              0 / Sin existencia
                            </button>
                          )}
                          {isWorkerOpeningPhase && (
                            <button
                              type="button"
                              onClick={() => toggleNotApplicable(item.id)}
                              className={`min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                                isNA
                                  ? 'bg-stone-700 text-white border-stone-700'
                                  : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                              }`}
                            >
                              <Ban className="w-3.5 h-3.5 shrink-0" />
                              {isNA ? 'No aplica' : 'No aplica hoy'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* PASO 2: Cierre del día (visible en cierre / jefe / horario libre) */}
                    {!isWorkerOpeningPhase && (
                      <div className="pt-3 border-t border-stone-100 space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <label
                            htmlFor={`mobile-close-${item.id}`}
                            className="text-xs font-bold text-stone-800"
                          >
                            Paso 2 · ¿Cuánto quedó hoy al cerrar? ({item.unit})
                          </label>
                          {hasClosingVal ? (
                            <span
                              className={`inline-flex items-center gap-1 text-xs font-semibold ${meta.textClass}`}
                            >
                              {(level === 'agotado' || level === 'comprar') && (
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                              )}
                              {suggestBuy > 0 ? `Pedir +${suggestBuy}` : meta.label}
                            </span>
                          ) : !isNA ? (
                            <span className="text-xs font-semibold text-stone-400">Por contar</span>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-2">
                          <motion.button
                            whileTap={{ scale: 0.94 }}
                            type="button"
                            disabled={isLocked || isNA}
                            onClick={() => stepField(item.id, 'closing', -1)}
                            aria-label={`Restar cierre ${item.name}`}
                            className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                          >
                            <Minus className="w-5 h-5" />
                          </motion.button>
                          <input
                            id={`mobile-close-${item.id}`}
                            type="number"
                            inputMode="decimal"
                            min={0}
                            step="any"
                            disabled={isLocked || isNA}
                            placeholder="—"
                            value={hasClosingVal ? row.closing : ''}
                            onChange={(e) =>
                              handleNumberInput(
                                item.id,
                                'closing',
                                e.target.value,
                                e.target.validity.badInput,
                              )
                            }
                            className={`min-w-0 flex-1 h-12 text-center font-mono tabular-nums text-xl font-bold rounded-xl border placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60 transition-colors ${
                              isNA
                                ? 'bg-stone-100 border-stone-200 text-stone-400'
                                : !hasClosingVal
                                  ? 'bg-stone-50 border-stone-300 text-stone-800'
                                  : level === 'agotado' || level === 'comprar'
                                    ? 'bg-red-50/40 border-red-400 text-stone-900'
                                    : level === 'medio'
                                      ? 'bg-amber-50/40 border-amber-400 text-stone-900'
                                      : 'bg-emerald-50/40 border-emerald-500 text-stone-900'
                            }`}
                          />
                          <motion.button
                            whileTap={{ scale: 0.94 }}
                            type="button"
                            disabled={isLocked || isNA}
                            onClick={() => stepField(item.id, 'closing', 1)}
                            aria-label={`Sumar cierre ${item.name}`}
                            className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                          >
                            <Plus className="w-5 h-5" />
                          </motion.button>
                        </div>

                        {!isLocked && (
                          <div className="grid grid-cols-2 gap-2 pt-0.5">
                            <button
                              type="button"
                              onClick={() => markZeroExplicit(item.id, 'closing')}
                              className={`min-h-[44px] px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                                hasClosingVal && row.closing === 0
                                  ? 'bg-red-700 text-white border-red-700'
                                  : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                              }`}
                            >
                              0 / No queda
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleNotApplicable(item.id)}
                              className={`min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                                isNA
                                  ? 'bg-stone-700 text-white border-stone-700'
                                  : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                              }`}
                            >
                              <Ban className="w-3.5 h-3.5 shrink-0" />
                              {isNA ? 'Marcado: No aplica' : 'No aplica hoy'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Desktop Table (>= lg) — Inicio y surtido SIEMPRE visibles antes del cierre */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th className="py-3.5 px-5 min-w-[210px]">Insumo</th>
                    <th className="py-3.5 px-3 text-center">Inicio del día</th>
                    <th className="py-3.5 px-3 text-center">Surtido (+)</th>
                    {isWorkerOpeningPhase ? (
                      <>
                        <th className="py-3.5 px-4 text-center">Confirmación y opciones</th>
                        <th className="py-3.5 px-5 text-right">Total disponible</th>
                      </>
                    ) : (
                      <>
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

                    const isNA = Boolean(row.notApplicable);
                    const openingState = getOpeningRowState(row);
                    const isPendingConfirm = openingState === 'pending_confirm';
                    const showOpeningNumber = !isNA && (row.hasOpening || isPendingConfirm);
                    const hasValue = row.hasClosing && !isNA;
                    const consumed =
                      row.hasOpening && hasValue
                        ? Math.max(0, row.opening + row.added - row.closing)
                        : null;
                    const level = getStockLevel(row.closing, item.minStock);
                    const meta = getStockLevelMeta(level);
                    const suggestBuy = getSuggestedPurchase(
                      row.closing,
                      item.minStock,
                      item.targetStock,
                    );
                    const rowAnomalies = detectEntryAnomalies(row, draftMode);

                    return (
                      <tr
                        key={item.id}
                        className={`transition-colors ${
                          isNA
                            ? 'bg-stone-50/90'
                            : isPendingConfirm
                              ? 'bg-sky-50/45 hover:bg-sky-50/70'
                              : 'hover:bg-stone-50/70'
                        }`}
                      >
                        <td className="py-4 px-5">
                          <div className="text-base font-semibold text-stone-900">{item.name}</div>
                          <div className="text-xs text-stone-500 font-mono tabular-nums mt-0.5 flex flex-wrap items-center gap-x-1.5">
                            <span>
                              {item.unit} · Mín: {item.minStock}
                            </span>
                            {typeof row.previousClosing === 'number' && (
                              <span className="text-sky-800 font-semibold">
                                · Ayer quedó: {row.previousClosing}
                              </span>
                            )}
                          </div>
                          {rowAnomalies.length > 0 && (
                            <div className="inline-flex items-center gap-1 mt-1 text-xs font-medium text-amber-700">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                              <span>{rowAnomalies[0].message}</span>
                            </div>
                          )}
                        </td>

                        {/* Inicio del día + "✓ Está bien" si pendiente */}
                        <td className="py-4 px-3">
                          <div className="flex flex-col items-center gap-1.5">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                disabled={isLocked || isNA}
                                onClick={() => stepField(item.id, 'opening', -1)}
                                aria-label={`Restar inicio de ${item.name}`}
                                className="w-9 h-10 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                              >
                                <Minus className="w-3.5 h-3.5" />
                              </button>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                disabled={isLocked || isNA}
                                placeholder="—"
                                aria-label={`Inicio de ${item.name}`}
                                value={showOpeningNumber ? row.opening : ''}
                                onChange={(e) =>
                                  handleNumberInput(
                                    item.id,
                                    'opening',
                                    e.target.value,
                                    e.target.validity.badInput,
                                  )
                                }
                                className={`w-16 h-10 text-center font-mono tabular-nums text-sm font-bold rounded-lg border placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60 ${
                                  isPendingConfirm
                                    ? 'bg-sky-50 border-sky-400 text-sky-950'
                                    : openingState === 'adjusted'
                                      ? 'bg-orange-50 border-orange-400 text-stone-900'
                                      : row.hasOpening
                                        ? 'bg-emerald-50/50 border-emerald-500 text-stone-900'
                                        : 'bg-stone-50 border-stone-200 text-stone-900'
                                }`}
                              />
                              <button
                                type="button"
                                disabled={isLocked || isNA}
                                onClick={() => stepField(item.id, 'opening', 1)}
                                aria-label={`Sumar inicio de ${item.name}`}
                                className="w-9 h-10 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                              >
                                <Plus className="w-3.5 h-3.5" />
                              </button>
                            </div>

                            {isPendingConfirm && !isLocked ? (
                              <button
                                type="button"
                                onClick={() => confirmSingleOpening(item.id)}
                                className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-white bg-sky-600 rounded-lg hover:bg-sky-700 whitespace-nowrap cursor-pointer"
                              >
                                <Check className="w-3.5 h-3.5" />
                                ✓ Está bien
                              </button>
                            ) : !isNA && openingState === 'adjusted' ? (
                              <span className="text-[11px] font-semibold text-orange-700">
                                Corregido
                              </span>
                            ) : !isNA && openingState === 'confirmed' ? (
                              <span className="text-[11px] font-semibold text-emerald-700">
                                Confirmado
                              </span>
                            ) : null}
                          </div>
                        </td>

                        {/* Surtido (+) */}
                        <td className="py-4 px-3">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              disabled={isLocked || isNA}
                              onClick={() => stepField(item.id, 'added', -1)}
                              aria-label={`Restar surtido de ${item.name}`}
                              className="w-9 h-10 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              disabled={isLocked || isNA}
                              aria-label={`Surtido de ${item.name}`}
                              value={isNA ? '' : row.added}
                              onChange={(e) =>
                                handleNumberInput(
                                  item.id,
                                  'added',
                                  e.target.value,
                                  e.target.validity.badInput,
                                )
                              }
                              className="w-16 h-10 text-center font-mono tabular-nums text-sm bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white disabled:opacity-60"
                            />
                            <button
                              type="button"
                              disabled={isLocked || isNA}
                              onClick={() => stepField(item.id, 'added', 1)}
                              aria-label={`Sumar surtido de ${item.name}`}
                              className="w-9 h-10 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>

                        {isWorkerOpeningPhase ? (
                          <>
                            <td className="py-4 px-3">
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => markZeroExplicit(item.id, 'opening')}
                                  className={`min-h-[38px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                                    row.hasOpening && !isNA && row.opening === 0
                                      ? 'bg-stone-900 text-white border-stone-900'
                                      : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                                  }`}
                                >
                                  0
                                </button>
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => toggleNotApplicable(item.id)}
                                  className={`min-h-[38px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                                    isNA
                                      ? 'bg-stone-700 text-white border-stone-700'
                                      : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                                  }`}
                                >
                                  No aplica
                                </button>
                              </div>
                            </td>
                            <td className="py-4 px-5 text-right font-mono tabular-nums font-bold">
                              {isNA ? (
                                <span className="text-stone-500 font-normal">No aplica</span>
                              ) : isPendingConfirm ? (
                                <span className="text-sky-700">Por confirmar</span>
                              ) : row.hasOpening ? (
                                <span className="text-stone-900">
                                  {row.opening + row.added} {item.unit}
                                </span>
                              ) : (
                                <span className="text-stone-400 font-normal">Por contar</span>
                              )}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="py-4 px-4">
                              <div className="flex items-center justify-center gap-1.5">
                                <motion.button
                                  whileTap={{ scale: 0.94 }}
                                  type="button"
                                  disabled={isLocked || isNA}
                                  onClick={() => stepField(item.id, 'closing', -1)}
                                  aria-label={`Restar cierre de ${item.name}`}
                                  className="w-11 h-11 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                                >
                                  <Minus className="w-4 h-4" />
                                </motion.button>
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  disabled={isLocked || isNA}
                                  placeholder="—"
                                  aria-label={`Cierre de ${item.name}`}
                                  value={hasValue ? row.closing : ''}
                                  onChange={(e) =>
                                    handleNumberInput(
                                      item.id,
                                      'closing',
                                      e.target.value,
                                      e.target.validity.badInput,
                                    )
                                  }
                                  className={`w-20 h-11 text-center font-mono tabular-nums text-base font-bold rounded-xl border placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60 transition-colors ${
                                    isNA
                                      ? 'bg-stone-100 border-stone-200 text-stone-400'
                                      : hasValue
                                        ? 'bg-white border-orange-500 text-stone-900'
                                        : 'bg-stone-50 border-stone-300 text-stone-800'
                                  }`}
                                />
                                <motion.button
                                  whileTap={{ scale: 0.94 }}
                                  type="button"
                                  disabled={isLocked || isNA}
                                  onClick={() => stepField(item.id, 'closing', 1)}
                                  aria-label={`Sumar cierre de ${item.name}`}
                                  className="w-11 h-11 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                                >
                                  <Plus className="w-4 h-4" />
                                </motion.button>
                              </div>
                            </td>

                            <td className="py-4 px-3">
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => markZeroExplicit(item.id, 'closing')}
                                  className={`min-h-[38px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                                    hasValue && row.closing === 0
                                      ? 'bg-red-700 text-white border-red-700'
                                      : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                                  }`}
                                >
                                  0 / No queda
                                </button>
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => toggleNotApplicable(item.id)}
                                  className={`min-h-[38px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                                    isNA
                                      ? 'bg-stone-700 text-white border-stone-700'
                                      : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                                  }`}
                                >
                                  No aplica
                                </button>
                              </div>
                            </td>

                            <td className="py-4 px-4 text-right font-mono tabular-nums text-stone-700">
                              {consumed !== null ? `${consumed} ${item.unit}` : '—'}
                            </td>

                            <td className="py-4 px-5 whitespace-nowrap">
                              {isNA ? (
                                <span className="text-xs font-semibold text-stone-500">
                                  No aplica hoy
                                </span>
                              ) : isPendingConfirm ? (
                                <span className="text-xs font-bold text-sky-700">
                                  Inicio por confirmar
                                </span>
                              ) : !hasValue ? (
                                <span className="text-xs font-medium text-stone-400">
                                  Por contar
                                </span>
                              ) : (
                                <div className="space-y-0.5">
                                  <span
                                    className={`inline-flex items-center gap-1.5 text-sm font-semibold ${meta.textClass}`}
                                  >
                                    {(level === 'agotado' || level === 'comprar') && (
                                      <AlertTriangle className="w-4 h-4 shrink-0" />
                                    )}
                                    {meta.label}
                                  </span>
                                  {suggestBuy > 0 && (
                                    <p className="text-xs font-mono tabular-nums text-red-700">
                                      Sugerido pedir: +{suggestBuy} {item.unit}
                                    </p>
                                  )}
                                </div>
                              )}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Notes & Desktop Save Section */}
      {stationItems.length > 0 && (
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
              className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white disabled:opacity-60"
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
                  className="min-h-[42px] px-3.5 py-2 text-xs font-semibold text-stone-800 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  Aceptar versión del servidor
                </button>
                <button
                  type="button"
                  disabled={savingMode !== null}
                  onClick={() => executeSave(pendingConflict.mode, { forceOverwrite: true })}
                  className="min-h-[42px] px-3.5 py-2 text-xs font-semibold text-white bg-red-700 rounded-xl hover:bg-red-800 disabled:opacity-50 cursor-pointer"
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
                className="font-bold text-orange-700 underline hover:text-orange-900 cursor-pointer"
              >
                Ver pendientes
              </button>
            </div>
          )}

          {/* Save error inline right beside Desktop Action Row */}
          {saveError && !isLocked && (
            <div
              role="alert"
              className="hidden lg:flex items-start justify-between gap-3 p-3.5 rounded-xl bg-red-50 border border-red-300 text-red-950"
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div className="text-xs space-y-0.5 min-w-0">
                  <p className="font-bold">
                    {saveError.title}
                    {saveError.code ? (
                      <span className="ml-2 font-mono font-semibold text-red-700">
                        ({saveError.code})
                      </span>
                    ) : null}
                  </p>
                  <p className="text-red-900 leading-relaxed break-words">{saveError.detail}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSaveError(null)}
                aria-label="Cerrar error de guardado"
                className="p-1 text-red-700 hover:bg-red-100 rounded-lg shrink-0 cursor-pointer"
              >
                <X className="w-4 h-4" />
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
                  ? 'Guardando apertura...'
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
                    ? 'Enviando cierre...'
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

      {/* Mobile Sticky Bottom CTA Bar (compact <= 15% mobile viewport height) */}
      {stationItems.length > 0 && !isLocked && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-stone-200 shadow-lg no-print">
          {pendingConflict && (
            <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-amber-950">
              <div className="max-w-lg mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold">Otro dispositivo editó esta planilla.</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={syncDraftsWithServer}
                    className="min-h-[36px] px-2.5 py-1 font-semibold text-stone-800 bg-white border border-stone-300 rounded-lg cursor-pointer"
                  >
                    Cargar servidor
                  </button>
                  <button
                    type="button"
                    disabled={savingMode !== null}
                    onClick={() => executeSave(pendingConflict.mode, { forceOverwrite: true })}
                    className="min-h-[36px] px-2.5 py-1 font-semibold text-white bg-red-700 rounded-lg disabled:opacity-50 cursor-pointer"
                  >
                    Sobrescribir
                  </button>
                </div>
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
                  <div className="text-xs min-w-0">
                    <p className="font-bold leading-snug">
                      {saveError.title}
                      {saveError.code ? (
                        <span className="ml-1.5 font-mono text-red-700">({saveError.code})</span>
                      ) : null}
                    </p>
                    <p className="text-red-900 leading-snug mt-0.5 break-words">{saveError.detail}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSaveError(null)}
                  aria-label="Cerrar error de guardado"
                  className="p-1 text-red-700 hover:bg-red-100 rounded-lg shrink-0 cursor-pointer"
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
                  {counts.pendingConfirm > 0
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
                  ? 'Guardando...'
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
    </div>
  );
}
