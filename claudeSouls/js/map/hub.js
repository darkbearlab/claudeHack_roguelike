// The hall you leave from.
//
// A room rather than a menu, and that is the whole reason it is worth building
// at all. Everything it needs already exists - a level, a renderer, people who
// stand on tiles, a conversation system, a bonfire - so a character select
// screen would have been *more* work than a place, and a place is somewhere
// you can put a story later. See docs/META.md: the seed keeper lives here, the
// fragments come back here, and the other heroes are the people whose fragments
// you are collecting.
//
// Hand-built, not generated. It is the one floor in the game that should be
// the same every time.

import { Level } from './level.js';
import { T } from './tiles.js';
import { HEROES } from '../data/heroes.js';

export const HUB_W = 21;
export const HUB_H = 13;

/**
 * The hall, its people, and the stair out.
 *
 * The heroes stand in a row facing the fire, which is also the order they are
 * offered in - the layout IS the menu, so there is nothing to keep in sync.
 */
export function buildHub() {
  const lvl = new Level(0, HUB_W, HUB_H);
  lvl.tiles.fill(T.STONE);
  lvl.name = '灰燼之廳';

  const x0 = 2, y0 = 2, w = HUB_W - 4, h = HUB_H - 4;
  for (let y = y0 - 1; y <= y0 + h; y++) {
    for (let x = x0 - 1; x <= x0 + w; x++) {
      const inside = x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
      lvl.set(x, y, inside ? T.FLOOR : T.WALL);
    }
  }
  for (let i = 0; i < lvl.lit.length; i++) lvl.lit[i] = 1;
  for (const r of [{ x: x0, y: y0, w, h, id: 0, type: 'hall', lit: true }]) lvl.rooms.push(r);

  // The fire in the middle. You always start beside it, in every sense.
  const cx = x0 + (w >> 1), cy = y0 + (h >> 1);
  lvl.set(cx, cy, T.BONFIRE);
  lvl.bonfires.push({ x: cx, y: cy, id: 0 });

  // The way down, at the far end - and it is not yours to open. The weaver
  // stands beside it, and a run begins in her conversation rather than under
  // your feet.
  //
  // The stair stays visible on purpose. A room whose only exit is a person you
  // have not spoken to yet reads as a room with no exit, so the stair is the
  // affordance and she is the gate: walk to the far end, find her there.
  const gate = { x: x0 + w - 2, y: cy };
  lvl.set(gate.x, gate.y, T.STAIRS_DOWN);
  lvl.downStair = { ...gate };

  // The heroes, along the near wall, in the order they are listed.
  const top = cy - ((HEROES.length - 1) >> 1);
  HEROES.forEach((h2, i) => {
    lvl.npcs.push({ key: `hero:${h2.key}`, x: x0 + 2, y: top + i });
  });
  // And the keeper, on the other side of the fire.
  lvl.npcs.push({ key: 'firekeeper', x: cx + 2, y: cy });
  // The weaver, one tile short of the stair and off the line of it - beside
  // the door, not in it. She is the only way down, which makes "standing on
  // the one tile everybody has to cross" exactly the mistake that turned the
  // fire keeper into a plug the first time she was placed.
  lvl.npcs.push({ key: 'weaver', x: gate.x - 1, y: cy - 1 });

  lvl.upStair = { x: x0 + 1, y: cy };
  return { level: lvl, start: { x: x0 + 1, y: cy } };
}
