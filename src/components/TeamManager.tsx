import { useState, type FormEvent } from 'react';
import { MailPlus, Trash2, UserCheck, Users } from 'lucide-react';
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH } from '../constants';
import {
  addInviteAndSyncAccess,
  removeInviteOrMember,
  updateWorkspaceName,
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
  const [restaurantName, setRestaurantName] = useState(workspace.name);
  const [savingName, setSavingName] = useState(false);

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [station, setStation] = useState<TeamStationId>(stations[0]?.id ?? 'jefe');
  const [inviting, setInviting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const stationNameMap = new Map(stations.map((s) => [s.id, s.name]));
  const getRoleLabel = (roleId: TeamStationId) => {
    if (roleId === 'jefe') return 'Co-Administrador / Jefe';
    return stationNameMap.get(roleId) ?? roleId;
  };

  const handleRename = async (e: FormEvent) => {
    e.preventDefault();
    if (restaurantName.trim().length < 2) return;
    setSavingName(true);
    setFeedback(null);
    try {
      await updateWorkspaceName(workspace.id, restaurantName);
      setFeedback({ type: 'success', text: 'Nombre del negocio actualizado.' });
    } catch {
      setFeedback({ type: 'error', text: 'No se pudo actualizar el nombre.' });
    } finally {
      setSavingName(false);
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
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium text-slate-500">
          Administración · Cuentas conectadas
        </p>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mt-1">
          Equipo y Configuración
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Las trabajadoras que ingresan mediante el código QR o enlace de su puesto aparecerán aquí automáticamente. También puedes invitar por correo manualmente.
        </p>
      </div>

      {feedback && (
        <div
          role="status"
          className={`px-4 py-3 text-sm rounded-xl border ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 space-y-6">
          <form
            onSubmit={handleRename}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <h2 className="font-display text-base font-semibold text-slate-900">
              Nombre del negocio
            </h2>
            <div className="flex items-center gap-2">
              <input
                type="text"
                required
                minLength={2}
                maxLength={MAX_NAME_LENGTH}
                value={restaurantName}
                onChange={(e) => setRestaurantName(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              <button
                type="submit"
                disabled={savingName}
                className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {savingName ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </form>

          <form
            onSubmit={handleInvite}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div className="flex items-center gap-2">
              <MailPlus className="w-4 h-4 text-teal-700" />
              <h2 className="font-display text-base font-semibold text-slate-900">
                Autorizar acceso por correo (opcional)
              </h2>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Nombre de la persona
              </label>
              <input
                type="text"
                required
                maxLength={MAX_NAME_LENGTH}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Ej: Laura (Salchipapas)"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Correo de Google
              </label>
              <input
                type="email"
                required
                maxLength={MAX_EMAIL_LENGTH}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ejemplo@gmail.com"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Puesto asignado
              </label>
              <select
                value={station}
                onChange={(e) => setStation(e.target.value as TeamStationId)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 bg-white"
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
              className="w-full py-2.5 text-sm font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              {inviting ? 'Autorizando...' : 'Autorizar acceso'}
            </button>
          </form>
        </div>

        <div className="lg:col-span-7 space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-teal-700" />
                <h2 className="font-display text-base font-semibold text-slate-900">
                  Cuentas activas
                </h2>
              </div>
              <span className="font-mono text-xs text-slate-500">
                {members.length + 1} activas
              </span>
            </div>

            <div className="divide-y divide-slate-100">
              <div className="px-5 py-3.5 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-900">{workspace.ownerEmail}</p>
                  <p className="text-xs text-slate-500">Jefe Principal · Acceso total</p>
                </div>
                <span className="text-xs font-semibold text-teal-700">Propietario</span>
              </div>

              {members.map((m) => (
                <div key={m.id} className="px-5 py-3.5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{m.displayName}</p>
                    <p className="text-xs text-slate-500">
                      {m.email} · {getRoleLabel(m.station)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveMember(m)}
                    aria-label={`Revocar acceso de ${m.email}`}
                    className="p-2 text-slate-400 hover:text-red-700 hover:bg-red-50 rounded-lg cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-slate-600" />
                <h2 className="font-display text-base font-semibold text-slate-900">
                  Invitaciones por correo pendientes
                </h2>
              </div>
              <span className="font-mono text-xs text-slate-500">{invites.length}</span>
            </div>

            {invites.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">
                No hay invitaciones por correo pendientes. Si usas códigos QR o enlaces desde &ldquo;Puestos de Trabajo&rdquo;, las trabajadoras se activan al ingresar.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {invites.map((inv) => (
                  <div key={inv.id} className="px-5 py-3.5 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{inv.displayName}</p>
                      <p className="text-xs text-slate-500">
                        {inv.email} · {getRoleLabel(inv.station)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveInvite(inv)}
                      aria-label={`Eliminar invitación de ${inv.email}`}
                      className="p-2 text-slate-400 hover:text-red-700 hover:bg-red-50 rounded-lg cursor-pointer"
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
