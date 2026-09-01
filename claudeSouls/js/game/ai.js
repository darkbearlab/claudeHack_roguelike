// Enemy behaviour.
//
// Every enemy runs the same four-state machine, and the *only* thing that
// differs between species is the numbers on their attacks. That is deliberate:
// a player who has learned to read one enemy has learned to read all of them,
// and the difficulty then comes from combinations rather than from surprises.
//
//   READY   - can move; picks an attack the moment its pattern would reach you
//   WINDUP  - telegraphing. Cannot move. Can be pushed back by being hit.
//   STRIKE  - resolves. Everything in the pattern takes damage, including other
//             enemies who wandered into it.
//   RECOVER - helpless. This is your damage window and it is the whole game.
//
// Two things it must never do, because both would break the contract the player
// is reading against:
//   * change which tiles it will hit after the wind-up has started
//   * attack on a turn it did not telegraph

import { dist } from '../../../engine/util.js';
import { astar } from '../../../engine/path.js';
import { hasLOS } from '../../../engine/fov.js';
import { attackTiles, snapDir } from './patterns.js';
import { STATE } from './actors.js';
import { makeProjectile } from './projectile.js';
import { T } from '../map/tiles.js';

/**
 * Advance an enemy's state machine. Called **once per game turn**, before any
 * of its actions - and that separation is not cosmetic.
 *
 * Speed decides how many times an enemy may *move or start something*; it must
 * not decide how fast a wind-up resolves. When the countdown lived inside the
 * per-action loop, a speed-18 hound with a one-turn wind-up would begin its
 * telegraph and resolve it in the same game turn: the player was hit by an
 * attack they were never shown. That is the read-and-react contract broken at
 * the root, and it is the reason wind-up and recovery are ticked here instead.
 *
 * Returns true if the enemy is busy and may not act this turn.
 */
export function tickEnemyState(game, e) {
  if (!e.alive) return true;
  e.regen();

  if (e.state === STATE.WINDUP) {
    // A wind-up cannot be aborted. An enemy that could cancel its telegraph
    // would make every telegraph worthless.
    e.timer--;
    if (e.timer <= 0) resolveAttack(game, e);
    return true;
  }
  if (e.state === STATE.RECOVER) {
    e.timer--;
    if (e.timer <= 0) e.state = STATE.READY;
    return true;
  }
  if (e.state === STATE.RESTING) {
    if (e.stamina >= cheapestCost(e)) e.state = STATE.READY;
    else return true;
  }
  return false;
}

export function enemyTurn(game, e) {
  if (!e.alive) return;
  if (e.state === STATE.WINDUP || e.state === STATE.RECOVER || e.state === STATE.RESTING) return;
  const p = game.player;
  const lvl = game.level;

  const seen = canSee(game, e);
  if (seen) { e.aware = true; e.lastKnown = { x: p.x, y: p.y }; }

  if (!e.aware) { idle(game, e); return; }

  // ---- can we start something? ------------------------------------------
  const choice = chooseAttack(game, e, seen);
  if (choice) { beginWindup(game, e, choice.attack, choice.dir); return; }

  if (e.stamina < cheapestCost(e)) { e.state = STATE.RESTING; return; }

  // ---- otherwise, move ---------------------------------------------------
  const goal = seen ? { x: p.x, y: p.y } : e.lastKnown;
  if (!goal) { idle(game, e); return; }

  if (e.spec.keepsDistance && seen) {
    const d = dist(e.x, e.y, p.x, p.y);
    // Archers back off when crowded and close in when they have lost the line.
    if (d <= 3) { if (stepAway(game, e, p)) return; }
    else if (d >= 4 && hasLOS(lvl, e.x, e.y, p.x, p.y, e.spec.sight)) { e.face(p.x - e.x, p.y - e.y); return; }
  }

  stepToward(game, e, goal);
}

// ---------------------------------------------------------------- attacking

function cheapestCost(e) {
  return Math.min(...e.spec.attacks.map((a) => a.cost));
}

/**
 * Pick an attack whose pattern would land on the player *right now*, from where
 * the enemy is standing. The enemy does not lead its target and does not aim at
 * where you are going - it commits to tiles, and you are free to leave them.
 */
function chooseAttack(game, e, seen) {
  if (!seen) return null;
  const p = game.player;
  const options = [];

  for (const a of e.spec.attacks) {
    if (e.stamina < a.cost) continue;

    if (a.kind === 'ranged') {
      const d = dist(e.x, e.y, p.x, p.y);
      if (d > a.range || d < 2) continue;
      if (!aligned(e, p)) continue;
      if (!hasLOS(game.level, e.x, e.y, p.x, p.y, a.range)) continue;
      options.push({ attack: a, dir: snapDir(p.x - e.x, p.y - e.y) });
      continue;
    }

    const dir = snapDir(p.x - e.x, p.y - e.y);
    const tiles = attackTiles(e.x, e.y, dir.dx, dir.dy, a.pattern);
    if (tiles.some((t) => t.x === p.x && t.y === p.y)) options.push({ attack: a, dir });
  }

  if (!options.length) return null;
  // Prefer the biggest thing it can afford; a brute that always used its cheap
  // backhand would never show the player its interesting attack.
  options.sort((x, y) => y.attack.damage - x.attack.damage);
  return options[0];
}

