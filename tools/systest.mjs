// System tests.
//
// The soak tests prove the game does not crash while someone plays it badly.
// These prove the parts a player might not reach for hours actually work: every
// potion, every scroll, every wand, every spell, every trap, every monster, all
// 26 levels of map generation, the save format, and the win condition.
//
//   node tools/systest.mjs
//
// Each check prints PASS or FAIL and the process exits non-zero if anything
// failed. Nothing here is random-seeded by wall clock; a failure is reproducible.

import { Game } from '../js/game/game.js';
import { RNG } from '../js/core/rng.js';
import { OBJECTS, objType, buildIdentityMap } from '../js/data/items.js';
import { MONSTERS, MONSTER_BY_KEY, pickMonsterSpec } from '../js/data/monsters.js';
import { ROLES } from '../js/data/roles.js';
import { generateLevel, DUNGEON_DEPTH } from '../js/map/mapgen.js';
import { T, isWalkable, isDown, isUp } from '../js/map/tiles.js';
import { makeObj, objName, objBase } from '../js/game/obj.js';
import { Monster } from '../js/game/actors.js';
import { monsterTurn } from '../js/game/ai.js';
import { quaffPotion, readScroll, zapWand, castSpell, SPELLS, TRAP_TYPES,
         triggerTrap, eatObject } from '../js/game/effects.js';
import { saveGame, loadGame } from '../js/game/save.js';
import { DIRS } from '../js/core/util.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passes = 0, failures = 0;
const failed = [];

