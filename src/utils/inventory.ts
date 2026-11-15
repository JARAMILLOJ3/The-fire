import type { Timestamp } from 'firebase/firestore';
import {
  LEVEL_STEPS,
  MAX_PACK_LABEL_LENGTH,
  MAX_PACK_SIZE,
  MAX_STOCK_VALUE,
  UNIT_OPTIONS,
  WORKER_GRACE_MINUTES,
} from '../constants';
import type {
  CaptureInputType,
  ConsolidatedItemRow,
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  ShiftSchedule,
  StationId,
  StockLevel,
  Workstation,
} from '../types';
import {
  BOGOTA_TIME_ZONE,
  getOperationalDateStr,
  getPreviousDateStr,
  shiftDateStr,
} from './date';
import { hasClosingDeadlinePassed } from './schedule';

export { getOperationalDateStr, getPreviousDateStr };

export function getTodayDateStr(now: Date = new Date()): string {
  return getOperationalDateStr(now);
}

export function formatDateHuman(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(dt);
}

export function formatTimeShort(ts?: Timestamp): string | null {
  if (!ts || typeof ts.toDate !== 'function') return null;
  try {
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: BOGOTA_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
    }).format(ts.toDate());
  } catch {
    return null;
  }
}

export function sanitizeStockQuantity(val: unknown): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.min(MAX_STOCK_VALUE, Math.round(num * 100) / 100);
}

export function parseQuantityInput(rawValue: string): {
  valid: boolean;
  value: number;
  empty: boolean;
  error?: string;
} {
  const normalized = rawValue.trim().replace(',', '.');
  if (normalized === '') {
    return { valid: true, value: 0, empty: true };
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized)) {
    return { valid: false, value: 0, empty: false, error: 'Ingresa un número válido.' };
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { valid: false, value: 0, empty: false, error: 'No se permiten valores negativos.' };
  }
  if (parsed > MAX_STOCK_VALUE) {
    return {
      valid: false,
      value: MAX_STOCK_VALUE,
      empty: false,
      error: `El máximo permitido es ${MAX_STOCK_VALUE}.`,
    };
  }
  return {
    valid: true,
    value: sanitizeStockQuantity(parsed),
    empty: false,
  };
}

export type EntryAnomalyType = 'closing_exceeds_available' | 'extreme_stock_spike';

export interface EntryAnomaly {
  itemId: string;
  itemName: string;
  unit: string;
  type: EntryAnomalyType;
  message: string;
}

export function detectEntryAnomalies(
  row: DraftEntryRow,
  mode: 'opening' | 'closing',
): EntryAnomaly[] {
  if (row.notApplicable) return [];
  const anomalies: EntryAnomaly[] = [];
  const spikeThreshold = Math.max(row.targetStock * 3, row.minStock * 5, 500);

  if (mode === 'closing' && row.hasClosing) {
    if (row.hasOpening) {
      const available = sanitizeStockQuantity(row.opening + row.added);
      if (row.closing > available) {
        anomalies.push({
          itemId: row.itemId,
          itemName: row.itemName,
          unit: row.unit,
          type: 'closing_exceeds_available',
          message: `Cierre (${row.closing}) mayor a inicio + surtido (${available} ${row.unit}). ¿Faltó anotar surtido?`,
        });
      }
    }
    if (row.closing > spikeThreshold) {
      anomalies.push({
        itemId: row.itemId,
        itemName: row.itemName,
        unit: row.unit,
        type: 'extreme_stock_spike',
        message: `Cantidad muy alta (${row.closing} ${row.unit}). Verifica si hubo un error de digitación.`,
      });
    }
  } else if (mode === 'opening' && row.hasOpening) {
    const totalAvailable = sanitizeStockQuantity(row.opening + row.added);
    if (totalAvailable > spikeThreshold) {
      anomalies.push({
        itemId: row.itemId,
        itemName: row.itemName,
        unit: row.unit,
        type: 'extreme_stock_spike',
        message: `Total disponible muy alto (${totalAvailable} ${row.unit}). Verifica si hubo un error de digitación.`,
      });
    }
  }

  return anomalies;
}

export function detectReportAnomalies(
  rows: DraftEntryRow[],
  mode: 'opening' | 'closing',
): EntryAnomaly[] {
  return rows.flatMap((row) => detectEntryAnomalies(row, mode));
}

export type OpeningRowState =
  | 'not_applicable'
  | 'pending_confirm'
  | 'uncounted'
  | 'confirmed'
  | 'adjusted'
  | 'manual';

export function computeOpeningStatusForValue(
  openingValue: number,
  previousClosing?: number,
): 'confirmed_match' | 'adjusted' | 'manual' {
  if (typeof previousClosing === 'number') {
    return openingValue === previousClosing ? 'confirmed_match' : 'adjusted';
  }
  return 'manual';
}

export function getOpeningRowState(row: DraftEntryRow | undefined): OpeningRowState {
  if (!row) return 'uncounted';
  if (row.notApplicable) return 'not_applicable';
  if (!row.hasOpening) {
    return typeof row.previousClosing === 'number' ? 'pending_confirm' : 'uncounted';
  }
  if (
    row.openingStatus === 'adjusted' ||
    (typeof row.previousClosing === 'number' && row.opening !== row.previousClosing)
  ) {
    return 'adjusted';
  }
  if (
    row.openingStatus === 'confirmed_match' ||
    (typeof row.previousClosing === 'number' && row.opening === row.previousClosing)
  ) {
    return 'confirmed';
  }
  return 'manual';
}

