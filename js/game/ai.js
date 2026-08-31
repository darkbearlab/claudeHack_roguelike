// Monster behaviour.
//
// The AI is a small priority list rather than a state machine, because a state
// machine invites states that never get left. Every turn a monster asks, in
// order: am I able to act, am I afraid, can I see the hero, do I remember where
// they were, and otherwise what is interesting nearby. The first question that
// answers "yes" decides the turn.
//
// The one piece of genuine cleverness is `lastKnown`. A monster that loses
// sight of you walks to where you *were*, not to where you are. That single
// field is the difference between "monsters cheat" and "monsters hunt", and it
// is what makes breaking line of sight a real tactic.

import { DIRS, dist, sgn } from '../core/util.js';
import { T, isDoor } from '../map/tiles.js';
import { astar, flowField, stepAlong } from '../sys/path.js';
import { hasLOS } from '../sys/fov.js';
import { monsterAttack, damagePlayer, hurtMonster, killMonster } from './combat.js';
import { objBase } from './obj.js';
import { capitalise } from '../core/util.js';
import { castMonsterSpell, breatheAt } from './effects.js';

export function monsterTurn(game, mon) {
  if (!mon.alive) return;
  const p = game.player;
  const level = game.level;

  mon.tickStatuses();

  if (mon.hasStatus('paralyzed') || mon.hasStatus('sleeping')) return;
  if (mon.spec.regen && mon.hp < mon.hpMax && game.rng.oneIn(3)) mon.hp++;

  // ---- waking up ---------------------------------------------------------
  if (mon.asleep) {
    const d = dist(mon.x, mon.y, p.x, p.y);
    let wakeChance = 0;
    if (d <= 1) wakeChance = 90;
    else if (d <= 5) wakeChance = 22 - d * 3;
    else if (d <= 10) wakeChance = 4;
    if (p.has('stealth')) wakeChance = Math.floor(wakeChance / 3);
    if (p.has('aggravate')) wakeChance = Math.max(wakeChance, 50);
    if (game.rng.rn2(100) < wakeChance) {
      mon.asleep = false;
      if (level.isVisible(mon.x, mon.y)) game.msg(`${capitalise(mon.displayName())} wakes up.`);
    } else return;
  }

  if (mon.shopkeeper) { shopkeeperTurn(game, mon); return; }

  // ---- can it see the hero? ---------------------------------------------
  const canSee = monsterCanSeeHero(game, mon);
  if (canSee) { mon.seenHero = true; mon.lastKnown = { x: p.x, y: p.y }; }

  if (mon.peaceful && !mon.tame) { wander(game, mon); return; }

  // ---- afraid ------------------------------------------------------------
  if (mon.fleeing > 0) {
    mon.fleeing--;
    if (fleeFrom(game, mon, p.x, p.y)) return;
    // Cornered. Fall through and fight.
  }

  const d = dist(mon.x, mon.y, p.x, p.y);

  // ---- adjacent: hit it --------------------------------------------------
  if (d === 1 && !p.hasStatus('hiddenFromAll')) {
    if (mon.hasStatus('confused') && game.rng.oneIn(2)) { randomStep(game, mon); return; }
    monsterAttack(game, mon);
    return;
  }

  // ---- ranged options ----------------------------------------------------
  if (canSee && d <= 8) {
    const breath = mon.spec.atk.find((a) => a.type === 'breath');
    if (breath && game.rng.oneIn(5) && alignedForRay(mon, p)) {
      breatheAt(game, mon, breath);
      return;
    }
    const gaze = mon.spec.atk.find((a) => a.type === 'gaze');
    if (gaze && game.rng.oneIn(4)) { doGaze(game, mon); return; }
    if (mon.spec.spellcaster && game.rng.oneIn(4)) { castMonsterSpell(game, mon); return; }
    const spellAtk = mon.spec.atk.find((a) => a.type === 'spell');
    if (spellAtk && game.rng.oneIn(6)) { castMonsterSpell(game, mon, spellAtk.effect); return; }
  }

  if (mon.spec.neverMove) return;

  // ---- move --------------------------------------------------------------
  if (mon.hasStatus('confused')) { randomStep(game, mon); return; }
  if (mon.spec.erratic && game.rng.oneIn(3)) { randomStep(game, mon); return; }

  const goal = canSee ? { x: p.x, y: p.y } : mon.lastKnown;
  if (goal) {
    if (!canSee && mon.x === goal.x && mon.y === goal.y) { mon.lastKnown = null; wander(game, mon); return; }
    const path = astar(level, mon.x, mon.y, goal.x, goal.y, { mover: mon, maxNodes: 900 });
    if (path && path.length) {
      const step = path[0];
      if (step.x === p.x && step.y === p.y) { monsterAttack(game, mon); return; }
      if (!tryStep(game, mon, step.x, step.y)) wander(game, mon);
      return;
    }
    // No path: shuffle in the right general direction, so it still presses.
    const dx = sgn(goal.x - mon.x), dy = sgn(goal.y - mon.y);
    if (tryStep(game, mon, mon.x + dx, mon.y + dy)) return;
    if (dx && tryStep(game, mon, mon.x + dx, mon.y)) return;
    if (dy && tryStep(game, mon, mon.x, mon.y + dy)) return;
  }
  wander(game, mon);
}

