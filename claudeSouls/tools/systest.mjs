// System tests.
//
// A deterministic combat system is far more testable than claudeHack's was:
// with no to-hit rolls and no damage dice, "the sentinel's lance lands on turn
// N and covers these three tiles" is an *assertion*, not a distribution. Most
// of what follows checks the read-and-react contract directly, because that
// contract is the game - if it can be broken, everything else is decoration.
//
//   node tools/systest.mjs

import { Game, DUNGEON_DEPTH } from '../js/game/game.js';
import { RNG } from '../../engine/rng.js';
import { generateLevel, MAX_STRAIT } from '../js/map/mapgen.js';
import { T, isWalkable, isChest, isCorpse } from '../js/map/tiles.js';
import { Enemy, STATE } from '../js/game/actors.js';
import { ENEMIES, ENEMY_BY_KEY } from '../js/data/enemies.js';
import { SKILLS, SKILL_BY_KEY, PLAYER } from '../js/data/skills.js';
import { ITEMS, ITEM_BY_KEY, SLOT, skillsFrom, STARTING_KIT,
         CONSUMABLES, CONSUMABLE_BY_KEY } from '../js/data/items.js';
import { TRACKS, soulsFor, priceOf } from '../js/data/souls.js';
import { AFFIXES, AFFIX_BY_KEY, canGrant, TEMP_HITS } from '../js/data/affixes.js';
import { attackTiles, snapDir, PATTERNS, spriteRotation, blocksDirection } from '../js/game/patterns.js';
import { ART_FACING } from '../js/data/sprites.js';
import { saveGame, loadGame } from '../js/game/save.js';
import { stepProjectiles } from '../js/game/projectile.js';
import { DIRS } from '../../engine/util.js';
import { readFileSync, existsSync } from 'node:fs';
import { TEXTURES, TEXTURE_KEYS } from '../js/data/textures.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let pass = 0, fail = 0;
const failed = [];
function check(name, fn) {
  try {
    const d = fn();
    pass++; console.log(`PASS  ${name}${d ? '  -- ' + d : ''}`);
  } catch (e) {
    fail++; failed.push(name);
    console.log(`FAIL  ${name}\n      ${e.message}`);
    if (process.env.VERBOSE) console.log(String(e.stack).split('\n').slice(1, 6).join('\n'));
  }
}
function assert(c, m) { if (!c) throw new Error(m); }

class QuietUI {
  pushMessage() {} render() {} animateTrail() {} onDeath() {}
  sleep() { return Promise.resolve(); }
  async showText() {} async showHelp() {}
  showGameOver() {} showSaved() {}
}

function freshGame(seed = 't', vow = 'light') {
  const g = new Game(null);
  g.ui = new QuietUI();
  g.newGame({ seed, name: 'Test', vow });
  return g;
}

/** Player and one enemy on clear floor, with nothing else in the way. */
function arena(seed, enemyKey, gap = 1) {
  const g = freshGame(seed);
  g.level.enemies.length = 0;
  g.level.projectiles.length = 0;
  g.level.markEnemiesDirty();
  const room = [...g.level.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const py = room.y + (room.h >> 1);
  g.player.x = room.x; g.player.y = py;
  const e = new Enemy(enemyKey, g.rng);
  g.level.addEnemy(e, room.x + gap, py);
  e.aware = true;
  g.afterMove();
  return { g, e, room };
}

/** Run the world with the player pinned alive, so an enemy can be observed. */
function observe(g, e, turns, stop) {
  for (let t = 0; t < turns && e.alive && g.running; t++) {
    g.player.hp = g.player.hpMax;
    g.worldTurn();
    if (stop && stop(t)) return t;
  }
  return -1;
}

// ===========================================================================
console.log('--- map -------------------------------------------------------');

check('every floor generates, is connected, and has stairs and a bonfire', () => {
  const problems = [];
  for (let s = 0; s < 12; s++) {
    for (let d = 1; d <= DUNGEON_DEPTH; d++) {
      const lvl = generateLevel(d, new RNG(`g:${s}:${d}`));
      if (!lvl.upStair) { problems.push(`d${d}/s${s}: no up stair`); continue; }
      if (d < DUNGEON_DEPTH && !lvl.downStair) { problems.push(`d${d}/s${s}: no down stair`); continue; }
      if (!lvl.bonfires.length) { problems.push(`d${d}/s${s}: no bonfire`); continue; }

      const seen = new Uint8Array(lvl.w * lvl.h);
      const stack = [lvl.idx(lvl.upStair.x, lvl.upStair.y)];
      seen[stack[0]] = 1;
      while (stack.length) {
        const i = stack.pop();
        const x = i % lvl.w, y = (i / lvl.w) | 0;
        for (const dir of DIRS) {
          const nx = x + dir.dx, ny = y + dir.dy;
          if (!lvl.inBounds(nx, ny)) continue;
          const j = lvl.idx(nx, ny);
          if (seen[j] || !lvl.passable(nx, ny)) continue;
          seen[j] = 1; stack.push(j);
        }
      }
      if (lvl.downStair && !seen[lvl.idx(lvl.downStair.x, lvl.downStair.y)]) {
        problems.push(`d${d}/s${s}: down stair unreachable`);
      }
      for (const b of lvl.bonfires) {
        if (!seen[lvl.idx(b.x, b.y)]) problems.push(`d${d}/s${s}: bonfire unreachable`);
      }
    }
  }
  assert(!problems.length, problems.slice(0, 4).join('; '));
  return `${12 * DUNGEON_DEPTH} floors`;
});

check('no corridor runs long enough to switch the game off', () => {
  // A one-tile-wide corridor does not merely make this game lethal, it turns
  // most of it off: arc3 and arc5 collapse to one effective tile, the only
  // movement left is forward and back - which is exactly what line3 and line6
  // punish - and block stops being the "nowhere to go" option and becomes
  // mandatory. Half the weapon pool degrades to `front`.
  //
  // Narrow places are not the problem and are deliberately kept: a corridor is
  // a real answer to a pack of hounds. LONG narrow places are the problem.
  const walk = (l, x, y) => {
    if (!l.inBounds(x, y)) return false;
    const t = l.at(x, y);
    return t === T.FLOOR || t === T.CORRIDOR || t === T.DOOR_OPEN || t === T.DOOR_BROKEN;
  };
  const strait = (l, x, y) => {
    if (!walk(l, x, y)) return null;
    const n = walk(l, x, y - 1), s = walk(l, x, y + 1);
    const e = walk(l, x + 1, y), w = walk(l, x - 1, y);
    if (n && s && !e && !w) return 'v';
    if (e && w && !n && !s) return 'h';
    return null;
  };

  let worst = 0, where = '', total = 0, straitTiles = 0;
  for (let s = 0; s < 8; s++) {
    for (let d = 1; d <= DUNGEON_DEPTH; d++) {
      const lvl = generateLevel(d, new RNG(`corr:${s}:${d}`));
      for (let y = 1; y < lvl.h - 1; y++) {
        for (let x = 1; x < lvl.w - 1; x++) {
          if (walk(lvl, x, y)) { total++; if (strait(lvl, x, y)) straitTiles++; }
        }
      }
      for (const axis of ['h', 'v']) {
        const [ax, ay] = axis === 'h' ? [1, 0] : [0, 1];
        for (let y = 1; y < lvl.h - 1; y++) {
          for (let x = 1; x < lvl.w - 1; x++) {
            if (strait(lvl, x, y) !== axis) continue;
            if (strait(lvl, x - ax, y - ay) === axis) continue;
            let run = 0, cx = x, cy = y;
            while (strait(lvl, cx, cy) === axis) { run++; cx += ax; cy += ay; }
            if (run > worst) { worst = run; where = `d${d}/s${s} at ${x},${y} (${axis})`; }
          }
        }
      }
    }
  }
  assert(worst <= MAX_STRAIT,
         `a ${worst}-tile stretch with no sidestep, ${where} - cap is ${MAX_STRAIT}`);
  // And the narrow places must not have been eliminated either.
  const pc = (100 * straitTiles) / total;
  assert(pc > 5, `only ${pc.toFixed(1)}% of tiles are narrow - the chokepoints are gone`);
  return `longest ${worst} tiles, ${pc.toFixed(1)}% of the floor is narrow`;
});

check('a floor is the same floor every time it is rebuilt', () => {
  const g = freshGame('stable');
  const before = g.levelAt(3).tiles.join();
  const eBefore = g.levelAt(3).enemies.map((e) => `${e.key}@${e.x},${e.y}`).join('|');
  g.respawnLevel(3);
  assert(before === g.levelAt(3).tiles.join(), 'terrain changed after respawn');
  assert(eBefore === g.levelAt(3).enemies.map((e) => `${e.key}@${e.x},${e.y}`).join('|'),
         'enemy placement changed after respawn');
  assert(eBefore.length > 0, 'floor 3 has no enemies');
  return 'terrain and enemies both stable';
});

check('enemies arrive in packs whose threatened ground overlaps', () => {
  // The point is not more enemies, it is overlapping telegraphs. Several things
  // winding up at once is a readable object rather than noise now that every
  // blow is announced - a lane, an arc and a reach drawn on the floor with a
  // gap somewhere in them - and finding the gap is a different question from
  // reading any single attack.
  let floors = 0, clustered = 0, worst = 0;
  for (let s = 0; s < 6; s++) {
    const g = freshGame(`pack:${s}`);
    for (let d = 2; d < DUNGEON_DEPTH; d++) {
      floors++;
      const es = g.levelAt(d).livingEnemies();
      worst = Math.max(worst, es.length);
      const together = es.filter((e) =>
        es.some((o) => o !== e && Math.max(Math.abs(o.x - e.x), Math.abs(o.y - e.y)) <= 2));
      if (together.length >= 2) clustered++;
    }
  }
  assert(clustered >= floors * 0.8,
         `only ${clustered} of ${floors} floors put anything close enough together to overlap`);

  // And a pack must not simply be extra bodies - it comes out of the floor's
  // budget, so head count stays where it was.
  // Packs come out of the floor's budget; the one elite per floor does not, on
  // purpose - it is an addition, not a reshuffle.
  assert(worst <= 17, `a floor held ${worst} enemies; packs are inflating the count`);
  return `${clustered}/${floors} floors, at most ${worst} enemies on one`;
});

check('a pack pairs shapes that ask different questions', () => {
  // A pack of things that all attack the same tile is just one attack repeated.
  // Every template has to mix reach with something else.
  const shapeOf = (key) => {
    const spec = ENEMY_BY_KEY[key];
    return spec.attacks.map((a) => a.pattern ?? a.kind).join('/');
  };
  const templates = [
    ['sentinel', 'hound', 'hound'],
    ['husk', 'crawler', 'crawler'],
    ['archer', 'brute'],
    ['swordsman', 'swordsman'],
    ['warden', 'sentinel'],
  ];
  for (const t of templates) {
    for (const k of t) assert(ENEMY_BY_KEY[k], `pack refers to unknown enemy ${k}`);
    const kinds = new Set(t.map(shapeOf));
    const sameSpecies = new Set(t).size === 1;
    assert(kinds.size > 1 || sameSpecies,
           `pack ${t.join('+')} is several copies of the same question`);
  }
  return `${templates.length} templates`;
});

check('every floor has something slow and something fast on it', () => {
  const misses = [];
  for (let s = 0; s < 8; s++) {
    const g = freshGame(`mix:${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      const es = g.levelAt(d).enemies;
      if (!es.some((e) => e.spec.speed < 12)) misses.push(`d${d}/s${s}: nothing slow`);
      if (!es.some((e) => e.spec.speed >= 12)) misses.push(`d${d}/s${s}: nothing quick`);
    }
  }
  assert(!misses.length, misses.slice(0, 3).join('; '));
  return 'speed always mixed';
});

// ===========================================================================
console.log('\n--- shapes and facing -----------------------------------------');

check('attack patterns rotate to facing without collapsing or duplicating', () => {
  for (const name of Object.keys(PATTERNS)) {
    for (const d of DIRS) {
      const tiles = attackTiles(10, 10, d.dx, d.dy, name);
      const keys = new Set(tiles.map((t) => `${t.x},${t.y}`));
      assert(keys.size === tiles.length, `${name} facing ${d.name}: duplicate tiles`);
      assert(!keys.has('10,10'), `${name} facing ${d.name}: hits the attacker's own tile`);
      assert(tiles.length >= 1, `${name} facing ${d.name}: empty`);
    }
  }
  for (const d of DIRS) {
    const [t] = attackTiles(5, 5, d.dx, d.dy, 'front');
    assert(t.x === 5 + d.dx && t.y === 5 + d.dy, `front facing ${d.name} is wrong tile`);
  }
  return `${Object.keys(PATTERNS).length} patterns x 8 facings`;
});

check('one step back is not a universal answer', () => {
  // The reason the shape library exists at all. Every attack used to be
  // reach-1, so retreating one tile solved the entire game - and retreating is
  // free, so the stamina system never engaged.
  const line = attackTiles(0, 0, 1, 0, 'line3').map((t) => `${t.x},${t.y}`);
  assert(line.includes('2,0'),
         'retreating along a line escapes it; lines must punish that');

  // The instinctive dodge out of the first half of a sweep lands in the second.
  const L = attackTiles(0, 0, 1, 0, 'sweepL').map((t) => `${t.x},${t.y}`);
  const R = attackTiles(0, 0, 1, 0, 'sweepR').map((t) => `${t.x},${t.y}`);
  assert(L.includes('1,0'), 'sweepL should threaten the tile in front');
  assert(!L.includes('1,1'), 'the sidestep should be safe from the first half');
  assert(R.includes('1,1'), 'the sidestep must be caught by the second half');
  assert(R.includes('2,0'), 'backing straight off should also be caught');

  // A radial attack needs more movement than one step provides. Checked from
  // every facing, because a ring that leaks when the boss happens to be looking
  // south-east is a ring the player cannot trust.
  for (const f of DIRS) {
    const ring = attackTiles(0, 0, f.dx, f.dy, 'around2').map((t) => `${t.x},${t.y}`);
    assert(ring.length === 24, `the boss ring is ${ring.length} tiles facing ${f.name}, not 24`);
    for (const d of DIRS) {
      const sx = 1 + d.dx, sy = 0 + d.dy;
      if (sx === 0 && sy === 0) continue;            // that tile is the boss
      assert(ring.includes(`${sx},${sy}`),
             `stepping ${d.name} escapes the boss ring; it should need a roll`);
    }
  }
  return 'lines punish retreat, sweeps punish the sidestep, rings need a roll';
});

check('a sprite facing the way it is drawn is not rotated', () => {
  // The bug this pins: every sprite was rotated as if its art pointed north,
  // but most of the generated art is a front view and points south - and the
  // resting facing is south too, so a character standing still was drawn
  // rotated a full 180 degrees. Upside down, in a game about reading which way
  // something is about to swing.
  for (const [sprite, dir] of Object.entries(ART_FACING)) {
    const v = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1],
                S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] }[dir];
    const r = spriteRotation(v[0], v[1], sprite);
    assert(Math.abs(Math.atan2(Math.sin(r), Math.cos(r))) < 1e-9,
           `${sprite} is drawn facing ${dir} but rotates ${(r * 180 / Math.PI).toFixed(0)}deg to face ${dir}`);
  }

  // And turning by a quarter turn must rotate by a quarter turn, whatever the
  // art's own heading is.
  for (const sprite of Object.keys(ART_FACING)) {
    const seen = new Set();
    for (const d of DIRS) {
      const r = spriteRotation(d.dx, d.dy, sprite);
      seen.add(Math.round(((r * 180 / Math.PI) % 360 + 360) % 360));
    }
    assert(seen.size === 8, `${sprite} collapses eight facings into ${seen.size} rotations`);
  }
  return `${Object.keys(ART_FACING).length} sprites, all eight facings each`;
});

