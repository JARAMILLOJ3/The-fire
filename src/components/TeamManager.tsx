import { useEffect, useState, type FormEvent } from 'react';
import { MailPlus, Trash2, UserCheck, Users } from 'lucide-react';
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH } from '../constants';
import {
  addInviteAndSyncAccess,
  removeInviteOrMember,
  updateWorkspaceProfile,
} from '../services/inventoryService';
import type {
  DailyReport,
  DailyReportEntry,
  InventoryItem,
  Invite,
  TeamMember,
  TeamStationId,
  Workspace,
  Workstation,
} from '../types';

interface TeamManagerProps {
  workspace: Workspace;
  stations: Workstation[];
  items: InventoryItem[];
  todayReports: DailyReport[];
  todayEntries: DailyReportEntry[];
  invites: Invite[];
  members: TeamMember[];
}

export function TeamManager({
  workspace,
  stations,
  items,
  todayReports,
  todayEntries,
  invites,
  members,
}: TeamManagerProps) {
  const [ownerName, setOwnerName] = useState(workspace.ownerName ?? '');
  const [restaurantName, setRestaurantName] = useState(workspace.name);
  const [savingProfile, setSavingProfile] = useState(false);

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [station, setStation] = useState<TeamStationId>(stations[0]?.id ?? 'jefe');
  const [inviting, setInviting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setOwnerName(workspace.ownerName ?? '');
    setRestaurantName(workspace.name);
  }, [workspace.ownerName, workspace.name]);

  const stationNameMap = new Map(stations.map((s) => [s.id, s.name]));
  const getRoleLabel = (roleId: TeamStationId) => {
    if (roleId === 'jefe') return 'Co-Administrador / Jefe';
    return stationNameMap.get(roleId) ?? roleId;
  };

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (restaurantName.trim().length < 2 || ownerName.trim().length < 1) {
      setFeedback({ type: 'error', text: 'Completa tu nombre y el nombre del negocio.' });
      return;
    }
    setSavingProfile(true);
    setFeedback(null);
    try {
      await updateWorkspaceProfile(workspace.id, {
        ownerName: ownerName.trim(),
        name: restaurantName.trim(),
      });
      setFeedback({ type: 'success', text: 'Tu nombre y datos del negocio fueron guardados.' });
    } catch {
      setFeedback({ type: 'error', text: 'No se pudieron actualizar los datos.' });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail.includes('@')) {
      setFeedback({ type: 'error', text: 'Ingresa un correo de Google válido.' });
      return;
    }
    if (workspace.authorizedEmails.length >= 15) {
      setFeedback({ type: 'error', text: 'Límite máximo de 15 cuentas autorizadas alcanzado.' });
      return;
    }
    setInviting(true);
    setFeedback(null);
    try {
      await addInviteAndSyncAccess({
        workspace,
        email: cleanEmail,
        displayName: displayName.trim() || cleanEmail.split('@')[0],
        station,
        stations,
        items,
        todayReports,
        todayEntries,
      });
      setEmail('');
      setDisplayName('');
      setFeedback({
        type: 'success',
        text: `Acceso habilitado para ${cleanEmail}. También puedes compartir el enlace o QR directo desde Puestos de Trabajo.`,
      });
    } catch {
      setFeedback({ type: 'error', text: 'No se pudo crear la invitación.' });
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveInvite = async (inv: Invite) => {
    setFeedback(null);
    try {
      await removeInviteOrMember({
        workspace,
        email: inv.email,
        inviteId: inv.id,
        stations,
        items,
      });
    } catch {
      setFeedback({ type: 'error', text: 'No se pudo revocar la invitación.' });
    }
  };

  const handleRemoveMember = async (member: TeamMember) => {
    setFeedback(null);
    try {
      const matchingInvite = invites.find((i) => i.email === member.email);
      await removeInviteOrMember({
        workspace,
        email: member.email,
        inviteId: matchingInvite?.id,
        memberId: member.id,
        stations,
        items,
      });
    } catch {
      setFeedback({ type: 'error', text: 'No se pudo revocar el acceso.' });
    }
  };

  return (
    <div className="space-y-6 sm:space-y-8 min-w-0">
      <div>
        <p className="text-xs font-semibold text-orange-600">
          Administración · Cuentas conectadas
        </p>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-1">
          Equipo y Configuración
        </h1>
        <p className="text-sm text-stone-600 mt-1">
          Las trabajadoras que ingresan mediante el código QR o enlace de su puesto aparecen aquí automáticamente.
        </p>
      </div>

      {feedback && (
        <div
          role="status"
          className={`px-4 py-3 text-sm rounded-2xl border ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 space-y-6 min-w-0">
          <form
            onSubmit={handleSaveProfile}
            className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4"
          >
            <h2 className="font-display text-base font-bold text-stone-900">
              Tu perfil y negocio
            </h2>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Tu nombre (para la bienvenida)
              </label>
              <input
                type="text"
                required
                minLength={1}
                maxLength={MAX_NAME_LENGTH}
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="Ej: Carlos"
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Nombre del restaurante
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={MAX_NAME_LENGTH}
                value={restaurantName}
                onChange={(e) => setRestaurantName(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            <button
              type="submit"
              disabled={savingProfile}
              className="w-full min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-stone-950 rounded-xl hover:bg-stone-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              {savingProfile ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </form>

          <form
            onSubmit={handleInvite}
            className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-2">
              <MailPlus className="w-4 h-4 text-orange-600 shrink-0" />
              <h2 className="font-display text-base font-bold text-stone-900">
                Autorizar acceso por correo (opcional)
              </h2>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Nombre de la persona
              </label>
              <input
                type="text"
                required
                maxLength={MAX_NAME_LENGTH}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Ej: Laura (Salchipapas)"
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Correo de Google
              </label>
              <input
                type="email"
                required
                maxLength={MAX_EMAIL_LENGTH}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ejemplo@gmail.com"
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Puesto asignado
              </label>
              <select
                value={station}
                onChange={(e) => setStation(e.target.value as TeamStationId)}
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
              >
                {stations.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
                <option value="jefe">Co-Administrador / Jefe</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={inviting}
              className="w-full min-h-[44px] py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 disabled:opacity-60 transition-colors cursor-pointer"
            >
              {inviting ? 'Autorizando...' : 'Autorizar acceso'}
            </button>
          </form>
        </div>

        <div className="lg:col-span-7 space-y-6 min-w-0">
          <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <UserCheck className="w-4 h-4 text-orange-600 shrink-0" />
                <h2 className="font-display text-base font-bold text-stone-900 truncate">
                  Cuentas activas
                </h2>
              </div>
              <span className="font-mono text-xs text-stone-500 shrink-0">
                {members.length + 1} activas
              </span>
            </div>

            <div className="divide-y divide-stone-100">
              <div className="px-5 py-3.5 flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-stone-900 truncate">
                    {workspace.ownerName ? `${workspace.ownerName} (${workspace.ownerEmail})` : workspace.ownerEmail}
                  </p>
                  <p className="text-xs text-stone-500 truncate">
                    Jefe Principal · Acceso total
                  </p>
                </div>
                <span className="text-xs font-semibold text-orange-600 shrink-0">
                  Propietario
                </span>
              </div>

              {members.map((m) => (
                <div key={m.id} className="px-5 py-3.5 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-stone-900 truncate">{m.displayName}</p>
                    <p className="text-xs text-stone-500 truncate">
                      {m.email} · {getRoleLabel(m.station)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveMember(m)}
                    aria-label={`Revocar acceso de ${m.email}`}
                    className="p-2 text-stone-400 hover:text-red-700 hover:bg-red-50 rounded-lg shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Users className="w-4 h-4 text-stone-600 shrink-0" />
                <h2 className="font-display text-base font-bold text-stone-900 truncate">
                  Invitaciones por correo pendientes
                </h2>
              </div>
              <span className="font-mono text-xs text-stone-500 shrink-0">{invites.length}</span>
            </div>

            {invites.length === 0 ? (
              <div className="p-6 text-sm text-stone-500">
                No hay invitaciones por correo pendientes. Si usas códigos QR o enlaces desde &ldquo;Puestos de Trabajo&rdquo;, las trabajadoras se activan al ingresar.
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {invites.map((inv) => (
                  <div key={inv.id} className="px-5 py-3.5 flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-stone-900 truncate">
                        {inv.displayName}
                      </p>
                      <p className="text-xs text-stone-500 truncate">
                        {inv.email} · {getRoleLabel(inv.station)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveInvite(inv)}
                      aria-label={`Eliminar invitación de ${inv.email}`}
                      className="p-2 text-stone-400 hover:text-red-700 hover:bg-red-50 rounded-lg shrink-0 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
