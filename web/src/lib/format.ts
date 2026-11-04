const pad = (n: number) => String(n).padStart(2, '0');

/** The local wall-clock time, which is what the server keeps for a photo with no EXIF date. */
export function toWallClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Taken-at values have no zone, so they are built from their parts and never parsed as UTC. */
function parseWallClock(value: string): Date {
  const [y, mo, d, h = 0, mi = 0, s = 0] = value.split(/[-T:]/).map(Number);
  return new Date(y!, (mo ?? 1) - 1, d ?? 1, h, mi, s);
}

export function dayLabel(day: string, now = new Date()): string {
  const date = parseWallClock(day);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((startOfToday - date.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

export function monthLabel(takenAt: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(parseWallClock(takenAt));
}

export function fullDate(takenAt: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(parseWallClock(takenAt));
}

export function timeOfDay(takenAt: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(parseWallClock(takenAt));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatCount(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatExposure(seconds: number): string {
  return seconds >= 1 ? `${seconds}s` : `1/${Math.round(1 / seconds)}s`;
}

export function formatMegapixels(width: number, height: number): string {
  return `${((width * height) / 1_000_000).toFixed(1)} MP`;
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toUpperCase() : '';
}
