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
import { T, isWalkable, isChest, isCorpse, flyable, tileName } from '../js/map/tiles.js';
import { Enemy, STATE } from '../js/game/actors.js';
import { ENEMIES, ENEMY_BY_KEY } from '../js/data/enemies.js';
import { SKILLS, SKILL_BY_KEY, PLAYER } from '../js/data/skills.js';
import { ITEMS, ITEM_BY_KEY, SLOT, skillsFrom, STARTING_KIT,
         CONSUMABLES, CONSUMABLE_BY_KEY } from '../js/data/items.js';
import { TRACKS, soulsFor, priceOf } from '../js/data/souls.js';
import { AFFIXES, AFFIX_BY_KEY, canGrant, TEMP_HITS } from '../js/data/affixes.js';
import { attackTiles, snapDir, PATTERNS, RADIAL, spriteRotation, blocksDirection } from '../js/game/patterns.js';
import { ART_FACING } from '../js/data/sprites.js';
import { planCycle, Animator } from '../js/ui/anim.js';
import { NPCS, NPC_BY_KEY } from '../js/data/npcs.js';
import { CHAMBERS, CHAMBER_BY_KEY, castFor, ROLES } from '../js/data/chambers.js';
import { HEROES, HERO_BY_KEY } from '../js/data/heroes.js';
import { hasLOS } from '../../engine/fov.js';
import { saveGame, loadGame, saveSummary } from '../js/game/save.js';
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
    // An async test in a synchronous runner is a test that CANNOT FAIL: the
    // assertions inside become an unhandled rejection and this line reports
    // PASS anyway. That happened - `a skill fires where the direction key
    // points` was written async and printed `PASS -- [object Promise]`.
    //
    // The rules are synchronous; command() is async only for animation (see
    // await0). So there is never a reason to need this, and it is refused
    // rather than supported.
    if (d && typeof d.then === 'function') {
      throw new Error('test function is async - the runner is synchronous and '
                    + 'would report PASS without running your assertions');
    }
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

function await0(g) {
  // command() is async only because the UI animates between turns; the rules
  // it drives are synchronous, and the charge resolves before the first await.
  g.command('h');
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

  // Measured over time, not out of a full bar. A roll now costs what a roll
  // costs - the same number in rags or mail - so from a standing start both
  // kits get the same count. What weight buys is the *rate*, so the gap has to
  // be measured the way it is now expressed: how many rolls a long fight
  // affords you. Pinning the full-bar count would have pinned the old design.
  const rollsOver = (p, turns) =>
    Math.floor((p.staminaMax + p.regenRate(true) * turns) / p.rollCost());
  const lRolls = rollsOver(light, 20);
  const hRolls = rollsOver(heavy, 20);
  assert(hRolls >= 2, `heavy gets only ${hRolls} rolls - that is not a trade, it is a wall`);
  assert(lRolls > hRolls, `light ${lRolls} rolls vs heavy ${hRolls} over 20 turns - weight buys nothing`);
  assert(light.rollCost() === heavy.rollCost(), 'a roll should cost a roll, whatever you wear');
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

  // The consequence that survived the rewrite: a tower shield is not free to
  // carry. What changed is *where* you pay. It used to add to the price of
  // every swing, which meant the same button showed a different number
  // depending on your off hand; now it is weight like anything else, and
  // weight reaches you through the recovery rate.
  p.equipItem(SLOT.OFF, 'buckler');
  const buckRegen = p.regenRate(true);
  p.equipItem(SLOT.OFF, 'tower');
  assert(p.costOf('strike') === bare, 'a tower shield still taxes the swing itself');
  assert(p.regenRate(true) < buckRegen, 'a tower shield is free to carry');
  return `strike ${bare} either way; regen ${buckRegen} -> ${p.regenRate(true)}`;
});

check('a committed turn passes however you spend it', () => {
  // Every way of asking to act has to consume the turn you already committed
  // to. When the skill path returned "nothing happened" instead, the turn
  // never advanced: the bot span forever, and a player would have found the
  // buttons dead with no indication that only the direction keys still moved
  // the clock. Same failure the refused bonfire rest caused, one file over.
  const { g } = arena('rec-turn', 'husk', 3);
  g.player.equip.main = 'warhammer';
  g.useSkill('sunder', { dx: 1, dy: 0 });
  assert(g.player.recovering, 'sunder did not commit');
  const t0 = g.turn;
  const spent = g.useSkill('pound', { dx: 1, dy: 0 });
  assert(spent, 'a skill pressed during recovery did not consume the turn');
  g.worldTurn();
  assert(g.turn > t0, 'the clock did not move');
  return `recovery burns the turn from the skill path too`;
});

check('a wind-up lands on the next turn, not this one', () => {
  const { g, e } = arena('wind1', 'husk', 2);
  g.player.equip.main = 'pike';                 // brace / impale
  const hp0 = e.hp;
  const spent = g.useSkill('impale', { dx: 1, dy: 0 });
  assert(spent, 'declaring a wind-up should cost the turn');
  assert(g.player.charging, 'nothing was declared');
  assert(e.hp === hp0, 'the blow landed on the turn it was declared');
  g.worldTurn();
  g.useSkill('impale', { dx: 1, dy: 0 });       // any input resolves it
  assert(!g.player.charging, 'the charge never resolved');
  assert(e.hp < hp0, `the declared blow never landed (${hp0} -> ${e.hp})`);
  return `declared, then landed for ${hp0 - e.hp}`;
});

check('a wind-up is knocked out of you, and the stamina stays spent', () => {
  // The whole gamble. Recovery cannot be taken away from you because the
  // damage is already banked; a wind-up can, and that is the entire
  // difference between the two halves of the same commitment budget.
  const { g } = arena('wind2', 'husk', 2);
  g.player.equip.main = 'pike';
  const st0 = g.player.stamina;
  g.useSkill('impale', { dx: 1, dy: 0 });
  assert(g.player.charging, 'nothing was declared');
  const st1 = g.player.stamina;
  assert(st1 < st0, 'declaring cost nothing');
  g.hurtPlayer(2, 'a test');
  assert(!g.player.charging, 'a hit did not interrupt the wind-up');
  assert(g.player.stamina === st1, 'the interrupted swing refunded its stamina');
  return `paid ${st0 - st1}, lost the swing, kept nothing back`;
});

check('you cannot walk out of your own swing', () => {
  const { g, e } = arena('wind3', 'husk', 2);
  g.player.equip.main = 'pike';
  const hp0 = e.hp;
  g.useSkill('impale', { dx: 1, dy: 0 });
  const { x, y } = g.player;
  g.worldTurn();
  await0(g);
  assert(e.hp < hp0 || !g.player.charging,
         'walking away cancelled the declared blow for free');
  assert(g.player.x === x && g.player.y === y,
         'the move went through as well as the swing');
  return 'the blow lands instead of the step';
});

check('no stamina comes back while a blow is in the air', () => {
  const { g } = arena('wind4', 'husk', 3);
  g.player.equip.main = 'pike';
  g.player.stamina = 10;
  g.useSkill('impale', { dx: 1, dy: 0 });
  const held = g.player.stamina;
  g.player.tick(true);
  assert(g.player.stamina === held,
         'the wind-up paid for its own next swing');
  return `held at ${held} through the declaration`;
});

check('commitment is priced by the rule, not by feel', () => {
  // The cooldowns this replaced correlated with how big an attack was at
  // r = 0.21 - they were filled in by hand and priced nothing. `hew` swept
  // four tiles on no cooldown while `gut` hit one tile and sat for three.
  //
  // So the band is computed here from the shape itself, and the table has to
  // agree. Adding a skill without a recovery now fails with the number it
  // should have had, which is the only way a rule like this survives contact
  // with the next twenty skills.
  //
  // Melee only, deliberately: recovery is a cost you pay by being reachable,
  // so at range 9 it is free. Ranged attacks stay priced by cooldown.
  const band = (sk) => {
    if (sk.ranged || !sk.pattern) return null;
    const t = attackTiles(0, 0, 1, 0, sk.pattern);
    const reach = Math.max(...t.map((q) => Math.max(Math.abs(q.x), Math.abs(q.y))));
    const v = (t.length - 1) * 1.0 + (reach - 1) * 1.2 + (sk.damage ?? 0) * 0.9;
    return v >= 9.5 ? 2 : v >= 5.5 ? 1 : 0;
  };
  const wrong = [];
  for (const sk of SKILLS) {
    if (sk.move || sk.defend) continue;
    const want = band(sk);
    if (want === null) continue;
    // The band says HOW MUCH commitment. Wind-up and recovery say how it is
    // split around the blow - impale and rend spend one of their two turns
    // before the hit rather than after, a different gamble at the same price.
    //
    // Stamina counts too, and that is not a loophole. The rule exists because
    // **a cost you can pay by waiting is not a cost**; whether waiting is cheap
    // depends on who is waiting. The soulbinder recovers one stamina a turn, so
    // her ten-point lance is ten turns of standing still - far more commitment
    // than the two the shape asks for. The same skill on a character who
    // recovers five a turn would be two turns and would need recovery on top.
    //
    // So: turns of commitment, plus turns of recovery the cost represents, for
    // whoever actually owns the skill.
    const owner = HEROES.find((h) => h.skills.includes(sk.key));
    const regen = owner ? owner.stamina.regen : PLAYER.staminaRegen + 2;
    const asTurns = Math.floor((sk.stamina ?? 0) / Math.max(1, regen));
    const got = (sk.windup ?? 0) + (sk.recovery ?? 0) + (owner ? asTurns : 0);
    if (got < want) {
      wrong.push(`${sk.key}: costs ${got} turns of commitment, shape asks ${want}`);
    }
    // And a weapon skill, which has no owner to price it for, still has to
    // match exactly - otherwise the rule stops meaning anything for them.
    if (!owner && (sk.windup ?? 0) + (sk.recovery ?? 0) !== want) {
      wrong.push(`${sk.key}: windup+recovery ${(sk.windup ?? 0) + (sk.recovery ?? 0)}, rule says ${want}`);
    }
    // No stacking: recovery replaces the cooldown, it does not sit on top of
    // it. Stamina AND cooldown AND recovery is three taxes for one swing.
    if (want > 0 && (sk.cooldown ?? 0) > 0) wrong.push(`${sk.key}: recovery ${want} AND cooldown ${sk.cooldown}`);
  }
  assert(wrong.length === 0, wrong.join('; '));
  const n = SKILLS.filter((k) => (k.recovery ?? 0) > 0).length;
  return `${n} of ${SKILLS.length} skills commit you`;
});

check('every weapon that commits on both attacks does so deliberately', () => {
  // Walking into something uses your primary, so a weapon whose primary has
  // recovery commits you on the casual action too. That is allowed - it is
  // what makes a pike a pike - but it must be a short, named list rather than
  // something that quietly grows every time a skill is retuned.
  // greatsword joined deliberately: it is the blade family's heavy end, and
  // every other two-handed heavy in the game is already on this list. It
  // shares cleave/rend with the greataxe, which costs nothing now that a
  // weapon's own skills only matter to whoever is playing without a hero.
  const ALL_IN = ['greataxe', 'halberd', 'pike', 'greatsword'];
  const found = [];
  for (const it of ITEMS.filter((i) => i.kind === 'weapon')) {
    const ks = [it.primary, it.secondary].filter(Boolean).map((k) => SKILL_BY_KEY[k]);
    if (ks.length && ks.every((k) => (k.recovery ?? 0) > 0)) found.push(it.key);
  }
  assert(found.length === ALL_IN.length && ALL_IN.every((k) => found.includes(k)),
         `all-commitment weapons are now [${found}], expected [${ALL_IN}]`);
  return `${found.join(', ')} - every swing is a commitment`;
});

check('an action costs what the action costs, however you are loaded', () => {
  // The rule the two deleted surcharges broke. A swing is the same swing in
  // rags or in mail; what your kit buys is a slower bar, not a dearer one.
  // Overload is the single deliberate exception, and it is a state you enter,
  // not a slope - so it is checked separately, below.
  const light = freshGame('cost-l', 'light').player;
  const heavy = freshGame('cost-h', 'heavy').player;
  assert(!light.encumbered && !heavy.encumbered, 'a standard kit should not be overloaded');
  const differ = [];
  for (const sk of light.skills) {
    const a = light.costOf(sk.key);
    const b = heavy.costOf(sk.key);
    if (a !== b) differ.push(`${sk.key} ${a}/${b}`);
  }
  assert(differ.length === 0, `same action, different price by load: ${differ.join(', ')}`);
  assert(light.rollCost() === heavy.rollCost(), 'rolling is dearer in armour');
  return `${light.skills.length} actions priced identically in leathers and mail`;
});

