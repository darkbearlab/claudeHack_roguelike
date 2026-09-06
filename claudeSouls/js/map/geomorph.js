// Assembling a floor from tiles.
//
// This is the board-game mechanism: square tiles with sockets on their edges,
// a random pile and a special stack, one placed against the last through the
// socket you came in by. What it replaces is docs/DESIGN.md's "rooms and
// corridors" generator; what it keeps is everything downstream, because a
// placed tile becomes an ordinary `room` and the rest of the game - claims,
// populate, situations, the boss - never learns the difference.
//
// One decision is deliberate and worth stating: THE WHOLE FLOOR IS PLACED UP
// FRONT, and revealed by sight. The physical game draws a tile when you reach
// an exit, which means what you find depends on which exit you took first.
// This game promises that a floor is a function of its seed - "die a few
// times and you will know it" - so the tiles are all drawn before you take a
// step, and the exploring feel comes from lighting, which rooms already have.
//
// Everything below was measured on a paper prototype before it was written
// here. The three rules that are not obvious were each the fix for something
// the first draft did wrong:
//   - no dead-end tile until the floor has a body   (a floor of two tiles)
//   - "if you are stuck, place a door"              (a floor a third full)
//   - close the middle door of any straight run     (six rooms in a line)

import { T } from './tiles.js';
import { GEOMORPHS } from '../data/geomorphs.js';
import { CHAMBER_BY_KEY } from '../data/chambers.js';

export const U = 10;                 // one cell of the grid, in tiles

const CHAR_TILE = {
  '#': T.WALL, '.': T.FLOOR, 'I': T.PILLAR, '%': T.RUBBLE, 'O': T.PIT, 'D': T.DOOR_CLOSED,
  '~': T.CHASM, '=': T.BRIDGE, '<': T.STAIRS_UP, '>': T.STAIRS_DOWN, '*': T.BONFIRE,
};
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const opp = (e) => (e + 2) % 4;

/** Rotate a grid of characters 90 degrees clockwise, `times` times. */
function rotate(grid, times) {
  let g = grid.map((r) => [...r]);
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) {
    const H = g.length, W = g[0].length;
    const out = Array.from({ length: W }, () => Array(H).fill(' '));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[x][H - 1 - y] = g[y][x];
    g = out;
  }
  return g;
}

/** A rotated tile with its sockets read off the art. Sockets are {cx, cy, e}. */
function piece(name, rot) {
  const g = rotate(GEOMORPHS[name].art.map((r) => r.split('')), rot);
  const H = g.length, W = g[0].length;
  const cw = W / U, ch = H / U;
  // `+` is a socket; `^` is the ARROW socket, the one the tile must be
  // entered by. And an edge whose middle pair is drawn as floor is an OPEN
  // edge: a socket with no door and no wall, where the tile simply ends and
  // whatever is beside it begins. Two open edges facing each other merge
  // into one space; an open edge beside nothing is floor against rock. All
  // of it rotates with the art like everything else.
  const socks = [];
  const isSock = (c) => c === '+' || c === '^';
  const openPair = (a, b) => standable(a) && standable(b);
  for (let cx = 0; cx < cw; cx++) {
    const t = g[0][cx * U + 4], t2 = g[0][cx * U + 5];
    const b = g[H - 1][cx * U + 4], b2 = g[H - 1][cx * U + 5];
    if (isSock(t)) socks.push({ cx, cy: 0, e: 0, arrow: t === '^' });
    else if (openPair(t, t2)) socks.push({ cx, cy: 0, e: 0, open: true });
    if (isSock(b)) socks.push({ cx, cy: ch - 1, e: 2, arrow: b === '^' });
    else if (openPair(b, b2)) socks.push({ cx, cy: ch - 1, e: 2, open: true });
  }
  for (let cy = 0; cy < ch; cy++) {
    const r = g[cy * U + 4][W - 1], r2 = g[cy * U + 5][W - 1];
    const l = g[cy * U + 4][0], l2 = g[cy * U + 5][0];
    if (isSock(r)) socks.push({ cx: cw - 1, cy, e: 1, arrow: r === '^' });
    else if (openPair(r, r2)) socks.push({ cx: cw - 1, cy, e: 1, open: true });
    if (isSock(l)) socks.push({ cx: 0, cy, e: 3, arrow: l === '^' });
    else if (openPair(l, l2)) socks.push({ cx: 0, cy, e: 3, open: true });
  }
  return { name, g, cw, ch, socks, arrow: socks.some((s) => s.arrow), rot: ((rot % 4) + 4) % 4 };
}

// The two characters a socket occupies, in piece-local coordinates.
function socketCells(s) {
  const x0 = s.cx * U, y0 = s.cy * U;
  if (s.e === 0) return [[x0 + 4, y0], [x0 + 5, y0]];
  if (s.e === 2) return [[x0 + 4, y0 + U - 1], [x0 + 5, y0 + U - 1]];
  if (s.e === 1) return [[x0 + U - 1, y0 + 4], [x0 + U - 1, y0 + 5]];
  return [[x0, y0 + 4], [x0, y0 + 5]];
}
const behindCells = (s) => socketCells(s).map(([x, y]) => [x - DX[s.e], y - DY[s.e]]);
const setCells = (p, cells, ch) => { for (const [x, y] of cells) p.g[y][x] = ch; };
const standable = (c) => c === '.' || c === '=' || /[a-z]/.test(c);
const isFloorAt = (p, cells) => cells.every(([x, y]) => standable(p.g[y]?.[x]));