export function confirmPreloadedOpeningRow(row: DraftEntryRow): DraftEntryRow {
  const nextOpening =
    typeof row.previousClosing === 'number' && !row.hasOpening
      ? row.previousClosing
      : row.opening;
  return {
    ...row,
    opening: nextOpening,
    hasOpening: true,
    notApplicable: false,
    openingStatus: computeOpeningStatusForValue(nextOpening, row.previousClosing),
  };
}

export function confirmAllPendingOpeningRows(
  rows: Record<string, DraftEntryRow>,
  touched: Record<string, { opening?: boolean } | undefined>,
): { nextRows: Record<string, DraftEntryRow>; confirmedIds: string[] } {
  const nextRows: Record<string, DraftEntryRow> = { ...rows };
  const confirmedIds: string[] = [];

  Object.entries(rows).forEach(([itemId, row]) => {
    const isUntouched = !touched[itemId]?.opening;
    if (
      isUntouched &&
      !row.notApplicable &&
      !row.hasOpening &&
      typeof row.previousClosing === 'number'
    ) {
      nextRows[itemId] = {
        ...row,
        opening: row.previousClosing,
        hasOpening: true,
        openingStatus: 'confirmed_match',
      };
      confirmedIds.push(itemId);
    }
  });

  return { nextRows, confirmedIds };
}

export function hasTargetBelowMin(minStock: number, targetStock: number): boolean {
  return targetStock < minStock;
}

export function getStockLevel(closingQty: number, minStock: number): StockLevel {
  if (closingQty <= 0) return 'agotado';
  if (closingQty <= minStock) return 'comprar';
  if (closingQty <= Math.ceil(minStock * 1.4)) return 'medio';
  return 'suficiente';
}

export function getSuggestedPurchase(currentQty: number, minStock: number, targetStock: number): number {
  if (currentQty > minStock) return 0;
  if (minStock === 0 && currentQty <= 0) {
    return Math.max(1, Math.ceil(targetStock - currentQty));
  }
  return Math.max(0, Math.ceil(targetStock - currentQty));
}

export const LEVEL_STEP_LABELS = [
  '0',
  '⅛',
  '¼',
  '⅜',
  '½',
  '⅝',
  '¾',
  '⅞',
  'Lleno',
] as const;

const INVARIANT_ABBREVIATIONS = new Set(['und', 'ud', 'kg', 'g', 'gr', 'l', 'lt', 'ml', 'lb', 'oz']);

export function pluralizeSpanishLabel(label: string, count: number): string {
  const clean = label.trim();
  if (!clean) return '';
  if (Math.abs(count) === 1) return clean;

  const lower = clean.toLocaleLowerCase('es');
  if (INVARIANT_ABBREVIATIONS.has(lower)) return clean;
  if (lower.endsWith('s') || lower.endsWith('x')) return clean;
  if (lower.endsWith('z')) return `${clean.slice(0, -1)}ces`;
  if (lower.endsWith('ción')) return `${clean.slice(0, -4)}ciones`;
  if (/[aeiouáéíóú]$/i.test(clean)) return `${clean}s`;
  return `${clean}es`;
}

function capitalizeWord(word: string): string {
  if (!word) return '';
  return word.charAt(0).toLocaleUpperCase('es') + word.slice(1);
}

export function getItemInputType(
  item: Pick<InventoryItem, 'inputType' | 'packSize' | 'capacity'>,
): CaptureInputType {
  if (item.inputType === 'packs') return 'packs';
  if (item.inputType === 'level') return 'level';
  return 'count';
}

export function getPacksFieldLabels(
  item: Pick<InventoryItem, 'packLabel' | 'unitLabel' | 'unit'>,
): {
  packSingular: string;
  packPlural: string;
  unitSingular: string;
  unitPlural: string;
  packsFieldLabel: string;
  looseFieldLabel: string;
} {
  const packSingular = item.packLabel?.trim() || 'paquete';
  const packPlural = pluralizeSpanishLabel(packSingular, 2);
  const unitSingular = item.unitLabel?.trim() || item.unit?.trim() || 'und';
  const unitPlural = pluralizeSpanishLabel(unitSingular, 2);

  const lowerUnit = unitSingular.toLocaleLowerCase('es');
  const isFeminine = /(a|ción|dad|tad|ud|und)$/i.test(lowerUnit);
  const looseWord = isFeminine ? 'sueltas' : 'sueltos';
  const looseBase =
    lowerUnit === 'und' ? 'Unidades' : capitalizeWord(unitPlural);

  return {
    packSingular,
    packPlural,
    unitSingular,
    unitPlural,
    packsFieldLabel: capitalizeWord(packPlural),
    looseFieldLabel: `${looseBase} ${looseWord}`,
  };
}

export function computePacksTotal(packs: number, loose: number, packSize: number): number {
  const safePacks = Number.isFinite(packs) ? Math.max(0, Math.floor(packs)) : 0;
  const safeLoose = Number.isFinite(loose) ? Math.max(0, loose) : 0;
  const safeSize = Number.isFinite(packSize) ? Math.max(2, Math.floor(packSize)) : 2;
  return sanitizeStockQuantity(safePacks * safeSize + safeLoose);
}

