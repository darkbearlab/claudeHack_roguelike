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
// The corollary is the part that keeps catching me out: when the bot dies a
// lot, the first question is whether the bot is playing badly, not whether the
// numbers are wrong. Three times now a "balance problem" has turned out to be
// this file - enemies banking energy, silent attackers not modelled at all,
// and the bot never walking back to a bonfire. Check the policy first.
//
//   node tools/botrun.mjs [runs] [maxTurns]
//   node tools/botrun.mjs --report      per-floor deaths, killers, per-vow split
//   node tools/botrun.mjs --light       one vow only; a mixed run averages the
//   node tools/botrun.mjs --heavy       trade away just as you try to measure it
//   WHY=1 node tools/botrun.mjs ...     print stamina / adjacency / escape routes
//   STAM=1 node tools/botrun.mjs ...    the stamina economy: how often the bar
//                                       is actually the thing stopping you.
//                                       Costs are only costs if this is nonzero.
//                                       at each death. This is what showed the
//                                       bot dying at full stamina with six ways
//                                       out, which is a policy bug wearing a
//                                       balance problem's clothes.
//
// The policy, in priority order:
//   1. standing in a telegraphed tile -> get out (roll if affordable, else walk)
//   2. an enemy is recovering and adjacent -> hit it, that is the whole game
//   3. an enemy is winding up, adjacent, and its poise can actually be broken
//      in the time available -> stagger it
//   3b. losing the trade against a silent attacker -> break contact
//   4. low stamina and nothing threatening -> wait and breathe
//   5. hurt and unengaged -> walk back to the bonfire and rest
//   6. otherwise advance towards the stairs

import { Game, DUNGEON_DEPTH } from '../js/game/game.js';
import { RNG } from '../../engine/rng.js';
import { DIRS, dist } from '../../engine/util.js';
import { astar } from '../../engine/path.js';
import { STATE } from '../js/game/actors.js';
import { SKILL_BY_KEY } from '../js/data/skills.js';
import { ITEM_BY_KEY, SLOT } from '../js/data/items.js';
import { T, isBonfire, isChest, isCorpse } from '../js/map/tiles.js';

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

/**
 * How much damage an adjacent enemy is worth per turn.
 *
 * This began as a model of untelegraphed attacks, which no longer exist - every
 * blow is announced now. What it measures is still worth measuring, though:
 * standing next to something has a running cost whether or not you can read the
 * blow, because reading it does not mean you can afford to answer it every
 * time.
 */
function pressure(e) {
  if (!e.alive || !e.aware) return 0;
  let worst = 0;
  for (const a of e.spec.attacks) {
    if (a.kind === 'ranged') continue;
    let dmg = a.damage, n = a.next;
    while (n) { dmg += n.damage; n = n.next; }
    worst = Math.max(worst, dmg / (a.windup + a.recovery));
  }
  return worst;
}

/**
 * Is standing here and swinging going to end well?
 *
 * Compares the chip damage that cannot be avoided against the time needed to
 * clear what is causing it. This is the calculation a human makes without
 * noticing - "there are three of them and I am on half health, back off" - and
 * it is the one the bot was missing entirely.
 */
function losingTheTrade(game, adj) {
  const p = game.player;
  let incoming = 0, work = 0;
  for (const { e } of adj) {
    incoming += pressure(e);
    work += Math.ceil(e.hp / (arms(p).prim.damage || 1));
  }
  if (incoming <= 0) return false;
  return incoming * work >= p.hp;
}

function safeSteps(game, danger) {
  const p = game.player;
  const out = [];
  for (const d of DIRS) {
    const nx = p.x + d.dx, ny = p.y + d.dy;
    if (!game.level.passable(nx, ny)) continue;
    if (game.level.enemyAt(nx, ny)) continue;
    if (!game.level.diagonalOk(p.x, p.y, nx, ny, true)) continue;
    if (inDanger(danger, nx, ny)) continue;
    out.push(d);
  }
  return out;
}

/**
 * Where a roll in direction `d` would actually put you.
 *
 * The bot used to assume a roll landed exactly `rollDistance` tiles away, which
 * is wrong next to a wall and wrong next to a body - and "I thought I was out"
 * is precisely the mistake the new attack shapes punish. This mirrors
 * Game.dash() exactly rather than approximating it.
 */
