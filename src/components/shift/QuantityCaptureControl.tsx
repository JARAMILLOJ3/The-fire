import { memo, useState } from 'react';
import { AlertTriangle, Minus, Plus } from 'lucide-react';
import { LEVEL_STEPS } from '../../constants';
import type { InventoryItem } from '../../types';
import {
  LEVEL_STEP_LABELS,
  computeLevelTotal,
  computePacksTotal,
  formatLevelApproximate,
  formatSpanishDecimal,
  getItemInputType,
  getPacksFieldLabels,
  parseQuantityInput,
  pluralizeSpanishLabel,
  sanitizeStockQuantity,
  snapQuantityToLevelStep,
  splitTotalToPacks,
} from '../../utils/inventory';

export type CaptureControlTone =
  | 'pending'
  | 'adjusted'
  | 'confirmed'
  | 'orange'
  | 'red'
  | 'amber'
  | 'emerald'
  | 'default';

export interface QuantityCaptureControlProps {
  item: Pick<
    InventoryItem,
    'id' | 'name' | 'unit' | 'inputType' | 'packSize' | 'packLabel' | 'unitLabel' | 'capacity'
  >;
  field: 'opening' | 'added' | 'closing';
  fieldLabel: string;
  value: number;
  hasValue: boolean;
  disabled: boolean;
  variant: 'mobile' | 'desktop';
  tone?: CaptureControlTone;
  inputId?: string;
  onCommitValue: (nextValue: number) => void;
  onClearValue?: () => void;
}

interface LocalPacksSplit {
  packs: number;
  loose: number;
  forValue: number;
  hadValue: boolean;
}

const MAJOR_LEVEL_MARKS: ReadonlyArray<{ step: number; label: string }> = [
  { step: 0, label: '0' },
  { step: 2, label: '¼' },
  { step: 4, label: '½' },
  { step: 6, label: '¾' },
  { step: 8, label: 'Lleno' },
];

function getCountInputToneClasses(tone: CaptureControlTone, disabled: boolean): string {
  if (disabled) {
    return 'bg-stone-100 border-stone-200 text-stone-400';
  }
  switch (tone) {
    case 'pending':
      return 'bg-sky-50 border-sky-400 text-sky-950';
    case 'adjusted':
      return 'bg-orange-50/50 border-orange-400 text-stone-900';
    case 'confirmed':
    case 'emerald':
      return 'bg-emerald-50/40 border-emerald-500 text-stone-900';
    case 'red':
      return 'bg-red-50/40 border-red-400 text-stone-900';
    case 'amber':
      return 'bg-amber-50/40 border-amber-400 text-stone-900';
    case 'orange':
      return 'bg-orange-50/40 border-orange-300 text-stone-900';
    default:
      return 'bg-white border-stone-300 text-stone-900';
  }
}

function getStepperButtonToneClasses(tone: CaptureControlTone): string {
  if (tone === 'orange') {
    return 'border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100';
  }
  if (tone === 'pending') {
    return 'border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100';
  }
  return 'border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100';
}

