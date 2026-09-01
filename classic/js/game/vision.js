// How far the hero can see - the game's half of field of view.
//
// engine/fov.js knows how light propagates through a grid. It does not know
// what a lamp is, or that being blind is a thing, or that rooms have their own
// lighting. Those are claudeHack's rules, so they live here. The split fell out
// of separating the engine from the games: lightRadius was the one function in
// the FOV module that reached into the player object.

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
