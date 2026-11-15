import { useState } from 'react';
import { Check, Clock, Copy, MessageSquare, Moon, Sun } from 'lucide-react';
import type { Workstation } from '../../types';
import { formatDateHuman } from '../../utils/inventory';
import { getNextScheduleWindowInfo, type WorkerScheduleStatus } from '../../utils/schedule';

interface ShiftOutsideHoursViewProps {
  station: Workstation;
  selectedDate: string;
  scheduleStatus: WorkerScheduleStatus;
}

export function ShiftOutsideHoursView({
  station,
  selectedDate,
  scheduleStatus,
}: ShiftOutsideHoursViewProps) {
  const [showRequestBox, setShowRequestBox] = useState(false);
  const [copiedMsg, setCopiedMsg] = useState(false);

  const nextWindow = getNextScheduleWindowInfo(new Date(), scheduleStatus.schedule);
  const hours = Math.floor(nextWindow.minutesUntil / 60);
  const mins = nextWindow.minutesUntil % 60;
  const countdownText =
    hours > 0 ? `en ${hours} h ${mins > 0 ? `${mins} min` : ''}`.trim() : `en ${mins} min`;

  const requestMessage = `Hola jefe, necesito registrar o corregir el inventario del puesto ${station.name} (${formatDateHuman(selectedDate)}) fuera de horario. ¿Me ayudas habilitándolo?`;

  const handleCopyRequest = async () => {
    try {
      await navigator.clipboard.writeText(requestMessage);
      setCopiedMsg(true);
      globalThis.setTimeout(() => setCopiedMsg(false), 2500);
    } catch {
      // Clipboard blocked
    }
  };

  return (
    <div className="py-4 sm:py-10 flex items-center justify-center min-w-0">
      <div className="w-full max-w-lg bg-white border border-stone-200 rounded-2xl p-5 sm:p-8 text-center space-y-5 shadow-xs animate-tf-fade-up">
        <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-700 flex items-center justify-center mx-auto">
          <Clock className="w-6 h-6" />
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-orange-600">
            ¡Hola, {station.workerName}! · {station.name}
          </p>
          <h1 className="font-display text-2xl font-bold text-stone-900 [text-wrap:balance]">
            Fuera de horario de inventario
          </h1>
          <p className="text-sm text-stone-600 leading-relaxed">
            La planilla se habilita únicamente en los horarios configurados por el jefe.
          </p>
        </div>

        <div className="px-4 py-3 rounded-xl bg-stone-950 text-white text-sm space-y-0.5">
          <p className="text-xs text-stone-400">Próximo turno habilitado</p>
          <p className="font-semibold">
            {nextWindow.windowName}: {nextWindow.dayLabel} a las {nextWindow.startLabel}{' '}
            <span className="font-mono tabular-nums text-orange-400">({countdownText})</span>
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
          <div className="p-4 rounded-xl bg-orange-50/70 border border-orange-200/80 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-bold text-orange-800">
              <Sun className="w-4 h-4 shrink-0" />
              <span>Apertura y surtido</span>
            </div>
            <p className="font-mono tabular-nums text-sm font-bold text-stone-900">
              {scheduleStatus.openingRangeLabel}
            </p>
            <p className="text-xs text-stone-600">Confirmar inicio y llegada de productos</p>
          </div>

          <div className="p-4 rounded-xl bg-stone-100 border border-stone-200 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-bold text-stone-800">
              <Moon className="w-4 h-4 shrink-0" />
              <span>Cierre del día</span>
            </div>
            <p className="font-mono tabular-nums text-sm font-bold text-stone-900">
              {scheduleStatus.closingRangeLabel}
            </p>
            <p className="text-xs text-stone-600">Conteo final al terminar la jornada</p>
          </div>
        </div>

        <div className="pt-1 space-y-3">
          <button
            type="button"
            onClick={() => setShowRequestBox((v) => !v)}
            className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-stone-800 bg-stone-100 border border-stone-200 rounded-xl hover:bg-stone-200/70 transition-colors cursor-pointer"
          >
            <MessageSquare className="w-4 h-4 text-orange-600 shrink-0" />
            Solicitar corrección al jefe
          </button>

          {showRequestBox && (
            <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 text-left space-y-3">
              <p className="text-xs text-stone-600 leading-relaxed">
                Copia este mensaje y envíaselo por WhatsApp al jefe para que corrija o registre tu turno desde su panel:
              </p>
              <p className="p-3 rounded-lg bg-white border border-stone-200 text-xs text-stone-800">
                {requestMessage}
              </p>
              <button
                type="button"
                onClick={handleCopyRequest}
                className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 cursor-pointer"
              >
                {copiedMsg ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedMsg ? 'Mensaje copiado' : 'Copiar mensaje para WhatsApp'}
              </button>
            </div>
          )}
        </div>

        <p className="text-xs font-mono tabular-nums text-stone-500">
          Hora actual en Bogotá: {scheduleStatus.currentTimeLabel}
        </p>
      </div>
    </div>
  );
}
