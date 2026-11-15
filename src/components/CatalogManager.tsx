import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Check,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  MAX_NAME_LENGTH,
  MAX_UNIT_LENGTH,
  UNASSIGNED_STATION_ID,
} from '../constants';
import type { PacksMigrationState } from '../hooks/useStationData';
import {
  createInventoryItem,
  setInventoryItemActive,
  updateInventoryItem,
} from '../services/bossService';
import type {
  CaptureInputType,
  InventoryItem,
  PacksUnitMigrationRecord,
  StationId,
  Workspace,
  Workstation,
} from '../types';
import {
  buildItemCaptureFields,
  confirmPacksThresholdSignature,
  findPacksItemsNeedingThresholdReview,
  formatContainerFractionLabel,
  formatItemStockDisplay,
  formatPackEquivalent,
  getEffectiveItemUnit,
  getItemInputType,
  getLevelUnitSelectOptions,
  getUnitSelectOptions,
  hasTargetBelowMin,
  isInvalidLevelUnit,
  parseCaptureDecimalInput,
  pluralizeSpanishLabel,
  readConfirmedPacksThresholds,
  validateCatalogItemInput,
} from '../utils/inventory';
import { ItemCaptureFields } from './ItemCaptureFields';
import { OptionSelect } from './OptionSelect';

interface CatalogManagerProps {
  workspace: Workspace;
  stations: Workstation[];
  items: InventoryItem[];
  initialFilterStation?: string;
  initialEditItemId?: string | null;
  onConsumeInitialEditItem?: () => void;
  onGoToWorkstations?: () => void;
  migratedPacksNotice?: PacksUnitMigrationRecord[];
  migratedPacksIds?: string[];
  packsMigrationState?: PacksMigrationState;
  onRetryPacksMigration?: () => void;
  onDismissMigratedPacksNotice?: () => void;
}

