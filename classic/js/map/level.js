// One dungeon level: terrain, what is on it, and what the hero remembers of it.
//
// The memory model is the interesting part. Three pieces of per-cell state,
// deliberately kept separate:
//
//   visible  - lit by the hero's field of view *this turn*. Recomputed on move.
//   seen     - terrain the hero has ever seen. Drawn dimmed when not visible.
//   memObj   - a snapshot of the topmost object seen on that cell.
//
// Objects need their own memory because they persist in the mind after the
// light moves on, and because a monster can pick one up while you are not
// looking - at which point your memory is wrong, and it *should* be. Nothing
// re-syncs memObj except seeing the cell again.

import { T, TILE, isWalkable, isOpaque, isDoor, isSecret,
         diagonalOk as tilesDiagonalOk, blocksDiagonal } from './tiles.js';

export const MAP_W = 80;
export const MAP_H = 21;

export class Level {
  constructor(depth, w = MAP_W, h = MAP_H) {
    this.depth = depth;
    this.w = w;
    this.h = h;
    const n = w * h;

    this.tiles   = new Uint8Array(n);        // T.*
    this.lit     = new Uint8Array(n);        // room lighting, independent of FOV
    this.seen    = new Uint8Array(n);        // ever seen by the hero
    this.visible = new Uint8Array(n);        // in FOV right now
    this.memObj  = new Array(n).fill(null);  // remembered top object {glyph,colour,sprite}
    this.noise   = new Uint8Array(n);        // per-cell decor variation, filled by mapgen

    this.rooms     = [];                     // {x,y,w,h,type,lit,id}
    this.monsters  = [];
    this.items     = [];                     // objects lying on the floor, each with .x/.y
    this.traps     = new Map();              // idx -> {type, seen, ...}
    this.engravings = new Map();             // idx -> {text, type}
    this.shops     = [];                     // {room, shk, kind}

    this.upStair = null;                     // {x,y}
    this.downStair = null;
    this.arrivedFrom = null;
    this.flags = { maze: false, bigroom: false, sanctum: false, cavern: false, noTeleport: false };
    this.name = null;                        // special-level title, if any
    this.turnsSpent = 0;
  }

  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  at(x, y) { return this.inBounds(x, y) ? this.tiles[this.idx(x, y)] : T.STONE; }
  set(x, y, t) { if (this.inBounds(x, y)) this.tiles[this.idx(x, y)] = t; }

  walkable(x, y) { return this.inBounds(x, y) && isWalkable(this.at(x, y)); }
  opaque(x, y)   { return !this.inBounds(x, y) || isOpaque(this.at(x, y)); }

  /**
   * Can this mover enter the square? `mon === null` means the hero.
   *
   * The hero and a monster genuinely differ here, and conflating them was a
   * real bug: a closed door is a wall to anything without hands, but the hero
   * opens one by walking into it. With the hero treated like a handless
   * monster, a flood fill out of a room with all its doors shut reported the
   * rest of the level unreachable, and autoexplore refused to move.
   */
  passable(x, y, mon = null) {
    if (!this.inBounds(x, y)) return false;
    const t = this.at(x, y);
    if (t === T.WATER) return !mon || mon.spec.swims || mon.spec.flies || mon.spec.amorphous;
    if (t === T.LAVA)  return !mon || mon.spec.flies || mon.spec.fireRes;
    if (t === T.BARS)  return !!(mon && (mon.spec.amorphous || mon.spec.tiny));
    if (isWalkable(t)) return true;
    if (t === T.DOOR_CLOSED) return !mon || !!(mon.spec.amorphous || mon.spec.unsolid);
    if (t === T.DOOR_LOCKED) return !!(mon && (mon.spec.amorphous || mon.spec.unsolid));
    return false;
  }

  /**
   * Somewhere the hero should not be *routed* through even though they may
   * walk in deliberately. Automatic movement that marches you into lava is
   * not a feature.
   */
  hazard(x, y) {
    const t = this.at(x, y);
    return t === T.LAVA || t === T.WATER;
  }

  // The pathfinder in engine/ asks the level these two questions rather than
  // importing claudeHack's tile table, because "you cannot cut the corner of a
  // doorway" is a rule of this game, not a property of grids.
  diagonalOk(fx, fy, tx, ty) { return tilesDiagonalOk(this, fx, fy, tx, ty); }
  isDoorway(x, y) { return blocksDiagonal(this.at(x, y)); }

  isVisible(x, y) { return this.inBounds(x, y) && !!this.visible[this.idx(x, y)]; }
  isSeen(x, y)    { return this.inBounds(x, y) && !!this.seen[this.idx(x, y)]; }

  clearVisible() { this.visible.fill(0); }

  markSeen(x, y) {
    const i = this.idx(x, y);
    this.seen[i] = 1;
    this.visible[i] = 1;
  }

  // ------------------------------------------------------------- occupants

