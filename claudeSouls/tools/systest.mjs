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
import { T } from '../js/map/tiles.js';
import { Enemy, STATE } from '../js/game/actors.js';
import { ENEMIES, ENEMY_BY_KEY } from '../js/data/enemies.js';
import { SKILLS, SKILL_BY_KEY, PLAYER } from '../js/data/skills.js';
import { ITEMS, ITEM_BY_KEY, SLOT, skillsFrom, STARTING_KIT,
         CONSUMABLES, CONSUMABLE_BY_KEY } from '../js/data/items.js';
import { attackTiles, snapDir, PATTERNS, spriteRotation, blocksDirection } from '../js/game/patterns.js';
import { ART_FACING } from '../js/data/sprites.js';
import { saveGame, loadGame } from '../js/game/save.js';
import { stepProjectiles } from '../js/game/projectile.js';
import { DIRS } from '../../engine/util.js';

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

check('telegraphed attacks always telegraph; silent ones stay cheap', () => {
  // Not everything telegraphs any more - fast, weak enemies simply hit, which
  // is what stops "back off one tile and poke the slow one" from being free.
  // But whether an attack telegraphs is a fixed property of that attack, never
  // a dice roll: an enemy that sometimes warns you cannot be learned, and that
  // is unfair rather than difficult.
  let silent = 0, loud = 0;
  for (const spec of ENEMIES) {
    for (const a of spec.attacks) {
      assert(a.recovery >= 1, `${spec.key}/${a.name} has no recovery`);
      if (a.windup === 0) {
        silent++;
        assert(a.damage <= 2,
               `${spec.key}/${a.name} deals ${a.damage} unannounced - silent damage must stay cheap`);
      } else {
        loud++;
        assert(a.windup >= 1, `${spec.key}/${a.name} has a broken wind-up`);
      }
    }
  }
  assert(silent > 0 && loud > 0, 'the roster needs both kinds');

  // A purely telegraphed melee species must never damage from another state.
  for (const spec of ENEMIES) {
    if (spec.attacks.some((a) => a.kind === 'ranged' || a.windup === 0)) continue;
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
  return `${loud} telegraphed, ${silent} silent (all <= 2 damage)`;
});

check('the tiles shown during a wind-up are the tiles that get hit', () => {
  const { g, e } = arena('promise', 'sentinel', 2);
  e.stamina = e.staminaMax;
  let promised = null;
  observe(g, e, 20, () => {
    if (e.state === STATE.WINDUP) {
      const now = e.attackTiles.map((q) => `${q.x},${q.y}`).sort().join('|');
      if (!promised) promised = now;
      else assert(now === promised, 'the telegraph moved after it was shown');
    }
    return !!promised && e.state === STATE.RECOVER;
  });
  assert(promised, 'the sentinel never wound up');
  return 'telegraph is immutable once shown';
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

check('a silent attacker is rate-limited by its own recovery', () => {
  // The other half of the bargain. A cheap fast attacker is NOT bounded by
  // stamina - it regenerates faster than it spends - so the only thing holding
  // its damage down is that it has to recover between blows. That makes this
  // the load-bearing guarantee for every untelegraphed attack in the game.
  //
  // It is also a direct regression test for a scheduler bug: enemies used to
  // gain energy while winding up and recovering, so a hound banked its entire
  // idle time and spent it in a burst afterwards - three tiles of movement in
  // one turn, which made disengaging impossible and its chip damage
  // unavoidable. It looked exactly like the bestiary being over-tuned.
  const rows = [];
  for (const spec of ENEMIES) {
    const silent = spec.attacks.filter((a) => a.windup === 0 && a.kind !== 'ranged');
    if (!silent.length) continue;
    const { g, e } = arena(`rate:${spec.key}`, spec.key, 1);
    e.stamina = e.staminaMax;

    const TURNS = 200;
    let blows = 0, hops = 0, prev = e.state;
    observe(g, e, TURNS, () => {
      const bx = e.x, by = e.y;
      if (prev !== STATE.RECOVER && e.state === STATE.RECOVER) blows++;
      prev = e.state;
      hops = Math.max(hops, Math.max(Math.abs(e.x - bx), Math.abs(e.y - by)));
      return false;
    });

    const best = Math.min(...silent.map((a) => a.recovery));
    const ceiling = TURNS / (best + 1);
    assert(blows <= ceiling + 1,
           `${spec.key} landed ${blows} silent blows in ${TURNS} turns, above its own ` +
           `recovery ceiling of ${ceiling.toFixed(0)} - it is banking turns somewhere`);
    const dps = (blows * Math.max(...silent.map((a) => a.damage))) / TURNS;
    assert(dps <= 1,
           `${spec.key} chips ${dps.toFixed(2)} damage a turn with no telegraph to read`);
    rows.push(`${spec.key} ${dps.toFixed(2)}/turn`);
  }
  assert(rows.length >= 3, 'expected several silent attackers to check');
  return rows.join(', ');
});

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
  assert(before - g.player.hp === 3, `mail took ${before - g.player.hp} from a 4 damage hit`);
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

  // Bonfires refill; picking things up does not.
  g.player.x = g.level.bonfires[0].x; g.player.y = g.level.bonfires[0].y;
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
    assert(c.heal || c.damage || c.pattern || c.projectile, `${c.key} does nothing at all`);
    if (c.directional) assert(c.pattern || c.projectile, `${c.key} is aimed but has no shape`);
  }
  return `${CONSUMABLES.length} consumables`;
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