check('overload is a state you can enter, and it costs', () => {
  const p = freshGame('enc', 'heavy').player;
  const before = p.costOf('strike');
  p.equipItem(SLOT.ARMOUR, 'plate');
  p.equipItem(SLOT.MAIN, 'warhammer');
  p.equipItem(SLOT.OFF, 'kite');
  assert(p.encumbered, `plate + warhammer + kite shield (weight ${p.weight}) is not overloaded`);
  assert(p.costOf('strike') > before, 'overload does not cost anything');
  return `weight ${p.weight}: every action +${p.costOf('strike') - before}`;
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
  // Keep trying until one works, rather than committing to the first
  // direction that looks plausible. The claim is "there is always a legal
  // move", not "the first passable direction is one" - a body occupies its
  // tile, and a diagonal through a doorframe is refused however clear it
  // looks. Testing the claim means looking for the move, not guessing it.
  for (const d of DIRS) {
    const nx = p.x + d.dx, ny = p.y + d.dy;
    if (!g.level.passable(nx, ny)) continue;
    if (g.level.occupant(nx, ny)) continue;
    if (!g.level.diagonalOk(p.x, p.y, nx, ny, true)) continue;
    g.step(d.dx, d.dy);
    if (p.x !== before.x || p.y !== before.y) break;
  }
  assert(p.x !== before.x || p.y !== before.y,
         'a fully loaded player at zero stamina could not move at all');
  return 'no locked states';
});

