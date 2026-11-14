import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  BOOTSTRAPPED_ADMIN_EMAIL,
  DEFAULT_CATALOG_ITEMS,
  DEFAULT_SHIFT_SCHEDULE,
  DEFAULT_STATIONS,
  MAIN_WORKSPACE_ID,
  MAX_AREA_LENGTH,
  MAX_DESC_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_STOCK_VALUE,
  MAX_UNIT_LENGTH,
  TIME_PATTERN,
} from '../constants';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  Invite,
  ReportStatus,
  ShiftSchedule,
  StationId,
  StationLink,
  TeamMember,
  TeamStationId,
  Workspace,
  Workstation,
} from '../types';

export interface ResolvedSession {
  workspace: Workspace;
  role: TeamStationId;
  isOwner: boolean;
  initialStation?: StationId;
  stationLinkInfo?: StationLink;
}

function clampString(val: string, maxLen: number): string {
  return val.trim().slice(0, maxLen);
}

function clampNumber(val: number): number {
  if (!Number.isFinite(val) || val < 0) return 0;
  return Math.min(MAX_STOCK_VALUE, Math.round(val * 100) / 100);
}

function makeCleanId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

export function generateAccessCode(): string {
  const part1 = Math.random().toString(36).slice(2, 8);
  const part2 = Math.random().toString(36).slice(2, 8);
  return `tf_${part1}${part2}`.replace(/[^a-zA-Z0-9_\-]/g, '');
}

export function buildStationShareUrl(stationId: string, accessCode: string): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.origin);
  url.searchParams.set('puesto', stationId);
  url.searchParams.set('codigo', accessCode);
  return url.toString();
}

export async function fetchStationLinkPreview(accessCode: string): Promise<StationLink | null> {
  if (!accessCode || accessCode.length < 6) return null;
  try {
    const snap = await getDoc(doc(db, 'stationLinks', accessCode));
    if (!snap.exists()) return null;
    const data = { id: snap.id, ...snap.data() } as StationLink;
    return data.active ? data : null;
  } catch {
    return null;
  }
}