export function splitTotalToPacks(
  total: number,
  packSize: number,
): { packs: number; loose: number } {
  const safeTotal = sanitizeStockQuantity(total);
  const safeSize = Number.isFinite(packSize) ? Math.max(2, Math.floor(packSize)) : 2;
  let packs = Math.floor(safeTotal / safeSize);
  let loose = Math.round((safeTotal - packs * safeSize) * 100) / 100;
  if (loose >= safeSize) {
    packs += Math.floor(loose / safeSize);
    loose = Math.round((loose % safeSize) * 100) / 100;
  }
  return { packs, loose };
}

export function computeLevelTotal(stepIndex: number, capacity: number): number {
  const safeStep = Number.isFinite(stepIndex)
    ? Math.max(0, Math.min(LEVEL_STEPS, Math.round(stepIndex)))
    : 0;
  const safeCapacity = Number.isFinite(capacity) ? Math.max(0, capacity) : 0;
  return sanitizeStockQuantity((safeStep / LEVEL_STEPS) * safeCapacity);
}

export function snapQuantityToLevelStep(value: number, capacity: number): number {
  if (!Number.isFinite(capacity) || capacity <= 0) return 0;
  const safeVal = Math.max(0, Number.isFinite(value) ? value : 0);
  const ratio = Math.min(1, safeVal / capacity);
  return Math.max(0, Math.min(LEVEL_STEPS, Math.round(ratio * LEVEL_STEPS)));
}

export function formatSpanishDecimal(value: number, maxDecimals = 2): string {
  const rounded = Math.round(value * 10 ** maxDecimals) / 10 ** maxDecimals;
  return new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  }).format(rounded);
}

export function formatLevelApproximate(value: number, unit: string): string {
  const safeVal = Math.max(0, Number.isFinite(value) ? value : 0);
  if (safeVal === 0) return `0 ${unit}`;
  const oneDecimal = Math.round(safeVal * 10) / 10;
  const maxDecimals =
    safeVal < 0.1 || Math.abs(safeVal - oneDecimal) >= 0.03 ? 2 : 1;
  return `≈ ${formatSpanishDecimal(safeVal, maxDecimals)} ${unit}`;
}

export function formatPreviousClosingForItem(
  previousClosing: number,
  item: Pick<InventoryItem, 'inputType' | 'packSize' | 'packLabel' | 'unitLabel' | 'capacity' | 'unit'>,
): string {
  const inputType = getItemInputType(item);
  if (inputType === 'packs' && typeof item.packSize === 'number' && item.packSize > 1) {
    const { packs, loose } = splitTotalToPacks(previousClosing, item.packSize);
    const packLabel = pluralizeSpanishLabel(item.packLabel?.trim() || 'paquete', packs);
    const unitBase = item.unitLabel?.trim() || item.unit;
    const totalLabel = `${formatSpanishDecimal(previousClosing, 2)} ${pluralizeSpanishLabel(unitBase, previousClosing)}`;
    if (loose > 0) {
      const looseLabel = pluralizeSpanishLabel(unitBase, loose);
      return `${packs} ${packLabel} + ${formatSpanishDecimal(loose, 2)} ${looseLabel} (${totalLabel})`;
    }
    return `${packs} ${packLabel} (${totalLabel})`;
  }

  if (inputType === 'level' && typeof item.capacity === 'number' && item.capacity > 0) {
    const step = snapQuantityToLevelStep(previousClosing, item.capacity);
    const mark = LEVEL_STEP_LABELS[step] ?? '0';
    return `${mark} (${formatLevelApproximate(previousClosing, item.unit)})`;
  }

  return `${formatSpanishDecimal(previousClosing, 2)} ${item.unit}`;
}

export interface PacksPurchaseSummary {
  packs: number;
  equivalentUnits: number;
  packLabelFormatted: string;
  unitLabelFormatted: string;
  text: string;
}

export function getPacksPurchaseSummary(
  suggestedUnits: number,
  item: Pick<InventoryItem, 'inputType' | 'packSize' | 'packLabel' | 'unitLabel' | 'unit'>,
): PacksPurchaseSummary | null {
  if (getItemInputType(item) !== 'packs') return null;
  if (!Number.isFinite(suggestedUnits) || suggestedUnits <= 0) return null;
  const packSize = item.packSize;
  if (!Number.isFinite(packSize) || !packSize || packSize <= 1) return null;

  const packs = Math.ceil(suggestedUnits / packSize);
  const equivalentUnits = sanitizeStockQuantity(packs * packSize);
  const packLabelFormatted = pluralizeSpanishLabel(item.packLabel?.trim() || 'paquete', packs);
  const unitBase = item.unitLabel?.trim() || item.unit || 'und';
  const unitLabelFormatted = pluralizeSpanishLabel(unitBase, equivalentUnits);

  return {
    packs,
    equivalentUnits,
    packLabelFormatted,
    unitLabelFormatted,
    text: `Comprar: ${packs} ${packLabelFormatted} (${formatSpanishDecimal(equivalentUnits, 2)} ${unitLabelFormatted})`,
  };
}

export function normalizeCatalogItemName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

export interface CatalogItemValidationResult {
  valid: boolean;
  error: string | null;
  warning: string | null;
}

