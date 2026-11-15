import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import { DEFAULT_SHIFT_SCHEDULE } from '../../constants';
import type { DailyReport, DailyReportEntry, DraftEntryRow, InventoryItem, Workspace } from '../../types';
import {
  buildNormalizedAuthorizedEmails,
  DiagnosticSaveError,
  prepareStationReportEntries,
  validateWorkerSubmitPhase,
} from '../workerService';
import { buildConsolidatedRows } from '../../utils/inventory';
import { buildWorkerClosingReferenceText } from '../../components/shift/ShiftMobileItemCard';

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws_1',
    name: 'The Fire',
    ownerUid: 'owner_1',
    ownerEmail: 'JEFE@Restaurant.COM ',
    authorizedEmails: ['socio@restaurant.com'],
    seeded: true,
    shiftSchedule: DEFAULT_SHIFT_SCHEDULE,
    ...overrides,
  };
}

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'mesera_1',
    workspaceId: 'ws_1',
    ownerUid: 'owner_1',
    authorizedEmails: ['jefe@restaurant.com'],
    station: 'mesera',
    name: 'Coca-Cola 400ml',
    unit: 'und',
    minStock: 10,
    targetStock: 30,
    active: true,
    sortOrder: 10,
    ...overrides,
  };
}

describe('worker opening visibility, phase validation, and closing reference', () => {
  it('reproduces opening saved with values and verifies boss consolidated view displays every item immediately', () => {
    const workspace = makeWorkspace();
    const itemA = makeItem({ id: 'mesera_1', name: 'Coca-Cola', minStock: 10, targetStock: 30 });
    const itemB = makeItem({ id: 'mesera_2', name: 'Agua', minStock: 8, targetStock: 24 });

    const draftRows: DraftEntryRow[] = [
      {
        itemId: itemA.id,
        itemName: itemA.name,
        unit: itemA.unit,
        minStock: itemA.minStock,
        targetStock: itemA.targetStock,
        opening: 18,
        added: 12,
        closing: 0,
        hasOpening: true,
        hasClosing: false,
        notApplicable: false,
      },
      {
        itemId: itemB.id,
        itemName: itemB.name,
        unit: itemB.unit,
        minStock: itemB.minStock,
        targetStock: itemB.targetStock,
        opening: 0,
        added: 0,
        closing: 0,
        hasOpening: false,
        hasClosing: false,
        notApplicable: true,
      },
    ];

    const normalizedEmails = buildNormalizedAuthorizedEmails(workspace);
    // Boss owner email is ALWAYS normalized and included even if missing/uppercase in workspace.authorizedEmails
    expect(normalizedEmails).toContain('jefe@restaurant.com');
    expect(normalizedEmails).toContain('socio@restaurant.com');

    const ops = prepareStationReportEntries({
      workspace,
      userUid: 'worker_1',
      reporterName: 'Ana',
      canManage: false,
      date: '2026-11-13',
      station: 'mesera',
      reportId: 'ws_1_2026-11-13_mesera',
      mode: 'opening',
      rows: draftRows,
      mergedExistingEntries: {},
      authorizedEmails: normalizedEmails,
      timestampValue: Timestamp.now(),
    });

    expect(ops).toHaveLength(2);
    expect(ops[0].hasOpening).toBe(true);
    expect(ops[0].createFields.opening).toBe(18);
    expect(ops[0].createFields.added).toBe(12);
    expect(ops[1].notApplicable).toBe(true);

    // Feed saved entries + opening_saved report into boss consolidated selector
    const entriesByItemId: Record<string, DailyReportEntry> = {};
    ops.forEach((op) => {
      entriesByItemId[op.itemId] = {
        id: op.itemId,
        ...(op.createFields as unknown as Omit<DailyReportEntry, 'id'>),
      };
    });

    const report: DailyReport = {
      id: 'ws_1_2026-11-13_mesera',
      workspaceId: 'ws_1',
      ownerUid: 'owner_1',
      authorizedEmails: normalizedEmails,
      date: '2026-11-13',
      station: 'mesera',
      status: 'opening_saved',
      reportedByUid: 'worker_1',
      reportedByName: 'Ana',
      notes: '',
    };

    const consolidated = buildConsolidatedRows([itemA, itemB], entriesByItemId, {
      mesera: report,
    });
    expect(consolidated[0].entry?.hasOpening).toBe(true);
    expect(consolidated[0].entry?.opening).toBe(18);
    expect(consolidated[0].entry?.added).toBe(12);
    expect(consolidated[0].isProvisional).toBe(true);
    expect(consolidated[0].provisionalStock).toBe(30);
    expect(consolidated[1].isNotApplicable).toBe(true);
  });

  it('rejects saving opening when zero items are counted or marked N/A (prevents empty opening_saved reports)', () => {
    const workspace = makeWorkspace();
    const emptyRows: DraftEntryRow[] = [
      {
        itemId: 'mesera_1',
        itemName: 'Coca-Cola',
        unit: 'und',
        minStock: 10,
        targetStock: 30,
        opening: 10, // preloaded yesterday value not confirmed yet!
        added: 0,
        closing: 0,
        hasOpening: false,
        hasClosing: false,
        notApplicable: false,
        previousClosing: 10,
      },
    ];

    let caught: DiagnosticSaveError | null = null;
    try {
      prepareStationReportEntries({
        workspace,
        userUid: 'worker_1',
        reporterName: 'Ana',
        canManage: false,
        date: '2026-11-13',
        station: 'mesera',
        reportId: 'ws_1_2026-11-13_mesera',
        mode: 'opening',
        rows: emptyRows,
        mergedExistingEntries: {},
        authorizedEmails: buildNormalizedAuthorizedEmails(workspace),
        timestampValue: Timestamp.now(),
      });
    } catch (err) {
      caught = err as DiagnosticSaveError;
    }

    expect(caught).toBeInstanceOf(DiagnosticSaveError);
    expect(caught?.code).toBe('no-opening-items');
  });

  it('rejects worker opening save with phase-mismatch error once server clock enters closing phase', () => {
    // 23:10 Bogota = 04:10Z -> inside closing phase
    expect(() =>
      validateWorkerSubmitPhase({
        canManage: false,
        mode: 'opening',
        schedule: DEFAULT_SHIFT_SCHEDULE,
        now: new Date('2026-11-14T04:10:00Z'),
        reportPath: 'dailyReports/r1',
      }),
    ).toThrowError(DiagnosticSaveError);

    try {
      validateWorkerSubmitPhase({
        canManage: false,
        mode: 'opening',
        schedule: DEFAULT_SHIFT_SCHEDULE,
        now: new Date('2026-11-14T04:10:00Z'),
        reportPath: 'dailyReports/r1',
      });
    } catch (err) {
      expect((err as DiagnosticSaveError).code).toBe('phase-mismatch');
      expect((err as DiagnosticSaveError).detail).toContain('Ya empezó el cierre');
    }

    // Boss (canManage=true) bypasses schedule restriction
    expect(() =>
      validateWorkerSubmitPhase({
        canManage: true,
        mode: 'opening',
        schedule: DEFAULT_SHIFT_SCHEDULE,
        now: new Date('2026-11-14T04:10:00Z'),
        reportPath: 'dailyReports/r1',
      }),
    ).not.toThrow();
  });

  it('builds gray inline closing reference text showing opening and restock amounts cleanly', () => {
    const item = makeItem({ unit: 'und' });
    const rowWithOpening: DraftEntryRow = {
      itemId: item.id,
      itemName: item.name,
      unit: item.unit,
      minStock: item.minStock,
      targetStock: item.targetStock,
      opening: 12,
      added: 6,
      closing: 0,
      hasOpening: true,
      hasClosing: false,
      notApplicable: false,
    };
    expect(buildWorkerClosingReferenceText(rowWithOpening, item)).toBe(
      'Hoy empezó con 12 und, llegó 6 und',
    );

    const rowWithoutRestock: DraftEntryRow = { ...rowWithOpening, added: 0 };
    expect(buildWorkerClosingReferenceText(rowWithoutRestock, item)).toBe(
      'Hoy empezó con 12 und, llegó 0',
    );
  });
});
