import { useState } from 'react';
import { APP_BRAND_NAME } from '../constants';

interface BrandLogoProps {
  subtitle?: string;
  size?: 'sm' | 'md';
}

export function BrandLogo({ subtitle, size = 'md' }: BrandLogoProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const boxClass = size === 'sm' ? 'w-10 h-10' : 'w-11 h-11';

  return (
    <div className="flex items-center gap-3 min-w-0">
      <div
        className={`${boxClass} rounded-lg bg-white border border-slate-200 overflow-hidden flex items-center justify-center shrink-0 p-0.5`}
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
          <span className="font-display text-sm font-bold text-slate-900">TF</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="font-display text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap truncate">
          {APP_BRAND_NAME}
        </div>
        {subtitle && (
          <div className="text-xs text-slate-500 truncate">{subtitle}</div>
        )}
      </div>
    </div>
  );
}
