// Level generation.
//
// Adapted from claudeHack's rooms-and-corridors generator, with the grid
// coarsened from 5x3 to 4x3 over a smaller map. That is not cosmetic: this game
// fights in rooms, so it wants **fewer, larger** rooms than a game that
// explores in them. A 12x4 room is an arena; a 4x2 room is a cupboard.
//
// The mazes, caverns and big rooms are gone. They are good for a game about
// exploring; for a game about reading an enemy's wind-up and stepping out of
// the way, rooms joined by corridors is the shape that produces the tactics -
// doorways to funnel through, corridors to retreat down, rooms to be surrounded
// in.
//
// Two things are added: bonfires, and cover.

import { Level, MAP_W, MAP_H } from './level.js';
import { T, isWalkable } from './tiles.js';
import { CHAMBERS } from '../data/chambers.js';

const GRID_COLS = 4;
// Two rows, not three. On a 64x25 map a 4x3 grid gives cells of 15x7, which
// caps a room at 12x4 - and a four-tall room cannot hold a situation. A
// colonnade needs five rows (aisle, pillars, lane, pillars, aisle), so with
// the old grid there was no room on any floor that a chamber could be built
// in: measured, 0.0%.
//
// It also moves the map toward what it is supposed to feel like. Wide shallow
// rooms joined by long thin corridors is the shape this generator inherited,
// and it is exactly the look we are trying to get away from. Bigger rooms mean
// less rock, shorter corridors and more space for attack shapes that were
// designed with space in mind.
const GRID_ROWS = 2;

export const DUNGEON_DEPTH = 10;

export function generateLevel(depth, rng) {
  const lvl = new Level(depth, MAP_W, MAP_H);
  genRooms(lvl, rng);
  fillNoise(lvl, rng);
  ensureConnected(lvl, rng);
  placeStairs(lvl, rng, depth);
  placeBonfires(lvl, rng);
  scatterCover(lvl, rng);
  placeStoreroom(lvl, rng, depth);
  placeChambers(lvl, rng, depth);
  // Last, and that matters: a long single-width corridor turns most of the
  // combat system off, and scatterCover drops rubble and pits that BLOCK
  // movement - so widening before it runs lets it narrow the map straight back
  // down again. The guarantee has to be established against the finished floor.
  openAlcoves(lvl, rng);
  // Last, against the FINISHED floor.
  //
  // She used to go down before scatterCover and openAlcoves, and picked the
  // most open tile she could see - on a map that was still being built. Rubble
  // dropped around her and corridors widened elsewhere afterwards, so the tile
  // she chose as open could be a doorway by the time anybody walked through
  // it. That is how she still ended up plugging a passage on three floors in
  // four hundred after being taught to avoid exactly that.
  //
  // Still inside mapgen, so the guarantee that matters is intact: she exists
  // before `populate` runs, and every spawn asks the level what is standing on
  // a tile.
  placeKeeper(lvl);
  return lvl;
}

// ===========================================================================

