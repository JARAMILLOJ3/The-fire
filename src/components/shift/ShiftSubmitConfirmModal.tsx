import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { EntryAnomaly } from '../../utils/inventory';

interface ShiftSubmitConfirmModalProps {
  open: boolean;
  mode: 'opening' | 'closing';
  stationName: string;
  totalItems: number;
  confirmedMatchCount: number;
  adjustedCount: number;
  zeroCount: number;
  naCount: number;
  anomalies: EntryAnomaly[];
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ShiftSubmitConfirmModal({
  open,
  mode,
  stationName,
  totalItems,
  confirmedMatchCount,
  adjustedCount,
  zeroCount,
  naCount,
  anomalies,
  saving,
  onCancel,
  onConfirm,
}: ShiftSubmitConfirmModalProps) {
  if (!open) return null;

  const isOpening = mode === 'opening';
  const activeCounted = Math.max(0, totalItems - naCount);
  const warningAnomalies = anomalies.filter((a) => a.severity !== 'info');
  const infoAnomalies = anomalies.filter((a) => a.severity === 'info');

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shift-confirm-title"
    >
      <div className="w-full sm:max-w-md max-h-[90dvh] flex flex-col bg-white border border-stone-200 rounded-t-3xl sm:rounded-2xl overflow-hidden shadow-2xl animate-tf-fade-up">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <CheckCircle2 className="w-5 h-5 text-orange-600 shrink-0" />
            <h2
              id="shift-confirm-title"
              className="font-display text-lg font-bold text-stone-900 truncate"
            >
              {isOpening ? 'Confirmar apertura del día' : 'Enviar cierre al jefe'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            aria-label="Cancelar confirmación"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-stone-500 hover:bg-stone-100 hover:text-stone-900 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-4 overflow-y-auto flex-1 min-h-0">
          <p className="text-sm text-stone-700 leading-relaxed">
            {isOpening ? (
              <>
                Vas a guardar la apertura de <strong className="text-stone-900">{stationName}</strong> con{' '}
                <strong className="font-mono tabular-nums text-stone-900">{activeCounted}</strong> insumos contados
                {zeroCount > 0 && (
                  <>
                    {' '}
                    (<strong className="font-mono tabular-nums text-stone-900">{zeroCount}</strong> en cero)
                  </>
                )}
                {naCount > 0 && (
                  <>
                    {' '}
                    y <strong className="font-mono tabular-nums text-stone-900">{naCount}</strong> marcados como no aplica
                  </>
                )}
                . ¿Confirmar?
              </>
            ) : (
              <>
                Vas a enviar el cierre de <strong className="text-stone-900">{stationName}</strong> con{' '}
                <strong className="font-mono tabular-nums text-stone-900">{activeCounted}</strong> insumos contados
                {zeroCount > 0 && (
                  <>
                    {' '}
                    (<strong className="font-mono tabular-nums text-red-700">{zeroCount}</strong> en cero)
                  </>
                )}
                {naCount > 0 && (
                  <>
                    {' '}
                    y <strong className="font-mono tabular-nums text-stone-900">{naCount}</strong> que no aplican hoy
                  </>
                )}
                . ¿Enviar ahora?
              </>
            )}
          </p>

          {(confirmedMatchCount > 0 || adjustedCount > 0) && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="px-3 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900">
                <p className="text-emerald-700 font-medium">Coincidieron con ayer</p>
                <p className="font-mono tabular-nums text-base font-bold mt-0.5">
                  {confirmedMatchCount}
                </p>
              </div>
              <div className="px-3 py-2.5 rounded-xl bg-orange-50 border border-orange-200 text-orange-950">
                <p className="text-orange-700 font-medium">Corregidos hoy</p>
                <p className="font-mono tabular-nums text-base font-bold mt-0.5">
                  {adjustedCount}
                </p>
              </div>
            </div>
          )}

          {warningAnomalies.length > 0 && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-amber-950">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>
                  Revisa {warningAnomalies.length}{' '}
                  {warningAnomalies.length === 1 ? 'cantidad inusual' : 'cantidades inusuales'}
                </span>
              </div>
              <ul className="text-xs text-amber-900 space-y-1 list-disc pl-4">
                {warningAnomalies.slice(0, 4).map((a) => (
                  <li key={`${a.itemId}-${a.type}`}>
                    <strong>{a.itemName}:</strong> {a.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {infoAnomalies.length > 0 && (
            <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-sky-950">
                <Info className="w-4 h-4 text-sky-600 shrink-0" />
                <span>
                  Nota de nivel ({infoAnomalies.length}{' '}
                  {infoAnomalies.length === 1 ? 'insumo' : 'insumos'})
                </span>
              </div>
              <ul className="text-xs text-sky-900 space-y-1 list-disc pl-4">
                {infoAnomalies.slice(0, 4).map((a) => (
                  <li key={`${a.itemId}-${a.type}`}>
                    <strong>{a.itemName}:</strong> {a.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-2.5 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="flex-1 min-h-[46px] px-4 py-2.5 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 disabled:opacity-50 cursor-pointer"
            >
              Volver a revisar
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={saving}
              className="flex-1 min-h-[46px] px-4 py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 cursor-pointer"
            >
              {saving
                ? isOpening
                  ? 'Guardando...'
                  : 'Enviando...'
                : isOpening
                  ? 'Sí, guardar apertura'
                  : 'Sí, enviar al jefe'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