function rollLanding(game, d) {
  const p = game.player;
  const lvl = game.level;
  let x = p.x, y = p.y, moved = 0;
  for (let i = 0; i < p.rollDistance(); i++) {
    const nx = x + d.dx, ny = y + d.dy;
    if (!lvl.passable(nx, ny)) break;
    if (lvl.enemyAt(nx, ny)) break;
    if (!lvl.diagonalOk(x, y, nx, ny)) break;
    x = nx; y = ny; moved++;
  }
  return { x, y, moved };
}

/**
 * The best way out of a threatened tile, roll first.
 *
 * Rolls are searched *independently* of single steps now. Under the old
 * reach-1 roster any tile a roll could reach was reachable by walking too, so
 * the bot only ever considered rolling in a direction it could already walk.
 * Against a six-tile lance or a full sweep that is exactly backwards: the whole
 * reason those shapes exist is that no single step escapes them, so the search
 * that starts from single steps finds nothing and the bot stands there and dies.
 */
function escapeRoutes(game, danger) {
  const p = game.player;
  const rolls = [];
  if (p.stamina >= p.rollCost()) {
    for (const d of DIRS) {
      const land = rollLanding(game, d);
      if (!land.moved) continue;
      if (inDanger(danger, land.x, land.y)) continue;
      rolls.push({ d, land });
    }
    // Furthest from trouble, so we do not roll out of one arc into the next.
    rolls.sort((a, b) => nearestEnemy(game, b.land.x, b.land.y) -
                         nearestEnemy(game, a.land.x, a.land.y));
  }
  return { rolls, steps: safeSteps(game, danger) };
}

/**
 * Is hitting this thing actually going to stop it?
 *
 * Poise turned "always trade into the wind-up" from the correct answer into a
 * way to die holding a brute's overhead. The bot now checks the arithmetic: it
 * only commits if the interrupt can land before the blow does.
 */
function canInterrupt(player, e) {
  if (e.state !== STATE.WINDUP) return false;
  const per = arms(player).prim.impact ?? 0;
  const turns = Math.max(1, e.timer);
  const affordable = Math.floor(player.stamina / player.costOf(arms(player).prim.key));
  return per * Math.min(turns, affordable) >= e.poiseLeft;
}

/**
 * The two attacks the bot is actually holding.
 *
 * This used to be the literals `strike` and `sweep` in nine places - the
 * longsword's skills - so the bot could only play a longsword, and every
 * measurement it produced was a measurement of one weapon. That is the same
 * mistake as `step()` hardcoding 'strike', recorded in DESIGN.md, arriving a
 * second time in a different file. The fix is the same: ask what is in your
 * hand.
 */
/**
 * Can you actually attack by walking into it?
 *
 * Walking into something uses your *primary*, and two weapons have a primary
 * with a cooldown (dagger's lunge, hatchet's bury). While it is ticking the
 * bump is refused and **no turn passes** - so a bot that keeps choosing it
 * spins forever, and every run with those two weapons died at floor 2. It
 * stayed invisible because the bot only ever carried a longsword, whose
 * primary is free.
 */
function canBump(p) {
  const { prim } = arms(p);
  const slot = p.skill(prim.key);
  return !!slot && slot.cd === 0 && p.hasSkill(prim.key) && p.canAfford(p.costOf(prim.key));
}

