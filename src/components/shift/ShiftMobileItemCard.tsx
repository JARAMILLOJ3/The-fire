import { memo, useCallback } from 'react';
import { AlertTriangle, Ban, Check, CheckCircle2, Clock, Info } from 'lucide-react';
import type { DraftEntryRow, InventoryItem } from '../../types';
import {
  detectEntryAnomalies,
  formatItemStockDisplay,
  formatPreviousClosingForItem,
  formatPurchaseRecommendation,
  getEffectiveItemUnit,
  getOpeningRowState,
  getStockLevel,
  getStockLevelMeta,
  getSuggestedPurchase,
  sanitizeStockQuantity,
} from '../../utils/inventory';
import { QuantityCaptureControl } from './QuantityCaptureControl';

export interface ShiftItemRowProps {
  item: InventoryItem;
  row: DraftEntryRow;
  isLocked: boolean;
  isWorkerOpeningPhase: boolean;
  isWorkerClosingPhase: boolean;
  draftMode: 'opening' | 'closing';
  onCommitField: (itemId: string, field: 'opening' | 'added' | 'closing', nextValue: number) => void;
  onClearField: (itemId: string, field: 'opening' | 'added' | 'closing') => void;
  onConfirmSingleOpening: (itemId: string) => void;
  onMarkZeroExplicit: (itemId: string, field: 'opening' | 'closing') => void;
  onToggleNotApplicable: (itemId: string) => void;
}

export function buildWorkerClosingReferenceText(
  row: DraftEntryRow,
  item: InventoryItem,
): string {
  if (row.notApplicable) {
    return 'Marcado como no aplica hoy';
  }
  const addedLabel = row.added > 0 ? formatItemStockDisplay(row.added, item) : '0';
  if (row.hasOpening) {
    return `Hoy empezó con ${formatItemStockDisplay(row.opening, item)}, llegó ${addedLabel}`;
  }
  if (row.added > 0) {
    return `Hoy empezó sin inicio registrado, llegó ${addedLabel}`;
  }
  return 'Hoy empezó sin inicio registrado, llegó 0';
}