function genRooms(lvl, rng) {
  lvl.tiles.fill(T.STONE);

  const colW = Math.floor((lvl.w - 2) / GRID_COLS);
  const rowH = Math.floor((lvl.h - 2) / GRID_ROWS);

  const cells = [];
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) cells.push({ gx, gy });
  }
  rng.shuffle(cells);

  const want = rng.int(6, 9);
  for (const c of cells) {
    if (lvl.rooms.length >= want) break;
    const cx = 1 + c.gx * colW;
    const cy = 1 + c.gy * rowH;
    const maxW = colW - 3, maxH = rowH - 3;
    if (maxW < 4 || maxH < 3) continue;

    const w = rng.int(4, maxW);
    const h = rng.int(3, maxH);
    const x = cx + 1 + rng.rn2(Math.max(1, colW - w - 2));
    const y = cy + 1 + rng.rn2(Math.max(1, rowH - h - 2));

    const room = { x, y, w, h, gx: c.gx, gy: c.gy, id: lvl.rooms.length, type: 'ordinary' };
    carveRoom(lvl, room);
    lvl.rooms.push(room);
  }

  // Randomised spanning tree over grid-adjacent rooms, plus a few loops.
  // The loops matter more here than in claudeHack: a level with no alternative
  // route means a retreat can only ever end in a dead end.
  const rooms = lvl.rooms;
  const edges = [];
  for (const a of rooms) {
    for (const b of rooms) {
      if (b.id <= a.id) continue;
      if (Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy) === 1) {
        edges.push({ a, b, w: rng.rn2(1000) });
      }
    }
  }
  edges.sort((p, q) => p.w - q.w);

  const parent = rooms.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const a = find(i), b = find(j); if (a === b) return false; parent[a] = b; return true; };

  const used = new Set();
  for (const e of edges) if (union(e.a.id, e.b.id)) { corridorBetween(lvl, e.a, e.b, rng); used.add(e); }
  for (const e of edges) if (!used.has(e) && rng.oneIn(3)) { corridorBetween(lvl, e.a, e.b, rng); used.add(e); }

  for (const r of rooms) {
    if (!rooms.length || find(r.id) === find(rooms[0].id)) continue;
    let best = null, bd = Infinity;
    for (const o of rooms) {
      if (find(o.id) !== find(rooms[0].id)) continue;
      const d = Math.abs(mid(o).x - mid(r).x) + Math.abs(mid(o).y - mid(r).y);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) { corridorBetween(lvl, r, best, rng); union(r.id, best.id); }
  }
}

const mid = (r) => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) });

function carveRoom(lvl, room) {
  for (let y = room.y - 1; y <= room.y + room.h; y++) {
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (!lvl.inBounds(x, y)) continue;
      const inside = x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
      lvl.set(x, y, inside ? T.FLOOR : T.WALL);
    }
  }
  // Every room is lit. Unlit rooms are a good exploration mechanic and a bad
  // combat one: you cannot read a wind-up you cannot see, and a game built on
  // reading wind-ups must never hide them.
  room.lit = true;
  for (let y = room.y - 1; y <= room.y + room.h; y++) {
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (lvl.inBounds(x, y)) lvl.lit[lvl.idx(x, y)] = 1;
    }
  }
}

/**
 * Corridors are two tiles wide, and so are the doors at each end.
 *
 * The generator inherited one-wide passages from claudeHack, and a one-wide
 * passage is measurably hostile to this game rather than merely tight: every
 * attack shape collapses to a single effective tile, the only movement left is
 * forward and back - which is exactly what `line3` and `line6` are built to
 * punish - and block stops being the "nowhere to go" option and becomes
 * mandatory. `openAlcoves` was the previous answer, capping how LONG a strait
 * could run. This removes most of them instead.
 *
 * The path itself is unchanged: the centre line is dug exactly as before,
 * including its licence to break through a wall it happens to run into. The
 * widening runs beside it and may only eat STONE - never WALL - because a
 * two-wide brush that could open walls would punch second holes in every room
 * it passed.
 *
 * **Not all of them.** Roughly a quarter stay one wide, and that is a
 * deliberate reversal of a first attempt that widened everything: it took the
 * share of narrow ground from 22% to 4%, which is not "chokepoints are no
 * longer the default", it is "chokepoints are gone". A corridor is a real
 * answer to a pack of hounds, and a floor with no tight ground on it has taken
 * that answer away. The test that guards this caught it.
 */
