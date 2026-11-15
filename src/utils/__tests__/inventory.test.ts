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
  buildItemCaptureFields,
  buildWhatsAppShoppingList,
  createDefaultStationItemDraft,
  detectEntryAnomalies,
  getStockLevel,
  getSuggestedPurchase,
  getUnitSelectOptions,
  inventoryItemToDraft,
  parseCaptureDecimalInput,
  parseQuantityInput,
  sanitizeStockQuantity,
  validateStationItemsDraft,
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

  it('converts packs + loose units and splits totals with custom packLabel/unitLabel', async () => {
    const {
      computePacksTotal,
      formatPreviousClosingForItem,
      getPacksFieldLabels,
      splitTotalToPacks,
    } = await import('../inventory');

    // Tocineta: kilo of 40 lonchas -> 2 kilos + 12 lonchas = 92 lonchas
    expect(computePacksTotal(2, 12, 40)).toBe(92);
    expect(splitTotalToPacks(92, 40)).toEqual({ packs: 2, loose: 12 });
    // Pan: paquete of 8 panes -> 100 panes = 12 paquetes + 4 panes
    expect(splitTotalToPacks(100, 8)).toEqual({ packs: 12, loose: 4 });
    // Loose >= packSize still calculates exact base total so worker can see warning & override
    expect(computePacksTotal(1, 45, 40)).toBe(85);

    const tocinetaItem = makeItem({
      name: 'Tocineta',
      unit: 'lonchas',
      inputType: 'packs',
      packSize: 40,
      packLabel: 'kilo',
      unitLabel: 'loncha',
    });
    expect(getPacksFieldLabels(tocinetaItem)).toMatchObject({
      packsFieldLabel: 'Kilos',
      looseFieldLabel: 'Lonchas sueltas',
    });
    expect(formatPreviousClosingForItem(92, tocinetaItem)).toBe('2 kilos + 12 lonchas (92 lonchas)');

    const panItem = makeItem({
      name: 'Pan hamburguesa',
      unit: 'pan',
      inputType: 'packs',
      packSize: 8,
      packLabel: 'paquete',
      unitLabel: 'pan',
    });
    expect(getPacksFieldLabels(panItem)).toMatchObject({
      packsFieldLabel: 'Paquetes',
      looseFieldLabel: 'Panes sueltos',
    });
    expect(formatPreviousClosingForItem(24, panItem)).toBe('3 paquetes (24 panes)');
  });

  it('converts 1/8 level steps to base units, snaps back, and formats approximate amounts', async () => {
    const {
      computeLevelTotal,
      formatLevelApproximate,
      formatPreviousClosingForItem,
      snapQuantityToLevelStep,
    } = await import('../inventory');

    // 5 L container in 1/8 steps
    expect(computeLevelTotal(0, 5)).toBe(0);
    expect(computeLevelTotal(1, 5)).toBe(0.63); // 1/8 * 5 = 0.625 -> sanitized 0.63
    expect(computeLevelTotal(2, 5)).toBe(1.25); // 1/4
    expect(computeLevelTotal(4, 5)).toBe(2.5); // 1/2
    expect(computeLevelTotal(6, 5)).toBe(3.75); // 3/4
    expect(computeLevelTotal(8, 5)).toBe(5); // Lleno

    expect(formatLevelApproximate(0.625, 'L')).toBe('≈ 0,6 L');
    expect(formatLevelApproximate(2.5, 'L')).toBe('≈ 2,5 L');
    expect(formatLevelApproximate(0, 'L')).toBe('0 L');

    expect(snapQuantityToLevelStep(0.63, 5)).toBe(1);
    expect(snapQuantityToLevelStep(2.5, 5)).toBe(4);
    expect(snapQuantityToLevelStep(5, 5)).toBe(8);

    const aceiteItem = makeItem({
      name: 'Aceite',
      unit: 'L',
      inputType: 'level',
      capacity: 5,
    });
    expect(formatPreviousClosingForItem(2.5, aceiteItem)).toBe('½ (≈ 2,5 L)');
  });

  it('rounds packs shopping quantities up to full packages with unit equivalent in BossDashboard and WhatsApp', async () => {
    const { getPacksPurchaseSummary } = await import('../inventory');

    const tocineta = makeItem({
      id: 'com_1',
      station: 'comida_rapida',
      name: 'Tocineta',
      unit: 'loncha',
      minStock: 40,
      targetStock: 120,
      inputType: 'packs',
      packSize: 40,
      packLabel: 'kilo',
      unitLabel: 'loncha',
    });

    // Need 81 lonchas -> ceil(81 / 40) = 3 kilos (120 lonchas)
    expect(getPacksPurchaseSummary(81, tocineta)?.text).toBe('Comprar: 3 kilos (120 lonchas)');
    // Need 40 lonchas exact -> 1 kilo (40 lonchas)
    expect(getPacksPurchaseSummary(40, tocineta)?.text).toBe('Comprar: 1 kilo (40 lonchas)');
    // Need 1 loncha -> rounds up to 1 kilo (40 lonchas)
    expect(getPacksPurchaseSummary(1, tocineta)?.text).toBe('Comprar: 1 kilo (40 lonchas)');
    // Count item returns null
    expect(getPacksPurchaseSummary(10, makeItem())).toBeNull();

    const station = makeStation({ id: 'comida_rapida', name: 'Comida Rápida' });
    const rows = buildConsolidatedRows(
      [tocineta],
      {
        com_1: makeEntry({
          itemId: 'com_1',
          station: 'comida_rapida',
          itemName: 'Tocineta',
          unit: 'loncha',
          minStock: 40,
          targetStock: 120,
          closing: 39,
          hasClosing: true,
        }),
      },
      {
        comida_rapida: {
          id: 'ws_1_2026-11-13_comida_rapida',
          workspaceId: 'ws_1',
          ownerUid: 'owner_1',
          authorizedEmails: ['boss@example.com'],
          date: '2026-11-13',
          station: 'comida_rapida',
          status: 'completed',
          reportedByUid: 'w1',
          reportedByName: 'Juan',
          notes: '',
        },
      },
    );

    expect(rows[0].suggestedBuy).toBe(81);
    const whatsapp = buildWhatsAppShoppingList('2026-11-13', rows, [station]);
    expect(whatsapp).toContain('Comprar: 3 kilos (120 lonchas)');
  });

  it('validates packSize (integer > 1), packLabel/unitLabel (<= 20 chars), and level capacity (> 0)', async () => {
    const { validateCatalogItemInput } = await import('../inventory');

    // Float or <= 1 packSize rejected
    expect(
      validateCatalogItemInput({
        name: 'Pan',
        unit: 'pan',
        station: 'comida_rapida',
        minStock: 8,
        targetStock: 24,
        inputType: 'packs',
        packSize: 8.5,
        packLabel: 'paquete',
        unitLabel: 'pan',
        existingItems: [],
      }).valid,
    ).toBe(false);

    expect(
      validateCatalogItemInput({
        name: 'Pan',
        unit: 'pan',
        station: 'comida_rapida',
        minStock: 8,
        targetStock: 24,
        inputType: 'packs',
        packSize: 1,
        packLabel: 'paquete',
        unitLabel: 'pan',
        existingItems: [],
      }).valid,
    ).toBe(false);

    // Oversized label (> 20 chars) rejected
    expect(
      validateCatalogItemInput({
        name: 'Pan',
        unit: 'pan',
        station: 'comida_rapida',
        minStock: 8,
        targetStock: 24,
        inputType: 'packs',
        packSize: 8,
        packLabel: 'nombre_demasiado_largo_21',
        unitLabel: 'pan',
        existingItems: [],
      }).valid,
    ).toBe(false);

    // Valid packs
    expect(
      validateCatalogItemInput({
        name: 'Pan',
        unit: 'pan',
        station: 'comida_rapida',
        minStock: 8,
        targetStock: 24,
        inputType: 'packs',
        packSize: 8,
        packLabel: 'paquete',
        unitLabel: 'pan',
        existingItems: [],
      }).valid,
    ).toBe(true);

    // Invalid vs valid capacity for level
    expect(
      validateCatalogItemInput({
        name: 'Aceite',
        unit: 'L',
        station: 'comida_rapida',
        minStock: 2,
        targetStock: 5,
        inputType: 'level',
        capacity: 0,
        existingItems: [],
      }).valid,
    ).toBe(false);

    expect(
      validateCatalogItemInput({
        name: 'Aceite',
        unit: 'L',
        station: 'comida_rapida',
        minStock: 2,
        targetStock: 5,
        inputType: 'level',
        capacity: 5,
        existingItems: [],
      }).valid,
    ).toBe(true);
  });

  it('validates workstation item drafts using the shared catalog rules without duplication', () => {
    const validResult = validateStationItemsDraft({
      stationId: 'comida_rapida',
      drafts: [
        createDefaultStationItemDraft({
          name: 'Pan perro',
          unit: 'pan',
          minStock: 16,
          targetStock: 40,
          inputType: 'packs',
          packSizeInput: '8',
          packLabel: 'paquete',
          unitLabel: 'pan',
        }),
        createDefaultStationItemDraft({
          name: 'Aceite freidora',
          unit: 'L',
          minStock: 2,
          targetStock: 6,
          inputType: 'level',
          capacityInput: '5,5',
        }),
        // Blank unsaved template row is ignored cleanly
        createDefaultStationItemDraft({ name: '   ' }),
      ],
    });

    expect(validResult.valid).toBe(true);
    expect(validResult.error).toBeNull();
    expect(validResult.warning).toBeNull();
    expect(validResult.preparedItems).toEqual([
      {
        name: 'Pan perro',
        unit: 'pan',
        minStock: 16,
        targetStock: 40,
        inputType: 'packs',
        packSize: 8,
        packLabel: 'paquete',
        unitLabel: 'pan',
      },
      {
        name: 'Aceite freidora',
        unit: 'L',
        minStock: 2,
        targetStock: 6,
        inputType: 'level',
        capacity: 5.5,
      },
    ]);

    // Rejects blank name when editing an existing item
    const missingExistingName = validateStationItemsDraft({
      stationId: 'comida_rapida',
      drafts: [
        createDefaultStationItemDraft({
          id: 'comida_rapida_1',
          name: '   ',
        }),
      ],
    });
    expect(missingExistingName.valid).toBe(false);

    // Rejects duplicate normalized names within the same workstation draft
    const dupResult = validateStationItemsDraft({
      stationId: 'comida_rapida',
      drafts: [
        createDefaultStationItemDraft({ name: 'Tocineta', unit: 'loncha' }),
        createDefaultStationItemDraft({ name: '  tocineta  ', unit: 'loncha' }),
      ],
    });
    expect(dupResult.valid).toBe(false);

    // Enforces packs and level validation rules from validateCatalogItemInput
    expect(
      validateStationItemsDraft({
        stationId: 'comida_rapida',
        drafts: [
          createDefaultStationItemDraft({
            name: 'Pan',
            unit: 'pan',
            inputType: 'packs',
            packSizeInput: '1',
            packLabel: 'paquete',
            unitLabel: 'pan',
          }),
        ],
      }).valid,
    ).toBe(false);

    expect(
      validateStationItemsDraft({
        stationId: 'comida_rapida',
        drafts: [
          createDefaultStationItemDraft({
            name: 'Pan',
            unit: 'pan',
            inputType: 'packs',
            packSizeInput: '8',
            packLabel: 'etiqueta_de_mas_de_20_caracteres',
            unitLabel: 'pan',
          }),
        ],
      }).valid,
    ).toBe(false);

    expect(
      validateStationItemsDraft({
        stationId: 'comida_rapida',
        drafts: [
          createDefaultStationItemDraft({
            name: 'Salsa',
            unit: 'L',
            inputType: 'level',
            capacityInput: '0',
          }),
        ],
      }).valid,
    ).toBe(false);

    // Propagates non-blocking warning when ideal < mínimo
    const warningResult = validateStationItemsDraft({
      stationId: 'comida_rapida',
      drafts: [
        createDefaultStationItemDraft({
          name: 'Queso',
          unit: 'und',
          minStock: 10,
          targetStock: 4,
        }),
      ],
    });
    expect(warningResult.valid).toBe(true);
    expect(warningResult.warning).toMatch(/ideal/i);
  });

  it('round-trips InventoryItem capture fields to draft and payload helpers', () => {
    const packsDraft = inventoryItemToDraft(
      makeItem({
        id: 'comida_rapida_2',
        station: 'comida_rapida',
        name: 'Tocineta',
        unit: 'loncha',
        minStock: 20,
        targetStock: 80,
        inputType: 'packs',
        packSize: 40,
        packLabel: 'kilo',
        unitLabel: 'loncha',
      }),
    );

    expect(packsDraft).toEqual({
      id: 'comida_rapida_2',
      name: 'Tocineta',
      unit: 'loncha',
      minStock: 20,
      targetStock: 80,
      inputType: 'packs',
      packSizeInput: '40',
      packLabel: 'kilo',
      unitLabel: 'loncha',
      capacityInput: '5',
    });

    expect(buildItemCaptureFields(packsDraft)).toEqual({
      inputType: 'packs',
      packSize: 40,
      packLabel: 'kilo',
      unitLabel: 'loncha',
    });

    const levelDraft = inventoryItemToDraft(
      makeItem({
        id: 'comida_rapida_3',
        inputType: 'level',
        capacity: 3.5,
      }),
    );
    expect(levelDraft.inputType).toBe('level');
    expect(levelDraft.capacityInput).toBe('3.5');
    expect(buildItemCaptureFields(levelDraft)).toEqual({
      inputType: 'level',
      capacity: 3.5,
    });

    expect(parseCaptureDecimalInput(' 4,25 ')).toBe(4.25);
    expect(parseCaptureDecimalInput('   ')).toBeNaN();
  });

  it('builds unit selector options with descriptive labels for L and kg while keeping raw values', () => {
    const opts = getUnitSelectOptions();
    expect(opts.find((o) => o.value === 'L')).toEqual({ value: 'L', label: 'L (litros)' });
    expect(opts.find((o) => o.value === 'kg')).toEqual({ value: 'kg', label: 'kg (kilos)' });
    expect(opts.find((o) => o.value === 'und')).toEqual({ value: 'und', label: 'und' });
  });
});