export async function resolveUserWorkspace(
  user: User,
  linkParams?: { stationId?: string | null; accessCode?: string | null },
): Promise<ResolvedSession> {
  const email = (user.email ?? '').trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
  const displayName = clampString(
    user.displayName || email.split('@')[0] || 'Usuario',
    MAX_NAME_LENGTH,
  );

  // 0. If user arrived via a QR / Share Link (?puesto=...&codigo=...)
  const accessCode = linkParams?.accessCode?.trim() || '';
  if (accessCode.length >= 6) {
    try {
      const linkSnap = await getDoc(doc(db, 'stationLinks', accessCode));
      if (linkSnap.exists()) {
        const link = { id: linkSnap.id, ...linkSnap.data() } as StationLink;
        if (link.active) {
          const isBoss =
            link.ownerUid === user.uid ||
            (email === BOOTSTRAPPED_ADMIN_EMAIL && link.workspaceId === MAIN_WORKSPACE_ID);

          if (isBoss) {
            const wsSnap = await getDoc(doc(db, 'workspaces', link.workspaceId));
            if (wsSnap.exists()) {
              return {
                workspace: { id: wsSnap.id, ...wsSnap.data() } as Workspace,
                role: 'jefe',
                isOwner: true,
                initialStation: link.stationId,
                stationLinkInfo: link,
              };
            }
          } else {
            const memberRef = doc(db, 'teamMembers', user.uid);
            const existingMemberSnap = await getDoc(memberRef);
            if (existingMemberSnap.exists()) {
              await updateDoc(memberRef, {
                station: link.stationId,
                inviteId: accessCode,
                displayName: link.workerName || displayName,
                updatedAt: serverTimestamp(),
              });
            } else {
              await setDoc(memberRef, {
                workspaceId: link.workspaceId,
                ownerUid: link.ownerUid,
                uid: user.uid,
                email,
                displayName: link.workerName || displayName,
                station: link.stationId,
                inviteId: accessCode,
                active: true,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }

            const wsSnap = await getDoc(doc(db, 'workspaces', link.workspaceId));
            if (wsSnap.exists()) {
              return {
                workspace: { id: wsSnap.id, ...wsSnap.data() } as Workspace,
                role: link.stationId,
                isOwner: false,
                initialStation: link.stationId,
                stationLinkInfo: link,
              };
            }
          }
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `stationLinks/${accessCode}`);
    }
  }

  // 1. Check existing active teamMember profile
  const memberPath = `teamMembers/${user.uid}`;
  try {
    const memberSnap = await getDoc(doc(db, 'teamMembers', user.uid));
    if (memberSnap.exists()) {
      const member = { id: memberSnap.id, ...memberSnap.data() } as TeamMember;
      if (member.active) {
        const wsSnap = await getDoc(doc(db, 'workspaces', member.workspaceId));
        if (wsSnap.exists()) {
          const workspace = { id: wsSnap.id, ...wsSnap.data() } as Workspace;
          return {
            workspace,
            role: member.station,
            isOwner: workspace.ownerUid === user.uid,
          };
        }
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, memberPath);
  }

  // 2. Check pending email invite
  if (email) {
    try {
      const inviteQuery = query(collection(db, 'invites'), where('email', '==', email));
      const inviteSnaps = await getDocs(inviteQuery);
      if (!inviteSnaps.empty) {
        const inviteDoc = inviteSnaps.docs[0];
        const invite = { id: inviteDoc.id, ...inviteDoc.data() } as Invite;

        await setDoc(doc(db, 'teamMembers', user.uid), {
          workspaceId: invite.workspaceId,
          ownerUid: invite.ownerUid,
          uid: user.uid,
          email,
          displayName: invite.displayName || displayName,
          station: invite.station,
          inviteId: invite.id,
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const wsSnap = await getDoc(doc(db, 'workspaces', invite.workspaceId));
        if (wsSnap.exists()) {
          const workspace = { id: wsSnap.id, ...wsSnap.data() } as Workspace;
          return {
            workspace,
            role: invite.station,
            isOwner: workspace.ownerUid === user.uid,
          };
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, 'invites');
    }
  }

  // 3. Owner workspace
  const targetWsId =
    email === BOOTSTRAPPED_ADMIN_EMAIL ? MAIN_WORKSPACE_ID : `ws_${user.uid}`;
  const wsPath = `workspaces/${targetWsId}`;

  try {
    const wsSnap = await getDoc(doc(db, 'workspaces', targetWsId));
    if (wsSnap.exists()) {
      const workspace = { id: wsSnap.id, ...wsSnap.data() } as Workspace;
      return { workspace, role: 'jefe', isOwner: true };
    }

    const newWorkspaceData = {
      name: 'The Fire',
      shiftSchedule: DEFAULT_SHIFT_SCHEDULE,
      ownerUid: user.uid,
      ownerEmail: email,
      authorizedEmails: [email],
      seeded: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'workspaces', targetWsId), newWorkspaceData);

    const createdSnap = await getDoc(doc(db, 'workspaces', targetWsId));
    const workspace = { id: createdSnap.id, ...createdSnap.data() } as Workspace;
    await seedDefaultWorkstationsAndCatalog(workspace);
    const refreshedSnap = await getDoc(doc(db, 'workspaces', targetWsId));
    return {
      workspace: { id: refreshedSnap.id, ...refreshedSnap.data() } as Workspace,
      role: 'jefe',
      isOwner: true,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, wsPath);
  }
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
  if (existingStations.length > 0) return;

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
    initialItems?: Array<{ name: string; unit: string; minStock: number; targetStock: number }>;
  },
): Promise<Workstation> {
  const stationId = makeCleanId('puesto');
  const accessCode = generateAccessCode();
  const initialItems = payload.initialItems ?? [];
  const batch = writeBatch(db);

  initialItems.forEach((item, idx) => {
    const itemId = `${stationId}_${idx + 1}`;
    batch.set(doc(db, 'items', itemId), {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      authorizedEmails: workspace.authorizedEmails.slice(0, 15),
      station: stationId,
      name: clampString(item.name, MAX_NAME_LENGTH),
      unit: clampString(item.unit, MAX_UNIT_LENGTH),
      minStock: clampNumber(item.minStock),
      targetStock: clampNumber(item.targetStock),
      active: true,
      sortOrder: (idx + 1) * 10,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  const stationBase: Omit<Workstation, 'id' | 'createdAt' | 'updatedAt'> = {
    workspaceId: workspace.id,
    ownerUid: workspace.ownerUid,
    authorizedEmails: workspace.authorizedEmails.slice(0, 15),
    name: clampString(payload.name, MAX_NAME_LENGTH),
    area: clampString(payload.area, MAX_AREA_LENGTH),
    workerName: clampString(payload.workerName, MAX_NAME_LENGTH),
    description: clampString(payload.description, MAX_DESC_LENGTH),
    accessCode,
    nextItemSlot: initialItems.length + 1,
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
    batch.delete(doc(db, 'items', item.id));
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `stations/${station.id}`);
  }
}

export async function updateWorkspaceName(workspaceId: string, name: string): Promise<void> {
  const cleanName = clampString(name, MAX_NAME_LENGTH);
  if (cleanName.length < 2) return;
  try {
    await updateDoc(doc(db, 'workspaces', workspaceId), {
      name: cleanName,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workspaces/${workspaceId}`);
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
  if (
    !TIME_PATTERN.test(schedule.openingStart) ||
    !TIME_PATTERN.test(schedule.openingEnd) ||
    !TIME_PATTERN.test(schedule.closingStart) ||
    !TIME_PATTERN.test(schedule.closingEnd)
  ) {
    throw new Error('Formato de hora inválido.');
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
  },
): Promise<void> {
  const slot = station ? Math.max(1, station.nextItemSlot) : Math.floor(Date.now() % 100000);
  const itemId = `${payload.station}_${slot}`;
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
    active: true,
    sortOrder: clampNumber(payload.sortOrder),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (station) {
    batch.update(doc(db, 'stations', station.id), {
      nextItemSlot: slot + 1,
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
  },
): Promise<void> {
  try {
    await updateDoc(doc(db, 'items', itemId), {
      station: payload.station,
      name: clampString(payload.name, MAX_NAME_LENGTH),
      unit: clampString(payload.unit, MAX_UNIT_LENGTH),
      minStock: clampNumber(payload.minStock),
      targetStock: clampNumber(payload.targetStock),
      active: payload.active,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${itemId}`);
  }
}

export async function deleteInventoryItem(itemId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'items', itemId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `items/${itemId}`);
  }
}

export async function loadWorkerStationFallback(params: {
  workspaceId: string;
  stationId: string;
  dateStr: string;
}): Promise<{
  station: Workstation | null;
  items: InventoryItem[];
  report: DailyReport | undefined;
  entries: Record<string, DailyReportEntry>;
}> {
  const { workspaceId, stationId, dateStr } = params;
  try {
    const stSnap = await getDoc(doc(db, 'stations', stationId));
    const station = stSnap.exists()
      ? ({ id: stSnap.id, ...stSnap.data() } as Workstation)
      : null;

    const maxSlot = station ? Math.min(200, station.nextItemSlot) : 40;
    const itemPromises: Promise<InventoryItem | null>[] = [];
    for (let slot = 1; slot < maxSlot; slot++) {
      const id = `${stationId}_${slot}`;
      itemPromises.push(
        getDoc(doc(db, 'items', id)).then((snap) =>
          snap.exists() ? ({ id: snap.id, ...snap.data() } as InventoryItem) : null,
        ),
      );
    }
    const fetchedItems = (await Promise.all(itemPromises)).filter(
      (it): it is InventoryItem => Boolean(it && it.active),
    );
    fetchedItems.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    const reportId = `${workspaceId}_${dateStr}_${stationId}`;
    const repSnap = await getDoc(doc(db, 'dailyReports', reportId));
    const report = repSnap.exists()
      ? ({ id: repSnap.id, ...repSnap.data() } as DailyReport)
      : undefined;

    const entries: Record<string, DailyReportEntry> = {};
    if (report) {
      const entrySnaps = await Promise.all(
        fetchedItems.map((it) =>
          getDoc(doc(db, 'dailyReports', reportId, 'entries', it.id)),
        ),
      );
      entrySnaps.forEach((snap) => {
        if (snap.exists()) {
          const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
          entries[entry.itemId] = entry;
        }
      });
    }

    return { station, items: fetchedItems, report, entries };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `stations/${stationId}`);
  }
}

export async function fetchStationEntriesOnce(
  workspaceId: string,
  dateStr: string,
  station: StationId,
  itemIds: string[],
): Promise<Record<string, DailyReportEntry>> {
  const reportId = `${workspaceId}_${dateStr}_${station}`;
  const path = `dailyReports/${reportId}`;
  try {
    const repSnap = await getDoc(doc(db, 'dailyReports', reportId));
    if (!repSnap.exists()) return {};

    const snaps = await Promise.all(
      itemIds.map((itemId) => getDoc(doc(db, 'dailyReports', reportId, 'entries', itemId))),
    );
    const map: Record<string, DailyReportEntry> = {};
    snaps.forEach((snap) => {
      if (snap.exists()) {
        const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
        map[entry.itemId] = entry;
      }
    });
    return map;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveStationReportBatch(params: {
  workspace: Workspace;
  user: User;
  date: string;
  station: StationId;
  mode: 'opening' | 'closing';
  notes: string;
  rows: DraftEntryRow[];
  existingReport: DailyReport | undefined;
  existingEntries: Record<string, DailyReportEntry>;
}): Promise<void> {
  const { workspace, user, date, station, mode, notes, rows, existingReport, existingEntries } = params;
  const reportId = `${workspace.id}_${date}_${station}`;
  const reporterName = clampString(
    user.displayName || user.email?.split('@')[0] || 'Encargada',
    MAX_NAME_LENGTH,
  );
  const nextStatus: ReportStatus = mode === 'closing' ? 'completed' : 'opening_saved';
  const cleanNotes = clampString(notes, MAX_NOTES_LENGTH);
  const authorizedEmails = workspace.authorizedEmails.slice(0, 15);

  const batch = writeBatch(db);
  const reportRef = doc(db, 'dailyReports', reportId);

  if (existingReport) {
    batch.update(reportRef, {
      status: nextStatus,
      reportedByUid: user.uid,
      reportedByName: reporterName,
      notes: cleanNotes,
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.set(reportRef, {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      authorizedEmails,
      date,
      station,
      status: nextStatus,
      reportedByUid: user.uid,
      reportedByName: reporterName,
      notes: cleanNotes,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  rows.forEach((row) => {
    const entryRef = doc(db, 'dailyReports', reportId, 'entries', row.itemId);
    const prev = existingEntries[row.itemId];
    const hasOpening = mode === 'opening' ? true : prev ? prev.hasOpening : row.hasOpening;
    const hasClosing = mode === 'closing' ? true : prev ? prev.hasClosing : row.hasClosing;

    if (prev) {
      batch.update(entryRef, {
        itemName: clampString(row.itemName, MAX_NAME_LENGTH),
        unit: clampString(row.unit, MAX_UNIT_LENGTH),
        minStock: clampNumber(row.minStock),
        targetStock: clampNumber(row.targetStock),
        opening: clampNumber(row.opening),
        added: clampNumber(row.added),
        closing: clampNumber(row.closing),
        hasOpening,
        hasClosing,
        updatedByUid: user.uid,
        updatedByName: reporterName,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(entryRef, {
        workspaceId: workspace.id,
        ownerUid: workspace.ownerUid,
        authorizedEmails,
        reportId,
        itemId: row.itemId,
        station,
        date,
        itemName: clampString(row.itemName, MAX_NAME_LENGTH),
        unit: clampString(row.unit, MAX_UNIT_LENGTH),
        minStock: clampNumber(row.minStock),
        targetStock: clampNumber(row.targetStock),
        opening: clampNumber(row.opening),
        added: clampNumber(row.added),
        closing: clampNumber(row.closing),
        hasOpening,
        hasClosing,
        updatedByUid: user.uid,
        updatedByName: reporterName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `dailyReports/${reportId}`);
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
  emailsToInclude: string[];
  stations: Workstation[];
  items: InventoryItem[];
  reports: DailyReport[];
  entries: DailyReportEntry[];
}): Promise<void> {
  const nextEmails = Array.from(
    new Set([
      params.workspace.ownerEmail,
      ...params.workspace.authorizedEmails,
      ...params.emailsToInclude.map((e) => e.trim().toLowerCase()),
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

  const nextEmails = Array.from(
    new Set([params.workspace.ownerEmail, ...params.workspace.authorizedEmails, cleanEmail]),
  ).slice(0, 15);

  const batch = writeBatch(db);
  batch.set(doc(db, 'invites', inviteId), {
    workspaceId: params.workspace.id,
    ownerUid: params.workspace.ownerUid,
    email: cleanEmail,
    displayName: cleanName,
    station: params.station,
    createdAt: serverTimestamp(),
  });

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

  const batch = writeBatch(db);
  if (params.inviteId) {
    batch.delete(doc(db, 'invites', params.inviteId));
  }
  if (params.memberId) {
    batch.delete(doc(db, 'teamMembers', params.memberId));
  }

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

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workspaces/${params.workspace.id}`);
  }
}