check('stamina comes back at one rate, seen or not', () => {
  // The reverse of what this used to assert. Out of combat the bar refilled
  // four times as fast, which meant it was only a resource inside the window
  // where something could see you: every corridor between fights reset it, so
  // what you spent getting somewhere cost nothing and there was never a reason
  // to leave a fight holding anything back.
  const g = freshGame('aggro', 'light');
  for (const e of g.level.enemies) { e.aware = false; e.lost = 0; }
  assert(!g.inCombat(), 'nothing has seen the player, but the game says combat');
  const calm = g.player.regenRate(g.inCombat());

  g.level.livingEnemies()[0].aware = true;
  assert(g.inCombat(), 'an aware enemy does not count as combat');
  const fight = g.player.regenRate(g.inCombat());

  assert(calm === fight, `being unseen still pays: ${calm} vs ${fight}`);
  return `${fight}/turn either way`;
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

check('a kill pays you back only if the weapon reaps', () => {
  // This was every weapon's rule, always. As a default it paid out at the
  // wrong moment - the turn a thing dies is the turn you are under the least
  // pressure - so it is an affix now, and the paired blades carry it innately
  // because they were designed around it.
  const bare = arena('combo-cd', 'hound', 1);
  bare.g.player.equipItem(SLOT.MAIN, 'sword');
  const s1 = bare.g.player.skill('sweep');
  s1.cd = 3;
  bare.e.hp = 1;
  bare.g.useSkill('strike', { dx: 1, dy: 0 });
  assert(!bare.e.alive, 'the hound survived a strike at 1 hp');
  assert(s1.cd === 3, `a plain sword refunded on kill: cooldown ${s1.cd}`);

  const reap = arena('combo-cd', 'hound', 1);
  reap.g.player.equipItem(SLOT.MAIN, 'blades');
  assert(reap.g.player.hasAffix('reaping'), 'the paired blades no longer reap');
  const s2 = reap.g.player.skill('flurry');
  s2.cd = 3;
  reap.e.hp = 1;
  reap.g.useSkill('slice', { dx: 1, dy: 0 });
  assert(!reap.e.alive, 'the hound survived a slice at 1 hp');
  assert(s2.cd === 2, `the blades did not refund: cooldown ${s2.cd}`);
  return 'plain weapon 3 -> 3, reaping 3 -> 2';
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

  // The baseline is OBSERVED, not restated. It used to be
  // `SKILL_BY_KEY.strike.damage`, which stopped being what the player deals
  // the day weapons started carrying a power of their own - and the test then
  // counted every hit as boosted, because the sword's own +1 was over the
  // line. The loop runs two swings past the affix, so the smallest number in
  // it is by construction an unboosted hit.
  const dealt = [];
  for (let i = 0; i < TEMP_HITS + 2; i++) {
    e.hp = 999; e.x = p.x + 1; e.y = p.y; g.level.markEnemiesDirty();
    p.stamina = p.staminaMax; p.recover = 0; p.skill('strike').cd = 0;
    const before = e.hp;
    g.useSkill('strike', { dx: 1, dy: 0 });
    dealt.push(before - e.hp);
  }
  const base = Math.min(...dealt);
  const boosted = dealt.filter((d) => d > base).length;
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
    // A skill belongs to a weapon or to a person. Skills bind to people now -
    // see js/data/heroes.js - so "nothing grants it" has to look in both
    // places or every hero skill reads as orphaned.
    const heroHas = HEROES.some((h) => h.skills.includes(s.key));
    assert(owned.has(s.key) || heroHas,
           `${s.key} is defined but neither a weapon nor a hero grants it`);
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
           c.grants || c.tempAffix || c.restore,
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

  // Checked by effect, not by return value. The call now reports "the turn was
  // consumed" - because a recovery turn is consumed however you spend it - so
  // the thing to assert is that you did not actually move and did not actually
  // hit anything, which is the rule this test is really about.
  const st = p.stamina;
  const px = p.x, py = p.y, ehp = e.hp;
  g.useSkill('roll', { dx: -1, dy: 0 });
  assert(p.x === px && p.y === py, 'rolled out of a recovery');
  g.useSkill('pound', { dx: 1, dy: 0 });
  assert(e.hp === ehp, 'attacked during a recovery');
  g.worldTurn();
  assert(p.stamina === st, 'stamina came back during a recovery');

  let guard = 0;
  while (p.recovering && guard++ < 6) g.worldTurn();
  assert(!p.recovering, 'the recovery never ended');
  return `${heavy.recovery} turns helpless, and no stamina in them`;
});

check('you are never left with only committed options', () => {
  // SUPERSEDES 'only secondary skills ever have a recovery'. That rule said
  // commitment must be opt-in, so a primary could never carry it - which meant
  // a greataxe's basic swing was mechanically a dagger's, and the whole point
  // of choosing a weapon was carried by damage alone. A primary may commit
  // now; a pike is *supposed* to be a pike.
  //
  // What has to hold instead is that you always have an uncommitted way to
  // act, or a bad matchup becomes unplayable rather than hard. The roll is
  // always available, always free of recovery, and does not even end your
  // turn - that is the guarantee, and it belongs to the player rather than to
  // any weapon.
  const roll = SKILL_BY_KEY.roll;
  assert(!roll.recovery && roll.always && !roll.advancesTurn,
         'the roll is the escape hatch from an all-commitment weapon; it must stay free');
  const block = SKILL_BY_KEY.block;
  assert(!block.recovery, 'block must not commit you; it is the answer to nowhere to go');

  // And nothing pays all three of stamina, cooldown and recovery.
  for (const s of SKILLS) {
    if (!s.recovery) continue;
    assert((s.cooldown ?? 0) === 0,
           `${s.key} pays stamina AND cooldown ${s.cooldown} AND recovery - three taxes`);
  }
  return 'roll and block never commit you, whatever you are holding';
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

check('a doorway two leaves wide does not pinch you', () => {
  // Reported from play: rolls could not get through the new double doors.
  //
  // The rule is "a doorway cannot be entered or left diagonally", and it is
  // there to stop things slipping past each other at a corridor mouth -
  // funnelling enemies into a doorway is a real defensive skill here. But it
  // is a rule about squeezing through a FRAME, and since doorways became two
  // tiles wide most of them are not frames. Every leaf of every double door
  // was still refusing diagonals as if it were a gap one body wide: measured,
  // 0 of 6151 diagonal rolls into a doorway got through. Not one.
  const isDoor = (t) => t === T.DOOR_OPEN || t === T.DOOR_CLOSED || t === T.DOOR_BROKEN;
  let wideOk = 0, wideTried = 0, narrowThrough = 0, narrowTried = 0;
  for (let s = 0; s < 6; s++) {
    const g = freshGame(`pinch-${s}`);
    for (let d = 1; d < 6; d++) {
      const lvl = g.levelAt(d);
      g.player.depth = d; g.level = lvl;
      lvl.enemies.length = 0; lvl.markEnemiesDirty();
      for (let y = 1; y < lvl.h - 1; y++) {
        for (let x = 1; x < lvl.w - 1; x++) {
          if (!isDoor(lvl.at(x, y))) continue;
          const doubled = [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .some(([dx, dy]) => isDoor(lvl.at(x + dx, y + dy)));
          for (const dd of DIRS) {
            if (!dd.dx || !dd.dy) continue;
            const from = { x: x - dd.dx, y: y - dd.dy };
            if (!lvl.walkable(from.x, from.y)) continue;
            g.player.x = from.x; g.player.y = from.y;
            g.player.stamina = g.player.staminaMax;
            const moved = g.dash(1, dd);
            if (doubled) { wideTried++; if (moved) wideOk++; }
            else { narrowTried++; if (moved) narrowThrough++; }
          }
        }
      }
    }
  }
  assert(wideTried > 200 && narrowTried > 20,
         `not enough doorways sampled (${wideTried} wide, ${narrowTried} narrow)`);
  // Wide: you have room, so you may go through it corner-first.
  assert(wideOk / wideTried > 0.9,
         `only ${((100 * wideOk) / wideTried).toFixed(0)}% of diagonal rolls clear a double doorway`);
  // Narrow: the chokepoint rule survives exactly where it still means
  // something. Losing this would take away the defensive use of a doorway.
  assert(narrowThrough === 0,
         `${narrowThrough} diagonal rolls squeezed through a single-leaf doorway`);
  return `double ${((100 * wideOk) / wideTried).toFixed(0)}% through, single 0% - the pinch is only where it is narrow`;
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
  // Bearing used to buy a cheaper roll. Now that a roll costs a fixed price it
  // buys the thing weight actually controls: how fast the bar comes back, and
  // how much you can carry before overloading. Same promise, current mechanism.
  assert(heavy.player.regenRate(true) > hg0, 'bearing did not make recovery faster');
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

  // Block comments are stripped as well as line comments: the note explaining
  // why not to do this quotes the thing it is warning about, and a test that
  // cannot tell code from the comment describing it will fail on its own
  // documentation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(!/querySelector\('button'\)/.test(code),
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

check('every hero has a face and a figure', () => {
  // Two pieces each, and they are not interchangeable: the map sprite is a
  // shape seen from directly overhead, so shrinking it into a dialogue box
  // shows you the top of a head. Same split as the Fire Keeper's.
  const dir = new URL('../../assets/', import.meta.url);
  for (const h of HEROES) {
    assert(h.sprite && h.face, `${h.key} is missing art`);
    assert(existsSync(new URL(`${h.sprite}.png`, dir)), `${h.key} has no figure`);
    assert(existsSync(new URL(`${h.face}.png`, dir)), `${h.key} has no portrait`);
    // And the person standing in the hall is drawn as the same person.
    assert(NPC_BY_KEY[`hero:${h.key}`].sprite === h.sprite,
           `${h.key} looks like somebody else in the hall`);
  }
  return `${HEROES.length} heroes, ${HEROES.length * 2} pieces of art`;
});

check('the hall holds every hero, and you cannot leave as nobody', () => {
  // The room IS the character select, so it is built from the roster rather
  // than written out - a hero added to heroes.js turns up in the hall without
  // anyone remembering to put them there. A menu that can disagree with the
  // roster eventually will.
  const g = freshGame('hall');
  g.enterHub();
  assert(g.inHub, 'enterHub did not put us in the hall');
  for (const h of HEROES) {
    assert(g.level.npcs.some((n) => n.key === `hero:${h.key}`),
           `${h.key} is in the roster but not in the hall`);
    assert(NPC_BY_KEY[`hero:${h.key}`], `${h.key} has no one to talk to`);
  }
  assert(g.level.bonfires.length, 'no fire in the hall');
  assert(g.level.downStair, 'no way out of the hall');

  // Leaving without choosing would start a run as nobody.
  assert(g.descend() === false, 'you can start a run without being anybody');
  assert(g.inHub, 'a refused descent left the hall anyway');
  return `${HEROES.length} heroes, a fire and a stair`;
});

check('walking up to someone is how you become them', () => {
  for (const h of HEROES) {
    const g = freshGame(`take-${h.key}`);
    g.ui = Object.assign(new QuietUI(), { showConversation() {} });
    g.enterHub();
    const npc = g.level.npcs.find((n) => n.key === `hero:${h.key}`);
    g.player.x = npc.x - 1; g.player.y = npc.y;
    g.step(1, 0);
    assert(g.hero?.key === h.key, `walking into ${h.key} did not take them up`);
    // You can see who you would be before you commit: their verbs and their
    // pool, in the hall, before the stair.
    for (const k of h.skills) assert(g.player.hasSkill(k), `${h.key}'s ${k} is not on the bar`);
    assert(g.player.staminaMax === h.stamina.max, `${h.key}'s pool is not shown in the hall`);

    assert(g.descend() === true, `could not start a run as ${h.key}`);
    assert(!g.inHub && g.player.depth === 1, 'the stair did not start a run');
    assert(g.player.hero?.key === h.key, 'the run started as somebody else');
    for (const k of h.skills) assert(g.player.hasSkill(k), `${h.key} lost ${k} on the way down`);
  }
  return `${HEROES.length} heroes taken up and taken down`;
});

check('nothing acts in the hall', () => {
  // It is the one place with no clock. A room to decide in stops being that
  // the moment standing in it costs anything.
  const g = freshGame('hall-clock');
  g.enterHub();
  const t = g.turn;
  for (let i = 0; i < 20; i++) g.worldTurn();
  assert(g.turn === t, `the hall advanced ${g.turn - t} turns`);
  return 'no turn pressure';
});

check('turning a blade aside takes it away, and needs somewhere to put it', () => {
  // The knight's whole shape. It is the first ability that READS a telegraph
  // and spends it, which turns the thing the game is built on from information
  // into a resource - and the existing stagger only ever delayed a blow by a
  // turn, so cancellation had to be built.
  const { g, e } = arena('aside', 'husk', 1);
  g.player.hero = HERO_BY_KEY.knight;
  g.player.stamina = g.player.staminaMax;
  for (let i = 0; i < 12 && e.state !== STATE.WINDUP; i++) { g.player.hp = g.player.hpMax; g.worldTurn(); }
  assert(e.state === STATE.WINDUP, 'could not get anything to wind up');

  const was = { x: e.x, y: e.y };
  const dir = { dx: Math.sign(e.x - g.player.x), dy: Math.sign(e.y - g.player.y) };
  g.useSkill('turnaside', dir);
  assert(e.state !== STATE.WINDUP, 'the attack was not cancelled - only delayed?');
  assert(e.x !== was.x || e.y !== was.y, 'nothing was displaced');
  assert(g.player.x === was.x && g.player.y === was.y,
         'the knight did not take the ground it gave up');

  // And it does nothing to what it cannot move, which is why the largest
  // things in the game are his blind spot.
  const { g: g2 } = arena('aside-big', 'husk', 3);
  g2.player.hero = HERO_BY_KEY.knight;
  g2.level.enemies.length = 0; g2.level.markEnemiesDirty();
  const big = new Enemy('minotaur', g2.rng);
  g2.level.addEnemy(big, g2.player.x + 1, g2.player.y);
  big.aware = true;
  for (let i = 0; i < 20 && big.state !== STATE.WINDUP; i++) { g2.player.hp = g2.player.hpMax; g2.worldTurn(); }
  if (big.state === STATE.WINDUP) {
    g2.player.stamina = g2.player.staminaMax;
    g2.useSkill('turnaside', { dx: 1, dy: 0 });
    assert(big.state === STATE.WINDUP, 'a 2x2 was turned aside; it should not move for anyone');
  }
  return 'cancels and displaces, and bounces off anything immovable';
});

check('the soulbinder feeds on hitting things, and can spend herself', () => {
  const { g } = arena('binder', 'husk', 1);
  const p = g.player;
  p.hero = HERO_BY_KEY.binder;

  // Her basic attack is her only real recovery. Stated as the CONSEQUENCE
  // rather than as a number: this used to assert `staminaRegen === 1`, and a
  // rate of 1 turned out to be a perfectly good plan on its own - she could
  // wait two turns for a roll and siphon was merely an accelerator. What has
  // to be true is that landing one is worth a long, unaffordable wait.
  const perHit = SKILL_BY_KEY.siphon.refund;
  const perTurn = p.regenRate(true);
  const turnsPerHit = perHit / perTurn;
  assert(turnsPerHit >= 10,
    `one siphon is worth ${turnsPerHit} turns of standing still - waiting is a plan`);
  // And never zero, or there is a state she cannot act her way out of: siphon
  // is the one skill of hers that will not take payment in health.
  assert(perTurn > 0, 'a rate of zero is a soft lock, not a constraint');
  assert(!SKILL_BY_KEY.siphon.bleed, 'siphon now bleeds - the soft-lock argument needs revisiting');
  p.stamina = 3;
  const before = p.stamina;
  g.useSkill('siphon', { dx: 1, dy: 0 });
  assert(p.stamina > before, `siphon left her poorer (${before} -> ${p.stamina})`);

  // And when the bar cannot pay, she can.
  p.stamina = 1;
  const hp = p.hp;
  const ok = g.useSkill('lance', { dx: 1, dy: 0 });
  assert(ok, 'she could not pay for a lance at all');
  assert(p.hp < hp, 'the shortfall was not paid in health');
  assert(p.stamina === 0, 'she kept stamina she should have spent first');

  // But it will not kill her.
  p.stamina = 0; p.hp = 1;
  assert(g.useSkill('lance', { dx: 1, dy: 0 }) === false, 'bleeding for a skill killed her');
  return 'siphon feeds, lance bleeds, and it stops short of killing her';
});

check('the squire cannot stop once he has started', () => {
  // No wind-up, so nothing can interrupt it - the price is not risk, it is
  // that next turn is spent going the same way whether or not that is where
  // he wants to be.
  const { g } = arena('onward', 'husk', 6);
  const p = g.player;
  p.hero = HERO_BY_KEY.squire;
  p.stamina = p.staminaMax;
  const x0 = p.x;
  g.useSkill('onward', { dx: 1, dy: 0 });
  assert(p.x > x0, 'the charge did not move him');
  assert(p.forced, 'the charge did not commit him to a second stride');

  // Whatever he presses next, he charges again the same way.
  const x1 = p.x;
  const stam = p.stamina;
  g.useSkill('roll', { dx: -1, dy: 0 });
  assert(p.x > x1, 'he turned round mid-charge');
  assert(!p.forced, 'the second stride did not clear the commitment');
  assert(p.stamina === stam, 'the forced stride charged him twice');
  return 'goes out at once, and carries him again whether he likes it or not';
});

check('each hero pays differently, and that is what distinguishes them', () => {
  // Skills bind to a person now rather than a weapon, and the reason is
  // measured: twelve weapons produced only NINE distinct shape pairs, `front`
  // carried nine of twenty-four attacks, and longsword, mace and paired blades
  // were the same weapon mechanically. The variety was in the numbers.
  //
  // So what has to be genuinely distinct is the ECONOMY, not the shapes. It
  // checks the three engines really are three, in the terms that matter: how
  // much you can chain, how fast it comes back, and what a dodge costs.
  const seen = new Set();
  for (const h of HEROES) {
    const g = freshGame(`hero-${h.key}`);
    g.player.hero = h;
    assert(g.player.staminaMax === h.stamina.max, `${h.key} does not get its own pool`);
    assert(g.player.staminaRegen === h.stamina.regen, `${h.key} does not get its own recovery`);
    assert(g.player.rollDistance() === h.roll.distance, `${h.key} does not get its own roll`);

    // Every skill it names exists and is actually reachable as that person.
    for (const k of h.skills) {
      assert(SKILL_BY_KEY[k], `${h.key} knows a skill that does not exist: ${k}`);
      assert(g.player.hasSkill(k), `${h.key} cannot use its own ${k}`);
    }
    // Three combat skills, because the button grid has three combat slots.
    assert(h.skills.length === 3, `${h.key} has ${h.skills.length} skills, the bar holds 3`);

    // The signature: how many turns of standing still one dodge costs you.
    const turnsPerRoll = (h.roll.cost / h.stamina.regen).toFixed(2);
    const chain = Math.floor(h.stamina.max / h.roll.cost);
    seen.add(`${turnsPerRoll}/${chain}`);
  }
  assert(seen.size === HEROES.length,
         `${HEROES.length} heroes share only ${seen.size} economies - they are reskins`);
  return `${HEROES.length} heroes, ${seen.size} distinct economies`;
});

check('the wind track adds to who you are, it does not replace it', () => {
  // The souls track used to assign staminaMax outright from the global
  // constant, which would have silently erased a hero's whole identity the
  // first time you spent souls on it - the soulbinder's small deliberate pool
  // becoming everybody's pool.
  const g = freshGame('wind-hero');
  g.player.hero = HERO_BY_KEY.knight;
  const base = g.player.staminaMax;
  g.player.staminaBonus = 4;
  assert(g.player.staminaMax === base + 4, 'growth does not add to the hero');
  g.player.hero = HERO_BY_KEY.binder;
  assert(g.player.staminaMax === HERO_BY_KEY.binder.stamina.max + 4,
         'growth was welded to one hero instead of being carried');
  return 'growth stacks on the person rather than overwriting them';
});

/** A stretch of open floor `len` wide and 2 tall, hunted across seeds. */
function lane(len, hero = 'knight') {
  for (let seed = 0; seed < 60; seed++) {
    const g = new Game(null);
    g.ui = new QuietUI();
    g.newGame({ seed: `lane${len}-${seed}`, name: 'A', hero });
    for (const lvl of [g.level, g.levelAt(DUNGEON_DEPTH)]) {
      for (let y = 2; y < lvl.h - 3; y++) {
        for (let x = 2; x < lvl.w - len - 1; x++) {
          let ok = true;
          for (let dy = 0; dy < 2 && ok; dy++) {
            for (let dx = 0; dx < len && ok; dx++) if (!lvl.passable(x + dx, y + dy)) ok = false;
          }
          if (ok) { g.level = lvl; lvl.enemies.length = 0; return { g, lvl, x, y }; }
        }
      }
    }
  }
  return null;
}

check('a big creature does not shoot itself', () => {
  // Reported from play, and the player's diagnosis was exactly right: if it
  // can hit itself then the shot is not coming from the square nearest you.
  //
  // It launched from the ANCHOR. For a 2x2 firing east the very next tile is
  // its own shoulder, so the dragon shot itself for 4 every time. The melee
  // branch four lines above has always used `origin()`/`nearestTileTo` for
  // precisely this reason.
  const found = lane(11);
  assert(found, 'no open lane to test in');
  const { g, lvl, x, y } = found;
  const d = new Enemy('firstflame', g.rng);
  lvl.addEnemy(d, x, y);
  d.aware = true;
  g.player.x = x + 9; g.player.y = y;

  let selfHit = false, playerHit = false;
  for (let t = 0; t < 25; t++) {
    const dh = d.hp, ph = g.player.hp;
    g.worldTurn();
    if (d.hp < dh) selfHit = true;
    if (g.player.hp < ph) playerHit = true;
    g.player.hp = g.player.hpMax;      // this is about hits, not about dying
  }
  assert(!selfHit, 'the dragon damaged itself with its own ranged attack');
  // And the fix must not simply have made it miss - that looks identical.
  assert(playerHit, 'the dragon never hit the player either, so this proves nothing');
  return 'fires from the square nearest you, and still connects';
});

check('a charge lands one stride per turn, each one announced', () => {
  // Reported from play: the whole three-part charge resolved in a single turn.
  // It telegraphed all three stops at once and then ran the entire loop, so
  // the player got one decision against a three-part attack and could not
  // react to the middle of it at all.
  //
  // The old comment argued that telegraphing only the first stride would be
  // "three unannounced blows wearing one announcement". Right about the
  // danger, wrong about the fix: announce them one at a time.
  const found = lane(11);
  assert(found, 'no open lane to test in');
  const { g, lvl, x, y } = found;
  const m = new Enemy('minotaur', g.rng);
  lvl.addEnemy(m, x, y);
  m.aware = true;
  g.player.x = x + 9; g.player.y = y;

  const strides = [];
  let last = { x: m.x, y: m.y };
  for (let t = 0; t < 16; t++) {
    const telegraph = (m.attackTiles ?? []).map((v) => `${v.x},${v.y}`);
    g.worldTurn();
    g.player.hp = g.player.hpMax;
    if (m.x !== last.x || m.y !== last.y) {
      strides.push({ telegraph, movedTo: { x: m.x, y: m.y } });
      last = { x: m.x, y: m.y };
    }
  }
  const charges = strides.filter((s) => s.telegraph.length);
  assert(charges.length >= 2, `only ${charges.length} announced strides - the charge is not staged`);
  // Every stride must have been shown before it happened, and shown as ONE
  // stop: a 2x2 body strikes a 2x2 area, never the whole run at once.
  for (const s of charges) {
    assert(s.telegraph.length <= m.size * m.size,
      `a stride telegraphed ${s.telegraph.length} tiles - that is the whole run, not one stop`);
  }
  return `${charges.length} strides, each announced as ${m.size}x${m.size} the turn before`;
});

check('shoving something mid-swing moves its telegraph too', () => {
  // Reported from play. `attackTiles` is resolved once, in absolute
  // coordinates, when the wind-up starts - so a long wind-up that got shoved
  // left its marked squares behind and then landed a blow from a place its
  // owner was no longer standing in.
  const found = lane(8);
  assert(found, 'no open lane to test in');
  const { g, lvl, x, y } = found;
  const e = new Enemy('sentinel', g.rng);
  lvl.addEnemy(e, x + 3, y);
  e.aware = true;
  g.player.x = x + 1; g.player.y = y;
  for (let t = 0; t < 10 && e.state !== STATE.WINDUP; t++) {
    g.worldTurn();
    g.player.hp = g.player.hpMax;
  }
  assert(e.state === STATE.WINDUP, 'the sentinel never wound up');
  assert(e.attackTiles?.length, 'it wound up without a telegraph');

  const before = e.attackTiles.map((t) => `${t.x},${t.y}`);
  const at = { x: e.x, y: e.y };
  const moved = g.knockBack(e, { dx: 1, dy: 0 }, 2);
  assert(moved > 0, 'the sentinel would not be pushed, so this proves nothing');

  const shift = { dx: e.x - at.x, dy: e.y - at.y };
  const want = before.map((k) => {
    const [bx, by] = k.split(',').map(Number);
    return `${bx + shift.dx},${by + shift.dy}`;
  });
  const after = e.attackTiles.map((t) => `${t.x},${t.y}`);
  assert(after.join(' ') === want.join(' '),
    `telegraph did not follow the body: ${after.join(' ')} vs expected ${want.join(' ')}`);
  return `pushed ${moved}, and all ${after.length} marked tiles came with it`;
});

check('nothing else lives in the dragon hall', () => {
  // Reported from a winning run: bonfire, keeper, dragon and a crowd all in
  // the same room. Measured over 60 bottom floors, that was the MAJORITY -
  // 55% had a bonfire in the boss room, 28% the keeper, 60% other enemies, and
  // 75% had escorts standing inside a sanctuary.
  //
  // Two causes, both of them a rule that existed elsewhere and not here.
  // Bonfires are placed first and `randomFreeSpot` picks uniformly over tiles,
  // so the biggest room is the likeliest to have one - and "the boss takes the
  // biggest room" walked into it. And the escort loop was the only spawn call
  // in populate.js that did not pass avoidBonfires/avoidChambers.
  const bad = [];
  const N = 30;
  let escortTotal = 0;
  for (let i = 0; i < N; i++) {
    const g = new Game(null);
    g.ui = new QuietUI();
    g.newGame({ seed: `sanctum${i}`, name: 'A', hero: 'knight' });
    const lvl = g.levelAt(DUNGEON_DEPTH);
    const boss = lvl.enemies.find((e) => e.spec.boss);
    if (!boss) { bad.push(`seed ${i}: no boss on the bottom floor`); continue; }
    const room = lvl.roomAt(boss.x, boss.y);
    if (!room) { bad.push(`seed ${i}: the boss is not in a room`); continue; }
    const inArena = (x, y) => lvl.roomAt(x, y)?.id === room.id;

    if (lvl.bonfires.some((b) => inArena(b.x, b.y))) bad.push(`seed ${i}: a bonfire in the arena`);
    if (lvl.npcs.some((n) => inArena(n.x, n.y))) bad.push(`seed ${i}: an NPC in the arena`);
    const others = lvl.enemies.filter((e) => e !== boss && e.alive);
    if (others.some((e) => inArena(e.x, e.y))) bad.push(`seed ${i}: company in the arena`);
    if (others.some((e) => lvl.isSanctuary(e.x, e.y))) bad.push(`seed ${i}: an escort in a sanctuary`);

    // And the floor is still a floor: a fire to come back to, and an approach
    // that costs something. Zero escorts is as wrong as five in the arena.
    if (!lvl.bonfires.length) bad.push(`seed ${i}: nowhere to rest on the bottom floor`);
    if (!others.length) bad.push(`seed ${i}: the approach is free`);
    escortTotal += others.length;
  }
  assert(bad.length === 0, `${bad.length} faults, first few: ${bad.slice(0, 3).join('; ')}`);
  return `${N} bottom floors: the hall is the dragon's alone, ${(escortTotal / N).toFixed(1)} escorts on the way in`;
});

check('walking into something attacks it, whoever you are', () => {
  // Two of the three heroes could not attack by walking into things, and the
  // regression arrived with a feature: `meleeSkill()` preferred the main
  // weapon's `primary`, which was harmless while heroes were empty-handed and
  // wrong the moment they were given weapons. The squire holds a spear whose
  // primary is `thrust` - a real melee skill he does not have - so the bump
  // resolved to nothing at all. The binder was fine only by luck.
  //
  // The fourth time this question has been answered from the equipment rather
  // than from the live skill list. Pinned as a consequence for every hero, so
  // the next weapon change cannot quietly take the basic action away again.
  const broken = [];
  for (const h of HEROES) {
    const g = new Game(null);
    g.ui = new QuietUI();
    g.newGame({ seed: 'bump', name: 'A', hero: h.key });
    const p = g.player;

    let spot = null;
    for (let y = 2; y < g.level.h - 2 && !spot; y++) {
      for (let x = 2; x < g.level.w - 2 && !spot; x++) {
        if (g.level.passable(x, y) && g.level.passable(x + 1, y)) spot = { x, y };
      }
    }
    assert(spot, 'no two adjacent open tiles on floor one');
    p.x = spot.x; p.y = spot.y;

    g.level.enemies.length = 0;
    const e = new Enemy('husk', g.rng);
    e.x = p.x + 1; e.y = p.y; e.hp = 40; e.hpMax = 40;
    g.level.enemies.push(e);
    g.level.markEnemiesDirty();
    p.stamina = p.staminaMax;

    const skill = p.meleeSkill();
    if (!p.activeSkills().includes(skill)) {
      broken.push(`${h.key} bumps with ${skill}, which is not one of their skills`);
      continue;
    }
    g.step(1, 0);
    if (e.hp === 40) broken.push(`${h.key} walked into a husk and nothing happened`);
  }
  assert(broken.length === 0, broken.join('; '));
  return `${HEROES.length} heroes, each bumping with a skill they actually have`;
});

check('the weapon in a hero hand is worth picking up', () => {
  // The bug this pins: heroes started with empty hands, and affixes are
  // addressed through the weapon that grants the skill. A hero's verbs are not
  // on any weapon, so `itemGranting` returned null for all of them and every
  // affix in the game did nothing. Measured then: a spear with `keen` gave the
  // squire +5 weight and +0 of everything else. A third of the loot table was
  // a strict downgrade.
  //
  // So this asserts the consequence: for every hero, holding their own weapon
  // beats holding nothing, and an affix on it reaches their own first skill.
  const flat = [];
  for (const h of HEROES) {
    const g = new Game(null);
    g.ui = new QuietUI();
    g.newGame({ seed: 'kit', name: 'A', hero: h.key });
    const p = g.player;
    const first = h.skills[0];
    assert(p.item(SLOT.MAIN), `${h.key} starts empty-handed`);
    assert(p.item(SLOT.MAIN).family === h.family, `${h.key} starts holding the wrong family`);

    // Not "armed does more damage than bare" - that was the first version and
    // the binder failed it correctly. She starts on the bottom rung of her
    // family on purpose, so her opening focus is power 0 and adds nothing to
    // the number. What must be true of every hero is that the slot is not
    // DEAD, and for her it earns its place by carrying affixes. That something
    // better exists and costs her is the next test's job.
    const armed = p.mods(first).damage;
    p.equipItem(SLOT.MAIN, null);
    const bare = p.mods(first).damage;
    if (armed < bare) flat.push(`${h.key}: holding a weapon is worse than nothing`);

    p.equipItem(SLOT.MAIN, h.kit.main);
    p.affix[h.kit.main] = { granted: 'keen' };
    const withAffix = p.mods(first);
    if (withAffix.knock <= 0) flat.push(`${h.key}: keen does nothing to ${first}`);
  }
  assert(flat.length === 0, flat.join('; '));
  return `${HEROES.length} heroes: the slot is live, and affixes reach their own skills`;
});

check('every hero has something to trade up to, and it costs', () => {
  // "Weapons are restricted by family" only means something if each family is
  // a LADDER. Two separate collapses were found by measuring rather than by
  // reading: the blade family had no heavy end at all (power 0, 0, 1, 1), and
  // the binder's heaviest focus was free because her recovery is 1 and the
  // rate is floored at 1, so `regen: -1` bought her nothing.
  const bad = [];
  for (const h of HEROES) {
    const g = new Game(null);
    g.ui = new QuietUI();
    g.newGame({ seed: 'ladder', name: 'A', hero: h.key });
    const p = g.player;
    const first = h.skills[0];
    const fam = ITEMS.filter((i) => i.kind === 'weapon' && i.family === h.family);
    assert(fam.length >= 3, `${h.key}'s family has only ${fam.length} weapons`);

    const rungs = fam.map((it) => {
      p.equipItem(SLOT.MAIN, it.key);
      return { key: it.key, dmg: p.mods(first).damage,
               regen: p.regenRate(true), cost: p.costOf(first) };
    });
    const best = rungs.reduce((a, b) => (b.dmg > a.dmg ? b : a));
    const start = rungs.find((r) => r.key === h.kit.main);
    if (best.dmg <= start.dmg) bad.push(`${h.key} has nothing better than ${start.key}`);
    // And the best one must actually charge for it, in one currency or the
    // other. Otherwise the "choice" is just the biggest number.
    if (best.regen >= start.regen && best.cost <= start.cost) {
      bad.push(`${h.key}: ${best.key} is free power (regen ${best.regen} cost ${best.cost})`);
    }
  }
  assert(bad.length === 0, bad.join('; '));
  return `${HEROES.length} families, each with a costed top rung`;
});

check('a weapon that is not yours cannot be held', () => {
  const g = new Game(null);
  g.ui = new QuietUI();
  g.newGame({ seed: 'fam', name: 'A', hero: 'knight' });
  const p = g.player;
  const off = ITEMS.find((i) => i.kind === 'weapon' && i.family !== 'blade');
  const r = p.equipItem(SLOT.MAIN, off.key);
  assert(r.ok === false, `the knight picked up a ${off.name}`);
  assert(p.item(SLOT.MAIN).family === 'blade', 'the refusal still changed what he holds');
  // Armour stays unrestricted - the decision worth binding to a person is what
  // you swing, not what you wear.
  const plate = ITEMS.find((i) => i.kind === 'armour' && i.key === 'plate');
  assert(p.equipItem(SLOT.ARMOUR, plate.key).ok !== false, 'armour was restricted too');
  return `${off.name} refused, plate allowed`;
});

check('coming back makes you the same person', () => {
  // Reported: leave mid-run, press continue, and you are somebody else with an
  // empty button bar.
  //
  // saveGame had written `hero` since heroes existed. loadGame's field list
  // never read it back, so every resume produced a null hero - and because
  // skills bind to the person now, that is not a cosmetic loss: the three
  // combat verbs collapsed to `roll` alone (the empty bar, which reads as lost
  // equipment), the stamina economy fell back to the old global constants, and
  // the map figure reverted to the armour sprite, which is the pre-hero
  // character showing through.
  //
  // So this compares what the PLAYER would notice, not which keys are in the
  // blob - a field list is what was already wrong in two places.
  const g = new Game(null);
  g.ui = new QuietUI();
  g.newGame({ seed: 'ident', name: 'Ash', hero: 'squire' });
  const before = {
    hero: g.player.hero?.key, skills: g.player.activeSkills().join(','),
    staminaMax: g.player.staminaMax, staminaRegen: g.player.staminaRegen,
    rollCost: g.player.rollCost(), rollDistance: g.player.rollDistance(),
    sprite: g.player.sprite, armour: g.player.equip.armour, hpMax: g.player.hpMax,
  };
  assert(saveGame(g), 'a run refused to save');

  const g2 = new Game(null);
  g2.ui = new QuietUI();
  g2.newGame({ seed: 'unrelated', name: 'Nobody' });
  assert(loadGame(g2), 'the save would not load');
  const after = {
    hero: g2.player.hero?.key, skills: g2.player.activeSkills().join(','),
    staminaMax: g2.player.staminaMax, staminaRegen: g2.player.staminaRegen,
    rollCost: g2.player.rollCost(), rollDistance: g2.player.rollDistance(),
    sprite: g2.player.sprite, armour: g2.player.equip.armour, hpMax: g2.player.hpMax,
  };
  for (const k of Object.keys(before)) {
    assert(before[k] === after[k], `${k}: was ${before[k]}, came back ${after[k]}`);
  }
  assert(g2.hero === g2.player.hero, 'the game and the player disagree about who you are');
  return `${before.hero}: ${g2.player.activeSkills().length} skills, ${before.staminaMax} stamina, still ${before.sprite}`;
});

check('the hall cannot overwrite a run', () => {
  // pagehide saves, and "walk down" from the title screen goes to the hall -
  // so with this unguarded, opening the hall while a real run was saved would
  // replace it with a depth-0 non-run and offer to continue THAT. Resuming it
  // would build floor 0 out of the dungeon generator with nobody chosen.
  const g = new Game(null);
  g.ui = new QuietUI();
  g.newGame({ seed: 'ident', name: 'Ash', hero: 'squire' });
  saveGame(g);
  const run = saveSummary();

  g.enterHub();
  assert(g.inHub, 'enterHub did not put us in the hall');
  assert(saveGame(g) === false, 'the hall was allowed to save');
  const still = saveSummary();
  assert(still.depth === run.depth && still.hero === run.hero,
    `the hall overwrote the run: ${JSON.stringify(still)}`);
  return `hall save refused; the saved run is still ${run.hero} on floor ${run.depth}`;
});

check('the title screen can read a save it did not write', () => {
  // `16/undefined HP` was on the title screen of every returning player.
  //
  // saveGame deliberately omits hpMax because it is derived from armour, and
  // says so in a comment; saveSummary read `d.player.hpMax` regardless. The
  // two sat forty lines apart, agreeing on the rule in prose and breaking it
  // in code - so this pins the RESULT, every field the screen prints, rather
  // than the one field that happened to be wrong.
  const g = new Game();
  g.newGame({ seed: 'summary', name: 'Ash', hero: 'knight' });
  saveGame(g);
  const sum = saveSummary();
  assert(sum, 'no summary was written');
  for (const [k, v] of Object.entries(sum)) {
    assert(v !== undefined && v !== null, `summary.${k} is ${v}`);
  }
  assert(sum.hpMax === g.player.hpMax,
    `summary hpMax ${sum.hpMax} but the player has ${g.player.hpMax}`);
  return `${sum.hp}/${sum.hpMax} HP, depth ${sum.depth}, no undefined on the screen`;
});

check('a skill fires where the direction key points', () => {
  // The bug as the player met it: arm the old knight's thrust, press UP, and
  // the lunge came out at forty-five degrees. Dragging still worked, because a
  // drag hands over a real vector and the two straight-up-and-down cases were
  // the only broken ones.
  //
  // The cause was in patterns.js and is pinned there. This pins the SYMPTOM,
  // through the path a person actually uses - arm a skill, press a key - so
  // that the guarantee survives a rewrite of how aiming is wired.
  const g = new Game(null);
  g.ui = new QuietUI();
  g.newGame({ seed: 'aimkeys', name: 'Ash', hero: 'knight' });
  const p = g.player;

  // Stand somewhere with two clear tiles in every direction, rather than
  // skipping the directions that happen to face a wall. Skipping would have
  // quietly tested five of the eight and called that a pass - and the two
  // broken ones were straight up and straight down, exactly the kind of pair a
  // convenience filter loses.
  let spot = null;
  for (let y = 2; y < g.level.h - 2 && !spot; y++) {
    for (let x = 2; x < g.level.w - 2 && !spot; x++) {
      let ok = true;
      for (let dy = -2; dy <= 2 && ok; dy++) {
        for (let dx = -2; dx <= 2 && ok; dx++) if (!g.level.passable(x + dx, y + dy)) ok = false;
      }
      if (ok) spot = { x, y };
    }
  }
  assert(spot, 'no 5x5 of open floor on the first level to test from');
  p.x = spot.x; p.y = spot.y;

  const missed = [];
  for (const d of DIRS) {
    // Two tiles out: the far end of the thrust, so a shape that is merely the
    // right length in the wrong direction cannot pass by accident.
    const tx = p.x + d.dx * 2, ty = p.y + d.dy * 2;
    g.level.enemies.length = 0;
    const e = new Enemy('husk', g.rng);
    e.x = tx; e.y = ty; e.hp = 40; e.hpMax = 40;
    g.level.enemies.push(e);
    g.level.markEnemiesDirty();
    // Everything the previous swing left behind. `recover` is the one that
    // matters and was the one missing: with it set, the next command is spent
    // finishing the last blow, so seven of eight directions reported a miss
    // that was really the player still swinging at the one before.
    p.stamina = p.staminaMax; p.cooldowns = {}; p.hp = p.hpMax;
    p.forced = null; p.recover = 0; p.charging = null;
    p.x = spot.x; p.y = spot.y;
    g.aiming = 'thrust';              // what pressing the skill button sets
    // doCommand, not command: command() holds a `busy` flag for the whole
    // async turn, so eight un-awaited calls in a row would run the first and
    // silently drop seven - which is exactly what this test did until the
    // aiming state was still set afterwards and gave it away. doCommand is the
    // function that owns "a skill is armed and a direction arrives".
    g.doCommand(d.key);
    if (e.hp === 40) missed.push(d.name);
  }
  assert(missed.length === 0, `thrust missed a target dead ahead facing: ${missed.join(', ')}`);
  return `armed skill + direction key hits at range 2, all ${DIRS.length} ways`;
});

check('a shape is the same size whichever way you face', () => {
  // A latent bug, found the moment new shapes were added and measured.
  //
  // Patterns were written facing east and turned with a rotation matrix, which
  // is right for an arc and wrong for anything with DEPTH. Facing south-east
  // the unit vector is (0.71, 0.71), so (1,0) and (2,0) both round onto (1,1)
  // and a lane silently loses a tile. Measured across the table:
  //
  //   reach2  2 -> 1     a spear thrusting diagonally hit ONE tile
  //   line3   3 -> 2
  //   line6   6 -> 4     the pike's signature lane, a third shorter
  //   sweepR  5 -> 4     which puts a hole in the union the sweep pair exists
  //                      to guarantee
  //
  // Nothing on screen said why, because the telegraph is drawn from the same
  // function - it was not lying, it was just weaker, diagonally, invisibly.
  // `around2` had been fixed for this exact reason years of commits ago and
  // nobody thought to check the rest of the table.
  //
  // Shapes with depth are computed from the facing now instead of turned into
  // it. This pins the property rather than the technique: whatever a shape is
  // built from, it must be the same size in all eight directions.
  const wrong = [];
  for (const name of Object.keys(PATTERNS)) {
    const sizes = DIRS.map((d) => attackTiles(0, 0, d.dx, d.dy, name).length);
    const east = attackTiles(0, 0, 1, 0, name).length;
    if (Math.min(...sizes) !== east || Math.max(...sizes) !== east) {
      wrong.push(`${name}: ${east} east, ${Math.min(...sizes)}-${Math.max(...sizes)} around`);
    }
  }
  assert(wrong.length === 0, `shapes change size when you turn: ${wrong.join('; ')}`);

  // SIZE IS NOT AIM, and checking only the first cost a real bug.
  //
  // `Math.sign(dx) || 1` was meant to catch the zero vector. Straight north is
  // (0, -1), and `0 || 1` is 1 - so every computed shape fired at (1, -1)
  // instead. Straight up and straight down came out at forty-five degrees, for
  // the player and for every enemy with a lane, and the count was right the
  // whole time so this test passed.
  //
  // The property is now stated in terms of where the tiles ARE: every tile of
  // a directional shape has to lie in the half-plane you aimed at, and the
  // nearest one has to sit on the line you pointed along.
  const misaimed = [];
  for (const name of Object.keys(PATTERNS)) {
    if (RADIAL.has(name)) continue;
    const seen = new Map();
    for (const d of DIRS) {
      const tiles = attackTiles(0, 0, d.dx, d.dy, name);
      // Nothing may land behind you. (`behind` is the deliberate exception and
      // is checked the other way round.)
      const behind = tiles.filter((t) => (t.x * d.dx + t.y * d.dy) < 0);
      if (name === 'behind') {
        if (behind.length !== tiles.length) misaimed.push(`${name} facing ${d.name} is not behind you`);
        continue;
      }
      if (behind.length) misaimed.push(`${name} facing ${d.name} puts ${behind.length} tiles behind you`);
      // And eight different aims must produce eight different shapes. That is
      // the bug stated exactly: under `|| 1`, north produced the NORTH-EAST
      // tiles, so the two were identical.
      //
      // The first version of this check asserted the shape was centred on the
      // line you aimed along, which the sweeps promptly failed - a sweep is
      // off-centre on purpose, that is what makes it a swing. Testing a claim
      // the design does not make is how you end up bending the design to
      // satisfy the test, so it was replaced rather than exempted.
      const key = tiles.map((t) => `${t.x},${t.y}`).sort().join(' ');
      if (seen.has(key)) misaimed.push(`${name} aimed ${d.name} hits the same tiles as ${seen.get(key)}`);
      seen.set(key, d.name);
    }
  }
  assert(misaimed.length === 0, misaimed.slice(0, 4).join('; '));

  // The sweeps are a designed pair - stepping out of one is meant to walk into
  // the other - so their union has to be whole in every facing too.
  for (const d of DIRS) {
    const both = new Set([...attackTiles(0, 0, d.dx, d.dy, 'sweepL'),
                          ...attackTiles(0, 0, d.dx, d.dy, 'sweepR')].map((t) => `${t.x},${t.y}`));
    assert(both.size === 8, `the sweep pair covers ${both.size} tiles facing ${d.name}, not 8`);
  }
  return `${Object.keys(PATTERNS).length} shapes, same size and aimed where you pointed`;
});

check('every skill can be used in every direction', () => {
  // Every skill in the game, not just the ones the starting kit holds - each is
  // reached by equipping whatever grants it, which also proves every weapon in
  // the table can actually be wielded.
  for (const s of SKILLS) {
    const owner = s.always || s.needsShield
      ? null : ITEMS.find((i) => i.primary === s.key || i.secondary === s.key);
    // A skill is reached by equipping the weapon that grants it, or by BEING
    // the person who has it. Both routes are exercised, which also proves
    // every weapon can be wielded and every hero can use everything they own.
    const hero = HEROES.find((h) => h.skills.includes(s.key));
    assert(s.always || s.needsShield || owner || hero,
           `nothing grants ${s.key}: no weapon has it and no hero knows it`);
    for (const d of DIRS) {
      const { g } = arena(`skill:${s.key}:${d.key}`, 'husk', 2);
      if (hero) {
        g.player.hero = hero;
        assert(g.player.hasSkill(s.key), `${hero.key} does not have their own ${s.key}`);
      } else if (owner) {
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

check('changing floor is not travelling across one', () => {
  // Movement is derived by diffing positions, and a diff cannot tell "walked
  // one tile" from "was picked up and put somewhere else". A staircase is the
  // second kind: measured, it moves you about thirty tiles onto a map where
  // the old coordinates mean nothing. Played as movement, the camera slides
  // that whole distance every time you descend.
  const g = freshGame('stairs-fx');
  g.fx.enabled = true;
  const d = g.level.downStair;
  g.player.x = d.x; g.player.y = d.y;

  g.fx.clear(); g.fx.begin(0, g);
  g.descend();
  g.fx.end(g);
  const evs = g.fx.take();
  assert(g.player.depth === 2, 'the test did not actually descend');
  assert(!evs.some((e) => e.kind === 'move' || e.kind === 'knock'),
         'a staircase was logged as movement, so the camera slides across the floor');
  assert(evs.some((e) => e.kind === 'level'), 'a floor change drew no curtain');
  // And the curtain must not hold up the next thing you do - it is covering a
  // cut that already happened, not delaying one.
  assert(planCycle(evs).gateEnd === 0, 'the floor-change curtain gates input');

  // An ordinary step is still a step.
  // Any direction that is actually free: a body occupies its tile, and the
  // Fire Keeper stands near the fire you arrive beside.
  g.fx.clear(); g.fx.begin(0, g);
  for (const d of DIRS) {
    const nx = g.player.x + d.dx, ny = g.player.y + d.dy;
    if (!g.level.passable(nx, ny) || g.level.occupant(nx, ny)) continue;
    if (!g.level.diagonalOk(g.player.x, g.player.y, nx, ny, true)) continue;
    g.step(d.dx, d.dy);
    break;
  }
  g.fx.end(g);
  const step = g.fx.take().filter((e) => e.kind === 'move');
  assert(step.length === 1 &&
         Math.max(Math.abs(step[0].from.x - step[0].to.x),
                  Math.abs(step[0].from.y - step[0].to.y)) === 1,
         'an ordinary step stopped being logged as movement');
  return 'stairs draw a curtain and snap; a step still slides one tile';
});

check('the camera walks with you but does not flinch with you', () => {
  // Two failures, one on each side of the same line.
  //
  // Let the camera follow everything and a lunge swings the entire world -
  // that is the jitter that locking the camera to the player was introduced to
  // fix, and it must not come back through the animator.
  //
  // Let it follow nothing and walking is worse: the view arrives at the new
  // tile immediately while the sprite is still sliding in from the old one, so
  // the world jumps and the little figure visibly runs to catch up with its
  // own viewport.
  //
  // So the split is not player-versus-enemy, it is "displacement that means
  // you went somewhere" against "displacement that means something happened
  // to you".
  const a = new Animator(() => {});
  const lay = (evs) => {
    const plan = planCycle(evs);
    a.events = plan.events;
    a.span = plan.span;
    a.raf = 1;                       // pretend a frame loop is running
  };
  // Freeze the clock: the two accessors each read the time themselves, and
  // sampling them microseconds apart makes an exact comparison fail on the
  // far decimals of the easing curve.
  const at = (ms) => { a.now = () => ms; };

  lay([{ kind: 'move', uid: 0, round: 0, from: { x: 4, y: 7 }, to: { x: 5, y: 7 } }]);
  at(60);
  const walkAll = a.offsetFor(0);
  const walkCam = a.moveOffsetFor(0);
  assert(walkAll && walkCam, 'a walk produced no offset at all');
  assert(Math.abs(walkCam.dx - walkAll.dx) < 1e-9,
         'the camera does not follow the whole of a walk, so the sprite would lag it');

  lay([{ kind: 'attack', uid: 0, round: 0, dx: 1, dy: 0 },
       { kind: 'hit', uid: 0, round: 0 }]);
  at(70);
  const swing = a.offsetFor(0);
  assert(swing && swing.dx !== 0, 'a lunge moved the sprite nowhere');
  assert(a.moveOffsetFor(0) === null,
         'the camera follows a lunge, which swings the whole world on every swing');

  a.raf = 0;
  return 'camera carries movement, ignores lunges and flinches';
});

check('the show costs the same whether one thing acted or thirty', () => {
  // Measured before this was built: a turn contains 10 visible events at the
  // median (5040 turns sampled), and playing them one after another at 120ms
  // is 1.2 seconds - per turn, typically, not in the worst case. Staging by
  // kind of event instead of by actor is what makes the cost flat, and flat is
  // the whole reason the design is shaped this way.
  const hits = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'hit', uid: i + 1, round: 0 }));
  const spans = [1, 3, 8, 14, 30].map((n) =>
    planCycle([{ kind: 'attack', uid: 0, round: 0, dx: 1, dy: 0 }, ...hits(n)]).span);
  assert(new Set(spans).size === 1,
         `span grows with the crowd: ${spans.join(', ')}ms for 1/3/8/14/30 targets`);
  return `${spans[0]}ms for anything from 1 to 30 targets`;
});

check('a stage with nothing in it takes no time', () => {
  // This game is mostly walking. If every stage claimed its slot, a step down
  // an empty corridor would cost most of a second and exploring would feel
  // like wading.
  const walk = planCycle([{ kind: 'move', uid: 0, round: 0,
                            from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }]).span;
  const fight = planCycle([{ kind: 'attack', uid: 0, round: 0, dx: 1, dy: 0 },
                           { kind: 'hit', uid: 1, round: 0 }]).span;
  assert(planCycle([]).span === 0, 'an empty turn still costs time');
  assert(walk < fight, `walking (${walk}ms) is not cheaper than fighting (${fight}ms)`);
  return `walk ${walk}ms, fight ${fight}ms, idle 0ms`;
});

check('a corpse is never seen to swing, but everyone walks together', () => {
  // Two rules that used to be one, and separating them is what fixed enemies
  // stuttering across the floor.
  //
  // The rounds are kept apart so a creature you killed is never seen to act:
  // it was already dead when the survivors moved, and merging the stages would
  // have the show invent an attack it never made. That is a statement about
  // ATTACKS, where the order carries the causality.
  //
  // Walking carries none. You and they moved in the same turn, and showing it
  // that way is more truthful - so movement is deliberately exempt and plays
  // at once for both rounds. Keeping it separate cost the thing you spend most
  // of the game looking at: on a plain walking turn the enemies' slide was the
  // LAST half of a 235ms animation, so any input inside that window snapped it
  // off half-played, and at any normal walking pace that was nearly every
  // turn.
  const plan = planCycle([
    { kind: 'move', uid: 0, round: 0, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { kind: 'attack', uid: 0, round: 0, dx: 1, dy: 0 },
    { kind: 'hit', uid: 1, round: 0 },
    { kind: 'die', uid: 1, round: 0, x: 3, y: 3 },
    { kind: 'move', uid: 2, round: 1, from: { x: 9, y: 9 }, to: { x: 8, y: 9 } },
    { kind: 'attack', uid: 2, round: 1, dx: -1, dy: 0 },
    { kind: 'hit', uid: 0, round: 1 },
  ]);
  const at = (kind, round) => plan.events.find((e) => e.kind === kind && e.round === round)?.at;

  // The causal half: nothing of theirs SWINGS until your round is done.
  const lastOfYours = Math.max(...plan.events
    .filter((e) => e.round === 0 && e.kind !== 'move').map((e) => e.at));
  assert(at('attack', 1) >= lastOfYours,
         'their attack starts before your round has finished');

  // The exemption, checked on purpose rather than by the absence of test data.
  assert(at('move', 0) === 0 && at('move', 1) === 0,
         'movement is not shared between the rounds - enemies will stutter');

  // And a plain walk is only as long as one step.
  const walk = planCycle([
    { kind: 'move', uid: 0, round: 0, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { kind: 'move', uid: 1, round: 1, from: { x: 5, y: 5 }, to: { x: 4, y: 5 } },
  ]);
  assert(walk.span <= 140,
         `a walking turn takes ${Math.round(walk.span)}ms; it should be one step long`);
  return `walk ${Math.round(walk.span)}ms shared; their swing waits for yours`;
});

check('the log records what the finished state can no longer tell you', () => {
  // worldTurn resolves everything before anything can be drawn, so the show
  // cannot read the result - the dead are off the enemy list and the shoved
  // are already at their destination. Two things have to survive that.
  const { g, e } = arena('fxlog', 'husk', 1);
  g.fx.enabled = true;
  const p = g.player;
  p.equipItem(SLOT.MAIN, 'falchion');          // chop knocks things back
  p.stamina = p.staminaMax;

  // 1. knockback is movement CAUSED BY a hit, so it must not be filed as
  //    ordinary movement - played in the movement stage it would show the
  //    target flying backwards before the blow that pushed it.
  const dir = { dx: Math.sign(e.x - p.x), dy: Math.sign(e.y - p.y) };
  g.fx.clear(); g.fx.begin(0, g);
  g.useSkill('shove', dir);
  g.fx.end(g);
  const evs = g.fx.take();
  assert(evs.some((v) => v.kind === 'knock' && v.uid === e.uid),
         `a shove was logged as ${evs.map((v) => v.kind).join('/')}, not a knock`);
  assert(!evs.some((v) => v.kind === 'move' && v.uid === e.uid),
         'knockback was filed as ordinary movement');

  // 2. a death carries its own coordinates, because a moment later there is
  //    nothing left on the level to ask.
  g.fx.clear(); g.fx.begin(0, g);
  const where = { x: e.x, y: e.y };
  g.hurtEnemy(e, 999, true);
  g.level.removeDead();
  g.fx.end(g);
  const died = g.fx.take().find((v) => v.kind === 'die');
  assert(died, 'a death produced no event');
  assert(died.x === where.x && died.y === where.y,
         'the death event does not know where it happened');
  assert(!g.level.enemies.includes(e), 'the test did not actually remove the body');
  return 'knockback stays with the hit; deaths carry their own position';
});

check('the log is off unless something is going to draw it', () => {
  // The bot runs sixty thousand steps a sweep and must not build a list nobody
  // reads. Only the real UI turns this on.
  const g = freshGame('fxoff');
  assert(g.fx.enabled === false, 'the event log is on by default');
  g.fx.begin(0, g);
  g.fx.add({ kind: 'hit', uid: 1 });
  g.fx.end(g);
  assert(g.fx.take().length === 0, 'a disabled log still recorded events');
  return 'disabled by default, records nothing';
});

check('a pillar can hide a creature, but never a blow', () => {
  // Both halves, and they pull against each other.
  //
  // Pillars must hide things or an ambush is impossible and a colonnade is
  // decoration. But "every blow in the game is announced" is the rule the
  // whole combat system rests on, and a telegraph behind a pillar is not a
  // telegraph. So: you can be surprised by something being THERE, never by a
  // blow arriving.
  let seenCount = 0, hiddenCount = 0, windups = 0, hiddenWindups = 0, chambers = 0;
  let exposure = [];
  for (let s = 0; s < 16 && chambers < 6; s++) {
    const g = freshGame(`amb-${s}`, 'heavy');
    for (let d = 3; d < DUNGEON_DEPTH && chambers < 6; d++) {
      const lvl = g.levelAt(d);
      const ch = lvl.chambers?.[0];
      if (ch?.key !== 'colonnade') continue;
      const room = lvl.rooms.find((r) => r.id === ch.room);
      const inside = () => lvl.livingEnemies().filter((e) =>
        e.x >= room.x && e.x < room.x + room.w && e.y >= room.y && e.y < room.y + room.h);
      if (!inside().length) continue;
      chambers++;

      g.player.depth = d; g.level = lvl; g.levels.set(d, lvl);
      g.player.x = ch.anchors.lane[0].x; g.player.y = ch.anchors.lane[0].y;
      g.afterMove();
      for (const e of inside()) (lvl.isVisible(e.x, e.y) ? seenCount++ : hiddenCount++);

      const arch = inside().filter((e) => e.spec.attacks.some((a) => a.kind === 'ranged'));
      if (arch.length) {
        const shot = ch.anchors.lane.filter((t) =>
          arch.some((a) => hasLOS(lvl, a.x, a.y, t.x, t.y, 12))).length;
        exposure.push(shot / ch.anchors.lane.length);
      }

      for (let t = 0; t < 40; t++) {
        g.player.hp = g.player.hpMax; g.player.stamina = g.player.staminaMax;
        g.worldTurn(); g.afterMove();
        for (const e of lvl.livingEnemies()) {
          if (e.state !== STATE.WINDUP) continue;
          windups++;
          if (!lvl.isVisible(e.x, e.y)) hiddenWindups++;
        }
      }
    }
  }
  assert(chambers >= 3, `only found ${chambers} colonnades to check`);
  assert(hiddenCount > 0, 'the pillars hide nothing - an ambush is impossible here');
  assert(windups > 50, `only saw ${windups} wind-ups; not enough to trust the next line`);
  assert(hiddenWindups === 0,
         `${hiddenWindups} of ${windups} wind-ups were invisible - a blow arrived unannounced`);
  const avg = exposure.reduce((a, b) => a + b, 0) / Math.max(1, exposure.length);
  assert(avg > 0.05 && avg < 0.85,
         `${(100 * avg).toFixed(0)}% of the lane is under fire - that is a corridor, not a choice`);
  return `${hiddenCount} hidden vs ${seenCount} seen, ${windups} wind-ups all visible, ` +
         `${(100 * avg).toFixed(0)}% of lane under fire`;
});

check('a span is a corridor whose walls are missing', () => {
  // Three attempts to build this, and the failures are worth keeping:
  //
  //   pits      a wall you can see over. Contradicted the sentence it was
  //             built from, and read on screen as a row of polka dots.
  //   no terrain at all - which lost the corridor and left a room with
  //             archers in it.
  //   a bridge over a chasm, which is both: a real, made, narrow route whose
  //             borders are absence rather than stone.
  //
  // So what has to hold is exactly that combination.
  let checked = 0, covered = [];
  for (let s = 0; s < 25 && checked < 5; s++) {
    const g = freshGame(`span-${s}`);
    for (let d = 4; d < DUNGEON_DEPTH && checked < 5; d++) {
      const lvl = g.levelAt(d);
      const ch = lvl.chambers?.[0];
      if (ch?.key !== 'gauntlet' || !ch.anchors.ledge.length) continue;
      const arch = lvl.livingEnemies().filter((e) => e.spec.attacks.some((a) => a.kind === 'ranged'));
      if (arch.length < 2) continue;
      checked++;

      // 1. the route is real and you can walk it.
      assert(ch.anchors.span.length >= 4, 'the span is too short to be a crossing');
      for (const t of ch.anchors.span) {
        assert(lvl.walkable(t.x, t.y), `the span is not walkable at ${t.x},${t.y}`);
      }
      // ...and two lanes wide, because a one-wide route collapses every attack
      // shape in the game - the rule MAX_STRAIT exists to enforce.
      const rows = new Set(ch.anchors.span.map((t) => t.y));
      assert(rows.size === 2, `the span is ${rows.size} lanes wide, not 2`);

      // 2. what borders it is absence, not stone - so it can be seen and shot
      //    across, and only your feet are stopped.
      const mid = ch.anchors.span[ch.anchors.span.length >> 1];
      const sy = Math.sign(ch.anchors.ledge[0].y - mid.y) || 1;
      let border = null;
      for (let y = mid.y + sy; y !== ch.anchors.ledge[0].y; y += sy) {
        if (!lvl.walkable(mid.x, y)) { border = lvl.at(mid.x, y); break; }
      }
      assert(border === T.CHASM, 'the span is bordered by something other than the drop');
      assert(flyable(T.CHASM), 'arrows do not cross the drop - then it is just a wall');

      // 3. the far bank is reachable, the long way. "Go and deal with them"
      //    has to be an option or the bridge is a toll booth.
      const seen = new Set([`${mid.x},${mid.y}`]);
      const q = [mid];
      while (q.length) {
        const c = q.pop();
        for (const dd of DIRS) {
          const x = c.x + dd.dx, y = c.y + dd.dy, k = `${x},${y}`;
          if (seen.has(k) || !lvl.walkable(x, y)) continue;
          seen.add(k); q.push({ x, y });
        }
      }
      const reachable = ch.anchors.ledge.filter((t) => seen.has(`${t.x},${t.y}`)).length;
      assert(reachable > 0, 'the far bank cannot be reached at all - that is a wall');

      // 4. and crossing costs you: the span is under fire.
      const hot = ch.anchors.span.filter((t) =>
        arch.some((a) => hasLOS(lvl, a.x, a.y, t.x, t.y, 12))).length;
      covered.push(hot / ch.anchors.span.length);
    }
  }
  assert(checked >= 3, `only found ${checked} spans`);
  const avg = covered.reduce((a, b) => a + b, 0) / covered.length;
  assert(avg > 0.4, `only ${(100 * avg).toFixed(0)}% of the span is under fire - nobody is holding it`);
  return `${checked} spans: 2 lanes over the drop, ${(100 * avg).toFixed(0)}% under fire, far bank reachable`;
});

check('a broken floor breaks the route and not the sight', () => {
  // Deliberately the opposite of a colonnade. There the sight lines break and
  // the ground is open; here the ground breaks and the sight lines are open -
  // so circling the mound answers one thing closing on you and answers no
  // arrows at all.
  let checked = 0;
  for (let s = 0; s < 20 && checked < 5; s++) {
    const g = freshGame(`mound-${s}`);
    for (let d = 2; d < DUNGEON_DEPTH && checked < 5; d++) {
      const lvl = g.levelAt(d);
      const ch = lvl.chambers?.[0];
      if (ch?.key !== 'centrepiece') continue;
      const room = lvl.rooms.find((r) => r.id === ch.room);
      const cx = room.x + (room.w >> 1), cy = room.y + (room.h >> 1);
      if (lvl.at(cx, cy) !== T.RUBBLE) continue;
      checked++;

      // the route is broken
      assert(!lvl.walkable(cx, cy), 'the mound can be walked over');
      // the sight is not: straight across the middle, both ways
      const a = { x: cx, y: cy - 2 }, b = { x: cx, y: cy + 2 };
      if (lvl.walkable(a.x, a.y) && lvl.walkable(b.x, b.y)) {
        assert(hasLOS(lvl, a.x, a.y, b.x, b.y, 12),
               'the mound blocks sight - that is a colonnade, not a broken floor');
      }
    }
  }
  assert(checked >= 3, `only found ${checked} broken floors`);
  return `${checked} broken floors: feet stopped, eyes not`;
});

check('every situation says what it is for', () => {
  // docs/SITUATIONS.md: the intent line is the standard the result is judged
  // against, so a chamber without one is a chamber nobody can check.
  for (const c of CHAMBERS) {
    assert(c.intent && c.intent.length > 20, `${c.key} has no intent`);
    assert(typeof c.fits === 'function' && typeof c.build === 'function',
           `${c.key} is missing geometry`);
    assert(c.cast?.length, `${c.key} has no cast - it is a room, not a situation`);
    for (const part of c.cast) {
      assert(ROLES[part.role], `${c.key} casts an unknown role "${part.role}"`);
      assert(castFor(part.role, c.minDepth, ENEMY_BY_KEY),
             `${c.key} wants a ${part.role} at depth ${c.minDepth} and nothing can play it`);
    }
  }
  return `${CHAMBERS.length} situations, all castable at their own depth`;
});

check('a situation is cast exactly, not topped up at random', () => {
  // The composition IS the situation. Before the general placement learned to
  // skip these rooms, a colonnade of two archers and one blocker came out with
  // six things in it, which is not a decision, it is a crowd.
  let checked = 0;
  for (let s = 0; s < 14; s++) {
    const g = freshGame(`cast-${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      const lvl = g.levelAt(d);
      const ch = lvl.chambers?.[0];
      if (!ch) continue;
      const spec = CHAMBER_BY_KEY[ch.key];
      const room = lvl.rooms.find((r) => r.id === ch.room);
      const inside = lvl.livingEnemies().filter((e) =>
        e.x >= room.x && e.x < room.x + room.w && e.y >= room.y && e.y < room.y + room.h);
      const most = spec.cast.reduce((n, c) => n + c.n[1], 0);
      assert(inside.length <= most,
             `${ch.key} was cast for at most ${most} and came out with ${inside.length}`);
      checked++;
    }
  }
  assert(checked > 0, 'no chambers generated at all');
  return `${checked} chambers, none diluted`;
});

check('a situation never eats the fire or the chest', () => {
  let checked = 0;
  for (let s = 0; s < 14; s++) {
    const g = freshGame(`chroom-${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      const lvl = g.levelAt(d);
      for (const ch of lvl.chambers ?? []) {
        checked++;
        const room = lvl.rooms.find((r) => r.id === ch.room);
        assert(room, `${ch.key} points at a room that does not exist`);
        for (const b of lvl.bonfires) {
          assert(!(b.x >= room.x && b.x < room.x + room.w &&
                   b.y >= room.y && b.y < room.y + room.h),
                 'a situation was built on top of a bonfire');
        }
        if (lvl.store) assert(lvl.store.room !== ch.room, 'a situation ate the storeroom');
      }
    }
  }
  return `${checked} chambers, none on a fire or a chest`;
});

check('a colonnade can be walked through', () => {
  // Pillars with no gaps are a wall with extra steps. There has to be a way
  // between them or the "which lane" decision is not a decision.
  let checked = 0;
  for (let s = 0; s < 14; s++) {
    const g = freshGame(`cross-${s}`);
    for (let d = 3; d < DUNGEON_DEPTH; d++) {
      const lvl = g.levelAt(d);
      const ch = lvl.chambers?.[0];
      if (ch?.key !== 'colonnade') continue;
      checked++;
      // From every lane tile, at least one flank tile is reachable without
      // leaving the room - i.e. the pillar rows have holes in them.
      const reach = ch.anchors.lane.some((t) =>
        [[0, -1], [0, 1]].some(([dx, dy]) => lvl.walkable(t.x + dx, t.y + dy)));
      assert(reach, 'the pillar rows are solid - the colonnade is two corridors');
    }
  }
  assert(checked > 0, 'no colonnades generated');
  return `${checked} colonnades, all crossable`;
});

check('there is someone at the first fire, and nothing is standing on her', () => {
  let floors = 0, missing = 0, notAtFire = 0, buried = 0;
  for (let s = 0; s < 8; s++) {
    const g = freshGame(`keeper-${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      const lvl = g.levelAt(d);
      floors++;
      const n = lvl.npcs[0];
      if (!n) { missing++; continue; }
      const fire = lvl.bonfires[0];
      // Range two, not one: see placeKeeper. The ring touching the fire is the
      // ground you back into, and she cannot be pushed off it.
      const r = Math.max(Math.abs(n.x - fire.x), Math.abs(n.y - fire.y));
      if (r < 1 || r > 2) notAtFire++;
      if (lvl.enemyAt(n.x, n.y)) buried++;
    }
  }
  assert(missing === 0, `${missing} floors have nobody at the fire`);
  assert(notAtFire === 0, `${notAtFire} keepers are not within sight of the first bonfire`);
  assert(buried === 0, `${buried} keepers have something spawned on top of them`);
  return `${floors} floors, someone at every fire`;
});

check('a person never seals anything off', () => {
  // She is impassable - a person cannot be killed or pushed, so for anything
  // asking "can I get there" she is a wall. A wall placed automatically, every
  // floor, next to the route everyone arrives on. The thing that could go
  // badly wrong is her standing in the one gap between two halves of a level.
  //
  // Checked as reachability rather than as a placement rule, because the
  // placement rule is a heuristic and heuristics are what this needs
  // protecting from: tucking her into the most cornered tile sounded correct
  // and made her a plug in a doorway.
  const flood = (lvl, from, ignoreNpcs) => {
    const seen = new Set([`${from.x},${from.y}`]);
    const q = [from];
    while (q.length) {
      const c = q.pop();
      for (const d of DIRS) {
        const x = c.x + d.dx, y = c.y + d.dy, k = `${x},${y}`;
        if (seen.has(k)) continue;
        if (!lvl.inBounds(x, y)) continue;
        if (!isWalkable(lvl.at(x, y))) continue;
        if (!ignoreNpcs && lvl.npcAt(x, y)) continue;
        seen.add(k); q.push({ x, y });
      }
    }
    return seen;
  };
  let floors = 0, sealed = 0, lost = 0;
  for (let s = 0; s < 8; s++) {
    const g = freshGame(`seal-${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      const lvl = g.levelAt(d);
      const from = lvl.upStair ?? lvl.bonfires[0];
      if (!from) continue;
      floors++;
      const withHer = flood(lvl, from, false);
      const without = flood(lvl, from, true);
      // Only her own tile may be missing. Anything else means she is a plug.
      const missing = [...without].filter((k) => !withHer.has(k));
      const hers = lvl.npcs.map((n) => `${n.x},${n.y}`);
      const cut = missing.filter((k) => !hers.includes(k));
      if (cut.length) { sealed++; lost += cut.length; }
    }
  }
  assert(sealed === 0, `${sealed} floors have ground cut off by her (${lost} tiles)`);
  return `${floors} floors, nothing sealed off`;
});

check('she cannot be hit by anything, and it is not a flag that says so', () => {
  // The guarantee is structural, not declared. Every attack in the game
  // resolves through level.enemyAt, so a person - who lives in level.npcs -
  // is unreachable by all of them at once. A boolean like `invulnerable: true`
  // would only be as good as every future attack remembering to check it.
  const { g } = arena('keeper-hit', 'husk', 4);
  const p = g.player;
  const lvl = g.level;
  lvl.npcs.length = 0;
  lvl.npcs.push({ key: 'firekeeper', x: p.x + 1, y: p.y });
  const her = lvl.npcs[0];

  assert(lvl.enemyAt(her.x, her.y) === null, 'a person answers to enemyAt');
  assert(lvl.occupant(her.x, her.y) === her, 'a person is not counted as a body');

  // Swing into her with the widest thing in the game and nothing should change.
  p.equipItem(SLOT.MAIN, 'greataxe');
  p.stamina = p.staminaMax;
  const before = JSON.stringify(lvl.npcs);
  g.useSkill('rend', { dx: 1, dy: 0 });
  g.worldTurn();
  assert(JSON.stringify(lvl.npcs) === before, 'a person was changed by being attacked');

  // And walking into her is a conversation, not a swing - it must not spend
  // the turn, because she stands in a room nothing spawns in and charging for
  // a conversation held somewhere safe only teaches people not to have it.
  let spoke = null;
  g.ui.showConversation = (spec) => { spoke = spec.key; };
  p.x = her.x - 1; p.y = her.y;
  const turn = g.turn;
  const spent = g.step(1, 0);
  assert(spoke === 'firekeeper', 'walking into her did not start a conversation');
  assert(spent === false && g.turn === turn, 'talking spent a turn');
  assert(p.x === her.x - 1, 'the player walked through her');
  return 'unreachable by construction; talking is free';
});

check('every person has art and a way to be drawn', () => {
  const dir = new URL('../../assets/', import.meta.url);
  for (const n of NPCS) {
    assert(n.name && n.glyph && n.colour, `${n.key} is missing a name, glyph or colour`);
    assert(existsSync(new URL(`${n.sprite}.png`, dir)), `${n.key} has no map sprite`);
    // The face is optional, but a name that points at nothing is not.
    if (n.face) assert(existsSync(new URL(`${n.face}.png`, dir)), `${n.key} has no portrait`);
    assert(Array.isArray(n.greeting) && n.greeting.length, `${n.key} has nothing to say`);
  }
  return `${NPCS.length} person, art present`;
});

check('nothing spawns in the room with the fire in it', () => {
  // You respawn at a bonfire, and resting is refused while anything is hunting
  // you - so a pack spawned around the fire means the first thing a death buys
  // you is a fight you did not pick, at the exact moment the game promised a
  // breath. Keeping enemies off the fire's own tile never helped: they stood
  // next to it.
  //
  // Checked as a consequence over real floors rather than by asserting that
  // each placement function was passed the right flag - there are five ways an
  // enemy can be placed and the last one found was a *second* chest guard,
  // positioned by a loose box around the storeroom that reached next door.
  let floors = 0, inside = 0, adjacent = 0, enemies = 0, fewest = 99;
  for (let s = 0; s < 12; s++) {
    const g = freshGame(`fire-${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      const lvl = g.levelAt(d);
      floors++;
      const live = lvl.livingEnemies();
      enemies += live.length;
      fewest = Math.min(fewest, live.length);
      for (const e of live) {
        if (lvl.isSanctuary(e.x, e.y)) inside++;
        for (const b of lvl.bonfires) {
          if (Math.max(Math.abs(e.x - b.x), Math.abs(e.y - b.y)) <= 1) adjacent++;
        }
      }
    }
  }
  assert(inside === 0, `${inside} enemies spawned in a bonfire room`);
  assert(adjacent === 0, `${adjacent} enemies spawned next to a bonfire`);
  // And the floors did not go quiet to achieve it.
  assert(fewest >= 3, `a floor came out with only ${fewest} enemies`);
  return `${floors} floors, ${(enemies / floors).toFixed(1)} enemies each, none at a fire`;
});

check('a chest still has something standing over it', () => {
  // The other half. Keeping enemies away from fires must not quietly remove
  // the guard a storeroom is promised - the easy way to satisfy the rule above
  // is to stop placing things, and that would look identical from the outside.
  let stores = 0, guarded = 0;
  for (let s = 0; s < 12; s++) {
    const g = freshGame(`guard-${s}`);
    for (let d = 1; d < DUNGEON_DEPTH; d++) {
      const lvl = g.levelAt(d);
      if (!lvl.store) continue;
      const r = lvl.rooms.find((q) => q.id === lvl.store.room);
      if (!r) continue;
      stores++;
      if (lvl.livingEnemies().some((e) =>
            e.x >= r.x && e.x < r.x + r.w && e.y >= r.y && e.y < r.y + r.h)) guarded++;
    }
  }
  assert(stores > 0, 'no storerooms generated at all');
  assert(guarded === stores, `${stores - guarded} of ${stores} chest rooms lost their guard`);
  return `${stores} chest rooms, all guarded`;
});

check('a charge announces every stride it will take', () => {
  // Three strides behind one wind-up would be two unannounced blows if only
  // the first were drawn. The telegraph is the whole path.
  const { g } = arena('rush-tel', 'minotaur', 4);
  const m = g.level.enemies[0];
  assert(m.size === 2, 'the horned one is not two tiles a side');
  const charge = m.spec.attacks.find((a) => a.rush);
  assert(charge, 'the horned one has no charge');
  assert(charge.rush.times === 3 && charge.rush.advance === 2,
         'the charge is not three strides of two');

  // Drive it until it commits to something, then look at what it drew.
  let telegraphed = 0;
  for (let t = 0; t < 60 && m.alive; t++) {
    g.player.hp = g.player.hpMax;
    g.worldTurn();
    if (m.state === STATE.WINDUP && m.attack?.rush) {
      telegraphed = m.attackTiles.length;
      break;
    }
  }
  assert(telegraphed > 0, 'the horned one never charged in 60 turns');
  // Each stride threatens its own 2x2 footprint, so a full charge is 12 tiles
  // and a charge that runs out of room is fewer - never more, and never one.
  assert(telegraphed % 4 === 0 && telegraphed <= 12 && telegraphed >= 4,
         `a charge telegraphed ${telegraphed} tiles; expected 4, 8 or 12`);
  return `${telegraphed} tiles announced before it moved`;
});

check('a charge runs you down once, however many strides cover you', () => {
  // The rush hits with its own footprint at every stop, and those footprints
  // overlap where it stops short. Without a per-body guard, standing in the
  // wrong square would take the same blow twice from one charge.
  const { g } = arena('rush-once', 'minotaur', 3);
  const m = g.level.enemies[0];
  const p = g.player;
  const charge = m.spec.attacks.find((a) => a.rush);
  let hits = 0;
  const real = g.hurtPlayer.bind(g);
  g.hurtPlayer = (n, src, o) => { if (/charge/.test(src ?? '')) hits++; return real(n, src, o); };
  for (let t = 0; t < 80 && m.alive; t++) {
    p.hp = p.hpMax;
    const before = hits;
    g.worldTurn();
    // A single charge resolves inside one turn, so more than one hit from it
    // in a turn is the bug.
    assert(hits - before <= 1, `one charge landed ${hits - before} blows in a turn`);
  }
  return `charge blows all landed once each (${hits} total)`;
});

check('a charge stops at a wall instead of walking through it', () => {
  const { g } = arena('rush-wall', 'minotaur', 3);
  const lvl = g.level;
  const m = g.level.enemies[0];
  for (let t = 0; t < 80 && m.alive; t++) {
    g.player.hp = g.player.hpMax;
    g.worldTurn();
    // Wherever it has got to, it is standing somewhere its whole body fits.
    assert(lvl.bodyFits(m.x, m.y, m.size, m),
           `the horned one is standing at ${m.x},${m.y} where its body does not fit`);
    for (const t2 of m.bodyTiles()) {
      assert(lvl.walkable(t2.x, t2.y), `part of it is inside rock at ${t2.x},${t2.y}`);
    }
  }
  return 'never ends a charge inside the geometry';
});

check('a big body is one creature from every square it covers', () => {
  const { g } = arena('big-index', 'husk', 6);
  const lvl = g.level;
  lvl.enemies.length = 0; lvl.markEnemiesDirty();
  const d = new Enemy('firstflame', g.rng);
  lvl.addEnemy(d, g.player.x + 3, g.player.y - 1);
  assert(d.size === 2, 'the First Flame is not two tiles a side');
  assert(d.bodyTiles().length === 4, `a 2x2 covers ${d.bodyTiles().length} tiles`);
  for (const t of d.bodyTiles()) {
    assert(lvl.enemyAt(t.x, t.y) === d, `${t.x},${t.y} does not answer as the dragon`);
    assert(!lvl.passable(t.x, t.y) || lvl.occupant(t.x, t.y) === d,
           `${t.x},${t.y} is not occupied by it`);
  }
  return '4 squares, one creature';
});

check('an area attack hits a big body once, not once per square', () => {
  // THE bug this whole feature was going to arrive as. Every attack in the
  // game is a list of tiles, and the loop over them used to ask what was
  // standing on each one - so a shape overlapping three squares of a 2x2 dealt
  // its damage three times to one creature. It does not read as a resolution
  // bug from the outside; it reads as "big enemies are too weak", and this
  // project has a documented habit of tuning numbers at those.
  const { g } = arena('big-hit', 'husk', 6);
  const lvl = g.level;
  lvl.enemies.length = 0; lvl.markEnemiesDirty();
  const p = g.player;
  const d = new Enemy('firstflame', g.rng);
  lvl.addEnemy(d, p.x + 1, p.y - 1);          // its body straddles the arc
  p.equipItem(SLOT.MAIN, 'greataxe');          // rend: a five-tile arc
  p.stamina = p.staminaMax;

  const covered = attackTiles(p.x, p.y, 1, 0, SKILL_BY_KEY.rend.pattern)
    .filter((t) => lvl.enemyAt(t.x, t.y) === d).length;
  assert(covered >= 2, `the test did not overlap the body (${covered} tiles)`);

  const before = d.hp;
  g.useSkill('rend', { dx: 1, dy: 0 });
  // rend declares before it lands - it is one of the three attacks with a
  // wind-up - so the blow has to be resolved before there is any damage to
  // count.
  if (g.player.charging) g.resolveCharge();
  const dealt = before - d.hp;
  // What ONE blow is, asked of the game rather than restated. The bare
  // `SKILL_BY_KEY.rend.damage` was right until weapons started carrying power
  // of their own, and then this test failed for a reason that had nothing to
  // do with what it is about, which is that a body covering two tiles is hit
  // once and not twice.
  const once = SKILL_BY_KEY.rend.damage + p.mods('rend').damage;
  assert(dealt === once,
         `a ${covered}-tile overlap dealt ${dealt} damage; one blow is ${once}`);
  return `${covered} squares overlapped, ${dealt} damage dealt once`;
});

check('a big body does not set fire to itself', () => {
  // Its own attack covers its own squares. `other !== e` already handles it,
  // because every tile of a body returns the same object - so this is
  // immunity by identity rather than by a size check, and it cannot be
  // forgotten by whatever attack is added next.
  const { g } = arena('big-ff', 'husk', 8);
  const lvl = g.level;
  lvl.enemies.length = 0; lvl.markEnemiesDirty();
  const d = new Enemy('firstflame', g.rng);
  lvl.addEnemy(d, g.player.x + 2, g.player.y);
  d.aware = true;
  const before = d.hp;
  for (let i = 0; i < 30 && d.alive; i++) { g.player.hp = g.player.hpMax; g.worldTurn(); }
  assert(d.hp >= before, `it damaged itself down to ${d.hp} from ${before}`);
  return 'never hits itself, by identity';
});

check('a big body cannot be shoved, and can always be broken away from', () => {
  const { g } = arena('big-move', 'husk', 6);
  const lvl = g.level;
  lvl.enemies.length = 0; lvl.markEnemiesDirty();
  const p = g.player;
  const d = new Enemy('firstflame', g.rng);
  lvl.addEnemy(d, p.x + 1, p.y);
  const where = { x: d.x, y: d.y };
  assert(d.immovable, 'a 2x2 is not marked immovable');
  assert(g.knockBack(d, { dx: 1, dy: 0 }, 3) === 0, 'a dragon was shoved');
  assert(d.x === where.x && d.y === where.y, 'a dragon moved when pushed');

  // The geometric guarantee, and it changed when corridors did.
  //
  // A 2x2 used to fit 1.9% of corridor, so a big creature was room-bound and
  // could never follow you out. Two-wide corridors take that to 39% - the
  // horned one hunts you through the halls again, which is better than it
  // being stuck in a room, and was the point of widening them.
  //
  // What must survive is not "it cannot leave its room" but the thing that was
  // actually valuable about it: **there is always ground it cannot follow you
  // onto**. Breaking away from something enormous has to stay possible.
  let floors = 0, withRefuge = 0;
  for (let s = 0; s < 4; s++) {
    const gg = freshGame(`refuge-${s}`);
    for (let dep = 1; dep < DUNGEON_DEPTH; dep++) {
      const l = gg.levelAt(dep);
      floors++;
      let refuge = 0;
      for (let y = 0; y < l.h && refuge < 9; y++) {
        for (let x = 0; x < l.w && refuge < 9; x++) {
          if (isWalkable(l.at(x, y)) && !l.bodyFits(x, y, 2)) refuge++;
        }
      }
      if (refuge >= 9) withRefuge++;
    }
  }
  assert(withRefuge === floors,
         `${floors - withRefuge} of ${floors} floors have nowhere a big creature cannot follow`);
  return `immovable; every one of ${floors} floors has ground it cannot reach`;
});

check('the ground the dragon stands on is clear', () => {
  // Reported from play: the boss room was also the bridge chamber, with the
  // drop starting one tile off the span. Two separate mistakes met there.
  //
  // Chambers are stamped in mapgen and cast in populate - but populate returns
  // early on the bottom floor, because the boss floor is placed by hand. So a
  // chamber down here carved its terrain and never got its cast: pillars and
  // chasms cut into the sanctum for nothing at all. And since the boss takes
  // the largest room and chambers want large rooms too, they collided.
  //
  // The arena also has to be clear. Rubble and pits are scattered into every
  // room big enough to hold them, and the biggest room is exactly where the
  // dragon stands.
  for (let s = 0; s < 20; s++) {
    const g = freshGame(`arena-${s}`);
    const lvl = g.levelAt(DUNGEON_DEPTH);
    assert(!lvl.chambers?.length, `seed ${s}: a situation was built on the boss floor`);

    const boss = lvl.enemies.find((e) => e.spec.boss);
    assert(boss, `seed ${s}: no boss`);
    // The room the dragon is actually IN, not "the largest room". Those were
    // the same thing until the boss started skipping rooms that already have a
    // bonfire in them, and then this test began clearing its throat about a
    // hall the dragon had never been in. The claim is about the ground under
    // the fight, so it has to be found from the fight.
    const room = lvl.roomAt(boss.x, boss.y);
    assert(room, `seed ${s}: the boss is not in a room`);
    let open = 0;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        const t = lvl.at(x, y);
        assert(t !== T.RUBBLE && t !== T.PIT && t !== T.PILLAR && t !== T.CHASM,
               `seed ${s}: the arena has ${tileName(t)} in it`);
        if (lvl.walkable(x, y)) open++;
      }
    }
    // Enough ground for something four squares across to be fought rather than
    // cornered.
    assert(open >= 30, `seed ${s}: the arena is only ${open} tiles`);
  }
  return '20 bottom floors: no situation, no clutter, room to fight in';
});

check('the bottom floor always has a boss that fits on it', () => {
  // Making the boss 2x2 broke this immediately: "the middle of the biggest
  // room" is no longer somewhere it can necessarily stand, and neither the
  // original spot nor its fallback checked the footprint - two seeds in twenty
  // produced a bottom floor with no boss at all, which is a run that cannot be
  // won. Then ordinary enemies started spawning *inside* it, because the free
  // -spot search only ever marked a creature's anchor tile.
  for (let s = 0; s < 15; s++) {
    const g = freshGame(`bossfit-${s}`);
    const lvl = g.levelAt(DUNGEON_DEPTH);
    const b = lvl.enemies.find((e) => e.spec.boss);
    assert(b, `seed ${s}: the bottom floor has no boss`);
    for (const t of b.bodyTiles()) {
      assert(lvl.enemyAt(t.x, t.y) === b,
             `seed ${s}: something else is standing inside the boss`);
    }
  }
  return '15 bottom floors, a whole boss on each';
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
