// Putting enemies on a floor.
//
// Two rules, both from the design:
//
// 1. **Enemy count is not the difficulty dial - composition is.** Three
//    archers is the same problem three times; two archers and a brute is a
//    different problem, because now you have to choose which one you deal with
//    while the other one is still shooting. The dial that actually matters is
//    how often something is winding up at you, and that is set by the species
//    mix, not the head count.
//
// 2. **Every floor needs something you can outrun and something you cannot.**
//    Otherwise "run past it" is either always right or never possible, and the
//    walk back from a bonfire stops being a decision.
//
// Placement is seeded separately from terrain (`seed#depth#mob`) so that the
// same floor always contains the same enemies in the same spots. That is what
// makes learning a floor mean anything.

import { Enemy } from './actors.js';
import { pickEnemy, ENEMY_BY_KEY } from '../data/enemies.js';
import { DUNGEON_DEPTH } from '../map/mapgen.js';
import { T } from '../map/tiles.js';

export function populate(game, lvl, rng) {
  const depth = lvl.depth;
  if (depth === DUNGEON_DEPTH) return;      // the boss floor is placed by hand

  // Grows slowly. Doubling the count is not how this game gets harder.
  const want = 4 + Math.floor(depth * 0.8) + rng.rn2(3);

  const place = (key) => {
    const spot = lvl.randomFreeSpot(rng, { roomsOnly: true, awayFrom: lvl.upStair, minDist: 7 });
    if (!spot) return 0;
    return spawn(game, lvl, key, spot.x, spot.y, rng);
  };

  let placed = 0;
  for (let guard = 0; placed < want && guard < want * 12; guard++) {
    placed += place(pickEnemy(rng, depth).key);
  }

  // Then guarantee the mix rather than hoping the rolls produced it. Both
  // halves of "can I walk away from this?" must exist on every floor, or
  // running past stops being a decision and the walk back from a bonfire is
  // just a punishment. An earlier version nudged the choice at one particular
  // index, which a group spawn could step straight over.
  if (!lvl.enemies.some((e) => e.spec.speed < 12)) place('husk');
  if (!lvl.enemies.some((e) => e.spec.speed >= 12)) place('hound');
}

export function spawn(game, lvl, key, x, y, rng, noGroup = false) {
  const spec = ENEMY_BY_KEY[key];
  const e = new Enemy(key, rng);
  lvl.addEnemy(e, x, y);
  let n = 1;

  if (spec.group && !noGroup) {
    const [lo, hi] = spec.group;
    const extra = rng.int(lo, hi) - 1;
    for (let i = 0; i < extra; i++) {
      const s = nearbyFree(lvl, x, y, 3, rng);
      if (!s) break;
      lvl.addEnemy(new Enemy(key, rng), s.x, s.y);
      n++;
    }
  }
  return n;
}

function nearbyFree(lvl, x, y, r, rng) {
  const out = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!lvl.walkable(nx, ny)) continue;
      if (lvl.enemyAt(nx, ny)) continue;
      const t = lvl.at(nx, ny);
      if (t === T.STAIRS_UP || t === T.STAIRS_DOWN || t === T.BONFIRE) continue;
      out.push({ x: nx, y: ny });
    }
  }
  return out.length ? rng.pick(out) : null;
}

/**
 * The bottom floor.
 *
 * The boss stands in the largest room, with a handful of ordinary enemies in
 * the rest of the floor so the approach is not free. There is deliberately a
 * bonfire on this floor like any other - the fight is meant to be attempted
 * many times.
 */
export function spawnBoss(game, lvl) {
  const rng = game.rng;
  const room = [...lvl.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (!room) return;

  const bx = room.x + (room.w >> 1);
  const by = room.y + (room.h >> 1);
  if (lvl.walkable(bx, by)) spawn(game, lvl, 'firstflame', bx, by, rng, true);
  else {
    const s = lvl.randomFreeSpot(rng, { roomsOnly: true });
    if (s) spawn(game, lvl, 'firstflame', s.x, s.y, rng, true);
  }

  for (let i = 0; i < 5; i++) {
    const s = lvl.randomFreeSpot(rng, { roomsOnly: true, awayFrom: lvl.upStair, minDist: 8 });
    if (s) spawn(game, lvl, pickEnemy(rng, DUNGEON_DEPTH - 1).key, s.x, s.y, rng, true);
  }
  lvl.name = 'the Ember Hall';
}