/**
 * Fill `lvl` with tiles. Returns the assembly's statistics, which the tests
 * read; the level itself carries everything the game reads.
 */
export function assemble(lvl, rng, { depth, boss = false, maxSpecials = 2, trace = null } = {}) {
  const cols = lvl.w / U, rows = lvl.h / U;
  const cells = Array.from({ length: rows }, () => Array(cols).fill(null));
  const pieces = [];
  const stats = { pieces: 0, loops: 0, cut: 0, deadEnds: 0, reopened: 0, specials: 0, runsBroken: 0 };
  const inBounds = (x, y) => x >= 0 && x < cols && y >= 0 && y < rows;
  const pick = (a) => rng.pick(a);

  const canPlace = (p, ox, oy) => {
    for (let dy = 0; dy < p.ch; dy++) for (let dx = 0; dx < p.cw; dx++) {
      if (!inBounds(ox + dx, oy + dy) || cells[oy + dy][ox + dx] != null) return false;
    }
    return true;
  };
  const place = (p, ox, oy) => {
    const pl = { id: pieces.length, p, ox, oy };
    pieces.push(pl);
    for (let dy = 0; dy < p.ch; dy++) for (let dx = 0; dx < p.cw; dx++) cells[oy + dy][ox + dx] = pl.id;
    stats.pieces++;
    return pl;
  };
  const socketAt = (wx, wy, e) => {
    const id = cells[wy]?.[wx]; if (id == null) return null;
    const pl = pieces[id];
    const s = pl.p.socks.find((q) => q.cx === wx - pl.ox && q.cy === wy - pl.oy && q.e === e);
    return s ? { pl, s } : null;
  };
  // A walled socket is a wall. It is taken OUT of the socket list, so that
  // `reopen` can give it another chance later: the first port left it listed,
  // reopen skipped every listed socket, and a floor that had walled two good
  // sockets early starved at three pieces with nowhere it was allowed to grow.
  // An open edge is never written to: no door, no wall. It is recognised by
  // what is drawn there rather than by a flag, because half the callers build
  // their socket coordinates on the spot.
  const isOpenEdge = (pl, s) => isFloorAt(pl.p, socketCells(s));
  const wallAt = (pl, s) => {
    s.done = true;
    if (isOpenEdge(pl, s)) return;                  // floor against rock is fine
    setCells(pl.p, socketCells(s), '#');
    pl.p.socks = pl.p.socks.filter((q) => q !== s);
  };
  // A connection is two socket rows, one on each tile. The DOOR goes on the
  // tile you ENTER - the side the board game's arrow points at - and the
  // other side is plain floor, so a doorway is one row of two leaves rather
  // than four leaves in a clump. And some of the time there is no door at
  // all: an open archway, which is the difference between a floor of rooms
  // and a floor of cells. `openAt` is the open side, `doorAt` the door side.
  // On an open edge both are no-ops: the edge was never anything but open.
  const openAt = (pl, s) => { s.done = true; if (!isOpenEdge(pl, s)) setCells(pl.p, socketCells(s), '.'); };
  const doorAt = (pl, s) => { s.done = true; if (!isOpenEdge(pl, s)) setCells(pl.p, socketCells(s), rng.rn2(4) === 0 ? '.' : 'D'); };
  // Either side of a connection reads as one, whichever character it got.
  const isOpening = (c) => c === 'D' || c === '.';

  const frontier = [];
  const pushSockets = (pl) => { for (const s of pl.p.socks) frontier.push({ pl, s }); };

  // ---- fixed pieces first ------------------------------------------------
  {
    let p, ox, oy, tries = 0;
    do {
      p = piece('stairIn', rng.rn2(4));
      ox = rng.rn2(Math.max(1, Math.floor(cols / 3)));
      oy = rng.rn2(rows);
    } while (!(canPlace(p, ox, oy) && p.socks.some((s) => inBounds(ox + s.cx + DX[s.e], oy + s.cy + DY[s.e]))) && ++tries < 100);
    pushSockets(place(p, ox, oy));
  }
  let hall = null;
  if (boss) {
    // Away from the entry, sockets facing inward, so the floor grows toward
    // it and nothing else can take its ground.
    // The placement with the most sockets facing INTO the map. It cannot be
    // "all of them": with a socket on every side, a 2x2 on a three-row grid
    // always has one side against the edge, and requiring none to was a hall
    // that never got placed at all. The ones facing out become wall.
    let best = null, bestIn = -1;
    for (let tries = 0; tries < 60; tries++) {
      const p = piece('dragonHall', rng.rn2(4));
      const ox = cols - p.cw - rng.rn2(Math.max(1, cols - p.cw - 1)), oy = rng.rn2(Math.max(1, rows - p.ch + 1));
      if (ox < 2 || !canPlace(p, ox, oy)) continue;
      const inward = p.socks.filter((s) => inBounds(ox + s.cx + DX[s.e], oy + s.cy + DY[s.e])).length;
      if (inward > bestIn) { best = { p, ox, oy }; bestIn = inward; }
    }
    // Its sockets do NOT join the frontier. A hall that grows its own tree of
    // tiles produces two trees on the floor, and where they meet is decided by
    // luck - on one seed every shared wall had a bend's solid side on it, so
    // nothing could be cut, the hall was buried as unreachable, and the dragon
    // fell back to the entry room with the fire and the keeper. The hall sits
    // still; the floor grows toward it and cuts in, and its interior is all
    // floor so any neighbour can.
    if (best) hall = place(best.p, best.ox, best.oy);
  }

  // ---- the piles ---------------------------------------------------------
  const pileNames = Object.keys(GEOMORPHS).filter((n) => !GEOMORPHS[n].special && !GEOMORPHS[n].fixed);
  const weighted = pileNames.flatMap((n) => Array(GEOMORPHS[n].weight ?? 1).fill(n));
  // Specials only where their situation is allowed, and never on the boss
  // floor - populate places that floor by hand and would leave a cast unfilled.
  const specialNames = boss ? [] : Object.keys(GEOMORPHS).filter((n) => {
    const sp = GEOMORPHS[n].special;
    return sp && CHAMBER_BY_KEY[sp] && depth >= CHAMBER_BY_KEY[sp].minDepth;
  });

  const total = cols * rows;
  const MIN_FILL = Math.floor(total * 0.7);
  const filledCells = () => cells.flat().filter((c) => c != null).length;

  const reopen = () => {
    const cands = [];
    for (const pl of pieces) {
      for (let cy = 0; cy < pl.p.ch; cy++) for (let cx = 0; cx < pl.p.cw; cx++) for (let e = 0; e < 4; e++) {
        const wx = pl.ox + cx + DX[e], wy = pl.oy + cy + DY[e];
        if (!inBounds(wx, wy) || cells[wy][wx] != null) continue;
        const existing = pl.p.socks.find((q) => q.cx === cx && q.cy === cy && q.e === e);
        // An open edge that faces empty ground and has already been through
        // the frontier can go through it again: it is still a way to grow.
        if (existing) { if (existing.open && existing.done) cands.push({ pl, s: existing, again: true }); continue; }
        const s = { cx, cy, e };
        if (!isFloorAt(pl.p, behindCells(s))) continue;
        cands.push({ pl, s });
      }
    }
    trace?.(`reopen: ${cands.length} candidates, ${filledCells()}/${total} cells filled`);
    if (!cands.length) return false;
    const { pl, s, again } = pick(cands);
    if (again) { s.done = false; }
    else { pl.p.socks.push(s); setCells(pl.p, socketCells(s), '+'); }
    frontier.push({ pl, s }); stats.reopened++;
    return true;
  };

  // ---- grow --------------------------------------------------------------
  // When nothing can be reopened and the floor is still thin, swap a placed
  // single-cell piece beside an empty cell for a cross - which has floor
  // behind every edge - and try again. Without this a floor whose first few
  // draws were bends and passages, all solid-sided, stopped at four pieces.
  const unstick = () => {
    const cands = pieces.filter((pl) =>
      pl.p.cw === 1 && pl.p.ch === 1 && !GEOMORPHS[pl.p.name].special && !GEOMORPHS[pl.p.name].fixed &&
      pl.p.name !== 'cross' &&
      [0, 1, 2, 3].some((e) => inBounds(pl.ox + DX[e], pl.oy + DY[e]) && cells[pl.oy + DY[e]][pl.ox + DX[e]] == null));
    if (!cands.length) return false;
    const old = pick(cands);
    const np = { id: old.id, p: piece('cross', 0), ox: old.ox, oy: old.oy };
    pieces[old.id] = np;
    for (const q of np.p.socks) {
      const tx = np.ox + DX[q.e], ty = np.oy + DY[q.e];
      if (!inBounds(tx, ty)) { wallAt(np, q); continue; }
      const tid = cells[ty][tx];
      if (tid == null) { frontier.push({ pl: np, s: q }); continue; }        // room to grow
      const there = pieces[tid];
      const bs = { cx: tx - there.ox, cy: ty - there.oy, e: opp(q.e) };
      const back = socketAt(tx, ty, opp(q.e));
      const bc = socketCells(bs);
      if (back) { openAt(np, q); doorAt(back.pl, back.s); }
      else if (isOpening(there.p.g[bc[0][1]][bc[0][0]]) && isFloorAt(there.p, behindCells(bs))) openAt(np, q);   // was connected to the old piece
      else if (isFloorAt(there.p, behindCells(bs))) { openAt(np, q); doorAt(there, bs); }
      else wallAt(np, q);
    }
    stats.unstuck = (stats.unstuck ?? 0) + 1;
    return true;
  };

  // A special that was drawn and has not fitted yet. Half the floors start
  // with one already on top of the deck, and that is for the span: its banks
  // need a neighbour to the north and to the south, so on a three-row grid it
  // can only ever sit in the middle row, and with an arrow it has one
  // rotation per approach. It fits while the middle row is still empty and
  // hardly ever after - measured at 1.7% of eligible floors when it was only
  // ever rolled for mid-growth, 7% once a miss kept it pending, and the rest
  // of the way here. The per-socket roll below still adds a second one.
  let pendingSpecial = (specialNames.length && rng.rn2(2) === 0) ? pick(specialNames) : null;
  while (frontier.length || (filledCells() < MIN_FILL && (reopen() || unstick()))) {
    if (!frontier.length) continue;
    const { pl, s } = frontier.splice(rng.rn2(frontier.length), 1)[0];
    // Resolved already - possibly from the other side, when a later piece
    // found this socket facing it. A flag rather than the character, because
    // an open edge is drawn as floor from the start and would otherwise look
    // resolved before anything had happened to it.
    if (s.done) continue;
    const wx = pl.ox + s.cx + DX[s.e], wy = pl.oy + s.cy + DY[s.e];

    if (!inBounds(wx, wy)) { trace?.(`${pl.p.name}@${pl.ox},${pl.oy} e${s.e} -> off map`); wallAt(pl, s); stats.deadEnds++; continue; }

    if (cells[wy][wx] != null) {
      const back = socketAt(wx, wy, opp(s.e));
      if (back) { openAt(pl, s); doorAt(back.pl, back.s); stats.loops++; continue; }
      const there = pieces[cells[wy][wx]];
      const bs = { cx: wx - there.ox, cy: wy - there.oy, e: opp(s.e) };
      // A piece that needs every socket connected always cuts through if it
      // can; anything else, some of the time.
      const must = GEOMORPHS[pl.p.name].allEnds || GEOMORPHS[there.p.name].fixed;
      if (isFloorAt(there.p, behindCells(bs)) && (must || rng.rn2(10) < 4)) {
        openAt(pl, s); doorAt(there, bs);
        stats.loops++; stats.cut++;
      } else { wallAt(pl, s); stats.deadEnds++; }
      continue;
    }

    // Every way `name` could sit here with a socket facing back at us.
    const optionsFor = (name) => {
      const out = [];
      for (let rot = 0; rot < 4; rot++) {
        const p = piece(name, rot);
        for (const q of p.socks) {
          if (q.e !== opp(s.e)) continue;
          // A tile with an arrow is entered by the arrow, full stop. The
          // rotations where some other socket faces back are not placements.
          if (p.arrow && !q.arrow) continue;
          const ox = wx - q.cx, oy = wy - q.cy;
          if (canPlace(p, ox, oy)) out.push({ p, ox, oy, q });
        }
      }
      const facesOut = ({ p, ox, oy }) => p.socks.some((t) => !inBounds(ox + t.cx + DX[t.e], oy + t.cy + DY[t.e]));
      let inward = out.filter((o) => !facesOut(o));
      if (GEOMORPHS[name].allEnds) {
        // Every socket must be able to connect: an empty cell (a tile will
        // be drawn facing back), or an occupied one it can cut through into.
        const connectable = ({ p, ox, oy }) => p.socks.every((t) => {
          const tx = ox + t.cx + DX[t.e], ty = oy + t.cy + DY[t.e];
          if (!inBounds(tx, ty)) return false;
          const id = cells[ty][tx];
          if (id == null) return true;
          const there = pieces[id];
          const bs = { cx: tx - there.ox, cy: ty - there.oy, e: opp(t.e) };
          return !!socketAt(tx, ty, opp(t.e)) || isFloorAt(there.p, behindCells(bs));
        });
        inward = inward.filter(connectable);
        return inward;                 // never a placement it cannot satisfy
      }
      return inward.length ? inward : out;
    };

    // Draw. A special first, some of the time - and if it will not fit HERE,
    // draw from the pile instead. The first port walled the socket when a
    // special could not be placed, which killed two good sockets on one floor
    // because the die had said "span" twice, and that floor starved at three
    // pieces.
    // A special that did not fit stays on top of the stack and is tried at
    // the next socket, while the pile supplies this one - what a card that
    // does not fit does in the board game. It matters more than it sounds: a
    // tile with an arrow has exactly one rotation per approach, and the span
    // also needs a 2x1 footprint with all four ends connectable, so rolling
    // the die afresh on every miss took it from common to 1.7% of the floors
    // deep enough for it.
    let name = null, options = [];
    if (pendingSpecial) {
      options = optionsFor(pendingSpecial);
      if (options.length) { name = pendingSpecial; pendingSpecial = null; }
      trace?.(`${pl.p.name}@${pl.ox},${pl.oy} e${s.e} -> (${wx},${wy}) pending ${name ?? pendingSpecial}: ${options.length} placements`);
    }
    if (!name && specialNames.length && stats.specials < maxSpecials && rng.rn2(4) === 0) {
      const drawn = pick(specialNames);
      options = optionsFor(drawn);
      if (options.length) name = drawn; else pendingSpecial = drawn;
      trace?.(`${pl.p.name}@${pl.ox},${pl.oy} e${s.e} -> (${wx},${wy}) special ${drawn}: ${options.length} placements`);
    }
    if (!options.length) {
      const pool = stats.pieces < 5 ? weighted.filter((n) => n !== 'nook') : weighted;
      name = pick(pool);
      options = optionsFor(name);
      trace?.(`${pl.p.name}@${pl.ox},${pl.oy} e${s.e} -> (${wx},${wy}) draw ${name}: ${options.length} placements`);
    }
    if (!options.length) { wallAt(pl, s); stats.deadEnds++; continue; }
    const chosen = pick(options);
    trace?.(`   placed ${name} at ${chosen.ox},${chosen.oy}`);

    const placed = place(chosen.p, chosen.ox, chosen.oy);
    // Which socket it was entered by - recorded, so the arrow rule can be
    // checked against what actually happened rather than inferred later.
    placed.entry = chosen.q;
    if (GEOMORPHS[name].special) stats.specials++;
    openAt(pl, s); doorAt(placed, chosen.q);
    for (const q of placed.p.socks) if (q !== chosen.q) frontier.push({ pl: placed, s: q });
  }

  // ---- loops between neighbours that share a wall ------------------------
  const doorOpen = (wx, wy, e) => {
    const id = cells[wy]?.[wx]; if (id == null) return false;
    const pl = pieces[id];
    const sq = { cx: wx - pl.ox, cy: wy - pl.oy, e };
    const sc = socketCells(sq);
    return isOpening(pl.p.g[sc[0][1]][sc[0][0]]) && isFloorAt(pl.p, behindCells(sq));
  };
  for (let wy = 0; wy < rows; wy++) for (let wx = 0; wx < cols; wx++) {
    const id = cells[wy][wx]; if (id == null) continue;
    for (const e of [1, 2]) {
      const nx = wx + DX[e], ny = wy + DY[e];
      if (!inBounds(nx, ny)) continue;
      const nid = cells[ny][nx]; if (nid == null || nid === id) continue;
      if (doorOpen(wx, wy, e)) continue;
      const a = pieces[id], b = pieces[nid];
      const sa = { cx: wx - a.ox, cy: wy - a.oy, e }, sb = { cx: nx - b.ox, cy: ny - b.oy, e: opp(e) };
      if (isFloorAt(a.p, behindCells(sa)) && isFloorAt(b.p, behindCells(sb)) && rng.rn2(10) < 3) {
        openAt(a, sa); doorAt(b, sb);
        stats.loops++; stats.cut++;
      }
    }
  }

  // ---- break long straight runs ------------------------------------------
  const reachCount = () => {
    const seen = new Set([0]); const q = [pieces[0]];
    while (q.length) {
      const cur = q.shift();
      for (let cy = 0; cy < cur.p.ch; cy++) for (let cx = 0; cx < cur.p.cw; cx++) for (let e = 0; e < 4; e++) {
        if (!doorOpen(cur.ox + cx, cur.oy + cy, e)) continue;
        const nid = cells[cur.oy + cy + DY[e]]?.[cur.ox + cx + DX[e]];
        if (nid == null || seen.has(nid)) continue;
        seen.add(nid); q.push(pieces[nid]);
      }
    }
    return seen.size;
  };
  const setDoor = (wx, wy, e, ch) => {
    const a = pieces[cells[wy][wx]], b = pieces[cells[wy + DY[e]][wx + DX[e]]];
    const sa = { cx: wx - a.ox, cy: wy - a.oy, e }, sb = { cx: wx + DX[e] - b.ox, cy: wy + DY[e] - b.oy, e: opp(e) };
    if (!isOpenEdge(a, sa)) setCells(a.p, socketCells(sa), ch);
    if (!isOpenEdge(b, sb)) setCells(b.p, socketCells(sb), ch);
  };
  // Is the door between these two cells one that must not be closed? An
  // arrow's door - closing it would leave that tile entered from somewhere
  // else, the one thing an arrow forbids - or an open edge, which has no door
  // to close and would get two wall tiles in the middle of a wide opening.
  const isArrowDoor = (wx, wy, e) => {
    const a = pieces[cells[wy][wx]], b = pieces[cells[wy + DY[e]][wx + DX[e]]];
    const sa = { cx: wx - a.ox, cy: wy - a.oy, e }, sb = { cx: wx + DX[e] - b.ox, cy: wy + DY[e] - b.oy, e: opp(e) };
    const qa = a.p.socks.find((q) => q.cx === sa.cx && q.cy === sa.cy && q.e === e);
    const qb = b.p.socks.find((q) => q.cx === sb.cx && q.cy === sb.cy && q.e === opp(e));
    return !!(qa?.arrow || qb?.arrow || isOpenEdge(a, sa) || isOpenEdge(b, sb));
  };
  const MAX_RUN = 3;
  for (const [axisE, major, minor] of [[1, cols, rows], [2, rows, cols]]) {
    for (let m = 0; m < minor; m++) {
      let run = [];
      for (let i = 0; i <= major; i++) {
        const wx = axisE === 1 ? i : m, wy = axisE === 1 ? m : i;
        const last = run[run.length - 1];
        const continues = i < major && cells[wy]?.[wx] != null &&
          (!last || cells[wy][wx] === cells[last[1]][last[0]] || doorOpen(last[0], last[1], axisE));
        if (continues) { run.push([wx, wy]); continue; }
        let ids = [...new Set(run.map(([x, y]) => cells[y][x]))];
        while (ids.length > MAX_RUN) {
          // The door nearest the middle that is not an arrow's door.
          const mid = Math.floor(ids.length / 2);
          let k = -1;
          for (const m of [mid, mid - 1, mid + 1, mid - 2, mid + 2]) {
            if (m < 1 || m >= ids.length) continue;
            const kk = run.findIndex(([x, y], j) => cells[y][x] === ids[m - 1] &&
                                                     run[j + 1] && cells[run[j + 1][1]][run[j + 1][0]] === ids[m]);
            if (kk >= 0 && !isArrowDoor(run[kk][0], run[kk][1], axisE)) { k = kk; break; }
          }
          if (k < 0) break;
          const [cx, cy] = run[k];
          const before = reachCount();
          setDoor(cx, cy, axisE, '#');
          if (reachCount() < before) { setDoor(cx, cy, axisE, '.'); break; }
          stats.runsBroken++;
          ids = ids.slice(0, ids.findIndex((id) => id === cells[cy][cx]) + 1);
        }
        run = [];
      }
    }
  }

  // ---- every walkable tile reachable, by TILE and not by piece ------------
  //
  // The piece-level walk above has a blind spot: a piece with two regions
  // inside it. The span is one - a bridge and two banks with a chasm between
  // them - and a door on a bank connects to nothing the bridge can reach. So
  // a gallery drawn off the north bank, and a bend off the gallery, were all
  // "reached" by piece and were an island by foot, with a bonfire on it.
  //
  // This is the old generator's ensureConnected, for tiles: flood from the
  // stair over the actual characters, and wherever an unreached region sits
  // beside a reached one across a socket position with floor on both sides,
  // cut a door. Repeat until nothing changes. Whatever is still cut off is
  // walled over, so nothing can be placed on ground you cannot get to.
  {
    const W = cols * U, H = rows * U;
    const charAt = (wx, wy) => {
      const id = cells[Math.floor(wy / U)]?.[Math.floor(wx / U)];
      if (id == null) return ' ';
      const pl = pieces[id];
      return pl.p.g[wy - pl.oy * U][wx - pl.ox * U];
    };
    const setChar = (wx, wy, ch) => {
      const pl = pieces[cells[Math.floor(wy / U)][Math.floor(wx / U)]];
      pl.p.g[wy - pl.oy * U][wx - pl.ox * U] = ch;
    };
    const walk = (c) => standable(c) || c === 'D' || c === '<' || c === '>' || c === '*';
    const flood = () => {
      const seen = new Uint8Array(W * H);
      let sx = -1, sy = -1;
      for (const pl of pieces) for (let y = 0; y < pl.p.g.length && sx < 0; y++) for (let x = 0; x < pl.p.g[0].length; x++) {
        if (pl.p.g[y][x] === '<') { sx = pl.ox * U + x; sy = pl.oy * U + y; break; }
      }
      if (sx < 0) return seen;
      const st = [[sx, sy]]; seen[sy * W + sx] = 1;
      while (st.length) {
        const [x, y] = st.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx]) continue;
          if (!walk(charAt(nx, ny))) continue;
          seen[ny * W + nx] = 1; st.push([nx, ny]);
        }
      }
      return seen;
    };
    for (let pass = 0; pass < 20; pass++) {
      const seen = flood();
      // Candidate doors: socket positions on a boundary between a reached
      // tile and an unreached one, with floor behind both.
      const cands = [];
      for (let wy = 0; wy < rows; wy++) for (let wx = 0; wx < cols; wx++) {
        const id = cells[wy][wx]; if (id == null) continue;
        for (const e of [1, 2]) {
          const nx = wx + DX[e], ny = wy + DY[e];
          if (!inBounds(nx, ny)) continue;
          const nid = cells[ny][nx]; if (nid == null || nid === id) continue;
          const a = pieces[id], b = pieces[nid];
          const sa = { cx: wx - a.ox, cy: wy - a.oy, e }, sb = { cx: nx - b.ox, cy: ny - b.oy, e: opp(e) };
          if (doorOpen(wx, wy, e)) continue;
          const ba = behindCells(sa), bb = behindCells(sb);
          if (!isFloorAt(a.p, ba) || !isFloorAt(b.p, bb)) continue;
          const ra = seen[(a.oy * U + ba[0][1]) * W + (a.ox * U + ba[0][0])];
          const rb = seen[(b.oy * U + bb[0][1]) * W + (b.ox * U + bb[0][0])];
          if (!!ra !== !!rb) cands.push({ a, sa, b, sb });
        }
      }
      if (cands.length) {
        const { a, sa, b, sb } = pick(cands);
        openAt(a, sa); doorAt(b, sb);   // both respect an open edge
        stats.loops++; stats.cut++; stats.rejoined = (stats.rejoined ?? 0) + 1;
        continue;
      }
      // Nothing to cut: the unreached ground is not beside any reached floor.
      // Grow from a REACHED piece into an empty cell, and resolve the new
      // tile's other sockets at once - connect to a socket facing back, or
      // cut where there is floor behind - so each step can close the gap.
      const grow = [];
      for (const pl of pieces) {
        for (let cy = 0; cy < pl.p.ch; cy++) for (let cx = 0; cx < pl.p.cw; cx++) for (let e = 0; e < 4; e++) {
          const wx = pl.ox + cx + DX[e], wy = pl.oy + cy + DY[e];
          if (!inBounds(wx, wy) || cells[wy][wx] != null) continue;
          const sq = { cx, cy, e };
          if (!isFloorAt(pl.p, behindCells(sq))) continue;
          const [bx, by] = behindCells(sq)[0];
          if (!seen[(pl.oy * U + by) * W + (pl.ox * U + bx)]) continue;      // grow from reached ground only
          grow.push({ pl, sq, wx, wy });
        }
      }
      if (!grow.length) {
        // The grid is full and nothing can be cut: every piece beside the
        // unreached ground shows it a solid face. Replace one such piece with
        // a cross, which has floor behind every edge, and connect it to all
        // four neighbours. Prefer swapping the unreached piece itself (an
        // island bend, say); failing that a reached neighbour of it. Only
        // single-cell pile pieces are swapped - never a situation, the entry
        // or the hall.
        const swappable = (pl) => pl.p.cw === 1 && pl.p.ch === 1 && !GEOMORPHS[pl.p.name].special && !GEOMORPHS[pl.p.name].fixed;
        const reachedPiece = (pl) => {
          for (let y = 0; y < U; y++) for (let x = 0; x < U; x++) {
            if (standable(pl.p.g[y][x]) && seen[(pl.oy * U + y) * W + (pl.ox * U + x)]) return true;
          }
          return false;
        };
        // ON THE BOUNDARY, and nowhere else. The first version swapped any
        // unreached piece that could be swapped, which on one floor was
        // twenty pieces deep inside the unreached cluster - each swap joined
        // it to other unreached pieces and never to the reached side, and
        // then 640 tiles were buried. A swap can only help where the two
        // regions touch: an unreached piece with a reached neighbour, or the
        // reached neighbour itself.
        const unreachedPieces = pieces.filter((pl) => !reachedPiece(pl));
        let target = null;
        for (const up of unreachedPieces) {
          let reachedNb = null;
          // Every cell of the piece, not just its top-left: a 2x2 hall has
          // twelve neighbours.
          for (let cy = 0; cy < up.p.ch && !reachedNb; cy++) for (let cx = 0; cx < up.p.cw && !reachedNb; cx++) {
            for (let e = 0; e < 4 && !reachedNb; e++) {
              const nid = cells[up.oy + cy + DY[e]]?.[up.ox + cx + DX[e]];
              if (nid == null || nid === up.id) continue;
              if (reachedPiece(pieces[nid])) reachedNb = pieces[nid];
            }
          }
          if (!reachedNb) continue;                    // not on the boundary
          if (swappable(up)) { target = up; break; }
          if (swappable(reachedNb)) { target = reachedNb; break; }
        }
        if (!target) break;
        const np = { id: target.id, p: piece('cross', 0), ox: target.ox, oy: target.oy };
        pieces[target.id] = np;
        for (const q of np.p.socks) {
          const tx = np.ox + DX[q.e], ty = np.oy + DY[q.e];
          if (!inBounds(tx, ty) || cells[ty][tx] == null) { wallAt(np, q); continue; }
          const there = pieces[cells[ty][tx]];
          const bs = { cx: tx - there.ox, cy: ty - there.oy, e: opp(q.e) };
          const back = socketAt(tx, ty, opp(q.e));
          if (back) { openAt(np, q); doorAt(back.pl, back.s); }
          else if (isFloorAt(there.p, behindCells(bs))) { openAt(np, q); doorAt(there, bs); }
          else {
            // The neighbour may already have an opening on this edge (it was
            // connected to the piece we just replaced). Keep it.
            const bc = socketCells(bs);
            if (isOpening(there.p.g[bc[0][1]][bc[0][0]]) && isFloorAt(there.p, behindCells(bs))) openAt(np, q); else wallAt(np, q);
          }
        }
        stats.swapped = (stats.swapped ?? 0) + 1;
        continue;
      }
      const { pl, sq, wx, wy } = pick(grow);
      // A tile with floor behind every edge, so whatever it lands beside can
      // be reached through it. Several qualify and the order is shuffled: a
      // repair that always reached for `cross` first put six of them on one
      // floor. (The swap repair below still uses a cross - it needs a socket
      // on all four sides to re-resolve every neighbour.)
      let placedAny = false;
      const fillers = ['cross', 'hall', 'pillared', 'split'];
      for (let i = fillers.length - 1; i > 0; i--) { const j = rng.rn2(i + 1); [fillers[i], fillers[j]] = [fillers[j], fillers[i]]; }
      for (const name of [...fillers, 'tee', 'landing']) {
        const opts = [];
        for (let rot = 0; rot < 4; rot++) {
          const p = piece(name, rot);
          for (const q of p.socks) {
            if (q.e !== opp(sq.e)) continue;
            const ox = wx - q.cx, oy = wy - q.cy;
            if (canPlace(p, ox, oy)) opts.push({ p, ox, oy, q });
          }
        }
        if (!opts.length) continue;
        const ch = pick(opts);
        const np = place(ch.p, ch.ox, ch.oy);
        openAt(pl, sq); doorAt(np, ch.q);
        // resolve its other sockets now
        for (const q of np.p.socks) {
          if (q === ch.q) continue;
          const tx = np.ox + q.cx + DX[q.e], ty = np.oy + q.cy + DY[q.e];
          if (!inBounds(tx, ty)) { wallAt(np, q); continue; }
          const tid = cells[ty][tx];
          if (tid == null) { wallAt(np, q); continue; }           // no further growth here
          const back = socketAt(tx, ty, opp(q.e));
          const there = pieces[tid];
          const bs = { cx: tx - there.ox, cy: ty - there.oy, e: opp(q.e) };
          if (back) { openAt(np, q); doorAt(back.pl, back.s); stats.loops++; }
          else if (isFloorAt(there.p, behindCells(bs))) { openAt(np, q); doorAt(there, bs); stats.loops++; stats.cut++; }
          else wallAt(np, q);
        }
        stats.grown = (stats.grown ?? 0) + 1;
        placedAny = true;
        break;
      }
      if (!placedAny) break;
    }
    // Wall over what is still cut off. Anchors on it are dropped at write
    // time because the character is no longer an anchor letter.
    const seen = flood();
    let buried = 0;
    for (let wy = 0; wy < H; wy++) for (let wx = 0; wx < W; wx++) {
      const c = charAt(wx, wy);
      if (c === ' ' || !walk(c) || seen[wy * W + wx]) continue;
      setChar(wx, wy, '#'); buried++;
    }
    if (buried) stats.buried = buried;
  }

  // ---- the way down: farthest from the entry by walking ------------------
  if (!boss) {
    const dist = new Map([[0, 0]]); const q = [pieces[0]];
    while (q.length) {
      const cur = q.shift();
      for (let cy = 0; cy < cur.p.ch; cy++) for (let cx = 0; cx < cur.p.cw; cx++) for (let e = 0; e < 4; e++) {
        if (!doorOpen(cur.ox + cx, cur.oy + cy, e)) continue;
        const nid = cells[cur.oy + cy + DY[e]]?.[cur.ox + cx + DX[e]];
        if (nid == null || dist.has(nid)) continue;
        dist.set(nid, dist.get(cur.id) + 1); q.push(pieces[nid]);
      }
    }
    let far = null;
    for (const pl of pieces) {
      if (pl.id === 0 || GEOMORPHS[pl.p.name].special) continue;
      const d = dist.get(pl.id) ?? -1;
      if (d > (far?.d ?? -1)) far = { pl, d };
    }
    if (far) {
      const p = far.pl.p, cx = Math.floor(p.g[0].length / 2), cy = Math.floor(p.g.length / 2);
      outer: for (let r = 0; r < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (p.g[cy + dy]?.[cx + dx] === '.') { p.g[cy + dy][cx + dx] = '>'; break outer; }
      }
      stats.exitDistance = far.d;
    }
  }

  // ---- write into the level ----------------------------------------------
  let fireId = 0;
  for (const pl of pieces) {
    const spec = GEOMORPHS[pl.p.name];
    const room = {
      x: pl.ox * U + 1, y: pl.oy * U + 1, w: pl.p.cw * U - 2, h: pl.p.ch * U - 2,
      id: lvl.rooms.length, type: 'ordinary', lit: true, tile: pl.p.name, rot: pl.p.rot,
      entry: pl.entry ? { e: pl.entry.e, cx: pl.entry.cx, cy: pl.entry.cy, arrow: !!pl.entry.arrow } : null,
    };
    lvl.rooms.push(room);
    const anchors = {};
    for (let y = 0; y < pl.p.g.length; y++) {
      for (let x = 0; x < pl.p.g[0].length; x++) {
        const wx = pl.ox * U + x, wy = pl.oy * U + y;
        let ch = pl.p.g[y][x];
        if (ch === '+' || ch === '^') ch = '#';
        if (/[a-z]/.test(ch)) {
          const a = spec.anchors?.[ch];
          const name = typeof a === 'string' ? a : a?.name;
          const tile = typeof a === 'object' && a?.tile ? T[a.tile] : T.FLOOR;
          if (name) (anchors[name] ??= []).push({ x: wx, y: wy });
          lvl.set(wx, wy, tile);
        } else {
          lvl.set(wx, wy, CHAR_TILE[ch] ?? T.STONE);
        }
        lvl.lit[lvl.idx(wx, wy)] = 1;
        if (ch === '<') lvl.upStair = { x: wx, y: wy };
        if (ch === '>') lvl.downStair = { x: wx, y: wy };
        if (ch === '*') { lvl.bonfires.push({ x: wx, y: wy, id: fireId++ }); lvl.claimRoom('fire', room.id); }
      }
    }
    if (lvl.upStair && lvl.roomAt(lvl.upStair.x, lvl.upStair.y)?.id === room.id) lvl.claimRoom('stair', room.id);
    if (lvl.downStair && lvl.roomAt(lvl.downStair.x, lvl.downStair.y)?.id === room.id) lvl.claimRoom('stair', room.id);
    if (spec.special) {
      // Only if every named anchor survived. A bank that could not be
      // connected was walled over above, and a span with no ledge is not a
      // gauntlet - it is a bridge in a room. Then it is a room.
      const declared = new Set(Object.values(spec.anchors ?? {}).map((a) => typeof a === 'string' ? a : a.name));
      const whole = [...declared].every((n) => anchors[n]?.length);
      if (whole) {
        lvl.chambers.push({ key: spec.special, room: room.id, anchors });
        lvl.claimRoom('chamber', room.id);
      } else {
        stats.degraded = (stats.degraded ?? 0) + 1;
      }
    }
    if (pl === hall) lvl.claimRoom('arena', room.id);
    // A tile that asked for its own enemies gets its room to itself: the
    // random fill, the extra fire and the chest all avoid claimed rooms.
    if (spec.enemies != null) lvl.claimRoom('staged', room.id);
  }
  lvl.genKind = 'geomorph';
  lvl.geomorph = stats;
  return stats;
}
