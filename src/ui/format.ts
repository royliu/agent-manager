import pc from 'picocolors';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

export function bar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const glyph = '█'.repeat(filled) + '░'.repeat(width - filled);
  if (clamped >= 90) return pc.red(glyph);
  if (clamped >= 70) return pc.yellow(glyph);
  return pc.green(glyph);
}

export function pct(percent: number): string {
  const s = `${Math.round(percent)}%`.padStart(4);
  if (percent >= 90) return pc.red(s);
  if (percent >= 70) return pc.yellow(s);
  return pc.green(s);
}

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

export function usd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

export function relTime(ts: number | undefined): string {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  if (delta < 0) return untilTime(ts);
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function untilTime(ts: number | undefined): string {
  if (!ts) return '—';
  const delta = ts - Date.now();
  if (delta <= 0) return 'now';
  const mins = Math.floor(delta / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** "a, b, and c" - a list is easier to read as a sentence. */
export function listPhrase(items: string[]): string {
  if (items.length < 3) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]!}`;
}

/** Visible width, ignoring colour escape codes. */
export function width(s: string): number {
  return s.replace(ANSI, '').length;
}

export function padEnd(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - width(s)));
}

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/**
 * Truncate to a visible column count while preserving colour escapes, so a
 * clamped line never leaks styling into the rest of the terminal.
 */
export function truncateVisible(s: string, max: number): string {
  if (width(s) <= max) return s;
  let visible = 0;
  let out = '';
  let styled = false;
  for (let i = 0; i < s.length; ) {
    if (s[i] === ESC) {
      const end = s.indexOf('m', i);
      if (end === -1) break;
      out += s.slice(i, end + 1);
      styled = true;
      i = end + 1;
      continue;
    }
    if (visible >= max - 1) break;
    out += s[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${styled ? RESET : ''}`;
}

export const { dim, bold, cyan, red, yellow, green, magenta } = pc;
