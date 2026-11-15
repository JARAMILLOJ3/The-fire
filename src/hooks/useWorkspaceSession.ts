import { useCallback, useEffect, useState } from 'react';
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
  resolveUserWorkspace,
  SessionAccessError,
} from '../services/sessionService';
import type { StationId, StationLink, TeamMember, TeamStationId, Workspace } from '../types';

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

export interface WorkspaceSessionState {
  linkParams: { stationId: string | null; accessCode: string | null };
  pendingLink: StationLink | null;
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

  const [pendingLink, setPendingLink] = useState<StationLink | null>(null);
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

  const canManage = isOwner || role === 'jefe';

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
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

  useEffect(() => {
    if (!authReady || user || !linkParams.accessCode) return;
    let cancelled = false;
    fetchStationLinkPreview(linkParams.accessCode).then((preview) => {
      if (!cancelled && preview) {
        setPendingLink(preview);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, user, linkParams.accessCode]);

  useEffect(() => {
    if (!authReady || !user) return;
    let cancelled = false;
    setSessionLoading(true);
    setSessionError(null);

    resolveUserWorkspace(user, linkParams)
      .then((resolved) => {
        if (cancelled) return;
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
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        if (err instanceof SessionAccessError) {
          setSessionError(err.message);
        } else {
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
  }, [authReady, user, linkParams]);

  // Live listener on active workspace
  useEffect(() => {
    if (!authReady || !user || !workspace?.id) return;
    const wsPath = `workspaces/${workspace.id}`;
    const unsub = onSnapshot(
      doc(db, 'workspaces', workspace.id),
      (snap) => {
        if (snap.exists()) {
          setWorkspace({ id: snap.id, ...snap.data() } as Workspace);
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, wsPath),
    );
    return () => unsub();
  }, [authReady, user, workspace?.id]);

  // Live check on worker's own teamMembers/{uid} for instant revocation / reassignment
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || canManage || role === 'jefe') return;

    const unsubSelfMember = onSnapshot(
      doc(db, 'teamMembers', user.uid),
      (snap) => {
        if (!snap.exists()) {
          setSessionError('Tu acceso fue removido por el jefe.');
          return;
        }
        const m = snap.data() as TeamMember;
        if (!m.active) {
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

    return () => unsubSelfMember();
  }, [authReady, user, workspace?.id, canManage, role]);

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
    await signOut(auth);
  }, []);

  return {
    linkParams,
    pendingLink,
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
