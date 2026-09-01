// One floor of the dungeon.
//
// Simpler than claudeHack's Level in two ways and more complicated in one.
//
// Simpler: there are no items on the ground and no object memory, because
// claudeSouls has no loot. Terrain memory (seen / visible) is all that is left.
//
// More complicated: the level carries **projectiles**. An arrow in this game is
// not damage that happens, it is a thing that exists on the board for a couple
// of turns, and it belongs to the level rather than to the archer that fired it
// - the archer may well be dead before it lands.

import { T, TILE, isWalkable, isOpaque, isDoor,
         diagonalOk as tilesDiagonalOk, blocksDiagonal, flyable } from './tiles.js';

export const MAP_W = 64;
export const MAP_H = 25;

export class Level {
  constructor(depth, w = MAP_W, h = MAP_H) {
    this.depth = depth;
    this.w = w;
    this.h = h;
    const n = w * h;

    this.tiles   = new Uint8Array(n);
    this.lit     = new Uint8Array(n);
    this.seen    = new Uint8Array(n);
    this.visible = new Uint8Array(n);
    this.noise   = new Uint8Array(n);

    this.rooms       = [];
    this.enemies     = [];
    this.projectiles = [];
    this.bonfires    = [];      // {x, y, id}

    this.upStair = null;
    this.downStair = null;
    this.genKind = 'rooms';
    this.name = null;
  }

  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  at(x, y) { return this.inBounds(x, y) ? this.tiles[this.idx(x, y)] : T.STONE; }
  set(x, y, t) { if (this.inBounds(x, y)) this.tiles[this.idx(x, y)] = t; }

  walkable(x, y) { return this.inBounds(x, y) && isWalkable(this.at(x, y)); }
  opaque(x, y)   { return !this.inBounds(x, y) || isOpaque(this.at(x, y)); }
  flyable(x, y)  { return this.inBounds(x, y) && flyable(this.at(x, y)); }

  /**
   * Can this mover enter the square? `mover === null` means the player.
   *
   * The player opens closed doors by walking into them; an enemy without hands
   * does not. Same distinction claudeHack ended up needing, imported here
   * deliberately rather than rediscovered.
   */
  passable(x, y, mover = null) {
    if (!this.inBounds(x, y)) return false;
    const t = this.at(x, y);
    if (isWalkable(t)) return true;
    if (t === T.DOOR_CLOSED) return !mover || !!mover.spec?.opensDoors;
    return false;
  }

  hazard() { return false; }   // no lava here; kept so engine/path.js can ask

  // The two rules engine/path.js asks the level about rather than importing.
  diagonalOk(fx, fy, tx, ty) { return tilesDiagonalOk(this, fx, fy, tx, ty); }
  isDoorway(x, y) { return blocksDiagonal(this.at(x, y)); }

  isVisible(x, y) { return this.inBounds(x, y) && !!this.visible[this.idx(x, y)]; }
  isSeen(x, y)    { return this.inBounds(x, y) && !!this.seen[this.idx(x, y)]; }
  clearVisible()  { this.visible.fill(0); }
  markSeen(x, y) {
    const i = this.idx(x, y);
    this.seen[i] = 1;
    this.visible[i] = 1;
  }

  // ------------------------------------------------------------- occupants

  markEnemiesDirty() { this._idx = null; }

  enemyAt(x, y) {
    if (!this.inBounds(x, y)) return null;
    if (!this._idx) {
      this._idx = new Map();
      for (const e of this.enemies) if (e.alive) this._idx.set(this.idx(e.x, e.y), e);
    }
    return this._idx.get(this.idx(x, y)) ?? null;
  }

  /** The neutral name engine/path.js asks by. */
  occupantAt(x, y) { return this.enemyAt(x, y); }

  moveEnemy(e, x, y) { e.x = x; e.y = y; this.markEnemiesDirty(); }

  addEnemy(e, x, y) {
    e.x = x; e.y = y;
    this.enemies.push(e);
    this.markEnemiesDirty();
    return e;
  }

  removeDead() {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!this.enemies[i].alive) this.enemies.splice(i, 1);
    }
    this.markEnemiesDirty();
  }

  livingEnemies() { return this.enemies.filter((e) => e.alive); }

  // ------------------------------------------------------------------ misc

  roomAt(x, y) {
    for (const r of this.rooms) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
    }
    return null;
  }

  bonfireAt(x, y) {
    return this.bonfires.find((b) => b.x === x && b.y === y) ?? null;
  }

  /** A free walkable square with nothing standing on it. */
  randomFreeSpot(rng, opts = {}) {
    const { roomsOnly = false, awayFrom = null, minDist = 0, avoidFeatures = true } = opts;
    const taken = new Set();
    for (const e of this.enemies) if (e.alive) taken.add(this.idx(e.x, e.y));

    const spots = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const t = this.tiles[i];
        if (!isWalkable(t)) continue;
        if (taken.has(i)) continue;
        if (avoidFeatures && (t === T.STAIRS_UP || t === T.STAIRS_DOWN || t === T.BONFIRE)) continue;
        if (roomsOnly && !this.roomAt(x, y)) continue;
        if (awayFrom && Math.max(Math.abs(x - awayFrom.x), Math.abs(y - awayFrom.y)) < minDist) continue;
        spots.push({ x, y });
      }
    }
    return spots.length ? rng.pick(spots) : null;
  }

  describeTile(x, y) { return TILE[this.at(x, y)].name; }
}

export { isDoor };