export function validateCatalogItemInput(params: {
  name: string;
  unit: string;
  station: StationId;
  minStock: number;
  targetStock: number;
  inputType?: CaptureInputType;
  packSize?: number;
  packLabel?: string;
  unitLabel?: string;
  capacity?: number;
  existingItems: InventoryItem[];
  editingItemId?: string;
}): CatalogItemValidationResult {
  const cleanName = params.name.trim();
  const cleanUnit = params.unit.trim();
  const inputType: CaptureInputType = params.inputType ?? 'count';

  if (!cleanName) {
    return { valid: false, error: 'Escribe el nombre del insumo.', warning: null };
  }
  if (!cleanUnit) {
    return {
      valid: false,
      error: 'La unidad de medida es obligatoria (ej: und, kg, paq).',
      warning: null,
    };
  }
  if (!Number.isFinite(params.minStock) || params.minStock < 0) {
    return { valid: false, error: 'El stock mínimo no puede ser negativo.', warning: null };
  }
  if (!Number.isFinite(params.targetStock) || params.targetStock < 0) {
    return { valid: false, error: 'El stock ideal no puede ser negativo.', warning: null };
  }

  if (inputType === 'packs') {
    const cleanPackLabel = (params.packLabel ?? '').trim();
    const cleanUnitLabel = (params.unitLabel ?? '').trim();

    if (!cleanPackLabel) {
      return {
        valid: false,
        error: 'Escribe cómo se llama el paquete (ej: paquete, kilo, caja, bolsa).',
        warning: null,
      };
    }
    if (cleanPackLabel.length > MAX_PACK_LABEL_LENGTH) {
      return {
        valid: false,
        error: `El nombre del paquete no puede superar ${MAX_PACK_LABEL_LENGTH} caracteres.`,
        warning: null,
      };
    }
    if (!cleanUnitLabel) {
      return {
        valid: false,
        error: 'Escribe cómo se llama la unidad suelta (ej: pan, loncha, und).',
        warning: null,
      };
    }
    if (cleanUnitLabel.length > MAX_PACK_LABEL_LENGTH) {
      return {
        valid: false,
        error: `El nombre de la unidad suelta no puede superar ${MAX_PACK_LABEL_LENGTH} caracteres.`,
        warning: null,
      };
    }
    if (
      typeof params.packSize !== 'number' ||
      !Number.isFinite(params.packSize) ||
      !Number.isInteger(params.packSize) ||
      params.packSize <= 1 ||
      params.packSize > MAX_PACK_SIZE
    ) {
      return {
        valid: false,
        error: 'La cantidad por paquete debe ser un número entero mayor a 1.',
        warning: null,
      };
    }
  } else if (inputType === 'level') {
    if (
      typeof params.capacity !== 'number' ||
      !Number.isFinite(params.capacity) ||
      params.capacity <= 0 ||
      params.capacity > MAX_STOCK_VALUE
    ) {
      return {
        valid: false,
        error: 'La capacidad total del envase lleno debe ser mayor a 0.',
        warning: null,
      };
    }
  }

  const normalizedName = normalizeCatalogItemName(cleanName);
  const duplicate = params.existingItems.find(
    (it) =>
      it.active &&
      it.station === params.station &&
      it.id !== params.editingItemId &&
      normalizeCatalogItemName(it.name) === normalizedName,
  );
  if (duplicate) {
    return {
      valid: false,
      error: `Ya existe un insumo activo llamado "${duplicate.name}" en este puesto.`,
      warning: null,
    };
  }

  const warning = hasTargetBelowMin(params.minStock, params.targetStock)
    ? `El stock ideal (${params.targetStock}) es menor que el stock mínimo (${params.minStock}). Ajusta el stock ideal para calcular compras completas.`
    : null;

  return { valid: true, error: null, warning };
}

export interface StationItemDraft {
  id?: string;
  name: string;
  unit: string;
  minStock: number;
  targetStock: number;
  inputType: CaptureInputType;
  packSizeInput: string;
  packLabel: string;
  unitLabel: string;
  capacityInput: string;
}

export interface PreparedStationItemPayload {
  id?: string;
  name: string;
  unit: string;
  minStock: number;
  targetStock: number;
  inputType: CaptureInputType;
  packSize?: number;
  packLabel?: string;
  unitLabel?: string;
  capacity?: number;
}

export function getUnitSelectOptions(): Array<{ value: string; label: string }> {
  return UNIT_OPTIONS.map((unit) => ({
    value: unit,
    label: unit === 'L' ? 'L (litros)' : unit === 'kg' ? 'kg (kilos)' : unit,
  }));
}

export function parseCaptureDecimalInput(rawValue: string): number {
  const normalized = rawValue.trim().replace(',', '.');
  if (!normalized) return Number.NaN;
  return Number(normalized);
}

export function buildItemCaptureFields(draft: {
  inputType: CaptureInputType;
  packSizeInput: string;
  packLabel: string;
  unitLabel: string;
  capacityInput: string;
}): {
  inputType: CaptureInputType;
  packSize?: number;
  packLabel?: string;
  unitLabel?: string;
  capacity?: number;
} {
  if (draft.inputType === 'packs') {
    return {
      inputType: 'packs',
      packSize: parseCaptureDecimalInput(draft.packSizeInput),
      packLabel: draft.packLabel.trim(),
      unitLabel: draft.unitLabel.trim(),
    };
  }
  if (draft.inputType === 'level') {
    return {
      inputType: 'level',
      capacity: parseCaptureDecimalInput(draft.capacityInput),
    };
  }
  return { inputType: 'count' };
}

