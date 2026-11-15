import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Archive, ArchiveRestore, Pencil, Plus, X } from 'lucide-react';
import {
  MAX_NAME_LENGTH,
  MAX_UNIT_LENGTH,
  UNIT_OPTIONS,
} from '../constants';
import {
  createInventoryItem,
  setInventoryItemActive,
  updateInventoryItem,
} from '../services/inventoryService';
import type {
  CaptureInputType,
  InventoryItem,
  StationId,
  Workspace,
  Workstation,
} from '../types';
import {
  buildItemCaptureFields,
  getItemInputType,
  hasTargetBelowMin,
  parseCaptureDecimalInput,
  pluralizeSpanishLabel,
  validateCatalogItemInput,
} from '../utils/inventory';
import { ItemCaptureFields } from './ItemCaptureFields';

interface CatalogManagerProps {
  workspace: Workspace;
  stations: Workstation[];
  items: InventoryItem[];
  initialFilterStation?: string;
  onGoToWorkstations?: () => void;
}

export function CatalogManager({
  workspace,
  stations,
  items,
  initialFilterStation = 'all',
  onGoToWorkstations,
}: CatalogManagerProps) {
  const [stationFilter, setStationFilter] = useState<'all' | StationId>(initialFilterStation);
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived'>('active');
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<InventoryItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [stationId, setStationId] = useState<StationId>(stations[0]?.id ?? 'mesera');
  const [unit, setUnit] = useState('und');
  const [minStock, setMinStock] = useState(5);
  const [targetStock, setTargetStock] = useState(15);
  const [inputType, setInputType] = useState<CaptureInputType>('count');
  const [packSizeInput, setPackSizeInput] = useState('8');
  const [packLabel, setPackLabel] = useState('paquete');
  const [unitLabel, setUnitLabel] = useState('und');
  const [capacityInput, setCapacityInput] = useState('5');

  useEffect(() => {
    setStationFilter(initialFilterStation);
  }, [initialFilterStation]);

  const stationNameMap = useMemo(
    () => new Map(stations.map((s) => [s.id, s.name])),
    [stations],
  );

  const activeItems = useMemo(() => items.filter((it) => it.active), [items]);
  const archivedItems = useMemo(() => items.filter((it) => !it.active), [items]);
  const scopedStatusItems = statusFilter === 'active' ? activeItems : archivedItems;

  const filteredItems = scopedStatusItems.filter((it) =>
    stationFilter === 'all' ? true : it.station === stationFilter,
  );

  const parsedPackSize = useMemo(
    () => parseCaptureDecimalInput(packSizeInput),
    [packSizeInput],
  );

  const parsedCapacity = useMemo(
    () => parseCaptureDecimalInput(capacityInput),
    [capacityInput],
  );

  const formValidation = useMemo(
    () =>
      validateCatalogItemInput({
        name,
        unit,
        station: stationId,
        minStock,
        targetStock,
        inputType,
        packSize: inputType === 'packs' ? parsedPackSize : undefined,
        packLabel: inputType === 'packs' ? packLabel : undefined,
        unitLabel: inputType === 'packs' ? unitLabel : undefined,
        capacity: inputType === 'level' ? parsedCapacity : undefined,
        existingItems: items,
        editingItemId: editingItem?.id,
      }),
    [
      name,
      unit,
      stationId,
      minStock,
      targetStock,
      inputType,
      parsedPackSize,
      packLabel,
      unitLabel,
      parsedCapacity,
      items,
      editingItem?.id,
    ],
  );

  const openCreateForm = () => {
    setEditingItem(null);
    setName('');
    setStationId(stationFilter === 'all' ? (stations[0]?.id ?? 'mesera') : stationFilter);
    setUnit('und');
    setMinStock(5);
    setTargetStock(15);
    setInputType('count');
    setPackSizeInput('8');
    setPackLabel('paquete');
    setUnitLabel('und');
    setCapacityInput('5');
    setErrorMsg(null);
    setActionFeedback(null);
    setShowForm(true);
  };

  const openEditForm = (item: InventoryItem) => {
    setEditingItem(item);
    setName(item.name);
    setStationId(item.station);
    setUnit(item.unit);
    setMinStock(item.minStock);
    setTargetStock(item.targetStock);
    setInputType(getItemInputType(item));
    setPackSizeInput(typeof item.packSize === 'number' ? String(item.packSize) : '8');
    setPackLabel(item.packLabel ?? 'paquete');
    setUnitLabel(item.unitLabel ?? (item.unit || 'und'));
    setCapacityInput(typeof item.capacity === 'number' ? String(item.capacity) : '5');
    setErrorMsg(null);
    setActionFeedback(null);
    setShowForm(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!formValidation.valid) {
      setErrorMsg(formValidation.error ?? 'Revisa los datos del insumo.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const cleanName = name.trim();
      const cleanUnit = unit.trim();
      const capturePayload = buildItemCaptureFields({
        inputType,
        packSizeInput,
        packLabel,
        unitLabel,
        capacityInput,
      });

      if (editingItem) {
        await updateInventoryItem(editingItem.id, {
          station: stationId,
          name: cleanName,
          unit: cleanUnit,
          minStock,
          targetStock,
          active: editingItem.active,
          ...capturePayload,
        });
      } else {
        const targetStationObj = stations.find((s) => s.id === stationId);
        await createInventoryItem(workspace, targetStationObj, {
          station: stationId,
          name: cleanName,
          unit: cleanUnit,
          minStock,
          targetStock,
          sortOrder: (items.length + 1) * 10,
          ...capturePayload,
        });
      }
      setShowForm(false);
    } catch {
      setErrorMsg('No se pudo guardar el insumo. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleArchive = async () => {
    if (!confirmArchive) return;
    setSubmitting(true);
    setActionFeedback(null);
    try {
      await setInventoryItemActive(confirmArchive.id, false);
      setConfirmArchive(null);
    } catch {
      setActionFeedback('No se pudo archivar el insumo. Intenta nuevamente.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRestore = async (item: InventoryItem) => {
    setActionFeedback(null);
    const check = validateCatalogItemInput({
      name: item.name,
      unit: item.unit,
      station: item.station,
      minStock: item.minStock,
      targetStock: item.targetStock,
      inputType: getItemInputType(item),
      packSize: item.packSize,
      packLabel: item.packLabel,
      unitLabel: item.unitLabel,
      capacity: item.capacity,
      existingItems: items,
      editingItemId: item.id,
    });
    if (!check.valid) {
      setActionFeedback(
        check.error ?? 'Ya existe un insumo activo con ese nombre en el mismo puesto.',
      );
      return;
    }

    setSubmitting(true);
    try {
      await setInventoryItemActive(item.id, true);
    } catch {
      setActionFeedback('No se pudo reactivar el insumo. Intenta nuevamente.');
    } finally {
      setSubmitting(false);
    }
  };

  const misconfiguredActiveCount = activeItems.filter((it) =>
    hasTargetBelowMin(it.minStock, it.targetStock),
  ).length;

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-orange-600">
            Configuración · {activeItems.length} activos
            {archivedItems.length > 0 ? ` · ${archivedItems.length} archivados` : ''}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-1">
            Catálogo de Insumos
          </h1>
          <p className="text-sm text-stone-600 mt-1">
            Administra los productos de cada puesto. Los insumos archivados conservan todo su historial sin aparecer en planillas nuevas.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openCreateForm}
            disabled={stations.length === 0}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.98] disabled:opacity-50 transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Nuevo insumo
          </button>
        </div>
      </div>

      {misconfiguredActiveCount > 0 && (
        <div
          role="status"
          className="px-4 py-3 rounded-2xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs sm:text-sm text-amber-950"
        >
          <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <span>
            Hay <strong>{misconfiguredActiveCount}</strong>{' '}
            {misconfiguredActiveCount === 1 ? 'insumo' : 'insumos'} con{' '}
            <strong>stock ideal menor que el stock mínimo</strong>. Edítalos para que la cantidad sugerida de compra sea correcta.
          </span>
        </div>
      )}

      {actionFeedback && (
        <div
          role="alert"
          className="px-4 py-3 rounded-2xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-800"
        >
          {actionFeedback}
        </div>
      )}

      {/* Filter Bar: Station + Active/Archived */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-stone-200/70 rounded-xl w-full sm:w-fit max-w-full overflow-x-auto">
          <button
            type="button"
            onClick={() => setStationFilter('all')}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              stationFilter === 'all'
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            Todos ({scopedStatusItems.length})
          </button>
          {stations.map((st) => {
            const count = scopedStatusItems.filter((i) => i.station === st.id).length;
            return (
              <button
                key={st.id}
                type="button"
                onClick={() => setStationFilter(st.id)}
                className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                  stationFilter === st.id
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                {st.name} ({count})
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1 p-1 bg-stone-200/70 rounded-xl shrink-0">
          <button
            type="button"
            onClick={() => {
              setStatusFilter('active');
              setActionFeedback(null);
            }}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
              statusFilter === 'active'
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            Activos ({activeItems.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setStatusFilter('archived');
              setActionFeedback(null);
            }}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
              statusFilter === 'archived'
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            Archivados ({archivedItems.length})
          </button>
        </div>
      </div>

      {/* Responsive Table / Mobile Cards */}
      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
        {filteredItems.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm font-medium text-stone-700">
              {stations.length === 0
                ? 'Primero crea tu primer puesto de trabajo para poder agregar insumos.'
                : statusFilter === 'archived'
                  ? 'No hay insumos archivados en este filtro.'
                  : 'No hay insumos activos en esta vista.'}
            </p>
            {stations.length === 0 && onGoToWorkstations ? (
              <button
                type="button"
                onClick={onGoToWorkstations}
                className="min-h-[40px] px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 cursor-pointer"
              >
                Crear primer puesto de trabajo
              </button>
            ) : statusFilter === 'active' && stations.length > 0 ? (
              <button
                type="button"
                onClick={openCreateForm}
                className="text-sm font-semibold text-orange-600 hover:text-orange-700 cursor-pointer"
              >
                + Agregar primer insumo
              </button>
            ) : null}
          </div>
        ) : (
          <>
            {/* Mobile Compact List (< sm) */}
            <div className="sm:hidden divide-y divide-stone-200">
              {filteredItems.map((item) => {
                const targetLow = hasTargetBelowMin(item.minStock, item.targetStock);
                const mode = getItemInputType(item);
                const modeSummary =
                  mode === 'packs' && item.packSize
                    ? `${item.packLabel || 'paquete'} de ${item.packSize} ${pluralizeSpanishLabel(item.unitLabel || item.unit, item.packSize)}`
                    : mode === 'level' && item.capacity
                      ? `Nivel (envase ${item.capacity} ${item.unit})`
                      : 'Conteo (− / +)';
                return (
                  <div key={item.id} className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-stone-900 truncate">{item.name}</p>
                      <p className="text-xs text-stone-500 truncate">
                        {stationNameMap.get(item.station) ?? item.station} · {item.unit} · {modeSummary}
                      </p>
                      <p className="text-xs font-mono tabular-nums text-stone-600 mt-0.5">
                        Mín: {item.minStock} · Ideal: {item.targetStock}
                      </p>
                      {targetLow && (
                        <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 mt-1">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          Stock ideal menor que mínimo
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditForm(item)}
                        aria-label={`Editar ${item.name}`}
                        className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg cursor-pointer"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {item.active ? (
                        <button
                          type="button"
                          onClick={() => setConfirmArchive(item)}
                          aria-label={`Archivar ${item.name}`}
                          title="Archivar insumo"
                          className="p-2 text-stone-500 hover:text-amber-700 hover:bg-amber-50 rounded-lg cursor-pointer"
                        >
                          <Archive className="w-4 h-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => handleRestore(item)}
                          aria-label={`Reactivar ${item.name}`}
                          title="Reactivar insumo"
                          className="p-2 text-emerald-700 hover:bg-emerald-50 rounded-lg cursor-pointer"
                        >
                          <ArchiveRestore className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop Table (sm+) */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th className="py-3 px-4">Insumo</th>
                    <th className="py-3 px-4">Puesto de trabajo</th>
                    <th className="py-3 px-4">Captura</th>
                    <th className="py-3 px-4">Unidad base</th>
                    <th className="py-3 px-4 text-right">Stock mínimo</th>
                    <th className="py-3 px-4 text-right">Stock ideal</th>
                    <th className="py-3 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-sm">
                  {filteredItems.map((item) => {
                    const targetLow = hasTargetBelowMin(item.minStock, item.targetStock);
                    const mode = getItemInputType(item);
                    const captureText =
                      mode === 'packs' && item.packSize
                        ? `Paquetes: 1 ${item.packLabel || 'paquete'} = ${item.packSize} ${pluralizeSpanishLabel(item.unitLabel || item.unit, item.packSize)}`
                        : mode === 'level' && item.capacity
                          ? `Nivel (0 a ${item.capacity} ${item.unit})`
                          : 'Conteo';
                    return (
                      <tr key={item.id} className="hover:bg-stone-50/80 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-medium text-stone-900">{item.name}</div>
                          {targetLow && (
                            <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 mt-0.5">
                              <AlertTriangle className="w-3 h-3 shrink-0" />
                              Ideal menor que mínimo
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-stone-600">
                          {stationNameMap.get(item.station) ?? item.station}
                        </td>
                        <td className="py-3 px-4 text-xs text-stone-600">{captureText}</td>
                        <td className="py-3 px-4 text-stone-600 font-mono text-xs">{item.unit}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-stone-800">
                          {item.minStock}
                        </td>
                        <td
                          className={`py-3 px-4 text-right font-mono tabular-nums ${
                            targetLow ? 'text-amber-800 font-semibold' : 'text-stone-600'
                          }`}
                        >
                          {item.targetStock}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openEditForm(item)}
                              aria-label={`Editar ${item.name}`}
                              className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg cursor-pointer"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            {item.active ? (
                              <button
                                type="button"
                                onClick={() => setConfirmArchive(item)}
                                aria-label={`Archivar ${item.name}`}
                                title="Archivar insumo"
                                className="p-2 text-stone-500 hover:text-amber-700 hover:bg-amber-50 rounded-lg cursor-pointer"
                              >
                                <Archive className="w-4 h-4" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={submitting}
                                onClick={() => handleRestore(item)}
                                aria-label={`Reactivar ${item.name}`}
                                title="Reactivar insumo"
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer"
                              >
                                <ArchiveRestore className="w-3.5 h-3.5" />
                                Reactivar
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Add/Edit Modal */}
      <AnimatePresence>
        {showForm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-stone-950/50 backdrop-blur-xs flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.2 }}
              className="bg-white border border-stone-200 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-5 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-bold text-stone-900">
                  {editingItem ? 'Editar insumo' : 'Agregar nuevo insumo'}
                </h2>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
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

              {!errorMsg && formValidation.warning && (
                <div
                  role="alert"
                  className="p-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <span>{formValidation.warning}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Nombre del insumo
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={MAX_NAME_LENGTH}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (errorMsg) setErrorMsg(null);
                    }}
                    placeholder="Ej: Pulpa de maracuyá"
                    className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Puesto de trabajo
                    </label>
                    <select
                      value={stationId}
                      onChange={(e) => {
                        setStationId(e.target.value);
                        if (errorMsg) setErrorMsg(null);
                      }}
                      className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
                    >
                      {stations.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Unidad base de inventario <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="text"
                      list="unit-suggestions"
                      required
                      maxLength={MAX_UNIT_LENGTH}
                      value={unit}
                      onChange={(e) => {
                        setUnit(e.target.value);
                        if (errorMsg) setErrorMsg(null);
                      }}
                      placeholder="Ej: und, kg, L"
                      className="w-full min-h-[42px] px-3 py-2 text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                    <datalist id="unit-suggestions">
                      {UNIT_OPTIONS.map((u) => (
                        <option key={u} value={u} />
                      ))}
                    </datalist>
                  </div>
                </div>

                {/* Capture type selector */}
                <ItemCaptureFields
                  inputType={inputType}
                  onInputTypeChange={setInputType}
                  unit={unit}
                  packSizeInput={packSizeInput}
                  onPackSizeInputChange={setPackSizeInput}
                  packLabel={packLabel}
                  onPackLabelChange={setPackLabel}
                  unitLabel={unitLabel}
                  onUnitLabelChange={setUnitLabel}
                  capacityInput={capacityInput}
                  onCapacityInputChange={setCapacityInput}
                  onClearError={() => {
                    if (errorMsg) setErrorMsg(null);
                  }}
                />

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Stock mínimo ({unit.trim() || 'und'})
                    </label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      required
                      value={minStock}
                      onChange={(e) => setMinStock(parseFloat(e.target.value) || 0)}
                      className="w-full min-h-[42px] px-3 py-2 text-sm font-mono tabular-nums border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Stock ideal ({unit.trim() || 'und'})
                    </label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      required
                      value={targetStock}
                      onChange={(e) => setTargetStock(parseFloat(e.target.value) || 0)}
                      className="w-full min-h-[42px] px-3 py-2 text-sm font-mono tabular-nums border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowForm(false)}
                    className="min-h-[42px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 disabled:opacity-60 cursor-pointer"
                  >
                    {submitting ? 'Guardando...' : 'Guardar insumo'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Archive Confirmation Modal */}
      <AnimatePresence>
        {confirmArchive && (
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
                Archivar insumo
              </h3>
              <p className="text-sm text-stone-600">
                ¿Deseas archivar{' '}
                <span className="font-semibold text-stone-900">{confirmArchive.name}</span>?
                Dejará de aparecer en la planilla de las trabajadoras, conservará todo su historial y podrás reactivarlo cuando lo necesites.
              </p>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setConfirmArchive(null)}
                  className="min-h-[40px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleArchive}
                  className="min-h-[40px] px-4 py-2 text-sm font-semibold text-white bg-amber-600 rounded-xl hover:bg-amber-700 disabled:opacity-60 cursor-pointer"
                >
                  {submitting ? 'Archivando...' : 'Archivar'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