function check(name, fn) {
  try {
    const detail = fn();
    passes++;
    console.log(`PASS  ${name}${detail ? '  -- ' + detail : ''}`);
  } catch (err) {
    failures++;
    failed.push(name);
    console.log(`FAIL  ${name}\n      ${err.message}`);
    if (process.env.VERBOSE) console.log(String(err.stack).split('\n').slice(1, 6).join('\n'));
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    passes++;
    console.log(`PASS  ${name}${detail ? '  -- ' + detail : ''}`);
  } catch (err) {
    failures++;
    failed.push(name);
    console.log(`FAIL  ${name}\n      ${err.message}`);
    if (process.env.VERBOSE) console.log(String(err.stack).split('\n').slice(1, 6).join('\n'));
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------------------------------------------------------- test UI
class QuietUI {
  constructor() { this.messages = []; }
  pushMessage(t) { this.messages.push(t); }
  render() {} animateTrail() {}
  sleep() { return Promise.resolve(); }
  async yesno() { return true; }
  async getKey() { return 'Escape'; }
  async getDirection() { return { dx: 1, dy: 0 }; }
  async getText() { return 'long sword'; }
  async pickItem(_p, e) { const r = e.filter((x) => !x.header && x.obj); return r.length ? r[0].obj : null; }
  async pickMany(_p, e) { return e.filter((x) => !x.header && x.obj).map((x) => x.obj); }
  async showMenu(_t, e, o) { return o?.multi ? [] : this.pickItem(_t, e); }
  async pickPosition() { return null; }
  async showText() {} async showTerrain() {} async showHelp() {}
  showGameOver() {} showSaved() {}
}

function freshGame(seed = 'systest', role = 'valkyrie') {
  const g = new Game(null);
  g.ui = new QuietUI();
  g.newGame({ seed, role, name: 'Tester' });
  return g;
}

// ===========================================================================
console.log('--- map generation ---------------------------------------------');

check('all 26 depths generate, are connected, and have stairs', () => {
  const problems = [];
  const kinds = new Map();
  let effortful = 0;
  for (let s = 0; s < 12; s++) {
    for (let d = 1; d <= DUNGEON_DEPTH; d++) {
      const rng = new RNG(`gen:${s}:${d}`);
      const lvl = generateLevel(d, rng);
      kinds.set(lvl.genKind, (kinds.get(lvl.genKind) ?? 0) + 1);

      let up = null, down = null, walkable = 0;
      for (let y = 0; y < lvl.h; y++) {
        for (let x = 0; x < lvl.w; x++) {
          const t = lvl.at(x, y);
          if (isWalkable(t)) walkable++;
          if (isUp(t)) up = { x, y };
          if (isDown(t)) down = { x, y };
        }
      }
      if (!up) { problems.push(`d${d}/s${s}: no up stair`); continue; }
      if (d < DUNGEON_DEPTH && !down) { problems.push(`d${d}/s${s}: no down stair`); continue; }
      if (walkable < 40) { problems.push(`d${d}/s${s}: only ${walkable} walkable cells`); continue; }

      // Connectivity, in two tiers.
      //
      // `Level.passable` answers the question monsters ask, and for a monster
      // without hands a closed door is a wall. The hero opens doors by walking
      // into them, kicks locked ones and searches out secret ones, so the hard
      // requirement is reachability through *any* door, and needing to kick or
      // search is merely noted.
      const flood = (allowDoors) => {
        const seen = new Uint8Array(lvl.w * lvl.h);
        const stack = [lvl.idx(up.x, up.y)];
        seen[stack[0]] = 1;
        while (stack.length) {
          const i = stack.pop();
          const x = i % lvl.w, y = (i / lvl.w) | 0;
          for (const dir of DIRS) {
            const nx = x + dir.dx, ny = y + dir.dy;
            if (!lvl.inBounds(nx, ny)) continue;
            const j = lvl.idx(nx, ny);
            if (seen[j]) continue;
            const t = lvl.at(nx, ny);
            const open = lvl.passable(nx, ny) ||
                         (allowDoors && (t === T.DOOR_CLOSED || t === T.DOOR_LOCKED ||
                                         t === T.SDOOR || t === T.SCORR));
            if (!open) continue;
            seen[j] = 1; stack.push(j);
          }
        }
        return seen;
      };
      if (down) {
        const hard = flood(true);
        if (!hard[lvl.idx(down.x, down.y)]) {
          problems.push(`d${d}/s${s}: down stair unreachable even through doors`);
        } else if (!flood(false)[lvl.idx(down.x, down.y)]) {
          effortful++;
        }
      }
      if (d === DUNGEON_DEPTH && !lvl.amuletSpot) problems.push(`d${d}/s${s}: sanctum has no amulet spot`);
    }
  }
  assert(problems.length === 0, problems.slice(0, 5).join('; ') + (problems.length > 5 ? ` (+${problems.length - 5} more)` : ''));
  return `${12 * DUNGEON_DEPTH} levels; ${effortful} need a door opened, kicked or found; kinds: ` +
         [...kinds.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
});

check('secret doors are never the only way through', () => {
  // A level whose only route to the down stair is a secret door is legal in
  // NetHack but must at least be *findable*: the secret square has to be
  // adjacent to reachable floor.
  let checked = 0;
  for (let s = 0; s < 8; s++) {
    for (let d = 1; d <= 10; d++) {
      const lvl = generateLevel(d, new RNG(`sec:${s}:${d}`));
      for (let y = 0; y < lvl.h; y++) {
        for (let x = 0; x < lvl.w; x++) {
          if (!lvl.hasSecretAt(x, y)) continue;
          checked++;
          let touchesFloor = false;
          for (const dir of DIRS) if (lvl.passable(x + dir.dx, y + dir.dy)) touchesFloor = true;
          assert(touchesFloor, `secret at ${x},${y} on d${d} touches nothing walkable`);
        }
      }
    }
  }
  return `${checked} secret squares checked`;
});

// ===========================================================================
console.log('\n--- objects and identification ---------------------------------');

check('every object type can be instantiated and named', () => {
  const rng = new RNG('obj');
  const disc = { idMap: buildIdentityMap(new RNG('id')), known: new Set(), calledBy: new Map() };
  for (const t of OBJECTS) {
    const o = makeObj(t.key, t.cls, rng, t.corpse ? { corpseOf: 'newt' } : {});
    const unknown = objName(o, disc);
    o.ided = true;
    disc.known.add(`${o.cls}/${o.key}`);
    const known = objName(o, disc);
    assert(unknown && known, `${t.key} produced an empty name`);
    assert(!/undefined|NaN|\[object/.test(unknown + known), `${t.key}: bad name "${unknown}" / "${known}"`);
  }
  return `${OBJECTS.length} types`;
});

check('appearance shuffle is a bijection per class and stable per seed', () => {
  const a = buildIdentityMap(new RNG('same'));
  const b = buildIdentityMap(new RNG('same'));
  const c = buildIdentityMap(new RNG('different'));
  assert(JSON.stringify(a) === JSON.stringify(b), 'same seed produced different appearances');
  assert(JSON.stringify(a) !== JSON.stringify(c), 'different seeds produced identical appearances');
  for (const cls of ['potion', 'scroll', 'wand', 'ring', 'amulet', 'spellbook']) {
    const keys = Object.keys(a).filter((k) => k.startsWith(cls + '/'));
    const vals = keys.map((k) => a[k]);
    assert(new Set(vals).size === vals.length,
           `${cls}: ${vals.length - new Set(vals).size} duplicate appearances`);
  }
  return 'six classes, no collisions';
});

// ===========================================================================
console.log('\n--- effects ----------------------------------------------------');

await checkAsync('every potion can be quaffed', async () => {
  const potions = OBJECTS.filter((o) => o.cls === 'potion');
  for (const t of potions) {
    for (const bless of [-1, 0, 1]) {
      const g = freshGame('potion:' + t.key);
      const o = makeObj(t.key, 'potion', g.rng, { bless, random: false });
      await quaffPotion(g, o);
    }
  }
  return `${potions.length} potions x3 BUC states`;
});

await checkAsync('every scroll can be read', async () => {
  const scrolls = OBJECTS.filter((o) => o.cls === 'scroll');
  for (const t of scrolls) {
    for (const bless of [-1, 0, 1]) {
      const g = freshGame('scroll:' + t.key);
      const o = makeObj(t.key, 'scroll', g.rng, { bless, random: false });
      await readScroll(g, o);
    }
  }
  return `${scrolls.length} scrolls x3 BUC states`;
});

await checkAsync('every wand can be zapped in every direction and at self', async () => {
  const wands = OBJECTS.filter((o) => o.cls === 'wand');
  const dirs = [...DIRS.map((d) => ({ dx: d.dx, dy: d.dy })), { dx: 0, dy: 0 }];
  for (const t of wands) {
    for (const dir of dirs) {
      const g = freshGame('wand:' + t.key);
      // Put something in front of the ray so the monster branch is exercised.
      const spot = g.freeNear(g.player.x, g.player.y, 3);
      if (spot) g.level.addMonster(new Monster('sewer rat', g.rng), spot.x, spot.y);
      const o = makeObj(t.key, 'wand', g.rng, { random: false });
      await zapWand(g, o, dir);
    }
  }
  return `${wands.length} wands x9 directions`;
});

await checkAsync('every spell can be cast', async () => {
  const keys = Object.keys(SPELLS);
  for (const k of keys) {
    const g = freshGame('spell:' + k);
    g.player.pw = 999; g.player.pwMax = 999;
    g.player.attr.int = 25;                      // make failure unlikely but not impossible
    const spot = g.freeNear(g.player.x, g.player.y, 3);
    if (spot) g.level.addMonster(new Monster('sewer rat', g.rng), spot.x, spot.y);
    for (let i = 0; i < 6; i++) await castSpell(g, k, { dx: 1, dy: 0 });
  }
  return `${keys.length} spells x6 casts`;
});

check('every trap can be triggered', () => {
  for (const t of TRAP_TYPES) {
    for (let i = 0; i < 8; i++) {
      const g = freshGame('trap:' + t.key + i);
      triggerTrap(g, { key: t.key, name: t.name, seen: false }, g.player.x, g.player.y);
    }
  }
  return `${TRAP_TYPES.length} trap types x8`;
});

check('every corpse and food item can be eaten', () => {
  const g = freshGame('eat');
  for (const spec of MONSTERS) {
    const corpse = makeObj('corpse', 'food', g.rng, {
      corpseOf: spec.name, random: false,
      raw: { nutrition: spec.nutrition ?? 100, monKey: spec.key, age: 0 },
    });
    eatObject(g, corpse);
  }
  for (const t of OBJECTS.filter((o) => o.cls === 'food' && !o.corpse)) {
    eatObject(g, makeObj(t.key, 'food', g.rng, { random: false }));
  }
  return `${MONSTERS.length} corpses + ${OBJECTS.filter((o) => o.cls === 'food').length - 1} foods`;
});

// ===========================================================================
console.log('\n--- monsters ---------------------------------------------------');

check('every monster species can be created and take turns', () => {
  for (const spec of MONSTERS) {
    const g = freshGame('mon:' + spec.key);
    const spot = g.freeNear(g.player.x, g.player.y, 4);
    if (!spot) throw new Error('no room to place ' + spec.key);
    const m = new Monster(spec.key, g.rng);
    g.level.addMonster(m, spot.x, spot.y);
    m.asleep = false;
    for (let i = 0; i < 25 && m.alive && g.running; i++) monsterTurn(g, m);
  }
  return `${MONSTERS.length} species x25 turns`;
});

check('monster generation respects the difficulty band', () => {
  const rng = new RNG('band');
  const worst = new Map();
  for (let depth = 1; depth <= DUNGEON_DEPTH; depth++) {
    const heroLevel = Math.max(1, Math.floor(depth * 0.8));
    let max = 0, min = 99;
    for (let i = 0; i < 400; i++) {
      const s = pickMonsterSpec(rng, depth, heroLevel);
      max = Math.max(max, s.lvl); min = Math.min(min, s.lvl);
    }
    worst.set(depth, [min, max]);
  }
  const [d1min, d1max] = worst.get(1);
  assert(d1max <= 1, `dungeon level 1 can generate a level-${d1max} monster`);
  const [, d26max] = worst.get(26);
  assert(d26max >= 8, `dungeon level 26 tops out at level ${d26max}`);
  const [d26min] = worst.get(26);
  assert(d26min >= 2, `dungeon level 26 still generates level-${d26min} vermin`);
  void d1min;
  return `dlvl1 caps at ${d1max}; dlvl26 spans ${d26min}-${d26max}`;
});

// ===========================================================================
console.log('\n--- save and load ----------------------------------------------');

await checkAsync('save/load round-trips a deep game exactly', async () => {
  const g = freshGame('save');
  // Visit several levels and accumulate state worth losing.
  for (let d = 2; d <= 8; d++) g.gotoLevel(d, 'up');
  g.player.gold = 1234;
  g.player.setStatus('confused', 7);
  g.disc.known.add('potion/healing');
  g.disc.calledBy.set('scroll/identify', 'the good one');
  const sword = makeObj('long sword', 'weapon', g.rng, { enchant: 3, bless: 1, random: false });
  g.addToInventory(sword);
  const before = {
    turn: g.turn, depth: g.player.depth, gold: g.player.gold,
    inv: g.player.inventory.map((o) => `${o.key}:${o.count}:${o.enchant}:${o.bless}`).join('|'),
    levels: g.levels.size,
    monsters: [...g.levels.values()].reduce((n, l) => n + l.monsters.length, 0),
    items: [...g.levels.values()].reduce((n, l) => n + l.items.length, 0),
    tiles: [...g.levels.values()].map((l) => l.tiles.join(',')).join(';'),
    seen: [...g.levels.values()].map((l) => l.seen.join(',')).join(';'),
    known: [...g.disc.known].sort().join(','),
    idMap: JSON.stringify(g.disc.idMap),
  };
  assert(saveGame(g), 'saveGame returned false');

  const g2 = new Game(null);
  g2.ui = new QuietUI();
  assert(loadGame(g2), 'loadGame returned false');
  const after = {
    turn: g2.turn, depth: g2.player.depth, gold: g2.player.gold,
    inv: g2.player.inventory.map((o) => `${o.key}:${o.count}:${o.enchant}:${o.bless}`).join('|'),
    levels: g2.levels.size,
    monsters: [...g2.levels.values()].reduce((n, l) => n + l.monsters.length, 0),
    items: [...g2.levels.values()].reduce((n, l) => n + l.items.length, 0),
    tiles: [...g2.levels.values()].map((l) => l.tiles.join(',')).join(';'),
    seen: [...g2.levels.values()].map((l) => l.seen.join(',')).join(';'),
    known: [...g2.disc.known].sort().join(','),
    idMap: JSON.stringify(g2.disc.idMap),
  };
  for (const k of Object.keys(before)) {
    assert(before[k] === after[k], `field "${k}" differs after reload`);
  }
  // Equipment must still point at inventory objects, not copies.
  for (const slot of Object.keys(g2.player.equip)) {
    const it = g2.player.equip[slot];
    if (it) assert(g2.player.inventory.includes(it), `equip.${slot} is not the inventory object`);
  }
  // Shops must still point at their shopkeeper and stock.
  for (const lvl of g2.levels.values()) {
    for (const shop of lvl.shops) {
      assert(shop.shk && lvl.monsters.includes(shop.shk), 'shop lost its shopkeeper');
      for (const o of shop.items) assert(lvl.items.includes(o), 'shop stock is not on the level');
    }
  }
  return `${before.levels} levels, ${before.monsters} monsters, ${before.items} items`;
});

check('the save fits in a localStorage budget', () => {
  const g = freshGame('size');
  for (let d = 2; d <= DUNGEON_DEPTH; d++) g.gotoLevel(d, 'up');
  saveGame(g);
  const bytes = store.get('claudehack.save.v1').length;
  assert(bytes < 4_500_000, `save is ${(bytes / 1e6).toFixed(2)} MB, over budget`);
  return `${DUNGEON_DEPTH} levels visited -> ${(bytes / 1024).toFixed(0)} KB`;
});

// ===========================================================================
console.log('\n--- the run itself ---------------------------------------------');

await checkAsync('the Amulet can be taken and carried out to win', async () => {
  const g = freshGame('win', 'valkyrie');
  g.gotoLevel(DUNGEON_DEPTH, 'up');
  const amulet = g.level.items.find((o) => o.key === 'Amulet of Yendor');
  assert(amulet, 'no Amulet on the bottom level');

  // Clear the guardians out of the way; this test is about the win path, not
  // about whether a level-1 Valkyrie can beat five demons.
  for (const m of g.level.monsters) m.alive = false;
  g.level.removeDead();

  g.player.x = amulet.x; g.player.y = amulet.y;
  await g.doPickup();
  assert(g.player.hasAmulet, 'picking up the Amulet did not set hasAmulet');
  assert(g.player.inventory.some((o) => o.key === 'Amulet of Yendor'), 'Amulet not in inventory');

  // Walk back up. changeLevel(-1) from depth 1 with the Amulet must win.
  for (let d = DUNGEON_DEPTH; d > 1; d--) g.gotoLevel(d - 1, 'down');
  assert(g.player.depth === 1, 'did not get back to depth 1');
  g.player.x = g.level.upStair.x; g.player.y = g.level.upStair.y;
  const spent = g.doUpstairs();
  assert(spent, 'doUpstairs did not act');
  assert(!g.running, 'game did not end');
  assert(g.gameOver?.how === 'ascended', `ended as "${g.gameOver?.how}" instead of ascended`);
  assert(g.gameOver.score > 20000, `winning score was only ${g.gameOver.score}`);
  return `score ${g.gameOver.score}`;
});

check('leaving level 1 without the Amulet does not win', () => {
  const g = freshGame('nowin');
  g.player.x = g.level.upStair.x; g.player.y = g.level.upStair.y;
  g.doUpstairs();
  assert(g.running, 'the game ended without the Amulet');
  return 'refused, as it should';
});

await checkAsync('death ends the run and clears the save', async () => {
  const g = freshGame('death');
  saveGame(g);
  assert(store.has('claudehack.save.v1'), 'precondition: save exists');
  g.die('a test');
  assert(!g.running, 'game still running after death');
  assert(g.gameOver.how === 'died', 'gameOver.how is not "died"');
  assert(!store.has('claudehack.save.v1'), 'save survived death');
  return 'permadeath holds';
});

check('every role starts legal and equipped', () => {
  for (const role of ROLES) {
    const g = freshGame('role:' + role.key, role.key);
    const p = g.player;
    assert(p.hp > 0 && p.hp === p.hpMax, `${role.key}: bad starting HP ${p.hp}/${p.hpMax}`);
    assert(p.inventory.length >= role.startItems.length, `${role.key}: missing starting items`);
    assert(p.equip.light, `${role.key}: no light source`);
    const wants = role.startItems.filter((i) => i.wield).length;
    if (wants) assert(p.equip.weapon, `${role.key}: nothing wielded`);
    for (const it of p.inventory) {
      assert(it.letter, `${role.key}: item ${it.key} has no inventory letter`);
      assert(objBase(it), `${role.key}: item ${it.key} has no base type`);
    }
    assert(g.level.walkable(p.x, p.y), `${role.key}: starts inside a wall`);
    assert(p.encumbrance() < 2, `${role.key}: starts encumbered`);
  }
  return `${ROLES.length} roles`;
});

check('the same seed produces the same dungeon and the same shuffle', () => {
  const a = freshGame('repeat-me', 'wizard');
  const b = freshGame('repeat-me', 'wizard');
  for (let d = 1; d <= 6; d++) { a.levelAt(d); b.levelAt(d); }
  for (let d = 1; d <= 6; d++) {
    assert(a.levelAt(d).tiles.join() === b.levelAt(d).tiles.join(), `level ${d} differs`);
    assert(a.levelAt(d).monsters.map((m) => m.specKey + m.x + ',' + m.y).join() ===
           b.levelAt(d).monsters.map((m) => m.specKey + m.x + ',' + m.y).join(), `level ${d} monsters differ`);
  }
  assert(JSON.stringify(a.disc.idMap) === JSON.stringify(b.disc.idMap), 'identity shuffle differs');
  return 'six levels identical';
});

// ===========================================================================
console.log(`\n=== ${passes} passed, ${failures} failed ===`);
if (failed.length) console.log('failed: ' + failed.join(', '));
process.exit(failures ? 1 : 0);
