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
} from 'firebase/firestore';
import {
  DEFAULT_SHIFT_SCHEDULE,
  MAIN_WORKSPACE_ID,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
} from '../constants';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  Invite,
  StationId,
  StationLink,
  TeamMember,
  TeamStationId,
  Workspace,
} from '../types';
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

  // 3. Check existing owned/authorized workspaces
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

  // 4. Create or open workspace for owner/admin (lazy-loads bossService for seed data)
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
