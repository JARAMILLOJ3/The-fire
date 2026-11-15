import { useEffect, useMemo, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Link2Off,
  Package,
  Pencil,
  Plus,
  Power,
  Printer,
  QrCode,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  MAX_AREA_LENGTH,
  MAX_DESC_LENGTH,
  MAX_NAME_LENGTH,
  UNASSIGNED_STATION_ID,
} from '../constants';
import {
  assignWorkstationItems,
  buildStationShareUrl,
  createWorkstation,
  deleteWorkstation,
  regenerateStationLink,
  toggleStationLinkActive,
  updateWorkstation,
} from '../services/inventoryService';
import type { InventoryItem, StationLink, Workspace, Workstation } from '../types';
import {
  getItemInputType,
  pluralizeSpanishLabel,
  validateStationItemAssignment,
} from '../utils/inventory';

interface WorkstationsManagerProps {
  workspace: Workspace;
  isOwner?: boolean;
  stations: Workstation[];
  items: InventoryItem[];
  stationLinksByCode?: Record<string, StationLink>;
  onOpenStationSheet: (stationId: string) => void;
  onOpenStationCatalog: (stationId: string) => void;
  onGoToCatalog: () => void;
}

export function WorkstationsManager({
  workspace,
  isOwner = false,
  stations,
  items,
  stationLinksByCode = {},
  onOpenStationSheet,
  onOpenStationCatalog,
  onGoToCatalog,
}: WorkstationsManagerProps) {
  const [showModal, setShowModal] = useState(false);
  const [editingStation, setEditingStation] = useState<Workstation | null>(null);
  const [assignStation, setAssignStation] = useState<Workstation | null>(null);
  const [assignSelectedIds, setAssignSelectedIds] = useState<string[]>([]);
  const [assignInitialOrderIds, setAssignInitialOrderIds] = useState<string[]>([]);
  const [assignSearch, setAssignSearch] = useState('');
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignSaving, setAssignSaving] = useState(false);

  const [qrStation, setQrStation] = useState<Workstation | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState<Workstation | null>(null);

  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [description, setDescription] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [togglingCode, setTogglingCode] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!qrStation) {
      setQrDataUrl('');
      return;
    }
    const shareUrl = buildStationShareUrl(qrStation.id, qrStation.accessCode);
    QRCode.toDataURL(shareUrl, {
      width: 320,
      margin: 2,
      color: { dark: '#1c1917', light: '#ffffff' },
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [qrStation, qrStation?.accessCode]);

  const activeItems = useMemo(() => items.filter((it) => it.active), [items]);
  const stationNameMap = useMemo(
    () => new Map(stations.map((st) => [st.id, st.name])),
    [stations],
  );

  const orderedAssignItems = useMemo(() => {
    if (!assignStation) return [];
    const orderRank = new Map(assignInitialOrderIds.map((id, idx) => [id, idx]));
    const term = assignSearch.trim().toLowerCase();
    return [...activeItems]
      .sort((a, b) => {
        const ra = orderRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = orderRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name, 'es');
      })
      .filter(
        (it) =>
          !term ||
          it.name.toLowerCase().includes(term) ||
          it.unit.toLowerCase().includes(term),
      );
  }, [assignStation, assignInitialOrderIds, activeItems, assignSearch]);

  const openCreateModal = () => {
    setEditingStation(null);
    setName('');
    setArea('');
    setWorkerName('');
    setDescription('');
    setErrorMsg(null);
    setShowModal(true);
  };

  const openEditModal = (st: Workstation) => {
    setEditingStation(st);
    setName(st.name);
    setArea(st.area);
    setWorkerName(st.workerName);
    setDescription(st.description);
    setErrorMsg(null);
    setShowModal(true);
  };

  const openAssignModal = (st: Workstation) => {
    const currentlyAssigned = activeItems.filter((it) => it.station === st.id);
    const unassigned = activeItems.filter((it) => it.station === UNASSIGNED_STATION_ID);
    const inOtherStations = activeItems.filter(
      (it) => it.station !== st.id && it.station !== UNASSIGNED_STATION_ID,
    );
    setAssignInitialOrderIds([
      ...currentlyAssigned.map((i) => i.id),
      ...unassigned.map((i) => i.id),
      ...inOtherStations.map((i) => i.id),
    ]);
    setAssignSelectedIds(currentlyAssigned.map((i) => i.id));
    setAssignSearch('');
    setAssignError(null);
    setAssignStation(st);
  };

  const toggleAssignItem = (itemId: string) => {
    setAssignSelectedIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId],
    );
    if (assignError) setAssignError(null);
  };

  const handleSaveAssignment = async (e: FormEvent) => {
    e.preventDefault();
    if (!assignStation) return;

    const validation = validateStationItemAssignment({
      selectedItemIds: assignSelectedIds,
      allItems: items,
    });
    if (!validation.valid) {
      setAssignError(validation.error ?? 'Revisa los insumos seleccionados.');
      return;
    }

    setAssignSaving(true);
    setAssignError(null);
    try {
      await assignWorkstationItems({
        station: assignStation,
        allStations: stations,
        allItems: items,
        selectedItemIds: assignSelectedIds,
      });
      setAssignStation(null);
    } catch {
      setAssignError('No se pudieron asignar los insumos. Intenta nuevamente.');
    } finally {
      setAssignSaving(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !workerName.trim()) {
      setErrorMsg('Ingresa el nombre del puesto y el nombre de la trabajadora encargada.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      if (editingStation) {
        await updateWorkstation(editingStation, {
          name,
          area,
          workerName,
          description,
        });
      } else {
        await createWorkstation(workspace, {
          name,
          area,
          workerName,
          description,
          sortOrder: (stations.length + 1) * 10,
        });
      }
      setShowModal(false);
    } catch {
      setErrorMsg('No se pudo guardar el puesto de trabajo. Intenta nuevamente.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyLink = async (st: Workstation) => {
    const shareUrl = buildStationShareUrl(st.id, st.accessCode);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedId(st.id);
      setTimeout(() => setCopiedId(null), 2500);
    } catch {
      // Clipboard blocked
    }
  };

  const handleCopyWhatsAppInvite = async (st: Workstation) => {
    const shareUrl = buildStationShareUrl(st.id, st.accessCode);
    const msg = `Hola ${st.workerName}, ingresa desde tu celular a este enlace de *The Fire Inventario* para registrar el cierre diario de *${st.name}*:\n${shareUrl}`;
    try {
      await navigator.clipboard.writeText(msg);
      setCopiedId(`wa_${st.id}`);
      setTimeout(() => setCopiedId(null), 2500);
    } catch {
      // Clipboard blocked
    }
  };

  const handleRegenerate = async () => {
    if (!qrStation) return;
    setRegenerating(true);
    try {
      const nextCode = await regenerateStationLink(workspace, qrStation);
      setQrStation({ ...qrStation, accessCode: nextCode });
    } finally {
      setRegenerating(false);
    }
  };

  const handleToggleLink = async (st: Workstation, currentActive: boolean) => {
    setTogglingCode(st.id);
    try {
      await toggleStationLinkActive(workspace, st, !currentActive);
    } finally {
      setTogglingCode(null);
    }
  };

  const handleDownloadQr = () => {
    if (!qrDataUrl || !qrStation) return;
    const link = document.createElement('a');
    link.href = qrDataUrl;
    link.download = `qr_${qrStation.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDeleteStation = async () => {
    if (!confirmDelete) return;
    setSubmitting(true);
    try {
      const stItems = items.filter((i) => i.station === confirmDelete.id);
      await deleteWorkstation(confirmDelete, stItems);
      setConfirmDelete(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-orange-600">
            Administración · {stations.length} puestos activos
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-1">
            Puestos de Trabajo y Códigos QR
          </h1>
          <p className="text-sm text-stone-600 mt-1 max-w-2xl">
            Crea cada sección del restaurante, asígnale sus insumos existentes y comparte su código QR o enlace directo con la trabajadora encargada.
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Nuevo puesto de trabajo
        </button>
      </div>

      {/* Stations Grid or Empty State */}
      {stations.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-2xl p-8 sm:p-10 text-center space-y-5">
          <div className="w-12 h-12 rounded-2xl bg-orange-50 border border-orange-200 flex items-center justify-center mx-auto">
            <QrCode className="w-6 h-6 text-orange-600" />
          </div>
          <div className="space-y-1.5 max-w-md mx-auto">
            <h2 className="font-display text-lg font-bold text-stone-900">
              Aún no hay puestos de trabajo
            </h2>
            <p className="text-sm text-stone-600">
              {activeItems.length === 0
                ? 'Paso recomendado: primero crea tus insumos en el apartado Insumos, después crea cada puesto de trabajo y asígnalos.'
                : `Ya tienes ${activeItems.length} ${activeItems.length === 1 ? 'insumo creado' : 'insumos creados'}. Crea tu primer puesto para asignar insumos y generar su QR.`}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            {activeItems.length === 0 && (
              <button
                type="button"
                onClick={onGoToCatalog}
                className="w-full sm:w-auto min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 transition-colors cursor-pointer"
              >
                <Package className="w-4 h-4" />
                1. Ir a Insumos
              </button>
            )}
            <button
              type="button"
              onClick={openCreateModal}
              className={`w-full sm:w-auto min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl transition-colors cursor-pointer ${
                activeItems.length === 0
                  ? 'text-stone-800 bg-white border border-stone-200 hover:bg-stone-100'
                  : 'text-white bg-orange-600 hover:bg-orange-700'
              }`}
            >
              <Plus className="w-4 h-4" />
              Crear primer puesto de trabajo
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
          {stations.map((st, idx) => {
            const stationItems = activeItems.filter((i) => i.station === st.id);
            const shareUrl = buildStationShareUrl(st.id, st.accessCode);
            const isCopiedLink = copiedId === st.id;
            const isCopiedWa = copiedId === `wa_${st.id}`;
            const linkDoc = st.accessCode ? stationLinksByCode[st.accessCode] : undefined;
            const isLinkActive = linkDoc ? linkDoc.active : true;
            const isTogglingThis = togglingCode === st.id;

            return (
              <motion.div
                key={st.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, delay: Math.min(idx * 0.04, 0.2) }}
                className="min-w-0 bg-white border border-stone-200 rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-4 sm:gap-5 hover:shadow-md transition-shadow"
              >
                <div className="space-y-3 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <h2 className="font-display text-lg font-bold text-stone-900 truncate">
                          {st.name}
                        </h2>
                        {!isLinkActive && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200 rounded-md shrink-0">
                            <Link2Off className="w-3 h-3" />
                            Link desactivado
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-stone-500 mt-0.5 truncate">
                        {st.area || 'Área general'} ·{' '}
                        <span className="font-mono tabular-nums">
                          {stationItems.length}{' '}
                          {stationItems.length === 1 ? 'insumo asignado' : 'insumos asignados'}
                        </span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditModal(st)}
                        aria-label={`Editar ${st.name}`}
                        className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg cursor-pointer"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {isOwner && (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(st)}
                          aria-label={`Eliminar ${st.name}`}
                          className="p-2 text-stone-500 hover:text-red-700 hover:bg-red-50 rounded-lg cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm text-stone-700 bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2.5 min-w-0">
                    <UserRound className="w-4 h-4 text-orange-600 shrink-0" />
                    <span className="text-stone-500 shrink-0">Trabajadora:</span>
                    <span className="font-semibold text-stone-900 truncate">{st.workerName}</span>
                  </div>

                  {st.description && (
                    <p className="text-xs text-stone-600 leading-relaxed">{st.description}</p>
                  )}

                  <div
                    className={`text-xs font-mono truncate px-3 py-2 rounded-xl border min-w-0 ${
                      isLinkActive
                        ? 'text-stone-500 bg-stone-50 border-stone-100'
                        : 'text-red-600/80 bg-red-50/40 border-red-100 line-through'
                    }`}
                  >
                    {shareUrl}
                  </div>
                </div>

                <div className="pt-3 border-t border-stone-100 flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openAssignModal(st)}
                      className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-orange-700 bg-orange-50 border border-orange-200 rounded-xl hover:bg-orange-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Package className="w-3.5 h-3.5" />
                      Asignar insumos ({stationItems.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setQrStation(st)}
                      className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-stone-950 rounded-xl hover:bg-stone-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <QrCode className="w-3.5 h-3.5 text-orange-400" />
                      Ver código QR
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopyLink(st)}
                      disabled={!isLinkActive}
                      className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {isCopiedLink ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      {isCopiedLink ? 'Copiado' : 'Copiar enlace'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopyWhatsAppInvite(st)}
                      disabled={!isLinkActive}
                      className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {isCopiedWa ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <ExternalLink className="w-3.5 h-3.5" />
                      )}
                      {isCopiedWa ? 'Copiado' : 'WhatsApp'}
                    </button>
                    <button
                      type="button"
                      disabled={isTogglingThis}
                      onClick={() => handleToggleLink(st, isLinkActive)}
                      className={`min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                        isLinkActive
                          ? 'text-red-700 bg-red-50/70 border-red-200 hover:bg-red-100'
                          : 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                      {isTogglingThis
                        ? 'Actualizando...'
                        : isLinkActive
                          ? 'Desactivar link'
                          : 'Reactivar link'}
                    </button>
                  </div>

                  <div className="flex items-center gap-3 text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => onOpenStationCatalog(st.id)}
                      className="text-stone-600 hover:text-stone-900 cursor-pointer"
                    >
                      Ver en Insumos
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenStationSheet(st.id)}
                      className="text-orange-600 hover:text-orange-700 cursor-pointer"
                    >
                      Abrir planilla
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Workstation Modal (Only station info) */}
      <AnimatePresence>
        {showModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-stone-950/50 backdrop-blur-xs flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.2 }}
              className="bg-white border border-stone-200 rounded-2xl w-full max-w-lg p-4 sm:p-6 space-y-5 shadow-2xl my-4 sm:my-8 min-w-0"
            >
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-bold text-stone-900">
                  {editingStation ? 'Editar puesto de trabajo' : 'Nuevo puesto de trabajo'}
                </h2>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  aria-label="Cerrar ventana"
                  className="p-1.5 text-stone-400 hover:text-stone-700 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {errorMsg && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl">
                  {errorMsg}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Nombre del puesto / sección
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={MAX_NAME_LENGTH}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ej: Jugos y Salchipapas"
                      className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Trabajadora encargada
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={MAX_NAME_LENGTH}
                      value={workerName}
                      onChange={(e) => setWorkerName(e.target.value)}
                      placeholder="Ej: Laura Gómez"
                      className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Área del local (opcional)
                    </label>
                    <input
                      type="text"
                      maxLength={MAX_AREA_LENGTH}
                      value={area}
                      onChange={(e) => setArea(e.target.value)}
                      placeholder="Ej: Barra y Freidora"
                      className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Descripción (opcional)
                    </label>
                    <input
                      type="text"
                      maxLength={MAX_DESC_LENGTH}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Ej: Control de pulpas, limones y papas"
                      className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="min-h-[42px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 disabled:opacity-60 cursor-pointer"
                  >
                    {submitting
                      ? 'Guardando...'
                      : editingStation
                        ? 'Guardar cambios'
                        : 'Crear puesto y generar QR'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Assign Existing Items Checklist Modal */}
      <AnimatePresence>
        {assignStation && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-stone-950/50 backdrop-blur-xs flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.2 }}
              className="bg-white border border-stone-200 rounded-2xl w-full max-w-lg p-4 sm:p-6 space-y-4 shadow-2xl my-4 sm:my-8 min-w-0"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-orange-600">Asignar insumos</p>
                  <h2 className="font-display text-lg font-bold text-stone-900 truncate">
                    {assignStation.name}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setAssignStation(null)}
                  aria-label="Cerrar asignación"
                  className="p-1.5 text-stone-400 hover:text-stone-700 rounded-lg cursor-pointer shrink-0"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {activeItems.length === 0 ? (
                <div className="py-6 text-center space-y-4">
                  <div className="w-11 h-11 rounded-2xl bg-orange-50 border border-orange-200 flex items-center justify-center mx-auto">
                    <Package className="w-5 h-5 text-orange-600" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-stone-900">
                      Aún no hay insumos creados en el catálogo
                    </p>
                    <p className="text-xs text-stone-600">
                      Primero crea tus insumos en el apartado Insumos y luego vuelve aquí para asignarlos a {assignStation.name}.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setAssignStation(null)}
                      className="min-h-[40px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                    >
                      Cerrar
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAssignStation(null);
                        onGoToCatalog();
                      }}
                      className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 cursor-pointer"
                    >
                      <Package className="w-4 h-4" />
                      Ir a Insumos
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSaveAssignment} className="space-y-3.5">
                  <div className="relative">
                    <Search className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={assignSearch}
                      onChange={(e) => setAssignSearch(e.target.value)}
                      placeholder="Buscar insumo por nombre o unidad..."
                      aria-label="Buscar insumo para asignar"
                      className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white"
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs text-stone-600">
                    <span>
                      <strong className="text-stone-900 font-mono tabular-nums">
                        {assignSelectedIds.length}
                      </strong>{' '}
                      {assignSelectedIds.length === 1
                        ? 'insumo seleccionado'
                        : 'insumos seleccionados'}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAssignStation(null);
                        onGoToCatalog();
                      }}
                      className="font-semibold text-orange-600 hover:text-orange-700 cursor-pointer"
                    >
                      Crear nuevo en Insumos
                    </button>
                  </div>

                  {assignError && (
                    <div
                      role="alert"
                      className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl"
                    >
                      {assignError}
                    </div>
                  )}

                  {orderedAssignItems.length === 0 ? (
                    <p className="py-8 text-center text-xs text-stone-500 border border-stone-200 rounded-xl">
                      No hay insumos que coincidan con &ldquo;{assignSearch.trim()}&rdquo;.
                    </p>
                  ) : (
                    <div className="max-h-[48vh] overflow-y-auto divide-y divide-stone-100 border border-stone-200 rounded-xl">
                      {orderedAssignItems.map((item) => {
                        const checked = assignSelectedIds.includes(item.id);
                        const mode = getItemInputType(item);
                        const captureLabel =
                          mode === 'packs' && item.packSize
                            ? `${item.packLabel || 'paquete'} de ${item.packSize} ${pluralizeSpanishLabel(item.unitLabel || item.unit, item.packSize)}`
                            : mode === 'level' && item.capacity
                              ? `Nivel (${item.capacity} ${item.unit})`
                              : 'Conteo';
                        const isInOtherStation =
                          item.station !== assignStation.id &&
                          item.station !== UNASSIGNED_STATION_ID;
                        const otherName = isInOtherStation
                          ? (stationNameMap.get(item.station) ?? item.station)
                          : null;

                        return (
                          <label
                            key={item.id}
                            className={`flex items-start gap-3 px-3.5 py-3 min-h-[48px] cursor-pointer transition-colors ${
                              checked ? 'bg-orange-50/50' : 'hover:bg-stone-50'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAssignItem(item.id)}
                              className="mt-0.5 w-5 h-5 rounded border-stone-300 text-orange-600 focus:ring-orange-500 shrink-0 cursor-pointer"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold text-stone-900 truncate">
                                  {item.name}
                                </span>
                                {item.station === UNASSIGNED_STATION_ID ? (
                                  <span className="text-[11px] font-medium text-amber-700 shrink-0">
                                    Sin asignar
                                  </span>
                                ) : otherName ? (
                                  <span className="text-[11px] font-medium text-stone-500 shrink-0 truncate max-w-[130px]">
                                    En: {otherName}
                                  </span>
                                ) : null}
                              </div>
                              <p className="text-xs text-stone-500 mt-0.5 truncate">
                                {item.unit} · {captureLabel} · Mín {item.minStock} / Ideal{' '}
                                {item.targetStock}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setAssignStation(null)}
                      className="min-h-[42px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={assignSaving}
                      className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 disabled:opacity-60 cursor-pointer"
                    >
                      {assignSaving ? 'Guardando...' : 'Guardar asignación'}
                    </button>
                  </div>
                </form>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* QR Code Display & Print Modal */}
      <AnimatePresence>
        {qrStation && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-xs flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.2 }}
              className="bg-white border border-stone-200 rounded-2xl w-full max-w-md p-6 space-y-5 shadow-2xl text-center"
            >
              <div className="flex items-center justify-between no-print">
                <span className="text-xs font-semibold text-orange-600">
                  Acceso directo al puesto
                </span>
                <button
                  type="button"
                  onClick={() => setQrStation(null)}
                  aria-label="Cerrar código QR"
                  className="p-1.5 text-stone-400 hover:text-stone-700 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-2">
                <img
                  src="/assets/aistudio/IMG_1518_bd74972f.jpeg"
                  alt="Logo The Fire"
                  referrerPolicy="no-referrer"
                  className="w-14 h-14 object-contain mx-auto rounded-xl border border-stone-200 p-1"
                />
                <h2 className="font-display text-xl font-bold text-stone-900">
                  {qrStation.name}
                </h2>
                <p className="text-sm text-stone-600">
                  Encargada:{' '}
                  <span className="font-semibold text-stone-900">{qrStation.workerName}</span>
                </p>
              </div>

              <div className="bg-white border border-stone-200 rounded-2xl p-4 inline-block mx-auto">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt={`Código QR para ${qrStation.name}`}
                    className="w-52 h-52 sm:w-56 sm:h-56 mx-auto"
                  />
                ) : (
                  <div className="w-52 h-52 sm:w-56 sm:h-56 flex items-center justify-center text-xs text-stone-400">
                    Generando código QR...
                  </div>
                )}
              </div>

              <p className="text-xs text-stone-500 leading-relaxed">
                Escanea este código QR desde el celular de la trabajadora o envíale el enlace para que registre su cierre cada día.
              </p>

              <div className="flex flex-wrap items-center justify-center gap-2 no-print">
                <button
                  type="button"
                  onClick={handleDownloadQr}
                  disabled={!qrDataUrl}
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-stone-950 rounded-xl hover:bg-stone-800 disabled:opacity-50 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar QR
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Imprimir
                </button>
                <button
                  type="button"
                  onClick={() => handleCopyLink(qrStation)}
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copiedId === qrStation.id ? 'Copiado' : 'Copiar enlace'}
                </button>
              </div>

              <div className="pt-3 border-t border-stone-100 flex flex-col items-center gap-2.5 no-print">
                {(() => {
                  const qrLinkDoc = qrStation.accessCode
                    ? stationLinksByCode[qrStation.accessCode]
                    : undefined;
                  const qrLinkActive = qrLinkDoc ? qrLinkDoc.active : true;
                  return (
                    <button
                      type="button"
                      disabled={togglingCode === qrStation.id}
                      onClick={() => handleToggleLink(qrStation, qrLinkActive)}
                      className={`inline-flex items-center gap-1.5 text-xs font-semibold cursor-pointer ${
                        qrLinkActive
                          ? 'text-red-700 hover:text-red-800'
                          : 'text-emerald-700 hover:text-emerald-800'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                      {togglingCode === qrStation.id
                        ? 'Actualizando...'
                        : qrLinkActive
                          ? 'Desactivar este enlace temporalmente'
                          : 'Reactivar este enlace'}
                    </button>
                  );
                })()}
                <button
                  type="button"
                  disabled={regenerating}
                  onClick={handleRegenerate}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-500 hover:text-red-700 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} />
                  {regenerating
                    ? 'Regenerando...'
                    : 'Regenerar enlace/QR (invalida el anterior y revoca sesiones)'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirm Delete Station */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-stone-950/50 backdrop-blur-xs flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="bg-white border border-stone-200 rounded-2xl w-full max-w-sm p-6 space-y-4 shadow-2xl"
            >
              <h3 className="font-display text-lg font-bold text-stone-900">
                Eliminar puesto de trabajo
              </h3>
              <p className="text-sm text-stone-600">
                ¿Seguro que deseas eliminar{' '}
                <span className="font-semibold text-stone-900">{confirmDelete.name}</span>? Sus
                insumos permanecerán en el catálogo como sin asignar, y su enlace y QR dejarán de
                funcionar.
              </p>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="min-h-[40px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleDeleteStation}
                  className="min-h-[40px] px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-60 cursor-pointer"
                >
                  {submitting ? 'Eliminando...' : 'Eliminar puesto'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
