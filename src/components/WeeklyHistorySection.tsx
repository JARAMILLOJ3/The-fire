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
  return (
    <section className="bg-white border border-stone-200 rounded-2xl overflow-hidden no-print">
      <div className="px-4 sm:px-5 py-4 border-b border-stone-200 flex flex-wrap items-center justify-between gap-2">
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
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
              <th className="py-3 px-4 sm:px-5 min-w-[150px]">Puesto</th>
              {weeklyHistory.dates.map((date) => {
                const { weekday, dayNum } = formatShortDayHeader(date);
                const isSelected = date === selectedDate;
                return (
                  <th key={date} className="py-2 px-1.5 sm:px-2 text-center min-w-[64px]">
                    <button
                      type="button"
                      onClick={() => onSelectDate(date)}
                      className={`min-w-[44px] min-h-[44px] sm:min-h-[38px] px-2 py-1 rounded-lg transition-colors cursor-pointer ${
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
              <th className="py-3 px-4 text-right whitespace-nowrap">Cumplimiento</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 text-xs">
            {weeklyHistory.rows.map((stRow) => (
              <tr key={stRow.station.id} className="hover:bg-stone-50/70">
                <td className="py-3 px-4 sm:px-5">
                  <p className="font-semibold text-stone-900 truncate max-w-[170px]">
                    {stRow.station.name}
                  </p>
                  <p className="text-[11px] text-stone-500 truncate max-w-[170px]">
                    {stRow.station.workerName}
                  </p>
                </td>
                {stRow.days.map((cell) => {
                  const isSelected = cell.date === selectedDate;
                  const label =
                    cell.status === 'completed'
                      ? 'Listo'
                      : cell.status === 'opening_saved'
                        ? cell.isLate
                          ? 'Sin cierre'
                          : 'Apertura'
                        : cell.isLate
                          ? 'Faltó'
                          : 'Pend.';
                  const tone =
                    cell.status === 'completed'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : cell.isLate
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : cell.status === 'opening_saved'
                          ? 'bg-amber-50 text-amber-800 border-amber-200'
                          : 'bg-stone-100 text-stone-600 border-stone-200';
                  return (
                    <td key={cell.date} className="py-2 px-1 sm:px-1.5 text-center">
                      <button
                        type="button"
                        onClick={() => onSelectDate(cell.date)}
                        title={
                          cell.anomalyCount > 0
                            ? `${cell.anomalyCount} anomalía(s) de consumo`
                            : formatDateHuman(cell.date)
                        }
                        className={`w-full min-h-[44px] sm:min-h-[36px] px-2 py-1.5 rounded-lg border font-semibold transition-all cursor-pointer ${tone} ${
                          isSelected ? 'ring-2 ring-orange-500 ring-offset-1' : ''
                        }`}
                      >
                        <div className="leading-tight">{label}</div>
                        {cell.anomalyCount > 0 && (
                          <div className="text-[10px] text-red-700 font-mono leading-tight mt-0.5">
                            {cell.anomalyCount} anom.
                          </div>
                        )}
                      </button>
                    </td>
                  );
                })}
                <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                  <span
                    className={`font-bold ${
                      stRow.completedCount >= 6
                        ? 'text-emerald-700'
                        : stRow.lateCount > 0
                          ? 'text-red-700'
                          : 'text-stone-800'
                    }`}
                  >
                    {stRow.completedCount}/7
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