export const QuantityCaptureControl = memo(function QuantityCaptureControl({
  item,
  field,
  fieldLabel,
  value,
  hasValue,
  disabled,
  variant,
  tone = 'default',
  inputId,
  onCommitValue,
  onClearValue,
}: QuantityCaptureControlProps) {
  const inputType = getItemInputType(item);
  const isPacksConfigured =
    inputType === 'packs' && typeof item.packSize === 'number' && item.packSize > 1;
  const isLevelConfigured =
    inputType === 'level' && typeof item.capacity === 'number' && item.capacity > 0;

  const [localSplit, setLocalSplit] = useState<LocalPacksSplit | null>(null);

  // ---------------------------------------------------------------------------
  // 1. PACKS + LOOSE MODE
  // ---------------------------------------------------------------------------
  if (isPacksConfigured) {
    const packSize = Math.floor(item.packSize as number);
    const labels = getPacksFieldLabels(item);
    const derived = hasValue ? splitTotalToPacks(value, packSize) : { packs: 0, loose: 0 };

    const activeSplit =
      localSplit && localSplit.hadValue === hasValue && localSplit.forValue === value
        ? { packs: localSplit.packs, loose: localSplit.loose }
        : derived;

    const packsCount = hasValue ? activeSplit.packs : 0;
    const looseCount = hasValue ? activeSplit.loose : 0;
    const totalCount = hasValue ? computePacksTotal(packsCount, looseCount, packSize) : 0;
    const isLooseOverflow = hasValue && looseCount >= packSize;
    const normalizedSplit = isLooseOverflow ? splitTotalToPacks(totalCount, packSize) : null;

    const commitSplit = (nextPacks: number, nextLoose: number) => {
      const safePacks = Math.max(0, Math.floor(nextPacks));
      const safeLoose = sanitizeStockQuantity(nextLoose);
      const nextTotal = computePacksTotal(safePacks, safeLoose, packSize);
      setLocalSplit({
        packs: safePacks,
        loose: safeLoose,
        forValue: nextTotal,
        hadValue: true,
      });
      onCommitValue(nextTotal);
    };

    const handlePacksChange = (raw: string, badInput: boolean) => {
      if (badInput) return;
      const trimmed = raw.trim();
      if (trimmed === '') {
        if (!hasValue || (looseCount === 0 && onClearValue && field !== 'added')) {
          setLocalSplit(null);
          onClearValue?.();
          return;
        }
        commitSplit(0, looseCount);
        return;
      }
      const parsed = parseQuantityInput(trimmed);
      if (!parsed.valid) return;
      commitSplit(Math.floor(parsed.value), looseCount);
    };

    const handleLooseChange = (raw: string, badInput: boolean) => {
      if (badInput) return;
      const trimmed = raw.trim();
      if (trimmed === '') {
        if (!hasValue || (packsCount === 0 && onClearValue && field !== 'added')) {
          setLocalSplit(null);
          onClearValue?.();
          return;
        }
        commitSplit(packsCount, 0);
        return;
      }
      const parsed = parseQuantityInput(trimmed);
      if (!parsed.valid) return;
      commitSplit(packsCount, parsed.value);
    };

    const isMobile = variant === 'mobile';
    const boxToneClass = getCountInputToneClasses(tone, disabled);
    const btnToneClass = getStepperButtonToneClasses(tone);
    const unitText = pluralizeSpanishLabel(labels.unitSingular, totalCount);

    return (
      <div className={isMobile ? 'space-y-2 min-w-0' : 'space-y-1.5 min-w-[205px]'}>
        <div
          className={
            isMobile
              ? 'grid grid-cols-1 min-[410px]:grid-cols-2 gap-2.5'
              : 'grid grid-cols-2 gap-1.5'
          }
        >
          {/* Packs complete field */}
          <div className="space-y-1 min-w-0">
            <label
              htmlFor={inputId ? `${inputId}-packs` : undefined}
              className="block text-[11px] font-semibold text-stone-600 truncate"
            >
              {labels.packsFieldLabel}
            </label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => commitSplit(Math.max(0, packsCount - 1), looseCount)}
                aria-label={`Restar ${labels.packsFieldLabel} (${fieldLabel}) ${item.name}`}
                className={`${
                  isMobile ? 'w-11 h-11 rounded-xl' : 'w-7 h-9 rounded-lg'
                } shrink-0 flex items-center justify-center border ${btnToneClass} disabled:opacity-40 cursor-pointer`}
              >
                <Minus className={isMobile ? 'w-4 h-4' : 'w-3 h-3'} />
              </button>
              <input
                id={inputId ? `${inputId}-packs` : undefined}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                disabled={disabled}
                placeholder="—"
                aria-label={`${labels.packsFieldLabel} (${fieldLabel}) de ${item.name}`}
                value={hasValue && !disabled ? packsCount : ''}
                onChange={(e) => handlePacksChange(e.target.value, e.target.validity.badInput)}
                className={`min-w-0 flex-1 ${
                  isMobile ? 'h-11 text-lg rounded-xl scroll-mb-36' : 'h-9 text-sm rounded-lg'
                } text-center font-mono tabular-nums font-bold border placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 ${boxToneClass}`}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => commitSplit(packsCount + 1, looseCount)}
                aria-label={`Sumar ${labels.packsFieldLabel} (${fieldLabel}) ${item.name}`}
                className={`${
                  isMobile ? 'w-11 h-11 rounded-xl' : 'w-7 h-9 rounded-lg'
                } shrink-0 flex items-center justify-center border ${btnToneClass} disabled:opacity-40 cursor-pointer`}
              >
                <Plus className={isMobile ? 'w-4 h-4' : 'w-3 h-3'} />
              </button>
            </div>
          </div>

          {/* Loose units field */}
          <div className="space-y-1 min-w-0">
            <label
              htmlFor={inputId ? `${inputId}-loose` : undefined}
              className="block text-[11px] font-semibold text-stone-600 truncate"
            >
              {labels.looseFieldLabel}
            </label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => commitSplit(packsCount, Math.max(0, looseCount - 1))}
                aria-label={`Restar ${labels.looseFieldLabel} (${fieldLabel}) ${item.name}`}
                className={`${
                  isMobile ? 'w-11 h-11 rounded-xl' : 'w-7 h-9 rounded-lg'
                } shrink-0 flex items-center justify-center border ${btnToneClass} disabled:opacity-40 cursor-pointer`}
              >
                <Minus className={isMobile ? 'w-4 h-4' : 'w-3 h-3'} />
              </button>
              <input
                id={inputId ? `${inputId}-loose` : undefined}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                disabled={disabled}
                placeholder="—"
                aria-label={`${labels.looseFieldLabel} (${fieldLabel}) de ${item.name}`}
                value={hasValue && !disabled ? looseCount : ''}
                onChange={(e) => handleLooseChange(e.target.value, e.target.validity.badInput)}
                className={`min-w-0 flex-1 ${
                  isMobile ? 'h-11 text-lg rounded-xl scroll-mb-36' : 'h-9 text-sm rounded-lg'
                } text-center font-mono tabular-nums font-bold border placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 ${
                  isLooseOverflow && !disabled
                    ? 'bg-amber-50 border-amber-500 text-amber-950'
                    : boxToneClass
                }`}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => commitSplit(packsCount, looseCount + 1)}
                aria-label={`Sumar ${labels.looseFieldLabel} (${fieldLabel}) ${item.name}`}
                className={`${
                  isMobile ? 'w-11 h-11 rounded-xl' : 'w-7 h-9 rounded-lg'
                } shrink-0 flex items-center justify-center border ${btnToneClass} disabled:opacity-40 cursor-pointer`}
              >
                <Plus className={isMobile ? 'w-4 h-4' : 'w-3 h-3'} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-[11px] text-stone-500">
            1 {labels.packSingular} = {packSize} {pluralizeSpanishLabel(labels.unitSingular, packSize)}
          </span>
          {hasValue && !disabled && (
            <span
              className={`font-mono tabular-nums font-bold ${
                tone === 'pending' ? 'text-sky-800' : 'text-stone-900'
              }`}
            >
              = {formatSpanishDecimal(totalCount, 2)} {unitText}
            </span>
          )}
        </div>

        {isLooseOverflow && normalizedSplit && !disabled && (
          <div
            role="alert"
            className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-[11px] text-amber-950 flex flex-wrap items-center justify-between gap-2"
          >
            <div className="flex items-start gap-1.5 min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
              <span>
                {formatSpanishDecimal(looseCount, 2)} sueltas es ≥ {packSize} (1 {labels.packSingular}).
              </span>
            </div>
            <button
              type="button"
              onClick={() =>
                setLocalSplit({
                  packs: normalizedSplit.packs,
                  loose: normalizedSplit.loose,
                  forValue: totalCount,
                  hadValue: true,
                })
              }
              className="min-h-[36px] sm:min-h-0 px-2 py-1 rounded-lg bg-amber-100 sm:bg-transparent font-bold text-amber-900 underline hover:text-amber-700 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Convertir ({normalizedSplit.packs}+{normalizedSplit.loose})
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // 2. LEVEL SLIDER MODE (0 to 8/8 in 1/8 steps)
  // ---------------------------------------------------------------------------
  if (isLevelConfigured) {
    const capacity = item.capacity as number;
    const step = hasValue ? snapQuantityToLevelStep(value, capacity) : 0;
    const stepLabel = LEVEL_STEP_LABELS[step] ?? '0';
    const totalEquivalent = hasValue ? computeLevelTotal(step, capacity) : 0;
    const approxText = hasValue
      ? formatLevelApproximate(totalEquivalent, item.unit)
      : `0 a ${formatSpanishDecimal(capacity, 2)} ${item.unit}`;

    const commitStep = (nextStep: number) => {
      const clamped = Math.max(0, Math.min(LEVEL_STEPS, Math.round(nextStep)));
      onCommitValue(computeLevelTotal(clamped, capacity));
    };

    const segmentActiveColor =
      tone === 'pending'
        ? 'bg-sky-500'
        : tone === 'red'
          ? 'bg-red-500'
          : tone === 'amber'
            ? 'bg-amber-500'
            : tone === 'confirmed' || tone === 'emerald'
              ? 'bg-emerald-500'
              : 'bg-orange-500';

    const thumbAccentClass =
      tone === 'pending'
        ? '[&::-webkit-slider-thumb]:bg-sky-600 [&::-moz-range-thumb]:bg-sky-600'
        : tone === 'emerald' || tone === 'confirmed'
          ? '[&::-webkit-slider-thumb]:bg-emerald-600 [&::-moz-range-thumb]:bg-emerald-600'
          : tone === 'red'
            ? '[&::-webkit-slider-thumb]:bg-red-600 [&::-moz-range-thumb]:bg-red-600'
            : '[&::-webkit-slider-thumb]:bg-orange-600 [&::-moz-range-thumb]:bg-orange-600';

    const isMobile = variant === 'mobile';

    return (
      <div
        className={`rounded-xl border p-2.5 sm:p-3 space-y-2.5 min-w-0 ${
          disabled
            ? 'bg-stone-100 border-stone-200 opacity-60'
            : tone === 'pending'
              ? 'bg-sky-50/70 border-sky-300'
              : tone === 'orange'
                ? 'bg-orange-50/40 border-orange-200'
                : 'bg-stone-50/70 border-stone-200'
        } ${isMobile ? '' : 'min-w-[215px]'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={disabled || (hasValue && step <= 0)}
              onClick={() => commitStep(hasValue ? step - 1 : 0)}
              aria-label={`Bajar 1/8 nivel (${fieldLabel}) ${item.name}`}
              className={`${
                isMobile ? 'w-11 h-11 rounded-xl' : 'w-8 h-8 rounded-lg'
              } border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 flex items-center justify-center disabled:opacity-40 cursor-pointer`}
            >
              <Minus className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
            </button>
            <span
              className={`min-w-[44px] text-center font-mono tabular-nums font-bold ${
                isMobile ? 'text-base' : 'text-sm'
              } ${
                !hasValue
                  ? 'text-stone-400'
                  : tone === 'pending'
                    ? 'text-sky-900'
                    : 'text-stone-900'
              }`}
            >
              {hasValue ? stepLabel : '—'}
            </span>
            <button
              type="button"
              disabled={disabled || (hasValue && step >= LEVEL_STEPS)}
              onClick={() => commitStep(hasValue ? step + 1 : 1)}
              aria-label={`Subir 1/8 nivel (${fieldLabel}) ${item.name}`}
              className={`${
                isMobile ? 'w-11 h-11 rounded-xl' : 'w-8 h-8 rounded-lg'
              } border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 flex items-center justify-center disabled:opacity-40 cursor-pointer`}
            >
              <Plus className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
            </button>
          </div>

          <span
            className={`font-mono tabular-nums text-xs font-bold text-right ${
              !hasValue
                ? 'text-stone-500'
                : tone === 'pending'
                  ? 'text-sky-800'
                  : 'text-stone-800'
            }`}
          >
            {approxText}
          </span>
        </div>

        {/* Touch-friendly 8-step bar + range input */}
        <div className={`relative ${isMobile ? 'h-12' : 'h-10'} flex items-center select-none`}>
          <div
            aria-hidden="true"
            className="absolute inset-x-0 grid grid-cols-8 gap-0.5 h-4 rounded-full overflow-hidden bg-stone-200 pointer-events-none"
          >
            {Array.from({ length: LEVEL_STEPS }, (_, idx) => (
              <div
                key={idx}
                className={hasValue && idx < step ? segmentActiveColor : 'bg-stone-200'}
              />
            ))}
          </div>
          <input
            id={inputId}
            type="range"
            min={0}
            max={LEVEL_STEPS}
            step={1}
            disabled={disabled}
            aria-label={`${fieldLabel} (${item.name}) en fracciones de 0 a lleno`}
            value={hasValue ? step : 0}
            onChange={(e) => commitStep(Number(e.target.value))}
            className={`relative z-10 w-full ${
              isMobile
                ? 'h-12 [&::-webkit-slider-thumb]:w-8 [&::-webkit-slider-thumb]:h-8 [&::-moz-range-thumb]:w-8 [&::-moz-range-thumb]:h-8'
                : 'h-10 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:h-7 [&::-moz-range-thumb]:w-7 [&::-moz-range-thumb]:h-7'
            } touch-pan-y appearance-none bg-transparent cursor-pointer disabled:cursor-not-allowed [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow-md ${
              !hasValue
                ? '[&::-webkit-slider-thumb]:bg-stone-400 [&::-moz-range-thumb]:bg-stone-400'
                : thumbAccentClass
            }`}
          />
        </div>

        {/* Visible quick-tap marks at 0, ¼, ½, ¾, Lleno */}
        <div className="grid grid-cols-5 gap-1">
          {MAJOR_LEVEL_MARKS.map((mark) => {
            const isActiveMark = hasValue && step === mark.step;
            return (
              <button
                key={mark.step}
                type="button"
                disabled={disabled}
                onClick={() => commitStep(mark.step)}
                className={`${
                  isMobile ? 'min-h-[44px] text-xs' : 'min-h-[32px] text-[11px]'
                } font-mono font-bold rounded-lg border transition-colors cursor-pointer disabled:opacity-40 ${
                  isActiveMark
                    ? tone === 'pending'
                      ? 'bg-sky-700 text-white border-sky-700'
                      : 'bg-stone-900 text-white border-stone-900'
                    : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-100'
                }`}
              >
                {mark.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // 3. STANDARD COUNT MODE (- / number / +)
  // ---------------------------------------------------------------------------
  const isMobile = variant === 'mobile';
  const boxToneClass = getCountInputToneClasses(tone, disabled);
  const btnToneClass = getStepperButtonToneClasses(tone);

  const stepDelta = (delta: number) => {
    const base = hasValue ? value : 0;
    onCommitValue(sanitizeStockQuantity(base + delta));
  };

  return (
    <div
      className={`flex items-center ${isMobile ? 'gap-2' : 'justify-center gap-1'}`}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => stepDelta(-1)}
        aria-label={`Restar ${fieldLabel} de ${item.name}`}
        className={`${
          isMobile
            ? 'w-12 h-12 rounded-xl'
            : field === 'closing'
              ? 'w-11 h-11 rounded-xl'
              : 'w-9 h-10 rounded-lg'
        } shrink-0 flex items-center justify-center border ${btnToneClass} disabled:opacity-40 cursor-pointer active:scale-95 transition-transform`}
      >
        <Minus className={isMobile ? 'w-5 h-5' : field === 'closing' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      </button>

      <input
        id={inputId}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        disabled={disabled}
        placeholder="—"
        aria-label={`${fieldLabel} de ${item.name}`}
        value={hasValue && !disabled ? value : ''}
        onChange={(e) => {
          if (e.target.validity.badInput) return;
          const parsed = parseQuantityInput(e.target.value);
          if (!parsed.valid) return;
          if (parsed.empty) {
            if (onClearValue && field !== 'added') {
              onClearValue();
            } else {
              onCommitValue(0);
            }
            return;
          }
          onCommitValue(parsed.value);
        }}
        className={`${
          isMobile
            ? 'min-w-0 flex-1 h-12 text-xl rounded-xl scroll-mb-36'
            : field === 'closing'
              ? 'w-20 h-11 text-base rounded-xl'
              : 'w-16 h-10 text-sm rounded-lg'
        } text-center font-mono tabular-nums font-bold border placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 ${boxToneClass}`}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => stepDelta(1)}
        aria-label={`Sumar ${fieldLabel} de ${item.name}`}
        className={`${
          isMobile
            ? 'w-12 h-12 rounded-xl'
            : field === 'closing'
              ? 'w-11 h-11 rounded-xl'
              : 'w-9 h-10 rounded-lg'
        } shrink-0 flex items-center justify-center border ${btnToneClass} disabled:opacity-40 cursor-pointer active:scale-95 transition-transform`}
      >
        <Plus className={isMobile ? 'w-5 h-5' : field === 'closing' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      </button>
    </div>
  );
});