function arms(p) {
  const main = p.item(SLOT.MAIN);
  const prim = SKILL_BY_KEY[main?.primary] ?? SKILL_BY_KEY.strike;
  const sec = SKILL_BY_KEY[main?.secondary] ?? null;
  return { prim, sec };
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

  // How much stamina to keep in hand before swinging.
  //
  // The bot used to hold back exactly one roll, always. That is fine for the
  // heavy vow, which can absorb the hit it fails to dodge, and quietly fatal
  // for the light one, which cannot: it would attack down to a single roll,
  // spend it, and then stand in the next telegraph with nothing left. Measured
  // over sixteen runs that one policy produced 12 deaths a run on heavy and 56
  // on light - which looked exactly like a balance problem in the vows and was
  // a bot playing the fragile character like the armoured one.
  //
  // Squishier characters, and hurt ones, keep a second roll in reserve.
  const fragile = p.hpMax <= 13 || p.hp <= p.hpMax / 2;
  const reserve = rollCost * (fragile ? 2 : 1);

  // 1. Standing somewhere that is about to be hit? Leave.
  if (inDanger(danger, p.x, p.y)) {
    const out = escapeRoutes(game, danger);
    // Roll first: it clears two tiles AND does not spend the turn, so it is
    // the only answer to a shape that a single step cannot leave.
    if (out.rolls.length) return { kind: 'skill', key: 'roll', dir: out.rolls[0].d };
    if (out.steps.length) return { kind: 'move', dir: out.steps[0] };

    // Cornered - which is exactly the case block exists for. Rolling does not
    // advance the turn, so wherever there is room to move, moving is better;
    // this is the branch where there is no room.
    if (p.shield && p.hasSkill('block') && p.stamina >= p.costOf('block')) {
      const threat = adjacentEnemies(game).find((a) => a.e.state === STATE.WINDUP)
                  ?? adjacentEnemies(game)[0];
      if (threat) return { kind: 'skill', key: 'block', dir: threat.d };
    }

    // Interrupting is a calculation rather than a reflex - if the poise maths
    // does not work we are going to eat the blow either way, so spend the turn
    // on damage instead of on a stagger that will not happen.
    const winding = adjacentEnemies(game).filter((a) => a.e.state === STATE.WINDUP);
    const stoppable = winding.find((a) => canInterrupt(p, a.e));
    if (stoppable && p.stamina >= p.costOf(arms(p).prim.key)) {
      if (canBump(p)) return { kind: 'move', dir: stoppable.d };
    }
    if (winding.length && p.stamina >= p.costOf(arms(p).prim.key)) {
      if (canBump(p)) return { kind: 'move', dir: winding[0].d };
    }
  }

  const adj = adjacentEnemies(game);

  // 2. Punish recovery. This is the entire game.
  const open = adj.find((a) => a.e.state === STATE.RECOVER || a.e.state === STATE.RESTING);
  if (open) {
    const { sec } = arms(p);
    const slot = sec && p.skill(sec.key);
    if (adj.length >= 2 && slot && slot.cd === 0 && p.hasSkill(sec.key)
        && p.stamina >= p.costOf(sec.key) + reserve) {
      return { kind: 'skill', key: sec.key, dir: open.d };
    }
    if (canBump(p) && p.stamina >= p.costOf(arms(p).prim.key) + reserve) return { kind: 'move', dir: open.d };
  }

  // 3. Stagger a wind-up - but only when it will actually land, and only with
  //    stamina spare to leave afterwards. Standing next to something whose
  //    poise you cannot break is just choosing to be hit.
  const winding = adj.find((a) => a.e.state === STATE.WINDUP && canInterrupt(p, a.e));
  if (winding && p.stamina >= p.costOf(arms(p).prim.key) + reserve) {
    if (canBump(p)) return { kind: 'move', dir: winding.d };
  }

  // 3b. Losing the trade. There is no telegraph to read against a silent
  //     attacker, so the only way to stop taking damage is to stop being
  //     adjacent - and a bonfire is the only place hp comes back.
  if (adj.length && (losingTheTrade(game, adj) || p.hp <= p.hpMax / 3)) {
    const out = escapeRoutes(game, danger);
    // A roll that lands you back in reach is just stamina spent to stand
    // somewhere else, so break contact or do not bother.
    const clear = out.rolls.find((r) => nearestEnemy(game, r.land.x, r.land.y) > 1);
    if (clear) return { kind: 'skill', key: 'roll', dir: clear.d };
    const home = p.bonfire && p.bonfire.depth === p.depth ? p.bonfire : null;
    if (home) {
      const path = astar(lvl, p.x, p.y, home.x, home.y, { maxNodes: 3000 });
      if (path && path.length) {
        const d = DIRS.find((q) => q.dx === path[0].x - p.x && q.dy === path[0].y - p.y);
        if (d && !lvl.enemyAt(path[0].x, path[0].y) &&
            lvl.diagonalOk(p.x, p.y, path[0].x, path[0].y, true)) {
          return { kind: 'move', dir: d };
        }
      }
    }
    if (out.steps.length) {
      const away = out.steps.sort((a, b) => nearestEnemy(game, p.x + b.dx, p.y + b.dy) -
                                            nearestEnemy(game, p.x + a.dx, p.y + a.dy))[0];
      return { kind: 'move', dir: away };
    }
  }

  // 4. Breathe. Never enter a fight without enough for one dodge.
  if (p.stamina < reserve + p.costOf(arms(p).prim.key)) {
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

  // 4b. Hurt, and carrying something that fixes that. Drinking costs the turn,
  //     so it is only right when the alternative is worse - which is why it
  //     waits for half health rather than topping up after every scratch.
  const flask = p.prepared('item');
  if (flask?.heal && p.chargesOf(flask.key) > 0 && p.hp <= p.hpMax / 2) {
    // Drinking costs stamina as well as the turn, so it competes with getting
    // out. Never drink yourself into a bar you cannot dodge on.
    const afterwards = p.stamina - p.costOf('prep:item');
    const exposed = adj.length > 0 || inDanger(danger, p.x, p.y);
    if (!exposed && afterwards >= rollCost) return { kind: 'skill', key: 'prep:item', dir: null };
  }

  // 4c. Standing on something worth taking. Free, and it exercises the whole
  //     loot-and-lose-it loop in every run rather than only in the tests.
  const here = lvl.at(p.x, p.y);
  if (isChest(here) || isCorpse(here)) return { kind: 'take' };

  // 5. Head down. Rest whenever a bonfire is underfoot and we are hurt - but
  //    you cannot sit down while something is hunting you, and a refused rest
  //    spends no turn, so asking anyway is an infinite loop. Break away or kill
  //    it first, which is what the rule is for.
  const hunted = game.hunters() > 0;
  if (isBonfire(lvl.at(p.x, p.y)) && p.hp < p.hpMax && !hunted) return { kind: 'rest' };

  // 5b. Hurt, and nothing is on us right now: walk back to the fire.
  //
  // The single largest bot flaw, and it masqueraded as a balance problem for a
  // long time. Health only comes back at a bonfire, and the bot would only rest
  // at one it happened to be standing on - so it ground itself down across a
  // floor, died at full stamina with half a dozen escape routes open and one
  // enemy next to it, respawned, and did it again. The damage-source table
  // blamed whatever happened to land the last two points.
  //
  // It also flattered the heavy vow, which takes roughly half the chip damage
  // and so survives the same bad policy about twice as long: that is where most
  // of the apparent gap between the two vows was coming from.
  //
  // Resting is not free - it brings the whole floor back - so this waits until
  // half health, which is roughly the point where one more telegraph you misread
  // is fatal.
  if (p.hp <= p.hpMax / 2 && !hunted && p.bonfire && p.bonfire.depth === p.depth && !adj.length) {
    const path = astar(lvl, p.x, p.y, p.bonfire.x, p.bonfire.y, { maxNodes: 4000 });
    if (path && path.length) {
      const step = path[0];
      const d = DIRS.find((q) => q.dx === step.x - p.x && q.dy === step.y - p.y);
      const when = danger.get(`${step.x},${step.y}`);
      if (d && !lvl.enemyAt(step.x, step.y) &&
          lvl.diagonalOk(p.x, p.y, step.x, step.y, true) &&
          (when === undefined || when >= 2)) {
        return { kind: 'move', dir: d };
      }
    }
  }
  if (lvl.at(p.x, p.y) === T.STAIRS_DOWN) return { kind: 'descend' };

  const goal = lvl.downStair ?? lvl.upStair;
  if (goal) {
    const path = astar(lvl, p.x, p.y, goal.x, goal.y, { maxNodes: 4000, avoidHazards: false });
    if (path && path.length) {
      const step = path[0];
      const d = DIRS.find((q) => q.dx === step.x - p.x && q.dy === step.y - p.y);
      const blocker = lvl.enemyAt(step.x, step.y);
      if (blocker && canBump(p)) return { kind: 'move', dir: d };   // walk into it = attack
      // A tile that is threatened two or more turns out is fine to walk
      // through - you will be gone before it resolves. Refusing every
      // threatened tile made the bot sit still for 20,000 turns whenever an
      // archer had a corridor covered, which is a bot flaw, not a level flaw.
      const when = danger.get(`${step.x},${step.y}`);
      // Bodies block diagonals for the player now, so a path step can be
      // illegal by the time we take it. Walking into it spends no turn, and the
      // run stalls - so check before committing.
      if (d && lvl.diagonalOk(p.x, p.y, step.x, step.y, true) &&
          (when === undefined || when >= 2)) return { kind: 'move', dir: d };
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
      if (d && lvl.diagonalOk(p.x, p.y, path[0].x, path[0].y, true)) return { kind: 'move', dir: d };
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
  // WEAPON=pike. The bot has always carried the starting sword, and that has
  // already hidden one whole class of bug (step() hardcoding 'strike' meant
  // mace-and-shield could not attack with the direction keys, and nothing
  // noticed because nothing ever held a mace). Anything that changes how a
  // weapon behaves - wind-up, recovery, two-handedness - is invisible to a
  // run that never picks one up.
  if (process.env.WEAPON) {
    const w = ITEM_BY_KEY[process.env.WEAPON];
    if (w) {
      game.player.equipItem(SLOT.MAIN, w.key);
      if (w.hands === 2) game.player.equipItem(SLOT.OFF, null);
    }
  }
  if (useShield) {
    const sh = game.player.pack.find((k) => ITEM_BY_KEY[k]?.kind === 'shield');
    if (sh) game.equipFromPack('off', sh);
  }

  const mix = {};
  // STAM: the stamina economy has never been observable. WHY prints the bar at
  // the moment of death, ACTMIX prints what the bot did - neither can answer
  // "was stamina ever the thing stopping you?", which is the only question that
  // matters when deciding whether a cost is a cost at all.
  const stam = { turns: 0, broke: 0, floor: 0, sum: 0, min: 99, walkedBroke: 0, waited: 0, waitedBroke: 0, waitCd: 0, waitRich: 0 };
  const floorDeaths = new Map();
  const killers = new Map();
  let steps = 0, stall = 0, lastTurn = -1, lastAction = null;

  // What is actually landing the killing blow. Per-floor death counts say
  // *where* the difficulty is; this says *what* it is, which is the number you
  // need before touching any of the tuning.
  const die = game.die.bind(game);
  game.die = (source) => {
    killers.set(source, (killers.get(source) ?? 0) + 1);
    if (process.env.WHY) {
      const p = game.player, lvl = game.level;
      let adj = 0;
      for (const d of DIRS) { const e = lvl.enemyAt(p.x + d.dx, p.y + d.dy); if (e?.alive) adj++; }
      const danger = dangerTiles(game);
      const outs = safeSteps(game, danger).length;
      console.log(`  died: ${source} | st=${p.stamina} adj=${adj} safeSteps=${outs} depth=${p.depth}`);
    }
    return die(source);
  };

  while (game.running && steps < maxTurns) {
    const before = game.turn;
    const deathsBefore = game.player.deaths;
    const a = act(game, rng);
    lastAction = a;
    if (process.env.ACTMIX) mix[a.kind] = (mix[a.kind] ?? 0) + 1;
    if (process.env.STAM && game.inCombat()) {
      const p = game.player;
      // The bar is only a constraint if it is ever below what you want to do.
      // Two thresholds: the cheapest attack you own (could you have hit at all)
      // and a roll (could you have got out of the way).
      let cheapest = 99;
      for (const sk of p.skills) {
        const d = SKILL_BY_KEY[sk.key];
        if (!d || d.move || d.defend) continue;
        cheapest = Math.min(cheapest, p.costOf(sk.key));
      }
      stam.turns++;
      stam.sum += p.stamina;
      stam.min = Math.min(stam.min, p.stamina);
      if (p.stamina < cheapest) stam.broke++;
      if (p.stamina < p.rollCost()) stam.floor++;
      if (p.stamina < p.rollCost() && a.kind === 'move') stam.walkedBroke++;
      // The one that decides whether waiting is a stamina problem at all. If the
      // bot waits just as often with a full bar, the waiting is its own policy
      // and no amount of tuning the economy will touch it.
      if (a.kind === 'wait') {
        stam.waited++;
        if (p.stamina < p.rollCost()) stam.waitedBroke++;
        // Three reasons to stand still, and they need completely different
        // fixes: no stamina (economy), everything on cooldown (cooldowns), or
        // able to act and choosing not to (position - not a cost problem at all).
        let anyReady = false, anyOffCd = false;
        for (const sk of p.skills) {
          const d = SKILL_BY_KEY[sk.key];
          if (!d || d.move || d.defend) continue;
          if (sk.cd === 0) { anyOffCd = true; if (p.canAfford(p.costOf(sk.key))) anyReady = true; }
        }
        if (!anyOffCd) stam.waitCd++;
        else if (anyReady) stam.waitRich++;
      }
    }

    switch (a.kind) {
      case 'skill': {
        // Some things are aimed and some are not - a flask has no direction.
        const spent = game.useSkill(a.key, a.dir ? { dx: a.dir.dx, dy: a.dir.dy } : null);
        if (spent) game.worldTurn();
        break;
      }
      case 'move':    await game.command(a.dir.key); break;
      case 'wait':    await game.command('.'); break;
      case 'rest':    await game.command('e'); break;
      case 'take':    await game.command('g'); break;
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
      // An action the rules refused does not advance the clock, and choosing it
      // again will be refused identically - that is a loop, not a stall. The
      // commonest cause is walking into something you cannot currently hit
      // (dagger and hatchet have a primary with a cooldown), which is legal
      // for the rules to refuse and legal for a player to shrug off, but a
      // bot will retry it until the heat death of the universe.
      //
      // Waiting is deliberately the fallback rather than a re-plan: it always
      // advances the clock, so the situation changes and the next decision is
      // made against a different board. The stall detector below is left
      // exactly as it was, so a bot that genuinely cannot act still fails.
      if (stall === 3) { await game.command('.'); }
      if (++stall > 300) {
        const p = game.player;
        const info = process.env.WHYSTALL
          ? ` last=${JSON.stringify(lastAction)} hp=${p.hp} st=${p.stamina}` +
            ` rec=${p.recover} adj=${DIRS.filter((d)=>game.level.enemyAt(p.x+d.dx,p.y+d.dy)).length}` +
            ` msg="${game.messages.slice(-1)[0]?.text ?? ''}"`
          : '';
        throw new Error(`stalled on floor ${game.player.depth} at turn ${game.turn}${info}`);
      }
    } else { stall = 0; lastTurn = game.turn; }
  }

  return {
    seed, vow, steps, turn: game.turn,
    depth: game.player.depth, maxDepth: game.player.maxDepth,
    deaths: game.player.deaths, kills: game.stats.kills, killers, mix, stam,
    how: game.gameOver?.how ?? 'timeout',
    floorDeaths: [...floorDeaths.entries()].sort((a, b) => a[0] - b[0]),
  };
}

const argv = process.argv.slice(2);
const report = argv.includes('--report');
// --light / --heavy: run one vow only. The two are meant to be a trade, and a
// mixed run averages the trade away just when you are trying to measure it.
const onlyVow = argv.includes('--light') ? 'light' : argv.includes('--heavy') ? 'heavy' : null;
// --shield: put the kit's shield on before the run, so a shield build can be
// measured against a two-weapon one instead of guessed at.
const useShield = argv.includes('--shield');
const rest = argv.filter((a) => !a.startsWith('--'));
const runs = Number(rest[0] ?? 10);
const maxTurns = Number(rest[1] ?? 20000);

let failures = 0, wins = 0, deepest = 0;
const perFloor = new Map();
const perKiller = new Map();
const vowDeaths = new Map(), vowRuns = new Map(), vowDepth = new Map(), vowMix = new Map();
const vowStam = new Map();
const t0 = Date.now();

for (let i = 0; i < runs; i++) {
  const vow = onlyVow ?? (i % 2 ? 'heavy' : 'light');
  try {
    const r = await run(`bot-${i}`, maxTurns, vow);
    deepest = Math.max(deepest, r.maxDepth);
    if (r.how === 'won') wins++;
    for (const [f, n] of r.floorDeaths) perFloor.set(f, (perFloor.get(f) ?? 0) + n);
    for (const [k, n] of r.killers) perKiller.set(k, (perKiller.get(k) ?? 0) + n);
    { const m = vowMix.get(r.vow) ?? {}; for (const [k,n] of Object.entries(r.mix ?? {})) m[k]=(m[k]??0)+n; vowMix.set(r.vow,m); }
    if (r.stam) { const t = vowStam.get(r.vow) ?? { turns:0,broke:0,floor:0,sum:0,min:99,walkedBroke:0,waited:0,waitedBroke:0,waitCd:0,waitRich:0 };
      t.turns+=r.stam.turns; t.broke+=r.stam.broke; t.floor+=r.stam.floor;
      t.sum+=r.stam.sum; t.walkedBroke+=r.stam.walkedBroke; t.min=Math.min(t.min,r.stam.min);
      t.waited+=r.stam.waited; t.waitedBroke+=r.stam.waitedBroke;
      t.waitCd+=r.stam.waitCd; t.waitRich+=r.stam.waitRich;
      vowStam.set(r.vow,t); }
    vowDeaths.set(r.vow, (vowDeaths.get(r.vow) ?? 0) + r.deaths);
    vowRuns.set(r.vow, (vowRuns.get(r.vow) ?? 0) + 1);
    vowDepth.set(r.vow, (vowDepth.get(r.vow) ?? 0) + r.maxDepth);
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
if (process.env.ACTMIX) {
  console.log('what the bot spends its turns on:');
  for (const v of ['light','heavy']) {
    const m = vowMix.get(v) ?? {};
    const tot = Object.values(m).reduce((a,b)=>a+b,0) || 1;
    console.log('  ' + v.padEnd(6) + Object.entries(m).sort((a,b)=>b[1]-a[1])
      .map(([k,n]) => `${k} ${((100*n)/tot).toFixed(0)}%`).join('  '));
  }
}
if (process.env.STAM) {
  console.log('the stamina economy, measured in combat only:');
  for (const v of ['light','heavy']) {
    const t = vowStam.get(v); if (!t?.turns) continue;
    const pct = (n) => `${((100*n)/t.turns).toFixed(1)}%`;
    console.log(`  ${v.padEnd(6)} avg bar ${(t.sum/t.turns).toFixed(1)}/20  low-water ${t.min}` +
      `   too poor to ATTACK ${pct(t.broke)}   too poor to ROLL ${pct(t.floor)}` +
      `   walked while too poor to roll ${pct(t.walkedBroke)}`);
    console.log(`         waited ${pct(t.waited)} of combat turns, and ` +
      `${t.waited ? ((100*t.waitedBroke)/t.waited).toFixed(0) : 0}% of THOSE waits were with too little to roll` +
      `  <- if this is low, the waiting is policy, not economy`);
    const w = t.waited || 1;
    // NOT mutually exclusive: "could not roll" is measured against rollCost and
    // "could have attacked" against the cheapest attack, and heavy's roll is
    // dearer than its strike - so a turn can be both. Read them separately.
    console.log(`         of those waits:  could not afford a ROLL ${((100*t.waitedBroke)/w).toFixed(0)}%` +
      `   everything on cooldown ${((100*t.waitCd)/w).toFixed(0)}%` +
      `   could have ATTACKED anyway ${((100*t.waitRich)/w).toFixed(0)}%  <- bot policy, not economy`);
  }
}
if (report && vowRuns.size) {
  // The two vows are supposed to be a trade, not a ranking. If one of them is
  // dying twice as often as the other, something has quietly become dominant.
  console.log('by vow:');
  for (const v of [...vowRuns.keys()].sort()) {
    const runs_ = vowRuns.get(v);
    console.log(`  ${v.padEnd(5)} ${(vowDeaths.get(v) / runs_).toFixed(1)} deaths/run, ` +
                `reached floor ${(vowDepth.get(v) / runs_).toFixed(1)} on average`);
  }
}
if (report && perKiller.size) {
  const total = [...perKiller.values()].reduce((a, b) => a + b, 0);
  console.log('what lands the killing blow:');
  for (const [k, n] of [...perKiller.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${k.padEnd(28)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(1)}%`);
  }
}
process.exit(failures ? 1 : 0);
