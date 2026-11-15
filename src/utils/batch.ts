export const MAX_BATCH_SIZE = 8;
export const WORKER_ENTRY_BATCH_SIZE = 4;

export function chunkArrayWithLimit<T>(
  items: readonly T[],
  batchSize: number = MAX_BATCH_SIZE,
): T[][] {
  const safeSize = Math.max(1, Math.floor(batchSize));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

export class PartialBatchError<T> extends Error {
  processedCount: number;
  totalCount: number;
  remainingItems: T[];
  causeError: unknown;

  constructor(params: {
    message: string;
    processedCount: number;
    totalCount: number;
    remainingItems: T[];
    causeError: unknown;
  }) {
    super(params.message);
    this.name = 'PartialBatchError';
    this.processedCount = params.processedCount;
    this.totalCount = params.totalCount;
    this.remainingItems = params.remainingItems;
    this.causeError = params.causeError;
  }
}

export async function executeChunkedBatch<T>(params: {
  items: readonly T[];
  commitBatch: (chunk: T[], chunkIndex: number, totalChunks: number) => Promise<void>;
  onProgress?: (processedCount: number, totalCount: number) => void;
  batchSize?: number;
  buildErrorMessage?: (info: {
    processedCount: number;
    totalCount: number;
    remainingCount: number;
    error: unknown;
  }) => string;
}): Promise<{ processedCount: number; totalCount: number }> {
  const { items, commitBatch, onProgress, batchSize = MAX_BATCH_SIZE, buildErrorMessage } = params;
  const totalCount = items.length;
  if (totalCount === 0) {
    return { processedCount: 0, totalCount: 0 };
  }

  const chunks = chunkArrayWithLimit(items, batchSize);
  let processedCount = 0;
  onProgress?.(0, totalCount);

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    try {
      await commitBatch(chunk, idx, chunks.length);
    } catch (error) {
      const remainingItems = items.slice(processedCount);
      const message = buildErrorMessage
        ? buildErrorMessage({
            processedCount,
            totalCount,
            remainingCount: remainingItems.length,
            error,
          })
        : `Se detuvo el proceso (${processedCount} de ${totalCount} procesados). Reintenta los ${remainingItems.length} restantes.`;
      throw new PartialBatchError<T>({
        message,
        processedCount,
        totalCount,
        remainingItems,
        causeError: error,
      });
    }
    processedCount += chunk.length;
    onProgress?.(processedCount, totalCount);
  }

  return { processedCount, totalCount };
}
