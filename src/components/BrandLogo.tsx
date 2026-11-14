import { useState } from 'react';
import { APP_BRAND_NAME } from '../constants';

interface BrandLogoProps {
  subtitle?: string;
  size?: 'sm' | 'md';
  theme?: 'light' | 'dark';
}

export function BrandLogo({ subtitle, size = 'md', theme = 'light' }: BrandLogoProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const boxClass = size === 'sm' ? 'w-10 h-10' : 'w-11 h-11';
  const isDark = theme === 'dark';

  return (
    <div className="flex items-center gap-3 min-w-0">
      <div
        className={`${boxClass} rounded-xl bg-white ${
          isDark ? 'border border-stone-700/80 shadow-sm' : 'border border-stone-200'
        } overflow-hidden flex items-center justify-center shrink-0 p-0.5`}
      >
        {!imgFailed ? (
          <img
            src="/assets/aistudio/IMG_1518_bd74972f.jpeg"
            alt="Logo The Fire"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-contain"
          />
        ) : (
          <span className="font-display text-sm font-bold text-stone-900">TF</span>
        )}
      </div>
      <div className="min-w-0">
        <div
          className={`font-display text-base sm:text-lg font-bold tracking-tight whitespace-nowrap truncate ${
            isDark ? 'text-white' : 'text-stone-900'
          }`}
        >
          {APP_BRAND_NAME}
        </div>
        {subtitle && (
          <div
            className={`text-xs truncate ${
              isDark ? 'text-stone-400' : 'text-stone-500'
            }`}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