// ---------------------------------------------------------------- movement

function tryStep(game, mon, nx, ny) {
  const level = game.level;
  if (!level.inBounds(nx, ny)) return false;
  const p = game.player;
  if (nx === p.x && ny === p.y) { monsterAttack(game, mon); return true; }

  const other = level.monsterAt(nx, ny);
  if (other && other !== mon) {
    // Monsters under conflict fight each other; otherwise they swap or wait.
    if (p.has('conflict') && game.rng.oneIn(2)) {
      const dmg = game.rng.d(1, 6) + mon.level;
      if (level.isVisible(nx, ny)) game.msg(`${capitalise(mon.displayName())} attacks ${other.displayName()}!`);
      hurtMonster(game, other, dmg);
      return true;
    }
    return false;
  }

  const t = level.at(nx, ny);
  if (isDoor(t) && (t === T.DOOR_CLOSED || t === T.DOOR_LOCKED)) {
    if (mon.spec.amorphous || mon.spec.unsolid) { /* seeps through */ }
    else if (mon.spec.opensDoors && t === T.DOOR_CLOSED) {
      level.set(nx, ny, T.DOOR_OPEN);
      if (level.isVisible(nx, ny)) game.msg('You hear a door open.');
      return true;                       // opening spends the turn
    } else if (mon.spec.opensDoors && t === T.DOOR_LOCKED && game.rng.oneIn(4)) {
      level.set(nx, ny, T.DOOR_BROKEN);
      game.msg('You hear a door crash open!');
      return true;
    } else return false;
  }
  if (!level.passable(nx, ny, mon)) {
    if (mon.spec.digs && level.at(nx, ny) === T.WALL && game.rng.oneIn(3)) {
      level.set(nx, ny, T.CORRIDOR);
      game.msg('You hear a pick-axe striking rock.');
      return true;
    }
    return false;
  }

  level.moveMonster(mon, nx, ny);

  // Monsters that scavenge pick things up, which is where your dropped
  // long sword goes while you are not looking.
  if (mon.spec.picksUp) {
    const here = level.itemsAt(nx, ny);
    for (const o of here) {
      if (o.key === 'Amulet of Yendor' && !mon.spec.covetous) continue;
      if (o.cls === 'coin' || game.rng.oneIn(3)) {
        level.removeItem(o);
        mon.inventory.push(o);
        if (o.cls === 'weapon' && !mon.weapon) mon.weapon = o;
        if (level.isVisible(nx, ny)) game.msg(`${capitalise(mon.displayName())} picks something up.`);
        break;
      }
    }
  }
  game.monsterSteppedOn(mon);
  return true;
}

function randomStep(game, mon) {
  const dirs = game.rng.shuffle([...DIRS]);
  for (const d of dirs) if (tryStep(game, mon, mon.x + d.dx, mon.y + d.dy)) return true;
  return false;
}

function wander(game, mon) {
  if (mon.spec.neverMove) return;
  if (!mon.wanderGoal || (mon.x === mon.wanderGoal.x && mon.y === mon.wanderGoal.y) || game.rng.oneIn(20)) {
    mon.wanderGoal = game.level.randomFreeSpot(game.rng);
  }
  if (mon.wanderGoal) {
    const path = astar(game.level, mon.x, mon.y, mon.wanderGoal.x, mon.wanderGoal.y,
                       { mover: mon, maxNodes: 400 });
    if (path && path.length) { tryStep(game, mon, path[0].x, path[0].y); return; }
    mon.wanderGoal = null;
  }
  if (game.rng.oneIn(2)) randomStep(game, mon);
}

