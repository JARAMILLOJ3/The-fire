import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  DEFAULT_CATALOG_ITEMS,
  DEFAULT_STATIONS,
  MAX_AREA_LENGTH,
  MAX_DESC_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PACK_LABEL_LENGTH,
  MAX_PACK_SIZE,
  MAX_UNIT_LENGTH,
  UNASSIGNED_STATION_ID,
} from '../constants';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  CaptureInputType,
  DailyReport,
  DailyReportEntry,
  InventoryItem,
  Invite,
  PacksUnitMigrationRecord,
  ShiftSchedule,
  StationId,
  StationLink,
  TeamMember,
  TeamStationId,
  Workspace,
  Workstation,
} from '../types';
import type {
  ResetExecutionProgress,
  ResetScope,
  ResetTaskItem,
  RestaurantBackupPayload,
} from '../utils/reset';
import { buildPacksUnitMigrationPlan } from '../utils/inventory';
import { validateShiftSchedule } from '../utils/schedule';
import { clampNumber, clampString, generateAccessCode, makeCleanId } from './shared';

export function buildStationShareUrl(stationId: string, accessCode: string): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.origin);
  url.searchParams.set('puesto', stationId);
  url.searchParams.set('codigo', accessCode);
  return url.toString();
}

export async function seedDefaultWorkstationsAndCatalog(workspace: Workspace): Promise<void> {
  const batch = writeBatch(db);
  const slotCounters: Record<string, number> = {};
  DEFAULT_STATIONS.forEach((s) => {
    slotCounters[s.id] = 1;
  });

  DEFAULT_CATALOG_ITEMS.forEach((tpl, idx) => {
    const slot = slotCounters[tpl.station] ?? 1;
    slotCounters[tpl.station] = slot + 1;
    const itemId = `${tpl.station}_${slot}`;
    batch.set(doc(db, 'items', itemId), {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      authorizedEmails: workspace.authorizedEmails.slice(0, 15),
      station: tpl.station,
      name: clampString(tpl.name, MAX_NAME_LENGTH),
      unit: clampString(tpl.unit, MAX_UNIT_LENGTH),
      minStock: clampNumber(tpl.minStock),
      targetStock: clampNumber(tpl.targetStock),
      active: true,
      sortOrder: (idx + 1) * 10,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  DEFAULT_STATIONS.forEach((st, idx) => {
    const accessCode = generateAccessCode();
    batch.set(doc(db, 'stations', st.id), {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      authorizedEmails: workspace.authorizedEmails.slice(0, 15),
      name: clampString(st.name, MAX_NAME_LENGTH),
      area: clampString(st.area, MAX_AREA_LENGTH),
      workerName: clampString(st.workerName, MAX_NAME_LENGTH),
      description: clampString(st.description, MAX_DESC_LENGTH),
      accessCode,
      nextItemSlot: slotCounters[st.id] ?? 1,
      active: true,
      sortOrder: (idx + 1) * 10,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'stationLinks', accessCode), {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      stationId: st.id,
      stationName: clampString(st.name, MAX_NAME_LENGTH),
      workerName: clampString(st.workerName, MAX_NAME_LENGTH),
      active: true,
      createdAt: serverTimestamp(),
    });
  });

  batch.update(doc(db, 'workspaces', workspace.id), {
    seeded: true,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workspaces/${workspace.id}`);
  }
}

export async function ensureWorkstationsForExistingWorkspace(
  workspace: Workspace,
  existingStations: Workstation[],
  existingItems: InventoryItem[],
): Promise<void> {
  if (workspace.seeded || existingStations.length > 0) return;

  const batch = writeBatch(db);
  const slotCounters: Record<string, number> = {};
  DEFAULT_STATIONS.forEach((s) => {
    slotCounters[s.id] = 1;
  });

  const existingKeys = new Set<string>();
  existingItems.forEach((item) => {
    const normalizedSt =
      (item.station as string) === 'hamburguesas' ? 'comida_rapida' : item.station;
    if ((item.station as string) === 'hamburguesas') {
      batch.update(doc(db, 'items', item.id), {
        station: 'comida_rapida',
        updatedAt: serverTimestamp(),
      });
    }
    existingKeys.add(`${normalizedSt}::${item.name.toLowerCase()}`);
    if (slotCounters[normalizedSt] !== undefined) {
      slotCounters[normalizedSt] += 1;
    }
  });

  let nextOrder = (existingItems.length + 1) * 10;
  DEFAULT_CATALOG_ITEMS.forEach((tpl) => {
    const key = `${tpl.station}::${tpl.name.toLowerCase()}`;
    if (existingKeys.has(key)) return;
    const slot = slotCounters[tpl.station] ?? 1;
    slotCounters[tpl.station] = slot + 1;
    const itemId = `${tpl.station}_${slot}`;
    batch.set(doc(db, 'items', itemId), {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      authorizedEmails: workspace.authorizedEmails.slice(0, 15),
      station: tpl.station,
      name: clampString(tpl.name, MAX_NAME_LENGTH),
      unit: clampString(tpl.unit, MAX_UNIT_LENGTH),
      minStock: clampNumber(tpl.minStock),
      targetStock: clampNumber(tpl.targetStock),
      active: true,
      sortOrder: nextOrder,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    nextOrder += 10;
  });

  DEFAULT_STATIONS.forEach((st, idx) => {
    const accessCode = generateAccessCode();
    batch.set(doc(db, 'stations', st.id), {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      authorizedEmails: workspace.authorizedEmails.slice(0, 15),
      name: clampString(st.name, MAX_NAME_LENGTH),
      area: clampString(st.area, MAX_AREA_LENGTH),
      workerName: clampString(st.workerName, MAX_NAME_LENGTH),
      description: clampString(st.description, MAX_DESC_LENGTH),
      accessCode,
      nextItemSlot: slotCounters[st.id] ?? 1,
      active: true,
      sortOrder: (idx + 1) * 10,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'stationLinks', accessCode), {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      stationId: st.id,
      stationName: clampString(st.name, MAX_NAME_LENGTH),
      workerName: clampString(st.workerName, MAX_NAME_LENGTH),
      active: true,
      createdAt: serverTimestamp(),
    });
  });

  batch.update(doc(db, 'workspaces', workspace.id), {
    name:
      workspace.name === 'Mi Restaurante' || workspace.name === 'Tefire'
        ? 'The Fire'
        : workspace.name,
    seeded: true,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `stations`);
  }
}

export async function createWorkstation(
  workspace: Workspace,
  payload: {
    name: string;
    area: string;
    workerName: string;
    description: string;
    sortOrder: number;
  },
): Promise<Workstation> {
  const stationId = makeCleanId('puesto');
  const accessCode = generateAccessCode();
  const batch = writeBatch(db);

  const stationBase: Omit<Workstation, 'id' | 'createdAt' | 'updatedAt'> = {
    workspaceId: workspace.id,
    ownerUid: workspace.ownerUid,
    authorizedEmails: workspace.authorizedEmails.slice(0, 15),
    name: clampString(payload.name, MAX_NAME_LENGTH),
    area: clampString(payload.area, MAX_AREA_LENGTH),
    workerName: clampString(payload.workerName, MAX_NAME_LENGTH),
    description: clampString(payload.description, MAX_DESC_LENGTH),
    accessCode,
    nextItemSlot: 1,
    assignedItemIds: [],
    active: true,
    sortOrder: clampNumber(payload.sortOrder),
  };

  batch.set(doc(db, 'stations', stationId), {
    ...stationBase,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'stationLinks', accessCode), {
    workspaceId: workspace.id,
    ownerUid: workspace.ownerUid,
    stationId,
    stationName: stationBase.name,
    workerName: stationBase.workerName,
    active: true,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    return { id: stationId, ...stationBase };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `stations/${stationId}`);
  }
}

export async function updateWorkstation(
  station: Workstation,
  payload: {
    name: string;
    area: string;
    workerName: string;
    description: string;
  },
): Promise<void> {
  const cleanName = clampString(payload.name, MAX_NAME_LENGTH);
  const cleanWorker = clampString(payload.workerName, MAX_NAME_LENGTH);
  const batch = writeBatch(db);

  batch.update(doc(db, 'stations', station.id), {
    name: cleanName,
    area: clampString(payload.area, MAX_AREA_LENGTH),
    workerName: cleanWorker,
    description: clampString(payload.description, MAX_DESC_LENGTH),
    updatedAt: serverTimestamp(),
  });

  if (station.accessCode) {
    batch.update(doc(db, 'stationLinks', station.accessCode), {
      stationName: cleanName,
      workerName: cleanWorker,
      active: station.active,
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `stations/${station.id}`);
  }
}

async function appendStationWorkerDeactivations(
  batch: ReturnType<typeof writeBatch>,
  workspaceId: string,
  ownerUid: string,
  stationId: string,
): Promise<void> {
  const membersQuery = query(collection(db, 'teamMembers'), where('ownerUid', '==', ownerUid));
  const snaps = await getDocs(membersQuery);
  snaps.forEach((d) => {
    const data = d.data() as TeamMember;
    if (data.workspaceId === workspaceId && data.station === stationId && data.active) {
      batch.update(d.ref, {
        active: false,
        updatedAt: serverTimestamp(),
      });
    }
  });
}

export async function toggleStationLinkActive(
  workspace: Workspace,
  station: Workstation,
  active: boolean,
): Promise<void> {
  if (!station.accessCode) return;
  const linkRef = doc(db, 'stationLinks', station.accessCode);
  try {
    const batch = writeBatch(db);
    const existingSnap = await getDoc(linkRef);
    if (existingSnap.exists()) {
      batch.update(linkRef, { active });
    } else {
      batch.set(linkRef, {
        workspaceId: workspace.id,
        ownerUid: workspace.ownerUid,
        stationId: station.id,
        stationName: clampString(station.name, MAX_NAME_LENGTH),
        workerName: clampString(station.workerName, MAX_NAME_LENGTH),
        active,
        createdAt: serverTimestamp(),
      });
    }

    if (!active) {
      await appendStationWorkerDeactivations(batch, workspace.id, workspace.ownerUid, station.id);
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `stationLinks/${station.accessCode}`);
  }
}

export async function regenerateStationLink(
  workspace: Workspace,
  station: Workstation,
): Promise<string> {
  const newCode = generateAccessCode();
  const batch = writeBatch(db);

  if (station.accessCode) {
    batch.delete(doc(db, 'stationLinks', station.accessCode));
  }

  batch.set(doc(db, 'stationLinks', newCode), {
    workspaceId: workspace.id,
    ownerUid: workspace.ownerUid,
    stationId: station.id,
    stationName: clampString(station.name, MAX_NAME_LENGTH),
    workerName: clampString(station.workerName, MAX_NAME_LENGTH),
    active: true,
    createdAt: serverTimestamp(),
  });

  batch.update(doc(db, 'stations', station.id), {
    accessCode: newCode,
    updatedAt: serverTimestamp(),
  });

  try {
    await appendStationWorkerDeactivations(batch, workspace.id, workspace.ownerUid, station.id);
    await batch.commit();
    return newCode;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `stations/${station.id}`);
  }
}

export async function deleteWorkstation(
  station: Workstation,
  stationItems: InventoryItem[],
): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'stations', station.id));
  if (station.accessCode) {
    batch.delete(doc(db, 'stationLinks', station.accessCode));
  }
  stationItems.forEach((item) => {
    batch.update(doc(db, 'items', item.id), {
      station: UNASSIGNED_STATION_ID,
      updatedAt: serverTimestamp(),
    });
  });

  try {
    await appendStationWorkerDeactivations(batch, station.workspaceId, station.ownerUid, station.id);
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `stations/${station.id}`);
  }
}

export async function updateWorkspaceProfile(
  workspaceId: string,
  payload: { ownerName?: string; name?: string },
): Promise<void> {
  const updates: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };

  if (payload.ownerName !== undefined) {
    const cleanOwner = clampString(payload.ownerName, MAX_NAME_LENGTH);
    if (cleanOwner.length < 1) return;
    updates.ownerName = cleanOwner;
  }

  if (payload.name !== undefined) {
    const cleanName = clampString(payload.name, MAX_NAME_LENGTH);
    if (cleanName.length >= 2) {
      updates.name = cleanName;
    }
  }

  try {
    await updateDoc(doc(db, 'workspaces', workspaceId), updates);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workspaces/${workspaceId}`);
  }
}

export async function updateWorkspaceShiftSchedule(
  workspaceId: string,
  schedule: ShiftSchedule,
): Promise<void> {
  const validation = validateShiftSchedule(schedule);
  if (!validation.valid) {
    throw new Error(validation.errors[0] ?? 'Horario inválido.');
  }

  try {
    await updateDoc(doc(db, 'workspaces', workspaceId), {
      shiftSchedule: {
        enabled: Boolean(schedule.enabled),
        openingStart: schedule.openingStart,
        openingEnd: schedule.openingEnd,
        closingStart: schedule.closingStart,
        closingEnd: schedule.closingEnd,
      },
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workspaces/${workspaceId}`);
  }
}

export interface InventoryItemCapturePayload {
  inputType?: CaptureInputType;
  packSize?: number;
  packLabel?: string;
  unitLabel?: string;
  capacity?: number;
  allowClosedContainers?: boolean;
}

function buildItemCapturePayload(
  payload: InventoryItemCapturePayload,
  forUpdate: boolean,
): Record<string, unknown> {
  const inputType: CaptureInputType =
    payload.inputType === 'packs' || payload.inputType === 'level' ? payload.inputType : 'count';

  if (inputType === 'packs') {
    const safeSize = Math.min(
      MAX_PACK_SIZE,
      Math.max(2, Math.round(Number(payload.packSize ?? 2))),
    );
    const result: Record<string, unknown> = {
      inputType: 'packs',
      packSize: safeSize,
      packLabel: clampString(payload.packLabel || 'paquete', MAX_PACK_LABEL_LENGTH),
      unitLabel: clampString(payload.unitLabel || 'und', MAX_PACK_LABEL_LENGTH),
    };
    if (forUpdate) {
      result.capacity = deleteField();
      result.allowClosedContainers = deleteField();
    }
    return result;
  }

  if (inputType === 'level') {
    const safeCapacity = Math.max(0.1, clampNumber(Number(payload.capacity ?? 1)));
    const result: Record<string, unknown> = {
      inputType: 'level',
      capacity: safeCapacity,
    };
    if (payload.allowClosedContainers) {
      result.allowClosedContainers = true;
    } else if (forUpdate) {
      result.allowClosedContainers = deleteField();
    }
    if (forUpdate) {
      result.packSize = deleteField();
      result.packLabel = deleteField();
      result.unitLabel = deleteField();
    }
    return result;
  }

  const result: Record<string, unknown> = {
    inputType: 'count',
  };
  if (forUpdate) {
    result.packSize = deleteField();
    result.packLabel = deleteField();
    result.unitLabel = deleteField();
    result.capacity = deleteField();
    result.allowClosedContainers = deleteField();
  }
  return result;
}

export async function migratePacksItemUnits(
  items: InventoryItem[],
): Promise<PacksUnitMigrationRecord[]> {
  const plan = buildPacksUnitMigrationPlan(items);
  if (plan.length === 0) return [];

  const CHUNK_SIZE = 20;
  for (let i = 0; i < plan.length; i += CHUNK_SIZE) {
    const chunk = plan.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    chunk.forEach((rec) => {
      batch.update(doc(db, 'items', rec.id), {
        unit: clampString(rec.newUnit, MAX_UNIT_LENGTH),
        updatedAt: serverTimestamp(),
      });
    });
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `items/${chunk[0]?.id ?? 'migration'}`);
    }
  }

  return plan;
}

function computeStationAssignedIds(
  stationId: string,
  allItems: InventoryItem[],
  overrides: Record<string, { station: StationId; active: boolean }> = {},
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  allItems.forEach((item) => {
    const effective = overrides[item.id] ?? { station: item.station, active: item.active };
    if (effective.active && effective.station === stationId && !seen.has(item.id)) {
      seen.add(item.id);
      result.push(item.id);
    }
  });

  Object.entries(overrides).forEach(([itemId, effective]) => {
    if (effective.active && effective.station === stationId && !seen.has(itemId)) {
      seen.add(itemId);
      result.push(itemId);
    }
  });

  return result.slice(0, 150);
}

export async function createInventoryItem(
  workspace: Workspace,
  station: Workstation | undefined,
  payload: {
    station: StationId;
    name: string;
    unit: string;
    minStock: number;
    targetStock: number;
    sortOrder: number;
  } & InventoryItemCapturePayload,
  allItems: InventoryItem[] = [],
): Promise<void> {
  const isAssignedToStation =
    Boolean(station) && payload.station !== UNASSIGNED_STATION_ID && station?.id === payload.station;
  const slot = isAssignedToStation && station ? Math.max(1, station.nextItemSlot) : 1;
  const itemId = isAssignedToStation ? `${payload.station}_${slot}` : makeCleanId('item');
  const batch = writeBatch(db);

  batch.set(doc(db, 'items', itemId), {
    workspaceId: workspace.id,
    ownerUid: workspace.ownerUid,
    authorizedEmails: workspace.authorizedEmails.slice(0, 15),
    station: payload.station,
    name: clampString(payload.name, MAX_NAME_LENGTH),
    unit: clampString(payload.unit, MAX_UNIT_LENGTH),
    minStock: clampNumber(payload.minStock),
    targetStock: clampNumber(payload.targetStock),
    ...buildItemCapturePayload(payload, false),
    active: true,
    sortOrder: clampNumber(payload.sortOrder),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (isAssignedToStation && station) {
    const nextAssignedIds = computeStationAssignedIds(station.id, allItems, {
      [itemId]: { station: station.id, active: true },
    });
    batch.update(doc(db, 'stations', station.id), {
      nextItemSlot: slot + 1,
      assignedItemIds: nextAssignedIds,
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `items/${itemId}`);
  }
}

export async function updateInventoryItem(
  itemId: string,
  payload: {
    station: StationId;
    name: string;
    unit: string;
    minStock: number;
    targetStock: number;
    active: boolean;
  } & InventoryItemCapturePayload,
  syncContext?: {
    previousStation?: Workstation;
    nextStation?: Workstation;
    allItems: InventoryItem[];
  },
): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'items', itemId), {
    station: payload.station,
    name: clampString(payload.name, MAX_NAME_LENGTH),
    unit: clampString(payload.unit, MAX_UNIT_LENGTH),
    minStock: clampNumber(payload.minStock),
    targetStock: clampNumber(payload.targetStock),
    ...buildItemCapturePayload(payload, true),
    active: payload.active,
    updatedAt: serverTimestamp(),
  });

  if (syncContext) {
    const overrides = {
      [itemId]: { station: payload.station, active: payload.active },
    };
    const { previousStation, nextStation, allItems } = syncContext;
    if (previousStation && previousStation.id !== payload.station) {
      batch.update(doc(db, 'stations', previousStation.id), {
        assignedItemIds: computeStationAssignedIds(previousStation.id, allItems, overrides),
        updatedAt: serverTimestamp(),
      });
    }
    if (nextStation) {
      batch.update(doc(db, 'stations', nextStation.id), {
        assignedItemIds: computeStationAssignedIds(nextStation.id, allItems, overrides),
        updatedAt: serverTimestamp(),
      });
    }
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${itemId}`);
  }
}

export async function setInventoryItemActive(
  itemId: string,
  active: boolean,
  syncContext?: {
    station?: Workstation;
    stationId: StationId;
    allItems: InventoryItem[];
  },
): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'items', itemId), {
    active,
    updatedAt: serverTimestamp(),
  });

  if (syncContext?.station) {
    const overrides = {
      [itemId]: { station: syncContext.stationId, active },
    };
    batch.update(doc(db, 'stations', syncContext.station.id), {
      assignedItemIds: computeStationAssignedIds(
        syncContext.station.id,
        syncContext.allItems,
        overrides,
      ),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${itemId}`);
  }
}

export async function assignWorkstationItems(params: {
  station: Workstation;
  allStations: Workstation[];
  allItems: InventoryItem[];
  selectedItemIds: string[];
}): Promise<void> {
  const { station, allStations, allItems, selectedItemIds } = params;
  const selectedSet = new Set(selectedItemIds);
  const batch = writeBatch(db);
  const overrides: Record<string, { station: StationId; active: boolean }> = {};
  const touchedStationIds = new Set<string>([station.id]);
  const stationById = new Map(allStations.map((st) => [st.id, st]));

  allItems.forEach((item) => {
    if (!item.active) return;
    const shouldBelongHere = selectedSet.has(item.id);
    const currentlyHere = item.station === station.id;

    if (shouldBelongHere && !currentlyHere) {
      batch.update(doc(db, 'items', item.id), {
        station: station.id,
        updatedAt: serverTimestamp(),
      });
      overrides[item.id] = { station: station.id, active: true };
      if (item.station && item.station !== UNASSIGNED_STATION_ID && stationById.has(item.station)) {
        touchedStationIds.add(item.station);
      }
    } else if (!shouldBelongHere && currentlyHere) {
      batch.update(doc(db, 'items', item.id), {
        station: UNASSIGNED_STATION_ID,
        updatedAt: serverTimestamp(),
      });
      overrides[item.id] = { station: UNASSIGNED_STATION_ID, active: true };
    }
  });

  touchedStationIds.forEach((stId) => {
    const targetStation = stationById.get(stId);
    if (!targetStation) return;
    batch.update(doc(db, 'stations', stId), {
      assignedItemIds: computeStationAssignedIds(stId, allItems, overrides),
      updatedAt: serverTimestamp(),
    });
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `stations/${station.id}`);
  }
}

export async function reopenStationReport(reportId: string, user: User): Promise<void> {
  const reporterName = clampString(
    user.displayName || user.email?.split('@')[0] || 'Jefe',
    MAX_NAME_LENGTH,
  );
  try {
    await updateDoc(doc(db, 'dailyReports', reportId), {
      status: 'opening_saved',
      reportedByUid: user.uid,
      reportedByName: reporterName,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `dailyReports/${reportId}`);
  }
}

export async function syncAuthorizedEmailsAcrossWorkspace(params: {
  workspace: Workspace;
  coAdminEmails: string[];
  stations: Workstation[];
  items: InventoryItem[];
  reports: DailyReport[];
  entries: DailyReportEntry[];
  workerNotes?: Array<{ id: string }>;
}): Promise<void> {
  const nextEmails = Array.from(
    new Set([
      params.workspace.ownerEmail.trim().toLowerCase(),
      ...params.coAdminEmails.map((e) => e.trim().toLowerCase()),
    ]),
  )
    .filter(Boolean)
    .slice(0, 15);

  const unchanged =
    nextEmails.length === params.workspace.authorizedEmails.length &&
    nextEmails.every((e, i) => params.workspace.authorizedEmails[i] === e);
  if (unchanged) return;

  const batch = writeBatch(db);
  batch.update(doc(db, 'workspaces', params.workspace.id), {
    authorizedEmails: nextEmails,
    updatedAt: serverTimestamp(),
  });
  params.stations.forEach((st) => {
    batch.update(doc(db, 'stations', st.id), {
      authorizedEmails: nextEmails,
      updatedAt: serverTimestamp(),
    });
  });
  params.items.forEach((item) => {
    batch.update(doc(db, 'items', item.id), {
      authorizedEmails: nextEmails,
      updatedAt: serverTimestamp(),
    });
  });
  params.reports.forEach((rep) => {
    batch.update(doc(db, 'dailyReports', rep.id), {
      authorizedEmails: nextEmails,
      updatedAt: serverTimestamp(),
    });
  });
  params.entries.forEach((entry) => {
    batch.update(doc(db, 'dailyReports', entry.reportId, 'entries', entry.itemId), {
      authorizedEmails: nextEmails,
      updatedAt: serverTimestamp(),
    });
  });
  params.workerNotes?.forEach((note) => {
    batch.update(doc(db, 'workerNotes', note.id), {
      authorizedEmails: nextEmails,
      updatedAt: serverTimestamp(),
    });
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workspaces/${params.workspace.id}`);
  }
}

export async function addInviteAndSyncAccess(params: {
  workspace: Workspace;
  email: string;
  displayName: string;
  station: TeamStationId;
  stations: Workstation[];
  items: InventoryItem[];
  todayReports: DailyReport[];
  todayEntries: DailyReportEntry[];
}): Promise<void> {
  const cleanEmail = params.email.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
  const cleanName = clampString(params.displayName, MAX_NAME_LENGTH);
  const inviteId = makeCleanId('inv');

  const batch = writeBatch(db);
  batch.set(doc(db, 'invites', inviteId), {
    workspaceId: params.workspace.id,
    ownerUid: params.workspace.ownerUid,
    email: cleanEmail,
    displayName: cleanName,
    station: params.station,
    createdAt: serverTimestamp(),
  });

  if (params.station === 'jefe') {
    const nextEmails = Array.from(
      new Set([params.workspace.ownerEmail, ...params.workspace.authorizedEmails, cleanEmail]),
    ).slice(0, 15);

    batch.update(doc(db, 'workspaces', params.workspace.id), {
      authorizedEmails: nextEmails,
      updatedAt: serverTimestamp(),
    });

    params.stations.forEach((st) => {
      batch.update(doc(db, 'stations', st.id), {
        authorizedEmails: nextEmails,
        updatedAt: serverTimestamp(),
      });
    });

    params.items.forEach((item) => {
      batch.update(doc(db, 'items', item.id), {
        authorizedEmails: nextEmails,
        updatedAt: serverTimestamp(),
      });
    });

    params.todayReports.forEach((rep) => {
      batch.update(doc(db, 'dailyReports', rep.id), {
        authorizedEmails: nextEmails,
        updatedAt: serverTimestamp(),
      });
    });

    params.todayEntries.forEach((entry) => {
      batch.update(doc(db, 'dailyReports', entry.reportId, 'entries', entry.itemId), {
        authorizedEmails: nextEmails,
        updatedAt: serverTimestamp(),
      });
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `invites/${inviteId}`);
  }
}

export async function removeInviteOrMember(params: {
  workspace: Workspace;
  email: string;
  inviteId?: string;
  memberId?: string;
  stations: Workstation[];
  items: InventoryItem[];
}): Promise<void> {
  const cleanEmail = params.email.trim().toLowerCase();
  const nextEmails = params.workspace.authorizedEmails
    .filter((e) => e !== cleanEmail || e === params.workspace.ownerEmail)
    .slice(0, 15);

  const emailsChanged =
    nextEmails.length !== params.workspace.authorizedEmails.length ||
    nextEmails.some((e, i) => params.workspace.authorizedEmails[i] !== e);

  const batch = writeBatch(db);
  if (params.inviteId) {
    batch.delete(doc(db, 'invites', params.inviteId));
  }
  if (params.memberId) {
    batch.update(doc(db, 'teamMembers', params.memberId), {
      active: false,
      updatedAt: serverTimestamp(),
    });
  }

  if (emailsChanged) {
    batch.update(doc(db, 'workspaces', params.workspace.id), {
      authorizedEmails: nextEmails,
      updatedAt: serverTimestamp(),
    });

    params.stations.forEach((st) => {
      batch.update(doc(db, 'stations', st.id), {
        authorizedEmails: nextEmails,
        updatedAt: serverTimestamp(),
      });
    });

    params.items.forEach((item) => {
      batch.update(doc(db, 'items', item.id), {
        authorizedEmails: nextEmails,
        updatedAt: serverTimestamp(),
      });
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workspaces/${params.workspace.id}`);
  }
}

export async function updateTeamMemberAccess(
  memberId: string,
  payload: { active?: boolean; station?: TeamStationId },
): Promise<void> {
  const updates: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };
  if (payload.active !== undefined) updates.active = payload.active;
  if (payload.station !== undefined) updates.station = payload.station;
  try {
    await updateDoc(doc(db, 'teamMembers', memberId), updates);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `teamMembers/${memberId}`);
  }
}

function assertWorkspaceOwner(workspace: Workspace, callerUid: string): void {
  if (!callerUid || workspace.ownerUid !== callerUid) {
    throw new Error('Solo el dueño del restaurante puede ejecutar esta acción.');
  }
}

function clearWorkspaceDraftStorage(workspaceId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const prefix = `thefire_draft:${workspaceId}:`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Ignore restricted storage environments
  }
}

function resolveDocRefFromPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 2) {
    return doc(db, parts[0], parts[1]);
  }
  if (parts.length === 4) {
    return doc(db, parts[0], parts[1], parts[2], parts[3]);
  }
  throw new Error(`Ruta inválida para reinicio: ${path}`);
}

async function fetchEntriesForReports(
  reports: DailyReport[],
  ownerUid: string,
): Promise<Record<string, Record<string, DailyReportEntry>>> {
  const entriesByReportId: Record<string, Record<string, DailyReportEntry>> = {};
  const CONCURRENCY = 8;

  for (let i = 0; i < reports.length; i += CONCURRENCY) {
    const slice = reports.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (rep) => {
        const snap = await getDocs(
          query(
            collection(db, 'dailyReports', rep.id, 'entries'),
            where('ownerUid', '==', ownerUid),
          ),
        );
        const map: Record<string, DailyReportEntry> = {};
        snap.forEach((d) => {
          const entry = { id: d.id, ...d.data() } as DailyReportEntry;
          map[d.id] = entry;
        });
        entriesByReportId[rep.id] = map;
      }),
    );
  }

  return entriesByReportId;
}

export async function fetchWorkspaceBackupData(
  workspace: Workspace,
  callerUid: string,
): Promise<RestaurantBackupPayload> {
  assertWorkspaceOwner(workspace, callerUid);

  const [stationsSnap, itemsSnap, reportsSnap] = await Promise.all([
    getDocs(query(collection(db, 'stations'), where('ownerUid', '==', workspace.ownerUid))),
    getDocs(query(collection(db, 'items'), where('ownerUid', '==', workspace.ownerUid))),
    getDocs(query(collection(db, 'dailyReports'), where('ownerUid', '==', workspace.ownerUid))),
  ]);

  const stations: Workstation[] = [];
  stationsSnap.forEach((d) => {
    const st = { id: d.id, ...d.data() } as Workstation;
    if (st.workspaceId === workspace.id) stations.push(st);
  });

  const items: InventoryItem[] = [];
  itemsSnap.forEach((d) => {
    const it = { id: d.id, ...d.data() } as InventoryItem;
    if (it.workspaceId === workspace.id) items.push(it);
  });

  const reports: DailyReport[] = [];
  reportsSnap.forEach((d) => {
    const rep = { id: d.id, ...d.data() } as DailyReport;
    if (rep.workspaceId === workspace.id) reports.push(rep);
  });

  const entriesByReportId = await fetchEntriesForReports(reports, workspace.ownerUid);

  return {
    workspaceName: workspace.name,
    stations,
    items,
    reports,
    entriesByReportId,
  };
}

export async function collectWorkspaceResetTasks(
  workspace: Workspace,
  scope: ResetScope,
  callerUid: string,
): Promise<ResetTaskItem[]> {
  assertWorkspaceOwner(workspace, callerUid);
  const { sortResetTasks } = await import('../utils/reset');

  const [reportsSnap, notesSnap] = await Promise.all([
    getDocs(query(collection(db, 'dailyReports'), where('ownerUid', '==', workspace.ownerUid))),
    getDocs(query(collection(db, 'workerNotes'), where('ownerUid', '==', workspace.ownerUid))),
  ]);

  const reports: DailyReport[] = [];
  reportsSnap.forEach((d) => {
    const rep = { id: d.id, ...d.data() } as DailyReport;
    if (rep.workspaceId === workspace.id) reports.push(rep);
  });

  const tasks: ResetTaskItem[] = [];
  const entriesByReportId = await fetchEntriesForReports(reports, workspace.ownerUid);

  reports.forEach((rep) => {
    const entries = entriesByReportId[rep.id] ?? {};
    Object.keys(entries).forEach((entryId) => {
      tasks.push({
        category: 'entries',
        path: `dailyReports/${rep.id}/entries/${entryId}`,
        label: entries[entryId]?.itemName || entryId,
      });
    });
    tasks.push({
      category: 'reports',
      path: `dailyReports/${rep.id}`,
      label: `${rep.date} (${rep.station})`,
    });
  });

  notesSnap.forEach((d) => {
    const note = d.data() as { workspaceId?: string; date?: string; station?: string };
    if (note.workspaceId === workspace.id) {
      tasks.push({
        category: 'reports',
        path: `workerNotes/${d.id}`,
        label: `Nota ${note.date ?? ''} (${note.station ?? ''})`,
      });
    }
  });

  if (scope === 'all') {
    const [itemsSnap, linksSnap, stationsSnap, invitesSnap, membersSnap] = await Promise.all([
      getDocs(query(collection(db, 'items'), where('ownerUid', '==', workspace.ownerUid))),
      getDocs(query(collection(db, 'stationLinks'), where('ownerUid', '==', workspace.ownerUid))),
      getDocs(query(collection(db, 'stations'), where('ownerUid', '==', workspace.ownerUid))),
      getDocs(query(collection(db, 'invites'), where('ownerUid', '==', workspace.ownerUid))),
      getDocs(query(collection(db, 'teamMembers'), where('ownerUid', '==', workspace.ownerUid))),
    ]);

    itemsSnap.forEach((d) => {
      const it = d.data() as Partial<InventoryItem>;
      if (it.workspaceId === workspace.id) {
        tasks.push({
          category: 'items',
          path: `items/${d.id}`,
          label: it.name || d.id,
        });
      }
    });

    linksSnap.forEach((d) => {
      const link = d.data() as Partial<StationLink>;
      if (link.workspaceId === workspace.id) {
        tasks.push({
          category: 'stationLinks',
          path: `stationLinks/${d.id}`,
          label: link.stationName || d.id,
        });
      }
    });

    stationsSnap.forEach((d) => {
      const st = d.data() as Partial<Workstation>;
      if (st.workspaceId === workspace.id) {
        tasks.push({
          category: 'stations',
          path: `stations/${d.id}`,
          label: st.name || d.id,
        });
      }
    });

    invitesSnap.forEach((d) => {
      const inv = d.data() as Partial<Invite>;
      if (inv.workspaceId === workspace.id) {
        tasks.push({
          category: 'invites',
          path: `invites/${d.id}`,
          label: inv.email || d.id,
        });
      }
    });

    membersSnap.forEach((d) => {
      const mem = d.data() as Partial<TeamMember>;
      if (
        mem.workspaceId === workspace.id &&
        d.id !== workspace.ownerUid &&
        d.id !== callerUid
      ) {
        tasks.push({
          category: 'teamMembers',
          path: `teamMembers/${d.id}`,
          label: mem.displayName || mem.email || d.id,
        });
      }
    });
  }

  return sortResetTasks(tasks);
}

export async function runWorkspaceResetTasks(params: {
  workspace: Workspace;
  callerUid: string;
  scope: ResetScope;
  tasks: ResetTaskItem[];
  onProgress?: (progress: ResetExecutionProgress) => void;
}): Promise<{ deletedCount: number; totalCount: number }> {
  assertWorkspaceOwner(params.workspace, params.callerUid);
  const { executeChunkedResetTasks } = await import('../utils/reset');

  const result = await executeChunkedResetTasks({
    tasks: params.tasks,
    onProgress: params.onProgress,
    commitChunk: async (chunk) => {
      const batch = writeBatch(db);
      chunk.forEach((task) => {
        batch.delete(resolveDocRefFromPath(task.path));
      });
      await batch.commit();
    },
  });

  clearWorkspaceDraftStorage(params.workspace.id);

  if (params.scope === 'all') {
    await updateDoc(doc(db, 'workspaces', params.workspace.id), {
      authorizedEmails: [params.workspace.ownerEmail].filter(Boolean),
      seeded: true,
      updatedAt: serverTimestamp(),
    });
  }

  return result;
}

export async function deleteWorkerNoteByBoss(noteId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'workerNotes', noteId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `workerNotes/${noteId}`);
  }
}
