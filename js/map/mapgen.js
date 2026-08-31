// Level generation.
//
// Four generators, chosen by depth with a randomised tail so the dungeon never
// feels like a checklist:
//
//   rooms   - the classic. A 5x3 lattice of candidate cells, a room in some of
//             them, a randomised spanning tree of corridors between neighbours.
//             This is NetHack's own approach and it is used for the majority of
//             levels because it is the one that produces *tactics*: doorways to
//             fight in, corridors to retreat down, rooms to be ambushed in.
//   maze    - recursive backtracker on the odd lattice. Deep levels only.
//   cavern  - cellular automata smoothing of noise. Open, ugly, dangerous.
//   bigroom - one enormous room. Appears once, somewhere in the middle.
//
// Everything downstream (FOV, pathing, item placement) only ever asks the Level
// object questions, so a generator is free to build whatever it likes as long
// as it leaves a connected map with an up and a down staircase.

import { Level, MAP_W, MAP_H } from './level.js';
import { T, isWalkable } from './tiles.js';
import { clamp } from '../core/util.js';

const GRID_COLS = 5;
const GRID_ROWS = 3;

export const DUNGEON_DEPTH = 26;

/** Decide which generator a depth uses. Deterministic given the level RNG. */
export function pickGenerator(depth, rng) {
  if (depth === DUNGEON_DEPTH) return 'sanctum';
  if (depth === 1) return 'rooms';
  if (depth >= 10 && rng.oneIn(9)) return 'maze';
  if (depth >= 4  && rng.oneIn(11)) return 'cavern';
  if (depth >= 6 && depth <= 14 && rng.oneIn(14)) return 'bigroom';
  return 'rooms';
}

export function generateLevel(depth, rng, opts = {}) {
  const kind = opts.force || pickGenerator(depth, rng);
  const lvl = new Level(depth, MAP_W, MAP_H);
  lvl.genKind = kind;

  switch (kind) {
    case 'maze':    genMaze(lvl, rng);    lvl.flags.maze = true;    break;
    case 'cavern':  genCavern(lvl, rng);  lvl.flags.cavern = true;  break;
    case 'bigroom': genBigRoom(lvl, rng); lvl.flags.bigroom = true; break;
    case 'sanctum': genSanctum(lvl, rng); lvl.flags.sanctum = true; break;
    default:        genRooms(lvl, rng);   break;
  }

  fillNoise(lvl, rng);
  ensureConnected(lvl, rng);
  placeStairs(lvl, rng, depth);
  ensureDescentWithoutSearching(lvl);
  return lvl;
}

// ===========================================================================
// rooms and corridors
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
  const grid = new Map();   // "gx,gy" -> room

  for (const c of cells) {
    if (grid.size >= want) break;
    const cx = 1 + c.gx * colW;
    const cy = 1 + c.gy * rowH;
    const maxW = colW - 3, maxH = rowH - 3;
    if (maxW < 3 || maxH < 2) continue;

    const w = rng.int(3, Math.max(3, maxW));
    const h = rng.int(2, Math.max(2, maxH));
    const x = cx + 1 + rng.rn2(Math.max(1, colW - w - 2));
    const y = cy + 1 + rng.rn2(Math.max(1, rowH - h - 2));

    const room = { x, y, w, h, gx: c.gx, gy: c.gy, id: grid.size, type: 'ordinary' };
    carveRoom(lvl, room, rng);
    lvl.rooms.push(room);
    grid.set(`${c.gx},${c.gy}`, room);
  }

  // Connect. Randomised spanning tree over grid-adjacency, then a few loops so
  // the level is not a pure tree - loops are what let you escape a chase.
  const rooms = lvl.rooms;
  const edges = [];
  for (const a of rooms) {
    for (const b of rooms) {
      if (b.id <= a.id) continue;
      const dx = Math.abs(a.gx - b.gx), dy = Math.abs(a.gy - b.gy);
      if (dx + dy === 1) edges.push({ a, b, w: rng.rn2(1000) });
    }
  }
  edges.sort((p, q) => p.w - q.w);

  const parent = rooms.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const a = find(i), b = find(j); if (a === b) return false; parent[a] = b; return true; };

  const used = [];
  for (const e of edges) if (union(e.a.id, e.b.id)) { corridorBetween(lvl, e.a, e.b, rng); used.push(e); }
  for (const e of edges) {
    if (used.includes(e)) continue;
    if (rng.oneIn(3)) { corridorBetween(lvl, e.a, e.b, rng); used.push(e); }
  }

  // Any room the lattice could not reach (its grid neighbours were all empty)
  // gets a brute-force corridor to the nearest room.
  for (const r of rooms) {
    if (find(r.id) === find(rooms[0].id)) continue;
    let best = null, bd = Infinity;
    for (const o of rooms) {
      if (find(o.id) !== find(rooms[0].id)) continue;
      const d = Math.abs(cx(o) - cx(r)) + Math.abs(cy(o) - cy(r));
      if (d < bd) { bd = d; best = o; }
    }
    if (best) { corridorBetween(lvl, r, best, rng); union(r.id, best.id); }
  }

  hideSomeDoors(lvl, rng);
  decorateRooms(lvl, rng);
}

