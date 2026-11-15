import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import type { DailyReport, DailyReportEntry, InventoryItem, Workstation } from '../../types';
import {
  buildRestaurantBackupCsvContent,
  chunkResetTasks,
  countResetTasksByCategory,
  executeChunkedResetTasks,
  formatPendingResetSummary,
  isResetConfirmationValid,
  MAX_RESET_BATCH_SIZE,
  PartialResetError,
  sortResetTasks,
  type ResetExecutionProgress,
  type ResetTaskItem,
} from '../reset';

describe('restaurant reset utilities', () => {
  it('validates the exact REINICIAR confirmation word', () => {
    expect(isResetConfirmationValid('REINICIAR')).toBe(true);
    expect(isResetConfirmationValid('  REINICIAR  ')).toBe(true);
    expect(isResetConfirmationValid('reiniciar')).toBe(false);
    expect(isResetConfirmationValid('Reiniciar')).toBe(false);
    expect(isResetConfirmationValid('REINICIA')).toBe(false);
    expect(isResetConfirmationValid('')).toBe(false);
  });

  it('orders entries before reports and items/links before stations, then chunks into small batches', () => {
    const unordered: ResetTaskItem[] = [
      { category: 'stations', path: 'stations/mesera', label: 'Mesera' },
      { category: 'reports', path: 'dailyReports/r1', label: '2026-11-14' },
      { category: 'teamMembers', path: 'teamMembers/u1', label: 'Ana' },
      { category: 'items', path: 'items/mesera_1', label: 'Coca-Cola' },
      { category: 'entries', path: 'dailyReports/r1/entries/mesera_1', label: 'Coca-Cola' },
      { category: 'stationLinks', path: 'stationLinks/code1', label: 'Link Mesera' },
      { category: 'invites', path: 'invites/inv1', label: 'ana@test.com' },
    ];

    const sorted = sortResetTasks(unordered);
    expect(sorted.map((t) => t.category)).toEqual([
      'entries',
      'reports',
      'items',
      'stationLinks',
      'stations',
      'invites',
      'teamMembers',
    ]);

    const manyTasks: ResetTaskItem[] = Array.from({ length: 45 }, (_, idx) => ({
      category: idx < 30 ? 'entries' : 'reports',
      path: idx < 30 ? `dailyReports/r1/entries/i${idx}` : `dailyReports/r${idx}`,
      label: `Task ${idx}`,
    }));

    const chunks = chunkResetTasks(manyTasks);
    expect(MAX_RESET_BATCH_SIZE).toBe(8);
    expect(chunks).toHaveLength(6);
    expect(chunks[0]).toHaveLength(8);
    expect(chunks[4]).toHaveLength(8);
    expect(chunks[5]).toHaveLength(5);
  });

  it('tracks progress across small batches, reports exact pending items on mid-flight failure, and resumes cleanly', async () => {
    const tasks: ResetTaskItem[] = [
      ...Array.from({ length: 32 }, (_, idx) => ({
        category: 'entries' as const,
        path: `dailyReports/r1/entries/item_${idx}`,
        label: `Insumo ${idx}`,
      })),
      ...Array.from({ length: 13 }, (_, idx) => ({
        category: 'reports' as const,
        path: `dailyReports/r_${idx}`,
        label: `Reporte ${idx}`,
      })),
    ];

    const committedPaths: string[] = [];
    const progressEvents: ResetExecutionProgress[] = [];
    let commitCallCount = 0;

    let caughtError: PartialResetError | null = null;
    try {
      await executeChunkedResetTasks({
        tasks,
        onProgress: (p) => progressEvents.push(p),
        commitChunk: async (chunk) => {
          commitCallCount += 1;
          if (commitCallCount === 2) {
            throw new Error('unavailable: network interrupted');
          }
          committedPaths.push(...chunk.map((c) => c.path));
        },
      });
    } catch (err) {
      caughtError = err as PartialResetError;
    }

    expect(caughtError).toBeInstanceOf(PartialResetError);
    expect(caughtError?.deletedCount).toBe(8);
    expect(caughtError?.totalCount).toBe(45);
    expect(caughtError?.pendingTasks).toHaveLength(37);
    expect(caughtError?.pendingByCategory.entries).toBe(24);
    expect(caughtError?.pendingByCategory.reports).toBe(13);
    expect(formatPendingResetSummary(caughtError!.pendingByCategory)).toBe(
      '24 conteos de insumos, 13 reportes diarios',
    );
    expect(progressEvents.some((p) => p.deletedCount === 8)).toBe(true);

    // Retry ONLY the remaining 37 pending tasks
    const retryResult = await executeChunkedResetTasks({
      tasks: caughtError!.pendingTasks,
      commitChunk: async (chunk) => {
        committedPaths.push(...chunk.map((c) => c.path));
      },
    });

    expect(retryResult).toEqual({ deletedCount: 37, totalCount: 37 });
    expect(committedPaths).toHaveLength(45);
    expect(new Set(committedPaths).size).toBe(45);
    expect(countResetTasksByCategory(tasks)).toEqual({
      entries: 32,
      reports: 13,
      items: 0,
      stationLinks: 0,
      stations: 0,
      invites: 0,
      teamMembers: 0,
    });
  });

  it('builds a complete backup CSV with stations, items (active+archived), reports, and formula protection', () => {
    const now = Timestamp.fromMillis(1700000000000);
    const stations: Workstation[] = [
      {
        id: 'mesera',
        workspaceId: 'restaurante_principal',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@test.com'],
        name: 'Mesera',
        area: 'Barra',
        workerName: 'Ana',
        description: '=CMD("evil")',
        accessCode: 'code_1',
        nextItemSlot: 2,
        active: true,
        sortOrder: 10,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const items: InventoryItem[] = [
      {
        id: 'mesera_1',
        workspaceId: 'restaurante_principal',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@test.com'],
        station: 'mesera',
        name: 'Tocineta',
        unit: 'loncha',
        minStock: 40,
        targetStock: 120,
        inputType: 'packs',
        packSize: 40,
        packLabel: 'kilo',
        unitLabel: 'loncha',
        active: true,
        sortOrder: 10,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'mesera_2',
        workspaceId: 'restaurante_principal',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@test.com'],
        station: 'mesera',
        name: 'Aceite Viejo',
        unit: 'L',
        minStock: 2,
        targetStock: 5,
        inputType: 'level',
        capacity: 5,
        active: false,
        sortOrder: 20,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const repId = 'restaurante_principal_2026-11-14_mesera';
    const reports: DailyReport[] = [
      {
        id: repId,
        workspaceId: 'restaurante_principal',
        ownerUid: 'owner_1',
        authorizedEmails: ['boss@test.com'],
        date: '2026-11-14',
        station: 'mesera',
        status: 'completed',
        reportedByUid: 'w1',
        reportedByName: 'Ana',
        notes: '+SUM(A1:A2)',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const entriesByReportId: Record<string, Record<string, DailyReportEntry>> = {
      [repId]: {
        mesera_1: {
          id: 'mesera_1',
          workspaceId: 'restaurante_principal',
          ownerUid: 'owner_1',
          authorizedEmails: ['boss@test.com'],
          reportId: repId,
          itemId: 'mesera_1',
          station: 'mesera',
          date: '2026-11-14',
          itemName: 'Tocineta',
          unit: 'loncha',
          minStock: 40,
          targetStock: 120,
          opening: 80,
          added: 40,
          closing: 50,
          hasOpening: true,
          hasClosing: true,
          notApplicable: false,
          previousClosing: 80,
          openingStatus: 'confirmed_match',
          updatedByUid: 'w1',
          updatedByName: 'Ana',
          createdAt: now,
          updatedAt: now,
        },
      },
    };

    const csv = buildRestaurantBackupCsvContent({
      workspaceName: 'The Fire',
      stations,
      items,
      reports,
      entriesByReportId,
    });

    const lines = csv.split('\n');
    expect(lines).toHaveLength(6); // header + 1 station + 2 items + 1 report + 1 entry
    expect(lines[1]).toContain('"PUESTO"');
    expect(lines[1]).toContain('"\'=CMD(""evil"")"');
    expect(lines[2]).toContain('"INSUMO"');
    expect(lines[2]).toContain('"packs (1 kilo = 40 loncha)"');
    expect(lines[3]).toContain('"Archivado"');
    expect(lines[4]).toContain('"REPORTE"');
    expect(lines[4]).toContain('"\'+SUM(A1:A2)"');
    expect(lines[5]).toContain('"DETALLE_REPORTE"');
    expect(lines[5]).toContain('"70"'); // consumed = 80 + 40 - 50
  });
});