function corridorBetween(lvl, a, b, rng) {
  const wide = !rng.oneIn(4);
  const horiz = a.gy === b.gy;
  if (horiz) {
    const left = a.x < b.x ? a : b, right = a.x < b.x ? b : a;
    const ax = left.x + left.w, ay = rng.int(left.y, Math.max(left.y, left.y + left.h - 2));
    const bx = right.x - 1,     by = rng.int(right.y, Math.max(right.y, right.y + right.h - 2));
    doorway(lvl, ax, ay, 0, wide ? 1 : 0, rng);
    doorway(lvl, bx, by, 0, wide ? 1 : 0, rng);
    const m = ax + 1 >= bx ? ax + 1 : rng.int(ax + 1, Math.max(ax + 1, bx - 1));
    for (let x = ax + 1; x <= m; x++) run(lvl, x, ay, 0, wide ? 1 : 0);
    const step = ay < by ? 1 : -1;
    for (let y = ay; y !== by; y += step) run(lvl, m, y, wide ? 1 : 0, 0);
    run(lvl, m, by, wide ? 1 : 0, 0);
    for (let x = m; x < bx; x++) run(lvl, x, by, 0, wide ? 1 : 0);
    // The bend needs its own corner or the two runs meet at a single tile and
    // the passage pinches back to one wide exactly where you turn.
    if (wide) { bore(lvl, m + 1, ay); bore(lvl, m + 1, by); }
  } else {
    const top = a.y < b.y ? a : b, bot = a.y < b.y ? b : a;
    const ax = rng.int(top.x, Math.max(top.x, top.x + top.w - 2)), ay = top.y + top.h;
    const bx = rng.int(bot.x, Math.max(bot.x, bot.x + bot.w - 2)), by = bot.y - 1;
    doorway(lvl, ax, ay, wide ? 1 : 0, 0, rng);
    doorway(lvl, bx, by, wide ? 1 : 0, 0, rng);
    const m = ay + 1 >= by ? ay + 1 : rng.int(ay + 1, Math.max(ay + 1, by - 1));
    for (let y = ay + 1; y <= m; y++) run(lvl, ax, y, wide ? 1 : 0, 0);
    const step = ax < bx ? 1 : -1;
    for (let x = ax; x !== bx; x += step) run(lvl, x, m, 0, wide ? 1 : 0);
    run(lvl, bx, m, 0, wide ? 1 : 0);
    for (let y = m; y < by; y++) run(lvl, bx, y, wide ? 1 : 0, 0);
    if (wide) { bore(lvl, ax, m + 1); bore(lvl, bx, m + 1); }
  }
}

/** The centre line, plus one tile beside it. */
function run(lvl, x, y, wx, wy) {
  dig(lvl, x, y);
  bore(lvl, x + wx, y + wy);
}

function dig(lvl, x, y) {
  if (!lvl.inBounds(x, y)) return;
  const t = lvl.at(x, y);
  if (t === T.STONE) lvl.set(x, y, T.CORRIDOR);
  else if (t === T.WALL) lvl.set(x, y, T.DOOR_BROKEN);
}

/** Widening. Rock only - it must never open a room's wall. */
function bore(lvl, x, y) {
  if (!lvl.inBounds(x, y)) return;
  if (lvl.at(x, y) === T.STONE) lvl.set(x, y, T.CORRIDOR);
}

/**
 * A doorway two tiles wide, both leaves the same kind.
 *
 * Same kind on purpose: half an open door and half a closed one is a doorway
 * you can walk through, which makes the closed half decoration.
 */
function doorway(lvl, x, y, wx, wy, rng) {
  // No locked doors and no secret doors. Both are exploration friction, and
  // this game's friction budget is spent entirely on combat.
  const r = rng.rn2(100);
  const kind = r < 35 ? T.DOOR_BROKEN : r < 75 ? T.DOOR_OPEN : T.DOOR_CLOSED;
  for (const [dx, dy] of [[0, 0], [wx, wy]]) {
    const tx = x + dx, ty = y + dy;
    if (lvl.inBounds(tx, ty) && lvl.at(tx, ty) === T.WALL) lvl.set(tx, ty, kind);
  }
}

// ===========================================================================

function fillNoise(lvl, rng) {
  for (let i = 0; i < lvl.noise.length; i++) lvl.noise[i] = rng.rn2(256);
}

function floodRegion(lvl, sx, sy, seen) {
  const out = [];
  const stack = [lvl.idx(sx, sy)];
  seen[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop();
    out.push(i);
    const x = i % lvl.w, y = (i / lvl.w) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (!lvl.inBounds(nx, ny)) continue;
      const j = lvl.idx(nx, ny);
      if (seen[j]) continue;
      const t = lvl.tiles[j];
      if (!isWalkable(t) && t !== T.DOOR_CLOSED) continue;
      seen[j] = 1; stack.push(j);
    }
  }
  return out;
}