  // Monster lookup is on the hottest path in the game: A* asks "is anything
  // standing here" for every node it expands, several thousand times per
  // monster per turn. A linear scan of the monster list made deep levels crawl.
  // The index below is rebuilt lazily - any code that moves, adds or kills a
  // monster calls markMonstersDirty(), and the next lookup pays one O(monsters)
  // rebuild before answering in O(1) for the rest of the search.
  markMonstersDirty() { this._monIdx = null; }

  monsterAt(x, y) {
    if (!this.inBounds(x, y)) return null;
    if (!this._monIdx) {
      this._monIdx = new Map();
      for (const m of this.monsters) if (m.alive) this._monIdx.set(this.idx(m.x, m.y), m);
    }
    return this._monIdx.get(this.idx(x, y)) ?? null;
  }

  /** Move a monster and keep the position index honest. */
  moveMonster(mon, x, y) {
    mon.x = x; mon.y = y;
    this.markMonstersDirty();
  }

  itemsAt(x, y) { return this.items.filter((o) => o.x === x && o.y === y); }

  topItemAt(x, y) {
    let best = null;
    for (const o of this.items) {
      if (o.x !== x || o.y !== y) continue;
      // Gold and the Amulet always show over ordinary clutter.
      if (!best || o.cls === 'coin' || o.key === 'Amulet of Yendor') best = o;
    }
    return best;
  }

  addItem(obj, x, y) {
    obj.x = x; obj.y = y;
    // Merge stackable piles so a floor tile does not accumulate 40 separate arrows.
    for (const o of this.items) {
      if (o.x === x && o.y === y && o !== obj && canMerge(o, obj)) {
        o.count += obj.count;
        return o;
      }
    }
    this.items.push(obj);
    return obj;
  }

  removeItem(obj) {
    const i = this.items.indexOf(obj);
    if (i >= 0) this.items.splice(i, 1);
  }

  addMonster(mon, x, y) {
    mon.x = x; mon.y = y;
    this.monsters.push(mon);
    this.markMonstersDirty();
    return mon;
  }

  removeDead() {
    for (let i = this.monsters.length - 1; i >= 0; i--) {
      if (!this.monsters[i].alive) this.monsters.splice(i, 1);
    }
    this.markMonstersDirty();
  }

  // ------------------------------------------------------------------ misc

  roomAt(x, y) {
    for (const r of this.rooms) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
    }
    return null;
  }

  /** Every walkable cell, for placement. Optionally filtered. */
  *walkableCells(pred = null) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!isWalkable(this.tiles[this.idx(x, y)])) continue;
        if (pred && !pred(x, y)) continue;
        yield { x, y };
      }
    }
  }

  /**
   * A free floor square with nothing standing on it.
   *
   * Occupancy is gathered once rather than asked per candidate square: the
   * naive version was O(cells x monsters) and it is called by every wandering
   * monster that needs a new destination, which on a busy level was the single
   * most expensive thing the game did.
   */
  randomFreeSpot(rng, opts = {}) {
    const { avoidStairs = false, roomsOnly = false, awayFrom = null, minDist = 0 } = opts;
    const taken = new Set();
    for (const m of this.monsters) if (m.alive) taken.add(this.idx(m.x, m.y));

    const spots = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const t = this.tiles[i];
        if (!isWalkable(t)) continue;
        if (taken.has(i)) continue;
        if (avoidStairs && (t === T.STAIRS_DOWN || t === T.STAIRS_UP ||
                            t === T.LADDER_DOWN || t === T.LADDER_UP)) continue;
        if (roomsOnly && !this.roomAt(x, y)) continue;
        if (awayFrom && Math.max(Math.abs(x - awayFrom.x), Math.abs(y - awayFrom.y)) < minDist) continue;
        spots.push({ x, y });
      }
    }
    return spots.length ? rng.pick(spots) : null;
  }

  /** Reveal a secret door or corridor at this spot, if there is one. */
  revealSecret(x, y) {
    const t = this.at(x, y);
    if (t === T.SDOOR) { this.set(x, y, T.DOOR_CLOSED); return 'door'; }
    if (t === T.SCORR) { this.set(x, y, T.CORRIDOR);    return 'corridor'; }
    return null;
  }

  hasSecretAt(x, y) { return isSecret(this.at(x, y)); }

  doorAt(x, y) { return isDoor(this.at(x, y)) ? this.at(x, y) : null; }

  trapAt(x, y) { return this.traps.get(this.idx(x, y)) || null; }
  addTrap(x, y, trap) { this.traps.set(this.idx(x, y), trap); return trap; }

  engravingAt(x, y) { return this.engravings.get(this.idx(x, y)) || null; }

  describeTile(x, y) {
    const t = this.at(x, y);
    return TILE[t].name;
  }
}

export function canMerge(a, b) {
  if (!a || !b) return false;
  if (a.key !== b.key || a.cls !== b.cls) return false;
  if (!a.stackable || !b.stackable) return false;
  if (a.enchant !== b.enchant) return false;
  if (a.bless !== b.bless) return false;
  if (a.blessKnown !== b.blessKnown) return false;
  if (a.erode !== b.erode) return false;
  if ((a.charges ?? null) !== (b.charges ?? null)) return false;
  if ((a.userName ?? null) !== (b.userName ?? null)) return false;
  return true;
}
