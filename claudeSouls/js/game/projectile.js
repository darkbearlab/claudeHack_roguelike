// Things in the air.
//
// An arrow in this game is not damage that happens to you, it is an object on
// the board with a position and a velocity. It buys four things at once and
// they are all load-bearing:
//
//   1. Enemy attacks become board state rather than dice, so they can be dodged,
//      blocked by cover, or walked out of.
//   2. The telegraph comes for free - the threat is literally drawn on the map,
//      no intent UI needed.
//   3. **Enemies shoot each other.** Step aside at the right moment and the
//      archer's arrow lands in the brute. This is the single most satisfying
//      thing in the game and it needs no special-casing: the arrow simply hits
//      the first body in its path.
//   4. Distance becomes a resource. A projectile moving three tiles a turn,
//      fired from nine tiles away, gives you three turns to be somewhere else.
//
// Projectiles belong to the level, not to whoever fired them - the archer may
// well be dead before its arrow lands, and the arrow should not care.

import { flyable } from '../map/tiles.js';

let pid = 1;
export function resetProjectileIds(n = 1) { pid = n; }

export function makeProjectile(o) {
  return {
    id: pid++,
    x: o.x, y: o.y,
    dx: o.dx, dy: o.dy,
    speed: o.speed ?? 3,
    damage: o.damage,
    fromPlayer: !!o.fromPlayer,
    // Who fired it. An enemy arrow hitting ANOTHER enemy is deliberate; one
    // hitting the thing that fired it is not, and for a body more than one
    // tile across that is the default outcome rather than an edge case - it
    // launches inside itself. Carried as a uid so the check is identity, the
    // same way melee already avoids friendly-firing its own squares.
    owner: o.owner ?? null,
    impact: o.impact ?? 0,
    glyph: o.glyph ?? '*',
    colour: o.colour ?? '#e0d0a0',
    life: o.life ?? 12,
    trail: [],
  };
}

/**
 * Advance every projectile one turn.
 *
 * Movement is stepped one tile at a time rather than teleported `speed` tiles,
 * because a fast arrow must still be stopped by the wall - or the body - that
 * is in the middle of its path.
 */
export function stepProjectiles(game) {
  const lvl = game.level;
  const survivors = [];

  for (const p of lvl.projectiles) {
    p.trail = [];
    let dead = false;

    for (let s = 0; s < p.speed && !dead; s++) {
      const nx = p.x + p.dx, ny = p.y + p.dy;

      if (!lvl.flyable(nx, ny)) { dead = true; break; }
      p.x = nx; p.y = ny;
      p.trail.push({ x: nx, y: ny });

      // The player.
      if (nx === game.player.x && ny === game.player.y) {
        if (p.fromPlayer) continue;               // your own knife passes you
        // You block the arrow, not the archer - who may well be dead by now.
        game.hurtPlayer(p.damage, 'an arrow', {
          from: { dx: -Math.sign(p.dx), dy: -Math.sign(p.dy) },
          unblockable: !!p.unblockable,
        });
        dead = true;
        break;
      }

      // Anything else standing there - including, deliberately, other enemies.
      const e = lvl.enemyAt(nx, ny);
      if (e && e.alive && e.uid === p.owner) continue;   // never your own body
      if (e && e.alive) {
        if (!p.fromPlayer) {
          game.msg(`The ${p.glyph === '*' ? 'cinder' : 'arrow'} strikes the ${e.name}!`, 'good');
        }
        game.hurtEnemy(e, p.damage, p.fromPlayer, p.impact);
        dead = true;
        break;
      }

      if (--p.life <= 0) { dead = true; break; }
    }

    if (!dead) survivors.push(p);
  }

  lvl.projectiles = survivors;
}
