import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from '../firebase';
import {
  fetchStationLinkPreview,
  preloadStationLinkPreview,
  resolveUserWorkspace,
  SessionAccessError,
} from '../services/sessionService';
import type { StationId, StationLink, TeamMember, TeamStationId, Workspace } from '../types';
import { perfMetrics } from '../utils/perfMetrics';
import {
  clearWorkerSnapshotCache,
  isSnapshotCompatibleWithLink,
  readCachedStationLinkPreview,
  readWorkerSnapshotCache,
} from '../utils/workerCache';

export function normalizeStationId(raw: string): StationId {
  if (raw === 'hamburguesas') return 'comida_rapida';
  return raw;
}

export function normalizeTeamRole(raw: string): TeamStationId {
  if (raw === 'jefe') return 'jefe';
  return normalizeStationId(raw);
}

function formatGoogleAuthError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? '';
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  switch (code) {
    case 'auth/unauthorized-domain':
      return `El dominio "${host}" aún no está autorizado en Firebase. Agrégalo en Firebase Console → Authentication → Settings → Authorized domains.`;
    case 'auth/popup-blocked':
      return 'Tu navegador bloqueó la ventana emergente de Google. Permite ventanas emergentes o abre la app en Chrome o Safari.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Se cerró la ventana de Google antes de completar el ingreso. Intenta nuevamente.';
    case 'auth/network-request-failed':
      return 'Error de conexión con Google. Verifica tu internet e intenta de nuevo.';
    case 'auth/operation-not-allowed':
      return 'El inicio de sesión con Google no está habilitado en Firebase Authentication.';
    default:
      return code
        ? `No se pudo iniciar sesión con Google (${code}).`
        : 'No se pudo completar el inicio de sesión con Google.';
  }
}

export interface OptimisticStationContext {
  workspaceId: string;
  stationId: StationId;
}

export interface WorkspaceSessionState {
  linkParams: { stationId: string | null; accessCode: string | null };
  pendingLink: StationLink | null;
  optimisticStationContext: OptimisticStationContext | null;
  user: User | null;
  authReady: boolean;
  authLoading: boolean;
  authError: string | null;
  workspace: Workspace | null;
  role: TeamStationId;
  isOwner: boolean;
  canManage: boolean;
  sessionLoading: boolean;
  sessionError: string | null;
  initialActiveSection: string | null;
  handleSignIn: () => Promise<void>;
  handleSignOut: () => Promise<void>;
}

