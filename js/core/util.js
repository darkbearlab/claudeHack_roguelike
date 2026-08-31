// Small shared helpers. Nothing here knows about the game.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const sgn   = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** The eight compass directions, in the order NetHack's yubn/hjkl keys sit. */
export const DIRS = [
  { dx: -1, dy:  0, key: 'h', name: 'west' },
  { dx: -1, dy: -1, key: 'y', name: 'northwest' },
  { dx:  0, dy: -1, key: 'k', name: 'north' },
  { dx:  1, dy: -1, key: 'u', name: 'northeast' },
  { dx:  1, dy:  0, key: 'l', name: 'east' },
  { dx:  1, dy:  1, key: 'n', name: 'southeast' },
  { dx:  0, dy:  1, key: 'j', name: 'south' },
  { dx: -1, dy:  1, key: 'b', name: 'southwest' },
];

export const DIR_BY_KEY = Object.fromEntries(DIRS.map((d) => [d.key, d]));

export const CARDINAL = DIRS.filter((d) => d.dx === 0 || d.dy === 0);

/** Chebyshev distance - the one that matches how movement actually works. */
export const dist = (x1, y1, x2, y2) => Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
/** Squared euclidean, for "within a circle" tests without a sqrt. */
export const dist2 = (x1, y1, x2, y2) => (x1 - x2) ** 2 + (y1 - y2) ** 2;

export function dirTowards(fx, fy, tx, ty) {
  return { dx: sgn(tx - fx), dy: sgn(ty - fy) };
}

/** "a sword" / "an apple" - good enough for the vocabulary this game uses. */
export function anArticle(word) {
  const w = String(word).trim();
  if (!w) return '';
  const first = w[0].toLowerCase();
  // "a unicorn horn", "a uniform" - u-as-in-you takes "a".
  if (first === 'u' && /^u(ni|ri|se|su|ni)/i.test(w)) return 'a';
  return 'aeiou'.includes(first) ? 'an' : 'a';
}

export function withArticle(name) {
  if (/^(the|a|an|your|his|her|their|some|\d)/i.test(name)) return name;
  return `${anArticle(name)} ${name}`;
}

export function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "3 gold pieces" / "1 gold piece" */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many ?? one + 's'}`;
}

/** Join a list the way English does. */
export function listJoin(items) {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** +3 / -1 / +0 - NetHack always shows the sign. */
export const signed = (n) => (n >= 0 ? `+${n}` : String(n));

/** Deterministic 32-bit hash of two integers - used for per-cell decor noise. */
export function hash2(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return (h ^ (h >>> 13)) >>> 0;
}

/** Bresenham line, inclusive of both ends. */
export function line(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (let guard = 0; guard < 1000; guard++) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
  }
  return pts;
}

/** Milliseconds -> "1h 04m", for the end-of-game dump. */
export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Roman numerals, for dungeon-level flavour text. */
export function roman(n) {
  const t = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
             [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let out = '';
  for (const [v, s] of t) while (n >= v) { out += s; n -= v; }
  return out;
}
