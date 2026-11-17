import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentSnapshot,
} from 'firebase/firestore';
import {
  DEFAULT_SHIFT_SCHEDULE,
  MAIN_WORKSPACE_ID,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
} from '../constants';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import type {
  Invite,
  StationId,
  StationLink,
  TeamMember,
  TeamStationId,
  Workspace,
} from '../types';
import { perfMetrics } from '../utils/perfMetrics';
import {
  readCachedStationLinkPreview,
  readWorkerSnapshotCache,
  writeCachedStationLinkPreview,
} from '../utils/workerCache';
import { clampString } from './shared';

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

interface LiveLinkFetchResult {
  exists: boolean;
  link: StationLink | null;
}

const inFlightLinkFetches = new Map<string, Promise<LiveLinkFetchResult>>();
const inFlightWorkspaceFetches = new Map<string, Promise<DocumentSnapshot | null>>();

function safeSpeculativeWorkspaceGet(workspaceId: string): Promise<DocumentSnapshot | null> {
  if (!workspaceId) return Promise.resolve(null);
  const existing = inFlightWorkspaceFetches.get(workspaceId);
  if (existing) return existing;

  const promise = (async (): Promise<DocumentSnapshot | null> => {
    try {
      perfMetrics.recordRead('workspaces');
      return await getDoc(doc(db, 'workspaces', workspaceId));
    } catch {
      inFlightWorkspaceFetches.delete(workspaceId);
      return null;
    }
  })();

  inFlightWorkspaceFetches.set(workspaceId, promise);
  return promise;
}

function fetchLiveStationLink(accessCode: string): Promise<LiveLinkFetchResult> {
  if (!accessCode || accessCode.length < 6) {
    return Promise.resolve({ exists: false, link: null });
  }
  const existingPromise = inFlightLinkFetches.get(accessCode);
  if (existingPromise) return existingPromise;

  const promise = (async (): Promise<LiveLinkFetchResult> => {
    perfMetrics.recordRead('stationLinks');
    const snap = await getDoc(doc(db, 'stationLinks', accessCode));
    perfMetrics.mark('linkPreview');
    if (!snap.exists()) {
      return { exists: false, link: null };
    }
    const data = { id: snap.id, ...snap.data() } as StationLink;
    if (data.active) {
      writeCachedStationLinkPreview(data);
      if (auth.currentUser && data.workspaceId) {
        void safeSpeculativeWorkspaceGet(data.workspaceId);
      }
    }
    return { exists: true, link: data };
  })().catch((err) => {
    inFlightLinkFetches.delete(accessCode);
    throw err;
  });

  inFlightLinkFetches.set(accessCode, promise);
  return promise;
}

export function preloadStationLinkPreview(accessCode: string | null | undefined): void {
  if (!accessCode || accessCode.length < 6) return;
  void fetchLiveStationLink(accessCode).catch(() => {
    // Preview preload is best-effort; resolveUserWorkspace handles errors explicitly
  });
}

export async function fetchStationLinkPreview(accessCode: string): Promise<StationLink | null> {
  if (!accessCode || accessCode.length < 6) return null;
  try {
    const result = await fetchLiveStationLink(accessCode);
    return result.link && result.link.active ? result.link : null;
  } catch {
    return readCachedStationLinkPreview(accessCode);
  }
}

