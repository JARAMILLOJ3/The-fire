import { useMemo } from 'react';
import {
  MAX_PACK_LABEL_LENGTH,
  MAX_PACK_SIZE,
  PACK_LABEL_OPTIONS,
  UNIT_LABEL_OPTIONS,
} from '../constants';
import type { CaptureInputType } from '../types';
import {
  formatLevelApproximate,
  getPacksFieldLabels,
  parseCaptureDecimalInput,
  pluralizeSpanishLabel,
} from '../utils/inventory';
import { OptionSelect } from './OptionSelect';

interface ItemCaptureFieldsProps {
  inputType: CaptureInputType;
  onInputTypeChange: (next: CaptureInputType) => void;
  unit: string;
  packSizeInput: string;
  onPackSizeInputChange: (val: string) => void;
  packLabel: string;
  onPackLabelChange: (val: string) => void;
  unitLabel: string;
  onUnitLabelChange: (val: string) => void;
  capacityInput: string;
  onCapacityInputChange: (val: string) => void;
  allowClosedContainers?: boolean;
  onAllowClosedContainersChange?: (next: boolean) => void;
  onClearError?: () => void;
  compact?: boolean;
  requireCaptureFields?: boolean;
}

const CAPTURE_OPTIONS: Array<{ id: CaptureInputType; title: string; sub: string }> = [
  { id: 'count', title: 'Contador', sub: '− / +' },
  { id: 'packs', title: 'Paquetes + sueltas', sub: 'Por empaque' },
  { id: 'level', title: 'Nivel (barra)', sub: '0 a lleno' },
];