const cx = (r) => r.x + (r.w >> 1);
const cy = (r) => r.y + (r.h >> 1);

function carveRoom(lvl, room, rng) {
  for (let y = room.y - 1; y <= room.y + room.h; y++) {
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (!lvl.inBounds(x, y)) continue;
      const inside = x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
      lvl.set(x, y, inside ? T.FLOOR : T.WALL);
    }
  }
  // Deep rooms are more often unlit. An unlit room is only visible within one
  // square, which changes how the whole level plays.
  room.lit = lvl.depth <= 2 ? true : !rng.oneIn(Math.max(2, 9 - Math.floor(lvl.depth / 4)));
  setRoomLit(lvl, room, room.lit);
}

export function setRoomLit(lvl, room, lit) {
  for (let y = room.y - 1; y <= room.y + room.h; y++) {
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (lvl.inBounds(x, y)) lvl.lit[lvl.idx(x, y)] = lit ? 1 : 0;
    }
  }
}

/** Dig an L- or Z-shaped corridor between two rooms and door both ends. */
function corridorBetween(lvl, a, b, rng) {
  const horiz = a.gy === b.gy;
  let ax, ay, bx, by;

  if (horiz) {
    const left = a.x < b.x ? a : b, right = a.x < b.x ? b : a;
    ax = left.x + left.w;           ay = rng.int(left.y, left.y + left.h - 1);
    bx = right.x - 1;               by = rng.int(right.y, right.y + right.h - 1);
    makeDoor(lvl, ax, ay, rng); makeDoor(lvl, bx, by, rng);
    const mid = ax + 1 >= bx ? ax + 1 : rng.int(ax + 1, Math.max(ax + 1, bx - 1));
    for (let x = ax + 1; x <= mid; x++) dig(lvl, x, ay);
    const step = ay < by ? 1 : -1;
    for (let y = ay; y !== by; y += step) dig(lvl, mid, y);
    dig(lvl, mid, by);
    for (let x = mid; x < bx; x++) dig(lvl, x, by);
  } else {
    const top = a.y < b.y ? a : b, bot = a.y < b.y ? b : a;
    ax = rng.int(top.x, top.x + top.w - 1);   ay = top.y + top.h;
    bx = rng.int(bot.x, bot.x + bot.w - 1);   by = bot.y - 1;
    makeDoor(lvl, ax, ay, rng); makeDoor(lvl, bx, by, rng);
    const mid = ay + 1 >= by ? ay + 1 : rng.int(ay + 1, Math.max(ay + 1, by - 1));
    for (let y = ay + 1; y <= mid; y++) dig(lvl, ax, y);
    const step = ax < bx ? 1 : -1;
    for (let x = ax; x !== bx; x += step) dig(lvl, x, mid);
    dig(lvl, bx, mid);
    for (let y = mid; y < by; y++) dig(lvl, bx, y);
  }
}

/** Corridor tiles only ever replace rock. Anything else already connects. */
function dig(lvl, x, y) {
  if (!lvl.inBounds(x, y)) return;
  const t = lvl.at(x, y);
  if (t === T.STONE) lvl.set(x, y, T.CORRIDOR);
  else if (t === T.WALL) lvl.set(x, y, T.DOOR_BROKEN);   // punched through a room wall
}

function makeDoor(lvl, x, y, rng) {
  if (!lvl.inBounds(x, y)) return;
  if (lvl.at(x, y) !== T.WALL) return;
  const r = rng.rn2(100);
  if (r < 24)      lvl.set(x, y, T.DOOR_BROKEN);   // doorway, no door
  else if (r < 60) lvl.set(x, y, T.DOOR_CLOSED);
  else if (r < 70) lvl.set(x, y, T.DOOR_LOCKED);
  else             lvl.set(x, y, T.DOOR_OPEN);
}