function fleeFrom(game, mon, tx, ty) {
  const field = flowField(game.level, [{ x: tx, y: ty }], { mover: mon, maxDist: 25 });
  const step = stepAlong(game.level, field, mon.x, mon.y, true);
  if (!step) return false;
  if (field[step.y * game.level.w + step.x] <= field[mon.y * game.level.w + mon.x]) return false;
  return tryStep(game, mon, step.x, step.y);
}

// ------------------------------------------------------------------ senses

export function monsterCanSeeHero(game, mon) {
  const p = game.player;
  const level = game.level;
  const d = dist(mon.x, mon.y, p.x, p.y);
  if (d > 14) return false;
  if (p.has('invisible') && !mon.spec.seeInvis && !game.rng.oneIn(3)) return false;
  if (mon.spec.telepathic && d <= 10) return true;
  if (mon.hasStatus('blind')) return false;
  return hasLOS(level, mon.x, mon.y, p.x, p.y, 14);
}

function alignedForRay(mon, p) {
  const dx = p.x - mon.x, dy = p.y - mon.y;
  return dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
}

function doGaze(game, mon) {
  const p = game.player;
  if (p.hasStatus('blind')) return;
  if (p.has('reflection')) {
    game.msg('The gaze is reflected by your amulet!', 'good');
    hurtMonster(game, mon, game.rng.d(2, 6));
    return;
  }
  const effects = ['sleep', 'slow', 'confuse', 'fear', 'damage'];
  const e = game.rng.pick(effects);
  switch (e) {
    case 'sleep':
      if (p.has('sleepRes') || p.has('freeAction')) { game.msg('You feel drowsy for a moment.'); break; }
      game.msg(`${capitalise(mon.displayName())} gazes at you. You fall asleep!`, 'bad');
      p.setStatus('paralyzed', game.rng.int(4, 10));
      break;
    case 'slow':
      game.msg(`${capitalise(mon.displayName())} gazes at you. You feel sluggish.`, 'bad');
      p.setStatus('slow', game.rng.int(10, 30));
      break;
    case 'confuse':
      game.msg(`${capitalise(mon.displayName())} gazes at you. Your vision swims.`, 'bad');
      p.setStatus('confused', game.rng.int(5, 12));
      break;
    case 'fear':
      game.msg(`${capitalise(mon.displayName())} gazes at you. You are terrified!`, 'bad');
      p.setStatus('scared', game.rng.int(3, 8));
      break;
    default:
      game.msg(`${capitalise(mon.displayName())} gazes at you!`, 'bad');
      damagePlayer(game, game.rng.d(2, 6), mon.name);
      break;
  }
}

// -------------------------------------------------------------- shopkeeper

function shopkeeperTurn(game, mon) {
  const p = game.player;
  const shop = mon.shop;
  if (!shop || shop.abandoned) { wander(game, mon); return; }

  if (!mon.peaceful) {
    // An angry shopkeeper is a level-12 monster with two weapon attacks. This
    // is the intended lesson about shoplifting.
    const path = astar(game.level, mon.x, mon.y, p.x, p.y, { mover: mon, maxNodes: 900 });
    if (dist(mon.x, mon.y, p.x, p.y) === 1) monsterAttack(game, mon);
    else if (path && path.length) tryStep(game, mon, path[0].x, path[0].y);
    return;
  }

  const owes = game.shopDebt(shop);
  const inShop = game.inShop(p.x, p.y) === shop;

  if (owes > 0 && !inShop) {
    game.msg(`"Hey!  You didn't pay for that!"`, 'bad');
    mon.peaceful = false;
    return;
  }

  // Stand in the doorway while the hero owes money; otherwise idle by the door.
  const post = owes > 0 ? shop.door : shop.postPos;
  if (post && (mon.x !== post.x || mon.y !== post.y)) {
    const path = astar(game.level, mon.x, mon.y, post.x, post.y, { mover: mon, maxNodes: 500 });
    if (path && path.length) tryStep(game, mon, path[0].x, path[0].y);
  }
}
