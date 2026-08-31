// Melee, ranged and special attacks.
//
// The to-hit maths is NetHack's, restated: a d20 roll must come in *under* a
// target number built from the defender's AC plus the attacker's level and
// bonuses. Two consequences worth keeping in mind while reading:
//
//   - AC is a number you want to be *low*, and negative AC is normal at depth.
//   - Because AC only shifts the target number, armour never makes you
//     unhittable, it makes each blow less likely. There is no immunity.
//
// Damage from a monster's AC below zero is also reduced, which is why plate
// mail feels different from a ring of protection even at the same AC.

import { objBase, damageDice, objName, makeObj } from './obj.js';
import { capitalise } from '../core/util.js';

/**
 * NetHack's AC_VALUE. Armour class at or above 3 is taken at face value;
 * below 3 it is randomised across the band, which is why a deeply armoured
 * hero is not merely hard to hit but *unpredictably* hard to hit. Without this
 * the difference between AC 0 and AC -10 would be a flat two percent a point.
 */
export function acValue(rng, ac) {
  if (ac >= 3) return ac;
  if (ac >= -19) return 3 - rng.rnd(3 - ac);
  return -20;
}

export function playerToHitTarget(player, mon) {
  // Higher is easier to hit. hitBonus already carries the +1 base and the
  // hero's experience level, so there is no constant to add here - an earlier
  // version had a stray +10, which made every attack in the game land and made
  // armour class decorative.
  return mon.ac + player.hitBonus();
}

/** Does the hero's blow land? */
export function playerHits(game, mon) {
  const p = game.player;
  let target = playerToHitTarget(p, mon);
  if (mon.asleep || mon.hasStatus('paralyzed') || mon.hasStatus('sleeping')) target += 4;
  if (mon.fleeing) target += 2;
  if (p.hasStatus('hallucinating')) target -= 2;
  return game.rng.rnd(20) < target;
}

/** Roll damage for the hero's current attack. */
export function playerDamage(game, mon) {
  const p = game.player;
  const w = p.equip.weapon;
  let dmg;
  if (w) {
    const [n, d] = damageDice(w);
    dmg = game.rng.d(n, d);
    const base = objBase(w);
    // Blessed weapons bite harder into the undead, as they should.
    if (w.bless > 0 && (mon.spec.undead || mon.spec.demon)) dmg += game.rng.rnd(4);
    if (base?.orcish && mon.spec.elf) dmg += 1;
  } else {
    dmg = game.rng.rnd(2);            // bare hands
  }
  dmg += p.damageBonus();

  // A Rogue striking something that has not noticed them triples the blow.
  // This is the whole reason to play a Rogue.
  if (p.backstab && (mon.asleep || !mon.seenHero || mon.fleeing)) {
    dmg = Math.floor(dmg * (2 + game.rng.rn2(2)));
    game.msg('You strike from the shadows!', 'good');
  }
  // Deeply armoured monsters shed part of a blow as well as dodging it.
  if (mon.ac < 0) dmg += Math.trunc(mon.ac / 2);
  return Math.max(1, dmg);
}

/** The hero attacks a monster in melee. Consumes the turn either way. */
export function playerAttack(game, mon) {
  const p = game.player;
  const name = mon.displayName();

  // The "really attack?" confirmation lives in the movement command, not here,
  // so that this function stays synchronous and can be called from anywhere.
  if (mon.peaceful) { mon.peaceful = false; game.angerNeighbours(mon); }

  if (mon.asleep) { mon.asleep = false; }
  mon.seenHero = true;
  mon.lastKnown = { x: p.x, y: p.y };
  p.conductWeaponless = p.conductWeaponless && !p.equip.weapon;

  if (!playerHits(game, mon)) {
    game.msg(`You miss ${name}.`);
    passiveCounter(game, mon);
    return true;
  }

  const dmg = playerDamage(game, mon);
  game.msg(`You hit ${name}.`);
  hurtMonster(game, mon, dmg, 'hit');

  // Weapon-borne effects.
  const w = p.equip.weapon;
  if (mon.alive && w && objBase(w)?.key === 'unicorn horn' && game.rng.oneIn(3)) {
    mon.setStatus('confused', game.rng.rnd(4));
  }
  if (mon.alive) passiveCounter(game, mon);
  return true;
}

/** Damage a monster, handle death, XP and corpses. */
export function hurtMonster(game, mon, dmg, cause = 'hit') {
  mon.hp -= dmg;
  mon.asleep = false;
  if (mon.hp > 0) {
    // Wounded monsters below a quarter health start looking for the exit.
    if (mon.hp < mon.hpMax / 4 && !mon.spec.neverMove && !mon.spec.mindless && game.rng.oneIn(2)) {
      mon.fleeing = game.rng.int(4, 10);
    }
    return false;
  }
  killMonster(game, mon, cause);
  return true;
}