check('snapDir returns one of the eight directions for any vector', () => {
  for (let a = 0; a < 360; a += 7) {
    const r = (a * Math.PI) / 180;
    const d = snapDir(Math.cos(r) * 5, Math.sin(r) * 5);
    assert(DIRS.some((q) => q.dx === d.dx && q.dy === d.dy), `angle ${a} gave ${d.dx},${d.dy}`);
  }
  return '52 angles';
});

// ===========================================================================
console.log('\n--- the core contract -----------------------------------------');

check('rolling costs stamina and does NOT advance the turn', () => {
  const { g } = arena('roll', 'husk', 6);
  const t0 = g.turn, s0 = g.player.stamina;
  const spent = g.useSkill('roll', { dx: 0, dy: -1 });
  assert(spent === false, 'roll reported that it advanced the turn');
  assert(g.turn === t0, `turn advanced from ${t0} to ${g.turn}`);
  assert(g.player.stamina === s0 - g.player.rollCost(), 'wrong stamina cost');
  return `free turn, -${g.player.rollCost()} stamina`;
});

check('a roll can be one tile or two, for the same price', () => {
  // A fixed-distance roll only reaches a ring, not a disc - and the exact tile
  // you land on is the question now that packs draw overlapping telegraphs with
  // a gap in them and bodies block the diagonal you used to slip out through.
  // Half the tiles you might want were simply unreachable.
  const { g } = arena('rolldist', 'husk', 8);
  const p = g.player;
  const start = { x: p.x, y: p.y };

  const go = (opts) => {
    p.x = start.x; p.y = start.y; p.stamina = p.staminaMax;
    g.useSkill('roll', { dx: 1, dy: 0 }, opts);
    return { moved: Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y)),
             spent: p.staminaMax - p.stamina };
  };

  const full = go({});
  const short = go({ steps: 1 });
  assert(full.moved === 2, `a full roll moved ${full.moved}`);
  assert(short.moved === 1, `a short roll moved ${short.moved}`);

  // Same price on purpose. The decision is *where*, not how much to spend - a
  // cheaper short roll would become the default and quietly halve the bite of
  // the whole stamina economy. Rolling one tile is worse unless the tile is the
  // point, and now it often is.
  assert(short.spent === full.spent,
         `short roll cost ${short.spent}, full cost ${full.spent} - precision should not be a discount`);
  assert(short.spent === p.rollCost(), 'a roll stopped costing a roll');
  return `1 or 2 tiles, ${full.spent} stamina either way`;
});

check('attacking advances the turn and costs stamina', () => {
  const { g } = arena('atk', 'husk', 1);
  const t0 = g.turn, s0 = g.player.stamina;
  assert(g.useSkill('strike', { dx: 1, dy: 0 }) === true, 'strike did not advance the turn');
  g.worldTurn();
  assert(g.turn === t0 + 1, 'turn did not advance');
  assert(g.player.stamina < s0 + g.player.staminaRegen, 'strike was free');
  return 'costs stamina, spends the turn';
});

check('weight is the trade, and it never takes rolling away', () => {
  const light = freshGame('v1', 'light').player;
  const heavy = freshGame('v2', 'heavy').player;

  // Everyone rolls two tiles. Heavy used to roll one, and against a five-tile
  // arc or a six-tile lane that is not "dodging less well", it is not dodging -
  // two tiles is the minimum that escapes anything in the roster.
  assert(light.rollDistance() === 2 && heavy.rollDistance() === 2,
         'a roll that cannot clear an attack shape is not a roll');

  const lRolls = Math.floor(light.staminaMax / light.rollCost());
  const hRolls = Math.floor(heavy.staminaMax / heavy.rollCost());
  assert(lRolls >= 4, `light gets only ${lRolls} rolls`);
  assert(hRolls >= 2, `heavy gets only ${hRolls} rolls - that is not a trade, it is a wall`);
  assert(lRolls >= hRolls * 2, `light ${lRolls} rolls vs heavy ${hRolls} - not enough of a gap`);
  assert(heavy.hpMax > light.hpMax, 'heavy is not tougher');
  assert(heavy.regenRate(true) < light.regenRate(true),
         'weight does not slow recovery, so the two kits regenerate identically');

  return `light ${lRolls} rolls @${light.rollCost()} regen ${light.regenRate(true)}, ` +
         `heavy ${hRolls} @${heavy.rollCost()} regen ${heavy.regenRate(true)}`;
});

check('a shield taxes every action, not just blocking', () => {
  // The answer to the problem that killed the parry: enemies telegraph, so a
  // defensive reaction is always correctly timed, so charging for the *use* of
  // a block cannot make it a decision. Charging for carrying the option can.
  const g = freshGame('shield', 'light');
  const p = g.player;
  const bare = p.costOf('strike');

  // Scaled by the shield's weight, not flat. A flat point made the buckler a
  // straight loss - you gave up the off-hand weapon's skill AND paid the tax
  // for one direction of cover, and the bot duly died more with it than
  // without. A buckler now costs only its weight; the tower shield pays.
  p.equipItem(SLOT.OFF, 'buckler');
  assert(p.actionSurcharge === 0, 'a buckler taxes every swing, which makes it a trap');

  p.equipItem(SLOT.OFF, 'tower');
  assert(p.actionSurcharge >= 1, 'a tower shield is free to carry');
  assert(p.costOf('strike') > bare, 'the surcharge is not applied to attacks');
  assert(p.costOf('roll') > SKILL_BY_KEY.roll.stamina, 'a tower shield does not make rolling dearer');
  return `strike ${bare} bare, ${p.costOf('strike')} behind a tower shield`;
});

check('walking is always free, however loaded you are', () => {
  // Two dead ends from the design conversation, both of which sound reasonable.
  // Taxing movement taxes *exploration* - most turns are spent crossing an
  // empty floor - so you would arrive at every fight already spent. And it
  // creates a locked state: heavy, empty bar, something fast next to you, and
  // no legal move at all.
  const g = freshGame('walk', 'heavy');
  const p = g.player;
  p.equipItem(SLOT.OFF, 'tower');
  p.stamina = 0;
  const before = { x: p.x, y: p.y };
  for (const d of DIRS) {
    if (!g.level.passable(p.x + d.dx, p.y + d.dy)) continue;
    g.step(d.dx, d.dy);
    break;
  }
  assert(p.x !== before.x || p.y !== before.y,
         'a fully loaded player at zero stamina could not move at all');
  return 'no locked states';
});

check('stamina comes back fast until something notices you', () => {
  const g = freshGame('aggro', 'light');
  for (const e of g.level.enemies) { e.aware = false; e.lost = 0; }
  assert(!g.inCombat(), 'nothing has seen the player, but the game says combat');
  const calm = g.player.regenRate(g.inCombat());

  g.level.livingEnemies()[0].aware = true;
  assert(g.inCombat(), 'an aware enemy does not count as combat');
  const fight = g.player.regenRate(g.inCombat());

  assert(calm > fight, `out of combat regen ${calm} is not better than ${fight}`);
  return `${fight}/turn hunted, ${calm}/turn otherwise`;
});

