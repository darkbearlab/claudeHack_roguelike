// A bot that plays the read-and-react loop.
//
// This one is a genuine balance instrument, which claudeHack's could never be.
// There, the outcome of a fight was a distribution over dice, so a bot could
// only tell you roughly how often things go badly. Here the combat is
// deterministic and fully observed, so a bot that plays *correctly* answers a
// question with a real answer: **is this fight winnable by someone who reads
// every telegraph and never wastes stamina?**
//
// If the perfect dodger still dies, the numbers are wrong, not the player.
//
//   node tools/botrun.mjs [runs] [maxTurns]
//   node tools/botrun.mjs --report      per-floor survival breakdown
//
// The policy, in priority order:
//   1. standing in a telegraphed tile -> get out (roll if affordable, else walk)
//   2. an enemy is recovering and adjacent -> hit it, that is the whole game
//   3. an enemy is winding up and adjacent and I can afford to trade -> stagger
//   4. low stamina and nothing threatening -> wait and breathe
//   5. otherwise advance towards the stairs

import { Game, DUNGEON_DEPTH } from '../js/game/game.js';
import { RNG } from '../../engine/rng.js';
import { DIRS, dist } from '../../engine/util.js';
import { astar } from '../../engine/path.js';
import { STATE } from '../js/game/actors.js';
import { SKILL_BY_KEY } from '../js/data/skills.js';
import { T, isBonfire } from '../js/map/tiles.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

class BotUI {
  pushMessage() {} render() {} animateTrail() {} onDeath() {}
  sleep() { return Promise.resolve(); }
  async showText() {} async showHelp() {}
  showGameOver() {} showSaved() {}
}

/** Every tile that will be hit next time something resolves. */
function dangerTiles(game) {
  const danger = new Map();
  for (const e of game.level.enemies) {
    if (!e.alive || e.state !== STATE.WINDUP || !e.attackTiles) continue;
    for (const t of e.attackTiles) danger.set(`${t.x},${t.y}`, e.timer);
  }
  for (const p of game.level.projectiles) {
    if (p.fromPlayer) continue;
    // Where the arrow will be over the next couple of turns.
    let x = p.x, y = p.y;
    for (let s = 0; s < p.speed * 2; s++) {
      x += p.dx; y += p.dy;
      if (!game.level.flyable(x, y)) break;
      danger.set(`${x},${y}`, Math.floor(s / p.speed) + 1);
    }
  }
  return danger;
}

const inDanger = (d, x, y) => d.has(`${x},${y}`);

function safeSteps(game, danger) {
  const p = game.player;
  const out = [];
  for (const d of DIRS) {
    const nx = p.x + d.dx, ny = p.y + d.dy;
    if (!game.level.passable(nx, ny)) continue;
    if (game.level.enemyAt(nx, ny)) continue;
    if (!game.level.diagonalOk(p.x, p.y, nx, ny)) continue;
    if (inDanger(danger, nx, ny)) continue;
    out.push(d);
  }
  return out;
}

function adjacentEnemies(game) {
  const p = game.player;
  const out = [];
  for (const d of DIRS) {
    const e = game.level.enemyAt(p.x + d.dx, p.y + d.dy);
    if (e && e.alive) out.push({ e, d });
  }
  return out;
}

