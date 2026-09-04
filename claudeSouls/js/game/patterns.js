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
/** The N tiles directly ahead, for whichever of the eight ways you are facing. */
const lane = (n) => (dx, dy) => {
  const out = [];
  for (let i = 1; i <= n; i++) out.push([dx * i, dy * i]);
  return out;
};

export const PATTERNS = {
  front:    [[1, 0]],
  arc3:     [[1, -1], [1, 0], [1, 1]],
  arc5:     [[1, -2], [1, -1], [1, 0], [1, 1], [1, 2]],

  // Lanes are computed from the facing, not rotated into it.
  //
  // Matrix rotation is right for the arcs and wrong for anything that runs
  // AWAY from the attacker. Facing south-east the unit vector is (0.71, 0.71),
  // so (1,0) and (2,0) both round to (1,1) and the lane quietly loses a tile.
  // Measured across the whole table before this was noticed: reach2 went 2 to
  // 1, line3 3 to 2, **line6 6 to 4**. A spear thrusting diagonally was a
  // one-tile attack and the pike's signature lane was a third shorter, with
  // nothing on screen to say why.
  //
  // Written as a function it is exact in all eight facings, because a lane is
  // *defined* by the direction rather than merely turned to face it.
  reach2:   lane(2),
  line3:    lane(3),
  line6:    lane(6),

  // The two halves of a sweep. Their union covers the whole front semicircle,
  // so the instinctive dodge - step to the side the blade has already passed -
  // walks straight into the second half. The escapes are backwards out of the
  // reach, or behind the attacker, and both take more than one step.
  // Computed, like the lanes and for the same reason: both have depth, so
  // rotating them diagonally collapsed the far tiles onto the near ones.
  // sweepR was losing one of its five, which puts a hole in the union the
  // pair is designed to guarantee - and the whole point of the pair is that
  // stepping aside walks into the second half.
  sweepL: (dx, dy) => {
    const [px, py] = [dy, -dx];              // the left flank
    const out = [];
    for (let i = 0; i <= 2; i++) out.push([dx * i + px, dy * i + py]);
    out.push([dx, dy]);
    return out;
  },
  sweepR: (dx, dy) => {
    const [px, py] = [-dy, dx];              // the right flank, and deeper
    const out = [];
    for (let i = 0; i <= 2; i++) out.push([dx * i + px, dy * i + py]);
    for (let i = 1; i <= 2; i++) out.push([dx * i, dy * i]);
    return out;
  },

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

  // ---- added for the character roster -----------------------------------
  // Skills bind to a person now rather than to a weapon, and eight people need
  // more than ten shapes between them: measured, the twelve weapons produced
  // only NINE distinct shape pairs, and `front` alone carried nine of the
  // twenty-four attacks. Three weapons were mechanically the same weapon.
  //
  // Each of these exists to ask a question none of the others asks.

  // Widens with distance. Standing close is the safe half of it, which is the
  // opposite of everything else here and makes backing off the wrong answer.
  // Also computed rather than rotated - it has depth, so it collapsed too.
  cone: (dx, dy) => {
    const [px, py] = [-dy, dx];              // one step across the facing
    const out = [];
    for (const k of [-1, 0, 1]) out.push([dx + px * k, dy + py * k]);
    for (const k of [-2, -1, 0, 1, 2]) out.push([dx * 2 + px * k, dy * 2 + py * k]);
    return out;
  },

  // Behind you. Worthless on its own and the point is that it is: rolling
  // through something and hitting it on the way past is one action made of two
  // that already exist.
  behind:   [[-1, 0]],

  // A ring at two, with the tiles against you deliberately left out. It is the
  // only shape that punishes distance instead of rewarding it - the answer to
  // it is to close, which is a strange thing to be forced into.
  ring2:    [[-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
             [-2, -1],                             [2, -1],
             [-2,  0],                             [2,  0],
             [-2,  1],                             [2,  1],
             [-2,  2], [-1,  2], [0,  2], [1,  2], [2,  2]],

  // Two tiles wide and two deep. Shallow, but nothing steps round the side of
  // it - and paired with a shove it moves two bodies at once, which against a
  // drop is the difference between a push and an execution.
  broad: (dx, dy) => {
    const [px, py] = [-dy, dx];
    const out = [];
    for (let i = 1; i <= 2; i++) {
      out.push([dx * i, dy * i]);
      out.push([dx * i + px, dy * i + py]);
    }
    return out;
  },
};

/**
 * Shapes that have no facing, and so must not be rotated.
 *
 * `ring2` joins the other two for the reason recorded above them: rotating a
 * ring by 45 degrees rounds its outer tiles onto each other, and a ring that
 * quietly loses tiles is a ring you can sidestep out of - which is the one
 * thing a ring is for.
 */
export const RADIAL = new Set(['around', 'around2', 'ring2']);

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
  const def = PATTERNS[patternName] ?? PATTERNS.front;
  // A function pattern is already expressed in the attacker's facing, so it is
  // used as-is; a list is written facing east and turned.
  const computed = typeof def === 'function';
  const pat = computed ? def(Math.sign(dx) || 1, Math.sign(dy) || 0) : def;
  const spin = !computed && !RADIAL.has(patternName);
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

/** The eight directions in ring order, so "adjacent direction" means something. */
const RING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

const ringIndex = (dx, dy) =>
  RING.findIndex(([x, y]) => x === Math.sign(dx) && y === Math.sign(dy));

/**
 * Does a shield facing `face` cover a blow arriving from `from`?
 *
 * `arc` is how many of the eight directions the shield covers: 1 is the one it
 * points at, 3 adds the neighbour either side. Nothing covers all eight, which
 * is what stops any shield from being the answer to being surrounded.
 */
export function blocksDirection(face, from, arc) {
  const f = ringIndex(face.dx, face.dy);
  const i = ringIndex(from.dx, from.dy);
  if (f < 0 || i < 0) return false;
  const spread = Math.max(0, Math.floor((arc - 1) / 2));
  const gap = Math.min((i - f + 8) % 8, (f - i + 8) % 8);
  return gap <= spread;
}