check('stamina regen is just under one light roll', () => {
  assert(PLAYER.staminaRegen < SKILL_BY_KEY.roll.stamina,
         `regen ${PLAYER.staminaRegen} >= roll ${SKILL_BY_KEY.roll.stamina} - dodging would be free`);
  assert(PLAYER.staminaRegen * 2 >= SKILL_BY_KEY.roll.stamina,
         'regen so low that dodging every other turn is impossible');
  return `${PLAYER.staminaRegen}/turn vs ${SKILL_BY_KEY.roll.stamina} per roll`;
});

check('every blow in the game is announced', () => {
  // The contract, and it took a wrong turn to get back to. Fast enemies used to
  // strike with no wind-up at all, on the reasoning that otherwise stepping
  // back one tile beat everything - which was true when every attack was
  // `front` at reach one, and stopped being true the moment attack shapes
  // existed. The justification was spent; the side effect was not. By encounter
  // weight, 54 to 62% of everything you met carried an unreadable attack, and
  // killing the boss with a sword meant eating more than a full health bar of
  // damage you were never allowed to react to.
  //
  // What replaces concealment is commitment: see `step` below.
  const bad = [];
  for (const spec of ENEMIES) {
    for (const a of spec.attacks) {
      if (a.windup < 1) bad.push(`${spec.key}/${a.name}`);
      if (a.next && a.next.windup < 1) bad.push(`${spec.key}/${a.next.name}`);
      assert(a.recovery >= 1, `${spec.key}/${a.name} has no recovery`);
    }
  }
  assert(!bad.length, `unannounced: ${bad.join(', ')}`);

  // And nothing may deal damage from a state other than a wind-up.
  for (const spec of ENEMIES) {
    if (spec.attacks.some((a) => a.kind === 'ranged')) continue;
    const { g, e } = arena(`tel:${spec.key}`, spec.key, 1);
    const hp0 = g.player.hp;
    for (let t = 0; t < 16; t++) {
      const before = e.state;
      g.worldTurn();
      if (g.player.hp < hp0) {
        assert(before === STATE.WINDUP, `${spec.key} dealt damage from state "${before}"`);
        break;
      }
      if (!e.alive) break;
    }
  }
  return `${ENEMIES.length} species, nothing unannounced`;
});

check('reading an attack is not the same as walking out of it for free', () => {
  // The thing that lets every attack telegraph without the fight turning into a
  // shuffle. A hound announces its pounce and then comes with you; a crawler
  // reaches two tiles. Backing off one square answers neither, so the reply is
  // a roll, a block, or hitting it first - and at poise 2 a single strike
  // breaks a hound, which is the thing a melee character wanted to do anyway.
  const committed = [];
  for (const spec of ENEMIES) {
    for (const a of spec.attacks) {
      const reaches = a.step > 0 || a.range > 1 ||
                      ['arc5', 'line3', 'line6', 'reach2', 'sweepL', 'sweepR',
                       'around', 'around2'].includes(a.pattern);
      if (reaches) { committed.push(spec.key); break; }
    }
  }
  const soft = ENEMIES.filter((s) => !committed.includes(s.key) && !s.boss)
                      .filter((s) => !s.attacks.some((a) => a.kind === 'ranged'));
  assert(soft.length <= 1,
         `${soft.map((s) => s.key).join(', ')} can all be beaten by stepping backwards`);

  // The two fast ones specifically: a step back must not be an answer.
  const hound = ENEMY_BY_KEY.hound.attacks[0];
  assert(hound.step >= 1, 'the hound no longer commits to its pounce');
  assert(ENEMY_BY_KEY.crawler.attacks[0].range >= 2, 'the crawler lost its reach');
  assert(SKILL_BY_KEY.strike.impact >= ENEMY_BY_KEY.hound.poise,
         'a single strike no longer interrupts a hound, so melee has no answer to one');
  return `${committed.length} species commit; a strike still breaks a hound`;
});

check('the tiles shown during a wind-up are the tiles that get hit', () => {
  // Immutable *within* a wind-up. A combo's second stage legitimately shows
  // different tiles - and, if it re-aims, tiles chosen after you moved - but it
  // telegraphs them before it lands, which is the part that matters.
  const { g, e } = arena('promise', 'sentinel', 2);
  e.stamina = e.staminaMax;
  let promised = null, watching = null, stages = 0;
  observe(g, e, 40, () => {
    if (e.state === STATE.WINDUP) {
      const now = e.attackTiles.map((q) => `${q.x},${q.y}`).sort().join('|');
      if (e.attack !== watching) { watching = e.attack; promised = now; stages++; }
      else assert(now === promised, 'the telegraph moved during a single wind-up');
    }
    return stages >= 2 && e.state === STATE.RECOVER;
  });
  assert(stages > 0, 'the sentinel never wound up');
  return `${stages} wind-ups watched, none changed after being shown`;
});

check('poise decides what can be interrupted', () => {
  // The interrupt on its own let a 4-stamina jab postpone a 7-stamina overhead
  // for ever, so 1v1 was solved by standing still and swinging.
  const light = SKILL_BY_KEY.strike.impact;

  const a = arena('poise-mid', 'sentinel', 1);
  a.e.stamina = a.e.staminaMax;
  observe(a.g, a.e, 20, () => a.e.state === STATE.WINDUP);
  assert(a.e.state === STATE.WINDUP, 'the sentinel never wound up');
  assert(a.e.poise > light, 'sentinel poise too low to test with');
  const t0 = a.e.timer;
  a.e.stagger(light);
  assert(a.e.timer === t0, 'one light hit interrupted a sentinel');
  a.e.stagger(light);
  assert(a.e.timer === t0 + 1, 'two light hits failed to interrupt a sentinel');

  // The brute is the other tier. Basic attacks cannot touch its wind-up, and
  // breaking it at all costs most of the bar - so "interrupt everything" is a
  // decision with a price rather than the answer to every fight.
  const brute = ENEMY_BY_KEY.brute;
  const overhead = brute.attacks.find((x) => x.windup >= 3);
  assert(overhead, 'the brute lost its heavy attack');

  const basic = SKILL_BY_KEY.strike;
  assert(basic.cooldown === 0 && basic.impact * overhead.windup < brute.poise,
         `spamming ${basic.name} breaks poise ${brute.poise} in ${overhead.windup} turns`);

  // Best case for the player: each turn of the wind-up, throw the heaviest
  // attack that is off cooldown and affordable.
  const cd = {}, spent = [];
  let poise = 0, stamina = PLAYER.staminaMax;
  for (let t = 0; t < overhead.windup; t++) {
    const best = SKILLS
      .filter((k) => k.advancesTurn && !(cd[k.key] > 0) && k.stamina <= stamina)
      .sort((x, y) => (y.impact ?? 0) - (x.impact ?? 0))[0];
    if (!best) break;
    for (const k of Object.keys(cd)) cd[k]--;
    poise += best.impact ?? 0;
    stamina -= best.stamina;
    cd[best.key] = best.cooldown;
    spent.push(best.key);
  }
  const cost = PLAYER.staminaMax - stamina;
  assert(poise >= brute.poise,
         `nothing the player owns can ever break poise ${brute.poise} (best ${poise})`);
  assert(cost > PLAYER.staminaMax / 2,
         `interrupting a brute costs only ${cost} of ${PLAYER.staminaMax} stamina - too cheap`);
  return `sentinel ${a.e.poise} falls to two strikes; brute ${brute.poise} needs ` +
         `${spent.join('+')} and ${cost} stamina`;
});

check('a combination continues with no gap', () => {
  // The follow-up arrives during what would have been the recovery window,
  // which is what removes the free "step aside, walk back, take three swings".
  const { g, e } = arena('combo', 'swordsman', 1);
  e.stamina = e.staminaMax;
  let chained = false;
  for (let t = 0; t < 60 && e.alive; t++) {
    g.player.hp = g.player.hpMax;
    const hadNext = e.state === STATE.WINDUP && !!e.attack?.next;
    g.worldTurn();
    if (hadNext && e.state === STATE.WINDUP && e.attack && !e.attack.next) chained = true;
  }
  assert(chained, 'the swordsman never chained its sweep into the backswing');
  const combo = ENEMY_BY_KEY.swordsman.attacks.find((a) => a.next);
  assert(combo.next.cost === 0, 'the follow-up should not be paid for twice');
  return 'stage two telegraphs the instant stage one lands';
});

check('a stepping attack moves the attacker but never onto an occupant', () => {
  // A stepper that walked onto its target resolved its arc from the target's
  // own square and missed entirely - so the brute could never legally pick its
  // overhead and threw cheap backhands all fight. It read as a balance problem
  // and was a geometry bug.
  for (const [key, gap] of [['brute', 2], ['minotaur', 5]]) {
    const { g, e } = arena(`step:${key}`, key, gap);
    e.stamina = e.staminaMax;
    observe(g, e, 40, () => {
      assert(!(e.x === g.player.x && e.y === g.player.y), `${key} stepped onto the player`);
      return false;
    });
  }
  const brute = arena('step-use', 'brute', 2);
  brute.e.stamina = brute.e.staminaMax;
  let usedHeavy = false;
  observe(brute.g, brute.e, 80, () => {
    if (brute.e.state === STATE.WINDUP && brute.e.attack?.step) usedHeavy = true;
    return false;
  });
  assert(usedHeavy, 'the brute never used its stepping attack');
  return 'steppers stop before bodies, and still connect';
});

check('a kill refunds a turn of every cooldown', () => {
  const { g, e } = arena('combo-cd', 'hound', 1);
  const slot = g.player.skill('sweep');
  slot.cd = 3;
  e.hp = 1;
  g.useSkill('strike', { dx: 1, dy: 0 });
  assert(!e.alive, 'the hound survived a strike at 1 hp');
  assert(slot.cd === 2, `cooldown ${slot.cd}, expected 2`);
  return 'kill -> cooldowns tick';
});

check('sustained aggression exhausts an enemy', () => {
  const { g, e } = arena('winded', 'brute', 2);
  const dearest = Math.max(...e.spec.attacks.map((a) => a.cost));
  let minStamina = 99, forcedDown = false;
  observe(g, e, 140, () => {
    minStamina = Math.min(minStamina, e.stamina);
    if (e.stamina < dearest) forcedDown = true;
    return false;
  });
  assert(minStamina >= 0, `stamina went to ${minStamina}`);
  assert(forcedDown, 'the brute could always afford its heaviest attack');

  const sen = arena('winded2', 'sentinel', 2);
  let sawResting = false;
  observe(sen.g, sen.e, 200, () => {
    if (sen.e.state === STATE.RESTING) { sawResting = true; return true; }
    return false;
  });
  assert(sawResting, 'the sentinel never had to stop and breathe');
  return 'expensive attacks price themselves out of the fight';
});

