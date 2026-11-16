import { describe, expect, it, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { DEFAULT_SHIFT_SCHEDULE } from '../../constants';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  Workspace,
} from '../../types';
import {
  diagnoseEntryRuleViolations,
  DiagnosticSaveError,
  PartialBatchSaveError,
  prepareStationReportEntries,
  saveStationReportBatch,
  type BatchChunkCommitInput,
  type WorkerSaveIO,
  type WorkerSaveProgress,
} from '../workerService';

function makeWorkspace(): Workspace {
  return {
    id: 'ws_1',
    name: 'The Fire',
    ownerUid: 'owner_1',
    ownerEmail: 'jefe@restaurant.com',
    authorizedEmails: ['jefe@restaurant.com'],
    seeded: true,
    shiftSchedule: DEFAULT_SHIFT_SCHEDULE,
  };
}

function makeWorkerUser(uid = 'worker_1'): User {
  return {
    uid,
    email: 'trabajadora@restaurant.com',
    emailVerified: true,
    displayName: 'Ana',
  } as unknown as User;
}

function makeCatalogAndRows(count: number, mode: 'opening' | 'closing' = 'opening'): {
  itemsById: Record<string, InventoryItem>;
  rows: DraftEntryRow[];
} {
  const itemsById: Record<string, InventoryItem> = {};
  const rows: DraftEntryRow[] = [];

  for (let i = 1; i <= count; i++) {
    const id = `asados_${i}`;
    const name = `Insumo ${i}`;
    itemsById[id] = {
      id,
      workspaceId: 'ws_1',
      ownerUid: 'owner_1',
      authorizedEmails: ['jefe@restaurant.com'],
      station: 'asados',
      name,
      unit: 'und',
      minStock: 2,
      targetStock: 10,
      active: true,
      sortOrder: i * 10,
    };

    rows.push({
      itemId: id,
      itemName: name,
      unit: 'und',
      minStock: 2,
      targetStock: 10,
      opening: 5 + (i % 4),
      added: i % 2,
      closing: mode === 'closing' ? 3 : 0,
      hasOpening: true,
      hasClosing: mode === 'closing',
      notApplicable: false,
    });
  }

  return { itemsById, rows };
}

