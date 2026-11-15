import type {
  DailyReport,
  DailyReportEntry,
  InventoryItem,
  Workstation,
} from '../types';
import {
  escapeCsvCell,
  getEffectiveItemUnit,
  getItemInputType,
  sanitizeStockQuantity,
} from './inventory';
import { chunkArrayWithLimit, MAX_BATCH_SIZE } from './batch';

export type ResetScope = 'reports_only' | 'all';

export type ResetTargetCategory =
  | 'entries'
  | 'reports'
  | 'items'
  | 'stationLinks'
  | 'stations'
  | 'invites'
  | 'teamMembers';

export interface ResetTaskItem {
  category: ResetTargetCategory;
  path: string;
  label: string;
}

export interface ResetExecutionProgress {
  totalCount: number;
  deletedCount: number;
  completedBatches: number;
  totalBatches: number;
  currentCategory: ResetTargetCategory | null;
  currentStepLabel: string;
}

export const MAX_RESET_BATCH_SIZE = MAX_BATCH_SIZE;
export const RESET_CONFIRMATION_WORD = 'REINICIAR';

export const RESET_CATEGORY_ORDER: readonly ResetTargetCategory[] = [
  'entries',
  'reports',
  'items',
  'stationLinks',
  'stations',
  'invites',
  'teamMembers',
];

export const RESET_CATEGORY_LABELS: Record<ResetTargetCategory, string> = {
  entries: 'conteos de insumos',
  reports: 'reportes diarios',
  items: 'insumos del catálogo',
  stationLinks: 'enlaces/QR de puestos',
  stations: 'puestos de trabajo',
  invites: 'invitaciones pendientes',
  teamMembers: 'accesos del equipo',
};

export function isResetConfirmationValid(input: string): boolean {
  return input.trim() === RESET_CONFIRMATION_WORD;
}

export function sortResetTasks(tasks: ResetTaskItem[]): ResetTaskItem[] {
  const rank = new Map<ResetTargetCategory, number>(
    RESET_CATEGORY_ORDER.map((cat, idx) => [cat, idx]),
  );
  return [...tasks].sort(
    (a, b) => (rank.get(a.category) ?? 99) - (rank.get(b.category) ?? 99),
  );
}

export function chunkResetTasks(
  tasks: ResetTaskItem[],
  batchSize: number = MAX_RESET_BATCH_SIZE,
): ResetTaskItem[][] {
  return chunkArrayWithLimit(sortResetTasks(tasks), batchSize);
}

export function countResetTasksByCategory(
  tasks: ResetTaskItem[],
): Record<ResetTargetCategory, number> {
  const counts: Record<ResetTargetCategory, number> = {
    entries: 0,
    reports: 0,
    items: 0,
    stationLinks: 0,
    stations: 0,
    invites: 0,
    teamMembers: 0,
  };
  tasks.forEach((task) => {
    counts[task.category] += 1;
  });
  return counts;
}

export function formatPendingResetSummary(
  counts: Record<ResetTargetCategory, number>,
): string {
  const parts: string[] = [];
  RESET_CATEGORY_ORDER.forEach((category) => {
    const count = counts[category] ?? 0;
    if (count > 0) {
      parts.push(`${count} ${RESET_CATEGORY_LABELS[category]}`);
    }
  });
  return parts.join(', ');
}

export class PartialResetError extends Error {
  deletedCount: number;
  totalCount: number;
  pendingTasks: ResetTaskItem[];
  pendingByCategory: Record<ResetTargetCategory, number>;

  constructor(params: {
    message: string;
    deletedCount: number;
    totalCount: number;
    pendingTasks: ResetTaskItem[];
  }) {
    super(params.message);
    this.name = 'PartialResetError';
    this.deletedCount = params.deletedCount;
    this.totalCount = params.totalCount;
    this.pendingTasks = params.pendingTasks;
    this.pendingByCategory = countResetTasksByCategory(params.pendingTasks);
  }
}