check('nothing lands blows faster than its own recovery allows', () => {
  // This started life guarding untelegraphed attacks and is now pointed at the
  // whole roster, which is where it always belonged. It is a regression test
  // for a scheduler bug: enemies used to gain energy while winding up and
  // recovering, so a hound banked its entire idle time and spent it in a burst
  // afterwards - three tiles of movement in a single turn, which made
  // disengaging arithmetically impossible. It presented as the bestiary being
  // over-tuned and accounted for a quarter of all recorded deaths.
  const TURNS = 160;
  const rows = [];
  for (const spec of ENEMIES) {
    const melee = spec.attacks.filter((a) => a.kind !== 'ranged');
    if (!melee.length) continue;
    const { g, e } = arena(`rate:${spec.key}`, spec.key, 1);
    e.stamina = e.staminaMax;

    let blows = 0, prev = e.state, hops = 0;
    observe(g, e, TURNS, () => {
      const bx = e.x, by = e.y;
      if (prev !== STATE.RECOVER && e.state === STATE.RECOVER) blows++;
      prev = e.state;
      hops = Math.max(hops, Math.max(Math.abs(e.x - bx), Math.abs(e.y - by)));
      return false;
    });

    // The cheapest full cycle it could possibly run: wind up, land, recover.
    const fastest = Math.min(...melee.map((a) => a.windup + a.recovery));
    const ceiling = TURNS / Math.max(1, fastest);
    assert(blows <= ceiling + 2,
           `${spec.key} landed ${blows} blows in ${TURNS} turns, past its own ` +
           `ceiling of ${ceiling.toFixed(0)} - it is banking turns somewhere`);

    // And nothing may cross more ground in one turn than its speed buys, plus
    // the one tile a stepping attack is allowed to carry it.
    const step = Math.max(...melee.map((a) => a.step ?? 0));
    assert(hops <= Math.ceil(spec.speed / 12) + step + 1,
           `${spec.key} moved ${hops} tiles in a single turn at speed ${spec.speed}`);
    rows.push(`${spec.key} ${blows}`);
  }
  assert(rows.length >= 8, 'expected most of the roster to be checked');
  return `${rows.length} species, none banking turns`;
});

// ===========================================================================
console.log('\n--- equipment --------------------------------------------------');

check('a weapon is a set of verbs, and the off hand only gets the first', () => {
  // The one line the whole loadout trade rests on.
  const { g } = arena('offhand', 'husk', 4);
  const p = g.player;
  p.equipItem(SLOT.MAIN, 'sword');
  p.equipItem(SLOT.OFF, 'spear');
  const active = p.activeSkills();
  assert(active.includes('strike') && active.includes('sweep'),
         'the main hand should grant both of its skills');
  assert(active.includes('thrust'), 'the off hand should grant its primary');
  assert(!active.includes('skewer'),
         'the off hand granted a secondary - dual wielding would dominate two-handers');
  assert(!g.useSkill('skewer', { dx: 1, dy: 0 }),
         'a skill you do not hold was usable anyway');
  return 'main: both, off: primary only';
});

check('walking into something swings whatever you are holding', () => {
  // Regression. Walking into an enemy called `strike` by name - the longsword's
  // primary - so the moment you picked up a mace the oldest interaction in the
  // game stopped working and told you that you were "not holding anything that
  // does that". Reported from play, not caught by any test, because every test
  // and the bot were carrying the starting sword.
  const { g, e } = arena('walkswing', 'husk', 1);
  const p = g.player;
  for (const [main, off] of [['sword', null], ['mace', 'tower'], ['greataxe', null],
                             ['spear', null], ['dagger', 'buckler'], ['falchion', null]]) {
    p.equipItem(SLOT.MAIN, main);
    p.equipItem(SLOT.OFF, off);
    p.stamina = p.staminaMax;
    p.recover = 0;
    e.hp = 99;
    const swing = p.meleeSkill();
    assert(swing, `${main} gives nothing to swing by walking`);
    assert(p.hasSkill(swing), `${main} would swing ${swing}, which it does not grant`);
    const before = e.hp;
    g.step(e.x - p.x, e.y - p.y);
    assert(e.hp < before, `walking into an enemy with a ${main} did nothing`);
  }

  // A bow is not a melee weapon, and saying so is better than silently failing.
  p.equipItem(SLOT.MAIN, 'bow');
  assert(!p.meleeSkill(), 'a bow counts as something to hit people with');
  return 'the main hand decides';
});

check('one affix per source, and two innate means no more work', () => {
  // The constraint is the design. Every affix can be traced to where it came
  // from, which is what stops them turning into the stat soup they become
  // everywhere else - and it makes "a strong found weapon" and "a customisable
  // weapon" two different weapons rather than one strictly better one.
  const { g } = arena('affix', 'husk', 6);
  const p = g.player;

  p.equipItem(SLOT.MAIN, 'sword');
  assert(canGrant(ITEM_BY_KEY.sword, p.affix.sword), 'a plain sword cannot be worked on');

  p.pack.push('stone_keen');
  g.prepareFromPack('item', 'stone_keen');
  p.stamina = p.staminaMax;
  assert(g.usePrepared('item', null), 'the stone did nothing');
  assert(p.affix.sword.granted === 'keen', 'the sword did not take the affix');
  assert(p.mods('strike').knock === 1, 'the affix changed nothing about the skill');

  // Second stone: refused, because the granted slot is taken.
  p.pack.push('stone_light');
  g.prepareFromPack('item', 'stone_light');
  p.stamina = p.staminaMax;
  g.usePrepared('item', null);
  assert(p.affix.sword.granted === 'keen', 'a second stone overwrote the first');

  // Two innate: nothing fits, ever.
  const hammer = ITEM_BY_KEY.warhammer;
  assert((hammer.affixes ?? []).length === 2, 'the warhammer lost its innate pair');
  assert(!canGrant(hammer, p.affix.warhammer), 'a fully forged weapon accepted more work');
  p.equipItem(SLOT.MAIN, 'warhammer');
  assert(p.mods('pound').damage > 0 && p.mods('pound').impact > 0,
         'the warhammer does not feel its own innate affixes');
  return 'innate, granted, temp - one each';
});

check('a temporary affix is spent in hits that land, not turns that pass', () => {
  const { g, e } = arena('oil', 'husk', 1);
  const p = g.player;
  p.equipItem(SLOT.MAIN, 'sword');
  p.pack.push('oil_ember');
  g.prepareFromPack('item', 'oil_ember');
  p.stamina = p.staminaMax;
  assert(g.usePrepared('item', null), 'the oil did nothing');
  assert(p.affix.sword.temp.hits === TEMP_HITS, 'the oil did not set a hit count');

  // Turns alone must not spend it.
  for (let i = 0; i < 4; i++) g.worldTurn();
  assert(p.affix.sword.temp.hits === TEMP_HITS, 'time wore the oil off');

  const base = SKILL_BY_KEY.strike.damage;
  let boosted = 0;
  for (let i = 0; i < TEMP_HITS + 2; i++) {
    e.hp = 999; e.x = p.x + 1; e.y = p.y; g.level.markEnemiesDirty();
    p.stamina = p.staminaMax; p.recover = 0; p.skill('strike').cd = 0;
    const before = e.hp;
    g.useSkill('strike', { dx: 1, dy: 0 });
    if (before - e.hp > base) boosted++;
  }
  assert(boosted === TEMP_HITS, `${boosted} boosted hits, expected exactly ${TEMP_HITS}`);
  assert(!(p.affix.sword.temp.hits > 0), 'the oil never ran out');
  return `${TEMP_HITS} hits, and turns do not count`;
});

check('affixes change weight, and weight is felt', () => {
  const { g } = arena('affix-w', 'husk', 6);
  const p = g.player;
  p.equipItem(SLOT.MAIN, 'greataxe');
  p.equipItem(SLOT.OFF, null);
  const before = { weight: p.weight, roll: p.rollCost() };

  p.affix.greataxe = { granted: 'light' };
  assert(p.weight < before.weight, 'a lightening affix did not change the weight');
  assert(p.rollCost() <= before.roll, 'lighter gear did not make rolling cheaper');
  return `${before.weight} -> ${p.weight}`;
});

check('no affix rewrites a pattern, so the button icons cannot lie', () => {
  // The shape icons are generated from the pattern table precisely so they
  // cannot drift from what the attack does. An affix that changed the pattern
  // would put that back.
  for (const a of AFFIXES) {
    assert(!('pattern' in a), `${a.key} changes a pattern`);
    for (const f of ['damage', 'impact', 'knock', 'stamina', 'cooldown', 'weight']) {
      assert(typeof a[f] === 'number', `${a.key}.${f} is not a number`);
    }
  }
  // And every stone or oil names an affix that exists.
  for (const c of CONSUMABLES) {
    for (const k of [c.grants, c.tempAffix]) {
      if (k) assert(AFFIX_BY_KEY[k], `${c.key} grants unknown affix "${k}"`);
    }
  }
  return `${AFFIXES.length} affixes, all numeric`;
});

check('a two-handed weapon really takes both hands', () => {
  const { g } = arena('twohand', 'husk', 4);
  const p = g.player;
  p.equipItem(SLOT.MAIN, 'sword');
  p.equipItem(SLOT.OFF, 'dagger');
  const res = p.equipItem(SLOT.MAIN, 'greataxe');
  assert(res.ok, 'could not equip a two-hander');
  assert(res.displaced.includes('dagger'), 'the off-hand item was not displaced');
  assert(!p.equip.off, 'the off hand is still holding something');
  assert(!p.equipItem(SLOT.OFF, 'dagger').ok, 'the off hand accepted an item anyway');
  const active = p.activeSkills();
  assert(active.includes('cleave') && active.includes('rend'), 'two-hander lost its skills');
  return 'both hands means both hands';
});

check('every weapon grants two real skills, and every skill has an owner', () => {
  const owned = new Set();
  for (const it of ITEMS) {
    if (it.kind !== 'weapon') continue;
    assert(it.primary && it.secondary, `${it.key} is missing a skill`);
    for (const k of [it.primary, it.secondary]) {
      assert(SKILL_BY_KEY[k], `${it.key} refers to unknown skill "${k}"`);
      owned.add(k);
    }
    assert(skillsFrom(it, SLOT.OFF).length === 1, `${it.key} grants the wrong number off-hand`);
  }
  for (const s of SKILLS) {
    if (s.always) continue;
    if (s.needsShield) {
      assert(ITEMS.some((i) => i.kind === 'shield'), `${s.key} needs a shield and there are none`);
      continue;
    }
    assert(owned.has(s.key), `${s.key} is defined but nothing grants it`);
  }
  return `${ITEMS.filter((i) => i.kind === 'weapon').length} weapons`;
});

check('swapping costs a turn, and cooldowns survive it', () => {
  // If a swap reset cooldowns, sheathing and drawing would be a free refresh -
  // and swapping costs a turn precisely so that it is a real decision.
  const { g } = arena('swap', 'husk', 6);
  const p = g.player;
  p.equipItem(SLOT.MAIN, 'sword');
  p.skill('sweep').cd = 3;

  const t0 = g.turn;
  assert(g.equipFromPack(SLOT.MAIN, 'spear') === true, 'equipping did not report a spent turn');
  g.worldTurn();
  assert(g.turn === t0 + 1, 'equipping did not advance the turn');
  assert(!p.hasSkill('sweep'), 'still holding the old weapon');
  assert(p.pack.includes('sword'), 'the old weapon did not go back in the pack');

  g.equipFromPack(SLOT.MAIN, 'sword');
  assert(p.skill('sweep').cd > 0, 'a weapon swap reset the cooldown');
  return 'a turn spent, cooldowns kept';
});

