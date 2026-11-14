import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  History,
  Lock,
  Minus,
  Moon,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sun,
  WifiOff,
} from 'lucide-react';
import { MAX_NOTES_LENGTH } from '../constants';
import {
  ConcurrencyConflictError,
  fetchStationEntriesOnce,
  reopenStationReport,
  saveStationReportBatch,
} from '../services/inventoryService';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  Workspace,
  Workstation,
} from '../types';
import {
  detectEntryAnomalies,
  detectReportAnomalies,
  formatDateHuman,
  formatTimeShort,
  getPreviousDateStr,
  getStockLevel,
  getStockLevelMeta,
  getSuggestedPurchase,
  parseQuantityInput,
  sanitizeStockQuantity,
  type EntryAnomaly,
} from '../utils/inventory';
import type { WorkerScheduleStatus } from '../utils/schedule';

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

  const opening = storedTouched?.opening
    ? storedRow?.opening ?? 0
    : existing
      ? existing.opening
      : 0;
  const hasOpening = notApplicable
    ? false
    : storedTouched?.opening
      ? Boolean(storedRow?.hasOpening)
      : Boolean(existing?.hasOpening);

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
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [autoLoadedPrevDate, setAutoLoadedPrevDate] = useState<string | null>(null);
  const [restoredFromLocal, setRestoredFromLocal] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [showOpeningDetails, setShowOpeningDetails] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [itemFilter, setItemFilter] = useState<ItemFilter>('todos');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [remoteChangedBy, setRemoteChangedBy] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{
    mode: 'opening' | 'closing';
    message: string;
  } | null>(null);
  const [pendingAnomalyConfirm, setPendingAnomalyConfirm] = useState<{
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
  const autoPreloadKeyRef = useRef<string>('');
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

    setDrafts(nextDrafts);
    setNotes(stored?.notesTouched ? stored.notes : latestReportNotesRef.current);
    setRestoredFromLocal(hasRestoredEdits);
    setRemoteChangedBy(null);
    setPendingConflict(null);
    setPendingAnomalyConfirm(null);
    setFeedback(null);
    setAutoLoadedPrevDate(null);
  }, [workspace.id, station.id, selectedDate, report?.id, draftMode, storageKey]);

  // 2. Merge remote snapshot updates WITHOUT overwriting any touched local fields
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
          if (!touched?.notApplicable && Boolean(existing.notApplicable) !== Boolean(updatedRow.notApplicable)) {
            updatedRow = {
              ...updatedRow,
              notApplicable: Boolean(existing.notApplicable),
            };
          }
          if (
            !touched?.opening &&
            !touched?.notApplicable &&
            (updatedRow.opening !== existing.opening || updatedRow.hasOpening !== existing.hasOpening)
          ) {
            updatedRow = {
              ...updatedRow,
              opening: existing.opening,
              hasOpening: existing.hasOpening,
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

  // 3. Auto-preload yesterday's closing as today's opening if today has no report yet
  useEffect(() => {
    if (isWorkerOutsideHours || report || stationItems.length === 0) return;
    const key = `${workspace.id}_${selectedDate}_${station.id}_${stationItems.length}`;
    if (autoPreloadKeyRef.current === key) return;
    autoPreloadKeyRef.current = key;

    let cancelled = false;
    const prevDate = getPreviousDateStr(selectedDate);
    fetchStationEntriesOnce(
      workspace.id,
      prevDate,
      station.id,
      stationItems.map((i) => i.id),
    )
      .then((prevEntries) => {
        if (cancelled) return;
        if (Object.keys(prevEntries).length === 0) return;
        let loadedAny = false;
        setDrafts((prev) => {
          const updated = { ...prev };
          Object.keys(updated).forEach((itemId) => {
            const prevEntry = prevEntries[itemId];
            const touched = touchedRef.current[itemId];
            if (
              prevEntry &&
              prevEntry.hasClosing &&
              !prevEntry.notApplicable &&
              !updated[itemId].hasOpening &&
              !updated[itemId].notApplicable &&
              !touched?.opening &&
              !touched?.notApplicable
            ) {
              updated[itemId] = {
                ...updated[itemId],
                opening: prevEntry.closing,
                hasOpening: true,
              };
              loadedAny = true;
            }
          });
          return loadedAny ? updated : prev;
        });
        if (loadedAny) {
          setAutoLoadedPrevDate(prevDate);
        }
      })
      .catch(() => {
        // Silent auto-preload fallback
      });

    return () => {
      cancelled = true;
    };
  }, [isWorkerOutsideHours, report, workspace.id, selectedDate, station.id, stationItems]);

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
          ? current.hasOpening
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
      }),
      {
        [field]: true,
        ...(field !== 'added' ? { notApplicable: true } : {}),
      },
    );
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
        opening: nextNA ? 0 : row.opening,
        added: nextNA ? 0 : row.added,
        closing: nextNA ? 0 : row.closing,
        hasOpening: nextNA ? false : row.hasOpening,
        hasClosing: nextNA ? false : row.hasClosing,
      }),
      { notApplicable: true, opening: true, closing: true },
    );
  };

  const handleNotesChange = (nextNotes: string) => {
    notesTouchedRef.current = true;
    setNotes(nextNotes);
    persistLocalDraft(drafts, nextNotes);
  };

  const handleLoadYesterdayClosing = async () => {
    if (stationItems.length === 0) return;
    setLoadingPrev(true);
    setFeedback(null);
    try {
      const prevDate = getPreviousDateStr(selectedDate);
      const prevEntries = await fetchStationEntriesOnce(
        workspace.id,
        prevDate,
        station.id,
        stationItems.map((i) => i.id),
      );
      const countFound = Object.keys(prevEntries).length;
      if (countFound === 0) {
        setFeedback({
          type: 'error',
          text: `No se encontró un cierre guardado para ${formatDateHuman(prevDate)}.`,
        });
        return;
      }

      setDrafts((prev) => {
        const updated = { ...prev };
        Object.keys(updated).forEach((itemId) => {
          const prevEntry = prevEntries[itemId];
          if (prevEntry && prevEntry.hasClosing && !prevEntry.notApplicable) {
            updated[itemId] = {
              ...updated[itemId],
              opening: prevEntry.closing,
              hasOpening: true,
              notApplicable: false,
            };
            touchedRef.current[itemId] = {
              ...(touchedRef.current[itemId] ?? {}),
              opening: true,
              notApplicable: true,
            };
          }
        });
        persistLocalDraft(updated, notes);
        return updated;
      });
      setAutoLoadedPrevDate(prevDate);
      setFeedback({
        type: 'success',
        text: `Se cargó el cierre del ${formatDateHuman(prevDate)} como base de apertura.`,
      });
    } catch {
      setFeedback({
        type: 'error',
        text: 'No se pudo consultar el reporte del día anterior.',
      });
    } finally {
      setLoadingPrev(false);
    }
  };

  const isRowAccounted = useCallback(
    (row: DraftEntryRow | undefined): boolean => {
      if (!row) return false;
      if (row.notApplicable) return true;
      return isWorkerOpeningPhase ? Boolean(row.hasOpening) : Boolean(row.hasClosing);
    },
    [isWorkerOpeningPhase],
  );

  const countedCount = stationItems.filter((it) => isRowAccounted(drafts[it.id])).length;
  const missingCount = Math.max(0, stationItems.length - countedCount);
  const allAccounted = stationItems.length > 0 && missingCount === 0;

  const lowCount = stationItems.filter((it) => {
    const row = drafts[it.id];
    if (!row || row.notApplicable) return false;
    const isCounted = isWorkerOpeningPhase ? row.hasOpening : row.hasClosing;
    if (!isCounted) return false;
    const lvl = getStockLevel(isWorkerOpeningPhase ? row.opening + row.added : row.closing, it.minStock);
    return lvl === 'agotado' || lvl === 'comprar' || lvl === 'medio';
  }).length;

  const progressPct =
    stationItems.length > 0 ? Math.round((countedCount / stationItems.length) * 100) : 0;

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
    setDrafts(syncedDrafts);
    setNotes(report?.notes ?? '');
    setRestoredFromLocal(false);
    setRemoteChangedBy(null);
    setPendingConflict(null);
    setFeedback({
      type: 'success',
      text: 'Planilla sincronizada con los últimos datos guardados en el servidor.',
    });
  };

  const handleSave = async (
    mode: 'opening' | 'closing',
    options?: { forceOverwrite?: boolean; skipAnomalyCheck?: boolean },
  ) => {
    if (stationItems.length === 0) return;

    const requiresFullCount = mode === 'closing' || isWorkerOpeningPhase;
    if (requiresFullCount && !allAccounted) {
      setItemFilter('pendientes');
      setFeedback({
        type: 'error',
        text: `Faltan ${missingCount} ${missingCount === 1 ? 'insumo' : 'insumos'} por contar. Escribe la cantidad, pulsa "0 / No queda" o marca "No aplica hoy".`,
      });
      listSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const rows = stationItems.map((it) => drafts[it.id]).filter(Boolean);

    if (!options?.skipAnomalyCheck) {
      const anomalies = detectReportAnomalies(rows, mode);
      if (anomalies.length > 0) {
        setPendingAnomalyConfirm({ mode, anomalies });
        return;
      }
    }

    setPendingAnomalyConfirm(null);
    setPendingConflict(null);
    setSavingMode(mode);
    setFeedback(null);
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

      setFeedback({
        type: 'success',
        text: saveResult.queuedOffline
          ? mode === 'opening'
            ? 'Sin conexión — apertura guardada en este celular. Se enviará sola al volver internet.'
            : 'Sin conexión — cierre guardado en este celular. Se enviará al jefe en cuanto vuelva la señal.'
          : mode === 'opening'
            ? '¡Apertura y surtido guardados! Si llegan más productos en este horario puedes volver a ajustarlo.'
            : '¡Excelente! Tu cierre fue enviado y el jefe ya puede verlo en su resumen.',
      });
      onSaved?.();
    } catch (err) {
      if (err instanceof ConcurrencyConflictError) {
        if (err.reason === 'completed_locked') {
          setFeedback({ type: 'error', text: err.message });
        } else {
          setPendingConflict({ mode, message: err.message });
          setFeedback({ type: 'error', text: err.message });
        }
        return;
      }

      const rawMsg = err instanceof Error ? err.message : '';
      const isPerm = rawMsg.includes('permission') || rawMsg.includes('insufficient');
      setFeedback({
        type: 'error',
        text: isPerm
          ? 'No se pudo guardar porque el horario ya terminó o el cierre ya fue enviado. Pídele al jefe revisar la planilla. Tu borrador sigue guardado aquí.'
          : 'Ocurrió un error al guardar el inventario. Tu borrador sigue guardado en este celular.',
      });
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
      if (itemFilter === 'pendientes') {
        return !isRowAccounted(row);
      }
      if (itemFilter === 'bajos') {
        if (!row || row.notApplicable) return false;
        const isCounted = isWorkerOpeningPhase ? row.hasOpening : row.hasClosing;
        if (!isCounted) return false;
        const val = isWorkerOpeningPhase ? row.opening + row.added : row.closing;
        const lvl = getStockLevel(val, item.minStock);
        return lvl === 'agotado' || lvl === 'comprar' || lvl === 'medio';
      }
      return true;
    });
  }, [stationItems, searchTerm, itemFilter, drafts, isRowAccounted, isWorkerOpeningPhase]);

  const closingTime = report?.status === 'completed' ? formatTimeShort(report?.updatedAt) : null;
  const draftTime = report?.status === 'opening_saved' ? formatTimeShort(report?.updatedAt) : null;

  // Outside Allowed Shift Schedule (Workers only) -> Render nothing from inventory
  if (isWorkerOutsideHours) {
    return (
      <div className="py-8 sm:py-12 flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28 }}
          className="w-full max-w-lg bg-white border border-stone-200 rounded-2xl p-6 sm:p-8 text-center space-y-5 shadow-xs"
        >
          <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-700 flex items-center justify-center mx-auto">
            <Clock className="w-6 h-6" />
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-orange-600">
              ¡Hola, {station.workerName}! · {station.name}
            </p>
            <h1 className="font-display text-2xl font-bold text-stone-900">
              Fuera de horario de inventario
            </h1>
            <p className="text-sm text-stone-600 leading-relaxed">
              En este momento la planilla está cerrada. Tu espacio solo se habilita en los horarios definidos por el jefe:
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
            <div className="p-4 rounded-xl bg-orange-50/70 border border-orange-200/80 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-bold text-orange-800">
                <Sun className="w-4 h-4 shrink-0" />
                <span>Apertura y surtido</span>
              </div>
              <p className="font-mono text-sm font-bold text-stone-900">
                {scheduleStatus.openingRangeLabel}
              </p>
              <p className="text-xs text-stone-600">Inicio del turno y llegada de productos</p>
            </div>

            <div className="p-4 rounded-xl bg-stone-100 border border-stone-200 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-bold text-stone-800">
                <Moon className="w-4 h-4 shrink-0" />
                <span>Cierre del día</span>
              </div>
              <p className="font-mono text-sm font-bold text-stone-900">
                {scheduleStatus.closingRangeLabel}
              </p>
              <p className="text-xs text-stone-600">Conteo final al terminar la jornada</p>
            </div>
          </div>

          <p className="text-xs font-mono text-stone-500 pt-1">
            Hora actual: {scheduleStatus.currentTimeLabel}
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8 min-w-0">
      {/* Friendly Personalized Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-orange-600">
            ¡Hola, {station.workerName}! · {station.area || 'Tu puesto'} ·{' '}
            {formatDateHuman(selectedDate)}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-1 [text-wrap:balance]">
            {station.name}
          </h1>
          <p className="text-sm text-stone-600 mt-1">
            {isWorkerOpeningPhase
              ? `Horario de apertura (${scheduleStatus.openingRangeLabel}): confirma con cuánto inicia el puesto y anota si llegaron productos.`
              : !canManage && scheduleStatus.phase === 'closing'
                ? `Horario de cierre (${scheduleStatus.closingRangeLabel}): anota cuántas unidades quedaron hoy al terminar el turno.`
                : 'Registra apertura, surtido o cierre diario del puesto.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isWorkerOpeningPhase && (
            <button
              type="button"
              onClick={() => setShowOpeningDetails((v) => !v)}
              className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {showOpeningDetails ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
              {showOpeningDetails ? 'Ocultar inicio y surtido' : 'Ver / ajustar inicio y surtido'}
            </button>
          )}

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
            : isWorkerOpeningPhase
              ? 'bg-orange-50/40 border-orange-200/80'
              : 'bg-white border-stone-200'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 text-sm min-w-0">
            {report?.status === 'completed' ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                <span className="font-semibold text-emerald-900">
                  ¡Cierre enviado al jefe!{closingTime ? ` (${closingTime})` : ''}
                </span>
              </>
            ) : isWorkerOpeningPhase ? (
              <>
                <Sun className="w-5 h-5 text-orange-600 shrink-0" />
                <span className="font-semibold text-stone-900">
                  {report?.status === 'opening_saved'
                    ? `Apertura guardada${draftTime ? ` (${draftTime})` : ''} · Puedes ajustar si llega más mercancía`
                    : 'Registro de apertura y llegada de productos'}
                </span>
              </>
            ) : report?.status === 'opening_saved' ? (
              <>
                <Save className="w-5 h-5 text-amber-600 shrink-0" />
                <span className="font-semibold text-amber-900">
                  Apertura lista{draftTime ? ` (${draftTime})` : ''} · Falta enviar cierre final
                </span>
              </>
            ) : (
              <>
                <Moon className="w-5 h-5 text-orange-600 shrink-0" />
                <span className="font-semibold text-stone-900">
                  Conteo de cierre del día
                </span>
              </>
            )}
          </div>

          <div className="text-sm font-mono tabular-nums font-bold text-stone-800 shrink-0">
            {countedCount} de {stationItems.length} contados
          </div>
        </div>

        <div className="w-full h-2.5 bg-stone-200/80 rounded-full overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${progressPct}%` }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className={`h-full rounded-full ${
              isCompleted ? 'bg-emerald-600' : 'bg-orange-600'
            }`}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-600">
          <span>
            {restoredFromLocal
              ? 'Borrador recuperado en este dispositivo. Tus números editados están a salvo.'
              : autoLoadedPrevDate
                ? `Base inicial cargada automáticamente con el cierre de ${formatDateHuman(autoLoadedPrevDate)}.`
                : isWorkerOpeningPhase
                  ? 'Cuenta cada insumo, toca "0" si no hay o "No aplica hoy" para poder guardar.'
                  : 'Cuenta todos los insumos (o marca "0 / No queda" / "No aplica") para habilitar el envío.'}
          </span>
          {!isLocked && stationItems.length > 0 && (
            <button
              type="button"
              onClick={handleLoadYesterdayClosing}
              disabled={loadingPrev}
              className="inline-flex items-center gap-1.5 font-semibold text-orange-600 hover:text-orange-700 cursor-pointer"
            >
              <History className="w-3.5 h-3.5" />
              {loadingPrev ? 'Consultando...' : 'Cargar cierre de ayer'}
            </button>
          )}
        </div>
      </div>

      {isLocked && (
        <div className="flex items-center gap-3 px-4 py-3.5 text-sm text-stone-800 bg-stone-100 border border-stone-200 rounded-2xl">
          <Lock className="w-4 h-4 text-stone-600 shrink-0" />
          <span>
            Este cierre ya fue enviado al jefe. Si necesitas cambiar un dato, pídele que reabra el reporte.
          </span>
        </div>
      )}

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

      {/* Quick Search & Filter Toolbar */}
      {stationItems.length > 0 && (
        <div
          ref={listSectionRef}
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-center gap-1 p-1 bg-stone-200/70 rounded-xl w-full sm:w-auto overflow-x-auto">
            <button
              type="button"
              onClick={() => setItemFilter('todos')}
              className={`min-h-[38px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                itemFilter === 'todos'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              Todos ({stationItems.length})
            </button>
            <button
              type="button"
              onClick={() => setItemFilter('pendientes')}
              className={`min-h-[38px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                itemFilter === 'pendientes'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              Faltan ({missingCount})
            </button>
            <button
              type="button"
              onClick={() => setItemFilter('bajos')}
              className={`min-h-[38px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                itemFilter === 'bajos'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              Bajos ({lowCount})
            </button>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar insumo..."
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
            {/* Mobile / Tablet Touch-First List */}
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
                const hasOpeningVal = row.hasOpening && !isNA;
                const hasClosingVal = row.hasClosing && !isNA;
                const activeStockVal = isWorkerOpeningPhase ? row.opening + row.added : row.closing;
                const level = getStockLevel(activeStockVal, item.minStock);
                const meta = getStockLevelMeta(level);
                const suggestBuy = getSuggestedPurchase(
                  row.closing,
                  item.minStock,
                  item.targetStock,
                );

                const inputBorderClass = isNA
                  ? 'bg-stone-100 border-stone-200 text-stone-400'
                  : !hasClosingVal
                    ? 'bg-stone-50 border-stone-300 text-stone-800'
                    : level === 'agotado' || level === 'comprar'
                      ? 'bg-red-50/40 border-red-400 text-stone-900'
                      : level === 'medio'
                        ? 'bg-amber-50/40 border-amber-400 text-stone-900'
                        : 'bg-emerald-50/40 border-emerald-500 text-stone-900';

                const isAccounted = isRowAccounted(row);
                const rowAnomalies = detectEntryAnomalies(row, draftMode);

                return (
                  <div
                    key={item.id}
                    className={`p-4 sm:p-5 space-y-3.5 transition-colors ${
                      isNA ? 'bg-stone-100/70' : isAccounted ? 'bg-white' : 'bg-stone-50/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-base font-bold text-stone-900 leading-snug">
                          {item.name}
                        </h3>
                        <p className="text-xs text-stone-500 mt-0.5 font-mono tabular-nums">
                          {item.unit} · Mínimo: {item.minStock}
                          {!isWorkerOpeningPhase && row.hasOpening && !isNA && !showOpeningDetails
                            ? ` · Base: ${row.opening + row.added}`
                            : ''}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        {isNA ? (
                          <span className="text-xs font-semibold text-stone-500">
                            No aplica hoy
                          </span>
                        ) : isWorkerOpeningPhase ? (
                          hasOpeningVal ? (
                            <span className="text-xs font-mono font-bold text-orange-700">
                              Total: {row.opening + row.added} {item.unit}
                            </span>
                          ) : (
                            <span className="text-xs font-semibold text-stone-400">
                              Por contar
                            </span>
                          )
                        ) : !hasClosingVal ? (
                          <span className="text-xs font-semibold text-stone-400">
                            Por contar
                          </span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-semibold ${meta.textClass}`}
                          >
                            {(level === 'agotado' || level === 'comprar') && (
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            )}
                            {suggestBuy > 0 ? `Pedir +${suggestBuy}` : meta.label}
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

                    {isWorkerOpeningPhase ? (
                      /* OPENING & RESTOCK PHASE */
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-stone-700">
                              Con cuánto abre ({item.unit})
                            </label>
                            <div className="flex items-center gap-2">
                              <motion.button
                                whileTap={{ scale: 0.93 }}
                                type="button"
                                disabled={isLocked || isNA}
                                onClick={() => stepField(item.id, 'opening', -1)}
                                aria-label={`Restar inicio ${item.name}`}
                                className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                              >
                                <Minus className="w-5 h-5" />
                              </motion.button>
                              <input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step="any"
                                disabled={isLocked || isNA}
                                placeholder="—"
                                value={hasOpeningVal ? row.opening : ''}
                                onChange={(e) =>
                                  handleNumberInput(
                                    item.id,
                                    'opening',
                                    e.target.value,
                                    e.target.validity.badInput,
                                  )
                                }
                                className="min-w-0 flex-1 h-12 text-center font-mono tabular-nums text-xl font-bold rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-stone-100"
                              />
                              <motion.button
                                whileTap={{ scale: 0.93 }}
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
                            <label className="block text-xs font-semibold text-orange-700">
                              ¿Llegó producto hoy? / Surtido (+)
                            </label>
                            <div className="flex items-center gap-2">
                              <motion.button
                                whileTap={{ scale: 0.93 }}
                                type="button"
                                disabled={isLocked || isNA}
                                onClick={() => stepField(item.id, 'added', -1)}
                                aria-label={`Restar surtido ${item.name}`}
                                className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100 disabled:opacity-40 cursor-pointer"
                              >
                                <Minus className="w-5 h-5" />
                              </motion.button>
                              <input
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
                                whileTap={{ scale: 0.93 }}
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
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => markZeroExplicit(item.id, 'opening')}
                              className={`min-h-[42px] px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                                hasOpeningVal && row.opening === 0
                                  ? 'bg-stone-900 text-white border-stone-900'
                                  : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                              }`}
                            >
                              0 / Sin existencia
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleNotApplicable(item.id)}
                              className={`min-h-[42px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
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
                    ) : (
                      /* CLOSING PHASE OR BOSS VIEW */
                      <>
                        <div className="space-y-2">
                          <label
                            htmlFor={`mobile-close-${item.id}`}
                            className="block text-xs font-semibold text-stone-600"
                          >
                            ¿Cuánto quedó hoy al cerrar? ({item.unit})
                          </label>
                          <div className="flex items-center gap-2">
                            <motion.button
                              whileTap={{ scale: 0.93 }}
                              type="button"
                              disabled={isLocked || isNA}
                              onClick={() => stepField(item.id, 'closing', -1)}
                              aria-label={`Restar ${item.name}`}
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
                              className={`min-w-0 flex-1 h-12 text-center font-mono tabular-nums text-xl font-bold rounded-xl border placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60 transition-colors ${inputBorderClass}`}
                            />
                            <motion.button
                              whileTap={{ scale: 0.93 }}
                              type="button"
                              disabled={isLocked || isNA}
                              onClick={() => stepField(item.id, 'closing', 1)}
                              aria-label={`Sumar ${item.name}`}
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
                                className={`min-h-[42px] px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
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
                                className={`min-h-[42px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
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

                        <AnimatePresence initial={false}>
                          {showOpeningDetails && !isNA && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              className="overflow-hidden"
                            >
                              <div className="pt-2.5 border-t border-stone-100 grid grid-cols-2 gap-3">
                                <div className="min-w-0">
                                  <label className="block text-xs font-medium text-stone-600 mb-1">
                                    Inicio del día
                                  </label>
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      disabled={isLocked}
                                      onClick={() => stepField(item.id, 'opening', -1)}
                                      aria-label={`Restar inicio ${item.name}`}
                                      className="w-9 h-10 shrink-0 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 disabled:opacity-40 cursor-pointer"
                                    >
                                      <Minus className="w-3.5 h-3.5" />
                                    </button>
                                    <input
                                      type="number"
                                      inputMode="decimal"
                                      min={0}
                                      step="any"
                                      disabled={isLocked}
                                      placeholder="—"
                                      value={hasOpeningVal ? row.opening : ''}
                                      onChange={(e) =>
                                        handleNumberInput(
                                          item.id,
                                          'opening',
                                          e.target.value,
                                          e.target.validity.badInput,
                                        )
                                      }
                                      className="min-w-0 w-full h-10 text-center font-mono tabular-nums text-base sm:text-sm font-semibold bg-stone-50 border border-stone-200 rounded-lg"
                                    />
                                    <button
                                      type="button"
                                      disabled={isLocked}
                                      onClick={() => stepField(item.id, 'opening', 1)}
                                      aria-label={`Sumar inicio ${item.name}`}
                                      className="w-9 h-10 shrink-0 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 disabled:opacity-40 cursor-pointer"
                                    >
                                      <Plus className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>

                                <div className="min-w-0">
                                  <label className="block text-xs font-medium text-stone-600 mb-1">
                                    Surtido hoy (+)
                                  </label>
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      disabled={isLocked}
                                      onClick={() => stepField(item.id, 'added', -1)}
                                      aria-label={`Restar surtido ${item.name}`}
                                      className="w-9 h-10 shrink-0 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 disabled:opacity-40 cursor-pointer"
                                    >
                                      <Minus className="w-3.5 h-3.5" />
                                    </button>
                                    <input
                                      type="number"
                                      inputMode="decimal"
                                      min={0}
                                      step="any"
                                      disabled={isLocked}
                                      value={row.added}
                                      onChange={(e) =>
                                        handleNumberInput(
                                          item.id,
                                          'added',
                                          e.target.value,
                                          e.target.validity.badInput,
                                        )
                                      }
                                      className="min-w-0 w-full h-10 text-center font-mono tabular-nums text-base sm:text-sm font-semibold bg-stone-50 border border-stone-200 rounded-lg"
                                    />
                                    <button
                                      type="button"
                                      disabled={isLocked}
                                      onClick={() => stepField(item.id, 'added', 1)}
                                      aria-label={`Sumar surtido ${item.name}`}
                                      className="w-9 h-10 shrink-0 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 disabled:opacity-40 cursor-pointer"
                                    >
                                      <Plus className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Desktop Spacious Table */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th className="py-3.5 px-5 min-w-[210px]">Insumo</th>
                    {(isWorkerOpeningPhase || showOpeningDetails) && (
                      <>
                        <th className="py-3.5 px-3 text-center">Inicio del día</th>
                        <th className="py-3.5 px-3 text-center">Surtido (+)</th>
                      </>
                    )}
                    {isWorkerOpeningPhase ? (
                      <>
                        <th className="py-3.5 px-4 text-center">Opciones</th>
                        <th className="py-3.5 px-5 text-right">Total disponible</th>
                      </>
                    ) : (
                      <>
                        <th className="py-3.5 px-4 text-center">¿Cuánto quedó hoy? (Cierre)</th>
                        <th className="py-3.5 px-3 text-center">Opciones</th>
                        {showOpeningDetails && <th className="py-3.5 px-4 text-right">Consumo</th>}
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
                    const hasOpeningVal = row.hasOpening && !isNA;
                    const hasValue = row.hasClosing && !isNA;
                    const consumed =
                      hasOpeningVal && hasValue
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
                        className={`transition-colors ${isNA ? 'bg-stone-50/90' : 'hover:bg-stone-50/70'}`}
                      >
                        <td className="py-4 px-5">
                          <div className="text-base font-semibold text-stone-900">
                            {item.name}
                          </div>
                          <div className="text-xs text-stone-500 font-mono tabular-nums mt-0.5">
                            {item.unit} · Mínimo: {item.minStock}
                            {!isWorkerOpeningPhase && !showOpeningDetails && hasOpeningVal
                              ? ` · Base día: ${row.opening + row.added}`
                              : ''}
                          </div>
                          {rowAnomalies.length > 0 && (
                            <div className="inline-flex items-center gap-1 mt-1 text-xs font-medium text-amber-700">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                              <span>{rowAnomalies[0].message}</span>
                            </div>
                          )}
                        </td>

                        {(isWorkerOpeningPhase || showOpeningDetails) && (
                          <>
                            <td className="py-4 px-3">
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
                                  value={hasOpeningVal ? row.opening : ''}
                                  onChange={(e) =>
                                    handleNumberInput(
                                      item.id,
                                      'opening',
                                      e.target.value,
                                      e.target.validity.badInput,
                                    )
                                  }
                                  className="w-16 h-10 text-center font-mono tabular-nums text-sm font-medium bg-stone-50 border border-stone-200 rounded-lg placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white disabled:opacity-60"
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
                            </td>

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
                          </>
                        )}

                        {isWorkerOpeningPhase ? (
                          <>
                            <td className="py-4 px-3">
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => markZeroExplicit(item.id, 'opening')}
                                  className={`min-h-[36px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                                    hasOpeningVal && row.opening === 0
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
                                  className={`min-h-[36px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                                    isNA
                                      ? 'bg-stone-700 text-white border-stone-700'
                                      : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                                  }`}
                                >
                                  No aplica
                                </button>
                              </div>
                            </td>
                            <td className="py-4 px-5 text-right font-mono tabular-nums font-bold text-stone-900">
                              {isNA
                                ? 'No aplica'
                                : hasOpeningVal
                                  ? `${row.opening + row.added} ${item.unit}`
                                  : 'Por contar'}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="py-4 px-4">
                              <div className="flex items-center justify-center gap-1.5">
                                <motion.button
                                  whileTap={{ scale: 0.93 }}
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
                                  whileTap={{ scale: 0.93 }}
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

                            {showOpeningDetails && (
                              <td className="py-4 px-4 text-right font-mono tabular-nums text-stone-700">
                                {consumed !== null ? `${consumed} ${item.unit}` : '—'}
                              </td>
                            )}

                            <td className="py-4 px-5 whitespace-nowrap">
                              {isNA ? (
                                <span className="text-xs font-semibold text-stone-500">
                                  No aplica hoy
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

      {/* Notes & Primary Save Footer */}
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
                  className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-stone-800 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  Aceptar versión del servidor
                </button>
                <button
                  type="button"
                  disabled={savingMode !== null}
                  onClick={() =>
                    handleSave(pendingConflict.mode, {
                      forceOverwrite: true,
                      skipAnomalyCheck: true,
                    })
                  }
                  className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-white bg-red-700 rounded-xl hover:bg-red-800 disabled:opacity-50 cursor-pointer"
                >
                  Sobrescribir con mis conteos
                </button>
              </div>
            </div>
          )}

          {pendingAnomalyConfirm && !isLocked && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-amber-950">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold">
                    Verifica {pendingAnomalyConfirm.anomalies.length}{' '}
                    {pendingAnomalyConfirm.anomalies.length === 1 ? 'cantidad inusual' : 'cantidades inusuales'} antes de enviar
                  </p>
                  <ul className="text-xs text-amber-900 space-y-1 list-disc pl-4">
                    {pendingAnomalyConfirm.anomalies.slice(0, 5).map((a) => (
                      <li key={`${a.itemId}-${a.type}`}>
                        <strong>{a.itemName}:</strong> {a.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setPendingAnomalyConfirm(null)}
                  className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-stone-800 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  Revisar conteos
                </button>
                <button
                  type="button"
                  disabled={savingMode !== null}
                  onClick={() =>
                    handleSave(pendingAnomalyConfirm.mode, {
                      skipAnomalyCheck: true,
                    })
                  }
                  className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 disabled:opacity-50 cursor-pointer"
                >
                  Confirmar y enviar así
                </button>
              </div>
            </div>
          )}

          {!isLocked && !allAccounted && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
              <span>
                <strong>{countedCount} de {stationItems.length} contados.</strong> Faltan{' '}
                {missingCount} {missingCount === 1 ? 'insumo' : 'insumos'} para poder enviar.
              </span>
              <button
                type="button"
                onClick={() => {
                  setItemFilter('pendientes');
                  listSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className="font-bold text-orange-700 underline hover:text-orange-900 cursor-pointer"
              >
                Ver los {missingCount} faltantes
              </button>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-end gap-3">
            {isWorkerOpeningPhase ? (
              <button
                type="button"
                disabled={isLocked || savingMode !== null || !allAccounted}
                onClick={() => handleSave('opening')}
                className="min-h-[48px] inline-flex items-center justify-center gap-2 px-6 py-3 text-sm sm:text-base font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Save className="w-5 h-5" />
                {savingMode === 'opening'
                  ? 'Guardando apertura...'
                  : allAccounted
                    ? 'Guardar apertura y surtido'
                    : `Faltan ${missingCount} por contar`}
              </button>
            ) : (
              <>
                {(canManage || scheduleStatus.phase === 'unrestricted') && (
                  <button
                    type="button"
                    disabled={isLocked || savingMode !== null}
                    onClick={() => handleSave('opening')}
                    className="min-h-[48px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Save className="w-4 h-4" />
                    {savingMode === 'opening' ? 'Guardando avance...' : 'Guardar avance'}
                  </button>
                )}

                <button
                  type="button"
                  disabled={isLocked || savingMode !== null || !allAccounted}
                  onClick={() => handleSave('closing')}
                  className="min-h-[48px] inline-flex items-center justify-center gap-2 px-6 py-3 text-sm sm:text-base font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <CheckCircle2 className="w-5 h-5" />
                  {savingMode === 'closing'
                    ? 'Enviando cierre...'
                    : allAccounted
                      ? 'Enviar cierre del día al jefe'
                      : `Faltan ${missingCount} por contar`}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