export function killMonster(game, mon, cause = 'hit') {
  if (!mon.alive) return;
  mon.alive = false;
  const level = game.level;
  level.markMonstersDirty();
  const seen = level.isVisible(mon.x, mon.y) || game.player.has('telepathy');
  if (seen) game.msg(`You ${cause === 'kill' ? 'destroy' : 'kill'} ${mon.displayName()}!`, 'good');

  game.player.gainXP(mon.xpValue, game);
  game.player.kills.set(mon.name, (game.player.kills.get(mon.name) ?? 0) + 1);
  game.stats.kills++;

  // Drop what it carried.
  for (const o of mon.inventory) level.addItem(o, mon.x, mon.y);
  mon.inventory.length = 0;

  // Corpses. Not everything leaves one; the ones that do matter for eating.
  if (!mon.spec.noCorpse && !mon.spec.unsolid && game.rng.rn2(100) < corpseChance(mon)) {
    const corpse = makeObj('corpse', 'food', game.rng, {
      corpseOf: mon.name, random: false,
      raw: { nutrition: mon.spec.nutrition ?? 100, monKey: mon.specKey, age: game.turn },
    });
    level.addItem(corpse, mon.x, mon.y);
  }
  if (mon.shopkeeper && mon.shop) {
    mon.shop.abandoned = true;
    for (const o of level.items) if (o.shopPrice) o.shopPrice = 0;
    game.msg('The shop is unattended.', 'warn');
  }
  if (mon.specKey === 'wizard') game.msg('The Wizard of Yendor is destroyed - for now.', 'magic');
}

function corpseChance(mon) {
  if (mon.spec.undead) return 25;
  if (mon.spec.lvl >= 10) return 90;
  return 60;
}

/** Damage the hero takes just for touching something. */
function passiveCounter(game, mon) {
  for (const at of mon.spec.atk) {
    if (at.type !== 'passive') continue;
    if (at.effect === 'paralyze') {
      // The floating eye. The single most famous "do not melee that" in the genre.
      if (game.player.has('freeAction')) { game.msg('You are unaffected.'); continue; }
      if (game.player.hasStatus('blind')) continue;
      const t = game.rng.int(20, 20 + at.d);
      game.player.setStatus('paralyzed', t);
      game.msg("You are frozen by the floating eye's gaze!", 'bad');
      game.player.lastAttacker = mon.name;
      continue;
    }
    if (at.effect === 'acid') {
      if (game.player.has('acidRes')) continue;
      const dmg = game.rng.d(at.n, at.d);
      game.msg('You are splashed by acid!', 'bad');
      damagePlayer(game, dmg, `${mon.name}'s acid`);
      continue;
    }
    if (at.effect === 'poison') {
      if (game.player.has('poisonRes')) { game.msg('You feel a little sick, but it passes.'); continue; }
      game.msg('You are poisoned!', 'bad');
      game.player.adjustAttr('str', -1, game);
      damagePlayer(game, game.rng.d(at.n, at.d), `${mon.name}'s spores`);
      continue;
    }
    if (at.effect === 'stick') {
      if (!game.player.hasStatus('stuck')) {
        game.msg('You are stuck to the lichen.', 'warn');
        game.player.setStatus('stuck', game.rng.int(3, 8));
      }
    }
  }
}

// ===========================================================================
// monster attacking the hero
// ===========================================================================

export function monsterAttack(game, mon) {
  const p = game.player;
  let acted = false;
  for (const at of mon.spec.atk) {
    if (at.type === 'passive') continue;
    if (at.type === 'breath' || at.type === 'gaze' || at.type === 'spell') continue; // ranged, handled in ai
    acted = true;
    const target = acValue(game.rng, p.ac) + mon.level + 1;
    const roll = game.rng.rnd(20);
    const displaced = p.has('displacement') && game.rng.oneIn(3);

    if (displaced) { game.msg(`${capitalise(mon.displayName())} attacks a spot beside you.`); continue; }
    if (roll >= target) { game.msg(`${capitalise(mon.displayName())} misses.`); continue; }

    let dmg = at.n ? game.rng.d(at.n, at.d) : 0;
    if (at.type === 'weapon' && mon.weapon) {
      const [n, d] = damageDice(mon.weapon);
      dmg = game.rng.d(n, d) + (mon.weapon.enchant ?? 0);
    }
    const verb = { bite: 'bites', claw: 'claws', butt: 'butts', kick: 'kicks',
                   sting: 'stings', touch: 'touches', crush: 'crushes',
                   weapon: 'hits' }[at.type] ?? 'hits';
    game.msg(`${capitalise(mon.displayName())} ${verb} you!`, 'bad');

    if (at.effect) dmg = applyAttackEffect(game, mon, at, dmg);
    if (dmg > 0) damagePlayer(game, dmg, mon.name);
    if (!game.running) return true;
  }
  return acted;
}