async function checkIsAdminUser(uid: string): Promise<boolean> {
  try {
    perfMetrics.recordRead('admins');
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

  const rawAccessCode = linkParams?.accessCode?.trim() || '';
  if (rawAccessCode.length > 0 && rawAccessCode.length < 6) {
    throw new SessionAccessError('El enlace o código QR ingresado no es válido.');
  }

  const cachedWorkerSnapshot = readWorkerSnapshotCache(user.uid);
  const cachedLinkPreview =
    rawAccessCode.length >= 6 ? readCachedStationLinkPreview(rawAccessCode) : null;
  const speculativeWsId =
    cachedLinkPreview?.workspaceId ?? cachedWorkerSnapshot?.workspace?.id ?? null;

  const memberRef = doc(db, 'teamMembers', user.uid);

  // 0. If user arrived via a QR / Share Link (?puesto=...&codigo=...):
  // Parallelize link lookup (often already prefetched), teamMember lookup & speculative workspace read.
  if (rawAccessCode.length >= 6) {
    let linkResult: LiveLinkFetchResult;
    let existingMemberSnap: DocumentSnapshot;
    let speculativeWsSnap: DocumentSnapshot | null;
    const adminPromise = checkIsAdminUser(user.uid);

    try {
      perfMetrics.recordRead('teamMembers');
      [linkResult, existingMemberSnap, speculativeWsSnap] = await Promise.all([
        fetchLiveStationLink(rawAccessCode).catch((error) => {
          handleFirestoreError(error, OperationType.GET, `stationLinks/${rawAccessCode}`);
        }),
        getDoc(memberRef).catch((error) => {
          handleFirestoreError(error, OperationType.GET, `teamMembers/${user.uid}`);
        }),
        speculativeWsId
          ? safeSpeculativeWorkspaceGet(speculativeWsId)
          : Promise.resolve(null),
      ]);
    } catch (error) {
      throw error;
    }

    if (!linkResult.exists || !linkResult.link) {
      throw new SessionAccessError(
        'Este enlace o código QR ya no es válido porque fue regenerado o eliminado por el jefe.',
      );
    }

    const link = linkResult.link;
    if (!link.active) {
      throw new SessionAccessError(
        'Este enlace está temporalmente desactivado por el jefe. Pídele que lo reactive o te comparta uno nuevo.',
      );
    }

    const getTargetWorkspace = async (): Promise<Workspace | null> => {
      if (
        speculativeWsSnap &&
        speculativeWsSnap.exists() &&
        speculativeWsSnap.id === link.workspaceId
      ) {
        return { id: speculativeWsSnap.id, ...speculativeWsSnap.data() } as Workspace;
      }
      const inFlightWs = inFlightWorkspaceFetches.get(link.workspaceId);
      if (inFlightWs) {
        const snap = await inFlightWs;
        if (snap && snap.exists() && snap.id === link.workspaceId) {
          return { id: snap.id, ...snap.data() } as Workspace;
        }
        inFlightWorkspaceFetches.delete(link.workspaceId);
      }
      try {
        perfMetrics.recordRead('workspaces');
        const wsSnap = await getDoc(doc(db, 'workspaces', link.workspaceId));
        return wsSnap.exists() ? ({ id: wsSnap.id, ...wsSnap.data() } as Workspace) : null;
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `workspaces/${link.workspaceId}`);
      }
    };

    const existingMemberData = existingMemberSnap.exists()
      ? ({ id: existingMemberSnap.id, ...existingMemberSnap.data() } as TeamMember)
      : null;
    const isKnownActiveStationWorker = Boolean(
      existingMemberData &&
        existingMemberData.workspaceId === link.workspaceId &&
        existingMemberData.active &&
        existingMemberData.station === link.stationId &&
        existingMemberData.station !== 'jefe' &&
        link.ownerUid !== user.uid,
    );

    const isAdmin = isKnownActiveStationWorker ? false : await adminPromise;
    const isBoss = link.ownerUid === user.uid || isAdmin;
    if (isBoss) {
      const workspace = await getTargetWorkspace();
      if (workspace) {
        return {
          workspace,
          role: 'jefe',
          isOwner: workspace.ownerUid === user.uid || isAdmin,
          initialStation: link.stationId,
          stationLinkInfo: link,
        };
      }
    }

    const desiredMemberDisplayName = link.workerName || displayName;

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
        const workspace = await getTargetWorkspace();
        if (workspace) {
          return {
            workspace,
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

      // Only update teamMember metadata when inviteId or displayName actually changed, and never block QR entry
      if (
        existing.inviteId !== rawAccessCode ||
        existing.displayName !== desiredMemberDisplayName
      ) {
        perfMetrics.recordWrite('teamMembers');
        void updateDoc(memberRef, {
          inviteId: rawAccessCode,
          displayName: desiredMemberDisplayName,
          updatedAt: serverTimestamp(),
        }).catch((error) => {
          console.warn('No se pudo actualizar metadatos de miembro en segundo plano:', error);
        });
      }
    } else {
      try {
        perfMetrics.recordWrite('teamMembers');
        await setDoc(memberRef, {
          workspaceId: link.workspaceId,
          ownerUid: link.ownerUid,
          uid: user.uid,
          email,
          displayName: desiredMemberDisplayName,
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

    const workspace = await getTargetWorkspace();
    if (workspace) {
      return {
        workspace,
        role: link.stationId,
        isOwner: false,
        initialStation: link.stationId,
        stationLinkInfo: link,
      };
    }
  }

  // 1. Direct entry (no QR params): parallelize teamMembers/{uid}, admins/{uid}, and speculative workspace read
  perfMetrics.recordRead('teamMembers');
  const [memberSnap, isAdmin, speculativeWsSnap] = await Promise.all([
    getDoc(memberRef).catch((error) => {
      handleFirestoreError(error, OperationType.GET, `teamMembers/${user.uid}`);
    }),
    checkIsAdminUser(user.uid),
    cachedWorkerSnapshot?.workspace?.id
      ? safeSpeculativeWorkspaceGet(cachedWorkerSnapshot.workspace.id)
      : Promise.resolve(null),
  ]);

  if (memberSnap.exists()) {
    const member = { id: memberSnap.id, ...memberSnap.data() } as TeamMember;
    if (!member.active) {
      if (!isAdmin) {
        throw new SessionAccessError(
          'Tu acceso a este restaurante fue desactivado por el jefe.',
        );
      }
    } else {
      if (
        speculativeWsSnap &&
        speculativeWsSnap.exists() &&
        speculativeWsSnap.id === member.workspaceId
      ) {
        const workspace = { id: speculativeWsSnap.id, ...speculativeWsSnap.data() } as Workspace;
        return {
          workspace,
          role: member.station,
          isOwner: workspace.ownerUid === user.uid || isAdmin,
        };
      }

      try {
        perfMetrics.recordRead('workspaces');
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

  // 2 & 3. Invited user or owner/admin: parallelize invites query, main workspace, and owned workspaces
  const [inviteResult, mainWsSnap, ownedSnaps] = await Promise.all([
    email
      ? (() => {
          perfMetrics.recordRead('invites');
          return getDocs(query(collection(db, 'invites'), where('email', '==', email))).catch(
            (error) => {
              handleFirestoreError(error, OperationType.LIST, 'invites');
            },
          );
        })()
      : Promise.resolve(null),
    (() => {
      perfMetrics.recordRead('workspaces');
      return getDoc(doc(db, 'workspaces', MAIN_WORKSPACE_ID)).catch(() => null);
    })(),
    (() => {
      perfMetrics.recordRead('workspaces');
      return getDocs(query(collection(db, 'workspaces'), where('ownerUid', '==', user.uid))).catch(
        () => null,
      );
    })(),
  ]);

  if (inviteResult && !inviteResult.empty) {
    const inviteDoc = inviteResult.docs[0];
    const invite = { id: inviteDoc.id, ...inviteDoc.data() } as Invite;

    perfMetrics.recordWrite('teamMembers');
    await setDoc(memberRef, {
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

    perfMetrics.recordRead('workspaces');
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

  if (mainWsSnap && mainWsSnap.exists()) {
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

  if (ownedSnaps && !ownedSnaps.empty) {
    const firstWs = ownedSnaps.docs[0];
    const workspace = { id: firstWs.id, ...firstWs.data() } as Workspace;
    return { workspace, role: 'jefe', isOwner: true };
  }

  // 4. Create or open workspace for owner/admin (lazy-loads bossService for seed data)
  const targetWsId = isAdmin ? MAIN_WORKSPACE_ID : `ws_${user.uid}`;
  const wsPath = `workspaces/${targetWsId}`;

  try {
    perfMetrics.recordRead('workspaces');
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
    perfMetrics.recordWrite('workspaces');
    await setDoc(doc(db, 'workspaces', targetWsId), newWorkspaceData);

    const createdSnap = await getDoc(doc(db, 'workspaces', targetWsId));
    const workspace = { id: createdSnap.id, ...createdSnap.data() } as Workspace;
    const { seedDefaultWorkstationsAndCatalog } = await import('./bossService');
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