/** Ranged attacks fire along one of the eight lines, so they can be side-stepped. */
function aligned(e, p) {
  const dx = p.x - e.x, dy = p.y - e.y;
  return dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
}

function beginWindup(game, e, attack, dir) {
  e.face(dir.dx, dir.dy);
  e.state = STATE.WINDUP;
  e.timer = attack.windup;
  e.attack = attack;
  e.attackDir = dir;
  e.attackTiles = attack.kind === 'ranged'
    ? rayTiles(game.level, e.x, e.y, dir, attack.range)
    : attackTiles(e.x, e.y, dir.dx, dir.dy, attack.pattern);
  if (game.level.isVisible(e.x, e.y)) {
    game.msg(`The ${e.name} readies ${attack.name}.`, 'warn');
  }
}

function rayTiles(lvl, x, y, dir, range) {
  const out = [];
  let cx = x, cy = y;
  for (let i = 0; i < range; i++) {
    cx += dir.dx; cy += dir.dy;
    if (!lvl.flyable(cx, cy)) break;
    out.push({ x: cx, y: cy });
  }
  return out;
}

function resolveAttack(game, e) {
  const a = e.attack;
  e.stamina = Math.max(0, e.stamina - a.cost);
  e.state = STATE.RECOVER;
  e.timer = a.recovery;

  if (a.kind === 'ranged') {
    game.level.projectiles.push(makeProjectile({
      x: e.x, y: e.y, dx: e.attackDir.dx, dy: e.attackDir.dy,
      speed: a.projectile.speed, damage: a.damage,
      glyph: a.projectile.glyph, colour: a.projectile.colour,
      fromPlayer: false, life: a.range + 2,
    }));
    if (game.level.isVisible(e.x, e.y)) game.msg(`The ${e.name} looses ${a.name}.`);
  } else {
    const tiles = e.attackTiles ?? [];
    let hitAnything = false;
    for (const t of tiles) {
      if (t.x === game.player.x && t.y === game.player.y) {
        game.msg(`The ${e.name}'s ${a.name} catches you!`, 'bad');
        game.hurtPlayer(a.damage, e.name);
        hitAnything = true;
      }
      const other = game.level.enemyAt(t.x, t.y);
      if (other && other !== e && other.alive) {
        // Friendly fire is not a special case; it falls out of attacks
        // covering tiles rather than targeting creatures.
        game.msg(`The ${e.name} hits the ${other.name}!`, 'good');
        game.hurtEnemy(other, a.damage, false);
        hitAnything = true;
      }
    }
    if (!hitAnything && game.level.isVisible(e.x, e.y)) {
      game.msg(`The ${e.name}'s ${a.name} hits nothing.`);
    }
  }

  e.attack = null;
  e.attackTiles = null;
}

// ----------------------------------------------------------------- movement

function canSee(game, e) {
  const p = game.player;
  if (dist(e.x, e.y, p.x, p.y) > e.spec.sight) return false;
  return hasLOS(game.level, e.x, e.y, p.x, p.y, e.spec.sight);
}

function stepToward(game, e, goal) {
  const lvl = game.level;
  if (e.x === goal.x && e.y === goal.y) { e.lastKnown = null; return; }
  const path = astar(lvl, e.x, e.y, goal.x, goal.y, { mover: e, maxNodes: 700 });
  if (path && path.length) { tryStep(game, e, path[0].x, path[0].y); return; }
  const dx = Math.sign(goal.x - e.x), dy = Math.sign(goal.y - e.y);
  if (tryStep(game, e, e.x + dx, e.y + dy)) return;
  if (dx && tryStep(game, e, e.x + dx, e.y)) return;
  if (dy) tryStep(game, e, e.x, e.y + dy);
}

function stepAway(game, e, from) {
  let best = null, bestD = dist(e.x, e.y, from.x, from.y);
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    const nx = e.x + dx, ny = e.y + dy;
    if (!game.level.passable(nx, ny, e)) continue;
    if (game.level.enemyAt(nx, ny)) continue;
    if (nx === game.player.x && ny === game.player.y) continue;
    const d = dist(nx, ny, from.x, from.y);
    if (d > bestD) { bestD = d; best = { x: nx, y: ny }; }
  }
  if (!best) return false;
  return tryStep(game, e, best.x, best.y);
}

function idle(game, e) {
  if (!e.aware && game.rng.oneIn(3)) {
    const d = game.rng.pick([[1,0],[-1,0],[0,1],[0,-1]]);
    tryStep(game, e, e.x + d[0], e.y + d[1]);
  }
}

function tryStep(game, e, nx, ny) {
  const lvl = game.level;
  if (!lvl.inBounds(nx, ny)) return false;
  if (nx === game.player.x && ny === game.player.y) { e.face(nx - e.x, ny - e.y); return false; }
  if (lvl.enemyAt(nx, ny)) return false;
  if (!lvl.diagonalOk(e.x, e.y, nx, ny)) return false;

  const t = lvl.at(nx, ny);
  if (t === T.DOOR_CLOSED) {
    if (!e.spec.opensDoors) return false;
    lvl.set(nx, ny, T.DOOR_OPEN);
    e.face(nx - e.x, ny - e.y);
    return true;                       // opening the door spends the move
  }
  if (!lvl.passable(nx, ny, e)) return false;

  e.face(nx - e.x, ny - e.y);
  lvl.moveEnemy(e, nx, ny);
  return true;
}