check('the pack is the only place equipment comes from', () => {
  const { g } = arena('pack', 'husk', 6);
  const p = g.player;
  p.pack = [];
  assert(!g.equipFromPack(SLOT.MAIN, 'greataxe'), 'equipped something not carried');
  assert(!g.equipFromPack(SLOT.ARMOUR, 'sword'), 'put a sword in the armour slot');
  return 'no conjuring';
});

check('armour turns aside a fraction, so it answers big blows not chip', () => {
  // A flat -1 was worth 50% against a two-damage bite and 17% against a
  // six-damage pyre, so it blunted exactly the chip damage the light kit
  // suffers most from - which is the opposite of what mail's own description
  // promises ("you have to read further ahead").
  const g = freshGame('armour-pct', 'heavy');
  const p = g.player;
  const took = (raw) => { p.hp = p.hpMax; g.hurtPlayer(raw, 'a test'); return p.hpMax - p.hp; };

  p.equipItem(SLOT.ARMOUR, 'leathers');
  for (const raw of [2, 3, 6]) assert(took(raw) === raw, 'leathers turned something aside');

  p.equipItem(SLOT.ARMOUR, 'mail');
  assert(took(2) === 2, 'mail still discounts the smallest hits');
  assert(took(6) < 6, 'mail does nothing against a heavy blow');

  p.equipItem(SLOT.ARMOUR, 'plate');
  const light = took(2), heavy = took(6);
  assert(6 - heavy > 2 - light,
         `plate saves ${2 - light} on a small hit and ${6 - heavy} on a big one - ` +
         'armour should be worth more against the blow you could not avoid');

  // And nothing is ever reduced to nothing: a hit that lands, hurts.
  for (const armourKey of ['mail', 'plate']) {
    p.equipItem(SLOT.ARMOUR, armourKey);
    assert(took(1) >= 1, `${armourKey} made a blow free`);
  }
  return 'proportional, and never free';
});

check('armour carries the health and the damage reduction', () => {
  for (const [vow, key] of [['light', 'leathers'], ['heavy', 'mail']]) {
    const g = freshGame(`armour:${vow}`, vow);
    const it = ITEM_BY_KEY[key];
    assert(g.player.equip.armour === key, `${vow} is not wearing ${key}`);
    assert(g.player.hpMax === it.hp, `${vow} hpMax is ${g.player.hpMax}, armour says ${it.hp}`);
    assert(g.player.armourReduce === it.reduce, `${vow} reduction differs from its armour`);
    assert(g.player.heavyArmour === it.heavy, `${vow} heaviness differs from its armour`);
  }
  const g = freshGame('armour:apply', 'heavy');
  const before = g.player.hp;
  g.hurtPlayer(4, 'a test');
  assert(before - g.player.hp < 4, 'mail turned nothing aside');
  return 'health and reduction both come off the armour';
});

// ===========================================================================
check('a small shield covers one direction, a big one covers three', () => {
  const N = { dx: 0, dy: -1 }, NE = { dx: 1, dy: -1 }, E = { dx: 1, dy: 0 }, S = { dx: 0, dy: 1 };
  const small = ITEM_BY_KEY.buckler.block.arc;
  const big = ITEM_BY_KEY.tower.block.arc;
  assert(small === 1 && big === 3, 'the two shields no longer differ in coverage');

  assert(blocksDirection(N, N, small), 'a buckler does not cover what it points at');
  assert(!blocksDirection(N, NE, small), 'a buckler covers a neighbour it should not');
  assert(blocksDirection(N, NE, big), 'a tower shield does not cover its neighbour');
  assert(!blocksDirection(N, E, big), 'a tower shield covers a quarter turn away');

  // Nothing covers everything - which is what stops any shield from being the
  // answer to being surrounded.
  for (const arc of [small, big]) {
    const covered = DIRS.filter((d) => blocksDirection(N, d, arc)).length;
    assert(covered === arc, `arc ${arc} actually covers ${covered} directions`);
    assert(covered < 8, 'a shield covers every direction');
  }
  assert(!blocksDirection(N, S, big), 'a shield blocks something behind you');
  return `buckler ${small}/8, tower ${big}/8`;
});

check('a blow you face is reduced; the same blow from behind is not', () => {
  const mk = (facing) => {
    const g = freshGame(`blk:${facing.dx},${facing.dy}`, 'light');
    g.player.equipItem(SLOT.OFF, 'buckler');
    g.player.blocking = { dx: 0, dy: -1 };     // shield up, facing north
    const before = g.player.hp;
    g.hurtPlayer(4, 'a test', { from: facing });
    return before - g.player.hp;
  };
  const met = mk({ dx: 0, dy: -1 });
  const behind = mk({ dx: 0, dy: 1 });
  assert(met < behind, `blocked ${met} vs unblocked ${behind} - the shield did nothing`);
  assert(behind === 4, `an unblocked hit took ${behind}, expected the full 4`);
  return `${behind} from behind, ${met} into the shield`;
});

check('a shield that is not raised does nothing', () => {
  const g = freshGame('blk:down', 'light');
  g.player.equipItem(SLOT.OFF, 'buckler');
  g.player.blocking = null;
  const before = g.player.hp;
  g.hurtPlayer(4, 'a test', { from: { dx: 0, dy: -1 } });
  assert(before - g.player.hp === 4, 'a shield blocked without being raised');
  return 'carrying is not blocking';
});

check('some attacks go straight through a shield, and they say so', () => {
  // Flagged per attack rather than derived from geometry, for the same reason
  // the wind-up is: a player has to be able to look it up, not infer it.
  const charge = ENEMY_BY_KEY.minotaur.attacks.find((a) => a.name === 'charge');
  assert(charge.unblockable, 'the charge is blockable again');

  const g = freshGame('blk:unblockable', 'light');
  g.player.equipItem(SLOT.OFF, 'tower');
  g.player.blocking = { dx: 0, dy: -1 };
  const before = g.player.hp;
  g.hurtPlayer(4, 'a test', { from: { dx: 0, dy: -1 }, unblockable: true });
  assert(before - g.player.hp === 4, 'an unblockable hit was blocked anyway');
  return 'the charge runs you over';
});

check('block advances the turn, so rolling still wins where there is room', () => {
  // The whole reason block is not simply better than rolling: rolling does not
  // advance the turn and this does. Block is what you do with nowhere to go.
  assert(SKILL_BY_KEY.block.advancesTurn === true, 'block became a free action');
  assert(SKILL_BY_KEY.roll.advancesTurn === false, 'rolling started costing a turn');

  const { g } = arena('blk:turn', 'husk', 4);
  g.player.equipItem(SLOT.OFF, 'buckler');
  const t0 = g.turn;
  assert(g.useSkill('block', { dx: 1, dy: 0 }) === true, 'block did not report a spent turn');
  assert(g.player.blocking, 'the shield did not go up');
  g.worldTurn();
  assert(g.turn === t0 + 1, 'block did not advance the turn');
  assert(!g.player.blocking, 'the shield stayed up past the turn it was raised');
  return 'up for one turn, and it costs the turn';
});

check('you cannot block bare-handed', () => {
  const { g } = arena('blk:none', 'husk', 4);
  g.player.equipItem(SLOT.OFF, 'dagger');
  assert(!g.player.hasSkill('block'), 'a dagger grants a block');
  assert(!g.useSkill('block', { dx: 1, dy: 0 }), 'blocked without a shield');
  return 'no shield, no block';
});

check('a prepared item is limited, costs the turn, and refills at a bonfire', () => {
  // This one exists because of a measured problem, not a wishlist: health only
  // came back at a bonfire, so a run was a slow slide from full to dead with
  // nothing you could do about it mid-floor. The bot died at full stamina with
  // six escape routes open, on chip damage it had taken three fights ago.
  const { g } = arena('flask', 'husk', 6);
  const p = g.player;
  assert(p.prepared('item')?.key === 'flask', 'the starting kit has no flask');

  p.hp = 3;
  const full = p.chargesOf('flask');
  const t0 = g.turn;
  assert(g.usePrepared('item', null) === true, 'drinking did not spend the turn');
  g.worldTurn();
  assert(g.turn === t0 + 1, 'drinking was free');
  assert(p.hp > 3, 'drinking did not heal');
  assert(p.chargesOf('flask') === full - 1, 'drinking did not cost a charge');

  p.charges.flask = 0;
  assert(!g.usePrepared('item', null), 'drank from an empty flask');

  // Bonfires refill; picking things up does not. Nothing may be hunting you,
  // which is a rule of its own - see the test below.
  g.player.x = g.level.bonfires[0].x; g.player.y = g.level.bonfires[0].y;
  for (const q of g.level.enemies) q.aware = false;
  g.rest();
  assert(p.chargesOf('flask') === full, 'a bonfire did not refill the flask');
  return `${full} charges, refilled at the fire`;
});

check('preparing costs a turn and swaps through the pack', () => {
  const { g } = arena('prep', 'husk', 6);
  const p = g.player;
  p.pack.push('whetstone');
  const was = p.prep.item;

  assert(g.prepareFromPack('item', 'whetstone') === true, 'preparing did not spend a turn');
  assert(p.prep.item === 'whetstone', 'the whetstone is not readied');
  assert(p.pack.includes(was), 'the old item did not go back in the pack');
  assert(!p.pack.includes('whetstone'), 'the readied item is still in the pack too');

  assert(!g.prepareFromPack('magic', 'whetstone'), 'an item was readied into the spell slot');
  assert(!g.prepareFromPack('item', 'sword'), 'a sword was readied as an item');
  return 'one item, one spell, a turn each';
});

check('a spell is aimed like any other skill and flies like any other attack', () => {
  const { g, e } = arena('spell', 'husk', 4);
  const p = g.player;
  assert(p.prepared('magic'), 'the starting kit has no spell');
  g.prepareFromPack('magic', null);
  p.pack.push('firebolt');
  g.prepareFromPack('magic', 'firebolt');

  const before = p.chargesOf('firebolt');
  assert(g.useSkill('prep:magic', { dx: 1, dy: 0 }) === true, 'casting did not spend the turn');
  assert(p.chargesOf('firebolt') === before - 1, 'casting did not cost a charge');
  assert(g.level.projectiles.length > 0, 'the bolt did not go anywhere');

  // And it is on the board like everything else, so it can miss and it can hit
  // the wrong thing.
  const pr = g.level.projectiles[0];
  assert(pr.fromPlayer, 'the player\'s own bolt is not marked as theirs');
  return 'cast, flies, costs a charge';
});

check('every consumable is reachable and does something', () => {
  for (const c of CONSUMABLES) {
    assert(c.charges > 0, `${c.key} has no charges`);
    assert(c.kind === 'item' || c.kind === 'magic', `${c.key} is neither item nor magic`);
    assert(c.heal || c.damage || c.pattern || c.projectile || c.shield || c.teleport ||
           c.grants || c.tempAffix,
           `${c.key} does nothing at all`);
    if (c.directional) {
      assert(c.pattern || c.projectile || c.teleport, `${c.key} is aimed but has no shape`);
    }
  }
  return `${CONSUMABLES.length} consumables`;
});