export function createDefaultStationItemDraft(
  overrides: Partial<StationItemDraft> = {},
): StationItemDraft {
  return {
    name: '',
    unit: 'und',
    minStock: 5,
    targetStock: 15,
    inputType: 'count',
    packSizeInput: '8',
    packLabel: 'paquete',
    unitLabel: 'und',
    capacityInput: '5',
    ...overrides,
  };
}

export function inventoryItemToDraft(item: InventoryItem): StationItemDraft {
  return {
    id: item.id,
    name: item.name,
    unit: item.unit,
    minStock: item.minStock,
    targetStock: item.targetStock,
    inputType: getItemInputType(item),
    packSizeInput: typeof item.packSize === 'number' ? String(item.packSize) : '8',
    packLabel: item.packLabel ?? 'paquete',
    unitLabel: item.unitLabel ?? (item.unit || 'und'),
    capacityInput: typeof item.capacity === 'number' ? String(item.capacity) : '5',
  };
}

export interface StationDraftItemsValidationResult {
  valid: boolean;
  error: string | null;
  warning: string | null;
  preparedItems: PreparedStationItemPayload[];
}

export function validateStationItemsDraft(params: {
  drafts: StationItemDraft[];
  stationId: StationId;
}): StationDraftItemsValidationResult {
  const preparedItems: PreparedStationItemPayload[] = [];
  const accumulatedActiveItems: InventoryItem[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < params.drafts.length; i++) {
    const row = params.drafts[i];
    const cleanName = row.name.trim();

    if (!cleanName) {
      if (row.id) {
        return {
          valid: false,
          error: 'Escribe el nombre de cada insumo existente o quítalo de la lista.',
          warning: null,
          preparedItems: [],
        };
      }
      continue;
    }

    const captureFields = buildItemCaptureFields(row);
    const check = validateCatalogItemInput({
      name: cleanName,
      unit: row.unit,
      station: params.stationId,
      minStock: row.minStock,
      targetStock: row.targetStock,
      inputType: captureFields.inputType,
      packSize: captureFields.packSize,
      packLabel: captureFields.packLabel,
      unitLabel: captureFields.unitLabel,
      capacity: captureFields.capacity,
      existingItems: accumulatedActiveItems,
      editingItemId: row.id,
    });

    if (!check.valid) {
      return {
        valid: false,
        error: `${cleanName}: ${check.error ?? 'Revisa los datos del insumo.'}`,
        warning: null,
        preparedItems: [],
      };
    }

    if (check.warning) {
      warnings.push(`${cleanName}: ${check.warning}`);
    }

    const prepared: PreparedStationItemPayload = {
      ...(row.id ? { id: row.id } : {}),
      name: cleanName,
      unit: row.unit.trim(),
      minStock: row.minStock,
      targetStock: row.targetStock,
      ...captureFields,
    };
    preparedItems.push(prepared);

    accumulatedActiveItems.push({
      id: row.id ?? `draft_${i}`,
      workspaceId: '',
      ownerUid: '',
      authorizedEmails: [],
      station: params.stationId,
      name: prepared.name,
      unit: prepared.unit,
      minStock: prepared.minStock,
      targetStock: prepared.targetStock,
      inputType: prepared.inputType,
      packSize: prepared.packSize,
      packLabel: prepared.packLabel,
      unitLabel: prepared.unitLabel,
      capacity: prepared.capacity,
      active: true,
      sortOrder: (i + 1) * 10,
    });
  }

  return {
    valid: true,
    error: null,
    warning: warnings.length > 0 ? warnings[0] : null,
    preparedItems,
  };
}

export function getStockLevelMeta(level: StockLevel): {
  label: string;
  textClass: string;
  bgClass: string;
  borderClass: string;
} {
  switch (level) {
    case 'agotado':
      return {
        label: 'Agotado',
        textClass: 'text-red-700',
        bgClass: 'bg-red-50',
        borderClass: 'border-red-200',
      };
    case 'comprar':
      return {
        label: 'Comprar',
        textClass: 'text-red-700',
        bgClass: 'bg-red-50',
        borderClass: 'border-red-200',
      };
    case 'medio':
      return {
        label: 'Pronto a acabarse',
        textClass: 'text-amber-700',
        bgClass: 'bg-amber-50',
        borderClass: 'border-amber-200',
      };
    case 'suficiente':
      return {
        label: 'Suficiente',
        textClass: 'text-emerald-700',
        bgClass: 'bg-emerald-50',
        borderClass: 'border-emerald-200',
      };
    case 'sin_dato':
      return {
        label: 'Pendiente de contar',
        textClass: 'text-stone-600',
        bgClass: 'bg-stone-100',
        borderClass: 'border-stone-200',
      };
  }
}

