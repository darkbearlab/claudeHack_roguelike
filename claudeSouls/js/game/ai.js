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
import { attackTiles, snapDir, RADIAL } from './patterns.js';
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
/**
 * Which way a blow arrives from, as the player would have to face to meet it.
 *
 * Two cases, and using the wrong one for either is visibly wrong in play:
 *
 *   normal   the reverse of the attacker's facing. NOT the direction to its
 *            body - the horned one charges six tiles and finishes past you, and
 *            it plainly hit you from the side it came from, not from behind.
 *   radial   the direction to the attacker. A ring has no facing, but its
 *            centre is unambiguous.
 */
function incomingDir(game, e, a) {
  const p = game.player;
  if (RADIAL.has(a.pattern)) {
    const dx = e.x - p.x, dy = e.y - p.y;
    return { dx: Math.sign(dx), dy: Math.sign(dy) };
  }
  const d = e.attackDir ?? { dx: 0, dy: 1 };
  return { dx: -d.dx, dy: -d.dy };
}

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

/** Turns out of sight before something gives up looking for you. */
const FORGET_AFTER = 12;

export function enemyTurn(game, e) {
  if (!e.alive) return;
  if (e.state === STATE.WINDUP || e.state === STATE.RECOVER || e.state === STATE.RESTING) return;
  const p = game.player;
  const lvl = game.level;

  const seen = canSee(game, e);
  if (seen) { e.aware = true; e.lost = 0; e.lastKnown = { x: p.x, y: p.y }; }
  else if (e.aware) {
    // Awareness has to decay, or it is a latch: one glimpse on arriving at a
    // floor and every enemy on it hunts you for the rest of the run. That
    // matters more than it sounds, because "out of combat" is what refills the
    // stamina bar - without forgetting, the fast refill would never fire once
    // and the weight rule would quietly become a tax on exploring.
    e.lost = (e.lost ?? 0) + 1;
    if (e.lost > FORGET_AFTER) { e.aware = false; e.lastKnown = null; }
  }

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
    // Tiles are worked out from where the enemy will be *after* its step, so a
    // stepping attack threatens further than it looks and one pace back is not
    // enough. Whatever is computed here is exactly what gets shown and exactly
    // what gets hit.
    const from = origin(game.level, e, dir, a, game);
    const tiles = attackTiles(from.x, from.y, dir.dx, dir.dy, a.pattern);
    if (tiles.some((t) => t.x === p.x && t.y === p.y)) options.push({ attack: a, dir });
  }

  if (!options.length) return null;
  // Weighted rather than "always the biggest". A brute that only ever led with
  // its overhead would be one puzzle repeated; mixing in the untelegraphed
  // backhand is what makes standing next to it uncomfortable.
  return game.rng.pickWeighted(options, (o) => o.attack.weight ?? 1);
}

/**
 * Where an attack resolves from. A stepping attack (the brute's overhead, the
 * minotaur's charge) moves the attacker first, and only as far as the floor
 * allows - so a charge into a wall is a short charge, not a teleport.
 *
 * It also stops **before anything already standing there**, which is not a
 * detail. Without that check a brute standing next to you would step onto your
 * square, resolve its five-tile arc from there, and miss you completely - so
 * the overhead was never a legal choice at melee range and the brute spent
 * every fight throwing its cheap backhand. It looked like a balance problem and
 * was a geometry bug.
 */
function origin(lvl, e, dir, a, game) {
  // A blow comes out of the part of it that is facing you. For a one-tile
  // creature that is simply where it stands; for a 2x2 the anchor corner would
  // put half its attacks in the air on its far side, so the swing starts from
  // whichever of its squares is nearest the player.
  const from = game ? e.nearestTileTo(game.player.x, game.player.y) : { x: e.x, y: e.y };
  let x = from.x, y = from.y;
  for (let i = 0; i < (a.step ?? 0); i++) {
    const nx = x + dir.dx, ny = y + dir.dy;
    if (!lvl.passable(nx, ny, e)) break;
    if (!lvl.diagonalOk(x, y, nx, ny)) break;
    if (game && nx === game.player.x && ny === game.player.y) break;
    const other = lvl.occupant(nx, ny);
    if (other && other !== e && other.alive !== false) break;
    x = nx; y = ny;
  }
  return { x, y };
}