function hideSomeDoors(lvl, rng) {
  const chance = clamp(2 + Math.floor(lvl.depth / 3), 2, 9);
  for (let y = 0; y < lvl.h; y++) {
    for (let x = 0; x < lvl.w; x++) {
      const t = lvl.at(x, y);
      if ((t === T.DOOR_CLOSED || t === T.DOOR_LOCKED) && rng.rn2(100) < chance) {
        lvl.set(x, y, T.SDOOR);
      } else if (t === T.CORRIDOR && rng.rn2(1000) < chance) {
        lvl.set(x, y, T.SCORR);
      }
    }
  }
}

function decorateRooms(lvl, rng) {
  for (const room of lvl.rooms) {
    if (room.type !== 'ordinary') continue;
    if (rng.oneIn(14)) placeFeature(lvl, room, T.FOUNTAIN, rng);
    if (rng.oneIn(30)) placeFeature(lvl, room, T.SINK, rng);
    if (lvl.depth >= 3 && rng.oneIn(28)) {
      placeFeature(lvl, room, T.ALTAR, rng);
      room.hasAltar = true;
    }
  }
}

function placeFeature(lvl, room, tile, rng) {
  for (let tries = 0; tries < 12; tries++) {
    const x = rng.int(room.x, room.x + room.w - 1);
    const y = rng.int(room.y, room.y + room.h - 1);
    if (lvl.at(x, y) === T.FLOOR) { lvl.set(x, y, tile); return { x, y }; }
  }
  return null;
}

// ===========================================================================
// maze
// ===========================================================================

function genMaze(lvl, rng) {
  lvl.tiles.fill(T.STONE);
  const w = lvl.w, h = lvl.h;

  // Work on the odd lattice: cells at odd coordinates, walls between them.
  const stack = [];
  const startX = 1, startY = 1;
  lvl.set(startX, startY, T.CORRIDOR);
  stack.push([startX, startY]);

  const dirs = [[0, -2], [0, 2], [-2, 0], [2, 0]];
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const cand = [];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx <= 0 || ny <= 0 || nx >= w - 1 || ny >= h - 1) continue;
      if (lvl.at(nx, ny) !== T.STONE) continue;
      cand.push([nx, ny, x + dx / 2, y + dy / 2]);
    }
    if (!cand.length) { stack.pop(); continue; }
    const [nx, ny, mx, my] = rng.pick(cand);
    lvl.set(mx, my, T.CORRIDOR);
    lvl.set(nx, ny, T.CORRIDOR);
    stack.push([nx, ny]);
  }

  // Braid it: knock out a fraction of dead ends. A perfect maze with a hunting
  // monster in it is not a challenge, it is a formality.
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (lvl.at(x, y) !== T.CORRIDOR) continue;
      let exits = 0;
      for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) if (isWalkable(lvl.at(x+dx, y+dy))) exits++;
      if (exits === 1 && rng.oneIn(3)) {
        const opts = [];
        for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
          const nx = x + dx * 2, ny = y + dy * 2;
          if (nx > 0 && ny > 0 && nx < w - 1 && ny < h - 1 && isWalkable(lvl.at(nx, ny))) {
            opts.push([x + dx, y + dy]);
          }
        }
        if (opts.length) { const [mx, my] = rng.pick(opts); lvl.set(mx, my, T.CORRIDOR); }
      }
    }
  }

  wallInPassages(lvl);
  lvl.lit.fill(0);
  // A handful of lit alcoves, so the level is not uniformly black.
  for (let i = 0; i < 4; i++) {
    const spot = lvl.randomFreeSpot(rng);
    if (!spot) break;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (lvl.inBounds(spot.x + dx, spot.y + dy)) lvl.lit[lvl.idx(spot.x + dx, spot.y + dy)] = 1;
    }
  }
}

/** Turn the rock immediately adjacent to any passage into wall, so it renders. */
function wallInPassages(lvl) {
  const copy = Uint8Array.from(lvl.tiles);
  for (let y = 0; y < lvl.h; y++) {
    for (let x = 0; x < lvl.w; x++) {
      if (copy[lvl.idx(x, y)] !== T.STONE) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (!lvl.inBounds(nx, ny)) continue;
          if (isWalkable(copy[lvl.idx(nx, ny)])) { touch = true; break; }
        }
      }
      if (touch) lvl.set(x, y, T.WALL);
    }
  }
}

// ===========================================================================
// cavern
// ===========================================================================

