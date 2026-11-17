// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InventoryItem, StationLink, Workspace, Workstation } from '../../types';
import {
  clearWorkerSnapshotCache,
  getTimestampMs,
  hasCachedWorkerHint,
  isSnapshotCompatibleWithLink,
  makeSerializedTimestamp,
  readCachedStationLinkPreview,
  readStationCatalogCache,
  readWorkerSnapshotCache,
  writeCachedStationLinkPreview,
  writeStationCatalogCache,
  writeWorkerSnapshotCache,
} from '../workerCache';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe('workerCache', () => {
  beforeEach(() => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage, sessionStorage },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  const sampleWorkspace: Workspace = {
    id: 'ws_1',
    name: 'The Fire',
    ownerUid: 'owner_1',
    ownerEmail: 'boss@test.com',
    authorizedEmails: ['boss@test.com'],
    seeded: true,
    updatedAt: makeSerializedTimestamp(1700000000000),
  };

  const sampleStation: Workstation = {
    id: 'asados',
    workspaceId: 'ws_1',
    ownerUid: 'owner_1',
    authorizedEmails: ['boss@test.com'],
    name: 'Asados',
    area: 'Parrilla',
    workerName: 'María',
    description: 'Carnes',
    accessCode: 'code_1234567890',
    nextItemSlot: 2,
    assignedItemIds: ['asados_1'],
    active: true,
    sortOrder: 10,
    updatedAt: makeSerializedTimestamp(1700000005000),
  };

  const sampleItem: InventoryItem = {
    id: 'asados_1',
    workspaceId: 'ws_1',
    ownerUid: 'owner_1',
    authorizedEmails: ['boss@test.com'],
    station: 'asados',
    name: 'Churrasco',
    unit: 'porción',
    minStock: 5,
    targetStock: 15,
    active: true,
    sortOrder: 10,
  };

  it('caches and invalidates station link previews by TTL and corrupt payload safety', () => {
    const link: StationLink = {
      id: 'code_1234567890',
      workspaceId: 'ws_1',
      ownerUid: 'owner_1',
      stationId: 'asados',
      stationName: 'Asados',
      workerName: 'María',
      active: true,
    };

    const t0 = 1_000_000;
    writeCachedStationLinkPreview(link, t0);
    expect(readCachedStationLinkPreview('code_1234567890', t0 + 1000)).toEqual(link);

    // Expired after 15 minutes
    expect(readCachedStationLinkPreview('code_1234567890', t0 + 16 * 60 * 1000)).toBeNull();

    // Corrupt JSON never throws
    window.sessionStorage.setItem('thefire_link_preview:v1:corrupt_123', '{not-json');
    expect(readCachedStationLinkPreview('corrupt_123')).toBeNull();
  });

  it('persists worker snapshot cache, rehydrates Timestamps, and merges partial updates safely', () => {
    const now = 2_000_000;
    writeWorkerSnapshotCache(
      'worker_uid_1',
      {
        workspace: sampleWorkspace,
        role: 'asados',
        station: sampleStation,
        items: [sampleItem],
        dateStr: '2026-11-15',
        todayReport: null,
        todayEntries: {},
      },
      now,
    );

    expect(hasCachedWorkerHint(now + 1000)).toBe(true);

    const hydrated = readWorkerSnapshotCache('worker_uid_1', now + 5000);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.workspace.id).toBe('ws_1');
    expect(getTimestampMs(hydrated!.workspace.updatedAt)).toBe(1700000000000);
    expect(hydrated!.station?.assignedItemIds).toEqual(['asados_1']);
    expect(getTimestampMs(hydrated!.station?.updatedAt)).toBe(1700000005000);
    expect(hydrated!.items).toHaveLength(1);

    // Partial yesterday update preserves existing items and station
    writeWorkerSnapshotCache(
      'worker_uid_1',
      {
        workspace: sampleWorkspace,
        role: 'asados',
        yesterdayDateStr: '2026-11-14',
        yesterdayStatus: 'none',
        yesterdayEntries: {},
      },
      now + 6000,
    );

    const afterYesterday = readWorkerSnapshotCache('worker_uid_1', now + 7000);
    expect(afterYesterday?.items).toHaveLength(1);
    expect(afterYesterday?.yesterdayStatus).toBe('none');
    expect(afterYesterday?.dateStr).toBe('2026-11-15');

    clearWorkerSnapshotCache('worker_uid_1');
    expect(readWorkerSnapshotCache('worker_uid_1', now + 8000)).toBeNull();
    expect(hasCachedWorkerHint(now + 8000)).toBe(false);
  });

  it('persists station-level catalog cache independently of user uid for fast QR entry', () => {
    const now = 2_500_000;
    writeStationCatalogCache(
      {
        workspaceId: 'ws_1',
        role: 'asados',
        station: sampleStation,
        items: [sampleItem],
      },
      now,
    );

    const catalog = readStationCatalogCache('ws_1', 'asados', now + 1000);
    expect(catalog).not.toBeNull();
    expect(catalog!.station?.name).toBe('Asados');
    expect(catalog!.items).toHaveLength(1);
    expect(catalog!.items[0].name).toBe('Churrasco');
    expect(getTimestampMs(catalog!.station?.updatedAt)).toBe(1700000005000);

    // Expired after 24h
    expect(readStationCatalogCache('ws_1', 'asados', now + 25 * 60 * 60 * 1000)).toBeNull();
  });

  it('checks QR link compatibility before hydrating optimistic worker session', () => {
    const now = 3_000_000;
    writeWorkerSnapshotCache(
      'worker_uid_1',
      {
        workspace: sampleWorkspace,
        role: 'asados',
        station: sampleStation,
        items: [sampleItem],
      },
      now,
    );
    const snap = readWorkerSnapshotCache('worker_uid_1', now + 100);

    expect(
      isSnapshotCompatibleWithLink(snap, { stationId: null, accessCode: null }, null),
    ).toBe(true);
    expect(
      isSnapshotCompatibleWithLink(
        snap,
        { stationId: 'mesera', accessCode: 'code_other' },
        null,
      ),
    ).toBe(false);
    expect(
      isSnapshotCompatibleWithLink(
        snap,
        { stationId: 'asados', accessCode: 'code_1234567890' },
        {
          id: 'code_1234567890',
          workspaceId: 'ws_1',
          ownerUid: 'owner_1',
          stationId: 'asados',
          stationName: 'Asados',
          workerName: 'María',
          active: true,
        },
      ),
    ).toBe(true);
  });
});
