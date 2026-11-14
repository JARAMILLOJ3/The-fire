import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Pencil,
  Plus,
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
  UNIT_OPTIONS,
} from '../constants';
import {
  buildStationShareUrl,
  createWorkstation,
  deleteWorkstation,
  regenerateStationLink,
  updateWorkstation,
} from '../services/inventoryService';
import type { InventoryItem, Workspace, Workstation } from '../types';

interface WorkstationsManagerProps {
  workspace: Workspace;
  stations: Workstation[];
  items: InventoryItem[];
  onOpenStationSheet: (stationId: string) => void;
  onOpenStationCatalog: (stationId: string) => void;
}

interface DraftNewItem {
  name: string;
  unit: string;
  minStock: number;
  targetStock: number;
}

export function WorkstationsManager({
  workspace,
  stations,
  items,
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
  const [draftItems, setDraftItems] = useState<DraftNewItem[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
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
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [qrStation, qrStation?.accessCode]);

  const openCreateModal = () => {
    setEditingStation(null);
    setName('');
    setArea('');
    setWorkerName('');
    setDescription('');
    setDraftItems([{ name: '', unit: 'und', minStock: 5, targetStock: 15 }]);
    setErrorMsg(null);
    setShowModal(true);
  };

  const openEditModal = (st: Workstation) => {
    setEditingStation(st);
    setName(st.name);
    setArea(st.area);
    setWorkerName(st.workerName);
    setDescription(st.description);
    setDraftItems([]);
    setErrorMsg(null);
    setShowModal(true);
  };

  const handleAddDraftItemRow = () => {
    setDraftItems((prev) => [
      ...prev,
      { name: '', unit: 'und', minStock: 5, targetStock: 15 },
    ]);
  };

  const handleUpdateDraftItem = (
    idx: number,
    field: keyof DraftNewItem,
    val: string | number,
  ) => {
    setDraftItems((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, [field]: val } : row)),
    );
  };

  const handleRemoveDraftItem = (idx: number) => {
    setDraftItems((prev) => prev.filter((_, i) => i !== idx));
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
        const validItems = draftItems.filter((d) => d.name.trim().length > 0);
        await createWorkstation(workspace, {
          name,
          area,
          workerName,
          description,
          sortOrder: (stations.length + 1) * 10,
          initialItems: validItems,
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
    const msg = `Hola ${st.workerName}, ingresa desde tu celular a este enlace de *The Fire Inventario* para registrar el inicio y cierre diario de *${st.name}*:\n${shareUrl}`;
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Administración · {stations.length} puestos activos
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mt-1">
            Puestos de Trabajo y Códigos QR
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Crea cada sección del negocio, asigna a su trabajadora y genera el enlace o código QR para que entre desde su celular directo a reportar su inventario diario.
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Nuevo puesto de trabajo
        </button>
      </div>

      {/* Stations Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {stations.map((st) => {
          const stationItems = items.filter((i) => i.active && i.station === st.id);
          const shareUrl = buildStationShareUrl(st.id, st.accessCode);
          const isCopiedLink = copiedId === st.id;
          const isCopiedWa = copiedId === `wa_${st.id}`;

          return (
            <div
              key={st.id}
              className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-5"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-display text-lg font-bold text-slate-900 truncate">
                      {st.name}
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
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
                      className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(st)}
                      aria-label={`Eliminar ${st.name}`}
                      className="p-2 text-slate-500 hover:text-red-700 hover:bg-red-50 rounded-lg cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5">
                  <UserRound className="w-4 h-4 text-teal-700 shrink-0" />
                  <span className="text-slate-500">Trabajadora:</span>
                  <span className="font-semibold text-slate-900 truncate">{st.workerName}</span>
                </div>

                {st.description && (
                  <p className="text-xs text-slate-600 leading-relaxed">{st.description}</p>
                )}

                <div className="text-xs text-slate-500 font-mono truncate bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
                  {shareUrl}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setQrStation(st)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <QrCode className="w-3.5 h-3.5" />
                    Ver código QR
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyLink(st)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {isCopiedLink ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {isCopiedLink ? 'Enlace copiado' : 'Copiar enlace'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyWhatsAppInvite(st)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {isCopiedWa ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <ExternalLink className="w-3.5 h-3.5" />}
                    {isCopiedWa ? 'Mensaje copiado' : 'Mensaje WhatsApp'}
                  </button>
                </div>

                <div className="flex items-center gap-3 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => onOpenStationCatalog(st.id)}
                    className="text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Insumos
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenStationSheet(st.id)}
                    className="text-teal-700 hover:text-teal-800 cursor-pointer"
                  >
                    Abrir planilla
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create / Edit Workstation Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl p-6 space-y-5 shadow-xl my-8">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-slate-900">
                {editingStation ? 'Editar puesto de trabajo' : 'Nuevo puesto de trabajo'}
              </h2>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {errorMsg && (
              <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nombre del puesto / sección
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={MAX_NAME_LENGTH}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ej: Jugos y Salchipapas"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Trabajadora encargada
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={MAX_NAME_LENGTH}
                    value={workerName}
                    onChange={(e) => setWorkerName(e.target.value)}
                    placeholder="Ej: Laura Gómez"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Área del local (opcional)
                  </label>
                  <input
                    type="text"
                    maxLength={MAX_AREA_LENGTH}
                    value={area}
                    onChange={(e) => setArea(e.target.value)}
                    placeholder="Ej: Barra y Freidora"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Descripción (opcional)
                  </label>
                  <input
                    type="text"
                    maxLength={MAX_DESC_LENGTH}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Ej: Control de pulpas, limones y papas"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              {!editingStation && (
                <div className="pt-2 border-t border-slate-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700">
                      Insumos a registrar en este puesto
                    </span>
                    <button
                      type="button"
                      onClick={handleAddDraftItemRow}
                      className="text-xs font-semibold text-teal-700 hover:text-teal-800 cursor-pointer"
                    >
                      + Agregar otro insumo
                    </button>
                  </div>

                  <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                    {draftItems.map((row, idx) => (
                      <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                        <input
                          type="text"
                          maxLength={MAX_NAME_LENGTH}
                          value={row.name}
                          onChange={(e) => handleUpdateDraftItem(idx, 'name', e.target.value)}
                          placeholder="Nombre del insumo"
                          className="col-span-5 px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        <input
                          type="text"
                          list="ws-unit-list"
                          maxLength={MAX_UNIT_LENGTH}
                          value={row.unit}
                          onChange={(e) => handleUpdateDraftItem(idx, 'unit', e.target.value)}
                          placeholder="und"
                          className="col-span-2 px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        <input
                          type="number"
                          min={0}
                          value={row.minStock}
                          onChange={(e) =>
                            handleUpdateDraftItem(idx, 'minStock', parseFloat(e.target.value) || 0)
                          }
                          title="Stock mínimo"
                          placeholder="Mín"
                          className="col-span-2 px-2 py-1.5 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        <input
                          type="number"
                          min={0}
                          value={row.targetStock}
                          onChange={(e) =>
                            handleUpdateDraftItem(
                              idx,
                              'targetStock',
                              parseFloat(e.target.value) || 0,
                            )
                          }
                          title="Stock ideal"
                          placeholder="Ideal"
                          className="col-span-2 px-2 py-1.5 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveDraftItem(idx)}
                          aria-label="Quitar fila"
                          className="col-span-1 p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <datalist id="ws-unit-list">
                    {UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-sm font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                >
                  {submitting
                    ? 'Guardando...'
                    : editingStation
                      ? 'Guardar cambios'
                      : 'Crear puesto y generar QR'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* QR Code Display & Print Modal */}
      {qrStation && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-5 shadow-xl text-center">
            <div className="flex items-center justify-between no-print">
              <span className="text-xs font-semibold text-teal-700">Acceso directo al puesto</span>
              <button
                type="button"
                onClick={() => setQrStation(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              <img
                src="/assets/aistudio/IMG_1518_bd74972f.jpeg"
                alt="Logo The Fire"
                referrerPolicy="no-referrer"
                className="w-14 h-14 object-contain mx-auto rounded-lg border border-slate-200 p-1"
              />
              <h2 className="font-display text-xl font-bold text-slate-900">
                {qrStation.name}
              </h2>
              <p className="text-sm text-slate-600">
                Encargada: <span className="font-semibold text-slate-900">{qrStation.workerName}</span>
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 inline-block mx-auto">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={`Código QR para ${qrStation.name}`}
                  className="w-56 h-56 mx-auto"
                />
              ) : (
                <div className="w-56 h-56 flex items-center justify-center text-xs text-slate-400">
                  Generando código QR...
                </div>
              )}
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              Escanea este código QR desde el celular de la trabajadora o envíale el enlace para que registre apertura y cierre cada día.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-2 no-print">
              <button
                type="button"
                onClick={handleDownloadQr}
                disabled={!qrDataUrl}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Descargar QR
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                Imprimir
              </button>
              <button
                type="button"
                onClick={() => handleCopyLink(qrStation)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" />
                {copiedId === qrStation.id ? 'Copiado' : 'Copiar enlace'}
              </button>
            </div>

            <div className="pt-3 border-t border-slate-100 flex justify-center no-print">
              <button
                type="button"
                disabled={regenerating}
                onClick={handleRegenerate}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-red-700 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} />
                {regenerating
                  ? 'Regenerando...'
                  : 'Regenerar enlace/QR (invalida el anterior)'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delete Station */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-6 space-y-4 shadow-xl">
            <h3 className="font-display text-lg font-bold text-slate-900">
              Eliminar puesto de trabajo
            </h3>
            <p className="text-sm text-slate-600">
              ¿Seguro que deseas eliminar <span className="font-semibold text-slate-900">{confirmDelete.name}</span> y todos sus insumos asignados? Su enlace y QR dejarán de funcionar.
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleDeleteStation}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-60 cursor-pointer"
              >
                {submitting ? 'Eliminando...' : 'Eliminar puesto'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
