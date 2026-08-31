// Field of view: recursive shadowcasting over eight octants.
//
// Two things make roguelike FOV feel right rather than merely correct:
//
//  1. Walls you can see the *face* of must light up, even though they are
//     opaque. Naive shadowcasting leaves a room outlined in darkness.
//  2. An unlit room should only show the square you stand on and its
//     neighbours, while a lit room shows entirely once you are inside it. That
//     is what makes carrying a light source matter.
//
// Both are handled here rather than in the renderer, because "what the hero can
// see" is a rule of the game - monsters use the same predicate to decide
// whether they can see you.

const OCTANTS = [
  [ 1,  0,  0,  1], [ 0,  1,  1,  0], [ 0, -1,  1,  0], [-1,  0,  0,  1],
  [-1,  0,  0, -1], [ 0, -1, -1,  0], [ 0,  1, -1,  0], [ 1,  0,  0, -1],
];

/**
 * Recompute level.visible from (ox,oy).
 * @param {Level} level
 * @param {number} radius  how far light carries at all
 * @param {boolean} blind  if true, only the hero's own square is visible
 */
export function computeFOV(level, ox, oy, radius, blind = false) {
  level.clearVisible();
  if (!level.inBounds(ox, oy)) return;

  level.markSeen(ox, oy);
  if (blind) return;

  for (const [xx, xy, yx, yy] of OCTANTS) {
    castLight(level, ox, oy, 1, 1.0, 0.0, radius, xx, xy, yx, yy);
  }

  // Lit rooms reveal wholesale once you are inside them - including the walls,
  // which shadowcasting alone will not do for the corners.
  const room = level.roomAt(ox, oy);
  if (room && room.lit) revealRoom(level, room);
}

function castLight(level, ox, oy, row, startSlope, endSlope, radius, xx, xy, yx, yy) {
  if (startSlope < endSlope) return;
  const r2 = radius * radius;
  let nextStart = startSlope;

  for (let d = row; d <= radius; d++) {
    let blocked = false;
    for (let dx = -d, dy = -d; dx <= 0; dx++) {
      const l = (dx - 0.5) / (dy + 0.5);
      const r = (dx + 0.5) / (dy - 0.5);
      if (r > nextStart) continue;
      if (l < endSlope) break;

      const cx = ox + dx * xx + dy * xy;
      const cy = oy + dx * yx + dy * yy;
      if (!level.inBounds(cx, cy)) continue;

      if (dx * dx + dy * dy <= r2) level.markSeen(cx, cy);

      const wall = level.opaque(cx, cy);
      if (blocked) {
        if (wall) { nextStart = r; continue; }
        blocked = false; startSlope = nextStart;
      } else if (wall && d < radius) {
        blocked = true;
        castLight(level, ox, oy, d + 1, startSlope, l, radius, xx, xy, yx, yy);
        nextStart = r;
      }
    }
    if (blocked) break;
  }
}

function revealRoom(level, room) {
  for (let y = room.y - 1; y <= room.y + room.h; y++) {
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (level.inBounds(x, y)) level.markSeen(x, y);
    }
  }
}

/**
 * Straight, symmetric line of sight - used for "can this monster see the hero",
 * for thrown objects and for wand rays. Deliberately not the same function as
 * the hero's FOV: this one ignores lighting entirely.
 */
export function hasLOS(level, x0, y0, x1, y1, maxDist = 99) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  if (Math.max(dx, dy) > maxDist) return false;
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0, guard = 0;
  while (guard++ < 200) {
    if (x === x1 && y === y1) return true;
    if (!(x === x0 && y === y0) && level.opaque(x, y)) return false;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
  }
  return false;
}

/** Light radius from the hero's equipment and the ambient level lighting. */
export function lightRadius(player, level) {
  if (player.hasStatus('blind')) return 0;
  let r = 1;                                  // you can always feel your own square
  if (player.lightSource) r = player.lightSource;
  const room = level.roomAt(player.x, player.y);
  if (room && room.lit) r = Math.max(r, 12);
  else if (level.lit[level.idx(player.x, player.y)]) r = Math.max(r, 8);
  return r;
}
