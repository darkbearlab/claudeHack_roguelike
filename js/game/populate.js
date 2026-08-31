// Filling a freshly generated level with things that want to kill you.
//
// Kept separate from mapgen because the two answer different questions.
// mapgen decides what the *place* is; this decides what is *in* it. Special
// rooms sit on the boundary and live here, because a shop is a shopkeeper and
// stock far more than it is a rectangle.

import { T, isWalkable } from '../map/tiles.js';
import { Monster } from './actors.js';
import { pickMonsterSpec, MONSTER_BY_KEY } from '../data/monsters.js';
import { makeObj, makeGold, randomObj, shopPriceOf, objBase } from './obj.js';
import { randomTrapType } from './effects.js';
import { OBJECTS } from '../data/items.js';
import { setRoomLit } from '../map/mapgen.js';
import { DUNGEON_DEPTH } from '../map/mapgen.js';

export function populateLevel(game, lvl) {
  const rng = game.rng;
  const depth = lvl.depth;

  if (lvl.flags.sanctum) { populateSanctum(game, lvl); return; }

  specialRooms(game, lvl);

  // Monsters. NetHack's rule of thumb is a handful at creation and a slow
  // trickle thereafter; the trickle is in Game.upkeep.
  const nMon = rng.int(3, 6) + Math.floor(depth / 4);
  for (let i = 0; i < nMon; i++) {
    const spot = lvl.randomFreeSpot(rng, { avoidStairs: true });
    if (!spot) break;
    if (lvl.roomAt(spot.x, spot.y)?.type === 'shop') continue;
    spawnAt(game, lvl, spot.x, spot.y, { asleep: rng.rn2(100) < 55 });
  }

  // Objects.
  const nObj = rng.int(3, 7) + Math.floor(depth / 6);
  for (let i = 0; i < nObj; i++) {
    const spot = lvl.randomFreeSpot(rng, { roomsOnly: lvl.rooms.length > 0 });
    if (!spot) break;
    if (lvl.roomAt(spot.x, spot.y)?.type === 'shop') continue;
    lvl.addItem(randomObj(rng, depth), spot.x, spot.y);
  }

  // Loose gold.
  for (let i = 0, n = rng.int(1, 3); i < n; i++) {
    const spot = lvl.randomFreeSpot(rng, { roomsOnly: lvl.rooms.length > 0 });
    if (!spot) break;
    if (lvl.roomAt(spot.x, spot.y)?.type === 'shop') continue;
    lvl.addItem(makeGold(rng.int(5, 30 + depth * 15)), spot.x, spot.y);
  }

  // Traps.
  const nTrap = rng.int(1, 2) + Math.floor(depth / 3);
  for (let i = 0; i < nTrap; i++) {
    const spot = lvl.randomFreeSpot(rng, { avoidStairs: true });
    if (!spot) continue;
    if (lvl.trapAt(spot.x, spot.y)) continue;
    if (lvl.roomAt(spot.x, spot.y)?.type === 'shop') continue;
    const type = randomTrapType(rng, depth);
    lvl.addTrap(spot.x, spot.y, { key: type.key, name: type.name, seen: false });
  }

  // Buried treasure in a dead-end corridor, occasionally.
  if (rng.oneIn(4)) {
    const spot = lvl.randomFreeSpot(rng, { avoidStairs: true });
    if (spot && lvl.at(spot.x, spot.y) === T.CORRIDOR) {
      lvl.addItem(makeGold(rng.int(50, 60 + depth * 30)), spot.x, spot.y);
    }
  }
}

export function spawnAt(game, lvl, x, y, opts = {}) {
  const rng = game.rng;
  const spec = opts.spec ?? pickMonsterSpec(rng, lvl.depth, game.player?.xpLevel ?? 1);
  const mon = new Monster(spec.key, rng, opts);
  lvl.addMonster(mon, x, y);
  giveMonsterGear(game, mon);

  // Some species arrive in numbers.
  if (spec.group && !opts.noGroup) {
    const [lo, hi] = spec.group;
    const n = rng.int(lo, hi) - 1;
    for (let i = 0; i < n; i++) {
      const spot = nearbyFree(lvl, x, y, 3, rng);
      if (!spot) break;
      const friend = new Monster(spec.key, rng, { ...opts, noGroup: true });
      lvl.addMonster(friend, spot.x, spot.y);
      giveMonsterGear(game, friend);
    }
  }
  return mon;
}

function giveMonsterGear(game, mon) {
  const rng = game.rng;
  if (!mon.spec.atk.some((a) => a.type === 'weapon')) return;
  if (!rng.oneIn(2)) return;
  const pool = OBJECTS.filter((o) => o.cls === 'weapon' && o.freq > 0 && !o.ammo && !o.launcher);
  const pick = rng.pickWeighted(pool, (o) => o.freq);
  const w = makeObj(pick.key, 'weapon', rng, { count: 1 });
  mon.inventory.push(w);
  mon.weapon = w;
}

