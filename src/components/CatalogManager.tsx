import { useEffect, useState, type FormEvent } from 'react';
import { Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import {
  MAX_NAME_LENGTH,
  MAX_UNIT_LENGTH,
  UNIT_OPTIONS,
} from '../constants';
import {
  createInventoryItem,
  deleteInventoryItem,
  seedDefaultWorkstationsAndCatalog,
  updateInventoryItem,
} from '../services/inventoryService';
import type { InventoryItem, StationId, Workspace, Workstation } from '../types';

interface CatalogManagerProps {
  workspace: Workspace;
  stations: Workstation[];
  items: InventoryItem[];
  initialFilterStation?: string;
}

export function CatalogManager({
  workspace,
  stations,
  items,
  initialFilterStation = 'all',
}: CatalogManagerProps) {
  const [stationFilter, setStationFilter] = useState<'all' | StationId>(initialFilterStation);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<InventoryItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [stationId, setStationId] = useState<StationId>(stations[0]?.id ?? 'mesera');
  const [unit, setUnit] = useState('und');
  const [minStock, setMinStock] = useState(5);
  const [targetStock, setTargetStock] = useState(15);

  useEffect(() => {
    setStationFilter(initialFilterStation);
  }, [initialFilterStation]);

  const stationNameMap = new Map(stations.map((s) => [s.id, s.name]));

  const filteredItems = items.filter((it) =>
    stationFilter === 'all' ? true : it.station === stationFilter,
  );

  const openCreateForm = () => {
    setEditingItem(null);
    setName('');
    setStationId(stationFilter === 'all' ? (stations[0]?.id ?? 'mesera') : stationFilter);
    setUnit('und');
    setMinStock(5);
    setTargetStock(15);
    setErrorMsg(null);
    setShowForm(true);
  };

  const openEditForm = (item: InventoryItem) => {
    setEditingItem(item);
    setName(item.name);
    setStationId(item.station);
    setUnit(item.unit);
    setMinStock(item.minStock);
    setTargetStock(item.targetStock);
    setErrorMsg(null);
    setShowForm(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg('Escribe el nombre del insumo.');
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      if (editingItem) {
        await updateInventoryItem(editingItem.id, {
          station: stationId,
          name,
          unit,
          minStock,
          targetStock,
          active: editingItem.active,
        });
      } else {
        const targetStationObj = stations.find((s) => s.id === stationId);
        await createInventoryItem(workspace, targetStationObj, {
          station: stationId,
          name,
          unit,
          minStock,
          targetStock,
          sortOrder: (items.length + 1) * 10,
        });
      }
      setShowForm(false);
    } catch {
      setErrorMsg('No se pudo guardar el insumo. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setSubmitting(true);
    try {
      await deleteInventoryItem(confirmDelete.id);
      setConfirmDelete(null);
    } catch {
      setErrorMsg('No se pudo eliminar el insumo.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSeedDefaults = async () => {
    setSeeding(true);
    try {
      await seedDefaultWorkstationsAndCatalog(workspace);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Configuración del Jefe · {items.length} insumos totales
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mt-1">
            Catálogo de Insumos
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Administra los productos que se controlan en cada puesto de trabajo y su stock mínimo para alertas de compra.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {items.length === 0 && stations.length === 0 && (
            <button
              type="button"
              onClick={handleSeedDefaults}
              disabled={seeding}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              {seeding ? 'Cargando...' : 'Cargar catálogo base The Fire'}
            </button>
          )}
          <button
            type="button"
            onClick={openCreateForm}
            disabled={stations.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Nuevo insumo
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setStationFilter('all')}
          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            stationFilter === 'all'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Todos ({items.length})
        </button>
        {stations.map((st) => {
          const count = items.filter((i) => i.station === st.id).length;
          return (
            <button
              key={st.id}
              type="button"
              onClick={() => setStationFilter(st.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                stationFilter === st.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {st.name} ({count})
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredItems.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm font-medium text-slate-700">
              No hay insumos en esta vista.
            </p>
            {stations.length > 0 && (
              <button
                type="button"
                onClick={openCreateForm}
                className="text-sm font-semibold text-teal-700 hover:text-teal-800 cursor-pointer"
              >
                + Agregar insumo
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">Insumo</th>
                  <th className="py-3 px-4">Puesto de trabajo</th>
                  <th className="py-3 px-4">Unidad</th>
                  <th className="py-3 px-4 text-right">Stock mínimo</th>
                  <th className="py-3 px-4 text-right">Stock ideal</th>
                  <th className="py-3 px-4 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredItems.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-medium text-slate-900">{item.name}</td>
                    <td className="py-3 px-4 text-slate-600">
                      {stationNameMap.get(item.station) ?? item.station}
                    </td>
                    <td className="py-3 px-4 text-slate-600 font-mono text-xs">{item.unit}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-800">
                      {item.minStock}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600">
                      {item.targetStock}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEditForm(item)}
                          aria-label={`Editar ${item.name}`}
                          className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(item)}
                          aria-label={`Eliminar ${item.name}`}
                          className="p-2 text-slate-500 hover:text-red-700 hover:bg-red-50 rounded-lg cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-slate-900">
                {editingItem ? 'Editar insumo' : 'Agregar nuevo insumo'}
              </h2>
              <button
                type="button"
                onClick={() => setShowForm(false)}
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
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nombre del insumo
                </label>
                <input
                  type="text"
                  required
                  maxLength={MAX_NAME_LENGTH}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej: Pulpa de maracuyá"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Puesto de trabajo
                  </label>
                  <select
                    value={stationId}
                    onChange={(e) => setStationId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 bg-white"
                  >
                    {stations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Unidad de medida
                  </label>
                  <input
                    type="text"
                    list="unit-suggestions"
                    required
                    maxLength={MAX_UNIT_LENGTH}
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  <datalist id="unit-suggestions">
                    {UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Stock mínimo (alerta compra)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    required
                    value={minStock}
                    onChange={(e) => setMinStock(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Stock ideal (objetivo)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    required
                    value={targetStock}
                    onChange={(e) => setTargetStock(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-sm font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                >
                  {submitting ? 'Guardando...' : 'Guardar insumo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-6 space-y-4 shadow-xl">
            <h3 className="font-display text-lg font-bold text-slate-900">
              Eliminar insumo
            </h3>
            <p className="text-sm text-slate-600">
              ¿Seguro que deseas eliminar <span className="font-semibold text-slate-900">{confirmDelete.name}</span> del catálogo? Los reportes de días pasados conservarán su registro histórico.
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
                onClick={handleDelete}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-60 cursor-pointer"
              >
                {submitting ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
