// A bot that actually tries to win.
//
// The random fuzzer in smoketest.mjs is a crash test and never leaves dungeon
// level 1, which means most of the game - deep level generation, shops, the
// Sanctum, the Amulet, the win condition - was never being executed at all.
// This plays with a simple greedy policy instead: heal when hurt, eat when
// weak, kill what is adjacent, otherwise walk towards the down staircase or
// towards whatever is still unexplored.
//
//   node tools/botrun.mjs [runs] [maxTurns]
//
// It is not a good player. It is a player good enough to reach the bottom
// sometimes, which is all that is needed to prove the whole game runs.

import { Game } from '../js/game/game.js';
import { RNG } from '../../engine/rng.js';
import { ROLES } from '../js/data/roles.js';
import { flowField, stepAlong, astar } from '../../engine/path.js';
import { T, isDown, isUp, isWalkable } from '../js/map/tiles.js';
import { objBase } from '../js/game/obj.js';
import { DIRS, dist } from '../../engine/util.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

class BotUI {
  constructor(rng) { this.rng = rng; this.intent = null; this.messages = []; }
  pushMessage(t) { this.messages.push(t); if (this.messages.length > 60) this.messages.shift(); }
  render() {}
  animateTrail() {}
  sleep() { return Promise.resolve(); }
  async yesno(q) {
    // Say no to attacking peacefuls and to choking; yes to the rest.
    if (/Really attack/.test(q)) return false;
    if (/hard time getting all of it down/.test(q)) return false;
    if (/Kick it/.test(q)) return true;
    return true;
  }
  async getKey() { return 'Escape'; }
  async getDirection() { return this.intent?.dir ?? { dx: 0, dy: 0 }; }
  async getText() { return 'Elbereth'; }
  async pickItem(_p, entries) {
    const real = entries.filter((e) => !e.header && e.obj);
    if (!real.length) return null;
    if (this.intent?.match) {
      const hit = real.find((e) => this.intent.match(e.obj, e.label));
      if (hit) return hit.obj;
      return null;
    }
    return null;
  }
  async pickMany(_p, entries) {
    const real = entries.filter((e) => !e.header && e.obj);
    return real.map((e) => e.obj);          // pick up everything
  }
  async showMenu(_t, entries, opts) {
    if (opts?.multi) return [];
    return this.pickItem(_t, entries);
  }
  async pickPosition() { return null; }
  async showText() {}
  async showTerrain() {}
  async showHelp() {}
  showGameOver() {}
  showSaved() {}
}

const isHealingPotion = (o) => o.cls === 'potion' && /healing/.test(o.key);
const isFood = (o) => o.cls === 'food' && !o.corpseOf;

function hostileAdjacent(game) {
  const p = game.player;
  const out = [];
  for (const d of DIRS) {
    const m = game.level.monsterAt(p.x + d.dx, p.y + d.dy);
    if (m && m.alive && !m.peaceful) out.push({ m, d });
  }
  return out;
}

function keyFor(dx, dy) {
  return DIRS.find((d) => d.dx === dx && d.dy === dy)?.key ?? null;
}

/**
 * A step is only usable if it will actually be taken. Walking into a peaceful
 * monster raises a confirmation the bot answers "no" to, which spends no turn -
 * so a path through a shopkeeper span-locks the run at zero turns per command.
 */
function stepUsable(game, x, y) {
  const m = game.level.monsterAt(x, y);
  return !(m && m.alive && m.peaceful);
}

/**
 * One decision. Returns the key to press.
 *
 * `blocked` holds keys that were just refused - the game declined the command
 * and no turn passed. Without it the bot loops forever on any legitimate
 * refusal; the one that actually happened was pressing W to wear body armour
 * while wearing a cloak, which the game rightly rejects every single time.
 * A general guard is better than a special case for each refusal the game can
 * produce, because there are many and the bot cannot know them all.
 */
