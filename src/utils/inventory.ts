import type { Timestamp } from 'firebase/firestore';
import { MAX_STOCK_VALUE } from '../constants';
import type {
  ConsolidatedItemRow,
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  StockLevel,
  Workstation,
} from '../types';
import {
  BOGOTA_TIME_ZONE,
  getOperationalDateStr,
  getPreviousDateStr,
} from './date';

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

export function getStockLevel(closingQty: number, minStock: number): StockLevel {
  if (closingQty <= 0) return 'agotado';
  if (closingQty <= minStock) return 'comprar';
  if (closingQty <= Math.ceil(minStock * 1.4)) return 'medio';
  return 'suficiente';
}

export function getSuggestedPurchase(currentQty: number, minStock: number, targetStock: number): number {
  if (currentQty > minStock) return 0;
  const goal = Math.max(targetStock, minStock * 2);
  return Math.max(0, Math.ceil(goal - currentQty));
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
      const qtyText = r.suggestedBuy > 0 ? `Pedir ${r.suggestedBuy} ${r.item.unit}` : 'Revisar reposición';
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

export function downloadDailyCsvReport(
  dateStr: string,
  rows: ConsolidatedItemRow[],
  stations: Workstation[],
): void {
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
  ];

  const csvRows = rows.map((r) => {
    const statusLabel = r.isNotApplicable
      ? 'No aplica'
      : r.isProvisional
        ? 'Provisional (solo apertura)'
        : getStockLevelMeta(r.stockLevel).label;

    return [
      dateStr,
      `"${(stationNameMap.get(r.item.station) ?? r.item.station).replace(/"/g, '""')}"`,
      `"${r.item.name.replace(/"/g, '""')}"`,
      `"${r.item.unit.replace(/"/g, '""')}"`,
      r.entry?.hasOpening && !r.isNotApplicable ? r.entry.opening : '',
      r.entry && !r.isNotApplicable ? r.entry.added : '',
      r.hasCountedClosing && r.currentStock !== null ? r.currentStock : '',
      r.consumed !== null ? r.consumed : '',
      r.item.minStock,
      `"${statusLabel}"`,
      r.hasCountedClosing ? r.suggestedBuy : 0,
    ];
  });

  const content = [headers.join(','), ...csvRows.map((row) => row.join(','))].join('\n');
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
