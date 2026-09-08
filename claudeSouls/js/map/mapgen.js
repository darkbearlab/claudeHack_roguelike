// Level generation.
//
// A floor is assembled from tiles - see geomorph.js for the mechanism and
// data/geomorphs.js for the tiles themselves. What is left in this file is
// the part that was always about the finished floor rather than about digging
// it: the extra fire, the storeroom, and the keeper.
//
// The rooms-and-corridors generator this file used to be lived here for a
// long time and is recorded in docs/DESIGN.md. It went because every defect
// it produced had the same shape - two features wanting the same ground - and
// a tile owns its ground by construction.
import { Level, MAP_W, MAP_H } from './level.js';
import { T, isWalkable } from './tiles.js';
import { CHAMBERS } from '../data/chambers.js';
import { assemble, LAYOUT, MAP_FOR } from './geomorph.js';

export const DUNGEON_DEPTH = 10;

export function generateLevel(depth, rng) {
  // The map is a property of the layout, not a constant - see MAP_FOR.
  //
  // Except on the bottom floor, which is laid by hand either way: the dragon
  // hall is a 2x2 piece and its approach has to hold escorts and a fire. On a
  // route-sized grid there was no room left for them and five boss floors in
  // thirty came out with a free walk to the door.
  const boss = depth === DUNGEON_DEPTH;
  const [mw, mh] = (boss ? MAP_FOR.fill : MAP_FOR[LAYOUT()]) ?? [MAP_W, MAP_H];
  const lvl = new Level(depth, mw, mh);
  // The floor is assembled from tiles - see geomorph.js for the mechanism and
  // docs/DESIGN.md for why. What comes out is a level full of ordinary rooms,
  // with the stairs, the arrival fire and any situations already in place and
  // their rooms claimed, so the steps that follow are the ones that were
  // always about the finished floor rather than about digging it.
  // Up to three attempts. The assembler guarantees every walkable tile is
  // reachable, and the way it keeps that promise as a last resort is to wall
  // over what it could not join. A little of that is fine - a dead pocket
  // behind a bend. A lot of it is a stump of a floor, and a stump is a
  // generation failure, not a level. Rebuilding from the same stream keeps
  // the result a function of the seed.
  for (let attempt = 0; ; attempt++) {
    const stats = assemble(lvl, rng, { depth, boss: depth === DUNGEON_DEPTH });
    if ((stats.buried ?? 0) <= 40 || attempt >= 2) { if (attempt) lvl.geomorph.attempts = attempt + 1; break; }
    lvl.reset();
  }
  placeExtraFire(lvl, rng);
  placeStoreroom(lvl, rng, depth);
  // Last, against the FINISHED floor. She picks the most open tile she can
  // see, so she has to see the floor as it will be walked - that was learned
  // the hard way on the old generator, where she chose before the cover was
  // scattered and ended up plugging a doorway on three floors in four hundred.
  // Still inside mapgen, so she exists before `populate` counts occupants.
  placeKeeper(lvl);
  return lvl;
}

/**
 * One more fire, somewhere nobody has spoken for.
 *
 * The arrival fire is drawn into the entry tile. This is the "bonfire
 * density" dial from the old placeBonfires, kept as a number for the same
 * reason it was one there: it decides whether dying is a setback or a
 * punishment, and a number can be turned during play.
 */
function placeExtraFire(lvl, rng) {
  const s = lvl.randomFreeSpot(rng, { roomsOnly: true, awayFrom: lvl.upStair, minDist: 12 });
  if (!s) return;
  lvl.set(s.x, s.y, T.BONFIRE);
  lvl.bonfires.push({ x: s.x, y: s.y, id: lvl.bonfires.length });
  lvl.claimRoom('fire', roomAt(lvl, s.x, s.y)?.id);
}

// ===========================================================================

// ===========================================================================

/**
 * Someone at the first fire.
 *
 * Placed beside the bonfire you arrive next to, because that is the one you
 * respawn at - so she is the thing that is there every time you come back,
 * which is the whole reason a Fire Keeper is a Fire Keeper.
 *
 * She goes down in mapgen rather than in populate so that she exists before
 * anything is spawned: every placement routine asks the level what is standing
 * on a tile, and she has to already be standing there to be counted.
 */
