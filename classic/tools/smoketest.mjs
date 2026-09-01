// Headless soak test.
//
// The game core has no DOM dependency by design, so it can be driven from Node
// with a stub UI. This plays thousands of random turns across many seeds and
// reports any exception, which finds crash bugs orders of magnitude faster than
// playing by hand does - and it finds the rare ones, which playing by hand
// essentially never does.
//
//   node tools/smoketest.mjs [seeds] [turns]
//
// It is a *crash* test, not a balance test. It answers "does this ever throw",
// not "is this fun". Exit code 1 means at least one seed threw.

import { Game } from '../js/game/game.js';
import { RNG } from '../../engine/rng.js';
import { ROLES } from '../js/data/roles.js';
import { saveGame, loadGame } from '../js/game/save.js';

// --- minimal browser surface -------------------------------------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

// --- stub UI -----------------------------------------------------------------
class StubUI {
  constructor(rng) { this.rng = rng; this.messages = []; this.prompts = 0; }
  pushMessage(t, c) { this.messages.push(t); if (this.messages.length > 200) this.messages.shift(); }
  render() {}
  animateTrail() {}
  sleep() { return Promise.resolve(); }
  async yesno() { this.prompts++; return this.rng.oneIn(3); }
  async getKey() { this.prompts++; return 'Escape'; }
  async getDirection() {
    this.prompts++;
    const d = [[-1,0],[1,0],[0,-1],[0,1],[1,1],[-1,-1],[1,-1],[-1,1],[0,0]][this.rng.rn2(9)];
    return { dx: d[0], dy: d[1] };
  }
  async getText() { this.prompts++; return this.rng.pick(['Elbereth', 'x', 'long sword', 'newt', '']); }
  async pickItem(_p, entries) {
    this.prompts++;
    const real = entries.filter((e) => !e.header);
    if (!real.length || this.rng.oneIn(6)) return null;
    return this.rng.pick(real).obj;
  }
  async pickMany(_p, entries) {
    this.prompts++;
    const real = entries.filter((e) => !e.header);
    return real.filter(() => this.rng.oneIn(2)).map((e) => e.obj);
  }
  async showMenu(_t, entries, opts) {
    this.prompts++;
    if (opts?.multi) return [];
    const real = entries.filter((e) => !e.header);
    return real.length && !this.rng.oneIn(3) ? this.rng.pick(real).obj : null;
  }
  async pickPosition() {
    this.prompts++;
    const lvl = this.game.level;
    const s = lvl.randomFreeSpot(this.rng);
    return s ?? null;
  }
  async showText() { this.prompts++; }
  async showTerrain() { this.prompts++; }
  async showHelp() { this.prompts++; }
  showGameOver() {}
  showSaved() {}
  showCommandPalette() {}
}

// --- the commands the fuzzer presses ----------------------------------------
// Movement dominates, because it dominates real play and because it is what
// drives the hero into everything else.
const COMMANDS = [
  ...'hjklyubn'.repeat(9).split(''),
  ...'HJKL'.split(''),
  ',', ',', 'i', 'd', 'D', 'w', 'W', 'T', 'P', 'R', 'x',
  'q', 'r', 'z', 'Z', 'e', 'a', 't', 'f', 'Q', 'E', 'p', 'c', 'o',
  '>', '>', '>', '<', 's', 's', '.', ':', ';', '^', '\\', '#',
  'C-x', 'C-f',
];

async function runSeed(seedName, maxTurns, verbose) {
  const rng = new RNG(`fuzz:${seedName}`);
  const ui = new StubUI(rng);
  const game = new Game(null);
  ui.game = game;
  game.ui = ui;
  const role = ROLES[rng.rn2(ROLES.length)].key;
  game.newGame({ seed: seedName, role, name: 'Fuzz' });

  let steps = 0;
  while (game.running && steps < maxTurns) {
    const key = rng.pick(COMMANDS);
    await game.command(key);
    steps++;
    // Exercise save/load round-trips periodically; a save bug that only shows
    // up after twenty levels is exactly what a soak test is for.
    if (steps % 900 === 0 && game.running) {
      saveGame(game);
      const g2 = new Game(null);
      g2.ui = ui; ui.game = g2;
      if (!loadGame(g2)) throw new Error('load returned false');
      g2.afterMove();
      ui.game = game;
    }
  }
  return {
    seed: seedName, role, steps, turns: game.turn,
    running: game.running, depth: game.player.depth, maxDepth: game.player.maxDepth,
    hp: game.player.hp, xp: game.player.xpLevel,
    how: game.gameOver?.how ?? 'alive', killer: game.gameOver?.killer ?? null,
    levels: game.levels.size, prompts: ui.prompts,
    lastMessages: verbose ? ui.messages.slice(-5) : null,
  };
}

const nSeeds = Number(process.argv[2] ?? 40);
const maxTurns = Number(process.argv[3] ?? 1500);

let failures = 0;
const deaths = new Map();
const start = Date.now();

for (let i = 0; i < nSeeds; i++) {
  const seed = `soak-${i}`;
  try {
    const r = await runSeed(seed, maxTurns, false);
    deaths.set(r.how, (deaths.get(r.how) ?? 0) + 1);
    if (r.killer) deaths.set('by:' + r.killer, (deaths.get('by:' + r.killer) ?? 0) + 1);
    process.stdout.write(
      `${String(i).padStart(3)} ${r.role.padEnd(10)} steps=${String(r.steps).padStart(5)} ` +
      `turn=${String(r.turns).padStart(5)} dlvl=${r.depth}/${r.maxDepth} ` +
      `xp=${r.xp} lv=${r.levels} ${r.how}${r.killer ? ' (' + r.killer + ')' : ''}\n`);
  } catch (err) {
    failures++;
    process.stdout.write(`${String(i).padStart(3)} SEED ${seed} THREW: ${err.message}\n`);
    process.stdout.write(String(err.stack).split('\n').slice(0, 8).join('\n') + '\n');
  }
}

console.log(`\n--- ${nSeeds} seeds, ${maxTurns} commands each, ${((Date.now() - start) / 1000).toFixed(1)}s ---`);
console.log('outcomes:', [...deaths.entries()].filter(([k]) => !k.startsWith('by:'))
  .map(([k, v]) => `${k}=${v}`).join(' '));
console.log(`failures: ${failures}`);
process.exit(failures ? 1 : 0);
