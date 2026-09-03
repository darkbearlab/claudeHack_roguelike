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
  /**
   * Can something move diagonally from one tile to another?
   *
   * Terrain always blocks it - you cannot cut a corner through a wall or squeeze
   * past a doorframe. Bodies block it too, but **only for the player**, and that
   * asymmetry is deliberate rather than sloppy.
   *
   * The rule exists so that a pincer costs something: two enemies beside each
   * other are a wall as far as walking is concerned, so slipping diagonally out
   * from between them is no longer free, and the way through is a roll, which
   * costs stamina. The player is the only actor with a stamina-priced way
   * through. Applying it to enemies as well simply paralysed them - packs are
   * placed in tight clusters on purpose, so their own packmates blocked every
   * diagonal, and measured over forty turns of hunting not one of fifty-one
   * enemies reached the player. That is not a tactic, it is a jam.
   *
   * So `bodies` is opt-in: the player's walk passes it, the player's roll does
   * not (it tumbles past them, though never through a doorframe), and enemy
   * movement and pathfinding never see it.
   */
  diagonalOk(fx, fy, tx, ty, bodies = false) {
    if (!tilesDiagonalOk(this, fx, fy, tx, ty)) return false;
    if (!bodies) return true;
    const dx = tx - fx, dy = ty - fy;
    if (!dx || !dy) return true;                     // orthogonal: bodies do not corner you
    return !this.enemyAt(fx + dx, fy) && !this.enemyAt(fx, fy + dy);
  }

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
  /**
   * Ground a bonfire makes safe to spawn on.
   *
   * `avoidFeatures` already kept enemies off the fire's own tile, which stopped
   * nothing: you wake at the fire and a pack is standing round it, and because
   * resting is refused while anything is hunting you, the bonfire you just
   * respawned at is unusable. The walk back from a death turns into a fight you
   * did not choose, at the exact moment the game had promised you a breath.
   *
   * The room, then, not the tile. The store-room chooser in mapgen has always
   * done exactly this - "never the one with the fire in it" - and this is the
   * same rule finally applied to the things that can kill you.
   *
   * A bonfire in a corridor has no room to protect, so it gets a radius wide
   * enough to cover a pack's two-tile spread instead.
   */
  isSanctuary(x, y) {
    for (const b of this.bonfires) {
      const room = this.roomAt(b.x, b.y);
      if (room) {
        if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) return true;
      } else if (Math.max(Math.abs(x - b.x), Math.abs(y - b.y)) <= 3) {
        return true;
      }
    }
    return false;
  }

  randomFreeSpot(rng, opts = {}) {
    const { roomsOnly = false, awayFrom = null, minDist = 0, avoidFeatures = true,
            avoidBonfires = false } = opts;
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
        if (avoidBonfires && this.isSanctuary(x, y)) continue;
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