function genCavern(lvl, rng) {
  const w = lvl.w, h = lvl.h;
  let grid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = x < 2 || y < 1 || x >= w - 2 || y >= h - 1;
      grid[y * w + x] = edge ? 1 : (rng.rn2(100) < 44 ? 1 : 0);
    }
  }
  for (let pass = 0; pass < 5; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < 2 || y < 1 || x >= w - 2 || y >= h - 1) { next[y * w + x] = 1; continue; }
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          n += grid[(y + dy) * w + (x + dx)];
        }
        next[y * w + x] = n >= 5 ? 1 : (n <= 2 ? 0 : grid[y * w + x]);
      }
    }
    grid = next;
  }

  for (let i = 0; i < w * h; i++) lvl.tiles[i] = grid[i] ? T.STONE : T.FLOOR;
  keepLargestRegion(lvl);
  wallInPassages(lvl);
  lvl.lit.fill(0);
  for (let i = 0; i < 6; i++) {
    const spot = lvl.randomFreeSpot(rng);
    if (!spot) break;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -4; dx <= 4; dx++) {
      if (lvl.inBounds(spot.x + dx, spot.y + dy)) lvl.lit[lvl.idx(spot.x + dx, spot.y + dy)] = 1;
    }
  }
  // Standing water, because a cavern with a pool in it reads as a cavern.
  if (rng.oneIn(2)) {
    const spot = lvl.randomFreeSpot(rng);
    if (spot) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = spot.x + dx, y = spot.y + dy;
        if (lvl.at(x, y) === T.FLOOR && Math.abs(dx) + Math.abs(dy) * 1.6 < 3.5) lvl.set(x, y, T.WATER);
      }
    }
  }
}

function keepLargestRegion(lvl) {
  const seen = new Uint8Array(lvl.w * lvl.h);
  let best = null, bestSize = 0;
  for (let y = 0; y < lvl.h; y++) {
    for (let x = 0; x < lvl.w; x++) {
      const i = lvl.idx(x, y);
      if (seen[i] || !isWalkable(lvl.tiles[i])) continue;
      const region = floodRegion(lvl, x, y, seen);
      if (region.length > bestSize) { bestSize = region.length; best = region; }
    }
  }
  if (!best) return;
  const keep = new Set(best);
  for (let i = 0; i < lvl.tiles.length; i++) {
    if (isWalkable(lvl.tiles[i]) && !keep.has(i)) lvl.tiles[i] = T.STONE;
  }
}

/**
 * Flood a connected region.
 *
 * `throughDoors` decides which question is being asked. Cavern trimming wants
 * strictly walkable cells. Connectivity wants the hero's answer, and to the
 * hero a door - closed, locked or secret - is a way through, just a slower one.
 *
 * Getting this wrong had a specific and bad consequence: the Sanctum's vault
 * is a sealed room with exactly one locked door, so with doors treated as walls
 * it looked like an unreachable region and ensureConnected obligingly tunnelled
 * a hole through its wall. The Amulet's vault is supposed to have one door.
 */
function floodRegion(lvl, sx, sy, seen, throughDoors = false) {
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
      const ok = isWalkable(t) ||
                 (throughDoors && t >= T.DOOR_CLOSED && t <= T.SCORR);
      if (!ok) continue;
      seen[j] = 1; stack.push(j);
    }
  }
  return out;
}

// ===========================================================================
// big room
// ===========================================================================

function genBigRoom(lvl, rng) {
  lvl.tiles.fill(T.STONE);
  const room = { x: 3, y: 2, w: lvl.w - 6, h: lvl.h - 4, id: 0, type: 'bigroom' };
  carveRoom(lvl, room, rng);
  room.lit = true;
  setRoomLit(lvl, room, true);
  lvl.rooms.push(room);
  lvl.name = 'a very big room';

  // Pillars, so there is at least something to break line of sight behind.
  for (let y = room.y + 2; y < room.y + room.h - 1; y += 3) {
    for (let x = room.x + 3; x < room.x + room.w - 2; x += 5) {
      if (rng.oneIn(3)) continue;
      lvl.set(x, y, T.WALL);
    }
  }
}

// ===========================================================================
// the sanctum - bottom of the dungeon, home of the Amulet
// ===========================================================================

