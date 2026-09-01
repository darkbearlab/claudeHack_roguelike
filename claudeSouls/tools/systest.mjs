// System tests.
//
// A deterministic combat system is far more testable than claudeHack's was:
// with no to-hit rolls and no damage dice, "the brute's overhead lands on turn
// N and covers these three tiles" is an *assertion*, not a distribution. Most
// of what follows checks the read-and-react contract directly, because that
// contract is the game - if it can be broken, everything else is decoration.
//
//   node tools/systest.mjs

import { Game, DUNGEON_DEPTH } from '../js/game/game.js';
import { RNG } from '../../engine/rng.js';
import { generateLevel } from '../js/map/mapgen.js';
import { T, isWalkable } from '../js/map/tiles.js';
import { Enemy, STATE } from '../js/game/actors.js';
import { ENEMIES, ENEMY_BY_KEY } from '../js/data/enemies.js';
import { SKILLS, SKILL_BY_KEY, PLAYER } from '../js/data/skills.js';
import { attackTiles, snapDir, PATTERNS } from '../js/game/patterns.js';
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

/** Put the player and one enemy on adjacent clear floor, with nothing else. */
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

check('a floor is the same floor every time it is rebuilt', () => {
  const g = freshGame('stable');
  const before = g.levelAt(3).tiles.join();
  const enemiesBefore = g.levelAt(3).enemies.map((e) => `${e.key}@${e.x},${e.y}`).join('|');
  g.respawnLevel(3);
  const after = g.levelAt(3).tiles.join();
  const enemiesAfter = g.levelAt(3).enemies.map((e) => `${e.key}@${e.x},${e.y}`).join('|');
  assert(before === after, 'terrain changed after respawn');
  assert(enemiesBefore === enemiesAfter, 'enemy placement changed after respawn');
  assert(enemiesAfter.length > 0, 'floor 3 has no enemies');
  return 'terrain and enemies both stable';
});

check('every floor has something slow and something fast on it', () => {
  // Both halves of "can I walk away from this" must exist, or running past
  // stops being a decision and the walk back from a bonfire is a punishment.
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
console.log('\n--- patterns and facing ---------------------------------------');

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
  // 'front' must always be exactly the one tile you are facing.
  for (const d of DIRS) {
    const [t] = attackTiles(5, 5, d.dx, d.dy, 'front');
    assert(t.x === 5 + d.dx && t.y === 5 + d.dy, `front facing ${d.name} is wrong tile`);
  }
  return `${Object.keys(PATTERNS).length} patterns x 8 facings`;
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
  // The single most important rule in the game.
  const { g } = arena('roll', 'husk', 6);
  const t0 = g.turn, s0 = g.player.stamina;
  const spent = g.useSkill('roll', { dx: 0, dy: -1 });
  assert(spent === false, 'roll reported that it advanced the turn');
  assert(g.turn === t0, `turn advanced from ${t0} to ${g.turn}`);
  assert(g.player.stamina === s0 - g.player.rollCost(),
         `stamina ${s0} -> ${g.player.stamina}, expected -${g.player.rollCost()}`);
  return `free turn, -${g.player.rollCost()} stamina`;
});

check('attacking advances the turn and costs stamina', () => {
  const { g } = arena('atk', 'husk', 1);
  const t0 = g.turn, s0 = g.player.stamina;
  const spent = g.useSkill('strike', { dx: 1, dy: 0 });
  assert(spent === true, 'strike did not advance the turn');
  g.worldTurn();
  assert(g.turn === t0 + 1, 'turn did not advance');
  assert(g.player.stamina < s0 + g.player.staminaRegen, 'strike was free');
  return 'costs stamina, spends the turn';
});

check('the two vows are a real trade, not a strictly better option', () => {
  const light = freshGame('v1', 'light').player;
  const heavy = freshGame('v2', 'heavy').player;
  const lRolls = Math.floor(light.staminaMax / light.rollCost());
  const hRolls = Math.floor(heavy.staminaMax / heavy.rollCost());
  assert(lRolls >= 5, `light gets only ${lRolls} rolls`);
  assert(hRolls >= 2 && hRolls <= 3, `heavy gets ${hRolls} rolls, wanted 2-3`);
  assert(heavy.hpMax > light.hpMax, 'heavy is not tougher');

  // Total ground a full bar can cover. Heavy must give up real mobility, or
  // its damage reduction makes it dominant - which is what a bot playing both
  // vows measured before roll distance was halved for heavy.
  const lGround = lRolls * light.rollDistance();
  const hGround = hRolls * heavy.rollDistance();
  assert(hGround * 2 <= lGround,
         `heavy covers ${hGround} tiles a bar vs light's ${lGround} - not enough of a trade`);
  return `light ${lGround} tiles/bar & ${light.hpMax} hp, heavy ${hGround} & ${heavy.hpMax}`;
});