function ensureConnected(lvl, rng) {
  for (let guard = 0; guard < 12; guard++) {
    const seen = new Uint8Array(lvl.w * lvl.h);
    const regions = [];
    for (let y = 0; y < lvl.h; y++) {
      for (let x = 0; x < lvl.w; x++) {
        const i = lvl.idx(x, y);
        if (seen[i] || !isWalkable(lvl.tiles[i])) continue;
        regions.push(floodRegion(lvl, x, y, seen));
      }
    }
    if (regions.length <= 1) return;
    regions.sort((a, b) => b.length - a.length);
    const a = regions[0][rng.rn2(regions[0].length)];
    const b = regions[1][rng.rn2(regions[1].length)];
    tunnel(lvl, a % lvl.w, (a / lvl.w) | 0, b % lvl.w, (b / lvl.w) | 0);
  }
}

function tunnel(lvl, x0, y0, x1, y1) {
  let x = x0, y = y0, guard = 0;
  while ((x !== x1 || y !== y1) && guard++ < 400) {
    if (x !== x1 && (y === y1 || (guard & 1))) x += Math.sign(x1 - x);
    else y += Math.sign(y1 - y);
    const t = lvl.at(x, y);
    if (t === T.STONE || t === T.WALL) lvl.set(x, y, T.CORRIDOR);
  }
  wallInPassages(lvl);
}

function wallInPassages(lvl) {
  const copy = Uint8Array.from(lvl.tiles);
  for (let y = 0; y < lvl.h; y++) {
    for (let x = 0; x < lvl.w; x++) {
      if (copy[lvl.idx(x, y)] !== T.STONE) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (lvl.inBounds(nx, ny) && isWalkable(copy[lvl.idx(nx, ny)])) { touch = true; break; }
        }
      }
      if (touch) lvl.set(x, y, T.WALL);
    }
  }
}

function placeStairs(lvl, rng, depth) {
  const up = lvl.randomFreeSpot(rng, { roomsOnly: true });
  if (up) { lvl.set(up.x, up.y, T.STAIRS_UP); lvl.upStair = up; }

  if (depth < DUNGEON_DEPTH) {
    let down = null;
    for (let t = 0; t < 60 && !down; t++) {
      down = lvl.randomFreeSpot(rng, { roomsOnly: true, awayFrom: up, minDist: 14 });
    }
    down = down || lvl.randomFreeSpot(rng, { roomsOnly: true }) || lvl.randomFreeSpot(rng);
    if (down) { lvl.set(down.x, down.y, T.STAIRS_DOWN); lvl.downStair = down; }
    // Both ends claim their room. The down stair not doing so is what put a
    // stair inside a situation on 16% of floors - chambers excluded the up
    // stair, the fires and the store, and nobody added this one.
    lvl.claimRoom('stair', roomAt(lvl, lvl.upStair?.x, lvl.upStair?.y)?.id);
    lvl.claimRoom('stair', roomAt(lvl, down?.x, down?.y)?.id);
  }
}

/**
 * Bonfires.
 *
 * One is always adjacent to the way in, which bounds the walk back after a
 * death to a single floor. Bonfire density is the dial that decides whether
 * dying is a setback or a punishment - it is deliberately a number here rather
 * than a shortcut system, because a number can be turned during play testing
 * and a system cannot.
 */
function placeBonfires(lvl, rng) {
  let id = 0;
  const put = (x, y) => {
    lvl.set(x, y, T.BONFIRE);
    lvl.bonfires.push({ x, y, id: id++ });
    // So the next one cannot land in the same room. Two fires in one room was
    // 11.5% of floors, and two within three tiles 5.3% - the extras had a
    // minimum distance from the UP STAIR and none at all from each other.
    lvl.claimRoom('fire', roomAt(lvl, x, y)?.id);
  };

  // One is always beside the way in - deliberately in the stair's own room, so
  // this is the one place 'fire' and 'stair' share.
  if (lvl.upStair) {
    const near = adjacentFloor(lvl, lvl.upStair.x, lvl.upStair.y, rng);
    if (near) put(near.x, near.y);
  }
  const extra = rng.int(1, 2);
  for (let i = 0; i < extra; i++) {
    const s = lvl.randomFreeSpot(rng, { roomsOnly: true, awayFrom: lvl.upStair, minDist: 10 });
    if (s) put(s.x, s.y);
  }
  if (!lvl.bonfires.length) {
    const s = lvl.randomFreeSpot(rng);
    if (s) put(s.x, s.y);
  }
}

