// Attack shapes.
//
// A pattern is written once, facing east, and rotated to wherever the attacker
// is looking. That is the only reason facing exists as a *rule* in this game -
// the sprites also turn, but that is presentation. What matters mechanically is
// that "the three tiles in front of it" means something different depending on
// which way the brute is looking, and the player can see which way that is.
//
// Rotation is a plain 2x2: the pattern's (1,0) is mapped onto the facing
// vector. Diagonal facings use the unit diagonal and the result is rounded,
// which lands every offset back on the grid - a three-tile arc facing
// south-east really is three tiles, not two overlapping ones.

import { DIRS } from '../../../engine/util.js';

const SQ = Math.SQRT1_2;   // 0.7071

/** Patterns are lists of [x, y] offsets in "facing east" space. */
export const PATTERNS = {
  front:    [[1, 0]],
  arc3:     [[1, -1], [1, 0], [1, 1]],
  reach2:   [[1, 0], [2, 0]],
  around:   [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]],
  around2:  [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
             [2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [2, -2], [-2, 2], [-2, -2]],
  cleave:   [[1, -1], [1, 0], [1, 1], [2, 0]],
};

/** Normalise any direction to a unit vector, diagonals included. */
export function unit(dx, dy) {
  if (!dx && !dy) return { x: 1, y: 0 };
  if (dx && dy) return { x: Math.sign(dx) * SQ, y: Math.sign(dy) * SQ };
  return { x: Math.sign(dx), y: Math.sign(dy) };
}

/** Rotate one offset from "facing east" space into the attacker's facing. */
export function rotate(ox, oy, dx, dy) {
  const f = unit(dx, dy);
  return {
    x: Math.round(ox * f.x - oy * f.y),
    y: Math.round(ox * f.y + oy * f.x),
  };
}

/**
 * Absolute tiles an attack covers.
 * Deduplicated, because rounding a diagonal rotation can collapse two offsets
 * onto one tile and a doubled tile would deal doubled damage.
 */
export function attackTiles(x, y, dx, dy, patternName) {
  const pat = PATTERNS[patternName] ?? PATTERNS.front;
  const seen = new Set();
  const out = [];
  for (const [ox, oy] of pat) {
    const r = rotate(ox, oy, dx, dy);
    const tx = x + r.x, ty = y + r.y;
    const k = tx * 10000 + ty;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x: tx, y: ty });
  }
  return out;
}

/** Snap an arbitrary vector to the nearest of the eight movement directions. */
export function snapDir(dx, dy) {
  if (!dx && !dy) return { dx: 0, dy: -1 };
  const ang = Math.atan2(dy, dx);
  const oct = ((Math.round((ang / Math.PI) * 4) % 8) + 8) % 8;
  const table = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const [x, y] = table[oct];
  return { dx: x, dy: y };
}

/** The facing angle in radians, for rotating a sprite drawn pointing north. */
export function facingAngle(dx, dy) {
  if (!dx && !dy) return 0;
  return Math.atan2(dy, dx) + Math.PI / 2;
}

export { DIRS };
