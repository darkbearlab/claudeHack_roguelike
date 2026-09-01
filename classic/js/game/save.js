// Saving to localStorage.
//
// The awkward part of saving a roguelike is not the data, it is the *graph*.
// A shop points at a room, a shopkeeper and a list of stock; the shopkeeper
// points back at the shop; the hero's equipment slots point at objects that are
// also in the inventory array. JSON has no notion of identity, so every one of
// those has to become an index or an id on the way out and a lookup on the way
// back in. Everything below exists to do exactly that, in one place, so no
// other file has to think about it.
//
// Typed arrays are stored base64-encoded rather than as JSON number arrays:
// 1680 bytes becomes 2.2 KB of base64 instead of about 6 KB of digits and
// commas, and localStorage is a 5 MB budget shared with everything else.

import { RNG } from '../../../engine/rng.js';
import { Level } from '../map/level.js';
import { Player, Monster, resetMonUids } from './actors.js';
import { MONSTER_BY_KEY } from '../data/monsters.js';
import { resetObjIds } from './obj.js';

const KEY = 'claudehack.save.v1';
const SETTINGS_KEY = 'claudehack.settings.v1';

// --------------------------------------------------------------- encoding

function b64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function unb64(str, Ctor = Uint8Array) {
  const s = atob(str);
  const out = new Ctor(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ----------------------------------------------------------------- levels

function levelToJSON(lvl) {
  const monIndex = new Map();
  lvl.monsters.forEach((m, i) => monIndex.set(m, i));
  const roomIndex = new Map();
  lvl.rooms.forEach((r, i) => roomIndex.set(r, i));

  return {
    depth: lvl.depth, w: lvl.w, h: lvl.h,
    genKind: lvl.genKind, name: lvl.name, flags: lvl.flags,
    tiles: b64(lvl.tiles),
    lit:   b64(lvl.lit),
    seen:  b64(lvl.seen),
    noise: b64(lvl.noise),
    memObj: lvl.memObj.map((m) => (m ? [m.glyph, m.colour, m.sprite ?? ''] : 0)),
    rooms: lvl.rooms.map((r) => ({ ...r, theDoor: r.theDoor ?? null })),
    monsters: lvl.monsters.map(monToJSON),
    items: lvl.items.map(objToJSON),
    traps: [...lvl.traps.entries()],
    engravings: [...lvl.engravings.entries()],
    upStair: lvl.upStair, downStair: lvl.downStair, amuletSpot: lvl.amuletSpot ?? null,
    shops: lvl.shops.map((s) => ({
      roomIdx: roomIndex.get(s.room) ?? -1,
      kind: s.kind, door: s.door, abandoned: s.abandoned,
      postPos: s.postPos ?? null,
      shkIdx: monIndex.get(s.shk) ?? -1,
      itemOids: s.items.map((o) => o.oid),
    })),
  };
}

function levelFromJSON(d) {
  const lvl = new Level(d.depth, d.w, d.h);
  lvl.genKind = d.genKind;
  lvl.name = d.name;
  lvl.flags = d.flags ?? lvl.flags;
  lvl.tiles.set(unb64(d.tiles));
  lvl.lit.set(unb64(d.lit));
  lvl.seen.set(unb64(d.seen));
  lvl.noise.set(unb64(d.noise));
  lvl.memObj = d.memObj.map((m) => (m ? { glyph: m[0], colour: m[1], sprite: m[2] || null } : null));
  lvl.rooms = d.rooms;
  lvl.monsters = d.monsters.map(monFromJSON);
  lvl.items = d.items.map(objFromJSON);
  lvl.traps = new Map(d.traps);
  lvl.engravings = new Map(d.engravings);
  lvl.upStair = d.upStair; lvl.downStair = d.downStair;
  if (d.amuletSpot) lvl.amuletSpot = d.amuletSpot;

  const byOid = new Map(lvl.items.map((o) => [o.oid, o]));
  lvl.shops = (d.shops ?? []).map((s) => {
    const shop = {
      room: lvl.rooms[s.roomIdx], kind: s.kind, door: s.door,
      abandoned: s.abandoned, postPos: s.postPos,
      shk: lvl.monsters[s.shkIdx] ?? null,
      items: s.itemOids.map((id) => byOid.get(id)).filter(Boolean),
    };
    if (shop.shk) { shop.shk.shopkeeper = true; shop.shk.shop = shop; }
    return shop;
  });
  return lvl;
}

// --------------------------------------------------------------- monsters

function monToJSON(m) {
  return {
    uid: m.uid, specKey: m.specKey, x: m.x, y: m.y,
    hp: m.hp, hpMax: m.hpMax, energy: m.energy, alive: m.alive,
    peaceful: m.peaceful, tame: m.tame, asleep: m.asleep,
    fleeing: m.fleeing, seenHero: m.seenHero, lastKnown: m.lastKnown,
    statuses: [...m.statuses.entries()],
    inventory: m.inventory.map(objToJSON),
    weaponOid: m.weapon?.oid ?? null,
    customName: m.customName ?? null,
    invisible: !!m.invisible, cancelled: !!m.cancelled,
    wanderGoal: m.wanderGoal ?? null,
  };
}

function monFromJSON(d) {
  const stub = new RNG(1);
  const m = new Monster(d.specKey, stub);
  Object.assign(m, {
    uid: d.uid, x: d.x, y: d.y, hp: d.hp, hpMax: d.hpMax, energy: d.energy,
    alive: d.alive, peaceful: d.peaceful, tame: d.tame, asleep: d.asleep,
    fleeing: d.fleeing, seenHero: d.seenHero, lastKnown: d.lastKnown,
    customName: d.customName, invisible: d.invisible, cancelled: d.cancelled,
    wanderGoal: d.wanderGoal,
  });
  if (d.customName) m.name = d.customName;
  m.statuses = new Map(d.statuses);
  m.inventory = d.inventory.map(objFromJSON);
  m.weapon = m.inventory.find((o) => o.oid === d.weaponOid) ?? null;
  return m;
}

// ---------------------------------------------------------------- objects

function objToJSON(o) {
  const out = { ...o };
  delete out.contents;
  if (o.contents) out.contents = o.contents.map(objToJSON);
  return out;
}

function objFromJSON(d) {
  const o = { ...d };
  if (d.contents) o.contents = d.contents.map(objFromJSON);
  return o;
}

// ----------------------------------------------------------------- player

function playerToJSON(p) {
  const oidOf = (o) => (o ? o.oid : null);
  return {
    role: p.role, name: p.name, x: p.x, y: p.y, depth: p.depth, maxDepth: p.maxDepth,
    attr: p.attr, attrMax: p.attrMax, xpLevel: p.xpLevel, xp: p.xp,
    hp: p.hp, hpMax: p.hpMax, pw: p.pw, pwMax: p.pwMax, baseAC: p.baseAC,
    gold: p.gold, nutrition: p.nutrition, luck: p.luck, speed: p.speed, energy: p.energy,
    inventory: p.inventory.map(objToJSON),
    equip: Object.fromEntries(Object.entries(p.equip).map(([k, v]) => [k, oidOf(v)])),
    statuses: [...p.statuses.entries()],
    intrinsics: [...p.intrinsics],
    spells: p.spells, turns: p.turns, hasAmulet: p.hasAmulet,
    kills: [...p.kills.entries()],
    intrinsicProtection: p.intrinsicProtection ?? 0,
    altWeaponOid: oidOf(p.altWeapon),
    conductFoodless: p.conductFoodless, conductWeaponless: p.conductWeaponless,
  };
}

function playerFromJSON(d) {
  const p = new Player(d.role, d.name);
  Object.assign(p, {
    x: d.x, y: d.y, depth: d.depth, maxDepth: d.maxDepth,
    attr: d.attr, attrMax: d.attrMax, xpLevel: d.xpLevel, xp: d.xp,
    hp: d.hp, hpMax: d.hpMax, pw: d.pw, pwMax: d.pwMax, baseAC: d.baseAC,
    gold: d.gold, nutrition: d.nutrition, luck: d.luck, speed: d.speed, energy: d.energy,
    turns: d.turns, hasAmulet: d.hasAmulet,
    intrinsicProtection: d.intrinsicProtection,
    conductFoodless: d.conductFoodless, conductWeaponless: d.conductWeaponless,
  });
  p.inventory = d.inventory.map(objFromJSON);
  const byOid = new Map(p.inventory.map((o) => [o.oid, o]));
  p.equip = Object.fromEntries(Object.entries(d.equip).map(([k, v]) => [k, byOid.get(v) ?? null]));
  p.altWeapon = byOid.get(d.altWeaponOid) ?? null;
  p.statuses = new Map(d.statuses);
  p.intrinsics = new Set(d.intrinsics);
  p.spells = d.spells;
  p.kills = new Map(d.kills);
  return p;
}

// ======================================================================

export function saveGame(game) {
  try {
    const data = {
      version: 1,
      seed: game.seed,
      rng: game.rng.save(),
      turn: game.turn,
      startedAt: game.startedAt,
      elapsedBefore: (game.elapsedBefore ?? 0) + (Date.now() - game.startedAt),
      stats: game.stats,
      player: playerToJSON(game.player),
      levels: [...game.levels.entries()].map(([depth, lvl]) => [depth, levelToJSON(lvl)]),
      disc: {
        idMap: game.disc.idMap,
        known: [...game.disc.known],
        calledBy: [...game.disc.calledBy.entries()],
      },
      messages: game.messages.slice(-60),
      genocided: game.genocided ? [...game.genocided] : [],
      lastPrayer: game.lastPrayer ?? null,
      nextOid: maxOid(game) + 1,
      nextMonUid: maxMonUid(game) + 1,
    };
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('save failed', err);
    return false;
  }
}

function maxOid(game) {
  let max = 0;
  const scan = (arr) => { for (const o of arr) if (o.oid > max) max = o.oid; };
  scan(game.player.inventory);
  for (const lvl of game.levels.values()) {
    scan(lvl.items);
    for (const m of lvl.monsters) scan(m.inventory);
  }
  return max;
}

function maxMonUid(game) {
  let max = 0;
  for (const lvl of game.levels.values()) for (const m of lvl.monsters) if (m.uid > max) max = m.uid;
  return max;
}

export function hasSave() {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}

export function saveSummary() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return {
      name: d.player.name, role: d.player.role, depth: d.player.depth,
      xpLevel: d.player.xpLevel, turn: d.turn, seed: d.seed,
      hp: d.player.hp, hpMax: d.player.hpMax,
    };
  } catch { return null; }
}

export function loadGame(game) {
  const raw = localStorage.getItem(KEY);
  if (!raw) return false;
  const d = JSON.parse(raw);

  game.seed = d.seed;
  game.rng = RNG.load(d.rng);
  game.turn = d.turn;
  game.startedAt = Date.now();
  game.elapsedBefore = d.elapsedBefore ?? 0;
  game.stats = d.stats;
  game.player = playerFromJSON(d.player);
  game.levels = new Map(d.levels.map(([depth, ld]) => [depth, levelFromJSON(ld)]));
  game.level = game.levels.get(game.player.depth);
  game.disc = {
    idMap: d.disc.idMap,
    known: new Set(d.disc.known),
    calledBy: new Map(d.disc.calledBy),
    seenTypes: new Set(),
  };
  game.messages = d.messages ?? [];
  game.genocided = new Set(d.genocided ?? []);
  game.lastPrayer = d.lastPrayer;
  game.running = true;
  game.gameOver = null;
  game.detectedMonsters = null;
  game.detectUntil = 0;

  resetObjIds(d.nextOid ?? 100000);
  resetMonUids(d.nextMonUid ?? 100000);
  return true;
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

// --------------------------------------------------------------- settings

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch { return {}; }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
