// What each hero actually does to something that stands still.
//
// The bot cannot answer this. Measured across 8 runs it swung 83 times as the
// old knight and rolled 9,108 times: its policy is "avoid damage at almost any
// cost", which is the right instrument for "can a perfect dodger survive" and
// a useless one for "what is a turn worth". The farwayer made that gap matter,
// because her whole design is a three-turn phrase and the bot never takes two
// swings in a row at anything.
//
// So: a post to hit, a full bar, and a player who attacks every turn they can
// afford to and waits when they cannot. No dodging, no positioning, no danger.
// That is not how the game is played, and it is not meant to be - it isolates
// the one number the bot hides, which is what a turn of swinging is worth.
//
//   node tools/dps.mjs [turns]
//
// The farwayer is played on the phrase she is designed around: reach, reach,
// return, return, pace, pace - four distinct marks laid, then the basic attack
// closes the set at x5. Everyone else swings their best affordable skill. Both
// are the honest best case for that character.

import { Game } from '../js/game/game.js';
import { HEROES } from '../js/data/heroes.js';
import { SKILL_BY_KEY, faceOf } from '../js/data/skills.js';
import { Enemy } from '../js/game/actors.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
};
class Quiet {
  pushMessage() {} render() {} animateTrail() {} onDeath() {}
  sleep() { return Promise.resolve(); }
  async showText() {} async showHelp() {} showGameOver() {} showSaved() {} showConversation() {}
}

const TURNS = Number(process.argv[2] ?? 40);

/** A hero, a post, and nothing else. */
function post(heroKey) {
  const g = new Game(null);
  g.ui = new Quiet();
  g.newGame({ seed: 'dps', name: 'A', hero: heroKey });
  const lvl = g.level;
  lvl.enemies.length = 0; lvl.projectiles.length = 0; lvl.markEnemiesDirty();
  const p = g.player;
  // Somewhere with room in front and behind: `behind` is one of her six faces
  // and an arena that cannot show it would flatter every other hero.
  let spot = null;
  for (const room of lvl.rooms) {
    for (let y = room.y + 1; y < room.y + room.h - 1 && !spot; y++) {
      for (let x = room.x + 2; x < room.x + room.w - 2; x++) {
        if ([-2, -1, 0, 1, 2].every((d) => lvl.walkable(x + d, y))) { spot = { x, y }; break; }
      }
    }
    if (spot) break;
  }
  if (!spot) throw new Error('no room with two clear tiles either side');
  p.x = spot.x; p.y = spot.y;
  p.stamina = p.staminaMax; p.staminaFrac = 0;
  p.hp = p.hpMax;

  const target = new Enemy('husk', g.rng);
  target.hpMax = 100000; target.hp = 100000;
  lvl.addEnemy(target, spot.x + 1, spot.y);
  // A second post at her back, so `behind` has something to hit. It is the
  // best case for that one face on purpose - the question this answers is
  // "what is it worth when it lands", not "how often does it land".
  const back = new Enemy('husk', g.rng);
  back.hpMax = 100000; back.hp = 100000;
  lvl.addEnemy(back, spot.x - 1, spot.y);
  lvl.markEnemiesDirty();
  // Asleep, so nothing hits back and nothing moves: the post must stay a post.
  for (const e of lvl.livingEnemies()) { e.aware = false; e.hunting = false; }
  g.afterMove();
  return { g, p, target, back };
}

const EAST = { dx: 1, dy: 0 };

/** Her designed phrase, repeated: lay four marks, then close with the basic. */
const PHRASE = ['reach', 'reach', 'return', 'return', 'pace', 'pace'];

function measure(heroKey) {
  const { g, p, target, back } = post(heroKey);
  const hero = p.hero;
  const start = target.hp + back.hp;
  let swings = 0, waits = 0, i = 0;
  const spentAt = { start: p.stamina };

  for (let t = 0; t < TURNS; t++) {
    // Keep going until the turn actually ends, which for her is two beats.
    let guard = 0;
    while (g.turn === t && guard++ < 8) {
      let key = null;
      if (heroKey === 'farwayer') {
        key = PHRASE[i % PHRASE.length];
        if (!p.canAfford(p.costOf(key))) key = null;
        else i++;
      } else {
        // The dearest thing they can afford: the honest best case.
        let best = null, bestCost = -1;
        for (const sk of hero.skills) {
          const d = SKILL_BY_KEY[sk];
          if (!d || d.move || d.defend || !d.damage) continue;
          const c = p.costOf(sk);
          if (p.canAfford(c) && p.skill(sk)?.cd === 0 && c > bestCost) { best = sk; bestCost = c; }
        }
        key = best;
      }
      if (key && g.useSkill(key, EAST)) { swings++; break; }
      if (key) { swings++; continue; }          // a beat spent, turn not over
      waits++; g.wait(); break;
    }
    g.worldTurn();
  }
  const dealt = start - (target.hp + back.hp);
  // Front-only as well as total. The post at her back exists so `behind` can
  // land, and only she can reach it - counting it in a comparison against
  // three heroes who cannot would flatter her by construction.
  const front = 100000 - target.hp;
  return {
    hero: heroKey, dealt, front, swings, waits,
    frontPerTurn: front / TURNS,
    perTurn: dealt / TURNS,
    perSwing: swings ? dealt / swings : 0,
    endStamina: p.stamina,
    startStamina: spentAt.start,
  };
}

console.log(`a post, a full bar, ${TURNS} turns of swinging as hard as you can afford\n`);
console.log('hero        front  front/turn    total   all/turn   swings   waited   bar end');
const rows = [];
for (const h of HEROES) {
  try {
    const r = measure(h.key);
    rows.push(r);
    console.log(
      `${h.key.padEnd(10)} ${String(r.front).padStart(6)}    ${r.frontPerTurn.toFixed(2).padStart(8)}` +
      `   ${String(r.dealt).padStart(6)}   ${r.perTurn.toFixed(2).padStart(8)}` +
      `   ${String(r.swings).padStart(6)}   ${String(r.waits).padStart(6)}   ${String(r.endStamina).padStart(6)}`);
  } catch (e) {
    console.log(`${h.key.padEnd(10)}  FAILED: ${e.message}`);
  }
}

const best = Math.max(...rows.map((r) => r.frontPerTurn));
const worst = Math.min(...rows.map((r) => r.frontPerTurn));
console.log(`\nsingle target: ${worst.toFixed(2)} to ${best.toFixed(2)} a turn` +
            `  (x${(best / Math.max(0.01, worst)).toFixed(2)})`);
console.log('waiting is the tell: a hero who waits is one whose bar, not whose beats, is the limit.');
