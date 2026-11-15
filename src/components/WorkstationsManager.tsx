import { useEffect, useMemo, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  Link2Off,
  Pencil,
  Plus,
  Power,
  Printer,
  QrCode,
  RefreshCw,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  MAX_AREA_LENGTH,
  MAX_DESC_LENGTH,
  MAX_NAME_LENGTH,
  MAX_UNIT_LENGTH,
} from '../constants';
import {
  buildStationShareUrl,
  createWorkstation,
  deleteWorkstation,
  regenerateStationLink,
  toggleStationLinkActive,
  updateWorkstation,
} from '../services/inventoryService';
import type { InventoryItem, StationLink, Workspace, Workstation } from '../types';
import {
  createDefaultStationItemDraft,
  getUnitSelectOptions,
  inventoryItemToDraft,
  type StationItemDraft,
  validateStationItemsDraft,
} from '../utils/inventory';
import { ItemCaptureFields } from './ItemCaptureFields';
import { OptionSelect } from './OptionSelect';

interface WorkstationsManagerProps {
  workspace: Workspace;
  isOwner?: boolean;
  stations: Workstation[];
  items: InventoryItem[];
  stationLinksByCode?: Record<string, StationLink>;
  onOpenStationSheet: (stationId: string) => void;
  onOpenStationCatalog: (stationId: string) => void;
}