function genSanctum(lvl, rng) {
  lvl.tiles.fill(T.STONE);
  lvl.name = 'the Sanctum';
  lvl.flags.noTeleport = true;

  const outer = { x: 4, y: 2, w: lvl.w - 8, h: lvl.h - 4, id: 0, type: 'sanctum' };
  carveRoom(lvl, outer, rng);
  outer.lit = true; setRoomLit(lvl, outer, true);
  lvl.rooms.push(outer);

  // An inner vault with exactly one door. The Amulet goes in the middle of it.
  const iw = 9, ih = 5;
  const ix = outer.x + ((outer.w - iw) >> 1);
  const iy = outer.y + ((outer.h - ih) >> 1);
  for (let y = iy - 1; y <= iy + ih; y++) {
    for (let x = ix - 1; x <= ix + iw; x++) {
      const inside = x >= ix && x < ix + iw && y >= iy && y < iy + ih;
      lvl.set(x, y, inside ? T.FLOOR : T.WALL);
    }
  }
  const doorX = ix + (iw >> 1);
  lvl.set(doorX, iy + ih, T.DOOR_LOCKED);

  const inner = { x: ix, y: iy, w: iw, h: ih, id: 1, type: 'vault', lit: true };
  setRoomLit(lvl, inner, true);
  lvl.rooms.push(inner);
  lvl.amuletSpot = { x: ix + (iw >> 1), y: iy + (ih >> 1) };
  lvl.set(lvl.amuletSpot.x, lvl.amuletSpot.y, T.ALTAR);

  // Braziers of lava in the corners of the outer hall.
  for (const [dx, dy] of [[2,1],[outer.w-3,1],[2,outer.h-2],[outer.w-3,outer.h-2]]) {
    lvl.set(outer.x + dx, outer.y + dy, T.LAVA);
  }
}

// ===========================================================================
// shared finishing steps
// ===========================================================================

function fillNoise(lvl, rng) {
  for (let i = 0; i < lvl.noise.length; i++) lvl.noise[i] = rng.rn2(256);
}

/** Guarantee the whole walkable map is one region; carve if it is not. */
function ensureConnected(lvl, rng) {
  for (let guard = 0; guard < 12; guard++) {
    const seen = new Uint8Array(lvl.w * lvl.h);
    const regions = [];
    for (let y = 0; y < lvl.h; y++) {
      for (let x = 0; x < lvl.w; x++) {
        const i = lvl.idx(x, y);
        if (seen[i] || !isWalkable(lvl.tiles[i])) continue;
        regions.push(floodRegion(lvl, x, y, seen, true));
      }
    }
    if (regions.length <= 1) return;

    regions.sort((a, b) => b.length - a.length);
    const main = regions[0], other = regions[1];
    const a = main[rng.rn2(main.length)], b = other[rng.rn2(other.length)];
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

/**
 * Guarantee that the way down never *requires* finding a secret door.
 *
 * Secret doors are good: they hide side rooms, vaults and shortcuts, and they
 * are the reason the search command exists. Secret doors on the critical path
 * are something else - they turn a level into "walk every wall pressing s",
 * which is tedium rather than difficulty. Measured before this was added, 18%
 * of levels demanded exactly that.
 *
 * A locked door on the path is deliberately still allowed. Kicking is one
 * command, always available, and it makes noise - that is a real decision with
 * a real cost, not a chore.
 */
function ensureDescentWithoutSearching(lvl) {
  if (!lvl.upStair || !lvl.downStair) return;
  const W = lvl.w, H = lvl.h;
  const goal = lvl.idx(lvl.downStair.x, lvl.downStair.y);

  for (let guard = 0; guard < 40; guard++) {
    const seen = new Uint8Array(W * H);
    const frontier = [];                       // secret tiles touching the reached area
    const stack = [lvl.idx(lvl.upStair.x, lvl.upStair.y)];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (!lvl.inBounds(nx, ny)) continue;
        const j = lvl.idx(nx, ny);
        if (seen[j]) continue;
        const t = lvl.tiles[j];
        if (t === T.SDOOR || t === T.SCORR) { frontier.push(j); continue; }
        // Locked doors count as passable here: they can be kicked.
        if (!isWalkable(t) && t !== T.DOOR_CLOSED && t !== T.DOOR_LOCKED) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    if (seen[goal]) return;
    if (!frontier.length) return;              // nothing left to reveal; already handled upstream
    const j = frontier[0];
    lvl.tiles[j] = lvl.tiles[j] === T.SDOOR ? T.DOOR_CLOSED : T.CORRIDOR;
  }
}

function placeStairs(lvl, rng, depth) {
  const roomsOnly = lvl.rooms.length > 0;
  const up = lvl.randomFreeSpot(rng, { roomsOnly });
  if (up) { lvl.set(up.x, up.y, T.STAIRS_UP); lvl.upStair = up; }

  if (depth < DUNGEON_DEPTH) {
    let down = null;
    for (let tries = 0; tries < 60; tries++) {
      const c = lvl.randomFreeSpot(rng, { roomsOnly, avoidStairs: true, awayFrom: up, minDist: 12 });
      if (c) { down = c; break; }
    }
    down = down || lvl.randomFreeSpot(rng, { avoidStairs: true });
    if (down) { lvl.set(down.x, down.y, T.STAIRS_DOWN); lvl.downStair = down; }
  }
}