check('a heavy swing leaves you standing there, and you cannot roll out of it', () => {
  // The player learns "recovery is the punish window" from the wrong end of it
  // all game. This is the same rule pointed the other way, and closing the
  // escape hatch is exactly what gives it weight - a cooldown you can dodge
  // through is a price, not a commitment.
  const { g, e } = arena('recover', 'husk', 2);
  const p = g.player;
  p.equipItem(SLOT.MAIN, 'warhammer');
  p.stamina = p.staminaMax;
  const heavy = SKILL_BY_KEY.sunder;
  assert(heavy.recovery >= 2, 'sunder lost its recovery');

  assert(g.useSkill('sunder', { dx: 1, dy: 0 }) === true, 'sunder did not spend the turn');
  g.worldTurn();
  assert(p.recovering, 'no recovery after the heaviest attack in the game');

  const st = p.stamina;
  assert(!g.useSkill('roll', { dx: -1, dy: 0 }), 'rolled out of a recovery');
  assert(!g.useSkill('pound', { dx: 1, dy: 0 }), 'attacked during a recovery');
  g.worldTurn();
  assert(p.stamina === st, 'stamina came back during a recovery');

  let guard = 0;
  while (p.recovering && guard++ < 6) g.worldTurn();
  assert(!p.recovering, 'the recovery never ended');
  return `${heavy.recovery} turns helpless, and no stamina in them`;
});

check('only secondary skills ever have a recovery', () => {
  // Otherwise it is not a choice you made, it is a tax on holding the weapon.
  for (const it of ITEMS) {
    if (it.kind !== 'weapon') continue;
    const first = SKILL_BY_KEY[it.primary];
    assert(!first.recovery, `${it.key}'s primary (${it.primary}) has a recovery`);
  }
  // And nothing pays all three of stamina, cooldown and recovery.
  for (const s of SKILLS) {
    if (!s.recovery) continue;
    assert((s.cooldown ?? 0) <= 1,
           `${s.key} pays stamina AND cooldown ${s.cooldown} AND recovery - three taxes`);
  }
  return 'commitment is opt-in';
});

check('knockback moves things, and stops at whatever is behind them', () => {
  const { g, e } = arena('knock', 'husk', 1);
  const p = g.player;
  p.equipItem(SLOT.MAIN, 'falchion');
  p.stamina = p.staminaMax;
  e.hp = 99;                                  // we are testing the push, not the kill

  const before = e.x;
  assert(g.useSkill('shove', { dx: 1, dy: 0 }) === true, 'shove did not spend the turn');
  assert(e.x > before, `shove did not move it (${before} -> ${e.x})`);
  assert(SKILL_BY_KEY.shove.damage <= 1, 'shove deals real damage; it is meant to be a tool');

  // Something solid behind it stops the push rather than overlapping.
  const blocked = arena('knock2', 'husk', 1);
  const other = new Enemy('husk', blocked.g.rng);
  blocked.g.level.addEnemy(other, blocked.e.x + 1, blocked.e.y);
  blocked.g.player.equipItem(SLOT.MAIN, 'falchion');
  blocked.g.player.stamina = blocked.g.player.staminaMax;
  blocked.e.hp = 99;
  const was = blocked.e.x;
  blocked.g.useSkill('shove', { dx: 1, dy: 0 });
  assert(blocked.e.x === was, 'pushed one enemy through another');
  return 'pushes, and stops when it should';
});

check('a ward eats the next blow whatever direction it came from', () => {
  const g = freshGame('ward', 'light');
  const p = g.player;
  g.prepareFromPack('magic', null);
  p.pack.push('ward');
  assert(g.prepareFromPack('magic', 'ward'), 'could not ready a ward');
  p.stamina = p.staminaMax;
  assert(g.usePrepared('magic', null) === true, 'casting the ward did not spend the turn');

  const hp = p.hp;
  // Unblockable and from behind: the two things a shield cannot answer.
  g.hurtPlayer(6, 'a test', { from: { dx: 0, dy: 1 }, unblockable: true });
  assert(p.hp === hp, 'the ward let an unblockable hit through');
  g.hurtPlayer(3, 'a test', { from: { dx: 0, dy: 1 }, unblockable: true });
  assert(p.hp < hp, 'the ward absorbed a second blow');
  return 'one blow, any direction, shields need not apply';
});

check('blink goes through bodies but not through rock', () => {
  const { g, e } = arena('blink', 'husk', 1);
  const p = g.player;
  g.prepareFromPack('magic', null);
  p.pack.push('blink');
  g.prepareFromPack('magic', 'blink');
  p.stamina = p.staminaMax;

  // The husk is adjacent to the east; blink should pass straight over it.
  const before = p.x;
  const moved = g.usePrepared('magic', { dx: 1, dy: 0 });
  if (moved) {
    assert(p.x > before + 1, `blink only reached ${p.x - before} tiles - it did not pass the body`);
    assert(!g.level.enemyAt(p.x, p.y), 'landed on top of something');
  }
  assert(isWalkable(g.level.at(p.x, p.y)), 'landed inside rock');
  return 'over bodies, never into stone';
});

check('storerooms come from the seed, are guarded, and are not on floor one', () => {
  let floors = 0, stores = 0, guarded = 0, cornered = 0;
  for (let s = 0; s < 8; s++) {
    const g = freshGame(`store:${s}`);
    for (let d = 1; d <= DUNGEON_DEPTH; d++) {
      floors++;
      const lvl = g.levelAt(d);
      if (!lvl.store) continue;
      assert(d > 1, 'floor one has a storeroom; it is the tutorial');
      // populate() returns early on the boss floor, so a chest there would sit
      // unguarded next to the finale.
      assert(d < DUNGEON_DEPTH, 'the boss floor has a storeroom, and nothing is watching it');
      stores++;
      assert(isChest(lvl.at(lvl.store.x, lvl.store.y)), 'the storeroom has no chest in it');
      assert(ITEM_BY_KEY[lvl.store.loot] || CONSUMABLE_BY_KEY[lvl.store.loot],
             `chest holds "${lvl.store.loot}", which is not a thing`);

      // The guard has to be between the chest and the room, and already awake.
      const guards = lvl.enemies.filter((e) => e.guarding);
      if (guards.length) {
        guarded++;
        assert(guards.every((e) => e.aware),
               'a guard has to be woken up, which reads as "more monsters" rather than "a guard"');
        const near = guards.some((e) =>
          Math.max(Math.abs(e.x - lvl.store.x), Math.abs(e.y - lvl.store.y)) <= 1);
        assert(near, 'nothing is actually standing in front of the chest');
      }
      const room = lvl.rooms.find((r) => r.id === lvl.store.room);
      if (room) {
        const corner = (lvl.store.x === room.x || lvl.store.x === room.x + room.w - 1) &&
                       (lvl.store.y === room.y || lvl.store.y === room.y + room.h - 1);
        if (corner) cornered++;
      }
    }
  }
  assert(stores > 0, 'no floor in eight runs had a storeroom');
  assert(guarded === stores, `${stores - guarded} storerooms are unguarded`);
  assert(cornered === stores, 'a chest is not in a corner, so there is no wrong side to come from');
  return `${stores} storerooms over ${floors} floors, all guarded`;
});

check('a chest gives up its contents once per run, and death does not refill it', () => {
  const g = freshGame('chest');
  let depth = 0;
  for (let d = 2; d < DUNGEON_DEPTH; d++) if (g.levelAt(d).store) { depth = d; break; }
  assert(depth, 'this seed has no storeroom to test with');

  g.gotoLevel(depth, 'up');
  const store = g.level.store;
  const p = g.player;
  p.x = store.x; p.y = store.y;

  const before = p.pack.length;
  assert(g.openChest() === true, 'the chest would not open');
  assert(p.pack.length === before + 1, 'opening the chest gave nothing');
  assert(p.pack.includes(store.loot), 'the wrong thing came out');
  assert(p.unbanked.includes(store.loot), 'what came out was already safe');
  assert(!isChest(g.level.at(store.x, store.y)), 'the chest is still there');

  // The floor is rebuilt from its seed on death - the chest must NOT come back.
  g.respawnLevel(depth);
  assert(!isChest(g.levelAt(depth).at(store.x, store.y)),
         'dying refilled a chest you had already emptied');
  return `${store.loot}, once`;
});

check('death drops what you had not banked, and you can go and get it', () => {
  // The Souls loop with items instead of a currency: worn equipment is never
  // touched, only what you have picked up and not yet carried home.
  const g = freshGame('corpse');
  const p = g.player;
  g.gotoLevel(2, 'up');
  const worn = { ...p.equip };
  g.gain('greataxe', 'test');
  g.gain('plate', 'test');
  assert(p.unbanked.length === 2, 'picking things up did not mark them unbanked');

  const died = { depth: p.depth, x: p.x, y: p.y };
  g.hurtPlayer(999, 'a test');

  assert(g.corpse, 'death left no remains');
  assert(g.corpse.items.length === 2, 'the remains are empty');
  assert(!p.pack.includes('greataxe'), 'kept what should have been dropped');
  assert(JSON.stringify(p.equip) === JSON.stringify(worn), 'lost something you were wearing');
  assert(isCorpse(g.levelAt(died.depth).at(died.x, died.y)), 'nothing marks the spot');

  // Walk back and take it.
  g.gotoLevel(died.depth, 'up');
  p.x = died.x; p.y = died.y;
  assert(g.reclaim() === true, 'could not pick your own remains back up');
  assert(p.pack.includes('greataxe') && p.pack.includes('plate'), 'did not get everything back');
  assert(!g.corpse, 'the remains are still there');
  return 'dropped, marked, recovered';
});

check('dying again before you reach it is how things are actually lost', () => {
  const g = freshGame('corpse2');
  const p = g.player;
  g.gotoLevel(2, 'up');
  g.gain('greataxe', 'test');
  g.hurtPlayer(999, 'a test');
  const first = g.corpse;
  assert(first?.items.includes('greataxe'), 'first death dropped nothing');

  g.gain('plate', 'test');
  g.hurtPlayer(999, 'a test');
  assert(g.corpse !== first, 'the second death did not move the remains');
  assert(!g.corpse.items.includes('greataxe'), 'the first pile survived; nothing is ever lost');
  assert(g.corpse.items.includes('plate'), 'the second pile is wrong');
  return 'one pile at a time';
});

check('dying on the square a chest was on still leaves remains you can take', () => {
  // Both the emptied-chest cleanup and the corpse are painted back on after a
  // floor is rebuilt from its seed, and they were writing to the same tile in
  // the wrong order - so a death on top of a looted chest erased the remains
  // and everything on them was gone with no way to get it back.
  const g = freshGame('corpse-on-chest');
  let depth = 0;
  for (let d = 2; d < DUNGEON_DEPTH; d++) if (g.levelAt(d).store) { depth = d; break; }
  assert(depth, 'this seed has no storeroom to test with');

  g.gotoLevel(depth, 'up');
  const store = g.level.store;
  const p = g.player;
  p.x = store.x; p.y = store.y;
  assert(g.openChest(), 'the chest would not open');
  g.gain('greataxe', 'test');

  g.hurtPlayer(999, 'a test');
  assert(g.corpse, 'death on a looted chest left no remains');
  assert(isCorpse(g.levelAt(depth).at(store.x, store.y)),
         'the chest cleanup painted over the remains');

  g.gotoLevel(depth, 'up');
  p.x = store.x; p.y = store.y;
  assert(g.reclaim(), 'could not take the remains back');
  assert(p.pack.includes('greataxe'), 'the remains gave nothing back');
  assert(!isCorpse(g.level.at(store.x, store.y)), 'the remains are still on the map');
  assert(isWalkable(g.level.at(store.x, store.y)), 'the tile underneath was left broken');
  return 'the two writes no longer fight over the same tile';
});