describe('worker batch saving (<=4 items per batch, item-by-item isolation, final report last, pending retry, idempotent, offline)', () => {
  it.each([1, 4, 5, 25, 60])(
    'commits %i items in chunks of max 4 entries with final report batch last and accurate progress',
    async (count) => {
      const workspace = makeWorkspace();
      const user = makeWorkerUser();
      const { itemsById, rows } = makeCatalogAndRows(count, 'opening');

      const entryBatchSizes: number[] = [];
      const reportStatusHistory: string[] = [];
      const progressEvents: WorkerSaveProgress[] = [];

      const io: Partial<WorkerSaveIO> = {
        syncClock: vi.fn(async () => {}),
        getServerTimestampValue: () => 'SERVER_TS',
        fetchServerItems: vi.fn(async () => ({
          itemsById,
          removedOrMovedIds: new Set<string>(),
          offlineFallback: false,
        })),
        fetchServerReport: vi.fn(async () => ({ exists: false, updatedAtMs: null })),
        fetchServerEntries: vi.fn(async () => ({})),
        commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[]) => {
          chunks.forEach((chunk) => {
            if (chunk.reportWrite) {
              reportStatusHistory.push(String(chunk.reportWrite.payload.status));
            }
            if (chunk.entryOps.length > 0) {
              entryBatchSizes.push(chunk.entryOps.length);
            }
          });
          return { queuedOffline: false };
        }),
      };

      const res = await saveStationReportBatch({
        workspace,
        user,
        canManage: false,
        date: '2026-11-15',
        station: 'asados',
        mode: 'opening',
        notes: '',
        rows,
        existingReport: undefined,
        existingEntries: {},
        expectedUpdatedAtMs: null,
        now: new Date('2026-11-15T22:00:00Z'), // 17:00 Bogota
        onProgress: (p) => progressEvents.push(p),
        io,
      });

      expect(res.savedCount).toBe(count);
      expect(res.queuedOffline).toBe(false);
      // Every entry batch has 1..4 entries (never > 4)
      expect(entryBatchSizes.every((size) => size >= 1 && size <= 4)).toBe(true);
      expect(entryBatchSizes.reduce((a, b) => a + b, 0)).toBe(count);
      expect(entryBatchSizes.length).toBe(Math.ceil(count / 4));
      // Report starts in 'open' before entries, and moves to 'opening_saved' strictly at the end
      expect(reportStatusHistory).toEqual(['open', 'opening_saved']);
      expect(progressEvents[progressEvents.length - 1]).toEqual({
        savedCount: count,
        totalCount: count,
        phase: 'report',
      });
    },
  );

  it('isolates a middle failing item in a 25-item closing, saves the other 24, keeps report non-completed, and retries only pending item to finish', async () => {
    const workspace = makeWorkspace();
    const user = makeWorkerUser();
    const { itemsById, rows } = makeCatalogAndRows(25, 'closing');

    const storedEntries: Record<string, DailyReportEntry> = {};
    let reportStatus: 'open' | 'opening_saved' | 'completed' = 'opening_saved';
    let item11ShouldFail = true;
    const retriedItemIds: string[] = [];
    const committedSizesPhase1: number[] = [];

    const existingReport: DailyReport = {
      id: 'ws_1_2026-11-15_asados',
      workspaceId: 'ws_1',
      ownerUid: 'owner_1',
      authorizedEmails: ['jefe@restaurant.com'],
      date: '2026-11-15',
      station: 'asados',
      status: 'opening_saved',
      reportedByUid: user.uid,
      reportedByName: 'Ana',
      notes: '',
    };

    const io: Partial<WorkerSaveIO> = {
      syncClock: vi.fn(async () => {}),
      getServerTimestampValue: () => 'SERVER_TS',
      fetchServerItems: vi.fn(async (_wsId: string, _st: string, itemIds: string[]) => {
        const subset: Record<string, InventoryItem> = {};
        itemIds.forEach((id: string) => {
          if (itemsById[id]) subset[id] = itemsById[id];
        });
        return {
          itemsById: subset,
          removedOrMovedIds: new Set<string>(),
          offlineFallback: false,
        };
      }),
      fetchServerReport: vi.fn(async () => ({
        exists: true,
        updatedAtMs: 1000,
        data: {
          status: reportStatus,
          reportedByUid: user.uid,
          reportedByName: 'Ana',
        },
      })),
      fetchServerEntries: vi.fn(async () => ({ ...storedEntries })),
      commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[]) => {
        for (const chunk of chunks) {
          if (chunk.entryOps.length > 0) {
            if (!item11ShouldFail) {
              chunk.entryOps.forEach((op) => retriedItemIds.push(op.itemId));
            } else {
              committedSizesPhase1.push(chunk.entryOps.length);
            }

            if (item11ShouldFail && chunk.entryOps.some((op) => op.itemId === 'asados_11')) {
              const permErr = new Error('Missing or insufficient permissions.');
              (permErr as Error & { code: string }).code = 'permission-denied';
              throw permErr;
            }

            chunk.entryOps.forEach((op) => {
              storedEntries[op.itemId] = {
                id: op.itemId,
                workspaceId: 'ws_1',
                ownerUid: 'owner_1',
                authorizedEmails: ['jefe@restaurant.com'],
                reportId: chunk.reportId,
                itemId: op.itemId,
                station: 'asados',
                date: '2026-11-15',
                itemName: op.itemName,
                unit: op.attemptedValues.unit,
                minStock: op.attemptedValues.minStock,
                targetStock: op.attemptedValues.targetStock,
                opening: op.attemptedValues.opening,
                added: op.attemptedValues.added,
                closing: op.attemptedValues.closing,
                hasOpening: op.hasOpening,
                hasClosing: op.hasClosing,
                notApplicable: op.notApplicable,
                updatedByUid: user.uid,
                updatedByName: 'Ana',
              };
            });
          }

          if (chunk.reportWrite) {
            reportStatus = chunk.reportWrite.payload.status as typeof reportStatus;
          }
        }
        return { queuedOffline: false };
      }),
      diagnoseSingleEntryFailure: vi.fn(async ({ op, reportId }) => {
        return new DiagnosticSaveError({
          title: `Error al guardar "${op.itemName}"`,
          detail: `"${op.itemName}" rechazado por permission-denied. Valores intentados: unidad="${op.attemptedValues.unit}", mínimo=${op.attemptedValues.minStock}, ideal=${op.attemptedValues.targetStock}, apertura=${op.attemptedValues.opening}, cierre=${op.attemptedValues.closing}.`,
          rawDetail: 'permission-denied in rules',
          failedDocumentPath: `dailyReports/${reportId}/entries/${op.itemId}`,
          code: 'permission-denied',
        });
      }),
    };

    const partialCallbacks: Array<Record<string, DailyReportEntry>> = [];
    let caught: unknown;
    try {
      await saveStationReportBatch({
        workspace,
        user,
        canManage: false,
        date: '2026-11-15',
        station: 'asados',
        mode: 'closing',
        notes: 'Todo ok',
        rows,
        existingReport,
        existingEntries: {},
        expectedUpdatedAtMs: 1000,
        now: new Date('2026-11-16T04:30:00Z'), // 22:30 Bogota (closing phase)
        onPartialSaved: (entries) => partialCallbacks.push(entries),
        io,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PartialBatchSaveError);
    const partialErr = caught as PartialBatchSaveError;

    // 24 saved items, 1 failed item (asados_11), and report stays at previous status ('opening_saved')
    expect(partialErr.savedItems).toHaveLength(24);
    expect(partialErr.failedItems).toHaveLength(1);
    expect(partialErr.failedItems[0].itemId).toBe('asados_11');
    expect(partialErr.failedItems[0].attemptedValues.closing).toBe(3);
    expect(partialErr.failedItems[0].reason).toContain('Insumo 11');
    expect(partialErr.remainingRows.map((r) => r.itemId)).toEqual(['asados_11']);
    expect(reportStatus).toBe('opening_saved');
    expect(Object.keys(storedEntries)).toHaveLength(24);
    expect(storedEntries['asados_11']).toBeUndefined();
    expect(partialCallbacks).toHaveLength(1);
    // Chunk 3 ([9, 10, 11, 12]) failed and immediately fell back to 4 isolated 1-item commits, then continued chunks 4..7
    expect(committedSizesPhase1).toEqual([4, 4, 4, 1, 1, 1, 1, 4, 4, 4, 1]);

    // Step 2: Fix failure cause and click "Reintentar los que faltan"
    item11ShouldFail = false;
    const retryRes = await saveStationReportBatch({
      workspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      mode: 'closing',
      notes: 'Todo ok',
      rows: partialErr.remainingRows,
      existingReport,
      existingEntries: storedEntries,
      previousSavedItems: partialErr.savedItems,
      expectedUpdatedAtMs: 1000,
      forceOverwrite: true,
      now: new Date('2026-11-16T04:30:00Z'),
      io,
    });

    expect(retriedItemIds).toEqual(['asados_11']);
    expect(retryRes.savedCount).toBe(25);
    expect(Object.keys(storedEntries)).toHaveLength(25);
    expect(storedEntries['asados_11'].hasClosing).toBe(true);
    expect(reportStatus).toBe('completed');
  });

  it('is idempotent when saving the same item twice (updates existing entry ID without duplicating)', async () => {
    const workspace = makeWorkspace();
    const user = makeWorkerUser();
    const { itemsById, rows } = makeCatalogAndRows(4, 'opening');

    const storedEntries: Record<string, DailyReportEntry> = {};
    let storedReport: DailyReport | undefined;
    const commitOpsKinds: string[] = [];

    const io: Partial<WorkerSaveIO> = {
      syncClock: vi.fn(async () => {}),
      getServerTimestampValue: () => 'SERVER_TS',
      fetchServerItems: vi.fn(async () => ({
        itemsById,
        removedOrMovedIds: new Set<string>(),
        offlineFallback: false,
      })),
      fetchServerReport: vi.fn(async () =>
        storedReport
          ? {
              exists: true,
              updatedAtMs: 1000,
              data: storedReport,
            }
          : { exists: false, updatedAtMs: null },
      ),
      fetchServerEntries: vi.fn(async () => ({ ...storedEntries })),
      commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[]) => {
        chunks.forEach((chunk) => {
          chunk.entryOps.forEach((op) => {
            commitOpsKinds.push(`${op.itemId}:${op.kind}`);
            storedEntries[op.itemId] = {
              id: op.itemId,
              workspaceId: 'ws_1',
              ownerUid: 'owner_1',
              authorizedEmails: ['jefe@restaurant.com'],
              reportId: chunk.reportId,
              itemId: op.itemId,
              station: 'asados',
              date: '2026-11-15',
              itemName: op.itemName,
              unit: op.attemptedValues.unit,
              minStock: op.attemptedValues.minStock,
              targetStock: op.attemptedValues.targetStock,
              opening: op.attemptedValues.opening,
              added: op.attemptedValues.added,
              closing: op.attemptedValues.closing,
              hasOpening: op.hasOpening,
              hasClosing: op.hasClosing,
              notApplicable: op.notApplicable,
              updatedByUid: user.uid,
              updatedByName: 'Ana',
            };
          });
          if (chunk.reportWrite) {
            storedReport = {
              id: chunk.reportId,
              workspaceId: 'ws_1',
              ownerUid: 'owner_1',
              authorizedEmails: ['jefe@restaurant.com'],
              date: '2026-11-15',
              station: 'asados',
              status: chunk.reportWrite.payload.status as DailyReport['status'],
              reportedByUid: user.uid,
              reportedByName: 'Ana',
              notes: '',
            };
          }
        });
        return { queuedOffline: false };
      }),
    };

    await saveStationReportBatch({
      workspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      mode: 'opening',
      notes: '',
      rows,
      existingReport: undefined,
      existingEntries: {},
      expectedUpdatedAtMs: null,
      now: new Date('2026-11-15T22:00:00Z'),
      io,
    });

    await saveStationReportBatch({
      workspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      mode: 'opening',
      notes: '',
      rows,
      existingReport: storedReport,
      existingEntries: storedEntries,
      expectedUpdatedAtMs: 1000,
      forceOverwrite: true,
      now: new Date('2026-11-15T22:00:00Z'),
      io,
    });

    expect(Object.keys(storedEntries)).toEqual([
      'asados_1',
      'asados_2',
      'asados_3',
      'asados_4',
    ]);
    expect(commitOpsKinds).toEqual([
      'asados_1:set',
      'asados_2:set',
      'asados_3:set',
      'asados_4:set',
      'asados_1:update',
      'asados_2:update',
      'asados_3:update',
      'asados_4:update',
    ]);
  });

  it('respects offline mode by queuing chunks of <=4 entries plus final report chunk', async () => {
    const workspace = makeWorkspace();
    const user = makeWorkerUser();
    const { itemsById, rows } = makeCatalogAndRows(9, 'opening');

    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: false },
    });

    try {
      let capturedChunks: BatchChunkCommitInput[] = [];
      let offlineFlagUsed = false;

      const io: Partial<WorkerSaveIO> = {
        syncClock: vi.fn(async () => {}),
        getServerTimestampValue: () => 'SERVER_TS',
        fetchServerItems: vi.fn(async () => ({
          itemsById,
          removedOrMovedIds: new Set<string>(),
          offlineFallback: true,
        })),
        fetchServerReport: vi.fn(async () => ({ exists: false, updatedAtMs: null, offline: true })),
        fetchServerEntries: vi.fn(async () => ({})),
        commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[], offline: boolean) => {
          capturedChunks = chunks;
          offlineFlagUsed = offline;
          return { queuedOffline: true };
        }),
      };

      const res = await saveStationReportBatch({
        workspace,
        user,
        canManage: false,
        date: '2026-11-15',
        station: 'asados',
        mode: 'opening',
        notes: '',
        rows,
        existingReport: undefined,
        existingEntries: {},
        expectedUpdatedAtMs: null,
        now: new Date('2026-11-15T22:00:00Z'),
        io,
      });

      expect(res.queuedOffline).toBe(true);
      expect(res.savedCount).toBe(9);
      expect(offlineFlagUsed).toBe(true);
      // 3 entry chunks (4 + 4 + 1) + 1 final report chunk
      expect(capturedChunks).toHaveLength(4);
      expect(capturedChunks.slice(0, 3).map((c) => c.entryOps.length)).toEqual([4, 4, 1]);
      expect(capturedChunks[0].reportWrite?.payload.status).toBe('open');
      expect(capturedChunks[3].entryOps).toHaveLength(0);
      expect(capturedChunks[3].reportWrite?.payload.status).toBe('opening_saved');
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator,
      });
    }
  });

  it('sanitizes invalid openingStatus, non-finite previousClosing, and whitespace displayName in prepareStationReportEntries & saveStationReportBatch', async () => {
    const workspace = makeWorkspace();
    const user = {
      uid: 'worker_1',
      email: 'ana@restaurant.com',
      emailVerified: true,
      displayName: '   ',
    } as unknown as User;

    const dirtyRow = {
      itemId: 'asados_1',
      itemName: 'TOCINETA',
      unit: 'und',
      minStock: 90,
      targetStock: 150,
      opening: 183,
      added: 61,
      closing: 152,
      hasOpening: true,
      hasClosing: true,
      notApplicable: false,
      previousClosing: Number.NaN,
      openingStatus: '' as unknown as DailyReportEntry['openingStatus'],
    } satisfies DraftEntryRow;

    const ops = prepareStationReportEntries({
      workspace,
      userUid: user.uid,
      reporterName: '   ',
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      reportId: 'ws_1_2026-11-15_asados',
      mode: 'closing',
      rows: [dirtyRow],
      mergedExistingEntries: {},
      authorizedEmails: ['jefe@restaurant.com'],
      timestampValue: 'SERVER_TS',
    });

    expect(ops).toHaveLength(1);
    expect(ops[0].createFields.updatedByName).toBe('Encargada');
    expect(ops[0].createFields.previousClosing).toBeUndefined();
    expect(ops[0].createFields.openingStatus).toBe('manual');

    let committedReporterName = '';
    const { itemsById } = makeCatalogAndRows(1, 'closing');
    itemsById.asados_1.name = 'TOCINETA';
    itemsById.asados_1.minStock = 90;
    itemsById.asados_1.targetStock = 150;

    await saveStationReportBatch({
      workspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      mode: 'closing',
      notes: '',
      rows: [dirtyRow],
      existingReport: undefined,
      existingEntries: {},
      expectedUpdatedAtMs: null,
      now: new Date('2026-11-16T04:30:00Z'),
      io: {
        syncClock: vi.fn(async () => {}),
        getServerTimestampValue: () => 'SERVER_TS',
        fetchServerItems: vi.fn(async () => ({
          itemsById,
          removedOrMovedIds: new Set<string>(),
          offlineFallback: false,
        })),
        fetchServerReport: vi.fn(async () => ({ exists: false, updatedAtMs: null })),
        fetchServerEntries: vi.fn(async () => ({})),
        commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[]) => {
          chunks.forEach((c) => {
            if (c.reportWrite) {
              committedReporterName = String(c.reportWrite.payload.reportedByName ?? '');
            }
          });
          return { queuedOffline: false };
        }),
      },
    });

    expect(committedReporterName).toBe('ana');
  });

  it('syncs stale/empty workspace authorizedEmails & ownerUid from server before committing entries', async () => {
    const staleWorkspace: Workspace = {
      id: 'ws_1',
      name: 'The Fire',
      ownerUid: '',
      ownerEmail: '',
      authorizedEmails: [],
      seeded: true,
      shiftSchedule: { ...DEFAULT_SHIFT_SCHEDULE, enabled: false },
    };
    const freshServerWorkspace: Workspace = {
      ...makeWorkspace(),
      shiftSchedule: { ...DEFAULT_SHIFT_SCHEDULE, enabled: false },
    };
    const user = makeWorkerUser();
    const { itemsById, rows } = makeCatalogAndRows(2, 'closing');

    const createdPayloads: Array<Record<string, unknown>> = [];
    await saveStationReportBatch({
      workspace: staleWorkspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      mode: 'closing',
      notes: '',
      rows,
      existingReport: undefined,
      existingEntries: {},
      expectedUpdatedAtMs: null,
      now: new Date('2026-11-16T00:47:00Z'), // 19:47 Bogota
      io: {
        syncClock: vi.fn(async () => {}),
        getServerTimestampValue: () => 'SERVER_TS',
        fetchServerWorkspace: vi.fn(async () => freshServerWorkspace),
        fetchServerItems: vi.fn(async () => ({
          itemsById,
          removedOrMovedIds: new Set<string>(),
          offlineFallback: false,
        })),
        fetchServerReport: vi.fn(async () => ({ exists: false, updatedAtMs: null })),
        fetchServerEntries: vi.fn(async () => ({})),
        commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[]) => {
          chunks.forEach((c) => {
            c.entryOps.forEach((op) => createdPayloads.push(op.createFields));
          });
          return { queuedOffline: false };
        }),
      },
    });

    expect(createdPayloads).toHaveLength(2);
    expect(createdPayloads[0].ownerUid).toBe('owner_1');
    expect(createdPayloads[0].authorizedEmails).toEqual(['jefe@restaurant.com']);
  });

  it('diagnoseEntryRuleViolations never swallows read failures and pinpoints rule mismatches', () => {
    const workspace = makeWorkspace();
    const user = makeWorkerUser();
    const { rows } = makeCatalogAndRows(1, 'closing');
    const [op] = prepareStationReportEntries({
      workspace,
      userUid: user.uid,
      reporterName: 'Ana',
      canManage: false,
      date: '2026-11-15',
      station: 'comida_rapida',
      reportId: 'ws_1_2026-11-15_comida_rapida',
      mode: 'closing',
      rows,
      mergedExistingEntries: {},
      authorizedEmails: ['jefe@restaurant.com'],
      timestampValue: 'SERVER_TS',
    });

    const diag = diagnoseEntryRuleViolations({
      entryError: Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      }),
      workspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'comida_rapida',
      reportId: 'ws_1_2026-11-15_comida_rapida',
      op,
      now: new Date('2026-11-16T00:47:00Z'), // 19:47 Bogota (outside default enabled schedule)
      itemProbe: {
        exists: true,
        data: {
          workspaceId: 'ws_1',
          station: 'comida_rapida',
          name: op.itemName,
          unit: 'und',
          minStock: 2,
          targetStock: 10,
        },
      },
      reportProbe: {
        exists: true,
        data: {
          workspaceId: 'ws_1',
          ownerUid: 'other_owner',
          date: '2026-11-15',
          station: 'comida_rapida',
          status: 'open',
        },
      },
      workspaceProbe: {
        exists: true,
        data: {
          ownerUid: 'owner_1',
          shiftSchedule: DEFAULT_SHIFT_SCHEDULE,
        },
      },
      entryProbe: {
        exists: false,
        errorCode: 'permission-denied',
        errorMessage: 'entry get denied',
      },
      memberProbe: {
        exists: true,
        data: {
          active: true,
          workspaceId: 'ws_1',
          station: 'hamburguesas', // legacy equivalent for comida_rapida should pass
        },
      },
    });

    expect(diag.reasons).toContain('ownerUid del reporte (other_owner) ≠ "owner_1"');
    expect(diag.reasons).toContain(
      'no se pudo verificar entrada en servidor (permission-denied: entry get denied)',
    );
    expect(diag.reasons.some((r) => r.includes('fuera de horario'))).toBe(true);
    expect(diag.reasons.some((r) => r.includes('teamMembers.station'))).toBe(false);
    expect(diag.error.rawDetail).toContain('Estado servidor:');
    expect(diag.error.rawDetail).toContain('Evaluación por condición de regla:');
    expect(diag.evaluations).toHaveLength(8);
    expect(diag.evaluations.find((e) => e.condition.startsWith('5.'))?.passed).toBe(true);
    expect(diag.evaluations.find((e) => e.condition.startsWith('6.'))?.passed).toBe(false);
    expect(diag.evaluations.find((e) => e.condition.startsWith('8.'))?.passed).toBe(false);
  });

  it('detects non-padded shiftSchedule hours (e.g. "1:00") and unitLabel matching for packs in diagnoseEntryRuleViolations', () => {
    const workspace = makeWorkspace();
    const user = makeWorkerUser();
    const { rows } = makeCatalogAndRows(1, 'closing');
    rows[0].unit = 'unid';
    const [op] = prepareStationReportEntries({
      workspace,
      userUid: user.uid,
      reporterName: 'Ana',
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      reportId: 'ws_1_2026-11-15_asados',
      mode: 'closing',
      rows,
      mergedExistingEntries: {},
      authorizedEmails: ['jefe@restaurant.com'],
      timestampValue: 'SERVER_TS',
    });

    const diag = diagnoseEntryRuleViolations({
      entryError: Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      }),
      workspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      reportId: 'ws_1_2026-11-15_asados',
      op,
      now: new Date('2026-11-15T22:40:00Z'), // 17:40 Bogota
      itemProbe: {
        exists: true,
        data: {
          workspaceId: 'ws_1',
          station: 'asados',
          name: op.itemName,
          unit: 'paq',
          unitLabel: 'unid',
          inputType: 'packs',
          minStock: 2,
          targetStock: 10,
        },
      },
      reportProbe: {
        exists: true,
        data: {
          workspaceId: 'ws_1',
          ownerUid: 'owner_1',
          date: '2026-11-15',
          station: 'asados',
          status: 'opening_saved',
        },
      },
      workspaceProbe: {
        exists: true,
        data: {
          ownerUid: 'owner_1',
          shiftSchedule: {
            enabled: true,
            openingStart: '10:00',
            openingEnd: '15:00',
            closingStart: '16:00',
            closingEnd: '1:00', // non-padded hour in server doc
          },
        },
      },
      entryProbe: {
        exists: false,
      },
      memberProbe: {
        exists: true,
        data: {
          active: true,
          workspaceId: 'ws_1',
          station: 'asados',
        },
      },
    });

    // Catalog evaluation passes because unitLabel === 'unid' matches op.createFields.unit === 'unid'
    expect(diag.evaluations.find((e) => e.condition.startsWith('4.'))?.passed).toBe(true);
    // Schedule evaluation pinpoints the non-padded "1:00" format on workspaces/{id}
    expect(diag.evaluations.find((e) => e.condition.startsWith('8.'))?.passed).toBe(false);
    expect(diag.reasons.some((r) => r.includes('closingEnd tiene formato "1:00"'))).toBe(true);
  });
});


