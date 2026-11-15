import type { User } from 'firebase/auth';
import {
  collection,
  deleteField,
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
  DEFAULT_CATALOG_ITEMS,
  DEFAULT_SHIFT_SCHEDULE,
  DEFAULT_STATIONS,
  MAIN_WORKSPACE_ID,
  MAX_AREA_LENGTH,
  MAX_DESC_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PACK_LABEL_LENGTH,
  MAX_PACK_SIZE,
  MAX_UNIT_LENGTH,
} from '../constants';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  CaptureInputType,
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
import { sanitizeStockQuantity } from '../utils/inventory';
import { validateShiftSchedule } from '../utils/schedule';

export interface ResolvedSession {
  workspace: Workspace;
  role: TeamStationId;
  isOwner: boolean;
  initialStation?: StationId;
  stationLinkInfo?: StationLink;
}

export class SessionAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionAccessError';
  }
}

export class ConcurrencyConflictError extends Error {
  readonly reason: 'completed_locked' | 'concurrent_create' | 'concurrent_update';
  readonly serverUpdatedByName?: string;
  readonly serverStatus?: ReportStatus;

  constructor(
    message: string,
    reason: 'completed_locked' | 'concurrent_create' | 'concurrent_update',
    details?: { serverUpdatedByName?: string; serverStatus?: ReportStatus },
  ) {
    super(message);
    this.name = 'ConcurrencyConflictError';
    this.reason = reason;
    this.serverUpdatedByName = details?.serverUpdatedByName;
    this.serverStatus = details?.serverStatus;
  }
}

export class DiagnosticSaveError extends Error {
  readonly title: string;
  readonly detail: string;
  readonly failedDocumentPath: string;
  readonly code?: string;

  constructor(params: {
    title: string;
    detail: string;
    failedDocumentPath: string;
    code?: string;
  }) {
    super(`${params.title}: ${params.detail}`);
    this.name = 'DiagnosticSaveError';
    this.title = params.title;
    this.detail = params.detail;
    this.failedDocumentPath = params.failedDocumentPath;
    this.code = params.code;
  }
}

export function evaluateReportSaveGuard(params: {
  mode: 'opening' | 'closing';
  canManage: boolean;
  expectedUpdatedAtMs?: number | null;
  forceOverwrite?: boolean;
  serverExists: boolean;
  serverStatus?: ReportStatus;
  serverUpdatedAtMs?: number | null;
  serverUpdatedByName?: string;
}):
  | {
      ok: true;
      effectiveStatus: ReportStatus;
    }
  | {
      ok: false;
      reason: 'completed_locked' | 'concurrent_create' | 'concurrent_update';
      message: string;
    } {
  const {
    mode,
    canManage,
    expectedUpdatedAtMs,
    forceOverwrite,
    serverExists,
    serverStatus,
    serverUpdatedAtMs,
    serverUpdatedByName,
  } = params;

  const requestedStatus: ReportStatus = mode === 'closing' ? 'completed' : 'opening_saved';

  // Downgrade protection: never allow workers to edit/reopen a completed report,
  // and never let boss opening adjustments silently downgrade a completed status.
  if (serverExists && serverStatus === 'completed') {
    if (!canManage) {
      return {
        ok: false,
        reason: 'completed_locked',
        message:
          'Este cierre ya fue enviado al jefe. Pídele que reabra la planilla si necesitas corregirlo.',
      };
    }
  }

  const effectiveStatus: ReportStatus =
    serverExists && serverStatus === 'completed' ? 'completed' : requestedStatus;

  if (!forceOverwrite && expectedUpdatedAtMs !== undefined) {
    if (expectedUpdatedAtMs === null && serverExists) {
      return {
        ok: false,
        reason: 'concurrent_create',
        message: `${serverUpdatedByName || 'Otra persona'} acaba de guardar esta planilla desde otro dispositivo. Revisa los cambios antes de sobrescribir.`,
      };
    }

    if (
      typeof expectedUpdatedAtMs === 'number' &&
      serverExists &&
      typeof serverUpdatedAtMs === 'number' &&
      serverUpdatedAtMs !== expectedUpdatedAtMs
    ) {
      return {
        ok: false,
        reason: 'concurrent_update',
        message: `${serverUpdatedByName || 'Otra persona'} actualizó esta planilla después de que la abriste. Revisa los cambios o confirma si deseas sobrescribir.`,
      };
    }
  }

  return {
    ok: true,
    effectiveStatus,
  };
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62_ALPHABET[bytes[i] % BASE62_ALPHABET.length];
  }
  return result;
}

