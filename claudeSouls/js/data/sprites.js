// Which way each piece of artwork already points.
//
// The renderer rotates a sprite to match its owner's facing, which requires
// knowing which way the art points *before* any rotation. That sounds like a
// detail and it is the whole thing: get it wrong and the character is drawn
// backwards, which in a game about reading which way a brute is about to swing
// is not a cosmetic problem.
//
// The original code assumed north for every sprite. Combined with the resting
// facing being south, that meant a character standing still was drawn rotated a
// full 180 degrees - upside down - which is what made this visible at all.
//
// Audited by eye against tools/facing.html, one sprite at a time: **all of it
// points south.** That is not a coincidence, it is what the asset prompt
// produced - it asked for a straight overhead view in which "a face or frontal
// detail cannot be seen at all", and what came back was consistently a front
// view. I had read two of these as back views from the static art (the ranger's
// quiver, the dragon's wings) and was wrong about both; the person looking at
// them move is the one who can tell.
//
// The table is kept even though every row currently agrees with the default,
// because "checked, and it is south" and "nobody has looked at this one" are
// different states and the file should say which is which. New art goes in with
// its own value rather than inheriting a default nobody verified.
//
// Values are compass points: 'N' 'NE' 'E' 'SE' 'S' 'SW' 'W' 'NW'.

export const DEFAULT_ART_FACING = 'S';

export const ART_FACING = {
  hero_ranger: 'S',
  hero_fighter: 'S',
  // The five armour states. Checked on the contact sheet the same way as the
  // rest: each one shows a face and a chest, so each one is a front view.
  hero_rags: 'S',
  hero_leathers: 'S',
  hero_brigandine: 'S',
  hero_mail: 'S',
  hero_plate: 'S',
  mon_jackal: 'S',
  mon_spider: 'S',    // radially symmetric; any value is equally correct
  mon_zombie: 'S',
  mon_skeleton: 'S',
  mon_soldier: 'S',
  mon_wraith: 'S',
  mon_lich: 'S',
  mon_troll: 'S',
  mon_minotaur: 'S',
  mon_dragon: 'S',
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
