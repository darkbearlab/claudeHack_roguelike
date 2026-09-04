// Terrain.
//
// Copied from claudeHack and cut down. claudeSouls has no shops, no altars, no
// fountains and no sinks - it is a combat game, and terrain that exists to be
// interacted with rather than fought around is dead weight here. What it adds
// is the bonfire, which is the only piece of terrain in this game with a rule
// attached to it.
//
// The door ids stay as separate constants rather than one id plus a state
// field, for the same reason as in claudeHack: the map is then a flat
// Uint8Array with no side table.

export const T = {
  STONE:       0,   // undug rock
  WALL:        1,
  FLOOR:       2,
  CORRIDOR:    3,
  DOOR_CLOSED: 4,
  DOOR_OPEN:   5,
  DOOR_BROKEN: 6,
  STAIRS_DOWN: 7,
  STAIRS_UP:   8,
  BONFIRE:     9,
  RUBBLE:     10,   // blocks movement, not sight - cover you can shoot over
  PIT:        11,   // blocks movement for walkers, projectiles fly over
  CHEST:      12,   // walk onto it, then press the context button
  CORPSE:     13,   // where you died, holding what you had not banked
  // The first terrain in this game that blocks movement AND sight without
  // being a wall. Rubble and pits both stop feet without stopping eyes, which
  // is deliberate - one decides who can reach whom, the other who can shoot
  // whom - but it left nothing at all that breaks a line of sight inside a
  // room. A colonnade needs exactly that: cover you can lose someone behind.
  PILLAR:     14,
};

const def = (name, glyph, colour, walk, opaque, extra = {}) =>
  ({ name, glyph, colour, walk, opaque, ...extra });

export const TILE = [];
TILE[T.STONE]       = def('solid rock',   ' ', '#0b0d11', false, true);
TILE[T.WALL]        = def('wall',         '#', '#7d776c', false, true);
TILE[T.FLOOR]       = def('floor',        '.', '#645e54', true,  false);
TILE[T.CORRIDOR]    = def('corridor',     '#', '#6e6659', true,  false);
TILE[T.DOOR_CLOSED] = def('closed door',  '+', '#a9743a', false, true,  { door: true });
TILE[T.DOOR_OPEN]   = def('open door',    '|', '#a9743a', true,  false, { door: true });
TILE[T.DOOR_BROKEN] = def('broken door',  '.', '#a9743a', true,  false, { door: true });
TILE[T.STAIRS_DOWN] = def('stairs down',  '>', '#e8e2d0', true,  false);
TILE[T.STAIRS_UP]   = def('stairs up',    '<', '#e8e2d0', true,  false);
TILE[T.BONFIRE]     = def('bonfire',      '&', '#ff9a3c', true,  false, { bonfire: true });
TILE[T.RUBBLE]      = def('rubble',       '*', '#8a8378', false, false);
TILE[T.PILLAR]      = def('pillar',       'I', '#9a9184', false, true);
TILE[T.PIT]         = def('pit',          '^', '#2a2a30', false, false, { pit: true });
// Both are walkable: you stand on them and then take what is there. Making
// them obstacles would mean a guard could body-block the loot forever.
TILE[T.CHEST]       = def('chest',        '(', '#c08a3c', true,  false, { chest: true });
TILE[T.CORPSE]      = def('your remains', '%', '#c8c0b0', true,  false, { corpse: true });

export const isWalkable = (t) => TILE[t].walk;
export const isOpaque   = (t) => TILE[t].opaque;
export const isDoor     = (t) => !!TILE[t].door;
export const isBonfire  = (t) => t === T.BONFIRE;
export const isChest    = (t) => t === T.CHEST;
export const isCorpse   = (t) => t === T.CORPSE;
export const tileName   = (t) => TILE[t].name;

/** Can a projectile pass through? Rubble is cover you shoot over; walls are not. */
export const flyable = (t) => isWalkable(t) || t === T.PIT || t === T.RUBBLE;

/**
 * Doorways cannot be entered or left diagonally.
 *
 * Same rule as claudeHack, and for the same reason: it stops things slipping
 * past each other at a corridor mouth, which matters more here than there -
 * funnelling enemies into a doorway is the core defensive skill of this game.
 */
export const blocksDiagonal = (t) => t >= T.DOOR_CLOSED && t <= T.DOOR_BROKEN;

export function diagonalOk(level, fx, fy, tx, ty) {
  if (fx === tx || fy === ty) return true;
  return !blocksDiagonal(level.at(fx, fy)) &&
         !blocksDiagonal(level.at(tx, ty)) &&
         !blocksDiagonal(level.at(tx, fy)) &&
         !blocksDiagonal(level.at(fx, ty));
}
