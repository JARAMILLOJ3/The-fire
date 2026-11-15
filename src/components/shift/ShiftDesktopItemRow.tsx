import { memo, useCallback } from 'react';
import { AlertTriangle, Check, Info } from 'lucide-react';
import {
  detectEntryAnomalies,
  formatItemStockDisplay,
  formatPreviousClosingForItem,
  formatPurchaseRecommendation,
  getEffectiveItemUnit,
  getItemInputType,
  getOpeningRowState,
  getStockLevel,
  getStockLevelMeta,
  getSuggestedPurchase,
  sanitizeStockQuantity,
} from '../../utils/inventory';
import { QuantityCaptureControl } from './QuantityCaptureControl';
import type { ShiftItemRowProps } from './ShiftMobileItemCard';

export const ShiftDesktopItemRow = memo(function ShiftDesktopItemRow({
  item,
  row,
  isLocked,
  isWorkerOpeningPhase,
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
  const isPendingConfirm = openingState === 'pending_confirm';
  const showOpeningNumber = !isNA && (row.hasOpening || isPendingConfirm);
  const hasValue = row.hasClosing && !isNA;
  const effectiveUnit = getEffectiveItemUnit(item);
  const isLevel = getItemInputType(item) === 'level';
  const isLevelRestock =
    isLevel &&
    row.hasOpening &&
    hasValue &&
    row.closing > sanitizeStockQuantity(row.opening + row.added);
  const consumed =
    row.hasOpening && hasValue
      ? sanitizeStockQuantity(Math.max(0, row.opening + row.added - row.closing))
      : null;
  const level = getStockLevel(row.closing, item.minStock);
  const meta = getStockLevelMeta(level);
  const suggestBuy = getSuggestedPurchase(row.closing, item.minStock, item.targetStock);
  const rowAnomalies = detectEntryAnomalies(row, draftMode, item);
  const warningAnomalies = rowAnomalies.filter((a) => a.severity !== 'info');
  const infoAnomalies = rowAnomalies.filter((a) => a.severity === 'info');
  const openingTone = isPendingConfirm
    ? 'pending'
    : openingState === 'adjusted'
      ? 'adjusted'
      : row.hasOpening
        ? 'confirmed'
        : 'default';
  const closingTone = !hasValue
    ? 'default'
    : level === 'agotado' || level === 'comprar'
      ? 'red'
      : level === 'medio'
        ? 'amber'
        : 'emerald';

  return (
    <tr
      className={`transition-colors ${
        isNA
          ? 'bg-stone-50/90'
          : isPendingConfirm
            ? 'bg-sky-50/45 hover:bg-sky-50/70'
            : 'hover:bg-stone-50/70'
      }`}
    >
      <td className="py-4 px-5 align-top">
        <div className="text-base font-semibold text-stone-900">{item.name}</div>
        <div className="text-xs text-stone-500 font-mono tabular-nums mt-0.5 flex flex-wrap items-center gap-x-1.5">
          <span>
            {effectiveUnit} · Mín: {formatItemStockDisplay(item.minStock, item)}
          </span>
          {typeof row.previousClosing === 'number' && (
            <span className="text-sky-800 font-semibold">
              · Ayer quedó: {formatPreviousClosingForItem(row.previousClosing, item)}
            </span>
          )}
        </div>
        {warningAnomalies.length > 0 && (
          <div className="inline-flex items-center gap-1 mt-1 text-xs font-medium text-amber-700">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{warningAnomalies[0].message}</span>
          </div>
        )}
        {infoAnomalies.length > 0 && (
          <div className="inline-flex items-center gap-1 mt-1 text-xs font-medium text-sky-700">
            <Info className="w-3.5 h-3.5 shrink-0" />
            <span>{infoAnomalies[0].message}</span>
          </div>
        )}
      </td>

      <td className="py-4 px-3 align-top">
        <div className="flex flex-col items-center gap-1.5">
          <QuantityCaptureControl
            item={item}
            field="opening"
            fieldLabel="inicio"
            value={row.opening}
            hasValue={showOpeningNumber}
            disabled={isLocked || isNA}
            variant="desktop"
            tone={openingTone}
            onCommitValue={handleCommitOpening}
            onClearValue={handleClearOpening}
          />

          {isPendingConfirm && !isLocked ? (
            <button
              type="button"
              onClick={() => onConfirmSingleOpening(item.id)}
              className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-white bg-sky-600 rounded-lg hover:bg-sky-700 whitespace-nowrap cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              ✓ Está bien
            </button>
          ) : !isNA && openingState === 'adjusted' ? (
            <span className="text-[11px] font-semibold text-orange-700">Corregido</span>
          ) : !isNA && openingState === 'confirmed' ? (
            <span className="text-[11px] font-semibold text-emerald-700">Confirmado</span>
          ) : null}
        </div>
      </td>

      <td className="py-4 px-3 align-top">
        <QuantityCaptureControl
          item={item}
          field="added"
          fieldLabel="surtido"
          value={row.added}
          hasValue={!isNA}
          disabled={isLocked || isNA}
          variant="desktop"
          tone="orange"
          onCommitValue={handleCommitAdded}
        />
      </td>

      {isWorkerOpeningPhase ? (
        <>
          <td className="py-4 px-3 align-top">
            <div className="flex items-center justify-center gap-1.5">
              <button
                type="button"
                disabled={isLocked}
                onClick={() => onMarkZeroExplicit(item.id, 'opening')}
                className={`min-h-[38px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                  row.hasOpening && !isNA && row.opening === 0
                    ? 'bg-stone-900 text-white border-stone-900'
                    : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                }`}
              >
                0
              </button>
              <button
                type="button"
                disabled={isLocked}
                onClick={() => onToggleNotApplicable(item.id)}
                className={`min-h-[38px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                  isNA
                    ? 'bg-stone-700 text-white border-stone-700'
                    : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                }`}
              >
                No aplica
              </button>
            </div>
          </td>
          <td className="py-4 px-5 text-right font-mono tabular-nums font-bold align-top">
            {isNA ? (
              <span className="text-stone-500 font-normal">No aplica</span>
            ) : isPendingConfirm ? (
              <span className="text-sky-700">Por confirmar</span>
            ) : row.hasOpening ? (
              <span className="text-stone-900">
                {formatItemStockDisplay(sanitizeStockQuantity(row.opening + row.added), item)}
              </span>
            ) : (
              <span className="text-stone-400 font-normal">Por contar</span>
            )}
          </td>
        </>
      ) : (
        <>
          <td className="py-4 px-4 align-top">
            <QuantityCaptureControl
              item={item}
              field="closing"
              fieldLabel="cierre"
              value={row.closing}
              hasValue={hasValue}
              disabled={isLocked || isNA}
              variant="desktop"
              tone={closingTone}
              onCommitValue={handleCommitClosing}
              onClearValue={handleClearClosing}
            />
          </td>

          <td className="py-4 px-3 align-top">
            <div className="flex items-center justify-center gap-1.5">
              <button
                type="button"
                disabled={isLocked}
                onClick={() => onMarkZeroExplicit(item.id, 'closing')}
                className={`min-h-[38px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                  hasValue && row.closing === 0
                    ? 'bg-red-700 text-white border-red-700'
                    : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                }`}
              >
                0 / No queda
              </button>
              <button
                type="button"
                disabled={isLocked}
                onClick={() => onToggleNotApplicable(item.id)}
                className={`min-h-[38px] px-2.5 py-1 text-xs font-semibold rounded-lg border whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                  isNA
                    ? 'bg-stone-700 text-white border-stone-700'
                    : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100'
                }`}
              >
                No aplica
              </button>
            </div>
          </td>

          <td className="py-4 px-4 text-right font-mono tabular-nums text-stone-700 align-top">
            {isLevelRestock ? (
              <span className="text-xs font-semibold text-sky-700">Reposición</span>
            ) : consumed !== null ? (
              formatItemStockDisplay(consumed, item)
            ) : (
              '—'
            )}
          </td>

          <td className="py-4 px-5 whitespace-nowrap align-top">
            {isNA ? (
              <span className="text-xs font-semibold text-stone-500">No aplica hoy</span>
            ) : isPendingConfirm ? (
              <span className="text-xs font-bold text-sky-700">Inicio por confirmar</span>
            ) : !hasValue ? (
              <span className="text-xs font-medium text-stone-400">Por contar</span>
            ) : (
              <div className="space-y-0.5">
                <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${meta.textClass}`}>
                  {(level === 'agotado' || level === 'comprar') && (
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                  )}
                  {meta.label}
                </span>
                {suggestBuy > 0 && (
                  <p className="text-xs font-mono tabular-nums text-red-700">
                    {formatPurchaseRecommendation(suggestBuy, item)}
                  </p>
                )}
              </div>
            )}
          </td>
        </>
      )}
    </tr>
  );
});
