import { useState } from 'react';
import { History } from 'lucide-react';
import { BOGOTA_TIME_ZONE } from '../utils/date';
import { formatDateHuman, type buildWeeklyStationHistory } from '../utils/inventory';

interface WeeklyHistorySectionProps {
  weeklyHistory: ReturnType<typeof buildWeeklyStationHistory>;
  selectedDate: string;
  todayStr: string;
  onSelectDate: (dateStr: string) => void;
}

function formatShortDayHeader(dateStr: string): { weekday: string; dayNum: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return { weekday: '', dayNum: dateStr };
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const weekday = new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    weekday: 'short',
  })
    .format(dt)
    .replace('.', '');
  return { weekday, dayNum: String(d) };
}

export function WeeklyHistorySection({
  weeklyHistory,
  selectedDate,
  todayStr,
  onSelectDate,
}: WeeklyHistorySectionProps) {
  const [showFullWeekOnMobile, setShowFullWeekOnMobile] = useState(false);
  const totalDates = weeklyHistory.dates.length;

  return (
    <section className="bg-white border border-stone-200 rounded-2xl overflow-hidden no-print">
      <div className="px-4 sm:px-5 py-4 border-b border-stone-200 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <History className="w-4 h-4 text-orange-600 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-base font-bold text-stone-900">
              Historial de los últimos 7 días por puesto
            </h2>
            <p className="text-xs text-stone-500">
              Toca cualquier día para abrir su reporte completo
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-stone-600">
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Cerrado
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            Solo apertura
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            Sin cierre
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-stone-300" />
            Sin historial
          </span>
          <button
            type="button"
            onClick={() => setShowFullWeekOnMobile((prev) => !prev)}
            className="sm:hidden min-h-[34px] px-2.5 py-1 text-xs font-semibold text-orange-700 bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 cursor-pointer"
          >
            {showFullWeekOnMobile ? 'Ver últimos 4 días' : 'Ver semana completa'}
          </button>
        </div>
      </div>

      <div className={showFullWeekOnMobile ? 'overflow-x-auto' : 'sm:overflow-x-auto'}>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
              <th className="py-3 px-3 sm:px-5 sm:min-w-[150px]">Puesto</th>
              {weeklyHistory.dates.map((date, idx) => {
                const { weekday, dayNum } = formatShortDayHeader(date);
                const isSelected = date === selectedDate;
                const hideOnCompactMobile = !showFullWeekOnMobile && idx < totalDates - 4;
                return (
                  <th
                    key={date}
                    className={`py-2 px-1 sm:px-2 text-center sm:min-w-[64px] ${
                      hideOnCompactMobile ? 'hidden sm:table-cell' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectDate(date)}
                      className={`min-w-[40px] sm:min-w-[44px] min-h-[42px] sm:min-h-[38px] px-1.5 sm:px-2 py-1 rounded-lg transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-orange-600 text-white'
                          : 'hover:bg-stone-200/70 text-stone-700'
                      }`}
                    >
                      <div className="text-[10px] uppercase leading-none opacity-80">
                        {date === todayStr ? 'Hoy' : weekday}
                      </div>
                      <div className="font-mono tabular-nums text-xs font-bold mt-0.5">
                        {dayNum}
                      </div>
                    </button>
                  </th>
                );
              })}
              <th className="py-3 px-2.5 sm:px-4 text-right whitespace-nowrap">
                <span className="hidden sm:inline">Cumplimiento</span>
                <span className="sm:hidden">Cumpl.</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 text-xs">
            {weeklyHistory.rows.map((stRow) => (
              <tr key={stRow.station.id} className="hover:bg-stone-50/70">
                <td className="py-3 px-3 sm:px-5 max-w-[115px] sm:max-w-[180px]">
                  <p className="font-semibold text-stone-900 truncate">{stRow.station.name}</p>
                  <p className="text-[11px] text-stone-500 truncate">{stRow.station.workerName}</p>
                </td>
                {stRow.days.map((cell, idx) => {
                  const isSelected = cell.date === selectedDate;
                  const hideOnCompactMobile = !showFullWeekOnMobile && idx < totalDates - 4;
                  const label = cell.isBeforeFirstReport
                    ? '—'
                    : cell.status === 'completed'
                      ? 'Listo'
                      : cell.status === 'opening_saved'
                        ? cell.isLate
                          ? 'Sin cierre'
                          : 'Apertura'
                        : cell.isLate
                          ? 'Faltó'
                          : 'Pend.';
                  const tone = cell.isBeforeFirstReport
                    ? 'bg-stone-50 text-stone-400 border-stone-200/80 font-medium'
                    : cell.status === 'completed'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : cell.isLate
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : cell.status === 'opening_saved'
                          ? 'bg-amber-50 text-amber-800 border-amber-200'
                          : 'bg-stone-100 text-stone-600 border-stone-200';
                  return (
                    <td
                      key={cell.date}
                      className={`py-2 px-0.5 sm:px-1.5 text-center ${
                        hideOnCompactMobile ? 'hidden sm:table-cell' : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => onSelectDate(cell.date)}
                        title={
                          cell.isBeforeFirstReport
                            ? `${formatDateHuman(cell.date)} · Antes del primer reporte`
                            : cell.anomalyCount > 0
                              ? `${cell.anomalyCount} anomalía(s) de consumo`
                              : formatDateHuman(cell.date)
                        }
                        className={`w-full min-h-[42px] sm:min-h-[36px] px-1.5 sm:px-2 py-1.5 rounded-lg border font-semibold transition-all cursor-pointer ${tone} ${
                          isSelected ? 'ring-2 ring-orange-500 ring-offset-1' : ''
                        }`}
                      >
                        <div className="leading-tight text-[11px] sm:text-xs">{label}</div>
                        {cell.anomalyCount > 0 && (
                          <div className="text-[10px] text-red-700 font-mono leading-tight mt-0.5">
                            {cell.anomalyCount} anom.
                          </div>
                        )}
                      </button>
                    </td>
                  );
                })}
                <td className="py-3 px-2.5 sm:px-4 text-right font-mono tabular-nums whitespace-nowrap">
                  {stRow.activeDaysCount === 0 ? (
                    <span className="font-semibold text-stone-400">—</span>
                  ) : (
                    <span
                      className={`font-bold ${
                        stRow.completedCount >= stRow.activeDaysCount
                          ? 'text-emerald-700'
                          : stRow.lateCount > 0
                            ? 'text-red-700'
                            : 'text-stone-800'
                      }`}
                    >
                      {stRow.completedCount}/{stRow.activeDaysCount}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
