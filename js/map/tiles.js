// Terrain types.
//
// Doors get four separate ids rather than one id plus a state field. That makes
// the map a flat Uint8Array with no side table, which the renderer, the field
// of view and the save file all benefit from. The cost is four constants
// instead of one; that is a good trade.

export const T = {
  STONE:       0,   // undug rock. Not floor, not wall - you cannot see it, only bump it.
  WALL:        1,
  FLOOR:       2,
  CORRIDOR:    3,
  DOOR_CLOSED: 4,
  DOOR_OPEN:   5,
  DOOR_BROKEN: 6,   // a doorway with no door left in it
  DOOR_LOCKED: 7,
  SDOOR:       8,   // secret door - looks like wall until searched out
  SCORR:       9,   // secret corridor - looks like stone
  STAIRS_DOWN: 10,
  STAIRS_UP:   11,
  LADDER_DOWN: 12,
  LADDER_UP:   13,
  ALTAR:       14,
  FOUNTAIN:    15,
  SINK:        16,
  THRONE:      17,
  GRAVE:       18,
  WATER:       19,
  LAVA:        20,
  TREE:        21,
  BARS:        22,
  CLOUD:       23,
};

// walk   - can a normal walker enter it
// opaque - does it block line of sight
// dig    - can it be dug through
const def = (name, glyph, colour, walk, opaque, extra = {}) =>
  ({ name, glyph, colour, walk, opaque, dig: true, ...extra });

export const TILE = [];
TILE[T.STONE]       = def('solid rock',      ' ', '#0b0d11', false, true);
TILE[T.WALL]        = def('wall',            '#', '#8b8578', false, true);
TILE[T.FLOOR]       = def('floor',           '.', '#6b6558', true,  false);
TILE[T.CORRIDOR]    = def('corridor',        '#', '#7a7364', true,  false);
TILE[T.DOOR_CLOSED] = def('closed door',     '+', '#a9743a', false, true,  { door: true });
TILE[T.DOOR_OPEN]   = def('open door',       '|', '#a9743a', true,  false, { door: true });
TILE[T.DOOR_BROKEN] = def('broken door',     '.', '#a9743a', true,  false, { door: true });
TILE[T.DOOR_LOCKED] = def('locked door',     '+', '#8a5a2a', false, true,  { door: true });
TILE[T.SDOOR]       = def('wall',            '#', '#8b8578', false, true,  { secret: true });
TILE[T.SCORR]       = def('solid rock',      ' ', '#0b0d11', false, true,  { secret: true });
TILE[T.STAIRS_DOWN] = def('staircase down',  '>', '#e8e2d0', true,  false, { dig: false });
TILE[T.STAIRS_UP]   = def('staircase up',    '<', '#e8e2d0', true,  false, { dig: false });
TILE[T.LADDER_DOWN] = def('ladder down',     '>', '#c08a4a', true,  false, { dig: false });
TILE[T.LADDER_UP]   = def('ladder up',       '<', '#c08a4a', true,  false, { dig: false });
TILE[T.ALTAR]       = def('altar',           '_', '#d8d4c8', true,  false, { dig: false });
TILE[T.FOUNTAIN]    = def('fountain',        '{', '#59a5d8', true,  false, { dig: false });
TILE[T.SINK]        = def('sink',            '{', '#9aa0a6', true,  false, { dig: false });
TILE[T.THRONE]      = def('opulent throne',  '\\','#e0b64a', true,  false, { dig: false });
TILE[T.GRAVE]       = def('grave',           '|', '#9aa0a6', true,  false);
TILE[T.WATER]       = def('water',           '}', '#2f6fb0', true,  false, { liquid: true, dig: false });
TILE[T.LAVA]        = def('lava',            '}', '#d9531e', true,  false, { liquid: true, dig: false });
TILE[T.TREE]        = def('tree',            '#', '#3d7a35', false, true);
TILE[T.BARS]        = def('iron bars',       '#', '#7f8b96', false, false, { dig: false });
TILE[T.CLOUD]       = def('cloud',           '#', '#b9c0c8', true,  true,  { dig: false });

export const isWalkable = (t) => TILE[t].walk;
export const isOpaque   = (t) => TILE[t].opaque;
export const isDoor     = (t) => !!TILE[t].door;
export const isStairs   = (t) => t === T.STAIRS_DOWN || t === T.STAIRS_UP ||
                                 t === T.LADDER_DOWN || t === T.LADDER_UP;
export const isDown     = (t) => t === T.STAIRS_DOWN || t === T.LADDER_DOWN;
export const isUp       = (t) => t === T.STAIRS_UP   || t === T.LADDER_UP;
export const isSecret   = (t) => !!TILE[t].secret;
export const isDiggable = (t) => TILE[t].dig;
export const isRoomish  = (t) => t === T.FLOOR || t === T.ALTAR || t === T.FOUNTAIN ||
                                 t === T.SINK || t === T.THRONE || t === T.GRAVE;
export const tileName   = (t) => TILE[t].name;

/**
 * A doorway cannot be entered *or left* diagonally.
 *
 * The "or left" half is the part that is easy to get wrong, and getting it
 * wrong is not symmetric-looking in the bug report: movement refused a step
 * that the pathfinder had planned, so travel and autoexplore would stall one
 * square short of a door with "you cannot reach anywhere new". Every consumer
 * of the rule - movement, A*, the flow field - now asks this one function about
 * both endpoints and both corners.
 */
export const blocksDiagonal = (t) => t >= T.DOOR_CLOSED && t <= T.SDOOR;

/** Is this diagonal step legal on this map, ignoring occupancy? */
export function diagonalOk(level, fx, fy, tx, ty) {
  if (fx === tx || fy === ty) return true;
  return !blocksDiagonal(level.at(fx, fy)) &&
         !blocksDiagonal(level.at(tx, ty)) &&
         !blocksDiagonal(level.at(tx, fy)) &&
         !blocksDiagonal(level.at(fx, ty));
}