export function buildConsolidatedRows(
  items: InventoryItem[],
  entriesByItemId: Record<string, DailyReportEntry>,
  reportsByStation: Record<string, DailyReport | undefined>,
): ConsolidatedItemRow[] {
  return items
    .filter((item) => item.active)
    .map((item) => {
      const entry = entriesByItemId[item.id] ?? null;
      const report = reportsByStation[item.station];
      const reportStatus = report?.status ?? 'open';
      const isStationCompleted = reportStatus === 'completed';
      const isNotApplicable = Boolean(entry?.notApplicable);
      const hasCountedClosing = isStationCompleted && Boolean(entry?.hasClosing) && !isNotApplicable;
      const hasProvisionalOpening = Boolean(entry?.hasOpening) && !isNotApplicable && !hasCountedClosing;
      const provisionalStock = hasProvisionalOpening && entry ? entry.opening + entry.added : null;

      if (!hasCountedClosing || !entry) {
        return {
          item,
          entry,
          reportStatus,
          currentStock: null,
          hasCountedClosing: false,
          isProvisional: hasProvisionalOpening,
          isNotApplicable,
          provisionalStock,
          consumed: null,
          stockLevel: 'sin_dato' as StockLevel,
          suggestedBuy: 0,
        };
      }

      const currentStock = entry.closing;
      const consumed = entry.hasOpening
        ? Math.max(0, entry.opening + entry.added - entry.closing)
        : null;
      const stockLevel = getStockLevel(currentStock, item.minStock);
      const suggestedBuy = getSuggestedPurchase(currentStock, item.minStock, item.targetStock);

      return {
        item,
        entry,
        reportStatus,
        currentStock,
        hasCountedClosing: true,
        isProvisional: false,
        isNotApplicable: false,
        provisionalStock: null,
        consumed,
        stockLevel,
        suggestedBuy,
      };
    });
}

export function buildWhatsAppShoppingList(
  dateStr: string,
  rows: ConsolidatedItemRow[],
  stations: Workstation[],
): string {
  const anyCompleted = rows.some((r) => r.hasCountedClosing);
  const toBuy = rows.filter(
    (r) => r.hasCountedClosing && (r.stockLevel === 'agotado' || r.stockLevel === 'comprar'),
  );
  const lowSoon = rows.filter((r) => r.hasCountedClosing && r.stockLevel === 'medio');

  if (!anyCompleted) {
    return `The Fire Inventario (${formatDateHuman(dateStr)}): Aún no hay cierres completados para generar lista de compras.`;
  }

  if (toBuy.length === 0 && lowSoon.length === 0) {
    return `The Fire Inventario (${formatDateHuman(dateStr)}): Todo con stock suficiente en los puestos cerrados. No hay compras urgentes.`;
  }

  const lines: string[] = [`*The Fire Inventario — Lista de compras (${formatDateHuman(dateStr)})*`, ''];

  stations.forEach((station) => {
    const stationRows = toBuy.filter((r) => r.item.station === station.id);
    if (stationRows.length === 0) return;
    lines.push(`*${station.name}* (${station.workerName})`);
    stationRows.forEach((r) => {
      const packsSummary = getPacksPurchaseSummary(r.suggestedBuy, r.item);
      const qtyText = packsSummary
        ? packsSummary.text
        : r.suggestedBuy > 0
          ? `Pedir ${r.suggestedBuy} ${r.item.unit}`
          : 'Revisar reposición';
      lines.push(`- ${r.item.name}: queda ${r.currentStock} ${r.item.unit} (${qtyText})`);
    });
    lines.push('');
  });

  if (lowSoon.length > 0) {
    lines.push('*Pronto a acabarse (Vigilar):*');
    lowSoon.forEach((r) => {
      const stName = stations.find((s) => s.id === r.item.station)?.name ?? r.item.station;
      lines.push(`- ${r.item.name} (${stName}): queda ${r.currentStock} ${r.item.unit}`);
    });
  }

  return lines.join('\n').trim();
}

const CSV_FORMULA_PREFIX_PATTERN = /^[\t\r ]*[=+\-@]|^[\t\r]/;

export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const raw = String(value);
  const safe = CSV_FORMULA_PREFIX_PATTERN.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildDailyCsvContent(
  dateStr: string,
  rows: ConsolidatedItemRow[],
  stations: Workstation[],
): string {
  const stationNameMap = new Map(stations.map((s) => [s.id, s.name]));
  const headers = [
    'Fecha',
    'Puesto',
    'Insumo',
    'Unidad',
    'Inicio',
    'Surtido',
    'Cierre',
    'Consumo',
    'Minimo',
    'Estado',
    'SugeridoComprar',
  ].map(escapeCsvCell);

  const csvRows = rows.map((r) => {
    const statusLabel = r.isNotApplicable
      ? 'No aplica'
      : r.isProvisional
        ? 'Provisional (solo apertura)'
        : getStockLevelMeta(r.stockLevel).label;

    return [
      escapeCsvCell(dateStr),
      escapeCsvCell(stationNameMap.get(r.item.station) ?? r.item.station),
      escapeCsvCell(r.item.name),
      escapeCsvCell(r.item.unit),
      escapeCsvCell(r.entry?.hasOpening && !r.isNotApplicable ? r.entry.opening : ''),
      escapeCsvCell(r.entry && !r.isNotApplicable ? r.entry.added : ''),
      escapeCsvCell(r.hasCountedClosing && r.currentStock !== null ? r.currentStock : ''),
      escapeCsvCell(r.consumed !== null ? r.consumed : ''),
      escapeCsvCell(r.item.minStock),
      escapeCsvCell(statusLabel),
      escapeCsvCell(r.hasCountedClosing ? r.suggestedBuy : 0),
    ];
  });

  return [headers.join(','), ...csvRows.map((row) => row.join(','))].join('\n');
}