export const ShiftMobileItemCard = memo(function ShiftMobileItemCard({
  item,
  row,
  isLocked,
  isWorkerOpeningPhase,
  isWorkerClosingPhase,
  draftMode,
  onCommitField,
  onClearField,
  onConfirmSingleOpening,
  onMarkZeroExplicit,
  onToggleNotApplicable,
}: ShiftItemRowProps) {
  const handleCommitOpening = useCallback(
    (val: number) => onCommitField(item.id, 'opening', val),
    [item.id, onCommitField],
  );
  const handleClearOpening = useCallback(
    () => onClearField(item.id, 'opening'),
    [item.id, onClearField],
  );
  const handleCommitAdded = useCallback(
    (val: number) => onCommitField(item.id, 'added', val),
    [item.id, onCommitField],
  );
  const handleCommitClosing = useCallback(
    (val: number) => onCommitField(item.id, 'closing', val),
    [item.id, onCommitField],
  );
  const handleClearClosing = useCallback(
    () => onClearField(item.id, 'closing'),
    [item.id, onClearField],
  );

  const isNA = Boolean(row.notApplicable);
  const openingState = getOpeningRowState(row);
  const isPendingConfirm = !isWorkerClosingPhase && openingState === 'pending_confirm';
  const showOpeningNumber = !isNA && (row.hasOpening || isPendingConfirm);
  const hasClosingVal = row.hasClosing && !isNA;

  const effectiveUnit = getEffectiveItemUnit(item);
  const level = getStockLevel(row.closing, item.minStock);
  const meta = getStockLevelMeta(level);
  const suggestBuy = getSuggestedPurchase(row.closing, item.minStock, item.targetStock);
  const rowAnomalies = isWorkerClosingPhase ? [] : detectEntryAnomalies(row, draftMode, item);
  const warningAnomalies = rowAnomalies.filter((a) => a.severity !== 'info');
  const infoAnomalies = rowAnomalies.filter((a) => a.severity === 'info');
  const openingTone = isPendingConfirm
    ? 'pending'
    : openingState === 'adjusted'
      ? 'adjusted'
      : row.hasOpening
        ? 'confirmed'
        : 'default';
  const closingTone = !hasClosingVal
    ? 'default'
    : isWorkerClosingPhase
      ? 'orange'
      : level === 'agotado' || level === 'comprar'
        ? 'red'
        : level === 'medio'
          ? 'amber'
          : 'emerald';

  const cardSurface = isNA
    ? 'bg-stone-100/80'
    : isPendingConfirm
      ? 'bg-sky-50/50'
      : isWorkerOpeningPhase && row.hasOpening
        ? 'bg-emerald-50/25'
        : isWorkerClosingPhase && hasClosingVal
          ? 'bg-emerald-50/20'
          : 'bg-white';

  const closingReferenceText = isWorkerClosingPhase
    ? buildWorkerClosingReferenceText(row, item)
    : null;

  return (
    <div className={`p-3.5 sm:p-5 space-y-4 ${cardSurface}`}>
      {/* Item Title + Status */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-stone-900 leading-snug break-words">
            {item.name}
          </h3>
          {isWorkerClosingPhase ? (
            <p className="text-xs text-stone-500 mt-1 leading-relaxed">
              {closingReferenceText}
            </p>
          ) : (
            <p className="text-xs text-stone-500 mt-0.5 font-mono tabular-nums">
              {effectiveUnit} · Mín: {formatItemStockDisplay(item.minStock, item)}
              {typeof row.previousClosing === 'number' && (
                <>
                  {' '}·{' '}
                  <span className="text-sky-800 font-semibold">
                    Ayer quedó: {formatPreviousClosingForItem(row.previousClosing, item)}
                  </span>
                </>
              )}
            </p>
          )}
        </div>

        <div className="shrink-0 text-right">
          {isNA ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-stone-500">
              <Ban className="w-3.5 h-3.5 shrink-0" />
              No aplica
            </span>
          ) : isWorkerClosingPhase ? (
            hasClosingVal ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                Contado
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-stone-500">
                <Clock className="w-3.5 h-3.5 shrink-0" />
                Por contar
              </span>
            )
          ) : isPendingConfirm ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-sky-100 text-sky-800 border border-sky-300 text-xs font-bold">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              Por confirmar
            </span>
          ) : openingState === 'adjusted' ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-700">
              <Check className="w-3.5 h-3.5 shrink-0" />
              Corregido
            </span>
          ) : openingState === 'confirmed' || openingState === 'manual' ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              Inicio OK
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-stone-500">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              Por contar
            </span>
          )}
        </div>
      </div>

      {warningAnomalies.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
          <span>{warningAnomalies[0].message}</span>
        </div>
      )}

      {infoAnomalies.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-sky-50 border border-sky-200 text-xs text-sky-900">
          <Info className="w-3.5 h-3.5 text-sky-600 shrink-0 mt-0.5" />
          <span>{infoAnomalies[0].message}</span>
        </div>
      )}

      {/* OPENING + ADDED SECTION (shown in Apertura OR Boss/Unrestricted, NEVER in Worker Closing Phase) */}
      {!isWorkerClosingPhase && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-bold text-stone-700">Inicio y surtido</span>
            {!isNA && (row.hasOpening || isPendingConfirm) && (
              <span className="font-mono tabular-nums font-semibold text-stone-600">
                Total disponible:{' '}
                {formatItemStockDisplay(sanitizeStockQuantity(row.opening + row.added), item)}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5 min-w-0">
              <label
                htmlFor={`m-open-${item.id}`}
                className="flex flex-wrap items-center justify-between gap-1.5 text-xs font-semibold text-stone-700"
              >
                <span>Inicio del día ({effectiveUnit})</span>
                {typeof row.previousClosing === 'number' && (
                  <span className="font-mono tabular-nums text-sky-800">
                    Ayer quedó: {formatPreviousClosingForItem(row.previousClosing, item)}
                  </span>
                )}
              </label>
              <QuantityCaptureControl
                item={item}
                field="opening"
                fieldLabel="inicio"
                value={row.opening}
                hasValue={showOpeningNumber}
                disabled={isLocked || isNA}
                variant="mobile"
                tone={openingTone}
                inputId={`m-open-${item.id}`}
                onCommitValue={handleCommitOpening}
                onClearValue={handleClearOpening}
              />
            </div>

            <div className="space-y-1.5 min-w-0">
              <label
                htmlFor={`m-add-${item.id}`}
                className="block text-xs font-semibold text-orange-700"
              >
                Surtido (+)
              </label>
              <QuantityCaptureControl
                item={item}
                field="added"
                fieldLabel="surtido"
                value={row.added}
                hasValue={!isNA}
                disabled={isLocked || isNA}
                variant="mobile"
                tone="orange"
                inputId={`m-add-${item.id}`}
                onCommitValue={handleCommitAdded}
              />
            </div>
          </div>

          {!isLocked && (
            <div className="flex flex-wrap gap-2">
              {isPendingConfirm && (
                <button
                  type="button"
                  onClick={() => onConfirmSingleOpening(item.id)}
                  className="flex-1 min-w-[140px] min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs sm:text-sm font-bold rounded-xl bg-sky-600 text-white hover:bg-sky-700 active:scale-[0.99] transition-all cursor-pointer"
                >
                  <Check className="w-4 h-4 shrink-0" />
                  ✓ Está bien
                </button>
              )}
              {isWorkerOpeningPhase && (
                <button
                  type="button"
                  onClick={() => onMarkZeroExplicit(item.id, 'opening')}
                  className={`flex-1 min-h-[44px] px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                    row.hasOpening && !isNA && row.opening === 0
                      ? 'bg-stone-900 text-white border-stone-900'
                      : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                  }`}
                >
                  0 / Sin existencia
                </button>
              )}
              {isWorkerOpeningPhase && (
                <button
                  type="button"
                  onClick={() => onToggleNotApplicable(item.id)}
                  className={`min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                    isNA
                      ? 'bg-stone-700 text-white border-stone-700'
                      : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                  }`}
                >
                  <Ban className="w-3.5 h-3.5 shrink-0" />
                  {isNA ? 'No aplica' : 'No aplica hoy'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* CLOSING SECTION (shown in Cierre OR Boss/Unrestricted, NEVER in Worker Opening Phase) */}
      {!isWorkerOpeningPhase && (
        <div
          className={`${
            isWorkerClosingPhase ? 'space-y-2.5' : 'pt-3 border-t border-stone-100 space-y-2.5'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={`mobile-close-${item.id}`}
              className="text-xs font-bold text-stone-800"
            >
              ¿Cuánto quedó hoy? ({effectiveUnit})
            </label>
            {!isWorkerClosingPhase &&
              (hasClosingVal ? (
                <span className={`inline-flex items-center gap-1 text-xs font-semibold ${meta.textClass}`}>
                  {(level === 'agotado' || level === 'comprar') && (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  )}
                  {suggestBuy > 0 ? formatPurchaseRecommendation(suggestBuy, item) : meta.label}
                </span>
              ) : !isNA ? (
                <span className="text-xs font-semibold text-stone-400">Por contar</span>
              ) : null)}
          </div>

          <QuantityCaptureControl
            item={item}
            field="closing"
            fieldLabel="cierre"
            value={row.closing}
            hasValue={hasClosingVal}
            disabled={isLocked || isNA}
            variant="mobile"
            tone={closingTone}
            inputId={`mobile-close-${item.id}`}
            onCommitValue={handleCommitClosing}
            onClearValue={handleClearClosing}
          />

          {!isLocked && (
            <div className="grid grid-cols-2 gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => onMarkZeroExplicit(item.id, 'closing')}
                className={`min-h-[44px] px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                  hasClosingVal && row.closing === 0
                    ? 'bg-red-700 text-white border-red-700'
                    : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                }`}
              >
                0 / No queda
              </button>
              <button
                type="button"
                onClick={() => onToggleNotApplicable(item.id)}
                className={`min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                  isNA
                    ? 'bg-stone-700 text-white border-stone-700'
                    : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                }`}
              >
                <Ban className="w-3.5 h-3.5 shrink-0" />
                {isNA ? 'Marcado: No aplica' : 'No aplica hoy'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

