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

  it('keeps preloaded yesterday closing as pending_confirm until confirmed or edited, and bulk-confirms only untouched rows', async () => {
    const {
      confirmAllPendingOpeningRows,
      confirmPreloadedOpeningRow,
      getOpeningRowState,
    } = await import('../inventory');

    const preloadedUntouched: DraftEntryRow = {
      itemId: 'mesera_1',
      itemName: 'Coca-Cola 400ml',
      unit: 'und',
      minStock: 10,
      targetStock: 30,
      opening: 12,
      added: 0,
      closing: 0,
      hasOpening: false,
      hasClosing: false,
      previousClosing: 12,
    };
    expect(getOpeningRowState(preloadedUntouched)).toBe('pending_confirm');

    const confirmedSingle = confirmPreloadedOpeningRow(preloadedUntouched);
    expect(confirmedSingle.hasOpening).toBe(true);
    expect(confirmedSingle.openingStatus).toBe('confirmed_match');
    expect(getOpeningRowState(confirmedSingle)).toBe('confirmed');

    const manuallyCorrected: DraftEntryRow = {
      ...preloadedUntouched,
      itemId: 'mesera_2',
      opening: 9,
      hasOpening: true,
      openingStatus: 'adjusted',
      previousClosing: 12,
    };
    expect(getOpeningRowState(manuallyCorrected)).toBe('adjusted');

    const noYesterday: DraftEntryRow = {
      itemId: 'mesera_3',
      itemName: 'Agua',
      unit: 'und',
      minStock: 5,
      targetStock: 15,
      opening: 0,
      added: 0,
      closing: 0,
      hasOpening: false,
      hasClosing: false,
    };
    expect(getOpeningRowState(noYesterday)).toBe('uncounted');

    const bulkResult = confirmAllPendingOpeningRows(
      {
        mesera_1: preloadedUntouched,
        mesera_2: manuallyCorrected,
        mesera_3: noYesterday,
      },
      {
        mesera_2: { opening: true },
      },
    );

    expect(bulkResult.confirmedIds).toEqual(['mesera_1']);
    expect(bulkResult.nextRows.mesera_1.hasOpening).toBe(true);
    expect(bulkResult.nextRows.mesera_1.openingStatus).toBe('confirmed_match');
    expect(bulkResult.nextRows.mesera_2.opening).toBe(9);
    expect(bulkResult.nextRows.mesera_2.openingStatus).toBe('adjusted');
    expect(bulkResult.nextRows.mesera_3.hasOpening).toBe(false);
  });

  it('formats save errors in Spanish with clear causes and Firestore error codes', async () => {
    const { formatStationSaveError } = await import('../inventory');

    const wrappedPerm = new Error(
      JSON.stringify({
        error: 'Missing or insufficient permissions.',
        operationType: 'write',
        path: 'dailyReports/restaurante_principal_2026-11-14_comida_rapida',
      }),
    );

    const outsideErr = formatStationSaveError(wrappedPerm, {
      schedulePhase: 'outside',
      isOnline: true,
    });
    expect(outsideErr.code).toBe('permission-denied');
    expect(outsideErr.title).toContain('Fuera del horario');

    const insidePermErr = formatStationSaveError(wrappedPerm, {
      schedulePhase: 'closing',
      inGracePeriod: false,
      isOnline: true,
    });
    expect(insidePermErr.code).toBe('permission-denied');
    expect(insidePermErr.detail).toContain('catálogo');

    const offlineErr = formatStationSaveError(new Error('Client is offline'), {
      isOnline: false,
    });
    expect(offlineErr.code).toBe('unavailable');
    expect(offlineErr.title).toContain('Sin conexión');
  });

  it('formats configured opening/closing times for thank-you screens cleanly', async () => {
    const { formatTime12h } = await import('../schedule');
    expect(formatTime12h('10:00')).toBe('10:00 a. m.');
    expect(formatTime12h('19:00')).toBe('7:00 p. m.');
    expect(formatTime12h('23:00')).toBe('11:00 p. m.');
    expect(formatTime12h('02:00')).toBe('2:00 a. m.');
  });

  it('handles minStock=0 at zero stock and warns instead of silently raising targetStock < minStock', async () => {
    const { hasTargetBelowMin } = await import('../inventory');

    // minStock=0, stock=0 -> minimum suggested purchase of 1 even when targetStock=0
    expect(getSuggestedPurchase(0, 0, 0)).toBe(1);
    expect(getSuggestedPurchase(0, 0, 5)).toBe(5);
    expect(getSuggestedPurchase(1, 0, 5)).toBe(0);

    // targetStock < minStock -> do NOT silently inflate to minStock * 2
    expect(hasTargetBelowMin(10, 5)).toBe(true);
    expect(hasTargetBelowMin(10, 10)).toBe(false);
    expect(getSuggestedPurchase(8, 10, 15)).toBe(7);
  });

  it('protects CSV cells from formula injection and quotes all columns', async () => {
    const { escapeCsvCell, buildDailyCsvContent } = await import('../inventory');

    expect(escapeCsvCell('=SUM(A1:A2)')).toBe(`"'=SUM(A1:A2)"`);
    expect(escapeCsvCell('+1234')).toBe(`"'+1234"`);
    expect(escapeCsvCell('-1234')).toBe(`"'-1234"`);
    expect(escapeCsvCell('@cmd')).toBe(`"'@cmd"`);
    expect(escapeCsvCell('\t=1+1')).toBe(`"'\t=1+1"`);
    expect(escapeCsvCell('  +cmd')).toBe(`"'  +cmd"`);
    expect(escapeCsvCell('Queso "Doble"')).toBe(`"Queso ""Doble"""`);

    const dangerItem = makeItem({ name: '=HYPERLINK("http://evil")', unit: '+und' });
    const rows = buildConsolidatedRows(
      [dangerItem],
      { mesera_1: makeEntry({ itemName: dangerItem.name, closing: 5, hasClosing: true }) },
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

    const csv = buildDailyCsvContent('2026-11-13', rows, [makeStation()]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    // Every cell in header and data row starts and ends with double quote
    lines[0].split(',').forEach((cell) => {
      expect(cell.startsWith('"') && cell.endsWith('"')).toBe(true);
    });
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[1]).toContain(`"'+und"`);
  });

  it('validates catalog items for required unit, active duplicate names in same station, and target < min warning', async () => {
    const { validateCatalogItemInput } = await import('../inventory');

    const existing = [
      makeItem({ id: 'm1', station: 'mesera', name: 'Coca-Cola 400ml', active: true }),
      makeItem({ id: 'm2', station: 'mesera', name: 'Gaseosa Vieja', active: false }),
      makeItem({ id: 'c1', station: 'cocina', name: 'Sal', active: true }),
    ];

    // Missing unit -> invalid
    const missingUnit = validateCatalogItemInput({
      name: 'Sprite',
      unit: '   ',
      station: 'mesera',
      minStock: 5,
      targetStock: 10,
      existingItems: existing,
    });
    expect(missingUnit.valid).toBe(false);
    expect(missingUnit.error).toContain('unidad');

    // Duplicate active name in same station (case/spaces normalized) -> invalid
    const dup = validateCatalogItemInput({
      name: '  coca-cola   400ml ',
      unit: 'und',
      station: 'mesera',
      minStock: 5,
      targetStock: 10,
      existingItems: existing,
    });
    expect(dup.valid).toBe(false);
    expect(dup.error).toContain('Ya existe');

    // Same name in different station or archived item -> valid
    const crossStation = validateCatalogItemInput({
      name: 'Sal',
      unit: 'kg',
      station: 'mesera',
      minStock: 2,
      targetStock: 5,
      existingItems: existing,
    });
    expect(crossStation.valid).toBe(true);

    const reuseArchived = validateCatalogItemInput({
      name: 'Gaseosa Vieja',
      unit: 'und',
      station: 'mesera',
      minStock: 2,
      targetStock: 5,
      existingItems: existing,
    });
    expect(reuseArchived.valid).toBe(true);

    // targetStock < minStock -> valid with warning (non-blocking, not silently overwritten)
    const warnTarget = validateCatalogItemInput({
      name: 'Postobón',
      unit: 'und',
      station: 'mesera',
      minStock: 10,
      targetStock: 4,
      existingItems: existing,
    });
    expect(warnTarget.valid).toBe(true);
    expect(warnTarget.warning).toContain('menor que el stock mínimo');
  });

  it('builds 7-day weekly station history and flags late stations', async () => {
    const { buildWeeklyStationHistory } = await import('../inventory');

    const station = makeStation();
    const item = makeItem();
    const reports: DailyReport[] = [
      {
        id: 'ws_1_2026-11-12_mesera',
        workspaceId: 'ws_1',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@example.com'],
        date: '2026-11-12',
        station: 'mesera',
        status: 'completed',
        reportedByUid: 'w1',
        reportedByName: 'Ana',
        notes: '',
      },
      {
        id: 'ws_1_2026-11-13_mesera',
        workspaceId: 'ws_1',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@example.com'],
        date: '2026-11-13',
        station: 'mesera',
        status: 'opening_saved',
        reportedByUid: 'w1',
        reportedByName: 'Ana',
        notes: '',
      },
    ];

    const history = buildWeeklyStationHistory({
      endDateStr: '2026-11-13',
      stations: [station],
      items: [item],
      allReports: reports,
      entriesByReportId: {
        'ws_1_2026-11-12_mesera': {
          mesera_1: makeEntry({
            reportId: 'ws_1_2026-11-12_mesera',
            date: '2026-11-12',
            closing: 4,
            hasClosing: true,
          }),
        },
      },
      schedule: {
        enabled: true,
        openingStart: '16:00',
        openingEnd: '18:00',
        closingStart: '23:00',
        closingEnd: '02:00',
      },
      // 2026-11-14 02:30 Bogota = 07:30Z -> past deadline for 2026-11-13
      now: new Date('2026-11-14T07:30:00Z'),
    });

    expect(history.dates).toHaveLength(7);
    expect(history.dates[0]).toBe('2026-11-07');
    expect(history.dates[6]).toBe('2026-11-13');
    expect(history.rows[0].completedCount).toBe(1);
    expect(history.rows[0].lateCount).toBe(6);
    const day12 = history.rows[0].days.find((d) => d.date === '2026-11-12');
    expect(day12?.status).toBe('completed');
    expect(day12?.lowStockCount).toBe(1);
    const day13 = history.rows[0].days.find((d) => d.date === '2026-11-13');
    expect(day13?.status).toBe('opening_saved');
    expect(day13?.isLate).toBe(true);
  });

  it('detects closing > available and above-average consumption anomalies across 7-day history', async () => {
    const { detectDashboardConsumptionAnomalies } = await import('../inventory');

    const station = makeStation();
    const itemA = makeItem({ id: 'mesera_1', name: 'Coca-Cola 400ml' });
    const itemB = makeItem({ id: 'mesera_2', name: 'Papas' });

    const priorReports: DailyReport[] = [
      {
        id: 'ws_1_2026-11-11_mesera',
        workspaceId: 'ws_1',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@example.com'],
        date: '2026-11-11',
        station: 'mesera',
        status: 'completed',
        reportedByUid: 'w1',
        reportedByName: 'Ana',
        notes: '',
      },
      {
        id: 'ws_1_2026-11-12_mesera',
        workspaceId: 'ws_1',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@example.com'],
        date: '2026-11-12',
        station: 'mesera',
        status: 'completed',
        reportedByUid: 'w1',
        reportedByName: 'Ana',
        notes: '',
      },
      {
        id: 'ws_1_2026-11-13_mesera',
        workspaceId: 'ws_1',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@example.com'],
        date: '2026-11-13',
        station: 'mesera',
        status: 'completed',
        reportedByUid: 'w1',
        reportedByName: 'Ana',
        notes: '',
      },
    ];

    const todayRows = buildConsolidatedRows(
      [itemA, itemB],
      {
        // High consumption today: 20 + 10 - 5 = 25 vs prior avg 5 (5x)
        mesera_1: makeEntry({
          itemId: 'mesera_1',
          opening: 20,
          added: 10,
          closing: 5,
          hasOpening: true,
          hasClosing: true,
        }),
        // Closing > opening + added: 10 + 0 < 15
        mesera_2: makeEntry({
          itemId: 'mesera_2',
          itemName: 'Papas',
          opening: 10,
          added: 0,
          closing: 15,
          hasOpening: true,
          hasClosing: true,
        }),
      },
      { mesera: priorReports[2] },
    );

    const anomalies = detectDashboardConsumptionAnomalies({
      selectedDate: '2026-11-13',
      rows: todayRows,
      stations: [station],
      allReports: priorReports,
      entriesByReportId: {
        'ws_1_2026-11-11_mesera': {
          mesera_1: makeEntry({ opening: 10, added: 0, closing: 5, hasOpening: true, hasClosing: true }),
        },
        'ws_1_2026-11-12_mesera': {
          mesera_1: makeEntry({ opening: 10, added: 0, closing: 5, hasOpening: true, hasClosing: true }),
        },
      },
    });

    expect(anomalies).toHaveLength(2);
    expect(anomalies.find((a) => a.itemId === 'mesera_1')?.kind).toBe('above_average_consumption');
    expect(anomalies.find((a) => a.itemId === 'mesera_1')?.ratioToAverage).toBe(5);
    expect(anomalies.find((a) => a.itemId === 'mesera_2')?.kind).toBe('closing_exceeds_available');
  });
});