export function downloadDailyCsvReport(
  dateStr: string,
  rows: ConsolidatedItemRow[],
  stations: Workstation[],
): void {
  const content = buildDailyCsvContent(dateStr, rows, stations);
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `the_fire_inventario_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export interface WeeklyStationDayCell {
  date: string;
  status: 'completed' | 'opening_saved' | 'open';
  isLate: boolean;
  anomalyCount: number;
  lowStockCount: number;
}

export interface WeeklyStationHistoryRow {
  station: Workstation;
  days: WeeklyStationDayCell[];
  completedCount: number;
  lateCount: number;
}

export interface WeeklyStationHistoryResult {
  dates: string[];
  rows: WeeklyStationHistoryRow[];
}

export function buildWeeklyStationHistory(params: {
  endDateStr: string;
  stations: Workstation[];
  items: InventoryItem[];
  allReports: DailyReport[];
  entriesByReportId: Record<string, Record<string, DailyReportEntry>>;
  schedule?: ShiftSchedule;
  now?: Date;
}): WeeklyStationHistoryResult {
  const {
    endDateStr,
    stations,
    items,
    allReports,
    entriesByReportId,
    schedule,
    now = new Date(),
  } = params;

  const dates = Array.from({ length: 7 }, (_, idx) => shiftDateStr(endDateStr, idx - 6));
  const reportByDateAndStation = new Map<string, DailyReport>();
  allReports.forEach((rep) => {
    reportByDateAndStation.set(`${rep.date}|${rep.station}`, rep);
  });

  const activeItemsByStation = new Map<string, InventoryItem[]>();
  items
    .filter((it) => it.active)
    .forEach((it) => {
      const list = activeItemsByStation.get(it.station) ?? [];
      list.push(it);
      activeItemsByStation.set(it.station, list);
    });

  const rows: WeeklyStationHistoryRow[] = stations.map((station) => {
    const stationItems = activeItemsByStation.get(station.id) ?? [];
    let completedCount = 0;
    let lateCount = 0;

    const days: WeeklyStationDayCell[] = dates.map((date) => {
      const rep = reportByDateAndStation.get(`${date}|${station.id}`);
      const status = rep?.status ?? 'open';
      const isLate =
        status !== 'completed' &&
        hasClosingDeadlinePassed(now, date, schedule, WORKER_GRACE_MINUTES);

      if (status === 'completed') completedCount += 1;
      if (isLate) lateCount += 1;

      const entries = rep ? entriesByReportId[rep.id] : undefined;
      let anomalyCount = 0;
      let lowStockCount = 0;

      if (entries) {
        stationItems.forEach((item) => {
          const entry = entries[item.id];
          if (!entry || entry.notApplicable) return;
          if (entry.hasOpening && entry.hasClosing) {
            const available = sanitizeStockQuantity(entry.opening + entry.added);
            if (entry.closing > available) {
              anomalyCount += 1;
            }
          }
          if (status === 'completed' && entry.hasClosing) {
            const lvl = getStockLevel(entry.closing, item.minStock);
            if (lvl === 'agotado' || lvl === 'comprar') {
              lowStockCount += 1;
            }
          }
        });
      }

      return {
        date,
        status,
        isLate,
        anomalyCount,
        lowStockCount,
      };
    });

    return {
      station,
      days,
      completedCount,
      lateCount,
    };
  });

  return { dates, rows };
}

export type DashboardConsumptionAnomalyKind =
  | 'closing_exceeds_available'
  | 'above_average_consumption';

export interface DashboardConsumptionAnomaly {
  itemId: string;
  itemName: string;
  unit: string;
  stationId: StationId;
  stationName: string;
  kind: DashboardConsumptionAnomalyKind;
  opening: number;
  added: number;
  closing: number;
  consumed: number;
  averageConsumed?: number;
  ratioToAverage?: number;
  sampleDays?: number;
  summary: string;
}

export function detectDashboardConsumptionAnomalies(params: {
  selectedDate: string;
  rows: ConsolidatedItemRow[];
  stations: Workstation[];
  allReports: DailyReport[];
  entriesByReportId: Record<string, Record<string, DailyReportEntry>>;
}): DashboardConsumptionAnomaly[] {
  const { selectedDate, rows, stations, allReports, entriesByReportId } = params;
  const stationNameMap = new Map(stations.map((s) => [s.id, s.name]));
  const minLookbackDate = shiftDateStr(selectedDate, -7);

  const priorCompletedReports = allReports.filter(
    (rep) =>
      rep.status === 'completed' &&
      rep.date < selectedDate &&
      rep.date >= minLookbackDate,
  );

  const anomalies: DashboardConsumptionAnomaly[] = [];

  rows.forEach((row) => {
    const entry = row.entry;
    if (!entry || entry.notApplicable || !entry.hasClosing) return;

    const stationName = stationNameMap.get(row.item.station) ?? row.item.station;
    const available = sanitizeStockQuantity(entry.opening + entry.added);

    if (entry.hasOpening && entry.closing > available) {
      const excess = sanitizeStockQuantity(entry.closing - available);
      anomalies.push({
        itemId: row.item.id,
        itemName: row.item.name,
        unit: row.item.unit,
        stationId: row.item.station,
        stationName,
        kind: 'closing_exceeds_available',
        opening: entry.opening,
        added: entry.added,
        closing: entry.closing,
        consumed: 0,
        summary: `Cierre (${entry.closing} ${row.item.unit}) mayor que inicio + surtido (${available} ${row.item.unit}). Sobra +${excess} ${row.item.unit}.`,
      });
      return;
    }

    if (!row.hasCountedClosing || !entry.hasOpening || row.consumed === null || row.consumed <= 0) {
      return;
    }

    const priorSamples: number[] = [];
    priorCompletedReports.forEach((rep) => {
      if (rep.station !== row.item.station) return;
      const prevEntry = entriesByReportId[rep.id]?.[row.item.id];
      if (!prevEntry || prevEntry.notApplicable || !prevEntry.hasOpening || !prevEntry.hasClosing) {
        return;
      }
      const prevAvailable = sanitizeStockQuantity(prevEntry.opening + prevEntry.added);
      if (prevEntry.closing <= prevAvailable) {
        priorSamples.push(sanitizeStockQuantity(prevAvailable - prevEntry.closing));
      }
    });

    if (priorSamples.length >= 2) {
      const avg = priorSamples.reduce((sum, val) => sum + val, 0) / priorSamples.length;
      const roundedAvg = Math.round(avg * 10) / 10;
      if (avg > 0 && row.consumed >= avg * 1.8 && row.consumed - avg >= 2) {
        const ratio = Math.round((row.consumed / avg) * 10) / 10;
        anomalies.push({
          itemId: row.item.id,
          itemName: row.item.name,
          unit: row.item.unit,
          stationId: row.item.station,
          stationName,
          kind: 'above_average_consumption',
          opening: entry.opening,
          added: entry.added,
          closing: entry.closing,
          consumed: row.consumed,
          averageConsumed: roundedAvg,
          ratioToAverage: ratio,
          sampleDays: priorSamples.length,
          summary: `Consumo de ${row.consumed} ${row.item.unit} (${ratio}x su promedio de ${roundedAvg} ${row.item.unit} en ${priorSamples.length} días).`,
        });
      }
    }
  });

  return anomalies;
}

export interface StationSaveErrorInfo {
  title: string;
  detail: string;
  code?: string;
}

export function formatStationSaveError(
  error: unknown,
  context: {
    schedulePhase?: 'opening' | 'closing' | 'outside' | 'unrestricted';
    inGracePeriod?: boolean;
    isOnline?: boolean;
  } = {},
): StationSaveErrorInfo {
  let code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;

  let rawMessage = error instanceof Error ? error.message : String(error ?? '');

  if (rawMessage.startsWith('{') && rawMessage.includes('"error"')) {
    try {
      const parsed = JSON.parse(rawMessage) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        rawMessage = parsed.error;
      }
    } catch {
      // Keep original message if not valid JSON
    }
  }

  const lower = rawMessage.toLowerCase();
  if (!code) {
    if (lower.includes('permission') || lower.includes('insufficient')) {
      code = 'permission-denied';
    } else if (lower.includes('unauthenticated')) {
      code = 'unauthenticated';
    } else if (lower.includes('unavailable') || lower.includes('offline')) {
      code = 'unavailable';
    } else if (lower.includes('deadline')) {
      code = 'deadline-exceeded';
    }
  }

  if (
    context.isOnline === false ||
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    lower.includes('offline') ||
    lower.includes('network')
  ) {
    return {
      title: 'Sin conexión estable con el servidor',
      detail:
        'Revisa tu señal de internet e intenta enviar de nuevo. Tu borrador sigue guardado en este dispositivo.',
      code: code ?? 'unavailable',
    };
  }

  if (code === 'unauthenticated') {
    return {
      title: 'Tu sesión de Google venció',
      detail:
        'Cierra este aviso e inicia sesión otra vez con tu cuenta de Google para poder enviar el inventario. Tu borrador no se perdió.',
      code,
    };
  }

  if (code === 'permission-denied') {
    if (context.schedulePhase === 'outside') {
      return {
        title: 'Fuera del horario permitido',
        detail:
          'El horario del turno ya terminó (hora de Colombia). Pídele al jefe revisar o guardar el registro. Tu borrador sigue guardado aquí.',
        code,
      };
    }

    if (context.inGracePeriod) {
      return {
        title: 'Horario terminado o cierre ya bloqueado',
        detail:
          'Puede que los minutos de tolerancia se hayan cumplido justo al enviar, o que el cierre ya estuviera guardado. Pídele al jefe revisar la planilla.',
        code,
      };
    }

    return {
      title: 'Permiso rechazado al guardar en el servidor',
      detail:
        'Firebase rechazó el envío (puede ser cierre ya bloqueado, algún insumo desactualizado respecto al catálogo del jefe o acceso del puesto revocado). Recarga la página o avísale al jefe; tu borrador sigue guardado aquí.',
      code,
    };
  }

  return {
    title: 'No se pudo guardar el inventario',
    detail:
      'Ocurrió un error al enviar al servidor. Tu borrador sigue guardado en este dispositivo; intenta de nuevo en unos segundos.',
    code,
  };
}