function placeKeeper(lvl) {
  if (globalThis.process?.env?.NONPC) return;   // measurement switch only
  const fire = lvl.bonfires[0];
  if (!fire) return;

  // The most OPEN tile beside the fire, and that direction was not obvious.
  //
  // She is a wall - a person cannot be killed or pushed - and she stands beside
  // the fire you respawn at on every floor, so where she stands is a real
  // question. Tucking her into the most cornered nook sounded right and was
  // measurably wrong: the tiles with fewest exits ARE the chokepoints, so she
  // became a plug in a doorway and the bot lost two and a half floors of
  // progress. Blocking open ground costs nothing, because open ground has
  // alternatives; blocking a narrow tile cuts the map in half.
  const walkableNeighbours = (x, y) => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (lvl.walkable(x + dx, y + dy)) n++;
      }
    }
    return n;
  };
  // ...and separately the four that decide whether a tile is a doorway.
  //
  // Openness alone was measured over eight neighbours, and a tile can be wide
  // open diagonally while still being the one square a corridor passes
  // through. Three floors in four hundred put her on exactly that tile. The
  // orthogonal count is what "is this a passage" actually means, so it leads
  // and the eight-way count breaks ties.
  const orthNeighbours = (x, y) => {
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (lvl.walkable(x + dx, y + dy)) n++;
    }
    return n;
  };
  // Two tiles out, not one. The ring immediately around the fire is the ground
  // you back into when something followed you home, and she cannot be killed
  // or pushed off it - measured, standing in it cost the light kit 36% more
  // deaths. At range two she still reads as sitting at the fire (the glow
  // carries it) without taking a square you might need.
  const ring = (r) => {
    const out = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = fire.x + dx, y = fire.y + dy;
        if (lvl.at(x, y) !== T.FLOOR) continue;
        out.push({ x, y, open: walkableNeighbours(x, y), orth: orthNeighbours(x, y) });
      }
    }
    return out;
  };
  // Rings 2, then 3, then 1, and the first ring that offers a tile which is
  // not a doorway wins.
  //
  // Ranking by openness was not enough: on three floors in four hundred every
  // tile in reach of the fire had two orthogonal exits or fewer, so the best
  // candidate was still a plug. There is nothing to rank when the whole
  // neighbourhood is corridor - the answer is to look further out.
  //
  // Order is deliberate. Two is where she reads as sitting at the fire without
  // taking a square you back into; three is further but still hers; one is the
  // ring the player needs and is the last resort. Falling through all three
  // places her anyway, because every seed has someone at the fire - that rule
  // is decided, and a floor with nobody at it is worse than a tight squeeze.
  const OPEN_ENOUGH = 3;
  let cands = null;
  for (const r of [2, 3, 1]) {
    const tiles = ring(r);
    if (tiles.some((t) => t.orth >= OPEN_ENOUGH)) { cands = tiles.filter((t) => t.orth >= OPEN_ENOUGH); break; }
    if (!cands && tiles.length) cands = tiles;      // remember the first non-empty
  }
  if (!cands?.length) return;
  // Chosen without touching the rng, and that is not tidiness.
  //
  // Drawing a random number here consumes one from the stream every other
  // generation decision on the floor is reading from, so adding her SHIFTED
  // EVERY MAP. The A/B that was supposed to measure "how much does she get in
  // the way" was in fact comparing two different dungeons, and the numbers
  // moved by more than a floor in both directions for that reason alone.
  // Deterministic tie-break, so the level is the same level with or without
  // her and the comparison means what it says.
  const spot = [...cands].sort((a, b) =>
    (b.orth - a.orth) || (b.open - a.open) || (a.y - b.y) || (a.x - b.x))[0];
  lvl.npcs.push({ key: 'firekeeper', x: spot.x, y: spot.y });
}

function adjacentFloor(lvl, x, y, rng) {
  const cands = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (lvl.at(x + dx, y + dy) === T.FLOOR) cands.push({ x: x + dx, y: y + dy });
    }
  }
  return cands.length ? rng.pick(cands) : null;
}

/**
 * The longest single-file stretch a floor may contain.
 *
 * A one-wide corridor does not merely make this game lethal, it turns most of
 * it off: every attack shape collapses to one tile and the only movement left
 * is forward and back. The old generator dug corridors and then broke them up
 * with alcoves to honour this; on an assembled floor it is honoured by the
 * drawings - every passage in data/geomorphs.js is two wide, and the three
 * single-file tiles are each shorter than this. The test still measures it
 * against the finished floor, because a rule kept by discipline is a rule
 * that needs a guard.
 */
export const MAX_STRAIT = 4;

const walkableAt = (lvl, x, y) => {
  if (!lvl.inBounds(x, y)) return false;
  const t = lvl.at(x, y);
  return t === T.FLOOR || t === T.CORRIDOR || t === T.DOOR_OPEN || t === T.DOOR_BROKEN;
};

