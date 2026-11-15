import { useEffect, useMemo, useRef, useState } from 'react';

export interface SelectOptionItem {
  value: string;
  label: string;
}

const OTHER_OPTION_VALUE = '__other__';

interface OptionSelectProps {
  value: string;
  onChange: (next: string) => void;
  options: SelectOptionItem[];
  otherLabel?: string;
  customPlaceholder?: string;
  selectAriaLabel?: string;
  customAriaLabel?: string;
  maxLength: number;
  required?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  disabled?: boolean;
  disabledNote?: string;
}

export function OptionSelect({
  value,
  onChange,
  options,
  otherLabel = 'Otra…',
  customPlaceholder = 'Escribe una unidad propia',
  selectAriaLabel,
  customAriaLabel,
  maxLength,
  required = true,
  size = 'md',
  id,
  disabled = false,
  disabledNote,
}: OptionSelectProps) {
  const presetSet = useMemo(() => new Set(options.map((opt) => opt.value)), [options]);
  const [customSelected, setCustomSelected] = useState<boolean>(
    () => Boolean(value) && !presetSet.has(value),
  );
  const internalChangeRef = useRef(false);
  const customInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (internalChangeRef.current) {
      internalChangeRef.current = false;
      return;
    }
    setCustomSelected(Boolean(value) && !presetSet.has(value));
  }, [value, presetSet]);

  const isCustomMode = !disabled && (customSelected || (Boolean(value) && !presetSet.has(value)));
  const selectValue = isCustomMode
    ? OTHER_OPTION_VALUE
    : presetSet.has(value)
      ? value
      : disabled && value
        ? value
        : '';

  const controlSizeClass =
    size === 'sm'
      ? 'min-h-[44px] px-2.5 py-2 text-base sm:text-sm'
      : 'min-h-[44px] px-3 py-2 text-base sm:text-sm';

  const handleSelectChange = (next: string) => {
    if (disabled) return;
    if (next === OTHER_OPTION_VALUE) {
      setCustomSelected(true);
      if (value !== '') {
        internalChangeRef.current = true;
        onChange('');
      }
      requestAnimationFrame(() => {
        customInputRef.current?.focus();
      });
      return;
    }

    setCustomSelected(false);
    if (value !== next) {
      internalChangeRef.current = true;
      onChange(next);
    }
  };

  const handleCustomInputChange = (next: string) => {
    if (disabled) return;
    if (next !== value) {
      internalChangeRef.current = true;
      onChange(next);
    }
  };

  return (
    <div className="space-y-1.5 min-w-0 w-full max-w-full">
      <select
        id={id}
        value={selectValue}
        disabled={disabled}
        required={required && !isCustomMode && !disabled}
        aria-label={selectAriaLabel}
        onChange={(e) => handleSelectChange(e.target.value)}
        className={`w-full max-w-full min-w-0 ${controlSizeClass} border rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 ${
          disabled
            ? 'bg-stone-100 border-stone-200 text-stone-600 cursor-not-allowed'
            : 'bg-white border-stone-200 text-stone-900'
        }`}
      >
        {selectValue === '' && (
          <option value="" disabled>
            Selecciona…
          </option>
        )}
        {disabled && value && !presetSet.has(value) && (
          <option value={value}>{value}</option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
        <option value={OTHER_OPTION_VALUE}>{otherLabel}</option>
      </select>

      {isCustomMode && (
        <input
          ref={customInputRef}
          type="text"
          required={required}
          maxLength={maxLength}
          value={value}
          onChange={(e) => handleCustomInputChange(e.target.value)}
          placeholder={customPlaceholder}
          aria-label={customAriaLabel ?? customPlaceholder}
          className={`w-full max-w-full min-w-0 ${controlSizeClass} bg-white border border-orange-300 rounded-xl text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500`}
        />
      )}

      {disabledNote && (
        <p className="text-[11px] font-medium text-stone-600 leading-snug">{disabledNote}</p>
      )}
    </div>
  );
}
