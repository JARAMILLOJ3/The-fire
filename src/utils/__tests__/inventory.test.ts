import { describe, expect, it } from 'vitest';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  Workstation,
} from '../../types';
import {
  buildConsolidatedRows,
  buildWhatsAppShoppingList,
  detectEntryAnomalies,
  getStockLevel,
  getSuggestedPurchase,
  parseQuantityInput,
  sanitizeStockQuantity,
} from '../inventory';

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'mesera_1',
    workspaceId: 'ws_1',
    ownerUid: 'owner_1',
    authorizedEmails: ['boss@example.com'],
    station: 'mesera',
    name: 'Coca-Cola 400ml',
    unit: 'und',
    minStock: 10,
    targetStock: 30,
    active: true,
    sortOrder: 1,
    ...overrides,
  };
}

function makeStation(overrides: Partial<Workstation> = {}): Workstation {
  return {
    id: 'mesera',
    workspaceId: 'ws_1',
    ownerUid: 'owner_1',
    authorizedEmails: ['boss@example.com'],
    name: 'Mesera — Gaseosas',
    area: 'Barra',
    workerName: 'Ana',
    description: '',
    accessCode: 'tf_123456789012345678',
    nextItemSlot: 2,
    active: true,
    sortOrder: 0,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<DailyReportEntry> = {}): DailyReportEntry {
  return {
    id: 'mesera_1',
    workspaceId: 'ws_1',
    ownerUid: 'owner_1',
    authorizedEmails: ['boss@example.com'],
    reportId: 'ws_1_2026-11-13_mesera',
    itemId: 'mesera_1',
    station: 'mesera',
    date: '2026-11-13',
    itemName: 'Coca-Cola 400ml',
    unit: 'und',
    minStock: 10,
    targetStock: 30,
    opening: 20,
    added: 5,
    closing: 8,
    hasOpening: true,
    hasClosing: true,
    notApplicable: false,
    updatedByUid: 'worker_1',
    updatedByName: 'Ana',
    ...overrides,
  };
}

describe('inventory.ts (sanitización, sin_dato, anomalías y compras)', () => {
  it('sanitizes and parses numeric inputs safely, including comma decimals', () => {
    expect(sanitizeStockQuantity(-5)).toBe(0);
    expect(sanitizeStockQuantity(Number.NaN)).toBe(0);
    expect(sanitizeStockQuantity(Number.POSITIVE_INFINITY)).toBe(0);
    expect(sanitizeStockQuantity(999999)).toBe(100000);
    expect(sanitizeStockQuantity(2.345)).toBe(2.35);

    expect(parseQuantityInput('')).toEqual({ valid: true, value: 0, empty: true });
    expect(parseQuantityInput('1,5')).toEqual({ valid: true, value: 1.5, empty: false });
    expect(parseQuantityInput('-3').valid).toBe(false);
    expect(parseQuantityInput('abc').valid).toBe(false);
    expect(parseQuantityInput('200000').valid).toBe(false);
  });

  it('marks uncounted and provisional items as sin_dato without false zero alerts', () => {
    const item = makeItem();
    const openReport: DailyReport = {
      id: 'ws_1_2026-11-13_mesera',
      workspaceId: 'ws_1',
      ownerUid: 'owner_1',
      authorizedEmails: ['boss@example.com'],
      date: '2026-11-13',
      station: 'mesera',
      status: 'opening_saved',
      reportedByUid: 'worker_1',
      reportedByName: 'Ana',
      notes: '',
    };

    // Uncounted item -> sin_dato, suggestedBuy 0
    const uncounted = buildConsolidatedRows([item], {}, {});
    expect(uncounted[0].stockLevel).toBe('sin_dato');
    expect(uncounted[0].currentStock).toBeNull();
    expect(uncounted[0].suggestedBuy).toBe(0);

    // Opening saved only -> provisional, still sin_dato (not counted closing)
    const provisional = buildConsolidatedRows(
      [item],
      { mesera_1: makeEntry({ closing: 0, hasClosing: false }) },
      { mesera: openReport },
    );
    expect(provisional[0].isProvisional).toBe(true);
    expect(provisional[0].provisionalStock).toBe(25);
    expect(provisional[0].stockLevel).toBe('sin_dato');
    expect(provisional[0].suggestedBuy).toBe(0);

    // Completed with closing 0 -> agotado and real purchase suggestion
    const completedReport: DailyReport = { ...openReport, status: 'completed' };
    const completedZero = buildConsolidatedRows(
      [item],
      { mesera_1: makeEntry({ closing: 0, hasClosing: true }) },
      { mesera: completedReport },
    );
    expect(completedZero[0].hasCountedClosing).toBe(true);
    expect(completedZero[0].stockLevel).toBe('agotado');
    expect(completedZero[0].suggestedBuy).toBe(30);
    expect(completedZero[0].consumed).toBe(25);
  });

  it('builds WhatsApp shopping list only from completed stations', () => {
    const item = makeItem();
    const station = makeStation();
    const provisionalRows = buildConsolidatedRows(
      [item],
      { mesera_1: makeEntry({ closing: 0, hasClosing: false }) },
      {},
    );
    expect(buildWhatsAppShoppingList('2026-11-13', provisionalRows, [station])).toContain(
      'Aún no hay cierres completados',
    );

    const completedRows = buildConsolidatedRows(
      [item],
      { mesera_1: makeEntry({ closing: 2, hasClosing: true }) },
      {
        mesera: {
          id: 'ws_1_2026-11-13_mesera',
          workspaceId: 'ws_1',
          ownerUid: 'owner_1',
          authorizedEmails: ['boss@example.com'],
          date: '2026-11-13',
          station: 'mesera',
          status: 'completed',
          reportedByUid: 'worker_1',
          reportedByName: 'Ana',
          notes: '',
        },
      },
    );
    const msg = buildWhatsAppShoppingList('2026-11-13', completedRows, [station]);
    expect(msg).toContain('Coca-Cola 400ml');
    expect(msg).toContain('Pedir 28 und');
  });

  it('detects closing exceeding available stock and extreme numeric spikes', () => {
    const baseRow: DraftEntryRow = {
      itemId: 'mesera_1',
      itemName: 'Coca-Cola 400ml',
      unit: 'und',
      minStock: 10,
      targetStock: 30,
      opening: 10,
      added: 5,
      closing: 20,
      hasOpening: true,
      hasClosing: true,
      notApplicable: false,
    };

    const exceeding = detectEntryAnomalies(baseRow, 'closing');
    expect(exceeding.some((a) => a.type === 'closing_exceeds_available')).toBe(true);

    const extreme = detectEntryAnomalies({ ...baseRow, closing: 1000 }, 'closing');
    expect(extreme.some((a) => a.type === 'extreme_stock_spike')).toBe(true);

    const naRow = detectEntryAnomalies({ ...baseRow, notApplicable: true, closing: 1000 }, 'closing');
    expect(naRow).toHaveLength(0);
  });

  it('computes stock levels and suggested purchases accurately', () => {
    expect(getStockLevel(0, 10)).toBe('agotado');
    expect(getStockLevel(10, 10)).toBe('comprar');
    expect(getStockLevel(14, 10)).toBe('medio');
    expect(getStockLevel(15, 10)).toBe('suficiente');
    expect(getSuggestedPurchase(11, 10, 30)).toBe(0);
    expect(getSuggestedPurchase(5, 10, 30)).toBe(25);
  });
});