function decide(game, ui, rng, blocked) {
  const p = game.player;
  const lvl = game.level;
  const use = (key) => (blocked.has(key) ? null : key);

  // 1. Emergency healing.
  if (p.hp < p.hpMax * 0.35 && !blocked.has('q')) {
    const pot = p.inventory.find(isHealingPotion);
    if (pot) { ui.intent = { match: (o) => o === pot }; return 'q'; }
  }
  // 2. Do not starve.
  if (p.nutrition < 60 && !blocked.has('e')) {
    const food = p.inventory.find(isFood) || p.inventory.find((o) => o.cls === 'food');
    if (food) { ui.intent = { match: (o) => o === food }; return 'e'; }
  }
  // 3. Kill what is next to you.
  const adj = hostileAdjacent(game);
  if (adj.length) {
    // Never melee a floating eye; that is the one rule the bot must know.
    const safe = adj.filter((a) => a.m.specKey !== 'floating eye');
    const pick = safe.length ? safe[0] : null;
    if (pick) return pick.d.key;
  }
  // 4. Wear armour that is lying unused, once, early. Body armour cannot go on
  //     over a cloak, so do not even try while one is worn.
  if (!p.equip.body && !p.equip.cloak && !blocked.has('W') &&
      p.inventory.some((o) => o.cls === 'armor' && objBase(o)?.slot === 'body' && !o.worn)) {
    ui.intent = { match: (o) => o.cls === 'armor' && objBase(o)?.slot === 'body' && !o.worn };
    return 'W';
  }
  // 5. Pick up what is underfoot.
  if (lvl.itemsAt(p.x, p.y).length && p.encumbrance() < 2 && !blocked.has(',')) {
    ui.intent = null; return ',';
  }

  // --- carrying the Amulet: the run is now about getting out ----------------
  if (p.hasAmulet) {
    if (isUp(lvl.at(p.x, p.y)) && !blocked.has('<')) return '<';
    if (lvl.upStair) {
      const path = astar(lvl, p.x, p.y, lvl.upStair.x, lvl.upStair.y, { maxNodes: 6000 });
      if (path?.length && stepUsable(game, path[0].x, path[0].y)) {
        const k = keyFor(path[0].x - p.x, path[0].y - p.y);
        if (k) return k;
      }
    }
  }

  // 6. On the stairs: take them.
  if (isDown(lvl.at(p.x, p.y)) && !blocked.has('>')) return '>';

  // 6b. A locked door next to us is a kick, not a wall. Without this the bot
  //     stalls in front of the ~16% of levels whose route down is locked.
  for (const d of DIRS) {
    if (lvl.at(p.x + d.dx, p.y + d.dy) === T.DOOR_LOCKED) {
      ui.intent = { dir: { dx: d.dx, dy: d.dy } };
      return 'o';                 // 'o' on a locked door offers to kick it
    }
  }

  // 7. Head for the stairs if they are known.
  if (lvl.downStair && lvl.isSeen(lvl.downStair.x, lvl.downStair.y)) {
    const path = astar(lvl, p.x, p.y, lvl.downStair.x, lvl.downStair.y, { maxNodes: 5000 });
    if (path?.length && stepUsable(game, path[0].x, path[0].y)) {
      const k = keyFor(path[0].x - p.x, path[0].y - p.y);
      if (k) return k;
    }
  }

  // 8. Otherwise explore.
  const goals = [];
  for (let y = 0; y < lvl.h; y++) {
    for (let x = 0; x < lvl.w; x++) {
      const i = lvl.idx(x, y);
      if (!lvl.seen[i] && isWalkable(lvl.tiles[i])) goals.push({ x, y });
    }
  }
  if (goals.length) {
    const field = flowField(lvl, goals, { maxDist: 400 });
    const step = stepAlong(lvl, field, p.x, p.y);
    if (step && stepUsable(game, step.x, step.y)) {
      const k = keyFor(step.x - p.x, step.y - p.y);
      if (k) return k;
    }
  }

  // 8b. Nothing reachable is unexplored, but a locked door might be hiding the
  //     rest of the level - including the Amulet's vault on the bottom floor,
  //     which is a sealed room with one locked door. Walk to it and kick.
  //
  //     One flow field over every square that faces a locked door, not an A*
  //     per door: the per-door version ran 1680 x 4 searches per decision and
  //     took a god run from seconds to minutes.
  {
    const goals = [];
    for (let y = 0; y < lvl.h; y++) {
      for (let x = 0; x < lvl.w; x++) {
        if (lvl.at(x, y) !== T.DOOR_LOCKED) continue;
        for (const d of DIRS) {
          if (d.dx && d.dy) continue;                 // must approach head-on
          if (lvl.passable(x + d.dx, y + d.dy)) goals.push({ x: x + d.dx, y: y + d.dy });
        }
      }
    }
    if (goals.length) {
      const field = flowField(lvl, goals, { maxDist: 400 });
      const step = stepAlong(lvl, field, p.x, p.y);
      if (step && stepUsable(game, step.x, step.y)) {
        const k = keyFor(step.x - p.x, step.y - p.y);
        if (k) return k;
      }
    }
  }

  // 9. Nothing new: search for secret doors, then wander.
  if (rng.oneIn(3)) return use('s') ?? '.';
  return rng.pick(DIRS).key;
}