/** Would a body anchored here stand on the player? */
function occupiesPlayer(game, x, y, size) {
  const p = game.player;
  return p.x >= x && p.x < x + size && p.y >= y && p.y < y + size;
}

/** Ranged attacks fire along one of the eight lines, so they can be side-stepped. */
function aligned(e, p) {
  const dx = p.x - e.x, dy = p.y - e.y;
  return dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
}

function beginWindup(game, e, attack, dir) {
  e.face(dir.dx, dir.dy);
  e.attack = attack;
  e.attackDir = dir;
  e.poiseLeft = e.poise;

  const from = attack.kind === 'ranged'
    ? { x: e.x, y: e.y }
    : origin(game.level, e, dir, attack, game);
  e.attackTiles = attack.kind === 'ranged'
    ? rayTiles(game.level, e.x, e.y, dir, attack.range)
    : attackTiles(from.x, from.y, dir.dx, dir.dy, attack.pattern);

  // windup 0 means no telegraph: it simply happens. Reserved for cheap, fast
  // attacks, so that standing next to something always costs you.
  if (attack.windup <= 0) { resolveAttack(game, e); return; }

  e.state = STATE.WINDUP;
  e.timer = attack.windup;
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
  // Before the stepping move below, so the lunge is drawn from where the
  // wind-up was telegraphed rather than from where it ended up.
  game.fx?.add({ kind: 'attack', uid: e.uid, x: e.x, y: e.y,
                 dx: e.attackDir?.dx ?? 0, dy: e.attackDir?.dy ?? 0 });
  e.stamina = Math.max(0, e.stamina - a.cost);
  e.state = STATE.RECOVER;
  e.timer = a.recovery;

  // A stepping attack actually moves. The tiles were computed from here when
  // the wind-up started, so the promise still holds.
  if (a.step && a.kind !== 'ranged') {
    const to = origin(game.level, e, e.attackDir, a, game);
    if (to.x !== e.x || to.y !== e.y) game.level.moveEnemy(e, to.x, to.y);
  }

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
    const struck = new Set();          // one blow per body, not per tile
    for (const t of tiles) {
      if (t.x === game.player.x && t.y === game.player.y) {
        game.msg(`The ${e.name}'s ${a.name} catches you!`, 'bad');
        game.hurtPlayer(a.damage, `${e.name}'s ${a.name}`, {
          from: incomingDir(game, e, a),
          unblockable: !!a.unblockable,
        });
        hitAnything = true;
      }
      const other = game.level.enemyAt(t.x, t.y);
      // `other !== e` is also what stops a big creature friendly-firing itself:
      // every tile of its body returns the same object, so identity excludes
      // it without a size check anywhere.
      if (other && other !== e && other.alive && !struck.has(other)) {
        struck.add(other);
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

  // A combination continues straight into its next part with no gap: the blade
  // is still moving. The follow-up telegraphs normally, so it is readable - but
  // it arrives during what would have been the recovery window, which is what
  // stops "step aside, walk back in, take three free swings".
  //
  // Only one telegraph is ever on screen, which is why this needed no change
  // to the renderer.
  if (a.next) {
    // A follow-up either swings back across the same ground (sweepL then
    // sweepR, whose union is the whole semicircle) or **turns to face you
    // again**. Re-aiming is honest: the second stage telegraphs after the first
    // one lands, so you still see it before it arrives - it just means the
    // dodge that answered stage one does not automatically answer stage two.
    // Without it a combo re-covers tiles you have already left.
    let dir = e.attackDir;
    if (a.next.reaim) {
      const dx = game.player.x - e.x, dy = game.player.y - e.y;
      if (dx || dy) dir = snapDir(dx, dy);
    }
    e.attack = null;
    beginWindup(game, e, a.next, dir);
    return;
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
    if (game.level.occupant(nx, ny)) continue;
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
  // A body needs room for all of itself. For the one-tile case this is the
  // same test as before; for a 2x2 it is why it cannot enter a corridor -
  // measured, only 1.9% of corridor tiles can hold one.
  if (e.size > 1) {
    if (!lvl.bodyFits(nx, ny, e.size, e)) return false;
    if (occupiesPlayer(game, nx, ny, e.size)) { e.face(nx - e.x, ny - e.y); return false; }
  } else if (lvl.occupant(nx, ny)) return false;
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
