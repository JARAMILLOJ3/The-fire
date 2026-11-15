import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Copy, RefreshCw, X } from 'lucide-react';
import {
  buildStationSaveErrorCopyText,
  type StationSaveErrorInfo,
} from '../../utils/inventory';

interface ShiftSaveErrorModalProps {
  open: boolean;
  error: StationSaveErrorInfo | null;
  retrying?: boolean;
  onRetryFailed?: () => void;
  onClose: () => void;
}

export async function copyErrorTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below when Clipboard API is restricted in embedded frames/Safari
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(ta);
    return copied;
  } catch {
    return false;
  }
}

export function ShiftSaveErrorModal({
  open,
  error,
  retrying = false,
  onRetryFailed,
  onClose,
}: ShiftSaveErrorModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [error, open]);

  if (!open || !error) return null;

  const copyPayload = buildStationSaveErrorCopyText(error);
  const showTechnicalBlock =
    Boolean(error.rawDetail?.trim()) && error.rawDetail?.trim() !== error.detail.trim();
  const savedItems = error.savedItems ?? [];
  const failedItems = error.failedItems ?? [];
  const canRetryPending = failedItems.length > 0 && Boolean(onRetryFailed);

  const handleCopy = async () => {
    const ok = await copyErrorTextToClipboard(copyPayload);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shift-save-error-title"
    >
      <div className="w-full sm:max-w-xl max-h-[90dvh] flex flex-col bg-white border border-red-200 rounded-t-3xl sm:rounded-2xl overflow-hidden shadow-2xl animate-tf-fade-up">
        <div className="px-5 py-4 border-b border-red-200 bg-red-50/70 flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h2
                id="shift-save-error-title"
                className="font-display text-base sm:text-lg font-bold text-red-950 break-words"
              >
                {error.title}
              </h2>
              {error.code && (
                <p className="text-xs font-mono font-semibold text-red-700 mt-0.5 break-all">
                  Código: {error.code}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ventana de error"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-red-700 hover:bg-red-100 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-4 overflow-y-auto flex-1 min-h-0">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              Motivo completo del error
            </p>
            <div className="p-3.5 rounded-xl bg-red-50/60 border border-red-200 text-sm text-red-950 leading-relaxed whitespace-pre-wrap break-words">
              {error.detail}
            </div>
          </div>

          {savedItems.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                Insumos ya guardados ({savedItems.length})
              </p>
              <div className="p-3 rounded-xl bg-emerald-50/70 border border-emerald-200 text-xs text-emerald-950 max-h-32 overflow-y-auto leading-relaxed">
                {savedItems.map((s) => s.itemName).join(', ')}
              </div>
            </div>
          )}

          {failedItems.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-red-700">
                Insumos pendientes con error ({failedItems.length})
              </p>
              <div className="space-y-2.5 max-h-60 overflow-y-auto pr-0.5">
                {failedItems.map((item) => (
                  <div
                    key={item.itemId}
                    className="p-3 rounded-xl bg-stone-50 border border-red-200 space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-bold text-stone-900">{item.itemName}</p>
                      {item.code && (
                        <span className="text-[11px] font-mono font-semibold text-red-700">
                          {item.code}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-red-900 leading-relaxed break-words">
                      {item.reason}
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 pt-1 text-[11px] font-mono tabular-nums text-stone-700 bg-white border border-stone-200 rounded-lg px-2.5 py-2">
                      <span>Unidad: {item.attemptedValues.unit}</span>
                      <span>Mín: {item.attemptedValues.minStock}</span>
                      <span>Ideal: {item.attemptedValues.targetStock}</span>
                      <span>Inicio: {item.attemptedValues.opening}</span>
                      {item.attemptedValues.added > 0 && (
                        <span>Surtido: +{item.attemptedValues.added}</span>
                      )}
                      <span>Cierre: {item.attemptedValues.closing}</span>
                      {item.attemptedValues.notApplicable && <span>No aplica: Sí</span>}
                    </div>
                    <p className="text-[11px] font-mono text-stone-500 break-all">
                      {item.failedDocumentPath}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            error.failedDocumentPath && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-stone-500">Documento afectado</p>
                <p className="px-3 py-2 rounded-xl bg-stone-100 border border-stone-200 text-xs font-mono text-stone-800 break-all">
                  {error.failedDocumentPath}
                </p>
              </div>
            )
          )}

          {showTechnicalBlock && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Detalle técnico completo
              </p>
              <pre className="p-3.5 rounded-xl bg-stone-950 text-stone-100 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words overflow-x-auto max-h-48 overflow-y-auto">
                {error.rawDetail}
              </pre>
            </div>
          )}

          <p className="text-xs text-stone-600">
            Tu borrador y los insumos ya guardados siguen seguros. Si algún insumo falló, puedes reintentar solo los pendientes o copiar el error para el jefe.
          </p>

          <div className="flex flex-col-reverse sm:flex-row gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[46px] px-4 py-2.5 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 cursor-pointer"
            >
              Cerrar
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="flex-1 min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-stone-900 bg-stone-100 border border-stone-300 rounded-xl hover:bg-stone-200 active:scale-[0.99] cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-emerald-700 shrink-0" />
                  ¡Error copiado!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 shrink-0" />
                  Copiar error
                </>
              )}
            </button>
            {canRetryPending && (
              <button
                type="button"
                disabled={retrying}
                onClick={onRetryFailed}
                className="flex-1 min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 shrink-0 ${retrying ? 'animate-spin' : ''}`} />
                {retrying ? 'Reintentando...' : 'Reintentar los que faltan'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