export function WorkstationsManager({
  workspace,
  isOwner = false,
  stations,
  items,
  stationLinksByCode = {},
  onOpenStationSheet,
  onOpenStationCatalog,
}: WorkstationsManagerProps) {
  const [showModal, setShowModal] = useState(false);
  const [editingStation, setEditingStation] = useState<Workstation | null>(null);
  const [qrStation, setQrStation] = useState<Workstation | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState<Workstation | null>(null);

  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [description, setDescription] = useState('');
  const [draftItems, setDraftItems] = useState<StationItemDraft[]>([]);
  const [editingInitialItemIds, setEditingInitialItemIds] = useState<string[]>([]);

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

  const unitOptions = useMemo(() => getUnitSelectOptions(), []);

  const itemsValidation = useMemo(
    () =>
      validateStationItemsDraft({
        drafts: draftItems,
        stationId: editingStation?.id ?? 'new_station',
      }),
    [draftItems, editingStation?.id],
  );

  const openCreateModal = () => {
    setEditingStation(null);
    setEditingInitialItemIds([]);
    setName('');
    setArea('');
    setWorkerName('');
    setDescription('');
    setDraftItems([createDefaultStationItemDraft()]);
    setErrorMsg(null);
    setShowModal(true);
  };

  const openEditModal = (st: Workstation) => {
    const stationActiveItems = items.filter((it) => it.active && it.station === st.id);
    setEditingStation(st);
    setEditingInitialItemIds(stationActiveItems.map((it) => it.id));
    setName(st.name);
    setArea(st.area);
    setWorkerName(st.workerName);
    setDescription(st.description);
    setDraftItems(stationActiveItems.map(inventoryItemToDraft));
    setErrorMsg(null);
    setShowModal(true);
  };

  const handleAddDraftItemRow = () => {
    setDraftItems((prev) => [...prev, createDefaultStationItemDraft()]);
    if (errorMsg) setErrorMsg(null);
  };

  const handleUpdateDraftItem = <K extends keyof StationItemDraft>(
    idx: number,
    field: K,
    val: StationItemDraft[K],
  ) => {
    setDraftItems((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, [field]: val } : row)),
    );
    if (errorMsg) setErrorMsg(null);
  };

  const handleRemoveDraftItem = (idx: number) => {
    setDraftItems((prev) => prev.filter((_, i) => i !== idx));
    if (errorMsg) setErrorMsg(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !workerName.trim()) {
      setErrorMsg('Ingresa el nombre del puesto y el nombre de la trabajadora encargada.');
      return;
    }

    if (!itemsValidation.valid) {
      setErrorMsg(itemsValidation.error ?? 'Revisa los datos de los insumos del puesto.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      if (editingStation) {
        const keptIds = new Set(
          itemsValidation.preparedItems
            .map((item) => item.id)
            .filter((id): id is string => Boolean(id)),
        );
        const archivedItemIds = editingInitialItemIds.filter((id) => !keptIds.has(id));
        await updateWorkstation(workspace, editingStation, {
          name,
          area,
          workerName,
          description,
          items: itemsValidation.preparedItems,
          archivedItemIds,
        });
      } else {
        await createWorkstation(workspace, {
          name,
          area,
          workerName,
          description,
          sortOrder: (stations.length + 1) * 10,
          initialItems: itemsValidation.preparedItems,
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
            Crea cada sección del restaurante, asigna a su encargada y comparte el código QR o enlace directo para que registre su cierre desde el celular.
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
        <div className="bg-white border border-stone-200 rounded-2xl p-8 sm:p-10 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-orange-50 border border-orange-200 flex items-center justify-center mx-auto">
            <QrCode className="w-6 h-6 text-orange-600" />
          </div>
          <div className="space-y-1.5 max-w-md mx-auto">
            <h2 className="font-display text-lg font-bold text-stone-900">
              Aún no hay puestos de trabajo
            </h2>
            <p className="text-sm text-stone-600">
              Crea tu primer puesto de trabajo (ej. Mesera, Asados o Cocina) para agregarle sus primeros insumos y generar su código QR.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreateModal}
            className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Crear primer puesto de trabajo
          </button>
        </div>
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        {stations.map((st, idx) => {
          const stationItems = items.filter((i) => i.active && i.station === st.id);
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
                        {stationItems.length} insumos
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
                    Insumos
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

      {/* Create / Edit Workstation Modal */}
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
              className="bg-white border border-stone-200 rounded-2xl w-full max-w-xl p-4 sm:p-6 space-y-5 shadow-2xl my-4 sm:my-8 min-w-0"
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

                <div className="pt-2 border-t border-stone-200 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-stone-700">
                      Insumos de este puesto ({draftItems.length})
                    </span>
                    <button
                      type="button"
                      onClick={handleAddDraftItemRow}
                      className="text-xs font-semibold text-orange-600 hover:text-orange-700 whitespace-nowrap cursor-pointer"
                    >
                      + Agregar otro insumo
                    </button>
                  </div>

                  {draftItems.length === 0 ? (
                    <p className="text-xs text-stone-500 bg-stone-50 border border-stone-200 rounded-xl px-3 py-3 text-center">
                      Este puesto aún no tiene insumos. Usa &quot;+ Agregar otro insumo&quot; para añadir uno.
                    </p>
                  ) : (
                    <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                      {draftItems.map((row, idx) => (
                        <div
                          key={row.id ?? `new_${idx}`}
                          className="p-3 bg-stone-50 border border-stone-200 rounded-xl space-y-2.5"
                        >
                          <div className="flex items-end gap-2 min-w-0">
                            <div className="flex-1 min-w-0">
                              <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                Insumo
                              </label>
                              <input
                                type="text"
                                maxLength={MAX_NAME_LENGTH}
                                value={row.name}
                                onChange={(e) => handleUpdateDraftItem(idx, 'name', e.target.value)}
                                placeholder="Nombre del insumo"
                                className="w-full min-h-[38px] px-2.5 py-1.5 text-sm bg-white border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveDraftItem(idx)}
                              aria-label="Quitar insumo"
                              title="Quitar insumo"
                              className="min-h-[38px] px-2 flex items-center justify-center text-stone-400 hover:text-red-600 rounded-lg cursor-pointer shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>

                          <div className="min-w-0">
                            <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                              Unidad <span className="text-red-600">*</span>
                            </label>
                            <OptionSelect
                              size="sm"
                              value={row.unit}
                              options={unitOptions}
                              maxLength={MAX_UNIT_LENGTH}
                              required={Boolean(row.id || row.name.trim().length > 0)}
                              selectAriaLabel="Unidad"
                              customAriaLabel="Escribe la unidad"
                              customPlaceholder="Ej: galón, ml, atado"
                              onChange={(val) => handleUpdateDraftItem(idx, 'unit', val)}
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                Mínimo ({row.unit.trim() || 'und'})
                              </label>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                value={row.minStock}
                                onChange={(e) =>
                                  handleUpdateDraftItem(
                                    idx,
                                    'minStock',
                                    parseFloat(e.target.value) || 0,
                                  )
                                }
                                aria-label="Mínimo"
                                className="w-full min-h-[38px] px-2.5 py-1.5 text-xs sm:text-sm font-mono tabular-nums bg-white border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                                Ideal ({row.unit.trim() || 'und'})
                              </label>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                value={row.targetStock}
                                onChange={(e) =>
                                  handleUpdateDraftItem(
                                    idx,
                                    'targetStock',
                                    parseFloat(e.target.value) || 0,
                                  )
                                }
                                aria-label="Ideal"
                                className="w-full min-h-[38px] px-2.5 py-1.5 text-xs sm:text-sm font-mono tabular-nums bg-white border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                              />
                            </div>
                          </div>

                          <ItemCaptureFields
                            compact
                            requireCaptureFields={Boolean(row.id || row.name.trim().length > 0)}
                            inputType={row.inputType}
                            onInputTypeChange={(next) =>
                              handleUpdateDraftItem(idx, 'inputType', next)
                            }
                            unit={row.unit}
                            packSizeInput={row.packSizeInput}
                            onPackSizeInputChange={(val) =>
                              handleUpdateDraftItem(idx, 'packSizeInput', val)
                            }
                            packLabel={row.packLabel}
                            onPackLabelChange={(val) =>
                              handleUpdateDraftItem(idx, 'packLabel', val)
                            }
                            unitLabel={row.unitLabel}
                            onUnitLabelChange={(val) =>
                              handleUpdateDraftItem(idx, 'unitLabel', val)
                            }
                            capacityInput={row.capacityInput}
                            onCapacityInputChange={(val) =>
                              handleUpdateDraftItem(idx, 'capacityInput', val)
                            }
                            onClearError={() => {
                              if (errorMsg) setErrorMsg(null);
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {!errorMsg && itemsValidation.warning && (
                    <div
                      role="alert"
                      className="p-2.5 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2"
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                      <span>{itemsValidation.warning}</span>
                    </div>
                  )}
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
                <span className="font-semibold text-stone-900">{confirmDelete.name}</span> y todos
                sus insumos asignados? Su enlace y QR dejarán de funcionar.
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
