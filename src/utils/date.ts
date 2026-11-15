export const BOGOTA_TIME_ZONE = 'America/Bogota';
export const OPERATIONAL_DAY_CUTOFF_HOUR = 6; // Antes de las 6:00 a. m. pertenece al día operativo anterior

export interface BogotaNowParts {
  dateStr: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  totalMinutes: number;
  hhmm: string;
}

const bogotaFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOGOTA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function getBogotaNowParts(now: Date = new Date()): BogotaNowParts {
  const parts = bogotaFormatter.formatToParts(now);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  const year = Number(map.year) || now.getUTCFullYear();
  const month = Number(map.month) || now.getUTCMonth() + 1;
  const day = Number(map.day) || now.getUTCDate();
  const rawHour = Number(map.hour);
  const hour = Number.isFinite(rawHour) ? rawHour % 24 : 0;
  const minute = Number(map.minute) || 0;

  const yStr = String(year).padStart(4, '0');
  const mStr = String(month).padStart(2, '0');
  const dStr = String(day).padStart(2, '0');
  const hStr = String(hour).padStart(2, '0');
  const minStr = String(minute).padStart(2, '0');

  return {
    dateStr: `${yStr}-${mStr}-${dStr}`,
    year,
    month,
    day,
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
    hhmm: `${hStr}:${minStr}`,
  };
}

export function shiftDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const py = String(dt.getUTCFullYear()).padStart(4, '0');
  const pm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const pd = String(dt.getUTCDate()).padStart(2, '0');
  return `${py}-${pm}-${pd}`;
}

export function getPreviousDateStr(dateStr: string): string {
  return shiftDateStr(dateStr, -1);
}

/**
 * Calcula el día operativo oficial en hora America/Bogota.
 * Entre las 00:00 y las 05:59 a. m., el día operativo sigue siendo el de ayer.
 */
export function getOperationalDateStr(now: Date = new Date()): string {
  const bogota = getBogotaNowParts(now);
  if (bogota.hour < OPERATIONAL_DAY_CUTOFF_HOUR) {
    return getPreviousDateStr(bogota.dateStr);
  }
  return bogota.dateStr;
}

const bogotaTimeWithSecondsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOGOTA_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function formatBogotaTimeExact(now: Date = new Date()): string {
  const parts = bogotaTimeWithSecondsFormatter.formatToParts(now);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  const hour = String((Number(map.hour) || 0) % 24).padStart(2, '0');
  const minute = String(Number(map.minute) || 0).padStart(2, '0');
  const second = String(Number(map.second) || 0).padStart(2, '0');
  return `${hour}:${minute}:${second}`;
}

let serverTimeOffsetMs = 0;
let lastServerSyncAtMs = 0;

export function getServerTimeOffsetMs(): number {
  return serverTimeOffsetMs;
}

export function setServerTimeOffsetMs(offsetMs: number): void {
  serverTimeOffsetMs = Number.isFinite(offsetMs) ? offsetMs : 0;
}

export function getServerNow(localNowMs: number = Date.now()): Date {
  return new Date(localNowMs + serverTimeOffsetMs);
}

export async function syncServerClockOffset(force = false): Promise<number> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return serverTimeOffsetMs;
  }
  const nowMs = Date.now();
  if (!force && lastServerSyncAtMs > 0 && nowMs - lastServerSyncAtMs < 60_000) {
    return serverTimeOffsetMs;
  }

  try {
    const reqStart = Date.now();
    const res = await fetch(`/?__ts=${reqStart}`, {
      method: 'HEAD',
      cache: 'no-store',
    });
    const reqEnd = Date.now();
    const dateHeader = res.headers.get('date');
    if (dateHeader) {
      const serverMs = Date.parse(dateHeader);
      if (Number.isFinite(serverMs)) {
        const midpoint = Math.round((reqStart + reqEnd) / 2);
        serverTimeOffsetMs = serverMs - midpoint;
        lastServerSyncAtMs = reqEnd;
      }
    }
  } catch {
    // Keep existing offset / local fallback when offline or unreachable
  }

  return serverTimeOffsetMs;
}