function nearbyFree(lvl, x, y, radius, rng) {
  const cands = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!lvl.inBounds(nx, ny)) continue;
      if (!isWalkable(lvl.at(nx, ny))) continue;
      if (lvl.monsterAt(nx, ny)) continue;
      cands.push({ x: nx, y: ny });
    }
  }
  return cands.length ? rng.pick(cands) : null;
}

// ===========================================================================
// special rooms
// ===========================================================================

function specialRooms(game, lvl) {
  const rng = game.rng;
  const depth = lvl.depth;
  const candidates = lvl.rooms.filter((r) =>
    r.type === 'ordinary' && r.w >= 3 && r.h >= 2 && !containsStairs(lvl, r));
  if (!candidates.length) return;

  const roll = rng.rn2(100);
  const room = rng.pick(candidates);

  if (depth >= 2 && roll < 12 && countDoors(lvl, room) === 1) makeShop(game, lvl, room);
  else if (depth >= 4 && roll < 20) makeZoo(game, lvl, room);
  else if (depth >= 5 && roll < 26) makeGraveyard(game, lvl, room);
  else if (depth >= 6 && roll < 32) makeBarracks(game, lvl, room);
  else if (depth >= 8 && roll < 36) makeTreasureRoom(game, lvl, room);
}

function containsStairs(lvl, r) {
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const t = lvl.at(x, y);
      if (t === T.STAIRS_UP || t === T.STAIRS_DOWN) return true;
    }
  return false;
}

function countDoors(lvl, r) {
  let n = 0, door = null;
  for (let y = r.y - 1; y <= r.y + r.h; y++) {
    for (let x = r.x - 1; x <= r.x + r.w; x++) {
      const onEdge = x === r.x - 1 || x === r.x + r.w || y === r.y - 1 || y === r.y + r.h;
      if (!onEdge) continue;
      const t = lvl.at(x, y);
      if (t >= T.DOOR_CLOSED && t <= T.SDOOR) { n++; door = { x, y }; }
    }
  }
  r.theDoor = door;
  return n;
}

const SHOP_KINDS = [
  { name: 'general store',   classes: null },
  { name: 'used armor dealership', classes: ['armor'] },
  { name: 'second-hand book store', classes: ['scroll', 'spellbook'] },
  { name: 'liquor emporium', classes: ['potion'] },
  { name: 'antique weapons outlet', classes: ['weapon'] },
  { name: 'delicatessen',    classes: ['food'] },
  { name: 'jewelers',        classes: ['ring', 'amulet', 'gem'] },
  { name: 'quality apparel and accessories', classes: ['tool'] },
];

function makeShop(game, lvl, room) {
  const rng = game.rng;
  countDoors(lvl, room);
  if (!room.theDoor) return;

  room.type = 'shop';
  room.lit = true;
  setRoomLit(lvl, room, true);

  const kind = rng.pick(SHOP_KINDS);
  const shop = { room, kind: kind.name, door: room.theDoor, abandoned: false, items: [] };
  lvl.shops.push(shop);

  // The shopkeeper stands next to the door, inside.
  const inside = insideOfDoor(lvl, room, room.theDoor);
  shop.postPos = inside;

  const shk = new Monster('shopkeeper', rng, { peaceful: true });
  shk.shopkeeper = true;
  shk.shop = shop;
  shk.customName = rng.pick(SHK_NAMES);
  shk.name = shk.customName;
  lvl.addMonster(shk, inside.x, inside.y);
  shop.shk = shk;

  // Stock. Everything but the doorway square.
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (inside && x === inside.x && y === inside.y) continue;
      if (lvl.at(x, y) !== T.FLOOR) continue;
      if (rng.rn2(100) < 22) continue;
      let o;
      if (kind.classes) {
        const cls = rng.pick(kind.classes);
        const pool = OBJECTS.filter((t) => t.cls === cls && t.freq > 0 && !t.unique);
        const pick = rng.pickWeighted(pool, (t) => t.freq);
        o = makeObj(pick.key, cls, rng);
      } else {
        o = randomObj(rng, lvl.depth);
        if (o.cls === 'coin') o = makeObj('food ration', 'food', rng);
      }
      o.shopOwned = true;
      lvl.addItem(o, x, y);
      shop.items.push(o);
    }
  }
}

const SHK_NAMES = ['Asidonhopo', 'Kalabhaskar', 'Ruxes', 'Sabbat', 'Ymirgard',
                   'Ihsan', 'Djemi', 'Kelmoron', 'Vasilis', 'Ozgur'];

function insideOfDoor(lvl, room, door) {
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const x = door.x + dx, y = door.y + dy;
    if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) return { x, y };
  }
  return { x: room.x, y: room.y };
}