export function useWorkspaceSession(): WorkspaceSessionState {
  const [linkParams] = useState(() => {
    if (typeof window === 'undefined') {
      return { stationId: null as string | null, accessCode: null as string | null };
    }
    const sp = new URLSearchParams(window.location.search);
    return {
      stationId: sp.get('puesto'),
      accessCode: sp.get('codigo'),
    };
  });

  const [pendingLink, setPendingLink] = useState<StationLink | null>(() =>
    readCachedStationLinkPreview(linkParams.accessCode),
  );
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [role, setRole] = useState<TeamStationId>('jefe');
  const [isOwner, setIsOwner] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [initialActiveSection, setInitialActiveSection] = useState<string | null>(null);

  const hydratedFromCacheUidRef = useRef<string | null>(null);
  const canManage = isOwner || role === 'jefe';

  // Start fetching QR link preview immediately on mount, in parallel with Firebase Auth init
  useEffect(() => {
    if (!linkParams.accessCode) return;
    preloadStationLinkPreview(linkParams.accessCode);
    let cancelled = false;
    fetchStationLinkPreview(linkParams.accessCode).then((preview) => {
      if (!cancelled && preview) {
        setPendingLink(preview);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [linkParams.accessCode]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      perfMetrics.mark('authReady');
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        hydratedFromCacheUidRef.current = null;
        setWorkspace(null);
        setRole('jefe');
        setIsOwner(false);
        setSessionError(null);
        setInitialActiveSection(null);
      }
    });

    getRedirectResult(auth).catch((error) => {
      console.error('Redirect auth error:', error);
      setAuthError(formatGoogleAuthError(error));
    });

    return () => unsub();
  }, []);

  const userUid = user?.uid ?? null;

  useEffect(() => {
    if (!authReady || !user || !userUid) return;
    let cancelled = false;

    const cachedSnapshot = readWorkerSnapshotCache(userUid);
    const cachedPreview = pendingLink ?? readCachedStationLinkPreview(linkParams.accessCode);
    const canHydrateOptimistically = isSnapshotCompatibleWithLink(
      cachedSnapshot,
      linkParams,
      cachedPreview,
    );

    if (canHydrateOptimistically && cachedSnapshot) {
      hydratedFromCacheUidRef.current = userUid;
      const cachedRole = normalizeTeamRole(cachedSnapshot.role);
      setWorkspace(cachedSnapshot.workspace);
      setRole(cachedRole);
      setIsOwner(false);
      setInitialActiveSection(normalizeStationId(cachedRole));
      setSessionError(null);
      setSessionLoading(false);
    } else {
      hydratedFromCacheUidRef.current = null;
      setSessionLoading(true);
      setSessionError(null);
    }

    resolveUserWorkspace(user, linkParams)
      .then((resolved) => {
        if (cancelled) return;
        perfMetrics.mark('sessionResolved');
        const normalizedRole = normalizeTeamRole(resolved.role);
        setWorkspace(resolved.workspace);
        setRole(normalizedRole);
        setIsOwner(resolved.isOwner);
        if (resolved.stationLinkInfo) {
          setPendingLink(resolved.stationLinkInfo);
        }
        if (resolved.initialStation) {
          setInitialActiveSection(normalizeStationId(resolved.initialStation));
        } else {
          setInitialActiveSection(
            resolved.isOwner || normalizedRole === 'jefe' ? 'jefe' : normalizedRole,
          );
        }
        if (resolved.isOwner || normalizedRole === 'jefe') {
          clearWorkerSnapshotCache(userUid);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        if (err instanceof SessionAccessError) {
          clearWorkerSnapshotCache(userUid);
          setWorkspace(null);
          setSessionError(err.message);
        } else if (hydratedFromCacheUidRef.current !== userUid) {
          setSessionError(
            'No se pudo inicializar el espacio del restaurante. Verifica tu sesión e intenta nuevamente.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Depend on primitive userUid + linkParams instead of full user object identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, userUid, linkParams]);

  // Live listener on active workspace
  const workspaceId = workspace?.id ?? null;
  useEffect(() => {
    if (!authReady || !userUid || !workspaceId) return;
    const wsPath = `workspaces/${workspaceId}`;
    const stopMetric = perfMetrics.onListenerStart('workspaces');
    const unsub = onSnapshot(
      doc(db, 'workspaces', workspaceId),
      (snap) => {
        if (snap.exists()) {
          setWorkspace({ id: snap.id, ...snap.data() } as Workspace);
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, wsPath),
    );
    return () => {
      stopMetric();
      unsub();
    };
  }, [authReady, userUid, workspaceId]);

  // Live check on worker's own teamMembers/{uid} for instant revocation / reassignment
  useEffect(() => {
    if (!authReady || !userUid || !workspaceId || canManage || role === 'jefe') return;

    const stopMetric = perfMetrics.onListenerStart('teamMembers');
    const unsubSelfMember = onSnapshot(
      doc(db, 'teamMembers', userUid),
      (snap) => {
        if (!snap.exists()) {
          clearWorkerSnapshotCache(userUid);
          setSessionError('Tu acceso fue removido por el jefe.');
          return;
        }
        const m = snap.data() as TeamMember;
        if (!m.active) {
          clearWorkerSnapshotCache(userUid);
          setSessionError('Tu acceso a este restaurante fue desactivado por el jefe.');
          return;
        }
        const nextRole = normalizeTeamRole(m.station);
        if (nextRole !== role) {
          setRole(nextRole);
          setInitialActiveSection(nextRole === 'jefe' ? 'jefe' : nextRole);
        }
      },
      () => {
        // Ignore transient offline listener issues
      },
    );

    return () => {
      stopMetric();
      unsubSelfMember();
    };
  }, [authReady, userUid, workspaceId, canManage, role]);

  const optimisticStationContext = useMemo<OptimisticStationContext | null>(() => {
    if (!authReady || !userUid || !pendingLink?.workspaceId || !pendingLink?.stationId) {
      return null;
    }
    return {
      workspaceId: pendingLink.workspaceId,
      stationId: normalizeStationId(pendingLink.stationId),
    };
  }, [authReady, userUid, pendingLink?.workspaceId, pendingLink?.stationId]);

  const handleSignIn = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Google Sign-In error:', error);
      const code = (error as { code?: string } | null)?.code ?? '';
      const isStandaloneWindow =
        typeof window !== 'undefined' && window.self === window.top;

      if (
        isStandaloneWindow &&
        (code === 'auth/popup-blocked' ||
          code === 'auth/operation-not-supported-in-this-environment')
      ) {
        try {
          await signInWithRedirect(auth, googleProvider);
          return;
        } catch (redirectError) {
          console.error('Google Redirect Sign-In error:', redirectError);
          setAuthError(formatGoogleAuthError(redirectError));
          return;
        }
      }

      setAuthError(formatGoogleAuthError(error));
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    clearWorkerSnapshotCache(userUid);
    await signOut(auth);
  }, [userUid]);

  return {
    linkParams,
    pendingLink,
    optimisticStationContext,
    user,
    authReady,
    authLoading,
    authError,
    workspace,
    role,
    isOwner,
    canManage,
    sessionLoading,
    sessionError,
    initialActiveSection,
    handleSignIn,
    handleSignOut,
  };
}
