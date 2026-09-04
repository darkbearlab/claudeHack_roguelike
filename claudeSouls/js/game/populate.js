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
import { DIRS } from '../../../engine/util.js';

export function populate(game, lvl, rng) {
  const depth = lvl.depth;
  if (depth === DUNGEON_DEPTH) return;      // the boss floor is placed by hand

  placeGuards(game, lvl, rng);
  placeElite(game, lvl, rng, depth);

  // Grows slowly. Doubling the count is not how this game gets harder.
  const want = 4 + Math.floor(depth * 0.8) + rng.rn2(3);

  const place = (key) => {
    const spot = lvl.randomFreeSpot(rng, {
      roomsOnly: true, awayFrom: lvl.upStair, minDist: 7, avoidBonfires: true });
    if (!spot) return 0;
    return spawn(game, lvl, key, spot.x, spot.y, rng);
  };

  // Packs first, and they come out of the same budget - a floor with a pack on
  // it is not a floor with more enemies, it is a floor where some of them are
  // standing together and threatening overlapping ground.
  let placed = placePacks(game, lvl, rng, want);

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
  // A big thing needs room to exist. Refusing here rather than nudging it is
  // deliberate: the placement routines all retry, and a creature quietly moved
  // somewhere it fits is a creature that is not where the level meant it.
  if ((spec.size ?? 1) > 1 && !lvl.bodyFits(x, y, spec.size)) return 0;
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
      if (lvl.occupant(nx, ny)) continue;
      const t = lvl.at(nx, ny);
      if (t === T.STAIRS_UP || t === T.STAIRS_DOWN || t === T.BONFIRE) continue;
      if (lvl.isSanctuary(nx, ny)) continue;      // group members too
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

  // The boss is four squares of dragon, so "the middle of the biggest room"
  // is no longer guaranteed to be somewhere it can stand - and the old
  // fallback did not check either, so two seeds in twenty produced a bottom
  // floor with **no boss on it at all**, which is a run that cannot be won.
  // Every candidate is now tested against the whole footprint.
  const size = ENEMY_BY_KEY.firstflame.size ?? 1;
  const fits = (x, y) => lvl.bodyFits(x, y, size);

  const centre = { x: room.x + (room.w >> 1) - ((size - 1) >> 1),
                   y: room.y + (room.h >> 1) - ((size - 1) >> 1) };
  let at = fits(centre.x, centre.y) ? centre : null;

  // Failing that, the tile of the biggest room closest to its middle that the
  // body does fit in - so it still reads as an arena rather than a corner.
  if (!at) {
    let best = null, bestD = Infinity;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (!fits(x, y)) continue;
        const d = Math.abs(x - centre.x) + Math.abs(y - centre.y);
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
    }
    at = best;
  }
  // And failing even that, anywhere on the floor it fits.
  if (!at) {
    for (let y = 0; y < lvl.h && !at; y++) {
      for (let x = 0; x < lvl.w && !at; x++) if (fits(x, y)) at = { x, y };
    }
  }
  if (at) spawn(game, lvl, 'firstflame', at.x, at.y, rng, true);

  for (let i = 0; i < 5; i++) {
    const s = lvl.randomFreeSpot(rng, { roomsOnly: true, awayFrom: lvl.upStair, minDist: 8 });
    if (s) spawn(game, lvl, pickEnemy(rng, DUNGEON_DEPTH - 1).key, s.x, s.y, rng, true);
  }
  lvl.name = 'the Ember Hall';
}

/**
 * Whatever is standing in front of the chest.
 *
 * Two things matter and both are easy to get wrong. The guard is placed
 * **between the chest and the rest of the room**, not next to it or behind it -
 * behind the chest it is scenery, and the point is that it is the thing you
 * have to get past. And it starts **awake**, because a guard you have to walk
 * up and wake reads as "this room happens to have more monsters in it".
 *
 * The species is chosen to match what is being guarded, so the fight teaches
 * you something about the prize: something with reach in front of a spear,
 * something that punishes standing still in front of heavy armour.
 */
const GUARD_FOR = {
  spear: 'sentinel', pike: 'sentinel', halberd: 'swordsman',
  mail: 'brute', plate: 'brute', tower: 'brute',
  bow: 'archer', hatchet: 'archer', knife: 'archer',
  warhammer: 'warden', greataxe: 'warden',
};