function formatResetBatchErrorMessage(error: unknown, category: ResetTargetCategory): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const lower = raw.toLowerCase();
  const catLabel = RESET_CATEGORY_LABELS[category];

  if (lower.includes('permission') || lower.includes('insufficient')) {
    return `Permiso denegado al eliminar ${catLabel}. Verifica que estés usando la cuenta del dueño del restaurante.`;
  }
  if (lower.includes('unavailable') || lower.includes('network') || lower.includes('offline')) {
    return `Se perdió la conexión al eliminar ${catLabel}. Revisa tu internet y reintenta los pendientes.`;
  }
  return `Se detuvo el reinicio al eliminar ${catLabel}. Puedes reintentar solo lo que quedó pendiente.`;
}

export async function executeChunkedResetTasks(params: {
  tasks: ResetTaskItem[];
  commitChunk: (chunk: ResetTaskItem[]) => Promise<void>;
  onProgress?: (progress: ResetExecutionProgress) => void;
  batchSize?: number;
}): Promise<{ deletedCount: number; totalCount: number }> {
  const sorted = sortResetTasks(params.tasks);
  const chunks = chunkResetTasks(sorted, params.batchSize ?? MAX_RESET_BATCH_SIZE);
  const totalCount = sorted.length;
  const totalBatches = chunks.length;

  let deletedCount = 0;

  params.onProgress?.({
    totalCount,
    deletedCount: 0,
    completedBatches: 0,
    totalBatches,
    currentCategory: sorted[0]?.category ?? null,
    currentStepLabel:
      totalCount === 0
        ? 'No hay registros por eliminar.'
        : `Preparando ${totalBatches} ${totalBatches === 1 ? 'lote' : 'lotes'}...`,
  });

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const currentCategory = chunk[0]?.category ?? null;
    const categoryLabel = currentCategory ? RESET_CATEGORY_LABELS[currentCategory] : 'registros';

    params.onProgress?.({
      totalCount,
      deletedCount,
      completedBatches: idx,
      totalBatches,
      currentCategory,
      currentStepLabel: `Eliminando ${categoryLabel} (lote ${idx + 1} de ${totalBatches})...`,
    });

    try {
      await params.commitChunk(chunk);
    } catch (error) {
      const pendingTasks = sorted.slice(deletedCount);
      throw new PartialResetError({
        message: formatResetBatchErrorMessage(error, currentCategory ?? 'reports'),
        deletedCount,
        totalCount,
        pendingTasks,
      });
    }

    deletedCount += chunk.length;
    params.onProgress?.({
      totalCount,
      deletedCount,
      completedBatches: idx + 1,
      totalBatches,
      currentCategory,
      currentStepLabel:
        deletedCount === totalCount
          ? 'Limpieza completada.'
          : `Eliminados ${deletedCount} de ${totalCount} registros...`,
    });
  }

  return { deletedCount, totalCount };
}

export interface RestaurantBackupPayload {
  workspaceName: string;
  stations: Workstation[];
  items: InventoryItem[];
  reports: DailyReport[];
  entriesByReportId: Record<string, Record<string, DailyReportEntry>>;
}

function formatCaptureTypeForBackup(item: InventoryItem): string {
  const mode = getItemInputType(item);
  if (mode === 'packs') {
    const pLabel = item.packLabel?.trim() || 'paquete';
    const uLabel = getEffectiveItemUnit(item);
    return `packs (1 ${pLabel} = ${item.packSize ?? '?'} ${uLabel})`;
  }
  if (mode === 'level') {
    const closedSuffix = item.allowClosedContainers ? ' + envases cerrados' : '';
    return `level (cap. ${item.capacity ?? '?'} ${getEffectiveItemUnit(item)}${closedSuffix})`;
  }
  return 'count';
}