async function runBot(seed, maxTurns, god = false) {
  const rng = new RNG(`bot:${seed}`);
  const ui = new BotUI(rng);
  const game = new Game(null);
  game.ui = ui;
  const role = ROLES[rng.rn2(ROLES.length)].key;
  game.newGame({ seed, role, name: 'Bot' });

  // --god makes the bot unkillable. That is not a balance cheat, it is how the
  // deep half of the dungeon gets executed at all: a greedy melee bot dies
  // around level 5, so levels 6-26, the Sanctum, the Amulet and the win
  // condition would otherwise never run outside a real playthrough.
  if (god) {
    game.player.hpMax = 100000; game.player.hp = 100000;
    game.player.pwMax = 10000; game.player.pw = 10000;
    game.player.baseAC = -40;
    game.player.intrinsics.add('fireRes'); game.player.intrinsics.add('coldRes');
    game.player.intrinsics.add('poisonRes'); game.player.intrinsics.add('sleepRes');
    game.player.intrinsics.add('shockRes'); game.player.intrinsics.add('freeAction');
    game.player.intrinsics.add('magicRes'); game.player.intrinsics.add('stoneRes');
    game.godmode = true;
  }

  let steps = 0;
  let stallTurn = game.turn, stallSteps = 0;
  const blocked = new Set();
  while (game.running && steps < maxTurns) {
    if (god) { game.player.hp = game.player.hpMax; game.player.nutrition = 2000; }
    const before = game.turn;
    const key = decide(game, ui, rng, blocked);
    await game.command(key);
    ui.intent = null;
    steps++;
    if (game.turn === before) blocked.add(key); else blocked.clear();
    // A command that spends no turn is fine; two hundred in a row is a bug,
    // in the bot or in the game, and is worth reporting rather than spinning.
    if (game.turn === stallTurn) {
      if (++stallSteps > 200) {
        const p = game.player, lvl = game.level;
        const around = [];
        for (let dy = -1; dy <= 1; dy++) {
          const row = [];
          for (let dx = -1; dx <= 1; dx++) {
            const m = lvl.monsterAt(p.x + dx, p.y + dy);
            row.push(lvl.at(p.x + dx, p.y + dy) + (m ? '/' + m.specKey : ''));
          }
          around.push(row.join(' '));
        }
        throw new Error(`stalled at turn ${game.turn} on dlvl ${p.depth} at ${p.x},${p.y}` +
          ` last key "${key}" msgs="${ui.messages.slice(-3).join(' | ')}" around=[${around.join(' / ')}]`);
      }
    } else { stallTurn = game.turn; stallSteps = 0; }
  }
  return {
    seed, role, steps, turn: game.turn,
    depth: game.player.depth, maxDepth: game.player.maxDepth,
    xp: game.player.xpLevel, hp: game.player.hp, hpMax: game.player.hpMax,
    gold: game.player.gold, kills: game.stats.kills,
    levels: game.levels.size, amulet: game.player.hasAmulet,
    how: game.gameOver?.how ?? 'timeout', killer: game.gameOver?.killer ?? null,
    shops: [...game.levels.values()].reduce((n, l) => n + l.shops.length, 0),
    genKinds: [...game.levels.values()].map((l) => l.genKind),
  };
}

const argv = process.argv.slice(2);
const god = argv.includes('--god');
const rest = argv.filter((a) => !a.startsWith('--'));
const runs = Number(rest[0] ?? 12);
const maxTurns = Number(rest[1] ?? 30000);
const start = Date.now();
let deepest = 0, failures = 0, wins = 0, amulets = 0;
const kinds = new Map();

for (let i = 0; i < runs; i++) {
  try {
    const r = await runBot(`bot-${i}`, maxTurns, god);
    deepest = Math.max(deepest, r.maxDepth);
    if (r.how === 'ascended') wins++;
    if (r.amulet) amulets++;
    for (const k of r.genKinds) kinds.set(k, (kinds.get(k) ?? 0) + 1);
    console.log(
      `${String(i).padStart(2)} ${r.role.padEnd(10)} steps=${String(r.steps).padStart(6)} ` +
      `turn=${String(r.turn).padStart(6)} dlvl=${String(r.depth).padStart(2)}/${String(r.maxDepth).padStart(2)} ` +
      `xp=${String(r.xp).padStart(2)} hp=${r.hp}/${r.hpMax} $${r.gold} kills=${r.kills} ` +
      `shops=${r.shops} ${r.how}${r.killer ? ' (' + r.killer + ')' : ''}${r.amulet ? ' +AMULET' : ''}`);
  } catch (err) {
    failures++;
    console.log(`${String(i).padStart(2)} THREW: ${err.message}`);
    console.log(String(err.stack).split('\n').slice(0, 10).join('\n'));
  }
}

console.log(`\n--- ${runs} bot runs, ${((Date.now() - start) / 1000).toFixed(1)}s ---`);
console.log(`deepest level reached: ${deepest}   amulets taken: ${amulets}   wins: ${wins}`);
console.log('level kinds generated:', [...kinds.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
console.log(`failures: ${failures}`);
process.exit(failures ? 1 : 0);