export function placeGuards(game, lvl, rng) {
  const store = lvl.store;
  if (!store) return;
  const room = lvl.rooms.find((r) => r.id === store.room);
  if (!room) return;

  const key = GUARD_FOR[store.loot] ?? (lvl.depth >= 6 ? 'swordsman' : 'husk');
  const cx = room.x + (room.w >> 1), cy = room.y + (room.h >> 1);

  // Walk from the chest toward the middle of the room and stand there.
  const dx = Math.sign(cx - store.x), dy = Math.sign(cy - store.y);
  const spots = [
    { x: store.x + dx, y: store.y + dy },
    { x: store.x + dx, y: store.y },
    { x: store.x, y: store.y + dy },
  ];
  let placed = 0;
  for (const s of spots) {
    if (placed) break;
    if (!lvl.inBounds(s.x, s.y) || lvl.at(s.x, s.y) !== T.FLOOR) continue;
    if (lvl.occupant(s.x, s.y)) continue;
    const e = new Enemy(key, rng);
    e.aware = true;                       // it already knows you are coming
    e.guarding = true;
    lvl.addEnemy(e, s.x, s.y);
    placed++;
  }

  // Deeper floors get a second one, so a storeroom stays a fight rather than a
  // toll booth once you outgrow the first guard.
  if (placed && lvl.depth >= 5) {
    // avoidBonfires here too: the box below is "roughly the storeroom" rather
    // than the storeroom, so it reaches into whatever is next door.
    const spot = lvl.randomFreeSpot(rng, { roomsOnly: true, avoidBonfires: true });
    if (spot && Math.abs(spot.x - store.x) <= room.w && Math.abs(spot.y - store.y) <= room.h) {
      const e = new Enemy(key, rng);
      e.aware = true; e.guarding = true;
      lvl.addEnemy(e, spot.x, spot.y);
    }
  }
}

// ===========================================================================
// Packs.
//
// The point is not "more enemies". It is **overlapping telegraphs**.
//
// Now that every blow in the game is announced, several enemies winding up at
// once is a readable object rather than noise: a lane, an arc and a reach drawn
// on the floor in red, with a gap somewhere in them. Finding the gap - and
// getting to it before it closes - is a different question from reading any one
// attack, and it is a question that only became askable when concealment went
// away. A saturated field you cannot read is just damage.
//
// So the members of a pack are chosen for **complementary shapes and different
// rhythms**, not for being individually dangerous:
//
//   a lane and something that punishes leaving it slowly
//   a wall in front and a long poke, so the gap is diagonal
//   something that keeps its distance and something that makes closing expensive
//
// They are placed together, in one room, so their threatened areas actually
// overlap. Scattered across a floor they would just be a head count.

const PACKS = [
  {
    name: 'lane and flush', minDepth: 2, weight: 12,
    // The sentinel paints a three-tile lane; the hounds pounce, and their
    // wind-up carries them forward, so backing down the lane is the one thing
    // that does not work. You have to leave sideways, immediately.
    members: ['sentinel', 'hound', 'hound'],
  },
  {
    name: 'wall and reach', minDepth: 3, weight: 12,
    // An arc directly in front and a two-tile poke beside it. Neither covers
    // the diagonal between them.
    members: ['husk', 'crawler', 'crawler'],
  },
  {
    name: 'crossfire', minDepth: 4, weight: 10,
    // You want to close on the archer. The brute's five-tile arc is the price
    // of the approach, and it steps forward as it swings.
    members: ['archer', 'brute'],
  },
  {
    name: 'two blades', minDepth: 5, weight: 10,
    // Two overlapping semicircles on different beats. Dodging one sweep's
    // second half is how you walk into the other one's first.
    members: ['swordsman', 'swordsman'],
  },
  {
    name: 'the press', minDepth: 7, weight: 8,
    // A ring you must roll out of, and a lane waiting where you would land.
    members: ['warden', 'sentinel'],
  },
];

/**
 * Put one pack down, together, in a room.
 *
 * Placed around a single anchor so the shapes actually overlap. If a member
 * cannot be placed it is simply dropped - a pack that fails to fit is a smaller
 * pack, not a crash.
 */
