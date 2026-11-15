import { describe, expect, it, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { DEFAULT_SHIFT_SCHEDULE } from '../../constants';
import type { DraftEntryRow, InventoryItem, Workspace } from '../../types';
import {
  DiagnosticSaveError,
  PartialBatchSaveError,
  reconcileRowsWithServerCatalog,
  saveStationReportBatch,
  type BatchChunkCommitInput,
  type ServerReportReadResult,
  type WorkerSaveIO,
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

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'asados_1',
    workspaceId: 'ws_1',
    ownerUid: 'owner_1',
    authorizedEmails: ['jefe@restaurant.com'],
    station: 'asados',
    name: 'Queso',
    unit: 'kg',
    minStock: 2,
    targetStock: 5,
    active: true,
    sortOrder: 10,
    ...overrides,
  };
}

function makeDraftRow(overrides: Partial<DraftEntryRow> = {}): DraftEntryRow {
  return {
    itemId: 'asados_1',
    itemName: 'Queso',
    unit: 'kg',
    minStock: 2,
    targetStock: 5,
    opening: 40,
    added: 20,
    closing: 0,
    hasOpening: true,
    hasClosing: false,
    notApplicable: false,
    ...overrides,
  };
}

describe('worker catalog pre-save sync and catalog-mismatch retry', () => {
  it('reads updated item metadata from server right before saving so stale open screen values do not trigger permission-denied', async () => {
    const workspace = makeWorkspace();
    const user = makeWorkerUser();
    // Screen was opened when Queso had unit 'kg', minStock 2, targetStock 5
    const staleRow = makeDraftRow();

    // Boss edited the item in catalog before worker pressed Guardar
    const serverQueso = makeItem({
      name: 'Queso loncheado',
      unit: 'loncha',
      minStock: 30,
      targetStock: 90,
    });

    const committedPayloads: Array<{
      itemId: string;
      itemName: unknown;
      unit: unknown;
      minStock: unknown;
      targetStock: unknown;
    }> = [];

    const onCatalogSynced = vi.fn();
    const onStatusMessage = vi.fn();

    const io: Partial<WorkerSaveIO> = {
      syncClock: vi.fn(async () => {}),
      getServerTimestampValue: () => 'SERVER_TS',
      fetchServerItems: vi.fn(async () => ({
        itemsById: { [serverQueso.id]: serverQueso },
        removedOrMovedIds: new Set<string>(),
        offlineFallback: false,
      })),
      fetchServerReport: vi.fn(async () => ({
        exists: false,
        updatedAtMs: null,
      })),
      fetchServerEntries: vi.fn(async () => ({})),
      commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[]) => {
        chunks.forEach((c) =>
          c.entryOps.forEach((op) => {
            committedPayloads.push({
              itemId: op.itemId,
              itemName: op.createFields.itemName,
              unit: op.createFields.unit,
              minStock: op.createFields.minStock,
              targetStock: op.createFields.targetStock,
            });
          }),
        );
        return { queuedOffline: false };
      }),
    };

    const result = await saveStationReportBatch({
      workspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      mode: 'opening',
      notes: '',
      rows: [staleRow],
      existingReport: undefined,
      existingEntries: {},
      expectedUpdatedAtMs: null,
      now: new Date('2026-11-15T22:00:00Z'), // 17:00 Bogota (opening phase)
      onStatusMessage,
      onCatalogSynced,
      io,
    });

    expect(result.catalogUpdatedDuringSave).toBe(true);
    expect(result.savedCount).toBe(1);
    expect(io.fetchServerItems).toHaveBeenCalledTimes(1);
    // 1) open report header, 2) entry chunk, 3) final opening_saved report update
    expect(io.commitChunks).toHaveBeenCalledTimes(3);
    expect(committedPayloads).toEqual([
      {
        itemId: 'asados_1',
        itemName: 'Queso loncheado',
        unit: 'loncha',
        minStock: 30,
        targetStock: 90,
      },
    ]);
    expect(onCatalogSynced).toHaveBeenCalledWith([serverQueso]);
    expect(onStatusMessage).not.toHaveBeenCalled();
  });

  it('refreshes items and retries ONCE with status message when boss changes catalog right as save executes', async () => {
    const workspace = makeWorkspace();
    const user = makeWorkerUser();
    const row = makeDraftRow();

    const oldServerItem = makeItem();
    const updatedServerItem = makeItem({
      name: 'Queso doble crema',
      unit: 'loncha',
      minStock: 40,
      targetStock: 120,
    });

    let serverItemFetchCount = 0;
    let entryCommitAttempt = 0;
    const committedUnits: unknown[] = [];
    const committedReportStatuses: unknown[] = [];
    const onStatusMessage = vi.fn();
    const onCatalogSynced = vi.fn();

    const io: Partial<WorkerSaveIO> = {
      syncClock: vi.fn(async () => {}),
      getServerTimestampValue: () => 'SERVER_TS',
      fetchServerItems: vi.fn(async () => {
        serverItemFetchCount += 1;
        // Attempt 0 sees old item right before boss saves; Attempt 1 sees updated item
        const item = serverItemFetchCount === 1 ? oldServerItem : updatedServerItem;
        return {
          itemsById: { [item.id]: item },
          removedOrMovedIds: new Set<string>(),
          offlineFallback: false,
        };
      }),
      fetchServerReport: vi.fn(async (): Promise<ServerReportReadResult> => ({
        exists: false,
        updatedAtMs: null,
      })),
      fetchServerEntries: vi.fn(async () => ({})),
      commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[]) => {
        const hasEntries = chunks.some((c) => c.entryOps.length > 0);
        if (hasEntries) {
          entryCommitAttempt += 1;
          if (entryCommitAttempt === 1) {
            const permErr = new Error('Missing or insufficient permissions.');
            (permErr as Error & { code: string }).code = 'permission-denied';
            throw permErr;
          }
        }
        chunks.forEach((c) => {
          if (c.reportWrite) {
            committedReportStatuses.push(c.reportWrite.payload.status);
          }
          c.entryOps.forEach((op) => {
            committedUnits.push(op.createFields.unit);
          });
        });
        return { queuedOffline: false };
      }),
      diagnoseChunkFailure: vi.fn(async () => {
        throw new DiagnosticSaveError({
          title: 'El catálogo de "Queso" cambió en el servidor',
          detail:
            'Documento rechazado: dailyReports/ws_1_2026-11-15_asados/entries/asados_1 ("Queso", creación). Motivo: unidad en catálogo ("loncha") ≠ "kg".',
          rawDetail:
            'Documento rechazado: dailyReports/ws_1_2026-11-15_asados/entries/asados_1\nFirebase (permission-denied): Missing or insufficient permissions.',
          failedDocumentPath: 'dailyReports/ws_1_2026-11-15_asados/entries/asados_1',
          code: 'catalog-mismatch',
        });
      }),
    };

    const result = await saveStationReportBatch({
      workspace,
      user,
      canManage: false,
      date: '2026-11-15',
      station: 'asados',
      mode: 'opening',
      notes: '',
      rows: [row],
      existingReport: undefined,
      existingEntries: {},
      expectedUpdatedAtMs: null,
      now: new Date('2026-11-15T22:00:00Z'),
      onStatusMessage,
      onCatalogSynced,
      io,
    });

    expect(result).toEqual({
      queuedOffline: false,
      catalogUpdatedDuringSave: true,
      savedCount: 1,
    });
    expect(onStatusMessage).toHaveBeenCalledTimes(1);
    expect(onStatusMessage).toHaveBeenCalledWith('El jefe actualizó los insumos, actualizando…');
    expect(io.fetchServerItems).toHaveBeenCalledTimes(2);
    expect(committedUnits).toEqual(['loncha']);
    expect(committedReportStatuses).toEqual(['open', 'opening_saved']);
    expect(onCatalogSynced).toHaveBeenCalledWith([updatedServerItem]);
  });

  it('retries at most once and throws PartialBatchSaveError with full uncut diagnostic if second attempt still fails', async () => {
    const workspace = makeWorkspace();
    const user = makeWorkerUser();
    const row = makeDraftRow();
    const serverItem = makeItem();

    const fullDiagnostic = new DiagnosticSaveError({
      title: 'El catálogo de "Queso" cambió en el servidor',
      detail:
        'Documento rechazado: dailyReports/ws_1_2026-11-15_asados/entries/asados_1 ("Queso", creación). Motivo: unidad en catálogo ("loncha") ≠ "kg"; minStock en catálogo (30) ≠ 2.',
      rawDetail:
        'Motivo completo sin recortar + stack de Firebase (permission-denied): False for entryMatchesItem',
      failedDocumentPath: 'dailyReports/ws_1_2026-11-15_asados/entries/asados_1',
      code: 'catalog-mismatch',
    });

    const onStatusMessage = vi.fn();
    let finalReportCommitted = false;
    const io: Partial<WorkerSaveIO> = {
      syncClock: vi.fn(async () => {}),
      getServerTimestampValue: () => 'SERVER_TS',
      fetchServerItems: vi.fn(async () => ({
        itemsById: { [serverItem.id]: serverItem },
        removedOrMovedIds: new Set<string>(),
        offlineFallback: false,
      })),
      fetchServerReport: vi.fn(async () => ({ exists: false, updatedAtMs: null })),
      fetchServerEntries: vi.fn(async () => ({})),
      commitChunks: vi.fn(async (chunks: BatchChunkCommitInput[]) => {
        if (chunks.some((c) => c.entryOps.length > 0)) {
          const permErr = new Error('Missing or insufficient permissions.');
          (permErr as Error & { code: string }).code = 'permission-denied';
          throw permErr;
        }
        if (chunks.some((c) => c.reportWrite?.payload.status === 'opening_saved')) {
          finalReportCommitted = true;
        }
        return { queuedOffline: false };
      }),
      diagnoseChunkFailure: vi.fn(async () => {
        throw fullDiagnostic;
      }),
    };

    let caught: unknown;
    try {
      await saveStationReportBatch({
        workspace,
        user,
        canManage: false,
        date: '2026-11-15',
        station: 'asados',
        mode: 'opening',
        notes: '',
        rows: [row],
        existingReport: undefined,
        existingEntries: {},
        expectedUpdatedAtMs: null,
        now: new Date('2026-11-15T22:00:00Z'),
        onStatusMessage,
        io,
      });
    } catch (err) {
      caught = err;
    }

    expect(io.diagnoseChunkFailure).toHaveBeenCalledTimes(2);
    expect(onStatusMessage).toHaveBeenCalledTimes(1);
    expect(finalReportCommitted).toBe(false);
    expect(caught).toBeInstanceOf(PartialBatchSaveError);
    const partial = caught as PartialBatchSaveError;
    expect(partial.rawDetail).toBe(fullDiagnostic.rawDetail);
    expect(partial.failedDocumentPath).toBe(fullDiagnostic.failedDocumentPath);
    expect(partial.savedItems).toEqual([]);
    expect(partial.failedItems).toHaveLength(1);
    expect(partial.failedItems[0].attemptedValues).toEqual({
      unit: 'kg',
      minStock: 2,
      targetStock: 5,
      opening: 40,
      added: 20,
      closing: 0,
      notApplicable: false,
    });
  });

  it('reconcileRowsWithServerCatalog drops unassigned or moved items that have no existing entry', () => {
    const keptItem = makeItem({ id: 'asados_1', name: 'Queso', unit: 'loncha', minStock: 20, targetStock: 60 });
    const rows: DraftEntryRow[] = [
      makeDraftRow({ itemId: 'asados_1', unit: 'kg', minStock: 2, targetStock: 5 }),
      makeDraftRow({ itemId: 'item_moved', itemName: 'Salsa vieja' }),
    ];

    const res = reconcileRowsWithServerCatalog({
      rows,
      serverItemsById: { [keptItem.id]: keptItem },
      removedOrMovedIds: new Set(['item_moved']),
      existingEntries: {},
    });

    expect(res.removedItemIds).toEqual(['item_moved']);
    expect(res.updatedItemIds).toEqual(['asados_1']);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].unit).toBe('loncha');
    expect(res.rows[0].minStock).toBe(20);
    expect(res.rows[0].targetStock).toBe(60);
  });
});