function makeZoo(game, lvl, room) {
  const rng = game.rng;
  room.type = 'zoo';
  room.lit = true;
  setRoomLit(lvl, room, true);
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (lvl.at(x, y) !== T.FLOOR) continue;
      if (lvl.monsterAt(x, y)) continue;
      spawnAt(game, lvl, x, y, { asleep: true, noGroup: true });
      lvl.addItem(makeGold(rng.int(10, 40 + lvl.depth * 20)), x, y);
    }
  }
  room.zoo = true;
}

function makeGraveyard(game, lvl, room) {
  const rng = game.rng;
  room.type = 'graveyard';
  room.lit = false;
  setRoomLit(lvl, room, false);
  const undead = ['zombie', 'gnome zombie', 'skeleton', 'mummy', 'wraith', 'barrow wight'];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (lvl.at(x, y) !== T.FLOOR) continue;
      if (rng.oneIn(3)) lvl.set(x, y, T.GRAVE);
      if (rng.oneIn(3) && !lvl.monsterAt(x, y)) {
        const key = rng.pick(undead.filter((k) => MONSTER_BY_KEY[k].lvl <= lvl.depth + 4));
        if (key) spawnAt(game, lvl, x, y, { spec: MONSTER_BY_KEY[key], asleep: true, noGroup: true });
      }
      if (rng.oneIn(6)) lvl.addItem(randomObj(rng, lvl.depth), x, y);
    }
  }
}

function makeBarracks(game, lvl, room) {
  const rng = game.rng;
  room.type = 'barracks';
  room.lit = true;
  setRoomLit(lvl, room, true);
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (lvl.at(x, y) !== T.FLOOR || lvl.monsterAt(x, y)) continue;
      if (rng.rn2(100) < 55) {
        spawnAt(game, lvl, x, y, { spec: MONSTER_BY_KEY['soldier'], asleep: true, noGroup: true });
      }
    }
  }
}

function makeTreasureRoom(game, lvl, room) {
  const rng = game.rng;
  room.type = 'treasure';
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (lvl.at(x, y) !== T.FLOOR) continue;
      if (rng.oneIn(2)) lvl.addItem(makeGold(rng.int(30, 80 + lvl.depth * 25)), x, y);
      if (rng.oneIn(4)) lvl.addItem(randomObj(rng, lvl.depth + 4), x, y);
    }
  }
  // Guarded, obviously.
  for (let i = 0; i < 3; i++) {
    const spot = nearbyFree(lvl, room.x + (room.w >> 1), room.y + (room.h >> 1), 3, rng);
    if (spot) spawnAt(game, lvl, spot.x, spot.y, { asleep: true, noGroup: true });
  }
}

// ===========================================================================
// the bottom of the dungeon
// ===========================================================================

function populateSanctum(game, lvl) {
  const rng = game.rng;
  const spot = lvl.amuletSpot;

  const amulet = makeObj('Amulet of Yendor', 'amulet', rng, { random: false, ided: true });
  lvl.addItem(amulet, spot.x, spot.y);

  // Four guardians inside the vault, and the Wizard himself.
  const vault = lvl.rooms.find((r) => r.type === 'vault');
  const placed = [];
  for (let y = vault.y; y < vault.y + vault.h; y++) {
    for (let x = vault.x; x < vault.x + vault.w; x++) {
      if (x === spot.x && y === spot.y) continue;
      if (lvl.at(x, y) !== T.FLOOR) continue;
      placed.push({ x, y });
    }
  }
  rng.shuffle(placed);
  for (let i = 0; i < Math.min(4, placed.length); i++) {
    spawnAt(game, lvl, placed[i].x, placed[i].y,
            { spec: MONSTER_BY_KEY['amulet guard'], noGroup: true });
  }
  if (placed.length > 4) {
    spawnAt(game, lvl, placed[4].x, placed[4].y,
            { spec: MONSTER_BY_KEY['wizard'], noGroup: true });
  }

  // The outer hall: a gauntlet.
  const outer = lvl.rooms.find((r) => r.type === 'sanctum');
  for (let i = 0; i < 10; i++) {
    const s = lvl.randomFreeSpot(rng, { avoidStairs: true });
    if (!s) break;
    if (s.x >= vault.x - 1 && s.x <= vault.x + vault.w &&
        s.y >= vault.y - 1 && s.y <= vault.y + vault.h) continue;
    spawnAt(game, lvl, s.x, s.y, { asleep: rng.oneIn(3), noGroup: true });
  }
  for (let i = 0; i < 6; i++) {
    const s = lvl.randomFreeSpot(rng, { avoidStairs: true });
    if (s) lvl.addItem(randomObj(rng, DUNGEON_DEPTH), s.x, s.y);
  }
  void outer;
}