function placePack(game, lvl, rng, pack) {
  const anchor = lvl.randomFreeSpot(rng, {
    roomsOnly: true, awayFrom: lvl.upStair, minDist: 9, avoidBonfires: true,
  });
  if (!anchor) return 0;

  let placed = 0;
  const spots = [{ x: anchor.x, y: anchor.y }];
  for (const d of DIRS) spots.push({ x: anchor.x + d.dx, y: anchor.y + d.dy });
  for (const d of DIRS) spots.push({ x: anchor.x + d.dx * 2, y: anchor.y + d.dy * 2 });

  for (const key of pack.members) {
    const spot = spots.find((s) =>
      lvl.inBounds(s.x, s.y) && lvl.at(s.x, s.y) === T.FLOOR && !lvl.occupant(s.x, s.y) &&
      !lvl.isSanctuary(s.x, s.y));
    if (!spot) break;
    placed += spawn(game, lvl, key, spot.x, spot.y, rng);
    spots.splice(spots.indexOf(spot), 1);
  }
  return placed;
}

/** How many of a floor's enemies arrive as a pack rather than scattered. */
export function placePacks(game, lvl, rng, budget) {
  const pool = PACKS.filter((p) => lvl.depth >= p.minDepth);
  if (!pool.length) return 0;

  let spent = 0;
  const want = lvl.depth >= 5 ? 2 : 1;
  for (let i = 0; i < want && spent < budget; i++) {
    if (!rng.oneIn(2)) continue;
    const pack = rng.pickWeighted(pool, (p) => p.weight);
    spent += placePack(game, lvl, rng, pack);
  }
  return spent;
}

// ===========================================================================
// Elites.
//
// "The floor boss drops something fixed" turned out to need floor bosses to
// exist first: the only boss in the game is on the last floor, and killing it
// ends the run, so anything it dropped would be worthless. So this is the
// version that does the job the idea was for - **guaranteeing that a run
// actually meets the equipment pool**, which matters more here than usual
// because weapons carry the skills. A player who never finds a second weapon
// never sees half the systems.
//
// One per floor from the third down, picked from a depth table, carrying a
// fixed item. Like everything else that can be picked up, both the species and
// the prize come from `seed#depth`, and the taken-set is per run - so resting
// brings the elite back but not its prize, and there is nothing to farm.

const ELITES = [
  { upto: 4, keys: ['husk', 'sentinel', 'swordsman'] },
  { upto: 7, keys: ['sentinel', 'swordsman', 'brute', 'archer'] },
  { upto: 99, keys: ['brute', 'warden', 'minotaur', 'flamekeeper'] },
];

const ELITE_DROP = [
  { upto: 4, keys: ['blades', 'hatchet', 'buckler', 'brigandine', 'whetstone', 'oil_ember'] },
  { upto: 7, keys: ['spear', 'mace', 'falchion', 'kite', 'firebomb', 'blink',
                    'stone_keen', 'oil_frost'] },
  { upto: 99, keys: ['halberd', 'greataxe', 'warhammer', 'pike', 'tower', 'plate', 'ward',
                     'stone_light', 'stone_keen'] },
];

const pickFrom = (table, depth, rng) => {
  const row = table.find((r) => depth <= r.upto) ?? table[table.length - 1];
  return rng.pick(row.keys);
};

/**
 * One tougher thing per floor, carrying something.
 *
 * It is deliberately not a new species: the roster is the roster, and a "harder
 * husk" is legible in a way a new sprite would not be. More health and more
 * poise means the answers you have learned still apply, they just take longer -
 * which is the right kind of harder for a game whose difficulty lives in
 * reading rather than in numbers.
 */
export function placeElite(game, lvl, rng, depth) {
  if (depth < 3 || depth >= DUNGEON_DEPTH) return 0;

  const spot = lvl.randomFreeSpot(rng, {
    roomsOnly: true, awayFrom: lvl.upStair, minDist: 10, avoidBonfires: true });
  if (!spot) return 0;

  const key = pickFrom(ELITES, depth, rng);
  const before = lvl.enemies.length;
  spawn(game, lvl, key, spot.x, spot.y, rng);
  const e = lvl.enemies[lvl.enemies.length - 1];
  if (!e || lvl.enemies.length === before) return 0;

  e.elite = true;
  e.drop = pickFrom(ELITE_DROP, depth, rng);
  e.name = `elder ${e.name}`;
  e.hpMax = Math.round(e.hpMax * 1.6);
  e.hp = e.hpMax;
  e.poise = e.poise + 2;
  e.poiseLeft = e.poise;
  return 1;
}