function applyAttackEffect(game, mon, at, dmg) {
  const p = game.player;
  const rng = game.rng;
  switch (at.effect) {
    case 'poison':
      if (p.has('poisonRes')) { game.msg('The poison has no effect.'); break; }
      if (rng.oneIn(8)) { game.msg('The poison was deadly...', 'bad'); return p.hp + 999; }
      game.msg('You feel weaker.', 'bad');
      p.adjustAttr('str', -1, game);
      dmg += rng.rnd(6);
      break;
    case 'drain':
      if (p.has('drainRes')) { game.msg('You feel a slight chill.'); break; }
      game.msg('You feel your life force draining away!', 'bad');
      p.loseLevel(game);
      break;
    case 'intdrain':
      game.msg('Your brain is eaten!', 'bad');
      if (!p.adjustAttr('int', -1, game)) game.msg('You feel a slight headache.');
      else if (p.attr.int <= 3) { p.deathReason = 'brainlessness'; return p.hp + 999; }
      break;
    case 'dexdrain':
      game.msg('You feel clumsy.', 'bad');
      p.adjustAttr('dex', -1, game);
      break;
    case 'sleep':
      if (p.has('sleepRes') || p.has('freeAction')) { game.msg('You yawn.'); break; }
      game.msg('You fall asleep!', 'bad');
      p.setStatus('paralyzed', rng.int(5, 15));
      break;
    case 'paralyze':
      if (p.has('freeAction')) { game.msg('You momentarily stiffen.'); break; }
      game.msg('You are frozen!', 'bad');
      p.setStatus('paralyzed', rng.int(3, 8));
      break;
    case 'stone':
      if (p.has('stoneRes') || p.has('unchanging')) { game.msg('You feel momentarily stiff.'); break; }
      if (!p.hasStatus('stoning')) {
        game.msg('You are slowly turning to stone!', 'bad');
        p.setStatus('stoning', 5);
      }
      break;
    case 'fire':
      if (p.has('fireRes')) { game.msg('The fire does not burn you.'); dmg = 0; break; }
      game.msg('You are burned!', 'bad'); dmg += rng.rnd(6);
      break;
    case 'cold':
      if (p.has('coldRes')) { game.msg('You are unharmed by the cold.'); dmg = 0; break; }
      game.msg('You are frozen!', 'bad'); dmg += rng.rnd(6);
      break;
    case 'elec':
      if (p.has('shockRes')) { game.msg('You are unharmed by the shock.'); dmg = 0; break; }
      game.msg('You are shocked!', 'bad'); dmg += rng.rnd(4);
      break;
    case 'acid':
      game.msg('You are covered in acid!', 'bad'); dmg += rng.rnd(6);
      break;
    case 'lycanthropy':
      if (!p.hasStatus('lycanthropy') && rng.oneIn(4)) {
        game.msg('You feel feverish.', 'bad');
        p.setStatus('lycanthropy', -1);
      }
      break;
    case 'wrap':
      if (!p.hasStatus('stuck')) { game.msg('You are held fast!', 'bad'); p.setStatus('stuck', rng.int(2, 5)); }
      break;
    case 'stealgold':
      if (p.gold > 0) {
        const amt = Math.min(p.gold, rng.int(10, 100));
        p.gold -= amt;
        game.msg('Your purse feels lighter.', 'bad');
        mon.fleeing = 40;
      }
      break;
    case 'steal': {
      const loot = p.inventory.filter((o) => !o.worn && !o.wielded);
      if (loot.length) {
        const o = rng.pick(loot);
        game.msg(`${capitalise(mon.displayName())} stole ${objName(o, game.disc)}!`, 'bad');
        game.removeFromInventory(o);
        mon.inventory.push(o);
        mon.fleeing = 60;
      }
      break;
    }
    case 'disease':
      if (p.has('poisonRes')) break;
      if (!p.hasStatus('sick')) { game.msg('You feel very sick.', 'bad'); p.setStatus('sick', rng.int(10, 30)); }
      break;
    default: break;
  }
  return dmg;
}

/** All hero damage funnels through here so that life saving has one home. */
export function damagePlayer(game, dmg, killer) {
  const p = game.player;
  if (dmg <= 0) return;
  p.hp -= dmg;
  p.lastAttacker = killer ?? p.lastAttacker;
  if (p.hp <= 0) {
    const ls = p.equip.amulet;
    if (ls && ls.key === 'life saving') {
      game.msg('But wait... your medallion begins to glow!', 'magic');
      p.hp = p.hpMax;
      game.removeFromInventory(ls);
      p.equip.amulet = null;
      game.msg('You feel much better. The medallion crumbles to dust!', 'good');
      return;
    }
    game.die(killer ?? 'something');
  }
}
