import { describe, expect, it, vi } from 'vitest';
import {
  chunkArrayWithLimit,
  executeChunkedBatch,
  MAX_BATCH_SIZE,
  PartialBatchError,
} from '../batch';

describe('batch.ts (lotes pequeños de máximo 8 documentos y reintento)', () => {
  it('chunks arrays cleanly up to MAX_BATCH_SIZE = 8', () => {
    expect(MAX_BATCH_SIZE).toBe(8);
    expect(chunkArrayWithLimit([])).toEqual([]);
    expect(chunkArrayWithLimit([1])).toEqual([[1]]);
    expect(chunkArrayWithLimit([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
    ]);
    expect(chunkArrayWithLimit([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [9],
    ]);

    const forty = Array.from({ length: 40 }, (_, i) => i + 1);
    const chunks = chunkArrayWithLimit(forty);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.length <= MAX_BATCH_SIZE)).toBe(true);
  });

  it('commits all chunks and reports incremental progress when everything succeeds', async () => {
    const items = Array.from({ length: 19 }, (_, i) => `item_${i + 1}`);
    const progressCalls: Array<[number, number]> = [];
    const committedChunks: string[][] = [];

    const result = await executeChunkedBatch({
      items,
      onProgress: (processed, total) => progressCalls.push([processed, total]),
      commitBatch: async (chunk) => {
        committedChunks.push(chunk);
      },
    });

    expect(result).toEqual({ processedCount: 19, totalCount: 19 });
    expect(committedChunks.map((c) => c.length)).toEqual([8, 8, 3]);
    expect(progressCalls).toEqual([
      [0, 19],
      [8, 19],
      [16, 19],
      [19, 19],
    ]);
  });

  it('throws PartialBatchError with processed count and remaining items on failure, then completes on retry', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `doc_${i + 1}`);
    const commitBatch = vi
      .fn<(chunk: string[], idx: number, total: number) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network timeout'));

    let caught: PartialBatchError<string> | null = null;
    try {
      await executeChunkedBatch({
        items,
        commitBatch,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(PartialBatchError);
      caught = err as PartialBatchError<string>;
    }

    expect(caught).not.toBeNull();
    expect(caught?.processedCount).toBe(8);
    expect(caught?.totalCount).toBe(20);
    expect(caught?.remainingItems).toHaveLength(12);
    expect(caught?.remainingItems[0]).toBe('doc_9');

    // Retry remaining 12 items succeeds across 2 small batches (8 + 4)
    const retryCommit = vi.fn(async () => undefined);
    const retryResult = await executeChunkedBatch({
      items: caught!.remainingItems,
      commitBatch: retryCommit,
    });
    expect(retryResult).toEqual({ processedCount: 12, totalCount: 12 });
    expect(retryCommit).toHaveBeenCalledTimes(2);
  });
});
