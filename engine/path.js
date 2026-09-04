// Pathfinding.
//
// Two different tools for two different jobs, which is worth being explicit
// about because using the wrong one is the classic roguelike performance bug:
//
//   astar()    - one agent, one destination. Cheap. Used by monsters chasing
//                the hero and by the travel command.
//   flowField()- one destination, every square's distance to it. Used for
//                monsters that flee (walk *up* the gradient) and for the
//                autoexplore heuristic, where recomputing A* per candidate
//                would be quadratic.
//
// This module is engine: it knows about grids and costs, not about doors or
// monsters. Whether a particular diagonal step is legal is a *game* rule -
// NetHack forbids cutting the corner of a doorway, another game might not - so
// the level answers it through level.diagonalOk(). A level with no opinion
// allows every diagonal. That indirection replaced a direct import of
// claudeHack's tile table, which was the one thing keeping this file from
// being shareable.

import { DIRS } from './util.js';

/** A* over the level for a single mover. Returns [{x,y}...] excluding the start. */
export function astar(level, sx, sy, tx, ty, opts = {}) {
  const { mover = null, maxNodes = 4000, ignoreMonsters = false, doorsOk = true,
          avoidHazards = false } = opts;
  if (sx === tx && sy === ty) return [];

  const W = level.w;
  const start = sy * W + sx, goal = ty * W + tx;
  const came = new Map();
  const g = new Map([[start, 0]]);
  const open = new BinaryHeap((n) => n.f);
  open.push({ i: start, f: heur(sx, sy, tx, ty) });
  let expanded = 0;

  while (open.size()) {
    const cur = open.pop();
    if (cur.i === goal) return rebuild(came, goal, W);
    if (expanded++ > maxNodes) break;

    const cx = cur.i % W, cy = (cur.i / W) | 0;
    for (const d of DIRS) {
      const nx = cx + d.dx, ny = cy + d.dy;
      if (!level.inBounds(nx, ny)) continue;
      const ni = ny * W + nx;
      if (ni !== goal && !stepOk(level, nx, ny, mover, ignoreMonsters, doorsOk)) continue;
      if (avoidHazards && ni !== goal && level.hazard(nx, ny)) continue;
      if (!diagOk(level, cx, cy, nx, ny)) continue;

      const ng = (g.get(cur.i) ?? Infinity) + 1;
      if (ng < (g.get(ni) ?? Infinity)) {
        g.set(ni, ng);
        came.set(ni, cur.i);
        open.push({ i: ni, f: ng + heur(nx, ny, tx, ty) });
      }
    }
  }
  return null;
}

function heur(x, y, tx, ty) { return Math.max(Math.abs(x - tx), Math.abs(y - ty)); }

/** Ask the level whether this diagonal is legal; allow it if the level has no opinion. */
function diagOk(level, fx, fy, tx, ty) {
  return level.diagonalOk ? level.diagonalOk(fx, fy, tx, ty) : true;
}

function stepOk(level, x, y, mover, ignoreMonsters, doorsOk) {
  if (!level.passable(x, y, mover)) return false;
  if (!doorsOk && level.isDoorway?.(x, y)) return false;
  if (!ignoreMonsters && occupied(level, x, y, mover)) return false;
  return true;
}

/**
 * Is something standing here?
 *
 * `occupantAt` rather than `monsterAt`: the second game calls its creatures
 * enemies, and the pathfinder should not know or care what either game names
 * them. This was the last place engine/ still spoke claudeHack's vocabulary,
 * and it only surfaced once a second consumer existed - which is exactly the
 * argument for not designing an engine interface against a single caller.
 */
/**
 * Is something OTHER than the mover standing here?
 *
 * The mover is excluded, and that only started to matter when a creature could
 * be bigger than a tile: a 2x2 body stands on four squares, so three of the
 * four it wants to shuffle onto are its own, and without this the search
 * refused every one of them. A two-tile bull could not take a single step and
 * simply stood in front of the first pillar it met.
 *
 * Harmless for one-tile movers, which are never asked about the square they
 * are already on.
 */