// ===========================================================================
// Storerooms.
//
// The first reason to explore a floor rather than walk to the stairs.
//
// Everything about one is derived from `seed#depth`, like the terrain and the
// monsters: whether the floor has a storeroom at all, which room it is, what is
// in the chest, and what is standing in front of it. That is not just tidiness
// - floors here are persistent, so "this seed has a storeroom on four" becomes
// something the player *keeps*, the same way the layout does. And because the
// contents come from the seed rather than from the kill, nothing about the loot
// is farmable: resting brings the guards back, not the chest.
//
// The chest itself is only "taken" once per run, tracked by the game rather
// than the level, since the level is rebuilt from the seed every time you die.

/**
 * How likely a floor is to hide one.
 *
 * Floor 1 never does - it is the tutorial. Nor does the last floor: `populate`
 * returns early there because the boss is placed by hand, so a chest down there
 * would be an unguarded freebie sitting next to the finale.
 */
function wantsStore(depth, rng) {
  if (depth <= 1 || depth >= DUNGEON_DEPTH) return false;
  return rng.oneIn(depth >= 8 ? 2 : 3);
}

/**
 * What could be in a chest at this depth.
 *
 * Deliberately not "tier N items": later floors offer the *committal* things -
 * the two-handers, the tower shield, the plate - because in this game depth
 * cannot mean bigger numbers, only harder choices.
 */
const STORE_TABLE = [
  { upto: 3, keys: ['rags', 'brigandine', 'bone', 'buckler', 'blades', 'hatchet', 'sword',
                    'knife', 'oil_ember'] },
  { upto: 7, keys: ['spear', 'mace', 'falchion', 'halberd', 'kite', 'mail', 'brigandine',
                    'firebomb', 'whetstone', 'blink', 'stone_keen', 'oil_frost'] },
  { upto: 99, keys: ['greataxe', 'warhammer', 'pike', 'tower', 'plate', 'bow', 'ward', 'blink',
                     'stone_keen', 'stone_light'] },
];

function lootFor(depth, rng) {
  const row = STORE_TABLE.find((r) => depth <= r.upto) ?? STORE_TABLE[STORE_TABLE.length - 1];
  return rng.pick(row.keys);
}

/**
 * Pick a room, put a chest in it, and stand something in the way.
 *
 * The guard is placed between the chest and the room's centre, and starts
 * awake. Both matter: a guard that has to be woken up reads as "this room has
 * more monsters in it", and one standing behind the chest is scenery. It should
 * be the thing you have to get past.
 */
export function placeStoreroom(lvl, rng, depth) {
  if (!wantsStore(depth, rng)) return;

  // Never a room anybody has spoken for. This used to list the two stair
  // rooms by hand and ran BEFORE chambers, which then excluded it; assembled
  // floors put situations down first, so the list was one item short and the
  // chest landed inside a colonnade - with its guard, which the situation's
  // cast then counted as a fourth member. The registry is the answer, as it
  // was for everything else that kept this list by hand.
  const taken = new Set([...lvl.claims.keys()]);

  // Asked of the level rather than computed here, so that this and the enemy
  // placement cannot drift apart. They already had: this used to exclude a
  // room *containing* a fire, which says nothing about a fire out in the
  // corridor - so a chest room could sit right beside one, and the guard the
  // chest is promised would spawn two tiles from the bonfire you respawn at.
  const nearFire = (r) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) if (lvl.isSanctuary(x, y)) return true;
    }
    return false;
  };

  // A room whose rectangle has at least one floor corner. A tile room's
  // rectangle is its whole footprint, and a bend or a passage has wall in
  // every corner; choosing one of those and then finding no corner to put the
  // chest in is how the storeroom rate quietly fell from 30% of floors to 17%.
  const floorCorner = (r) => [[r.x, r.y], [r.x + r.w - 1, r.y], [r.x, r.y + r.h - 1], [r.x + r.w - 1, r.y + r.h - 1]]
    .some(([x, y]) => lvl.at(x, y) === T.FLOOR);
  const options = lvl.rooms.filter((r) => !taken.has(r.id) && !nearFire(r) && r.w >= 4 && r.h >= 3 && floorCorner(r));
  if (!options.length) return;
  const room = rng.pick(options);
  room.type = 'store';

  // The chest goes in a corner, so there is a wrong side to approach from.
  const corners = [
    { x: room.x, y: room.y },
    { x: room.x + room.w - 1, y: room.y },
    { x: room.x, y: room.y + room.h - 1 },
    { x: room.x + room.w - 1, y: room.y + room.h - 1 },
  ].filter((c) => lvl.at(c.x, c.y) === T.FLOOR);
  if (!corners.length) return;
  const spot = rng.pick(corners);
  lvl.set(spot.x, spot.y, T.CHEST);
  lvl.store = { x: spot.x, y: spot.y, loot: lootFor(depth, rng), room: room.id };
  lvl.claimRoom('store', room.id);
}

function roomAt(lvl, x, y) {
  return lvl.rooms.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) ?? null;
}
