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
import { artVector } from '../data/sprites.js';

const SQ = Math.SQRT1_2;   // 0.7071

/**
 * Patterns are lists of [x, y] offsets in "facing east" space.
 *
 * The set exists to make **one step backwards stop being the universal answer**.
 * Before this, every attack was reach-1 and the whole game could be played by
 * retreating one tile and walking back in - which cost no stamina, so the
 * stamina system never engaged at all. Each shape below wants a different
 * response:
 *
 *   front / arc3     step back, or sideways
 *   line3 / line6    step SIDEWAYS - retreating along the lane does nothing
 *   arc5             a wide wall; going round it takes two tiles, so: roll
 *   around           you need two tiles of movement to leave: roll
 *   sweepL / sweepR  the two halves of a combination - see enemies.js
 */
export const PATTERNS = {
  front:    [[1, 0]],
  arc3:     [[1, -1], [1, 0], [1, 1]],
  arc5:     [[1, -2], [1, -1], [1, 0], [1, 1], [1, 2]],
  reach2:   [[1, 0], [2, 0]],
  line3:    [[1, 0], [2, 0], [3, 0]],
  line6:    [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]],

  // The two halves of a sweep. Their union covers the whole front semicircle,
  // so the instinctive dodge - step to the side the blade has already passed -
  // walks straight into the second half. The escapes are backwards out of the
  // reach, or behind the attacker, and both take more than one step.
  sweepL:   [[0, -1], [1, -1], [2, -1], [1, 0]],
  sweepR:   [[0, 1], [1, 1], [2, 1], [1, 0], [2, 0]],

  // Radial. These are listed in RADIAL below and are NOT rotated: a ring has
  // no facing, and rotating one by 45 degrees rounds its outer tiles onto each
  // other - the old sparse `around2` star lost four tiles that way, and leaked
  // two more even facing east, so a single sidestep walked out of the boss's
  // signature attack. It is a solid 5x5 now: you need two tiles of movement,
  // which means a roll, which means stamina. That is the entire point of it.
  around:   [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]],
  around2:  [[-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
             [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1],
             [-2,  0], [-1,  0],           [1,  0], [2,  0],
             [-2,  1], [-1,  1], [0,  1], [1,  1], [2,  1],
             [-2,  2], [-1,  2], [0,  2], [1,  2], [2,  2]],
};

/** Shapes that have no facing, and so must not be rotated. */
export const RADIAL = new Set(['around', 'around2']);

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
  const spin = !RADIAL.has(patternName);
  const seen = new Set();
  const out = [];
  for (const [ox, oy] of pat) {
    const r = spin ? rotate(ox, oy, dx, dy) : { x: ox, y: oy };
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

/**
 * The angle, in radians, of a direction - measured so that north is 0.
 *
 * This is the *absolute* angle of a heading, not the rotation to apply to a
 * sprite. Those were the same thing only while every piece of art was assumed
 * to point north, which turned out not to be true of the generated art at all.
 * See spriteRotation() below and js/data/sprites.js.
 */
export function facingAngle(dx, dy) {
  if (!dx && !dy) return 0;
  return Math.atan2(dy, dx) + Math.PI / 2;
}

/**
 * How far to rotate a sprite so it faces the way its owner is facing.
 *
 * The art already points somewhere; rotating by the full facing angle assumes
 * that somewhere is north. Subtracting the art's own heading is the whole fix -
 * art that already points south, on a character facing south, now comes out
 * unrotated instead of upside down.
 */
export function spriteRotation(dx, dy, sprite) {
  const art = artVector(sprite);
  return facingAngle(dx, dy) - facingAngle(art.dx, art.dy);
}

export { DIRS };