/**
 * Stamp a situation into a room.
 *
 * Deliberately after the bonfires and the keeper, so a chamber can never be
 * built on top of the one square the game promises is a breath - and before
 * `populate`, because the enemies it asks for are placed by reading the
 * anchors it leaves behind.
 *
 * One per floor for now. This is the seam the situation pool grows from: more
 * templates and per-theme pools change this function's *inputs*, not its
 * shape.
 */
function placeChambers(lvl, rng, depth) {
  lvl.chambers = [];
  // Never the bottom floor. `populate` says "the boss floor is placed by hand"
  // and returns before it would cast anybody - so a chamber down here got its
  // terrain carved and its cast never filled: pillars and chasms cut into the
  // sanctum for nothing. Worse, the boss takes the largest room and chambers
  // like large rooms too, so one floor in seven put the dragon in a colonnade
  // or on a bridge with the drop at its shoulder.
  if (depth >= DUNGEON_DEPTH) return;
  const pool = CHAMBERS.filter((c) => depth >= c.minDepth);
  if (!pool.length) return;

  // This used to be three hand-listed exclusions - the fires, the up stair,
  // the store. It was missing the DOWN stair, which is how 16% of floors got a
  // stair standing inside a colonnade or on a bridge over a chasm. A list that
  // has to be kept in step with every other feature is a list that will fall
  // out of step; the registry answers "has anyone taken this room" instead.
  // Try the whole pool, not one draw from it.
  //
  // This picked ONE spec and gave up if no free room fitted it, and the three
  // specs want different rooms - a colonnade needs 9x5, a span 10x6, a broken
  // floor only 8x5. So a floor with a perfectly good 8x5 going spare produced
  // nothing at all whenever the die said "span".
  //
  // It mattered more once the exclusions were correct: adding the down stair
  // to them dropped situations from 54% of floors to 42%, and shuffling the
  // pool instead of drawing from it puts that back without letting a stair
  // stand in a colonnade again.
  const order = [...pool];
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.rn2(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  let spec = null, options = [];
  for (const cand of order) {
    const fit = lvl.rooms.filter((r) => !lvl.claims.has(r.id) && cand.fits(r));
    if (fit.length) { spec = cand; options = fit; break; }
  }
  if (!spec) return;

  const room = rng.pick(options);
  // Clear the room of scattered cover first.
  //
  // scatterCover runs before this and drops rubble and pits into any room big
  // enough to hold them, and every chamber's `build` skips tiles that are not
  // plain floor - so a situation stamped over them kept the holes: a span with
  // rubble in its bridge and a pit in the middle of its chasm, which is
  // neither a corridor nor a drop but a mess.
  //
  // A situation's composition IS the room. Random cover topping it up is the
  // same mistake as random enemies topping up its cast, one layer down, and
  // spawnBoss has cleared its arena for this reason since it was written.
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      const t = lvl.at(x, y);
      if (t === T.RUBBLE || t === T.PIT) lvl.set(x, y, T.FLOOR);
    }
  }
  const anchors = spec.build(lvl, room);
  lvl.chambers.push({ key: spec.key, room: room.id, anchors });
  lvl.claimRoom('chamber', room.id);
}

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
 * Rubble and pits.
 *
 * Rubble blocks movement but not sight, so it is cover you can shoot over and
 * hide behind - it makes the ranged distance bands interesting instead of
 * binary. Pits block walkers but not projectiles, so they shape who can reach
 * whom without shaping who can shoot whom.
 */
function scatterCover(lvl, rng) {
  for (const room of lvl.rooms) {
    if (room.w < 6 || room.h < 3) continue;
    const n = rng.rn2(4);
    for (let i = 0; i < n; i++) {
      const x = rng.int(room.x + 1, room.x + room.w - 2);
      const y = rng.int(room.y + 1, room.y + room.h - 2);
      if (lvl.at(x, y) !== T.FLOOR) continue;
      lvl.set(x, y, rng.oneIn(4) ? T.PIT : T.RUBBLE);
    }
  }
}