check('sitting at a fire makes what you are carrying safe', () => {
  const g = freshGame('bank');
  const p = g.player;
  g.gain('greataxe', 'test');
  assert(p.unbanked.length === 1, 'nothing was marked unbanked');

  const b = g.level.bonfires[0];
  p.x = b.x; p.y = b.y;
  g.rest();
  assert(p.unbanked.length === 0, 'resting did not bank what you were carrying');

  g.hurtPlayer(999, 'a test');
  assert(!g.corpse, 'dropped something that had already been banked');
  assert(p.pack.includes('greataxe'), 'lost a banked item');
  return 'the walk back is the point';
});

// ===========================================================================
console.log('\n--- projectiles -----------------------------------------------');

check('arrows take turns to arrive, so they can be dodged', () => {
  const { g, e } = arena('arrow', 'archer', 8);
  e.stamina = e.staminaMax;
  observe(g, e, 16, () => g.level.projectiles.length > 0);
  assert(g.level.projectiles.length, 'the archer never fired');
  const p = g.level.projectiles[0];
  const d = Math.max(Math.abs(p.x - g.player.x), Math.abs(p.y - g.player.y));
  assert(d / p.speed >= 1, 'the arrow arrives with no turn to react');
  return `speed ${p.speed}, ${d} tiles out`;
});

check('an arrow fired this turn does not move until the next one', () => {
  // Projectiles step BEFORE enemies act, so anything launched during the enemy
  // phase waits a full turn. Without that a ranged attack is an ambush.
  const { g, e } = arena('order', 'archer', 8);
  e.stamina = e.staminaMax;
  observe(g, e, 16, () => {
    if (!g.level.projectiles.length) return false;
    const p = g.level.projectiles[0];
    assert(Math.max(Math.abs(p.x - e.x), Math.abs(p.y - e.y)) <= 1,
           'the arrow had already travelled on the turn it was fired');
    return true;
  });
  return 'launched arrows wait one turn';
});