function clampString(val: string, maxLen: number): string {
  return val.trim().slice(0, maxLen);
}

function clampNumber(val: number): number {
  return sanitizeStockQuantity(val);
}

function makeCleanId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomBase62(8)}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

export function generateAccessCode(): string {
  return `tf_${randomBase62(18)}`;
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

async function checkIsAdminUser(uid: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'admins', uid));
    return snap.exists();
  } catch {
    return false;
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
  const isAdmin = await checkIsAdminUser(user.uid);

  // 0. If user arrived via a QR / Share Link (?puesto=...&codigo=...)
  const rawAccessCode = linkParams?.accessCode?.trim() || '';
  if (rawAccessCode.length > 0 && rawAccessCode.length < 6) {
    throw new SessionAccessError('El enlace o código QR ingresado no es válido.');
  }

  if (rawAccessCode.length >= 6) {
    let linkSnap;
    try {
      linkSnap = await getDoc(doc(db, 'stationLinks', rawAccessCode));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `stationLinks/${rawAccessCode}`);
    }

    if (!linkSnap.exists()) {
      throw new SessionAccessError(
        'Este enlace o código QR ya no es válido porque fue regenerado o eliminado por el jefe.',
      );
    }

    const link = { id: linkSnap.id, ...linkSnap.data() } as StationLink;
    if (!link.active) {
      throw new SessionAccessError(
        'Este enlace está temporalmente desactivado por el jefe. Pídele que lo reactive o te comparta uno nuevo.',
      );
    }

    const isBoss = link.ownerUid === user.uid || isAdmin;
    if (isBoss) {
      try {
        const wsSnap = await getDoc(doc(db, 'workspaces', link.workspaceId));
        if (wsSnap.exists()) {
          const workspace = { id: wsSnap.id, ...wsSnap.data() } as Workspace;
          return {
            workspace,
            role: 'jefe',
            isOwner: workspace.ownerUid === user.uid || isAdmin,
            initialStation: link.stationId,
            stationLinkInfo: link,
          };
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `workspaces/${link.workspaceId}`);
      }
    }

    // Worker arriving with active QR / link
    const memberRef = doc(db, 'teamMembers', user.uid);
    let existingMemberSnap;
    try {
      existingMemberSnap = await getDoc(memberRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `teamMembers/${user.uid}`);
    }

    if (existingMemberSnap.exists()) {
      const existing = { id: existingMemberSnap.id, ...existingMemberSnap.data() } as TeamMember;
      if (existing.workspaceId !== link.workspaceId) {
        throw new SessionAccessError('Tu cuenta pertenece a otro restaurante.');
      }
      if (!existing.active) {
        throw new SessionAccessError(
          'Tu acceso fue desactivado por el jefe. Pídele que te habilite nuevamente.',
        );
      }
      if (existing.station === 'jefe') {
        const wsSnap = await getDoc(doc(db, 'workspaces', link.workspaceId));
        if (wsSnap.exists()) {
          return {
            workspace: { id: wsSnap.id, ...wsSnap.data() } as Workspace,
            role: 'jefe',
            isOwner: false,
            initialStation: link.stationId,
            stationLinkInfo: link,
          };
        }
      }
      if (existing.station !== link.stationId) {
        throw new SessionAccessError(
          'Tu cuenta ya está vinculada a otro puesto de trabajo. No puedes cambiarte de puesto con otro QR; pídele al jefe que actualice tu puesto.',
        );
      }

      try {
        await updateDoc(memberRef, {
          inviteId: rawAccessCode,
          displayName: link.workerName || displayName,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `teamMembers/${user.uid}`);
      }
    } else {
      try {
        await setDoc(memberRef, {
          workspaceId: link.workspaceId,
          ownerUid: link.ownerUid,
          uid: user.uid,
          email,
          displayName: link.workerName || displayName,
          station: link.stationId,
          inviteId: rawAccessCode,
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, `teamMembers/${user.uid}`);
      }
    }

    try {
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
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `workspaces/${link.workspaceId}`);
    }
  }

  // 1. Check existing teamMember profile
  const memberPath = `teamMembers/${user.uid}`;
  let memberSnap;
  try {
    memberSnap = await getDoc(doc(db, 'teamMembers', user.uid));
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, memberPath);
  }

  if (memberSnap.exists()) {
    const member = { id: memberSnap.id, ...memberSnap.data() } as TeamMember;
    if (!member.active) {
      if (!isAdmin) {
        throw new SessionAccessError(
          'Tu acceso a este restaurante fue desactivado por el jefe.',
        );
      }
    } else {
      try {
        const wsSnap = await getDoc(doc(db, 'workspaces', member.workspaceId));
        if (wsSnap.exists()) {
          const workspace = { id: wsSnap.id, ...wsSnap.data() } as Workspace;
          return {
            workspace,
            role: member.station,
            isOwner: workspace.ownerUid === user.uid || isAdmin,
          };
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `workspaces/${member.workspaceId}`);
      }
    }
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
            isOwner: workspace.ownerUid === user.uid || isAdmin,
          };
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, 'invites');
    }
  }

  // 3. Check existing owned/authorized workspaces (including main restaurant for owner/admins)
  try {
    const mainWsSnap = await getDoc(doc(db, 'workspaces', MAIN_WORKSPACE_ID));
    if (mainWsSnap.exists()) {
      const workspace = { id: mainWsSnap.id, ...mainWsSnap.data() } as Workspace;
      if (
        isAdmin ||
        workspace.ownerUid === user.uid ||
        (email && workspace.authorizedEmails.includes(email))
      ) {
        return {
          workspace,
          role: 'jefe',
          isOwner: workspace.ownerUid === user.uid || isAdmin,
        };
      }
    }
  } catch {
    // User does not have access to MAIN_WORKSPACE_ID; continue to personal workspace
  }

  try {
    const ownedQuery = query(collection(db, 'workspaces'), where('ownerUid', '==', user.uid));
    const ownedSnaps = await getDocs(ownedQuery);
    if (!ownedSnaps.empty) {
      const firstWs = ownedSnaps.docs[0];
      const workspace = { id: firstWs.id, ...firstWs.data() } as Workspace;
      return { workspace, role: 'jefe', isOwner: true };
    }
  } catch {
    // Fall through to creating personal workspace
  }

  // 4. Create or open workspace for owner/admin
  const targetWsId = isAdmin ? MAIN_WORKSPACE_ID : `ws_${user.uid}`;
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
    batch.delete(doc(db, 'items', item.id));
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
    }
    return result;
  }

  if (inputType === 'level') {
    const safeCapacity = Math.max(0.1, clampNumber(Number(payload.capacity ?? 1)));
    const result: Record<string, unknown> = {
      inputType: 'level',
      capacity: safeCapacity,
    };
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
  }
  return result;
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
    ...buildItemCapturePayload(payload, false),
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
  } & InventoryItemCapturePayload,
): Promise<void> {
  try {
    await updateDoc(doc(db, 'items', itemId), {
      station: payload.station,
      name: clampString(payload.name, MAX_NAME_LENGTH),
      unit: clampString(payload.unit, MAX_UNIT_LENGTH),
      minStock: clampNumber(payload.minStock),
      targetStock: clampNumber(payload.targetStock),
      ...buildItemCapturePayload(payload, true),
      active: payload.active,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${itemId}`);
  }
}

export async function setInventoryItemActive(itemId: string, active: boolean): Promise<void> {
  try {
    await updateDoc(doc(db, 'items', itemId), {
      active,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${itemId}`);
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
  canManage: boolean;
  date: string;
  station: StationId;
  mode: 'opening' | 'closing';
  notes: string;
  rows: DraftEntryRow[];
  existingReport: DailyReport | undefined;
  existingEntries: Record<string, DailyReportEntry>;
  expectedUpdatedAtMs?: number | null;
  forceOverwrite?: boolean;
}): Promise<{ queuedOffline: boolean }> {
  const {
    workspace,
    user,
    canManage,
    date,
    station,
    mode,
    notes,
    rows,
    existingReport,
    existingEntries,
    expectedUpdatedAtMs,
    forceOverwrite,
  } = params;
  const reportId = `${workspace.id}_${date}_${station}`;
  const reporterName = clampString(
    user.displayName || user.email?.split('@')[0] || 'Encargada',
    MAX_NAME_LENGTH,
  );
  const cleanNotes = clampString(notes, MAX_NOTES_LENGTH);
  const rawAuthorizedEmails = (workspace.authorizedEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length >= 3 && e.length <= 120 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    .slice(0, 15);
  const authorizedEmails =
    rawAuthorizedEmails.length > 0
      ? rawAuthorizedEmails
      : [workspace.ownerEmail.trim().toLowerCase()];
  const reportRef = doc(db, 'dailyReports', reportId);

  let detectedOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  let serverExists = Boolean(existingReport);
  let serverStatus: ReportStatus | undefined = existingReport?.status;
  let serverUpdatedAtMs: number | null = existingReport?.updatedAt?.toMillis?.() ?? null;
  let serverUpdatedByName: string | undefined = existingReport?.reportedByName;

  if (!detectedOffline) {
    try {
      const serverSnap = await getDoc(reportRef);
      serverExists = serverSnap.exists();
      if (serverExists) {
        const data = serverSnap.data() as Partial<DailyReport>;
        serverStatus = data.status;
        serverUpdatedAtMs =
          data.updatedAt && typeof data.updatedAt.toMillis === 'function'
            ? data.updatedAt.toMillis()
            : null;
        serverUpdatedByName = data.reportedByName;
      } else {
        serverStatus = undefined;
        serverUpdatedAtMs = null;
        serverUpdatedByName = undefined;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      const isOffline = msg.includes('offline') || msg.includes('unavailable');
      if (isOffline) {
        detectedOffline = true;
      } else {
        handleFirestoreError(err, OperationType.GET, `dailyReports/${reportId}`);
      }
    }
  }

  const guard = evaluateReportSaveGuard({
    mode,
    canManage,
    expectedUpdatedAtMs,
    forceOverwrite,
    serverExists,
    serverStatus,
    serverUpdatedAtMs,
    serverUpdatedByName,
  });

  if (!guard.ok) {
    throw new ConcurrencyConflictError(guard.message, guard.reason, {
      serverUpdatedByName,
      serverStatus,
    });
  }

  // Merge any remote entries created concurrently so we use batch.update instead of batch.set
  const mergedExistingEntries: Record<string, DailyReportEntry> = { ...existingEntries };
  if (!detectedOffline && serverExists) {
    const missingIds = rows
      .map((r) => r.itemId)
      .filter((id) => !mergedExistingEntries[id]);
    if (missingIds.length > 0) {
      try {
        const fetched = await Promise.all(
          missingIds.map((itemId) => getDoc(doc(db, 'dailyReports', reportId, 'entries', itemId))),
        );
        fetched.forEach((snap) => {
          if (snap.exists()) {
            const entry = { id: snap.id, ...snap.data() } as DailyReportEntry;
            mergedExistingEntries[entry.itemId] = entry;
          }
        });
      } catch {
        // Proceed with client snapshot if offline
      }
    }
  }

  interface EntryWriteOp {
    itemId: string;
    itemName: string;
    ref: ReturnType<typeof doc>;
    kind: 'update' | 'set';
    payload: Record<string, unknown>;
    updatePayload: Record<string, unknown>;
    createPayload: Record<string, unknown>;
  }

  const entryOperations: EntryWriteOp[] = [];

  rows.forEach((row) => {
    const prev = mergedExistingEntries[row.itemId];
    const notApplicable = Boolean(row.notApplicable);
    const hasOpening = notApplicable
      ? false
      : row.hasOpening || Boolean(prev?.hasOpening && mode === 'closing');
    const hasClosing = notApplicable
      ? false
      : row.hasClosing || Boolean(prev?.hasClosing && mode === 'opening');
    const addedVal = clampNumber(row.added);

    if (!prev && !hasOpening && !hasClosing && !notApplicable && addedVal === 0) {
      return;
    }

    const entryRef = doc(db, 'dailyReports', reportId, 'entries', row.itemId);
    const openingVal =
      !row.hasOpening && prev?.hasOpening ? clampNumber(prev.opening) : clampNumber(row.opening);
    const effectiveAdded =
      !row.hasOpening && prev && row.added === 0 ? clampNumber(prev.added) : addedVal;
    const closingVal =
      !row.hasClosing && prev?.hasClosing ? clampNumber(prev.closing) : clampNumber(row.closing);

    const previousClosingVal =
      typeof row.previousClosing === 'number'
        ? clampNumber(row.previousClosing)
        : typeof prev?.previousClosing === 'number'
          ? clampNumber(prev.previousClosing)
          : undefined;
    const derivedOpeningStatus =
      notApplicable
        ? undefined
        : row.openingStatus ??
          (hasOpening && previousClosingVal !== undefined
            ? openingVal === previousClosingVal
              ? 'confirmed_match'
              : 'adjusted'
            : hasOpening
              ? prev?.openingStatus ?? 'manual'
              : prev?.openingStatus);

    const updatePayload: Record<string, unknown> = {
      opening: openingVal,
      added: effectiveAdded,
      closing: closingVal,
      hasOpening,
      hasClosing,
      notApplicable,
      updatedByUid: user.uid,
      updatedByName: reporterName,
      updatedAt: serverTimestamp(),
    };
    if (previousClosingVal !== undefined) {
      updatePayload.previousClosing = previousClosingVal;
    }
    if (derivedOpeningStatus !== undefined) {
      updatePayload.openingStatus = derivedOpeningStatus;
    }
    if (canManage) {
      updatePayload.itemName = row.itemName;
      updatePayload.unit = row.unit;
      updatePayload.minStock = clampNumber(row.minStock);
      updatePayload.targetStock = clampNumber(row.targetStock);
    }

    const createPayload: Record<string, unknown> = {
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
      authorizedEmails,
      reportId,
      itemId: row.itemId,
      station,
      date,
      itemName: row.itemName,
      unit: row.unit,
      minStock: canManage ? clampNumber(row.minStock) : Number(row.minStock),
      targetStock: canManage ? clampNumber(row.targetStock) : Number(row.targetStock),
      opening: openingVal,
      added: effectiveAdded,
      closing: closingVal,
      hasOpening,
      hasClosing,
      notApplicable,
      updatedByUid: user.uid,
      updatedByName: reporterName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (previousClosingVal !== undefined) {
      createPayload.previousClosing = previousClosingVal;
    }
    if (derivedOpeningStatus !== undefined) {
      createPayload.openingStatus = derivedOpeningStatus;
    }

    entryOperations.push({
      itemId: row.itemId,
      itemName: row.itemName,
      ref: entryRef,
      kind: prev ? 'update' : 'set',
      payload: prev ? updatePayload : createPayload,
      updatePayload,
      createPayload,
    });
  });

  // Chunk into batches of <= 8 entries so Firestore security rules stay safely under the 20-read batch limit
  const MAX_ENTRIES_PER_BATCH = 8;
  const entryChunks: EntryWriteOp[][] = [];
  if (entryOperations.length === 0) {
    entryChunks.push([]);
  } else {
    for (let i = 0; i < entryOperations.length; i += MAX_ENTRIES_PER_BATCH) {
      entryChunks.push(entryOperations.slice(i, i + MAX_ENTRIES_PER_BATCH));
    }
  }

  const intermediateStatus: ReportStatus =
    serverExists && serverStatus === 'completed' ? 'completed' : 'opening_saved';

  const batches = entryChunks.map((chunk, chunkIdx) => {
    const chunkBatch = writeBatch(db);
    const isFirst = chunkIdx === 0;
    const isLast = chunkIdx === entryChunks.length - 1;
    const chunkStatus = isLast ? guard.effectiveStatus : intermediateStatus;

    if (isFirst) {
      if (serverExists) {
        chunkBatch.update(reportRef, {
          status: chunkStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          updatedAt: serverTimestamp(),
        });
      } else {
        chunkBatch.set(reportRef, {
          workspaceId: workspace.id,
          ownerUid: workspace.ownerUid,
          authorizedEmails,
          date,
          station,
          status: chunkStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } else if (isLast) {
      chunkBatch.update(reportRef, {
        status: guard.effectiveStatus,
        reportedByUid: user.uid,
        reportedByName: reporterName,
        notes: cleanNotes,
        updatedAt: serverTimestamp(),
      });
    }

    chunk.forEach((op) => {
      if (op.kind === 'update') {
        chunkBatch.update(op.ref, op.payload);
      } else {
        chunkBatch.set(op.ref, op.payload);
      }
    });

    return chunkBatch;
  });

  if (detectedOffline) {
    // Firestore persistentLocalCache durably queues the batches in IndexedDB; resolve once queued
    Promise.all(batches.map((b) => b.commit())).catch((error) => {
      console.error('Error al sincronizar envío offline al reconectar:', error);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    return { queuedOffline: true };
  }

  const extractFirebaseCode = (error: unknown): string | undefined =>
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;

  try {
    for (const b of batches) {
      await b.commit();
    }
    return { queuedOffline: false };
  } catch (batchError) {
    console.warn(
      `[saveStationReportBatch] Lote rechazado (${extractFirebaseCode(batchError) ?? 'error'}). Iniciando diagnóstico documento por documento...`,
      batchError,
    );

    // Diagnostic mode: save report alone first, then each entry 1-by-1 to isolate exact doc & reason
    let liveReportExists = serverExists;
    try {
      const liveReportSnap = await getDoc(reportRef);
      liveReportExists = liveReportSnap.exists();
    } catch {
      // Keep prior knowledge if read fails
    }

    const firstStepReportStatus: ReportStatus =
      entryOperations.length === 0 ? guard.effectiveStatus : intermediateStatus;

    try {
      if (liveReportExists) {
        await updateDoc(reportRef, {
          status: firstStepReportStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(reportRef, {
          workspaceId: workspace.id,
          ownerUid: workspace.ownerUid,
          authorizedEmails,
          date,
          station,
          status: firstStepReportStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (reportWriteError) {
      const errCode = extractFirebaseCode(reportWriteError) ?? extractFirebaseCode(batchError);
      const reasons: string[] = [];

      if (!user.emailVerified) {
        reasons.push('tu cuenta de Google no tiene email verificado');
      }
      if (!canManage) {
        try {
          const [memSnap, wsSnap, repSnap] = await Promise.all([
            getDoc(doc(db, 'teamMembers', user.uid)),
            getDoc(doc(db, 'workspaces', workspace.id)),
            getDoc(reportRef),
          ]);
          if (!memSnap.exists()) {
            reasons.push(`no existe teamMembers/${user.uid}`);
          } else {
            const m = memSnap.data() as Partial<TeamMember>;
            if (!m.active) reasons.push('tu acceso en teamMembers está desactivado (active: false)');
            if (m.workspaceId !== workspace.id) {
              reasons.push(`teamMembers.workspaceId (${m.workspaceId}) no coincide con ${workspace.id}`);
            }
            if (m.station !== station) {
              reasons.push(`teamMembers.station (${m.station}) no coincide con ${station}`);
            }
          }
          if (wsSnap.exists()) {
            const ws = wsSnap.data() as Partial<Workspace>;
            if (ws.ownerUid !== workspace.ownerUid) {
              reasons.push('el ownerUid del restaurante cambió en el servidor');
            }
            if (ws.shiftSchedule?.enabled) {
              reasons.push(
                `horario servidor habilitado (${ws.shiftSchedule.openingStart}–${ws.shiftSchedule.openingEnd} / ${ws.shiftSchedule.closingStart}–${ws.shiftSchedule.closingEnd}), fecha reporte: ${date}`,
              );
            }
          }
          if (repSnap.exists()) {
            const r = repSnap.data() as Partial<DailyReport>;
            if (r.status === 'completed') {
              reasons.push('el reporte ya está marcado como completed');
            }
          }
        } catch {
          // Ignore secondary diagnostic read errors
        }
      }

      const opLabel = liveReportExists ? 'actualización' : 'creación';
      const detail =
        reasons.length > 0
          ? `Documento rechazado: dailyReports/${reportId} (${opLabel}). Motivo: ${reasons.join('; ')}.`
          : `Documento rechazado: dailyReports/${reportId} (${opLabel}). Verifica el horario permitido, la fecha operativa (${date}) o que el reporte no esté bloqueado.`;

      console.error('Firestore Diagnostic Report Error:', {
        path: `dailyReports/${reportId}`,
        code: errCode,
        reasons,
        reportWriteError,
      });

      throw new DiagnosticSaveError({
        title: 'Firebase rechazó el encabezado del reporte',
        detail,
        failedDocumentPath: `dailyReports/${reportId}`,
        code: errCode,
      });
    }

    // Report succeeded; now write each entry one by one
    for (const op of entryOperations) {
      let liveEntryExists = op.kind === 'update';
      try {
        const entrySnap = await getDoc(op.ref);
        liveEntryExists = entrySnap.exists();
      } catch {
        // Use expected op kind if pre-read fails
      }

      try {
        if (liveEntryExists) {
          await updateDoc(op.ref, op.updatePayload);
        } else {
          await setDoc(op.ref, op.createPayload);
        }
      } catch (entryWriteError) {
        const errCode = extractFirebaseCode(entryWriteError) ?? extractFirebaseCode(batchError);
        const reasons: string[] = [];

        try {
          const [itemSnap, repSnap, wsSnap] = await Promise.all([
            getDoc(doc(db, 'items', op.itemId)),
            getDoc(reportRef),
            getDoc(doc(db, 'workspaces', workspace.id)),
          ]);

          if (!itemSnap.exists()) {
            reasons.push(`el insumo items/${op.itemId} no existe en el servidor`);
          } else {
            const it = itemSnap.data() as Partial<InventoryItem>;
            if (it.workspaceId !== workspace.id) {
              reasons.push(`workspaceId del catálogo (${it.workspaceId}) ≠ ${workspace.id}`);
            }
            if (it.station !== station && !(it.station === 'hamburguesas' && station === 'comida_rapida')) {
              reasons.push(`puesto en catálogo (${it.station}) ≠ ${station}`);
            }
            if (it.name !== op.createPayload.itemName) {
              reasons.push(`nombre en catálogo ("${it.name}") ≠ "${String(op.createPayload.itemName)}"`);
            }
            if (it.unit !== op.createPayload.unit) {
              reasons.push(`unidad en catálogo ("${it.unit}") ≠ "${String(op.createPayload.unit)}"`);
            }
            if (it.minStock !== op.createPayload.minStock) {
              reasons.push(`minStock en catálogo (${it.minStock}) ≠ ${String(op.createPayload.minStock)}`);
            }
            if (it.targetStock !== op.createPayload.targetStock) {
              reasons.push(`targetStock en catálogo (${it.targetStock}) ≠ ${String(op.createPayload.targetStock)}`);
            }
          }

          if (repSnap.exists()) {
            const rep = repSnap.data() as Partial<DailyReport>;
            if (rep.status === 'completed') {
              reasons.push(`dailyReports/${reportId} está en estado completed`);
            }
            if (rep.ownerUid && rep.ownerUid !== workspace.ownerUid) {
              reasons.push(`ownerUid del reporte (${rep.ownerUid}) ≠ ${workspace.ownerUid}`);
            }
          } else {
            reasons.push(`no existe dailyReports/${reportId}`);
          }

          if (wsSnap.exists()) {
            const ws = wsSnap.data() as Partial<Workspace>;
            if (ws.ownerUid !== workspace.ownerUid) {
              reasons.push(`ownerUid del restaurante (${ws.ownerUid}) ≠ ${workspace.ownerUid}`);
            }
            if (ws.shiftSchedule?.enabled) {
              reasons.push(
                `ventana configurada en servidor (${ws.shiftSchedule.openingStart}–${ws.shiftSchedule.openingEnd} / ${ws.shiftSchedule.closingStart}–${ws.shiftSchedule.closingEnd}), fecha: ${date}`,
              );
            }
          }
        } catch {
          // Ignore secondary diagnostic read errors
        }

        const entryPath = `dailyReports/${reportId}/entries/${op.itemId}`;
        const opLabel = liveEntryExists ? 'actualización' : 'creación';
        const detail =
          reasons.length > 0
            ? `Documento rechazado: ${entryPath} ("${op.itemName}", ${opLabel}). Motivo: ${reasons.join('; ')}.`
            : `Documento rechazado: ${entryPath} ("${op.itemName}", ${opLabel}). Revisa que el insumo coincida con el catálogo o que el horario siga activo.`;

        console.error('Firestore Diagnostic Entry Error:', {
          path: entryPath,
          itemName: op.itemName,
          code: errCode,
          reasons,
          entryWriteError,
        });

        throw new DiagnosticSaveError({
          title: `Error al guardar insumo "${op.itemName}"`,
          detail,
          failedDocumentPath: entryPath,
          code: errCode,
        });
      }
    }

    // Finalize report status to completed if needed
    if (guard.effectiveStatus !== firstStepReportStatus) {
      try {
        await updateDoc(reportRef, {
          status: guard.effectiveStatus,
          reportedByUid: user.uid,
          reportedByName: reporterName,
          notes: cleanNotes,
          updatedAt: serverTimestamp(),
        });
      } catch (finalizeError) {
        const errCode = extractFirebaseCode(finalizeError) ?? extractFirebaseCode(batchError);
        throw new DiagnosticSaveError({
          title: 'Error al finalizar el cierre del reporte',
          detail: `Se guardaron los insumos, pero Firebase rechazó cerrar dailyReports/${reportId}.`,
          failedDocumentPath: `dailyReports/${reportId}`,
          code: errCode,
        });
      }
    }

    return { queuedOffline: false };
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

  // Only co-admins ('jefe') are added to authorizedEmails; workers authenticate strictly via teamMembers/{uid}
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
