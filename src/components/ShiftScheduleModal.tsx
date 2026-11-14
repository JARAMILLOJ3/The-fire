import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Clock, RotateCcw, Sun, Moon, X } from 'lucide-react';
import { DEFAULT_SHIFT_SCHEDULE, WORKER_GRACE_MINUTES } from '../constants';
import { updateWorkspaceShiftSchedule } from '../services/inventoryService';
import type { ShiftSchedule, Workspace } from '../types';
import { formatTime12h, normalizeShiftSchedule, validateShiftSchedule } from '../utils/schedule';

interface ShiftScheduleModalProps {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}

export function ShiftScheduleModal({ workspace, open, onClose }: ShiftScheduleModalProps) {
  const initial = normalizeShiftSchedule(workspace.shiftSchedule);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [openingStart, setOpeningStart] = useState(initial.openingStart);
  const [openingEnd, setOpeningEnd] = useState(initial.openingEnd);
  const [closingStart, setClosingStart] = useState(initial.closingStart);
  const [closingEnd, setClosingEnd] = useState(initial.closingEnd);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const synced = normalizeShiftSchedule(workspace.shiftSchedule);
    setEnabled(synced.enabled);
    setOpeningStart(synced.openingStart);
    setOpeningEnd(synced.openingEnd);
    setClosingStart(synced.closingStart);
    setClosingEnd(synced.closingEnd);
    setErrorMsg(null);
  }, [open, workspace.shiftSchedule]);

  const validation = useMemo(
    () =>
      validateShiftSchedule({
        enabled,
        openingStart,
        openingEnd,
        closingStart,
        closingEnd,
      }),
    [enabled, openingStart, openingEnd, closingStart, closingEnd],
  );

  const handleResetDefault = () => {
    setEnabled(DEFAULT_SHIFT_SCHEDULE.enabled);
    setOpeningStart(DEFAULT_SHIFT_SCHEDULE.openingStart);
    setOpeningEnd(DEFAULT_SHIFT_SCHEDULE.openingEnd);
    setClosingStart(DEFAULT_SHIFT_SCHEDULE.closingStart);
    setClosingEnd(DEFAULT_SHIFT_SCHEDULE.closingEnd);
    setErrorMsg(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validation.valid) {
      setErrorMsg(validation.errors[0] ?? 'Horario inválido.');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const next: ShiftSchedule = {
        enabled,
        openingStart,
        openingEnd,
        closingStart,
        closingEnd,
      };
      await updateWorkspaceShiftSchedule(workspace.id, next);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error && err.message
          ? err.message
          : 'No se pudieron guardar los horarios. Verifica las horas e intenta nuevamente.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-stone-950/55 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shift-schedule-title"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2 }}
            className="bg-white border border-stone-200 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl my-8"
          >
            <div className="bg-stone-950 px-6 py-4 text-white flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <Clock className="w-5 h-5 text-orange-400 shrink-0" />
                <div className="min-w-0">
                  <h2 id="shift-schedule-title" className="font-display text-lg font-bold truncate">
                    Horarios de Apertura y Cierre
                  </h2>
                  <p className="text-xs text-stone-400 truncate">
                    Hora oficial Colombia (Bogotá) · +{WORKER_GRACE_MINUTES} min de tolerancia al cerrar
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar configuración de horarios"
                className="p-1.5 text-stone-400 hover:text-white rounded-lg shrink-0 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-5">
              {(errorMsg || validation.errors.length > 0) && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl">
                  {errorMsg ?? validation.errors[0]}
                </div>
              )}

              {validation.errors.length === 0 && validation.warnings.length > 0 && (
                <div className="p-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>{validation.warnings[0]}</span>
                </div>
              )}

              <label className="flex items-start gap-3 p-3.5 rounded-xl border border-stone-200 bg-stone-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-orange-600 rounded cursor-pointer"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-stone-900">
                    Activar acceso solo en estos horarios
                  </p>
                  <p className="text-xs text-stone-600 mt-0.5">
                    Fuera de estos rangos (+{WORKER_GRACE_MINUTES} min de gracia), las trabajadoras no podrán guardar planillas. Tú como jefe siempre tienes acceso total.
                  </p>
                </div>
              </label>

              <div className={`space-y-4 transition-opacity ${enabled ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                {/* Opening Schedule */}
                <div className="p-4 rounded-2xl border border-stone-200 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-bold text-stone-900">
                      <Sun className="w-4 h-4 text-orange-600 shrink-0" />
                      <span>1. Apertura y ajuste de surtido</span>
                    </div>
                    <span className="text-xs font-mono text-orange-700 font-semibold">
                      {formatTime12h(openingStart)} – {formatTime12h(openingEnd)}
                    </span>
                  </div>
                  <p className="text-xs text-stone-600">
                    Para registrar con cuánto abren el día y anotar si llegaron productos nuevos (cierra justo a la hora &ldquo;Hasta&rdquo;).
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Desde
                      </label>
                      <input
                        type="time"
                        required
                        value={openingStart}
                        onChange={(e) => setOpeningStart(e.target.value)}
                        className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Hasta (límite exacto)
                      </label>
                      <input
                        type="time"
                        required
                        value={openingEnd}
                        onChange={(e) => setOpeningEnd(e.target.value)}
                        className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                      />
                    </div>
                  </div>
                </div>

                {/* Closing Schedule */}
                <div className="p-4 rounded-2xl border border-stone-200 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-bold text-stone-900">
                      <Moon className="w-4 h-4 text-stone-800 shrink-0" />
                      <span>2. Cierre del día</span>
                    </div>
                    <span className="text-xs font-mono text-stone-800 font-semibold">
                      {formatTime12h(closingStart)} – {formatTime12h(closingEnd)}
                    </span>
                  </div>
                  <p className="text-xs text-stone-600">
                    Al terminar la jornada para anotar lo que quedó. Si pasa de medianoche (ej. 11:00 p. m. a 2:00 a. m.), se vincula automáticamente a la misma noche de trabajo.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Desde
                      </label>
                      <input
                        type="time"
                        required
                        value={closingStart}
                        onChange={(e) => setClosingStart(e.target.value)}
                        className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-stone-700 mb-1">
                        Hasta (límite exacto)
                      </label>
                      <input
                        type="time"
                        required
                        value={closingEnd}
                        onChange={(e) => setClosingEnd(e.target.value)}
                        className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleResetDefault}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-600 hover:text-orange-600 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Restaurar 4–6 PM / 11 PM–2 AM
                </button>

                <div className="flex items-center gap-2 ml-auto">
                  <button
                    type="button"
                    onClick={onClose}
                    className="min-h-[42px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={saving || !validation.valid}
                    className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 disabled:opacity-60 cursor-pointer"
                  >
                    {saving ? 'Guardando...' : 'Guardar horarios'}
                  </button>
                </div>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