function occupied(level, x, y, mover = null) {
  const who = level.occupantAt ? level.occupantAt(x, y) : level.monsterAt?.(x, y);
  return !!who && who !== mover;
}

function rebuild(came, goal, W) {
  const out = [];
  let cur = goal;
  while (came.has(cur)) {
    out.push({ x: cur % W, y: (cur / W) | 0 });
    cur = came.get(cur);
  }
  return out.reverse();
}

/**
 * Dijkstra distance from a set of goals over the whole level.
 * Returns an Int32Array of step counts, -1 where unreachable.
 *
 * The expansion obeys the no-diagonal-through-a-doorway rule, and it has to:
 * a field built with moves the game will refuse produces a gradient whose only
 * downhill step is illegal, at which point stepAlong finds nothing better than
 * where it stands and autoexplore reports the level fully explored one square
 * inside the first room. The rule is symmetric in the two cells, so applying it
 * while expanding outwards from the goals is the same as applying it while
 * walking inwards towards them.
 */
export function flowField(level, goals, opts = {}) {
  const { mover = null, ignoreMonsters = true, maxDist = 200, avoidHazards = false } = opts;
  const W = level.w, H = level.h;
  const dist = new Int32Array(W * H).fill(-1);
  const queue = [];
  for (const gpt of goals) {
    if (!level.inBounds(gpt.x, gpt.y)) continue;
    const i = gpt.y * W + gpt.x;
    dist[i] = 0; queue.push(i);
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const d = dist[i];
    if (d >= maxDist) continue;
    const x = i % W, y = (i / W) | 0;
    for (const dir of DIRS) {
      const nx = x + dir.dx, ny = y + dir.dy;
      if (!level.inBounds(nx, ny)) continue;
      const ni = ny * W + nx;
      if (dist[ni] !== -1) continue;
      if (!level.passable(nx, ny, mover)) continue;
      if (avoidHazards && level.hazard(nx, ny)) continue;
      if (!ignoreMonsters && occupied(level, nx, ny, mover)) continue;
      if (!diagOk(level, x, y, nx, ny)) continue;
      dist[ni] = d + 1;
      queue.push(ni);
    }
  }
  return dist;
}

/**
 * Step that most decreases (or with `away`, increases) a flow field.
 *
 * This has to honour the same no-diagonal-through-a-doorway rule the movement
 * command enforces, or autoexplore proposes a step the game then refuses and
 * the whole walk stalls one square from a door.
 */
export function stepAlong(level, field, x, y, away = false) {
  const W = level.w;
  let best = null, bestVal = away ? -1 : Infinity;
  const here = field[y * W + x];
  for (const d of DIRS) {
    const nx = x + d.dx, ny = y + d.dy;
    if (!level.inBounds(nx, ny)) continue;
    if (!diagOk(level, x, y, nx, ny)) continue;
    const v = field[ny * W + nx];
    if (v < 0) continue;
    if (away ? v > bestVal : v < bestVal) { bestVal = v; best = { x: nx, y: ny }; }
  }
  if (!best) return null;
  if (!away && here >= 0 && bestVal >= here) return null;
  return best;
}

/** A tiny binary heap; the browser has none and sorting an array is too slow. */
class BinaryHeap {
  constructor(scoreFn) { this.content = []; this.scoreFn = scoreFn; }
  size() { return this.content.length; }
  push(el) {
    this.content.push(el);
    let n = this.content.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.scoreFn(this.content[n]) >= this.scoreFn(this.content[p])) break;
      [this.content[n], this.content[p]] = [this.content[p], this.content[n]];
      n = p;
    }
  }
  pop() {
    const top = this.content[0];
    const end = this.content.pop();
    if (this.content.length) {
      this.content[0] = end;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1, r = l + 1;
        let swap = n;
        if (l < this.content.length && this.scoreFn(this.content[l]) < this.scoreFn(this.content[swap])) swap = l;
        if (r < this.content.length && this.scoreFn(this.content[r]) < this.scoreFn(this.content[swap])) swap = r;
        if (swap === n) break;
        [this.content[n], this.content[swap]] = [this.content[swap], this.content[n]];
        n = swap;
      }
    }
    return top;
  }
}