function act(game, rng) {
  const p = game.player;
  const lvl = game.level;
  const danger = dangerTiles(game);
  const rollCost = p.rollCost();

  // 1. Standing somewhere that is about to be hit? Leave.
  if (inDanger(danger, p.x, p.y)) {
    const safe = safeSteps(game, danger);
    if (safe.length) {
      // Prefer to roll: it does not spend the turn, so you can leave AND act.
      if (p.stamina >= rollCost) {
        const d = safe.find((q) => {
          const nx = p.x + q.dx * 2, ny = p.y + q.dy * 2;
          return !inDanger(danger, nx, ny);
        }) ?? safe[0];
        return { kind: 'skill', key: 'roll', dir: d };
      }
      return { kind: 'move', dir: safe[0] };
    }
    // Nowhere safe: staggering the thing about to hit us is the last resort.
    const adj = adjacentEnemies(game).find((a) => a.e.state === STATE.WINDUP);
    if (adj && p.stamina >= SKILL_BY_KEY.strike.stamina) {
      return { kind: 'move', dir: adj.d };
    }
  }

  const adj = adjacentEnemies(game);

  // 2. Punish recovery. This is the entire game.
  const open = adj.find((a) => a.e.state === STATE.RECOVER || a.e.state === STATE.RESTING);
  if (open) {
    const sweep = p.skill('sweep');
    if (adj.length >= 2 && sweep.cd === 0 && p.stamina >= SKILL_BY_KEY.sweep.stamina + rollCost) {
      return { kind: 'skill', key: 'sweep', dir: open.d };
    }
    if (p.stamina >= SKILL_BY_KEY.strike.stamina + rollCost) return { kind: 'move', dir: open.d };
  }

  // 3. Stagger a wind-up, but only with stamina spare to leave afterwards.
  const winding = adj.find((a) => a.e.state === STATE.WINDUP);
  if (winding && p.stamina >= SKILL_BY_KEY.strike.stamina + rollCost) {
    return { kind: 'move', dir: winding.d };
  }

  // 4. Breathe. Never enter a fight without enough for one dodge.
  if (p.stamina < rollCost + SKILL_BY_KEY.strike.stamina) {
    const threat = lvl.livingEnemies().some((e) => dist(e.x, e.y, p.x, p.y) <= 2);
    if (!threat) return { kind: 'wait' };
    const safe = safeSteps(game, danger);
    if (safe.length) {
      const away = safe.sort((a, b) => nearestEnemy(game, p.x + b.dx, p.y + b.dy) -
                                       nearestEnemy(game, p.x + a.dx, p.y + a.dy))[0];
      return { kind: 'move', dir: away };
    }
    return { kind: 'wait' };
  }

  // 5. Head down. Rest whenever a bonfire is underfoot and we are hurt.
  if (isBonfire(lvl.at(p.x, p.y)) && p.hp < p.hpMax) return { kind: 'rest' };
  if (lvl.at(p.x, p.y) === T.STAIRS_DOWN) return { kind: 'descend' };

  const goal = lvl.downStair ?? lvl.upStair;
  if (goal) {
    const path = astar(lvl, p.x, p.y, goal.x, goal.y, { maxNodes: 4000, avoidHazards: false });
    if (path && path.length) {
      const step = path[0];
      const d = DIRS.find((q) => q.dx === step.x - p.x && q.dy === step.y - p.y);
      const blocker = lvl.enemyAt(step.x, step.y);
      if (blocker) return { kind: 'move', dir: d };     // walk into it = attack
      // A tile that is threatened two or more turns out is fine to walk
      // through - you will be gone before it resolves. Refusing every
      // threatened tile made the bot sit still for 20,000 turns whenever an
      // archer had a corridor covered, which is a bot flaw, not a level flaw.
      const when = danger.get(`${step.x},${step.y}`);
      if (d && (when === undefined || when >= 2)) return { kind: 'move', dir: d };
    }
  }
  // Genuinely stuck: go and remove whatever is holding the corridor.
  const nearest = lvl.livingEnemies()
    .map((e) => ({ e, d: dist(e.x, e.y, p.x, p.y) }))
    .sort((a, b) => a.d - b.d)[0];
  if (nearest) {
    const path = astar(lvl, p.x, p.y, nearest.e.x, nearest.e.y, { maxNodes: 3000 });
    if (path && path.length) {
      const d = DIRS.find((q) => q.dx === path[0].x - p.x && q.dy === path[0].y - p.y);
      if (d) return { kind: 'move', dir: d };
    }
  }
  const any = safeSteps(game, danger);
  return any.length ? { kind: 'move', dir: rng.pick(any) } : { kind: 'wait' };
}

