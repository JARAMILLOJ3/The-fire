import { describe, expect, it } from 'vitest';
import { evaluateReportSaveGuard } from '../inventoryService';

describe('inventoryService concurrency & downgrade guard', () => {
  it('blocks workers from overwriting or downgrading a completed report', () => {
    const res = evaluateReportSaveGuard({
      mode: 'opening',
      canManage: false,
      expectedUpdatedAtMs: 1000,
      forceOverwrite: true,
      serverExists: true,
      serverStatus: 'completed',
      serverUpdatedAtMs: 1000,
      serverUpdatedByName: 'Ana',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('completed_locked');
    }
  });

  it('protects completed status from silent downgrade when boss saves opening adjustments', () => {
    const res = evaluateReportSaveGuard({
      mode: 'opening',
      canManage: true,
      expectedUpdatedAtMs: 2000,
      serverExists: true,
      serverStatus: 'completed',
      serverUpdatedAtMs: 2000,
      serverUpdatedByName: 'Jefe',
    });

    expect(res).toEqual({
      ok: true,
      effectiveStatus: 'completed',
    });
  });

  it('detects concurrent creation when client had no report yet', () => {
    const res = evaluateReportSaveGuard({
      mode: 'closing',
      canManage: false,
      expectedUpdatedAtMs: null,
      serverExists: true,
      serverStatus: 'opening_saved',
      serverUpdatedAtMs: 5000,
      serverUpdatedByName: 'María',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('concurrent_create');
      expect(res.message).toContain('María');
    }
  });

  it('detects stale updatedAt conflict when another device updated the report', () => {
    const res = evaluateReportSaveGuard({
      mode: 'closing',
      canManage: false,
      expectedUpdatedAtMs: 4000,
      serverExists: true,
      serverStatus: 'opening_saved',
      serverUpdatedAtMs: 5500,
      serverUpdatedByName: 'Luisa',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('concurrent_update');
      expect(res.message).toContain('Luisa');
    }
  });

  it('allows explicit forceOverwrite for non-completed concurrent updates', () => {
    const res = evaluateReportSaveGuard({
      mode: 'closing',
      canManage: false,
      expectedUpdatedAtMs: 4000,
      forceOverwrite: true,
      serverExists: true,
      serverStatus: 'opening_saved',
      serverUpdatedAtMs: 5500,
      serverUpdatedByName: 'Luisa',
    });

    expect(res).toEqual({
      ok: true,
      effectiveStatus: 'completed',
    });
  });
});