check('an arrow hits the first body in its path, enemy or not', () => {
  const g = freshGame('friendly');
  g.level.enemies.length = 0; g.level.markEnemiesDirty();
  const room = [...g.level.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const y = room.y + (room.h >> 1);
  g.player.x = room.x; g.player.y = y;
  const blocker = new Enemy('husk', g.rng);
  g.level.addEnemy(blocker, room.x + 2, y);
  const hp0 = blocker.hp;
  g.level.projectiles.push({
    id: 1, x: room.x, y, dx: 1, dy: 0, speed: 3, damage: 3, impact: 0,
    fromPlayer: false, glyph: '>', colour: '#fff', life: 9, trail: [],
  });
  stepProjectiles(g);
  assert(blocker.hp < hp0, 'the arrow passed straight through another enemy');
  assert(!g.level.projectiles.length, 'the arrow survived hitting something');
  return 'friendly fire falls out of the model, not a special case';
});

// ===========================================================================
console.log('\n--- bonfires, death and the run -------------------------------');

check('resting heals, refills stamina and brings everything back', () => {
  const g = freshGame('rest');
  const b = g.level.bonfires[0];
  g.player.x = b.x; g.player.y = b.y;
  g.player.hp = 1; g.player.stamina = 0;
  const before = g.level.livingEnemies().length;
  for (const e of g.level.enemies) e.alive = false;
  g.level.removeDead();
  assert(g.level.livingEnemies().length === 0, 'precondition: floor cleared');
  g.rest();
  assert(g.player.hp === g.player.hpMax, 'resting did not heal');
  assert(g.player.stamina === g.player.staminaMax, 'resting did not restore stamina');
  assert(g.level.livingEnemies().length === before, 'enemies did not come back');
  return `${before} enemies stood back up`;
});

check('you cannot sit down while something is hunting you', () => {
  // Resting heals, refills stamina, refills charges AND puts every enemy back
  // on its spawn. Without this it is a reset button you can press mid-fight,
  // and the obvious use is to un-stick a bad position rather than recover from
  // one - which is exactly what a speedrun would do with it.
  const g = freshGame('hunted');
  const p = g.player;
  const b = g.level.bonfires[0];
  p.x = b.x; p.y = b.y;
  p.hp = 1;

  const watcher = g.level.livingEnemies()[0];
  assert(watcher, 'this floor has no enemies to be hunted by');
  for (const e of g.level.enemies) e.aware = false;
  watcher.aware = true;

  assert(g.hunters() === 1, 'one aware enemy should count as one hunter');
  // rest() returns whether the turn was spent, not whether it worked - resting
  // does not advance the turn either way - so the effect is what to check.
  g.rest();
  assert(p.hp === 1, 'rested with something hunting');

  // Awareness decays once you are out of sight, so breaking away is the way
  // out - which makes disengaging a skill rather than a formality.
  watcher.aware = false;
  assert(g.hunters() === 0, 'losing awareness did not clear the hunt');
  g.rest();
  assert(p.hp === p.hpMax, 'could not rest with nothing hunting');
  return 'no reset button mid-fight';
});

check('bodies block a diagonal, and a roll is the way through', () => {
  // Until now a pincer could always be stepped out of, which quietly undercut
  // packs, made block - the "nowhere to go" option - almost never correct, and
  // made the falchion's shove a curiosity.
  const { g, e } = arena('pinch', 'husk', 1);
  const lvl = g.level;
  const p = g.player;

  // Two bodies on the cardinals either side of the diagonal we want to take.
  const east = { x: p.x + 1, y: p.y }, south = { x: p.x, y: p.y + 1 };
  if (!lvl.passable(east.x, east.y) || !lvl.passable(south.x, south.y)) return 'no room to set up';
  lvl.enemies.length = 0; lvl.markEnemiesDirty();
  for (const spot of [east, south]) {
    const q = new Enemy('husk', g.rng);
    lvl.addEnemy(q, spot.x, spot.y);
  }

  // Body-blocking is opt-in, and only the player's walk opts in - enemies never
  // see it, because applying it to them paralysed packs entirely.
  assert(!lvl.diagonalOk(p.x, p.y, p.x + 1, p.y + 1, true),
         'walked diagonally out from between two bodies');
  assert(lvl.diagonalOk(p.x, p.y, p.x + 1, p.y + 1),
         'a roll cannot get past bodies either, so being pinched has no answer');

  // Orthogonal movement is untouched: bodies do not corner you, they only stop
  // you cutting between them.
  const free = DIRS.filter((d) => !d.dx || !d.dy)
    .filter((d) => lvl.passable(p.x + d.dx, p.y + d.dy) && !lvl.enemyAt(p.x + d.dx, p.y + d.dy));
  for (const d of free) {
    assert(lvl.diagonalOk(p.x, p.y, p.x + d.dx, p.y + d.dy, true),
           'a body blocked an orthogonal step, which would create dead ends');
  }

  // And terrain is still terrain - a roll tumbles past a hound, not through a
  // doorframe.
  const walls = [];
  for (let y = 1; y < lvl.h - 1 && walls.length < 1; y++) {
    for (let x = 1; x < lvl.w - 1; x++) {
      if (lvl.isDoorway(x, y)) { walls.push({ x, y }); break; }
    }
  }
  for (const w of walls) {
    for (const d of DIRS.filter((q) => q.dx && q.dy)) {
      assert(!lvl.diagonalOk(w.x, w.y, w.x + d.dx, w.y + d.dy),
             'a roll cut a corner through a doorway');
    }
  }
  return 'pinched means pinched until you spend stamina';
});

check('death returns you to the bonfire instead of ending the run', () => {
  const g = freshGame('death');
  const start = { ...g.player.bonfire };
  g.gotoLevel(2, 'up');
  g.player.hp = 1;
  g.hurtPlayer(99, 'a test');
  assert(g.running, 'the run ended on a single death');
  assert(g.player.depth === start.depth, `woke on floor ${g.player.depth}`);
  assert(g.player.x === start.x && g.player.y === start.y, 'did not wake at the bonfire');
  assert(g.player.hp === g.player.hpMax, 'did not wake healed');
  assert(g.player.deaths === 1, 'death was not counted');
  return 'death is a setback, not an ending';
});

check('map memory survives death; enemies do not', () => {
  const g = freshGame('memory');
  for (let i = 0; i < 200; i++) g.level.seen[i] = 1;
  const seenBefore = g.level.seen.reduce((a, b) => a + b, 0);
  for (const e of g.level.enemies) e.alive = false;
  g.level.removeDead();
  g.hurtPlayer(999, 'a test');
  assert(g.level.seen.reduce((a, b) => a + b, 0) >= seenBefore, 'the map you had learned was erased');
  assert(g.level.livingEnemies().length > 0, 'enemies did not respawn');
  return 'you keep what you learned';
});

check('souls are carried, dropped where you die, and picked back up', () => {
  // Same pile as the loot, different payload - which is why the corpse system
  // was worth building first. What souls actually produce is the decision to
  // walk back to the fire; the stat line is the pretext.
  const g = freshGame('souls');
  const p = g.player;
  g.gotoLevel(2, 'up');

  const e = g.level.livingEnemies()[0];
  assert(e, 'no enemy to kill');
  g.hurtEnemy(e, 999, true, 0);
  assert(p.souls > 0, 'killing something paid nothing');
  const carried = p.souls;

  const died = { depth: p.depth, x: p.x, y: p.y };
  g.hurtPlayer(999, 'a test');
  assert(p.souls === 0, 'kept souls through a death');
  assert(g.corpse?.souls === carried, 'the remains do not hold what was carried');

  g.gotoLevel(died.depth, 'up');
  p.x = died.x; p.y = died.y;
  g.reclaim();
  assert(p.souls === carried, 'walking back did not return them');
  return `${carried} souls, lost and recovered`;
});

check('souls buy only what no item owns, and only at a fire', () => {
  const g = freshGame('spend');
  const p = g.player;
  p.souls = 5000;

  // Away from a fire they are just a number you are carrying.
  const room = [...g.level.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  p.x = room.x + 1; p.y = room.y + 1;
  g.buyRank('wind');
  assert(!(p.ranks.wind > 0), 'bought an upgrade away from a bonfire');

  const b = g.level.bonfires[0];
  p.x = b.x; p.y = b.y;
  const st0 = p.staminaMax, roll0 = p.rollCost(), regen0 = p.regenRate(true), hp0 = p.hpMax;
  g.buyRank('wind');
  assert(p.staminaMax > st0, 'the wind track did not raise stamina');

  // Bearing widens the free weight allowance, so the same kit rolls cheaper and
  // recovers faster - growth expressed through the equipment system rather than
  // around it.
  const heavy = freshGame('spend2', 'heavy');
  heavy.player.souls = 5000;
  const hb = heavy.level.bonfires[0];
  heavy.player.x = hb.x; heavy.player.y = hb.y;
  const hr0 = heavy.player.rollCost(), hg0 = heavy.player.regenRate(true);
  for (let i = 0; i < 3; i++) heavy.buyRank('bearing');
  assert(heavy.player.rollCost() < hr0, 'bearing did not make rolling cheaper');
  assert(heavy.player.regenRate(true) > hg0, 'bearing did not speed recovery');

  // And nothing on sale touches what equipment owns.
  assert(p.hpMax === hp0, 'souls bought health, which armour is for');
  for (const t of TRACKS) {
    assert(!/hp|damage|傷害|生命/.test(t.hint), `${t.key} sells something an item should`);
  }
  assert(!TRACKS.some((t) => /flask|瓶/.test(t.hint)),
         'flask charges are for sale, which shifts the whole difficulty curve');
  return `${TRACKS.length} tracks, none competing with the pool`;
});

check('a run must be winnable with zero upgrades', () => {
  // The guarantee that keeps grinding pointless: souls can make you stronger
  // but can never unlock progress, so running out is a harder run and never a
  // soft lock. Enemies respawn at fires, so any required currency would make
  // farming optimal rather than merely possible.
  const g = freshGame('nobuy');
  assert(Object.keys(g.player.ranks).length === 0, 'a run starts with ranks already bought');
  g.gotoLevel(DUNGEON_DEPTH, 'up');
  const boss = g.level.enemies.find((e) => e.spec.boss);
  assert(boss, 'no boss to kill');
  g.hurtEnemy(boss, 9999, true, 0);
  assert(!g.running && g.gameOver.how === 'won', 'the boss could not be beaten unupgraded');
  return 'nothing on the way down is gated behind souls';
});

check('one elite a floor, carrying something, once per run', () => {
  // "The floor boss drops something fixed" needed floor bosses to exist: the
  // only boss is on the last floor and killing it ends the run. This does the
  // job the idea was for - guaranteeing a run actually meets the equipment
  // pool, which matters here because weapons carry the skills.
  let floors = 0, elites = 0;
  for (let s = 0; s < 5; s++) {
    const g = freshGame(`elite:${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      const found = g.levelAt(d).enemies.filter((e) => e.elite);
      assert(found.length <= 1, `floor ${d} has ${found.length} elites`);
      if (d >= 3) floors++;
      if (!found.length) continue;
      elites++;
      const e = found[0];
      assert(d >= 3, 'an elite on a tutorial floor');
      assert(ITEM_BY_KEY[e.drop] || CONSUMABLE_BY_KEY[e.drop], `elite carries "${e.drop}"`);
      assert(e.hpMax > ENEMY_BY_KEY[e.key].hp, 'an elite is not tougher than its species');
    }
  }
  assert(elites >= floors * 0.9, `only ${elites} elites across ${floors} eligible floors`);

  // The prize comes from the seed, not from the kill, so resting does not refill it.
  const g = freshGame('elite:drop');
  g.gotoLevel(4, 'up');
  const e = g.level.enemies.find((q) => q.elite);
  if (e) {
    const drop = e.drop;
    g.hurtEnemy(e, 9999, true, 0);
    assert(g.player.pack.includes(drop), 'the elite gave nothing');
    const again = g.respawnLevel(4).enemies.find((q) => q.elite);
    if (again) {
      const had = g.player.pack.filter((k) => k === drop).length;
      g.hurtEnemy(again, 9999, true, 0);
      assert(g.player.pack.filter((k) => k === drop).length === had,
             'killing the respawned elite paid out again - that is farmable');
    }
  }
  return `${elites} elites over ${floors} floors`;
});

check('killing the boss wins the run', () => {
  const g = freshGame('boss');
  g.gotoLevel(DUNGEON_DEPTH, 'up');
  const boss = g.level.enemies.find((e) => e.spec.boss);
  assert(boss, 'no boss on the bottom floor');
  g.hurtEnemy(boss, 9999, true, 0);
  assert(!g.running, 'the run did not end');
  assert(g.gameOver.how === 'won', `ended as ${g.gameOver.how}`);
  return `beat ${boss.name}`;
});

check('save and load round-trip a run', () => {
  const g = freshGame('save');
  g.gotoLevel(3, 'up');
  g.player.hp = 7; g.player.stamina = 11; g.player.deaths = 2;
  for (let i = 0; i < 300; i++) g.level.seen[i] = 1;
  const seen = g.level.seen.reduce((a, b) => a + b, 0);
  assert(saveGame(g), 'save returned false');

  const g2 = new Game(null); g2.ui = new QuietUI();
  assert(loadGame(g2), 'load returned false');
  assert(g2.seed === g.seed, 'seed differs');
  assert(g2.player.depth === 3, 'depth differs');
  assert(g2.player.hp === 7 && g2.player.stamina === 11, 'player stats differ');
  assert(g2.player.deaths === 2, 'deaths differ');
  assert(g2.level.tiles.join() === g.level.tiles.join(), 'terrain differs');
  assert(g2.level.seen.reduce((a, b) => a + b, 0) === seen, 'map memory differs');
  const bytes = store.get('claudesouls.save.v2').length;
  assert(bytes < 300000, `save is ${bytes} bytes`);
  return `${(bytes / 1024).toFixed(1)} KB`;
});

check('claudeSouls does not share a save key with claudeHack', () => {
  const g = freshGame('keys');
  saveGame(g);
  assert(store.has('claudesouls.save.v2'), 'wrong key');
  assert(!store.has('claudehack.save.v1'), "wrote into claudeHack's save slot");
  return 'claudesouls.save.v2';
});

// ===========================================================================
console.log('\n--- content ---------------------------------------------------');

check('what you wear is what you are drawn as', () => {
  // Pins the consequence, not the getter. The bug was that the sprite was
  // chosen once during newGame from the starting kit, so a run that changed
  // armour - the entire point of the loadout system - kept the silhouette it
  // started in. A test on `get sprite` would have passed against a stored
  // field set in the right place too; this one cannot.
  const g = freshGame('sprite-seed');
  const seen = new Set();
  for (const a of ITEMS.filter((i) => i.kind === 'armour')) {
    g.player.equip.armour = a.key;
    assert(g.player.sprite === a.sprite,
           `wearing ${a.name} draws ${g.player.sprite}, not ${a.sprite}`);
    seen.add(g.player.sprite);
  }
  // and they must actually differ, or the getter is right and the art is not
  assert(seen.size === 5, `5 armours share only ${seen.size} sprites`);
  return `${seen.size} armours, ${seen.size} silhouettes`;
});

check('every sprite the game can ask for exists on disk', () => {
  // The other half: the getter can be perfect and still name a file that was
  // never exported, which fails silently as an invisible player.
  const dir = new URL('../../assets/', import.meta.url);
  const wanted = new Set(ITEMS.filter((i) => i.kind === 'armour').map((i) => i.sprite));
  for (const spec of ENEMIES) if (spec.sprite) wanted.add(spec.sprite);
  const missing = [...wanted].filter((n) => !existsSync(new URL(`${n}.png`, dir)));
  assert(missing.length === 0, `no artwork for: ${missing.join(', ')}`);
  return `${wanted.size} sprites, all present`;
});

check('every overlay closes by its own close button, not by position', () => {
  // Reported from play: after the help screen grew a texture picker, Close
  // stopped working. showText bound `querySelector('button')` - "the first
  // button in the overlay" - which was only ever the close button while the
  // body was inert text. Adding interactive content silently stole the
  // binding, and the first picker button became the close button instead.
  const src = readFileSync(new URL('../js/ui/ui.js', import.meta.url), 'utf8');

  assert(!/querySelector\('button'\)/.test(src.replace(/\/\/.*$/gm, '')),
         'an overlay still finds its close button by position');

  // Every screen that draws a Close button must also bind that exact button.
  const closes = (src.match(/data-act="close"/g) ?? []).length;
  const binds = (src.match(/\[data-act="close"\]/g) ?? []).length;
  assert(binds >= 1, 'nothing binds a close button by name');
  assert(closes >= binds, 'more close bindings than close buttons');
  return `${binds} screens close by name`;
});

check('every surface offered is a surface that exists', () => {
  // A settings screen that lists a look the stylesheet does not define is a
  // button that silently does nothing, which is the same class of bug as a
  // context button that refuses without saying why.
  const css = readFileSync(new URL('../css/texture.css', import.meta.url), 'utf8');
  for (const t of TEXTURES) {
    assert(t.name && t.hint, `${t.key} has no name or description`);
    if (t.key === 'none') {
      // `body.tex-none`, not `.tex-none` - the stylesheet has a comment saying
      // this class does not exist, and matching the prose instead of the rule
      // is how a test ends up asserting against its own documentation.
      assert(!css.includes('body.tex-none'),
             'a "none" class exists; the absence of a class is meant to BE the setting');
      continue;
    }
    assert(css.includes(`body.tex-${t.key}`), `${t.key} is offered but never defined`);
  }

  // And nothing defined is left unreachable from the picker.
  const defined = [...css.matchAll(/body\.tex-([a-z]+)/g)].map((m) => m[1]);
  for (const key of new Set(defined)) {
    assert(TEXTURE_KEYS.includes(key), `.tex-${key} exists but nothing offers it`);
  }

  // The board itself must never wear one: a texture under the map competes with
  // the telegraphs, which is the one thing this interface must not do.
  assert(!/#map\s*[,{]/.test(css.split('where it goes')[1] ?? ''),
         'the map canvas is in the list of textured surfaces');
  return `${TEXTURES.length} surfaces, all defined`;
});

check('every enemy can be built and fought', () => {
  for (const spec of ENEMIES) {
    const { g, e } = arena(`fight:${spec.key}`, spec.key, 2);
    observe(g, e, 40, () => false);
  }
  return `${ENEMIES.length} species x 40 turns`;
});

check('every skill can be used in every direction', () => {
  // Every skill in the game, not just the ones the starting kit holds - each is
  // reached by equipping whatever grants it, which also proves every weapon in
  // the table can actually be wielded.
  for (const s of SKILLS) {
    const owner = s.always || s.needsShield
      ? null : ITEMS.find((i) => i.primary === s.key || i.secondary === s.key);
    assert(s.always || s.needsShield || owner, `no weapon grants ${s.key}`);
    for (const d of DIRS) {
      const { g } = arena(`skill:${s.key}:${d.key}`, 'husk', 2);
      if (owner) {
        g.player.equipItem(SLOT.MAIN, owner.key);
        assert(g.player.hasSkill(s.key), `${owner.key} in the main hand does not grant ${s.key}`);
      }
      if (s.needsShield) {
        g.player.equipItem(SLOT.OFF, 'buckler');
        assert(g.player.hasSkill(s.key), `a shield does not grant ${s.key}`);
      }
      g.player.stamina = g.player.staminaMax;
      g.player.skill(s.key).cd = 0;
      g.useSkill(s.key, { dx: d.dx, dy: d.dy });
    }
  }
  return `${SKILLS.length} skills x 8 directions`;
});

check('the boss is only on the bottom floor', () => {
  for (let s = 0; s < 6; s++) {
    const g = freshGame(`nb:${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      assert(!g.levelAt(d).enemies.some((e) => e.spec.boss), `boss found on floor ${d}`);
    }
    assert(g.levelAt(DUNGEON_DEPTH).enemies.some((e) => e.spec.boss), 'no boss on the last floor');
  }
  return '6 runs checked';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (failed.length) console.log('failed: ' + failed.join(', '));
process.exit(fail ? 1 : 0);
