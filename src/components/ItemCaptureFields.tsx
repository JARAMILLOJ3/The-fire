import { useId } from 'react';
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
  onClearError,
  compact = false,
  requireCaptureFields = true,
}: ItemCaptureFieldsProps) {
  const uid = useId();
  const packLabelListId = `${uid}-pack-labels`;
  const unitLabelListId = `${uid}-unit-labels`;

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
            className={`px-1.5 py-1.5 rounded-lg text-center transition-all cursor-pointer ${
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
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Nombre del paquete <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                list={packLabelListId}
                required={requireCaptureFields}
                maxLength={MAX_PACK_LABEL_LENGTH}
                value={packLabel}
                onChange={(e) => {
                  onPackLabelChange(e.target.value);
                  onClearError?.();
                }}
                placeholder="Ej: paquete, kilo, caja"
                className="w-full min-h-[38px] px-2.5 py-1.5 text-xs sm:text-sm bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <datalist id={packLabelListId}>
                {PACK_LABEL_OPTIONS.map((opt) => (
                  <option key={opt} value={opt} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Nombre de la unidad suelta <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                list={unitLabelListId}
                required={requireCaptureFields}
                maxLength={MAX_PACK_LABEL_LENGTH}
                value={unitLabel}
                onChange={(e) => {
                  onUnitLabelChange(e.target.value);
                  onClearError?.();
                }}
                placeholder="Ej: pan, loncha, und"
                className="w-full min-h-[38px] px-2.5 py-1.5 text-xs sm:text-sm bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <datalist id={unitLabelListId}>
                {UNIT_LABEL_OPTIONS.map((opt) => (
                  <option key={opt} value={opt} />
                ))}
              </datalist>
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
              className="w-full min-h-[38px] px-2.5 py-1.5 text-xs sm:text-sm font-mono tabular-nums bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
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
              className="w-full min-h-[38px] px-2.5 py-1.5 text-xs sm:text-sm font-mono tabular-nums bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
          {Number.isFinite(parsedCapacity) && parsedCapacity > 0 && (
            <p className="text-[11px] sm:text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-2.5 py-1.5">
              Barra de 0 a lleno en pasos de ⅛ (⅛ ={' '}
              <strong>{formatLevelApproximate(parsedCapacity / 8, cleanUnit)}</strong>, ½ ={' '}
              <strong>{formatLevelApproximate(parsedCapacity / 2, cleanUnit)}</strong>)
            </p>
          )}
        </div>
      )}
    </div>
  );
}