function nearestEnemy(game, x, y) {
  let best = 99;
  for (const e of game.level.enemies) {
    if (!e.alive) continue;
    best = Math.min(best, dist(e.x, e.y, x, y));
  }
  return best;
}

async function run(seed, maxTurns, vow) {
  const rng = new RNG(`bot:${seed}`);
  const game = new Game(null);
  game.ui = new BotUI();
  game.newGame({ seed, name: 'Bot', vow });

  const floorDeaths = new Map();
  let steps = 0, stall = 0, lastTurn = -1;

  while (game.running && steps < maxTurns) {
    const before = game.turn;
    const deathsBefore = game.player.deaths;
    const a = act(game, rng);

    switch (a.kind) {
      case 'skill': {
        const spent = game.useSkill(a.key, { dx: a.dir.dx, dy: a.dir.dy });
        if (spent) game.worldTurn();
        break;
      }
      case 'move':    await game.command(a.dir.key); break;
      case 'wait':    await game.command('.'); break;
      case 'rest':    await game.command('e'); break;
      case 'descend': await game.command('>'); break;
      default:        await game.command('.'); break;
    }

    if (game.player.deaths > deathsBefore) {
      const d = game.player.depth;
      floorDeaths.set(d, (floorDeaths.get(d) ?? 0) + 1);
      if (game.player.deaths > 60) break;    // hopeless; stop burning cycles
    }

    steps++;
    if (game.turn === lastTurn) {
      if (++stall > 300) throw new Error(`stalled on floor ${game.player.depth} at turn ${game.turn}`);
    } else { stall = 0; lastTurn = game.turn; }
  }

  return {
    seed, vow, steps, turn: game.turn,
    depth: game.player.depth, maxDepth: game.player.maxDepth,
    deaths: game.player.deaths, kills: game.stats.kills,
    how: game.gameOver?.how ?? 'timeout',
    floorDeaths: [...floorDeaths.entries()].sort((a, b) => a[0] - b[0]),
  };
}

const argv = process.argv.slice(2);
const report = argv.includes('--report');
const rest = argv.filter((a) => !a.startsWith('--'));
const runs = Number(rest[0] ?? 10);
const maxTurns = Number(rest[1] ?? 20000);

let failures = 0, wins = 0, deepest = 0;
const perFloor = new Map();
const t0 = Date.now();

for (let i = 0; i < runs; i++) {
  const vow = i % 2 ? 'heavy' : 'light';
  try {
    const r = await run(`bot-${i}`, maxTurns, vow);
    deepest = Math.max(deepest, r.maxDepth);
    if (r.how === 'won') wins++;
    for (const [f, n] of r.floorDeaths) perFloor.set(f, (perFloor.get(f) ?? 0) + n);
    console.log(
      `${String(i).padStart(2)} ${r.vow.padEnd(5)} steps=${String(r.steps).padStart(5)} ` +
      `turn=${String(r.turn).padStart(5)} floor=${String(r.depth).padStart(2)}/${String(r.maxDepth).padStart(2)} ` +
      `deaths=${String(r.deaths).padStart(2)} kills=${String(r.kills).padStart(3)} ${r.how}`);
  } catch (e) {
    failures++;
    console.log(`${String(i).padStart(2)} THREW: ${e.message}`);
    console.log(String(e.stack).split('\n').slice(1, 6).join('\n'));
  }
}

console.log(`\n--- ${runs} runs, ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
console.log(`deepest floor: ${deepest}/${DUNGEON_DEPTH}   wins: ${wins}   failures: ${failures}`);
if (report && perFloor.size) {
  console.log('deaths per floor (where the difficulty actually is):');
  for (const f of [...perFloor.keys()].sort((a, b) => a - b)) {
    console.log(`  floor ${String(f).padStart(2)}  ${'#'.repeat(Math.min(50, perFloor.get(f)))} ${perFloor.get(f)}`);
  }
}
process.exit(failures ? 1 : 0);