export function CatalogManager({
  workspace,
  stations,
  items,
  initialFilterStation = 'all',
  initialEditItemId = null,
  onConsumeInitialEditItem,
  onGoToWorkstations,
  migratedPacksNotice = [],
  migratedPacksIds = [],
  packsMigrationState,
  onRetryPacksMigration,
  onDismissMigratedPacksNotice,
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
  const [stationId, setStationId] = useState<StationId>(
    stations[0]?.id ?? UNASSIGNED_STATION_ID,
  );
  const [unit, setUnit] = useState('und');
  const [minStock, setMinStock] = useState(5);
  const [targetStock, setTargetStock] = useState(15);
  const [inputType, setInputType] = useState<CaptureInputType>('count');
  const [packSizeInput, setPackSizeInput] = useState('8');
  const [packLabel, setPackLabel] = useState('paquete');
  const [unitLabel, setUnitLabel] = useState('und');
  const [capacityInput, setCapacityInput] = useState('5');
  const [allowClosedContainers, setAllowClosedContainers] = useState(false);

  const [confirmedThresholds, setConfirmedThresholds] = useState<Record<string, string>>(() =>
    readConfirmedPacksThresholds(workspace.id),
  );

  useEffect(() => {
    setConfirmedThresholds(readConfirmedPacksThresholds(workspace.id));
  }, [workspace.id, items]);

  const migratedPacksIdSet = useMemo(() => new Set(migratedPacksIds), [migratedPacksIds]);
  const packsThresholdReviewItems = useMemo(
    () => findPacksItemsNeedingThresholdReview(items, confirmedThresholds, migratedPacksIdSet),
    [items, confirmedThresholds, migratedPacksIdSet],
  );

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
  const unassignedCount = useMemo(
    () => scopedStatusItems.filter((i) => i.station === UNASSIGNED_STATION_ID).length,
    [scopedStatusItems],
  );

  const filteredItems = scopedStatusItems.filter((it) =>
    stationFilter === 'all' ? true : it.station === stationFilter,
  );

  const unitOptions = useMemo(() => getUnitSelectOptions(), []);
  const levelUnitOptions = useMemo(() => getLevelUnitSelectOptions(), []);

  const parsedPackSize = useMemo(
    () => parseCaptureDecimalInput(packSizeInput),
    [packSizeInput],
  );

  const parsedCapacity = useMemo(
    () => parseCaptureDecimalInput(capacityInput),
    [capacityInput],
  );

  const effectivePackLooseUnit = unitLabel.trim() || 'und';
  const effectiveFormUnit =
    inputType === 'packs' ? effectivePackLooseUnit : unit.trim() || 'und';

  const formValidation = useMemo(
    () =>
      validateCatalogItemInput({
        name,
        unit: effectiveFormUnit,
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
      effectiveFormUnit,
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
    setStationId(
      stationFilter === 'all'
        ? (stations[0]?.id ?? UNASSIGNED_STATION_ID)
        : stationFilter,
    );
    setUnit('und');
    setMinStock(5);
    setTargetStock(15);
    setInputType('count');
    setPackSizeInput('8');
    setPackLabel('paquete');
    setUnitLabel('und');
    setCapacityInput('5');
    setAllowClosedContainers(false);
    setErrorMsg(null);
    setActionFeedback(null);
    setShowForm(true);
  };

  const openEditForm = useCallback((item: InventoryItem) => {
    const mode = getItemInputType(item);
    const nextUnitLabel = item.unitLabel ?? (item.unit || 'und');
    setEditingItem(item);
    setName(item.name);
    setStationId(item.station || UNASSIGNED_STATION_ID);
    setUnit(mode === 'packs' ? nextUnitLabel.trim() || 'und' : item.unit);
    setMinStock(item.minStock);
    setTargetStock(item.targetStock);
    setInputType(mode);
    setPackSizeInput(typeof item.packSize === 'number' ? String(item.packSize) : '8');
    setPackLabel(item.packLabel ?? 'paquete');
    setUnitLabel(nextUnitLabel);
    setCapacityInput(typeof item.capacity === 'number' ? String(item.capacity) : '5');
    setAllowClosedContainers(Boolean(item.allowClosedContainers));
    setErrorMsg(null);
    setActionFeedback(null);
    setShowForm(true);
  }, []);

  useEffect(() => {
    if (!initialEditItemId) return;
    const match = items.find((it) => it.id === initialEditItemId);
    if (!match) return;
    openEditForm(match);
    onConsumeInitialEditItem?.();
  }, [initialEditItemId, items, openEditForm, onConsumeInitialEditItem]);

  const handleInputTypeChange = (nextType: CaptureInputType) => {
    setInputType(nextType);
    if (nextType === 'packs') {
      setUnit(unitLabel.trim() || 'und');
    } else if (nextType === 'level' && isInvalidLevelUnit(unit)) {
      setUnit('L');
    }
    if (errorMsg) setErrorMsg(null);
  };

  const handleUnitLabelChange = (nextUnitLabel: string) => {
    setUnitLabel(nextUnitLabel);
    if (inputType === 'packs') {
      setUnit(nextUnitLabel.trim() || 'und');
    }
    if (errorMsg) setErrorMsg(null);
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
      const cleanUnit =
        inputType === 'packs' ? unitLabel.trim() || 'und' : unit.trim();
      const capturePayload = buildItemCaptureFields({
        inputType,
        packSizeInput,
        packLabel,
        unitLabel,
        capacityInput,
        allowClosedContainers,
      });

      if (editingItem) {
        const previousStation = stations.find((s) => s.id === editingItem.station);
        const nextStation = stations.find((s) => s.id === stationId);
        await updateInventoryItem(
          editingItem.id,
          {
            station: stationId,
            name: cleanName,
            unit: cleanUnit,
            minStock,
            targetStock,
            active: editingItem.active,
            ...capturePayload,
          },
          {
            previousStation,
            nextStation,
            allItems: items,
          },
        );
        if (inputType === 'packs') {
          setConfirmedThresholds(
            confirmPacksThresholdSignature(workspace.id, {
              ...editingItem,
              station: stationId,
              name: cleanName,
              unit: cleanUnit,
              minStock,
              targetStock,
              ...capturePayload,
            }),
          );
        }
      } else {
        const targetStationObj = stations.find((s) => s.id === stationId);
        await createInventoryItem(
          workspace,
          targetStationObj,
          {
            station: stationId,
            name: cleanName,
            unit: cleanUnit,
            minStock,
            targetStock,
            sortOrder: (items.length + 1) * 10,
            ...capturePayload,
          },
          items,
        );
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
      await setInventoryItemActive(confirmArchive.id, false, {
        station: stations.find((s) => s.id === confirmArchive.station),
        stationId: confirmArchive.station,
        allItems: items,
      });
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
      unit: getEffectiveItemUnit(item),
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
      await setInventoryItemActive(item.id, true, {
        station: stations.find((s) => s.id === item.station),
        stationId: item.station,
        allItems: items,
      });
    } catch {
      setActionFeedback('No se pudo reactivar el insumo. Intenta nuevamente.');
    } finally {
      setSubmitting(false);
    }
  };

  const misconfiguredActiveCount = activeItems.filter((it) =>
    hasTargetBelowMin(it.minStock, it.targetStock),
  ).length;

  const invalidLevelActiveItems = activeItems.filter(
    (it) => getItemInputType(it) === 'level' && isInvalidLevelUnit(it.unit),
  );

  const showPacksSwitchReviewWarning = Boolean(
    editingItem &&
      inputType === 'packs' &&
      (getItemInputType(editingItem) !== 'packs' ||
        editingItem.unit.trim() !== effectivePackLooseUnit),
  );

  const showLevelUnitSwitchWarning = Boolean(
    editingItem &&
      inputType === 'level' &&
      isInvalidLevelUnit(editingItem.unit) &&
      !isInvalidLevelUnit(unit),
  );

  const packsEquivalentMin =
    inputType === 'packs' && Number.isInteger(parsedPackSize) && parsedPackSize > 1
      ? formatPackEquivalent(minStock, parsedPackSize, packLabel)
      : '';
  const packsEquivalentTarget =
    inputType === 'packs' && Number.isInteger(parsedPackSize) && parsedPackSize > 1
      ? formatPackEquivalent(targetStock, parsedPackSize, packLabel)
      : '';

  const levelFractionMin =
    inputType === 'level' && Number.isFinite(parsedCapacity) && parsedCapacity > 0
      ? formatContainerFractionLabel(minStock, parsedCapacity, effectiveFormUnit)
      : '';
  const levelFractionTarget =
    inputType === 'level' && Number.isFinite(parsedCapacity) && parsedCapacity > 0
      ? formatContainerFractionLabel(targetStock, parsedCapacity, effectiveFormUnit)
      : '';
  const levelFractionOneUnit =
    inputType === 'level' &&
    Number.isFinite(parsedCapacity) &&
    parsedCapacity > 0 &&
    minStock !== 1 &&
    targetStock !== 1
      ? formatContainerFractionLabel(1, parsedCapacity, effectiveFormUnit)
      : '';

  const minIdealUnitLabel =
    inputType === 'packs'
      ? pluralizeSpanishLabel(effectivePackLooseUnit, 2)
      : effectiveFormUnit;

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-orange-600">
            Configuración · {activeItems.length} activos
            {archivedItems.length > 0 ? ` · ${archivedItems.length} archivados` : ''}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-1">
            Insumos
          </h1>
          <p className="text-sm text-stone-600 mt-1">
            Crea y edita todos tus insumos aquí. Luego asigna cada producto a su puesto desde Puestos de Trabajo.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openCreateForm}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Nuevo insumo
          </button>
        </div>
      </div>

      {packsMigrationState &&
        (packsMigrationState.status === 'running' || packsMigrationState.status === 'error') && (
          <div
            role={packsMigrationState.status === 'error' ? 'alert' : 'status'}
            className={`px-4 py-3.5 rounded-2xl border flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm ${
              packsMigrationState.status === 'error'
                ? 'bg-red-50 border-red-200 text-red-950'
                : 'bg-sky-50 border-sky-200 text-sky-950'
            }`}
          >
            <div className="space-y-0.5 min-w-0">
              <p className="font-semibold">
                Actualizando unidades por paquetes ·{' '}
                <span className="font-mono tabular-nums">
                  {packsMigrationState.processed} de {packsMigrationState.total} procesados
                </span>
              </p>
              {packsMigrationState.errorMessage && (
                <p className="text-xs text-red-800">{packsMigrationState.errorMessage}</p>
              )}
            </div>
            {packsMigrationState.status === 'error' && onRetryPacksMigration && (
              <button
                type="button"
                onClick={onRetryPacksMigration}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reintentar
              </button>
            )}
          </div>
        )}

      {migratedPacksNotice.length > 0 && (
        <div
          role="status"
          className="px-4 py-3.5 rounded-2xl bg-sky-50 border border-sky-200 flex items-start justify-between gap-3 text-xs sm:text-sm text-sky-950"
        >
          <div className="space-y-1">
            <p className="font-semibold">
              Se actualizó la unidad base a su unidad suelta en {migratedPacksNotice.length}{' '}
              {migratedPacksNotice.length === 1 ? 'insumo por paquetes' : 'insumos por paquetes'} (sin cambiar las cantidades guardadas):
            </p>
            <ul className="list-disc pl-5 text-xs space-y-0.5">
              {migratedPacksNotice.map((rec) => (
                <li key={rec.id}>
                  <strong>{rec.name}</strong>: &ldquo;{rec.oldUnit}&rdquo; → &ldquo;{rec.newUnit}&rdquo;. Revisa que su mínimo e ideal estén en {pluralizeSpanishLabel(rec.newUnit, 2)}.
                </li>
              ))}
            </ul>
          </div>
          {onDismissMigratedPacksNotice && (
            <button
              type="button"
              onClick={onDismissMigratedPacksNotice}
              aria-label="Cerrar aviso de migración"
              className="min-w-[36px] min-h-[36px] flex items-center justify-center text-sky-700 hover:bg-sky-100 rounded-lg shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {packsThresholdReviewItems.length > 0 && (
        <div
          role="status"
          className="px-4 py-4 rounded-2xl bg-amber-50 border border-amber-200 space-y-3"
        >
          <div className="flex items-start gap-2.5 text-xs sm:text-sm text-amber-950">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">
                Confirma mínimo e ideal de insumos por paquetes ({packsThresholdReviewItems.length})
              </p>
              <p className="text-xs text-amber-900 mt-0.5">
                Verifica que el mínimo y el ideal estén escritos en unidades sueltas y no en paquetes.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {packsThresholdReviewItems.map((item) => {
              const packSize = item.packSize ?? 1;
              const packLabel = item.packLabel || 'paquete';
              const minEq = packSize > 1 ? formatPackEquivalent(item.minStock, packSize, packLabel) : '';
              const targetEq =
                packSize > 1 ? formatPackEquivalent(item.targetStock, packSize, packLabel) : '';

              return (
                <div
                  key={item.id}
                  className="bg-white border border-amber-200 rounded-xl px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-stone-900 truncate">{item.name}</p>
                    <p className="text-xs text-stone-600 font-mono tabular-nums">
                      Mín: {formatItemStockDisplay(item.minStock, item)}
                      {minEq ? ` (${minEq})` : ''} · Ideal: {formatItemStockDisplay(item.targetStock, item)}
                      {targetEq ? ` (${targetEq})` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmedThresholds(confirmPacksThresholdSignature(workspace.id, item))
                      }
                      className="min-h-[38px] inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Confirmar
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditForm(item)}
                      className="min-h-[38px] inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-stone-800 bg-white border border-stone-200 rounded-lg hover:bg-stone-100 cursor-pointer"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      Editar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {invalidLevelActiveItems.length > 0 && (
        <div
          role="status"
          className="px-4 py-3 rounded-2xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs sm:text-sm text-amber-950"
        >
          <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <span>
            Hay <strong>{invalidLevelActiveItems.length}</strong>{' '}
            {invalidLevelActiveItems.length === 1
              ? 'insumo de tipo Nivel (barra)'
              : 'insumos de tipo Nivel (barra)'}{' '}
            con unidad <strong>&ldquo;{invalidLevelActiveItems[0].unit}&rdquo;</strong> (
            {invalidLevelActiveItems.map((it) => it.name).join(', ')}). Edítalos para usar una medida real (<strong>L, ml, kg o g</strong>).
          </span>
        </div>
      )}

      {activeItems.length > 0 && stations.length === 0 && onGoToWorkstations && (
        <div className="px-4 py-3.5 rounded-2xl bg-orange-50 border border-orange-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs sm:text-sm text-orange-950">
          <span>
            <strong>Siguiente paso:</strong> ya tienes insumos creados. Crea tus puestos de trabajo para asignarlos y generar sus códigos QR.
          </span>
          <button
            type="button"
            onClick={onGoToWorkstations}
            className="min-h-[40px] px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Ir a Puestos y QR
          </button>
        </div>
      )}

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
            className={`min-h-[44px] sm:min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              stationFilter === 'all'
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            Todos ({scopedStatusItems.length})
          </button>
          {(unassignedCount > 0 ||
            stations.length === 0 ||
            stationFilter === UNASSIGNED_STATION_ID) && (
            <button
              type="button"
              onClick={() => setStationFilter(UNASSIGNED_STATION_ID)}
              className={`min-h-[44px] sm:min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                stationFilter === UNASSIGNED_STATION_ID
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Sin asignar ({unassignedCount})
            </button>
          )}
          {stations.map((st) => {
            const count = scopedStatusItems.filter((i) => i.station === st.id).length;
            return (
              <button
                key={st.id}
                type="button"
                onClick={() => setStationFilter(st.id)}
                className={`min-h-[44px] sm:min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
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
            className={`min-h-[44px] sm:min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
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
            className={`min-h-[44px] sm:min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
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
              {statusFilter === 'archived'
                ? 'No hay insumos archivados en este filtro.'
                : activeItems.length === 0
                  ? 'Aún no hay insumos creados. Paso 1: crea tus insumos con unidad, mínimo, ideal y tipo de captura.'
                  : 'No hay insumos activos en esta vista.'}
            </p>
            {statusFilter === 'active' && (
              <button
                type="button"
                onClick={openCreateForm}
                className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 cursor-pointer"
              >
                + Crear primer insumo
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Mobile Compact List (< sm) */}
            <div className="sm:hidden divide-y divide-stone-200">
              {filteredItems.map((item) => {
                const targetLow = hasTargetBelowMin(item.minStock, item.targetStock);
                const mode = getItemInputType(item);
                const effectiveUnit = getEffectiveItemUnit(item);
                const invalidLevelUnit = mode === 'level' && isInvalidLevelUnit(item.unit);
                const stationLabel =
                  item.station === UNASSIGNED_STATION_ID
                    ? 'Sin asignar'
                    : (stationNameMap.get(item.station) ?? 'Sin asignar');
                const modeSummary =
                  mode === 'packs' && item.packSize
                    ? `${item.packLabel || 'paquete'} de ${item.packSize} ${pluralizeSpanishLabel(effectiveUnit, item.packSize)}`
                    : mode === 'level' && item.capacity
                      ? `Nivel (envase ${item.capacity} ${effectiveUnit}${item.allowClosedContainers ? ' + cerrados' : ''})`
                      : 'Conteo (− / +)';
                return (
                  <div key={item.id} className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-stone-900 truncate">{item.name}</p>
                      <p className="text-xs text-stone-500 truncate">
                        <span
                          className={
                            stationLabel === 'Sin asignar' ? 'text-amber-700 font-semibold' : undefined
                          }
                        >
                          {stationLabel}
                        </span>{' '}
                        · {effectiveUnit} · {modeSummary}
                      </p>
                      <p className="text-xs font-mono tabular-nums text-stone-600 mt-0.5">
                        Mín: {formatItemStockDisplay(item.minStock, item)} · Ideal: {formatItemStockDisplay(item.targetStock, item)}
                      </p>
                      {invalidLevelUnit && (
                        <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 mt-1">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          Unidad &ldquo;{item.unit}&rdquo; no válida para Nivel (usa L, ml, kg o g)
                        </p>
                      )}
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
                        className="min-w-[44px] min-h-[44px] flex items-center justify-center text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg cursor-pointer"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {item.active ? (
                        <button
                          type="button"
                          onClick={() => setConfirmArchive(item)}
                          aria-label={`Archivar ${item.name}`}
                          title="Archivar insumo"
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-stone-500 hover:text-amber-700 hover:bg-amber-50 rounded-lg cursor-pointer"
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
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-emerald-700 hover:bg-emerald-50 rounded-lg cursor-pointer"
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
                    const effectiveUnit = getEffectiveItemUnit(item);
                    const invalidLevelUnit = mode === 'level' && isInvalidLevelUnit(item.unit);
                    const captureText =
                      mode === 'packs' && item.packSize
                        ? `Paquetes: 1 ${item.packLabel || 'paquete'} = ${item.packSize} ${pluralizeSpanishLabel(effectiveUnit, item.packSize)}`
                        : mode === 'level' && item.capacity
                          ? `Nivel (0 a ${item.capacity} ${effectiveUnit}${item.allowClosedContainers ? ' + cerrados' : ''})`
                          : 'Conteo';
                    return (
                      <tr key={item.id} className="hover:bg-stone-50/80 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-medium text-stone-900">{item.name}</div>
                          {invalidLevelUnit && (
                            <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 mt-0.5">
                              <AlertTriangle className="w-3 h-3 shrink-0" />
                              Cambia &ldquo;{item.unit}&rdquo; a L, ml, kg o g
                            </div>
                          )}
                          {targetLow && (
                            <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 mt-0.5">
                              <AlertTriangle className="w-3 h-3 shrink-0" />
                              Ideal menor que mínimo
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-stone-600">
                          {item.station === UNASSIGNED_STATION_ID ||
                          !stationNameMap.has(item.station) ? (
                            <span className="text-amber-700 font-medium">Sin asignar</span>
                          ) : (
                            stationNameMap.get(item.station)
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-stone-600">{captureText}</td>
                        <td className="py-3 px-4 text-stone-600 font-mono text-xs">{effectiveUnit}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-stone-800">
                          {formatItemStockDisplay(item.minStock, item)}
                        </td>
                        <td
                          className={`py-3 px-4 text-right font-mono tabular-nums ${
                            targetLow ? 'text-amber-800 font-semibold' : 'text-stone-600'
                          }`}
                        >
                          {formatItemStockDisplay(item.targetStock, item)}
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
      {showForm && (
        <div className="fixed inset-0 z-50 bg-stone-950/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-stone-200 rounded-2xl w-full max-w-lg max-h-[90dvh] flex flex-col overflow-hidden shadow-2xl min-w-0 animate-tf-fade-up">
            <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-stone-100 flex items-center justify-between shrink-0">
              <h2 className="font-display text-lg font-bold text-stone-900">
                {editingItem ? 'Editar insumo' : 'Agregar nuevo insumo'}
              </h2>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                aria-label="Cerrar ventana"
                className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center text-stone-400 hover:text-stone-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
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

              {showPacksSwitchReviewWarning && editingItem && (
                <div
                  role="status"
                  className="p-3 text-xs text-amber-950 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <span>
                    La unidad base ahora es <strong>{pluralizeSpanishLabel(effectivePackLooseUnit, 2)}</strong> (antes{' '}
                    &ldquo;{editingItem.unit}&rdquo;). Revisa el mínimo y el ideal para confirmar que están expresados en{' '}
                    {pluralizeSpanishLabel(effectivePackLooseUnit, 2)}.
                  </span>
                </div>
              )}

              {inputType === 'level' && isInvalidLevelUnit(effectiveFormUnit) && (
                <div
                  role="alert"
                  className="p-3 text-xs text-amber-950 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <span>
                    Este insumo tenía unidad <strong>&ldquo;{effectiveFormUnit}&rdquo;</strong>. El tipo Nivel (barra) requiere una medida real (<strong>L, ml, kg o g</strong>); selecciona una unidad válida y revisa mínimo, ideal y capacidad.
                  </span>
                </div>
              )}

              {showLevelUnitSwitchWarning && editingItem && (
                <div
                  role="status"
                  className="p-3 text-xs text-amber-950 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <span>
                    Se cambió la unidad desde &ldquo;{editingItem.unit}&rdquo; a <strong>{effectiveFormUnit}</strong> porque Nivel requiere una medida real. Revisa mínimo, ideal y capacidad.
                  </span>
                </div>
              )}

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
                  className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
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
                    className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
                  >
                    <option value={UNASSIGNED_STATION_ID}>
                      Sin asignar (asignar después en Puestos)
                    </option>
                    {stations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="min-w-0">
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Unidad base de inventario <span className="text-red-600">*</span>
                  </label>
                  <OptionSelect
                    value={effectiveFormUnit}
                    options={inputType === 'level' ? levelUnitOptions : unitOptions}
                    maxLength={MAX_UNIT_LENGTH}
                    required
                    disabled={inputType === 'packs'}
                    disabledNote={
                      inputType === 'packs'
                        ? `Se cuenta en ${pluralizeSpanishLabel(effectivePackLooseUnit, 2)}`
                        : undefined
                    }
                    selectAriaLabel="Unidad base de inventario"
                    customAriaLabel="Escribe la unidad de inventario"
                    customPlaceholder={
                      inputType === 'level' ? 'Ej: oz, galón' : 'Ej: galón, ml, atado'
                    }
                    onChange={(val) => {
                      setUnit(val);
                      if (errorMsg) setErrorMsg(null);
                    }}
                  />
                </div>
              </div>

              {/* Capture type selector */}
              <ItemCaptureFields
                inputType={inputType}
                onInputTypeChange={handleInputTypeChange}
                unit={effectiveFormUnit}
                packSizeInput={packSizeInput}
                onPackSizeInputChange={setPackSizeInput}
                packLabel={packLabel}
                onPackLabelChange={setPackLabel}
                unitLabel={unitLabel}
                onUnitLabelChange={handleUnitLabelChange}
                capacityInput={capacityInput}
                onCapacityInputChange={setCapacityInput}
                allowClosedContainers={allowClosedContainers}
                onAllowClosedContainersChange={setAllowClosedContainers}
                onClearError={() => {
                  if (errorMsg) setErrorMsg(null);
                }}
              />

              <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Mínimo ({minIdealUnitLabel})
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    required
                    value={minStock}
                    onChange={(e) => setMinStock(parseFloat(e.target.value) || 0)}
                    className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm font-mono tabular-nums border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  {packsEquivalentMin && (
                    <p className="text-[11px] font-medium text-stone-600 mt-1">
                      {packsEquivalentMin}
                    </p>
                  )}
                  {levelFractionMin && (
                    <p className="text-[11px] font-medium text-stone-600 mt-1">
                      {levelFractionMin}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Ideal ({minIdealUnitLabel})
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    required
                    value={targetStock}
                    onChange={(e) => setTargetStock(parseFloat(e.target.value) || 0)}
                    className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm font-mono tabular-nums border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  {packsEquivalentTarget && (
                    <p className="text-[11px] font-medium text-stone-600 mt-1">
                      {packsEquivalentTarget}
                    </p>
                  )}
                  {levelFractionTarget && (
                    <p className="text-[11px] font-medium text-stone-600 mt-1">
                      {levelFractionTarget}
                    </p>
                  )}
                </div>
              </div>
              {levelFractionOneUnit && (
                <p className="text-[11px] text-stone-500 -mt-2">
                  Referencia del envase: {levelFractionOneUnit}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="min-h-[44px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 disabled:opacity-60 cursor-pointer"
                >
                  {submitting ? 'Guardando...' : 'Guardar insumo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Archive Confirmation Modal */}
      {confirmArchive && (
        <div className="fixed inset-0 z-50 bg-stone-950/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-stone-200 rounded-2xl w-full max-w-sm max-h-[90dvh] overflow-y-auto p-5 sm:p-6 space-y-4 shadow-2xl animate-tf-fade-up">
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
                className="min-h-[44px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleArchive}
                className="min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-amber-600 rounded-xl hover:bg-amber-700 disabled:opacity-60 cursor-pointer"
              >
                {submitting ? 'Archivando...' : 'Archivar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

