// Which way each piece of artwork already points.
//
// The renderer rotates a sprite to match its owner's facing, which requires
// knowing which way the art points *before* any rotation. That sounds like a
// detail and it is the whole thing: get it wrong and the character is drawn
// backwards, which in a game about reading which way a brute is about to swing
// is not a cosmetic problem.
//
// The generated art is NOT consistent, and it cannot be - the prompt asked for
// a straight overhead view where "a face or frontal detail cannot be seen at
// all", so the model had no reason to pick a consistent forward direction. Most
// of what came back reads as a front view (you see the visor, the muzzle, the
// chest) and so points SOUTH. A couple read as back views (you see the quiver,
// the wings from behind) and point NORTH.
//
// The original code assumed north for everything. Combined with the default
// facing being south, that meant a character standing still was drawn rotated a
// full 180 degrees - upside down - which is what made this visible in the first
// place.
//
// Values are compass points: 'N' 'NE' 'E' 'SE' 'S' 'SW' 'W' 'NW'.
// Anything not listed uses DEFAULT_ART_FACING.
//
// To re-check these by eye, open tools/facing.html - it draws every sprite as
// the game would draw it in all eight directions and lets you flip each one.

export const DEFAULT_ART_FACING = 'S';

export const ART_FACING = {
  // Back views: you are looking at the quiver and the shoulder blades.
  hero_ranger: 'N',
  mon_dragon: 'N',

  // Front views. Listed explicitly rather than left to the default, because
  // "we checked this one and it really is south" and "nobody has looked at this
  // one yet" are different states and the table should say which is which.
  hero_fighter: 'S',
  mon_jackal: 'S',
  mon_zombie: 'S',
  mon_skeleton: 'S',
  mon_soldier: 'S',
  mon_wraith: 'S',
  mon_lich: 'S',
  mon_troll: 'S',
  mon_minotaur: 'S',

  // Radially symmetric - there is no front to get wrong, and any value here is
  // equally correct. Kept in the table so nobody spends time squinting at it.
  mon_spider: 'S',
};

const VECTORS = {
  N: { dx: 0, dy: -1 }, NE: { dx: 1, dy: -1 },
  E: { dx: 1, dy: 0 }, SE: { dx: 1, dy: 1 },
  S: { dx: 0, dy: 1 }, SW: { dx: -1, dy: 1 },
  W: { dx: -1, dy: 0 }, NW: { dx: -1, dy: -1 },
};

export const COMPASS = Object.keys(VECTORS);

/** The direction a sprite's art points, as a vector. */
export function artVector(sprite) {
  return VECTORS[ART_FACING[sprite] ?? DEFAULT_ART_FACING] ?? VECTORS.S;
}
