import {
  MAX_STOCK_VALUE,
  MAX_WORKER_NOTE_LENGTH,
  WORKER_NOTE_SHORTCUTS,
} from '../constants';
import type { InventoryItem, WorkerNote } from '../types';
import { formatSpanishDecimal, getEffectiveItemUnit } from './inventory';

export interface WorkerNoteValidationResult {
  valid: boolean;
  text: string;
  quantity?: number;
  error: string | null;
}

export function validateWorkerNoteInput(params: {
  text: string;
  quantityInput?: string;
}): WorkerNoteValidationResult {
  const trimmedText = params.text.trim();
  if (!trimmedText) {
    return {
      valid: false,
      text: '',
      error: 'Escribe una nota antes de guardar.',
    };
  }
  if (trimmedText.length > MAX_WORKER_NOTE_LENGTH) {
    return {
      valid: false,
      text: trimmedText,
      error: `La nota no puede superar los ${MAX_WORKER_NOTE_LENGTH} caracteres.`,
    };
  }

  const rawQty = (params.quantityInput ?? '').trim().replace(',', '.');
  if (!rawQty) {
    return {
      valid: true,
      text: trimmedText,
      quantity: undefined,
      error: null,
    };
  }

  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(rawQty)) {
    return {
      valid: false,
      text: trimmedText,
      error: 'Ingresa una cantidad numérica válida o déjala vacía.',
    };
  }

  const parsedQty = Number(rawQty);
  if (!Number.isFinite(parsedQty) || parsedQty < 0) {
    return {
      valid: false,
      text: trimmedText,
      error: 'La cantidad no puede ser negativa.',
    };
  }
  if (parsedQty > MAX_STOCK_VALUE) {
    return {
      valid: false,
      text: trimmedText,
      error: `La cantidad máxima permitida es ${MAX_STOCK_VALUE}.`,
    };
  }

  return {
    valid: true,
    text: trimmedText,
    quantity: Math.round(parsedQty * 100) / 100,
    error: null,
  };
}

export function applyWorkerNoteShortcut(currentText: string, shortcut: string): string {
  const cleanShortcut = shortcut.trim();
  const cleanCurrent = currentText.trim();
  if (!cleanCurrent) {
    return cleanShortcut.slice(0, MAX_WORKER_NOTE_LENGTH);
  }

  // Replace leading shortcut prefix if switching between preset shortcuts without wiping custom detail
  for (const preset of WORKER_NOTE_SHORTCUTS) {
    if (cleanCurrent === preset) {
      return cleanShortcut.slice(0, MAX_WORKER_NOTE_LENGTH);
    }
    const prefix = `${preset}: `;
    if (cleanCurrent.startsWith(prefix)) {
      const rest = cleanCurrent.slice(prefix.length).trim();
      const next = rest ? `${cleanShortcut}: ${rest}` : cleanShortcut;
      return next.slice(0, MAX_WORKER_NOTE_LENGTH);
    }
  }

  if (cleanCurrent.toLowerCase().includes(cleanShortcut.toLowerCase())) {
    return currentText.slice(0, MAX_WORKER_NOTE_LENGTH);
  }

  const combined = `${cleanShortcut}: ${cleanCurrent}`;
  return combined.slice(0, MAX_WORKER_NOTE_LENGTH);
}

export function canWorkerModifyNote(
  note: Pick<WorkerNote, 'authorUid' | 'date' | 'station' | 'workspaceId'>,
  context: {
    userUid: string;
    operationalDate: string;
    stationId: string;
    workspaceId: string;
  },
): boolean {
  return (
    note.authorUid === context.userUid &&
    note.date === context.operationalDate &&
    note.station === context.stationId &&
    note.workspaceId === context.workspaceId
  );
}

export function sortWorkerNotesNewestFirst(notes: WorkerNote[]): WorkerNote[] {
  return [...notes].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    const aMs = a.createdAt?.toMillis?.() ?? 0;
    const bMs = b.createdAt?.toMillis?.() ?? 0;
    if (aMs !== bMs) return bMs - aMs;
    return b.timeLabel.localeCompare(a.timeLabel);
  });
}

export function buildWorkerNoteItemMetadata(item?: InventoryItem): {
  itemId?: string;
  itemName?: string;
  itemUnit?: string;
} {
  if (!item) return {};
  return {
    itemId: item.id,
    itemName: item.name,
    itemUnit: getEffectiveItemUnit(item),
  };
}

export function formatWorkerNoteContextLabel(note: Pick<WorkerNote, 'itemName' | 'itemUnit' | 'quantity'>): string | null {
  const hasItem = Boolean(note.itemName?.trim());
  const hasQty = typeof note.quantity === 'number' && Number.isFinite(note.quantity);
  if (!hasItem && !hasQty) return null;

  const qtyText = hasQty ? formatSpanishDecimal(note.quantity as number, 2) : '';
  const unitText = note.itemUnit?.trim() ?? '';

  if (hasItem && hasQty) {
    return `${note.itemName} · ${qtyText}${unitText ? ` ${unitText}` : ''}`;
  }
  if (hasItem) {
    return note.itemName ?? null;
  }
  return `Cantidad: ${qtyText}${unitText ? ` ${unitText}` : ''}`;
}