check('stamina regen is just under one light roll', () => {
  // The number the whole rhythm hangs on: you cannot dodge every single turn.
  assert(PLAYER.staminaRegen < SKILL_BY_KEY.roll.stamina,
         `regen ${PLAYER.staminaRegen} >= roll ${SKILL_BY_KEY.roll.stamina} - dodging would be free`);
  assert(PLAYER.staminaRegen * 2 >= SKILL_BY_KEY.roll.stamina,
         'regen so low that dodging every other turn is impossible');
  return `${PLAYER.staminaRegen}/turn vs ${SKILL_BY_KEY.roll.stamina} per roll`;
});

check('an enemy telegraphs before it strikes, and never strikes early', () => {
  for (const spec of ENEMIES) {
    for (const a of spec.attacks) {
      assert(a.windup >= 1, `${spec.key}/${a.name} has no wind-up`);
      assert(a.recovery >= 1, `${spec.key}/${a.name} has no recovery`);
    }
    // Melee only. A ranged attack legitimately damages you turns after the
    // archer has finished recovering, because the thing that hits you is the
    // arrow, not the archer - that path is covered by the projectile tests.
    if (spec.attacks.some((a) => a.kind === 'ranged')) continue;

    const { g, e } = arena(`tel:${spec.key}`, spec.key, 1);
    e.stamina = e.staminaMax;
    const hp0 = g.player.hp;
    for (let t = 0; t < 14; t++) {
      const before = e.state;
      g.worldTurn();
      if (g.player.hp < hp0) {
        assert(before === STATE.WINDUP,
               `${spec.key} dealt damage from state "${before}" - no telegraph`);
        break;
      }
      if (!e.alive) break;
    }
  }
  const melee = ENEMIES.filter((s) => !s.attacks.some((a) => a.kind === 'ranged')).length;
  return `${melee} melee species: damage only ever follows a wind-up`;
});

check('the tiles shown during a wind-up are the tiles that get hit', () => {
  // If these two could disagree the whole read-and-react contract is a lie.
  const { g, e } = arena('promise', 'brute', 1);
  e.stamina = e.staminaMax;
  let promised = null;
  for (let t = 0; t < 10; t++) {
    g.worldTurn();
    if (e.state === STATE.WINDUP && !promised) promised = e.attackTiles.map((q) => `${q.x},${q.y}`).sort().join('|');
    if (promised && e.state === STATE.RECOVER) break;
    // The promise must never change once made.
    if (promised && e.state === STATE.WINDUP) {
      const now = e.attackTiles.map((q) => `${q.x},${q.y}`).sort().join('|');
      assert(now === promised, 'the telegraph moved after it was shown');
    }
  }
  assert(promised, 'the brute never wound up');
  return 'telegraph is immutable once shown';
});

check('hitting an enemy mid-wind-up delays the blow', () => {
  const { g, e } = arena('stagger', 'brute', 1);
  e.stamina = e.staminaMax;
  for (let t = 0; t < 8 && e.state !== STATE.WINDUP; t++) g.worldTurn();
  assert(e.state === STATE.WINDUP, 'never reached wind-up');
  const before = e.timer;
  e.stagger();
  assert(e.timer === before + 1, `timer ${before} -> ${e.timer}, expected +1`);
  return 'interrupt pushes the attack back a turn';
});

check('sustained aggression exhausts an enemy', () => {
  // Enemy stamina has to actually bind on something or it is a dead system.
  // What it buys is not usually the "winded" state - it is that an enemy which
  // keeps swinging can no longer *afford its good attack*, and degrades to
  // cheap pokes. That is the reward for keeping the pressure on.
  const { g, e } = arena('winded', 'brute', 1);
  const dearest = Math.max(...e.spec.attacks.map((a) => a.cost));
  let minStamina = 99, forcedDown = false, usedCheap = false;
  for (let t = 0; t < 60 && e.alive && g.running; t++) {
    g.player.hp = g.player.hpMax;
    g.worldTurn();
    minStamina = Math.min(minStamina, e.stamina);
    if (e.stamina < dearest) forcedDown = true;
    if (e.state === STATE.WINDUP && e.attack && e.attack.cost < dearest) usedCheap = true;
  }
  assert(minStamina >= 0, `stamina went to ${minStamina}`);
  assert(forcedDown, 'the brute could always afford its heaviest attack');
  assert(usedCheap, 'the brute never fell back to a cheaper attack');

  // And an enemy whose cheapest attack costs more than it regenerates does
  // eventually have to stop entirely.
  const h = arena('winded2', 'husk', 1);
  let sawResting = false;
  for (let t = 0; t < 120 && h.e.alive && h.g.running; t++) {
    h.g.player.hp = h.g.player.hpMax;
    h.g.worldTurn();
    if (h.e.state === STATE.RESTING) { sawResting = true; break; }
  }
  assert(sawResting, 'the husk never had to stop and breathe');
  return 'heavy attacks price themselves out; cheap attackers eventually stall';
});