export function ItemCaptureFields({
  inputType,
  onInputTypeChange,
  unit,
  packSizeInput,
  onPackSizeInputChange,
  packLabel,
  onPackLabelChange,
  unitLabel,
  onUnitLabelChange,
  capacityInput,
  onCapacityInputChange,
  allowClosedContainers = false,
  onAllowClosedContainersChange,
  onClearError,
  compact = false,
  requireCaptureFields = true,
}: ItemCaptureFieldsProps) {
  const packOptions = useMemo(
    () => PACK_LABEL_OPTIONS.map((opt) => ({ value: opt, label: opt })),
    [],
  );
  const unitLabelOptions = useMemo(
    () => UNIT_LABEL_OPTIONS.map((opt) => ({ value: opt, label: opt })),
    [],
  );

  const parsedPackSize = parseCaptureDecimalInput(packSizeInput);
  const parsedCapacity = parseCaptureDecimalInput(capacityInput);
  const cleanUnit = unit.trim() || 'und';

  return (
    <div className={compact ? 'space-y-2' : 'space-y-2 pt-1'}>
      <label className="block text-xs font-semibold text-stone-700">Cómo se cuenta</label>
      <div className="grid grid-cols-3 gap-1 p-1 bg-stone-100 rounded-xl">
        {CAPTURE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => {
              onInputTypeChange(opt.id);
              onClearError?.();
            }}
            className={`min-h-[44px] flex flex-col items-center justify-center px-1.5 py-1.5 rounded-lg text-center transition-all cursor-pointer ${
              inputType === opt.id
                ? 'bg-white text-stone-900 shadow-xs font-bold'
                : 'text-stone-600 hover:text-stone-900 font-medium'
            }`}
          >
            <div className="text-[11px] sm:text-xs leading-tight">{opt.title}</div>
            <div className="text-[10px] text-stone-500 leading-tight mt-0.5">{opt.sub}</div>
          </button>
        ))}
      </div>

      {inputType === 'packs' && (
        <div
          className={`rounded-xl border border-stone-200 space-y-2.5 ${
            compact ? 'p-2.5 bg-white' : 'p-3.5 bg-stone-50 space-y-3'
          }`}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="min-w-0">
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Nombre del paquete <span className="text-red-600">*</span>
              </label>
              <OptionSelect
                size="sm"
                value={packLabel}
                options={packOptions}
                maxLength={MAX_PACK_LABEL_LENGTH}
                required={requireCaptureFields}
                selectAriaLabel="Nombre del paquete"
                customAriaLabel="Otro nombre del paquete"
                customPlaceholder="Ej: saco, bulto, caja"
                onChange={(val) => {
                  onPackLabelChange(val);
                  onClearError?.();
                }}
              />
            </div>

            <div className="min-w-0">
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Nombre de la unidad suelta <span className="text-red-600">*</span>
              </label>
              <OptionSelect
                size="sm"
                value={unitLabel}
                options={unitLabelOptions}
                maxLength={MAX_PACK_LABEL_LENGTH}
                required={requireCaptureFields}
                selectAriaLabel="Nombre de la unidad suelta"
                customAriaLabel="Otro nombre de la unidad suelta"
                customPlaceholder="Ej: alita, pieza, und"
                onChange={(val) => {
                  onUnitLabelChange(val);
                  onClearError?.();
                }}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-700 mb-1">
              Unidades por cada {packLabel.trim() || 'paquete'}{' '}
              <span className="text-red-600">*</span>
            </label>
            <input
              type="number"
              min={2}
              max={MAX_PACK_SIZE}
              step={1}
              required={requireCaptureFields}
              value={packSizeInput}
              onChange={(e) => {
                onPackSizeInputChange(e.target.value);
                onClearError?.();
              }}
              className="w-full min-h-[44px] px-2.5 py-2 text-base sm:text-sm font-mono tabular-nums bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <p className="text-[11px] text-stone-600 mt-1">
              Es un promedio; ajústalo si notas que no coincide
            </p>
          </div>

          {Number.isInteger(parsedPackSize) && parsedPackSize > 1 && (
            <p className="text-[11px] sm:text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-2.5 py-1.5">
              Vista trabajadora:{' '}
              <strong>
                {
                  getPacksFieldLabels({
                    packLabel,
                    unitLabel,
                    unit: cleanUnit,
                  }).packsFieldLabel
                }
              </strong>{' '}
              y{' '}
              <strong>
                {
                  getPacksFieldLabels({
                    packLabel,
                    unitLabel,
                    unit: cleanUnit,
                  }).looseFieldLabel
                }
              </strong>{' '}
              (1 {packLabel.trim() || 'paquete'} = {parsedPackSize}{' '}
              {pluralizeSpanishLabel(unitLabel.trim() || cleanUnit, parsedPackSize)})
            </p>
          )}
        </div>
      )}

      {inputType === 'level' && (
        <div
          className={`rounded-xl border border-stone-200 space-y-2 ${
            compact ? 'p-2.5 bg-white' : 'p-3.5 bg-stone-50'
          }`}
        >
          <div>
            <label className="block text-xs font-semibold text-stone-700 mb-1">
              Capacidad total del envase lleno ({cleanUnit}){' '}
              <span className="text-red-600">*</span>
            </label>
            <input
              type="number"
              min={0.1}
              step="any"
              required={requireCaptureFields}
              value={capacityInput}
              onChange={(e) => {
                onCapacityInputChange(e.target.value);
                onClearError?.();
              }}
              placeholder="Ej: 5"
              className="w-full min-h-[44px] px-2.5 py-2 text-base sm:text-sm font-mono tabular-nums bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
          {Number.isFinite(parsedCapacity) && parsedCapacity > 0 && (
            <p className="text-[11px] sm:text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-2.5 py-1.5">
              Barra de 0 a lleno en pasos de ⅛ (⅛ ={' '}
              <strong>{formatLevelApproximate(parsedCapacity / 8, cleanUnit)}</strong>, ½ ={' '}
              <strong>{formatLevelApproximate(parsedCapacity / 2, cleanUnit)}</strong>)
            </p>
          )}
          {onAllowClosedContainersChange && (
            <label className="flex items-start gap-2.5 p-2.5 bg-white border border-stone-200 rounded-xl cursor-pointer hover:bg-stone-50 transition-colors">
              <input
                type="checkbox"
                checked={allowClosedContainers}
                onChange={(e) => {
                  onAllowClosedContainersChange(e.target.checked);
                  onClearError?.();
                }}
                className="mt-0.5 w-5 h-5 rounded border-stone-300 text-orange-600 focus:ring-orange-500 shrink-0 cursor-pointer"
              />
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-stone-900">
                  Contar envases cerrados
                </span>
                <span className="block text-[11px] text-stone-600 leading-snug mt-0.5">
                  Actívalo solo si en este puesto también hay botellas o tarros sellados además del envase abierto.
                </span>
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