/**
 * The guarantee: nowhere on a floor can you travel more than this many tiles
 * without a sidestep being available. Measured, not hoped for - systest pins it.
 */
export const MAX_STRAIT = 4;

const walkableAt = (lvl, x, y) => {
  if (!lvl.inBounds(x, y)) return false;
  const t = lvl.at(x, y);
  return t === T.FLOOR || t === T.CORRIDOR || t === T.DOOR_OPEN || t === T.DOOR_BROKEN;
};

/** A tile you can only leave along one axis - no sideways at all. */
function strait(lvl, x, y) {
  if (!walkableAt(lvl, x, y)) return null;
  const n = walkableAt(lvl, x, y - 1), s = walkableAt(lvl, x, y + 1);
  const e = walkableAt(lvl, x + 1, y), w = walkableAt(lvl, x - 1, y);
  if (n && s && !e && !w) return 'v';
  if (e && w && !n && !s) return 'h';
  return null;
}

/**
 * Break up long single-width corridors with alcoves.
 *
 * A one-tile-wide corridor does not merely make this game lethal, it **turns
 * most of it off**. Every attack shape collapses: `arc3` and `arc5` cover one
 * effective tile, the only movement left is forward and back - which is exactly
 * what `line3` and `line6` are designed to punish - and block stops being the
 * "nowhere to go" option and becomes mandatory. Measured on the old generator,
 * 22.5% of every walkable tile was corridor you could not step sideways out of.
 *
 * The fix is not to remove narrow places: a corridor is a legitimate answer to
 * a pack of hounds, and chokepoints are tactics. It is to cap how *long* they
 * run, so there is always a sidestep within a couple of tiles. Alcoves keep the
 * corridor feeling like a corridor and give the geometry something to remember.
 *
 * Only STONE is ever dug, never WALL, so an alcove can never breach a room.
 */
export function openAlcoves(lvl, rng, maxRun = MAX_STRAIT - 1) {
  for (const axis of ['h', 'v']) {
    const along = axis === 'h' ? [1, 0] : [0, 1];
    const side = axis === 'h' ? [0, 1] : [1, 0];
    for (let y = 1; y < lvl.h - 1; y++) {
      for (let x = 1; x < lvl.w - 1; x++) {
        if (strait(lvl, x, y) !== axis) continue;
        // Only start counting at the beginning of a run.
        if (strait(lvl, x - along[0], y - along[1]) === axis) continue;

        let run = 0, cx = x, cy = y;
        while (strait(lvl, cx, cy) === axis) {
          run++;
          if (run > maxRun) {
            // Exhaustive by construction, so a corridor tile with any solid
            // neighbour can always be given a sidestep:
            //   rock  -> carve it
            //   wall with something solid behind -> hollow a pocket
            //   wall with a room behind -> break a doorway into the room
            // Only the map edge has no answer, and corridors do not run there.
            const opts = [[side[0], side[1]], [-side[0], -side[1]]];
            for (const [dx, dy] of rng.shuffle(opts)) {
              const ax = cx + dx, ay = cy + dy;
              if (!lvl.inBounds(ax, ay)) continue;
              const t = lvl.at(ax, ay);
              if (t === T.STONE) { lvl.set(ax, ay, T.CORRIDOR); run = 0; break; }
              if (t !== T.WALL) continue;
              const bx = ax + dx, by = ay + dy;
              const behindOpen = lvl.inBounds(bx, by) && isWalkable(lvl.at(bx, by));
              lvl.set(ax, ay, behindOpen ? T.DOOR_BROKEN : T.CORRIDOR);
              run = 0;
              break;
            }
          }
          cx += along[0]; cy += along[1];
        }
      }
    }
  }
}

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

  // Never the room you arrive in, and never the one with the fire in it.
  const taken = new Set();
  if (lvl.upStair) taken.add(roomAt(lvl, lvl.upStair.x, lvl.upStair.y)?.id);
  if (lvl.downStair) taken.add(roomAt(lvl, lvl.downStair.x, lvl.downStair.y)?.id);

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

  const options = lvl.rooms.filter((r) => !taken.has(r.id) && !nearFire(r) && r.w >= 4 && r.h >= 3);
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