check('a kill refunds a turn of every cooldown', () => {
  const { g, e } = arena('combo', 'hound', 1);
  const slot = g.player.skill('sweep');
  slot.cd = 3;
  e.hp = 1;
  g.useSkill('strike', { dx: 1, dy: 0 });
  assert(!e.alive, 'the hound survived a strike at 1 hp');
  assert(slot.cd === 2, `cooldown ${slot.cd}, expected 2`);
  return 'kill -> cooldowns tick';
});

// ===========================================================================
console.log('\n--- projectiles -----------------------------------------------');

check('arrows take turns to arrive, so they can be dodged', () => {
  const { g, e } = arena('arrow', 'archer', 8);
  e.stamina = e.staminaMax;
  let fired = -1;
  for (let t = 0; t < 14; t++) {
    g.worldTurn();
    if (g.level.projectiles.length) { fired = t; break; }
  }
  assert(fired >= 0, 'the archer never fired');
  const p = g.level.projectiles[0];
  const distance = Math.max(Math.abs(p.x - g.player.x), Math.abs(p.y - g.player.y));
  assert(distance / p.speed >= 1, 'the arrow arrives with no turn to react');
  return `speed ${p.speed}, ${distance} tiles out`;
});

check('an arrow fired this turn does not move until the next one', () => {
  // Order of resolution: projectiles move BEFORE enemies act, so anything
  // launched during the enemy phase waits a full turn. Without that a ranged
  // attack is an ambush rather than a telegraph.
  const { g, e } = arena('order', 'archer', 8);
  e.stamina = e.staminaMax;
  for (let t = 0; t < 14; t++) {
    g.worldTurn();
    if (g.level.projectiles.length) {
      const p = g.level.projectiles[0];
      assert(Math.max(Math.abs(p.x - e.x), Math.abs(p.y - e.y)) <= 1,
             'the arrow had already travelled on the turn it was fired');
      break;
    }
  }
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
    id: 1, x: room.x, y, dx: 1, dy: 0, speed: 3, damage: 3,
    fromPlayer: false, glyph: '→', colour: '#fff', life: 9, trail: [],
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
  g.player.x = start.x + 5; g.player.y = start.y;
  g.gotoLevel(2, 'up');
  g.player.hp = 1;
  g.hurtPlayer(99, 'a test');
  assert(g.running, 'the run ended on a single death');
  assert(g.player.depth === start.depth, `woke on floor ${g.player.depth}, expected ${start.depth}`);
  assert(g.player.x === start.x && g.player.y === start.y, 'did not wake at the bonfire');
  assert(g.player.hp === g.player.hpMax, 'did not wake healed');
  assert(g.player.deaths === 1, 'death was not counted');
  return 'death is a setback, not an ending';
});

check('map memory survives death; enemies do not', () => {
  const g = freshGame('memory');
  const lvl = g.level;
  for (let i = 0; i < 200; i++) lvl.seen[i] = 1;
  const seenBefore = lvl.seen.reduce((a, b) => a + b, 0);
  for (const e of lvl.enemies) e.alive = false;
  lvl.removeDead();
  g.hurtPlayer(999, 'a test');
  const after = g.level;
  assert(after.seen.reduce((a, b) => a + b, 0) >= seenBefore, 'the map you had learned was erased');
  assert(after.livingEnemies().length > 0, 'enemies did not respawn');
  return 'you keep what you learned';
});

check('killing the boss wins the run', () => {
  const g = freshGame('boss');
  g.gotoLevel(DUNGEON_DEPTH, 'up');
  const boss = g.level.enemies.find((e) => e.spec.boss);
  assert(boss, 'no boss on the bottom floor');
  g.hurtEnemy(boss, 9999, true);
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
  const bytes = store.get('claudesouls.save.v1').length;
  assert(bytes < 300000, `save is ${bytes} bytes`);
  return `${(bytes / 1024).toFixed(1)} KB`;
});

check('claudeSouls does not share a save key with claudeHack', () => {
  // Both games live on one origin. A shared key would silently eat a run, and
  // only for players who tried both.
  const g = freshGame('keys');
  saveGame(g);
  assert(store.has('claudesouls.save.v1'), 'wrong key');
  assert(!store.has('claudehack.save.v1'), 'wrote into claudeHack\'s save slot');
  return 'claudesouls.save.v1';
});

// ===========================================================================
console.log('\n--- content ---------------------------------------------------');

check('every enemy can be built and fought', () => {
  for (const spec of ENEMIES) {
    const { g, e } = arena(`fight:${spec.key}`, spec.key, 2);
    for (let t = 0; t < 30 && e.alive && g.running; t++) {
      g.player.hp = g.player.hpMax;      // survive long enough to observe it
      g.player.stamina = g.player.staminaMax;
      g.worldTurn();
    }
  }
  return `${ENEMIES.length} species x30 turns`;
});

check('every skill can be used in every direction', () => {
  for (const s of SKILLS) {
    for (const d of DIRS) {
      const { g } = arena(`skill:${s.key}:${d.key}`, 'husk', 2);
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