export function buildRestaurantBackupCsvContent(payload: RestaurantBackupPayload): string {
  const stationNameMap = new Map(payload.stations.map((s) => [s.id, s.name]));
  const itemsById = new Map(payload.items.map((it) => [it.id, it]));

  const headers = [
    'Seccion',
    'ID',
    'Fecha',
    'PuestoID',
    'PuestoNombre',
    'AreaOUnidad',
    'EncargadaOCaptura',
    'Insumo',
    'Estado',
    'Inicio',
    'Surtido',
    'Cierre',
    'Consumo',
    'Minimo',
    'Ideal',
    'ReportadoPor',
    'Notas',
  ].map(escapeCsvCell);

  const rows: string[][] = [];

  const sortedStations = [...payload.stations].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  sortedStations.forEach((st) => {
    rows.push([
      escapeCsvCell('PUESTO'),
      escapeCsvCell(st.id),
      escapeCsvCell(''),
      escapeCsvCell(st.id),
      escapeCsvCell(st.name),
      escapeCsvCell(st.area),
      escapeCsvCell(st.workerName),
      escapeCsvCell(''),
      escapeCsvCell(st.active ? 'Activo' : 'Inactivo'),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(st.description),
    ]);
  });

  const sortedItems = [...payload.items].sort(
    (a, b) => a.station.localeCompare(b.station) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  sortedItems.forEach((it) => {
    rows.push([
      escapeCsvCell('INSUMO'),
      escapeCsvCell(it.id),
      escapeCsvCell(''),
      escapeCsvCell(it.station),
      escapeCsvCell(stationNameMap.get(it.station) ?? it.station),
      escapeCsvCell(getEffectiveItemUnit(it)),
      escapeCsvCell(formatCaptureTypeForBackup(it)),
      escapeCsvCell(it.name),
      escapeCsvCell(it.active ? 'Activo' : 'Archivado'),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(it.minStock),
      escapeCsvCell(it.targetStock),
      escapeCsvCell(''),
      escapeCsvCell(''),
    ]);
  });

  const sortedReports = [...payload.reports].sort(
    (a, b) => b.date.localeCompare(a.date) || a.station.localeCompare(b.station),
  );
  sortedReports.forEach((rep) => {
    const stationName = stationNameMap.get(rep.station) ?? rep.station;
    const statusLabel =
      rep.status === 'completed'
        ? 'Completado'
        : rep.status === 'opening_saved'
          ? 'Solo apertura'
          : 'Abierto';

    rows.push([
      escapeCsvCell('REPORTE'),
      escapeCsvCell(rep.id),
      escapeCsvCell(rep.date),
      escapeCsvCell(rep.station),
      escapeCsvCell(stationName),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(statusLabel),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(''),
      escapeCsvCell(rep.reportedByName),
      escapeCsvCell(rep.notes),
    ]);

    const entriesMap = payload.entriesByReportId[rep.id] ?? {};
    const sortedEntries = Object.values(entriesMap).sort((a, b) =>
      a.itemName.localeCompare(b.itemName),
    );
    sortedEntries.forEach((entry) => {
      const matchedItem = itemsById.get(entry.itemId);
      const resolvedUnit = matchedItem ? getEffectiveItemUnit(matchedItem) : entry.unit;
      const consumed =
        !entry.notApplicable && entry.hasOpening && entry.hasClosing
          ? sanitizeStockQuantity(Math.max(0, entry.opening + entry.added - entry.closing))
          : '';
      const entryStatus = entry.notApplicable
        ? 'No aplica'
        : entry.openingStatus === 'adjusted'
          ? 'Apertura corregida'
          : entry.openingStatus === 'confirmed_match'
            ? 'Apertura igual a ayer'
            : entry.hasClosing
              ? 'Cerrado'
              : 'Solo apertura';

      rows.push([
        escapeCsvCell('DETALLE_REPORTE'),
        escapeCsvCell(`${rep.id}/${entry.itemId}`),
        escapeCsvCell(entry.date),
        escapeCsvCell(entry.station),
        escapeCsvCell(stationName),
        escapeCsvCell(resolvedUnit),
        escapeCsvCell(''),
        escapeCsvCell(entry.itemName),
        escapeCsvCell(entryStatus),
        escapeCsvCell(entry.hasOpening && !entry.notApplicable ? entry.opening : ''),
        escapeCsvCell(!entry.notApplicable ? entry.added : ''),
        escapeCsvCell(entry.hasClosing && !entry.notApplicable ? entry.closing : ''),
        escapeCsvCell(consumed),
        escapeCsvCell(entry.minStock),
        escapeCsvCell(entry.targetStock),
        escapeCsvCell(entry.updatedByName),
        escapeCsvCell(
          typeof entry.previousClosing === 'number'
            ? `Cierre anterior: ${entry.previousClosing}`
            : '',
        ),
      ]);
    });
  });

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

export function downloadRestaurantBackupCsv(
  payload: RestaurantBackupPayload,
  dateStr: string,
): void {
  const content = buildRestaurantBackupCsvContent(payload);
  const slug =
    payload.workspaceName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'restaurante';
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `respaldo_${slug}_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
