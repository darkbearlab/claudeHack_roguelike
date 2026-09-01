// Everything a potion, scroll, wand, spell, trap or ray actually does.
//
// This file is deliberately one big dispatch rather than a class hierarchy of
// Effect objects. The effects are almost entirely *unlike* each other - a
// potion of gain level and a scroll of destroy armour share no structure at
// all - so an inheritance tree would have been one abstract method and a lot of
// ceremony. A switch that reads top to bottom is the honest shape.
//
// Two invariants hold throughout:
//   1. An effect that the hero can observe identifies its object. Learning by
//      use is the entire identification game, so `game.discover()` is called
//      from inside the effect, not by the caller.
//   2. Nothing here ends the turn. The command layer owns the turn.

import { T, isDoor, isDiggable } from '../map/tiles.js';
import { DIRS, dist, capitalise, listJoin, line } from '../../../engine/util.js';
import { objName, objBase, makeObj, makeGold, randomObj } from './obj.js';
import { damagePlayer, hurtMonster, killMonster } from './combat.js';
import { Monster } from './actors.js';
import { pickMonsterSpec, MONSTER_BY_KEY } from '../data/monsters.js';
import { OBJECTS } from '../data/items.js';

// ===========================================================================
// potions
// ===========================================================================

export async function quaffPotion(game, o) {
  const p = game.player;
  const rng = game.rng;
  const cursed = o.bless < 0, blessed = o.bless > 0;
  let learn = true;

  game.msg(`You drink ${objName(o, game.disc, { article: 'the' })}.`);

  switch (o.key) {
    case 'healing': {
      const heal = blessed ? rng.d(8, 4) : cursed ? rng.d(4, 4) : rng.d(6, 4);
      healPlayer(game, heal, blessed ? 2 : 1);
      game.msg('You feel better.', 'good');
      break;
    }
    case 'extra healing': {
      const heal = blessed ? rng.d(8, 8) : cursed ? rng.d(4, 8) : rng.d(6, 8);
      healPlayer(game, heal, blessed ? 5 : 2);
      p.clearStatus('blind');
      p.clearStatus('confused');
      p.clearStatus('hallucinating');
      game.msg('You feel much better.', 'good');
      break;
    }
    case 'full healing':
      p.hpMax += blessed ? 8 : 4;
      p.hp = p.hpMax;
      p.pw = p.pwMax;
      ['blind', 'confused', 'hallucinating', 'sick', 'stoning'].forEach((s) => p.clearStatus(s));
      game.msg('You feel completely healed.', 'good');
      break;
    case 'gain level':
      if (cursed) {
        game.msg('You rise up through the ceiling!', 'magic');
        game.changeLevel(-1, true);
        return true;
      }
      p.xp = Math.max(p.xp, gainLevelXP(p));
      p.levelUp(game);
      break;
    case 'gain energy': {
      const amt = (blessed ? 3 : cursed ? -2 : 2) * rng.rnd(5);
      p.pwMax = Math.max(0, p.pwMax + Math.max(0, amt));
      p.pw = Math.min(p.pwMax, Math.max(0, p.pw + amt));
      game.msg(amt > 0 ? 'Magical energies course through your body.' : 'You feel drained of energy.',
               amt > 0 ? 'good' : 'bad');
      break;
    }
    case 'gain ability': {
      const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
      if (blessed) { for (const k of keys) p.adjustAttr(k, 1, game); game.msg('You feel strong all over!', 'good'); }
      else { const k = rng.pick(keys); p.adjustAttr(k, cursed ? -1 : 1, game);
             game.msg(cursed ? 'You feel weaker.' : 'You feel more capable.', cursed ? 'bad' : 'good'); }
      break;
    }
    case 'restore ability':
      for (const k of Object.keys(p.attr)) p.attr[k] = p.attrMax[k];
      game.msg('You feel your abilities restored.', 'good');
      break;
    case 'speed':
      if (cursed) { p.setStatus('slow', rng.int(10, 30)); game.msg('You feel slower.', 'bad'); }
      else { p.setStatus('fast', rng.int(15, 40)); game.msg('You are suddenly moving faster.', 'good'); }
      break;
    case 'see invisible':
      p.setStatus('see invisible', blessed ? -1 : rng.int(200, 400));
      game.msg('You can see through yourself, but you are visible!');
      break;
    case 'levitation':
      p.setStatus('levitating', cursed ? rng.int(100, 200) : rng.int(20, 60));
      game.msg('You float up, out of reach of the floor.', 'magic');
      break;
    case 'invisibility':
      p.setStatus('invisible', blessed ? -1 : rng.int(30, 80));
      game.msg('Gee! All of a sudden, you can see right through yourself.', 'magic');
      break;
    case 'monster detection':
      detectMonsters(game, blessed ? -1 : 0);
      break;
    case 'object detection':
      detectObjects(game);
      break;
    case 'confusion':
      p.setStatus('confused', rng.int(8, 20));
      game.msg('Huh, What? Where am I?', 'bad');
      break;
    case 'blindness':
      p.setStatus('blind', rng.int(100, 300));
      game.msg('A cloud of darkness falls upon you.', 'bad');
      break;
    case 'paralysis':
      if (p.has('freeAction')) { game.msg('You stiffen momentarily.'); break; }
      p.setStatus('paralyzed', rng.int(10, 25));
      game.msg('Your limbs are frozen!', 'bad');
      break;
    case 'sleeping':
      if (p.has('sleepRes') || p.has('freeAction')) { game.msg('You yawn.'); break; }
      p.setStatus('paralyzed', rng.int(10, 25));
      game.msg('You fall asleep.', 'bad');
      break;
    case 'hallucination':
      p.setStatus('hallucinating', rng.int(80, 200));
      game.msg('Oh wow! Everything looks so cosmic!', 'magic');
      break;
    case 'sickness':
      if (p.has('poisonRes')) { game.msg('(But in fact it was biologically contaminated tap water.)'); break; }
      game.msg('Yecch! This stuff tastes like poison.', 'bad');
      p.adjustAttr('str', -1, game);
      damagePlayer(game, rng.rnd(4) + 2, 'a contaminated potion');
      break;
    case 'acid':
      game.msg('This burns!', 'bad');
      damagePlayer(game, rng.d(2, 6), 'a potion of acid');
      break;
    case 'booze':
      game.msg('Ooph! This tastes like liquid fire!', 'warn');
      p.setStatus('confused', rng.int(10, 20));
      p.nutrition += 20;
      break;
    case 'fruit juice':
      game.msg('This tastes like fruit juice.');
      p.nutrition += blessed ? 100 : 50;
      break;
    case 'water':
      if (blessed) { game.msg('This burns like acid!'); if (p.hasStatus('lycanthropy')) { p.clearStatus('lycanthropy'); game.msg('You feel purified.', 'good'); } p.luck++; }
      else if (cursed) { game.msg('This burns like acid!', 'bad'); damagePlayer(game, rng.rnd(6), 'unholy water'); p.luck--; }
      else game.msg('This tastes like water.');
      break;
    case 'polymorph':
      game.msg('You feel a change coming over you.', 'magic');
      polymorphPlayer(game);
      break;
    default:
      game.msg('Nothing seems to happen.');
      learn = false;
      break;
  }
  if (learn) game.discover(o);
  return true;
}

function gainLevelXP(p) {
  // Just enough to trip the next threshold in Player.gainXP.
  return p.xp;
}

export function healPlayer(game, amount, maxGain = 0) {
  const p = game.player;
  const over = p.hp + amount - p.hpMax;
  p.hp = Math.min(p.hpMax, p.hp + amount);
  if (over > 0 && maxGain > 0) { p.hpMax += Math.min(maxGain, over); p.hp = p.hpMax; }
}

// ===========================================================================
// scrolls
// ===========================================================================

export async function readScroll(game, o) {
  const p = game.player;
  const rng = game.rng;
  const blessed = o.bless > 0, cursed = o.bless < 0;
  const confused = p.hasStatus('confused');
  let learn = true;

  if (p.hasStatus('blind')) { game.msg('You cannot see to read.'); return false; }
  game.msg(`You read ${objName(o, game.disc, { article: 'the' })}.`);

  switch (o.key) {
    case 'identify': {
      const n = blessed ? (rng.oneIn(5) ? 99 : rng.int(2, 4)) : 1;
      game.discover(o);
      await game.identifyMenu(n);
      return true;
    }
    case 'light':
      lightArea(game, confused ? -1 : 1);
      break;
    case 'enchant weapon': {
      const w = p.equip.weapon;
      if (!w) { game.msg('Your hands tingle.'); break; }
      const amt = blessed ? rng.int(1, 3) : cursed ? -1 : 1;
      w.enchant += amt; w.enchantKnown = true;
      game.msg(`Your ${objName(w, game.disc, { article: false })} glows ${amt > 0 ? 'blue' : 'brown'} for a moment.`,
               amt > 0 ? 'good' : 'bad');
      if (w.erode > 0 && amt > 0) w.erode--;
      break;
    }
    case 'enchant armor': {
      const worn = ['body', 'cloak', 'helm', 'gloves', 'boots', 'shield']
        .map((s) => p.equip[s]).filter(Boolean);
      if (!worn.length) { game.msg('Your skin glows for a moment.'); break; }
      const a = rng.pick(worn);
      const amt = blessed ? rng.int(1, 2) : cursed ? -1 : 1;
      a.enchant += amt; a.enchantKnown = true;
      game.msg(`Your ${objName(a, game.disc, { article: false })} glows ${amt > 0 ? 'silver' : 'black'}.`,
               amt > 0 ? 'good' : 'bad');
      break;
    }
    case 'remove curse': {
      const targets = blessed ? p.inventory : p.inventory.filter((i) => i.worn || i.wielded);
      let any = false;
      for (const it of targets) if (it.bless < 0) { it.bless = 0; it.blessKnown = true; any = true; }
      game.msg(any ? 'You feel like someone is helping you.' : 'You feel in touch with the Universal Oneness.',
               'good');
      break;
    }
    case 'destroy armor': {
      const worn = ['body', 'cloak', 'helm', 'gloves', 'boots', 'shield']
        .map((s) => p.equip[s]).filter(Boolean);
      if (blessed || confused) {
        for (const a of worn) { a.erode = 0; a.bless = Math.max(0, a.bless); }
        game.msg('Your armor is repaired.', 'good');
        break;
      }
      if (!worn.length) { game.msg('Your skin itches.'); break; }
      const a = rng.pick(worn);
      game.msg(`Your ${objName(a, game.disc, { article: false })} crumbles to dust!`, 'bad');
      game.unequip(a, true);
      game.removeFromInventory(a);
      break;
    }
    case 'confuse monster':
      p.setStatus('confusing touch', blessed ? 40 : 20);
      game.msg('Your hands begin to glow red.', 'magic');
      break;
    case 'scare monster':
      for (const m of game.level.monsters) {
        if (m.alive && dist(m.x, m.y, p.x, p.y) < 10) m.fleeing = rng.int(10, 25);
      }
      game.msg('You hear maniacal laughter in the distance.', 'magic');
      break;
    case 'blank paper':
      game.msg('This scroll seems to be blank.');
      break;
    case 'teleportation':
      teleportPlayer(game, cursed ? null : (blessed ? 'controlled' : null));
      break;
    case 'gold detection': {
      let n = 0;
      for (const it of game.level.items) {
        if (it.cls === 'coin') { game.level.seen[game.level.idx(it.x, it.y)] = 1; game.rememberObject(it); n++; }
      }
      game.msg(n ? 'You feel materially aware.' : 'You feel materially poor.', n ? 'magic' : 'warn');
      break;
    }
    case 'food detection': {
      let n = 0;
      for (const it of game.level.items) {
        if (it.cls === 'food') { game.level.seen[game.level.idx(it.x, it.y)] = 1; game.rememberObject(it); n++; }
      }
      game.msg(n ? 'Your nose twitches.' : 'Your nose twitches, but you smell nothing.');
      break;
    }
    case 'magic mapping':
      magicMap(game, !cursed);
      break;
    case 'fire': {
      game.msg('The scroll erupts in a tower of flame!', 'bad');
      if (!p.has('fireRes')) damagePlayer(game, rng.d(2, 6), 'a scroll of fire');
      for (const m of game.level.monsters) {
        if (m.alive && dist(m.x, m.y, p.x, p.y) <= 1 && !m.spec.fireRes) hurtMonster(game, m, rng.d(3, 6));
      }
      break;
    }
    case 'punishment':
      if (blessed) { game.msg('You feel guilty.'); break; }
      game.msg('You are being punished for your misbehavior!', 'bad');
      p.setStatus('punished', -1);
      break;
    case 'create monster': {
      const n = blessed ? rng.int(3, 6) : confused ? rng.int(6, 12) : 1;
      for (let i = 0; i < n; i++) game.spawnMonsterNear(p.x, p.y, 2);
      game.msg('You feel watched.', 'warn');
      break;
    }
    case 'taming': {
      let n = 0;
      for (const m of game.level.monsters) {
        if (m.alive && dist(m.x, m.y, p.x, p.y) <= 1) { m.peaceful = true; m.tame = true; n++; }
      }
      game.msg(n ? 'You feel charismatic.' : 'You feel a strange sense of loss.', n ? 'good' : 'warn');
      break;
    }
    case 'amnesia':
      game.msg('Thinking of Maud, you forget everything else.', 'bad');
      forgetMap(game, blessed ? 0.3 : 0.75);
      break;
    case 'charging':
      await game.chargeMenu(blessed);
      game.discover(o);
      return true;
    case 'genocide':
      await game.genocideMenu(blessed);
      game.discover(o);
      return true;
    default:
      game.msg('Nothing seems to happen.');
      learn = false;
  }
  if (learn) game.discover(o);
  return true;
}

// ===========================================================================
// wands and rays
// ===========================================================================

export async function zapWand(game, o, dir) {
  const p = game.player;
  const base = objBase(o);
  if (o.charges !== null && o.charges <= 0) {
    game.msg('You wrest one last charge out of the worn-out wand.');
    if (game.rng.oneIn(3)) { game.msg('Nothing happens.'); return true; }
  } else if (o.charges !== null) o.charges--;

  const key = o.key;
  const self = dir && dir.dx === 0 && dir.dy === 0;

  switch (key) {
    case 'light':
      lightArea(game, 1);
      game.msg('A lit field surrounds you!', 'magic');
      game.discover(o); return true;
    case 'nothing':
      game.msg('You feel an absence of magical power.'); return true;
    case 'secret door detection': {
      let n = 0;
      for (let y = Math.max(0, p.y - 8); y <= Math.min(game.level.h - 1, p.y + 8); y++) {
        for (let x = Math.max(0, p.x - 8); x <= Math.min(game.level.w - 1, p.x + 8); x++) {
          if (game.level.revealSecret(x, y)) { game.level.seen[game.level.idx(x, y)] = 1; n++; }
        }
      }
      game.msg(n ? 'You sense hidden passages.' : 'You sense no hidden passages.', n ? 'magic' : '');
      if (n) game.discover(o);
      return true;
    }
    case 'create monster': {
      const n = game.rng.oneIn(23) ? game.rng.int(2, 5) : 1;
      for (let i = 0; i < n; i++) game.spawnMonsterNear(p.x, p.y, 2);
      game.discover(o); return true;
    }
    case 'enlightenment':
      game.showEnlightenment();
      game.discover(o); return true;
    case 'wishing':
      await game.wishPrompt();
      game.discover(o); return true;
    case 'digging':
      if (self || (dir.dx === 0 && dir.dy === 0)) { game.msg('You dig a hole beneath you.'); game.digDown(); }
      else digRay(game, dir);
      game.discover(o); return true;
    default: break;
  }

  if (self) { zapSelf(game, o); return true; }
  if (!dir) { game.msg('Nothing happens.'); return true; }

  const isRay = !!base.ray;
  fireBeam(game, p.x, p.y, dir, {
    ray: isRay,
    range: isRay ? 13 : 8,
    onMonster: (m) => wandHitsMonster(game, o, m),
    onTile: (x, y) => wandHitsTile(game, o, x, y),
    source: o,
  });
  return true;
}

function zapSelf(game, o) {
  const p = game.player;
  switch (o.key) {
    case 'magic missile':
      game.msg('The missiles bounce!', 'bad');
      damagePlayer(game, game.rng.d(2, 6), 'a wand of magic missile');
      game.discover(o); break;
    case 'striking':
      game.msg('You are hit by the force!', 'bad');
      damagePlayer(game, game.rng.d(2, 12), 'a wand of striking');
      game.discover(o); break;
    case 'fire':
      if (p.has('fireRes')) game.msg('You feel warm.');
      else { game.msg('You are caught in the fire!', 'bad'); damagePlayer(game, game.rng.d(6, 6), 'a wand of fire'); }
      game.discover(o); break;
    case 'cold':
      if (p.has('coldRes')) game.msg('You feel cool.');
      else { game.msg('You are frozen!', 'bad'); damagePlayer(game, game.rng.d(6, 6), 'a wand of cold'); }
      game.discover(o); break;
    case 'lightning':
      if (p.has('shockRes')) game.msg('You feel a mild tingle.');
      else { game.msg('You are shocked!', 'bad'); damagePlayer(game, game.rng.d(6, 6), 'a wand of lightning');
             p.setStatus('blind', game.rng.int(10, 30)); }
      game.discover(o); break;
    case 'sleep':
      if (p.has('sleepRes') || p.has('freeAction')) game.msg('You yawn.');
      else { game.msg('You fall asleep!', 'bad'); p.setStatus('paralyzed', game.rng.int(10, 25)); }
      game.discover(o); break;
    case 'slow monster':
      p.setStatus('slow', game.rng.int(20, 50)); game.msg('You feel sluggish.', 'bad'); game.discover(o); break;
    case 'speed monster':
      p.setStatus('fast', game.rng.int(20, 50)); game.msg('You speed up.', 'good'); game.discover(o); break;
    case 'make invisible':
      p.setStatus('invisible', -1); game.msg('Gee! You can see right through yourself.', 'magic'); game.discover(o); break;
    case 'teleportation':
      teleportPlayer(game); game.discover(o); break;
    case 'polymorph':
      polymorphPlayer(game); game.discover(o); break;
    case 'cancellation':
      game.msg('You feel a wrenching sensation.');
      for (const it of p.inventory) if (objBase(it)?.magic) it.cancelled = true;
      game.discover(o); break;
    case 'probing':
      game.msg('You feel self-knowledgeable.');
      game.showEnlightenment(); game.discover(o); break;
    case 'undead turning':
      game.msg('You feel a strange chill.'); break;
    case 'opening':
      game.msg('Your pack opens.'); break;
    case 'locking':
      game.msg('Your pack shuts tight.'); break;
    default:
      game.msg('Nothing happens.');
  }
}

function wandHitsMonster(game, o, m) {
  const rng = game.rng;
  const resistsMagic = m.spec.mr && rng.rn2(100) < m.spec.mr;
  switch (o.key) {
    case 'magic missile':
      game.msg(`The missiles hit ${m.displayName()}.`);
      hurtMonster(game, m, rng.d(2, 6)); game.discover(o); return 'continue';
    case 'striking':
      if (resistsMagic) { game.msg(`${capitalise(m.displayName())} resists.`); }
      else { game.msg(`${capitalise(m.displayName())} is hit by the force!`); hurtMonster(game, m, rng.d(2, 12)); }
      game.discover(o); return 'stop';
    case 'fire':
      if (m.spec.fireRes) game.msg(`${capitalise(m.displayName())} is not harmed.`);
      else { game.msg(`${capitalise(m.displayName())} is caught in the fire!`); hurtMonster(game, m, rng.d(6, 6)); }
      game.discover(o); return 'continue';
    case 'cold':
      if (m.spec.coldRes) game.msg(`${capitalise(m.displayName())} is not harmed.`);
      else { game.msg(`${capitalise(m.displayName())} is covered in frost!`); hurtMonster(game, m, rng.d(6, 6)); }
      game.discover(o); return 'continue';
    case 'lightning':
      if (m.spec.elecRes) game.msg(`${capitalise(m.displayName())} is not harmed.`);
      else { game.msg(`${capitalise(m.displayName())} is struck by lightning!`); hurtMonster(game, m, rng.d(6, 6)); }
      game.discover(o); return 'continue';
    case 'sleep':
      if (resistsMagic || m.spec.sleepRes) game.msg(`${capitalise(m.displayName())} resists.`);
      else { game.msg(`${capitalise(m.displayName())} falls asleep.`); m.setStatus('sleeping', rng.int(10, 40)); }
      game.discover(o); return 'continue';
    case 'slow monster':
      if (resistsMagic) game.msg(`${capitalise(m.displayName())} resists.`);
      else { m.setStatus('slow', rng.int(20, 60)); game.msg(`${capitalise(m.displayName())} slows down.`); }
      game.discover(o); return 'stop';
    case 'speed monster':
      m.setStatus('fast', rng.int(20, 60)); game.msg(`${capitalise(m.displayName())} speeds up.`, 'warn');
      game.discover(o); return 'stop';
    case 'make invisible':
      m.invisible = true; game.msg(`${capitalise(m.displayName())} vanishes!`); game.discover(o); return 'stop';
    case 'cancellation':
      m.cancelled = true; m.spec = { ...m.spec, spellcaster: false };
      game.msg(`${capitalise(m.displayName())} looks momentarily different.`); game.discover(o); return 'stop';
    case 'teleportation': {
      const spot = game.level.randomFreeSpot(rng);
      if (spot) { game.level.moveMonster(m, spot.x, spot.y); game.msg(`${capitalise(m.displayName())} suddenly disappears!`); }
      game.discover(o); return 'stop';
    }
    case 'polymorph': {
      const spec = pickMonsterSpec(rng, game.level.depth, game.player.xpLevel);
      game.msg(`${capitalise(m.displayName())} turns into ${spec.name}!`, 'magic');
      const nm = new Monster(spec.key, rng);
      m.alive = false;
      game.level.addMonster(nm, m.x, m.y);
      game.discover(o); return 'stop';
    }
    case 'undead turning':
      if (m.spec.undead) { game.msg(`${capitalise(m.displayName())} turns to flee!`); m.fleeing = 40; hurtMonster(game, m, rng.d(2, 6)); }
      else game.msg(`${capitalise(m.displayName())} is unaffected.`);
      game.discover(o); return 'stop';
    case 'probing':
      game.msg(`${capitalise(m.displayName())}: ${m.hp}/${m.hpMax} HP, AC ${m.ac}, level ${m.level}.`, 'magic');
      game.discover(o); return 'continue';
    case 'opening':
    case 'locking':
      return 'continue';
    default:
      game.msg(`${capitalise(m.displayName())} is unaffected.`);
      return 'stop';
  }
}

function wandHitsTile(game, o, x, y) {
  const lvl = game.level;
  const t = lvl.at(x, y);
  if (o.key === 'opening' && (t === T.DOOR_CLOSED || t === T.DOOR_LOCKED)) {
    lvl.set(x, y, T.DOOR_OPEN); game.msg('The door opens.'); game.discover(o); return 'stop';
  }
  if (o.key === 'locking' && (t === T.DOOR_OPEN || t === T.DOOR_BROKEN)) {
    lvl.set(x, y, T.DOOR_LOCKED); game.msg('The door locks!'); game.discover(o); return 'stop';
  }
  if (o.key === 'striking' && (t === T.DOOR_CLOSED || t === T.DOOR_LOCKED)) {
    lvl.set(x, y, T.DOOR_BROKEN); game.msg('The door crashes open!'); game.discover(o); return 'stop';
  }
  if (o.key === 'fire' && lvl.itemsAt(x, y).length) {
    for (const it of lvl.itemsAt(x, y)) {
      if (it.cls === 'scroll' || it.cls === 'spellbook') { lvl.removeItem(it); game.msg('You smell burning parchment.'); }
    }
  }
  return null;
}

/**
 * Send a beam or ray from (x,y) in `dir`.
 * A ray bounces off walls; a beam stops at the first thing it hits.
 */
export function fireBeam(game, x0, y0, dir, opts) {
  const lvl = game.level;
  const { range = 10, ray = false, onMonster, onTile, glyph = '*' } = opts;
  let x = x0, y = y0, dx = dir.dx, dy = dir.dy;
  const trail = [];

  for (let step = 0; step < range; step++) {
    const nx = x + dx, ny = y + dy;
    if (!lvl.inBounds(nx, ny)) break;

    if (!lvl.walkable(nx, ny) && !isDoor(lvl.at(nx, ny))) {
      if (onTile) { const r = onTile(nx, ny); if (r === 'stop') break; }
      if (!ray) break;
      // Bounce. Try reflecting each axis; if both are blocked, reverse.
      const hb = lvl.walkable(x + dx, y), vb = lvl.walkable(x, y + dy);
      if (dx && dy) {
        if (!hb && !vb) { dx = -dx; dy = -dy; }
        else if (!hb) dx = -dx;
        else dy = -dy;
      } else { dx = -dx; dy = -dy; }
      continue;
    }

    x = nx; y = ny;
    trail.push({ x, y });

    if (onTile) { const r = onTile(x, y); if (r === 'stop') break; }

    if (x === game.player.x && y === game.player.y && opts.hitsPlayer) {
      const r = opts.hitsPlayer();
      if (r === 'stop') break;
    }
    const m = lvl.monsterAt(x, y);
    if (m && onMonster) {
      const r = onMonster(m);
      if (r === 'stop') break;
    }
  }
  game.animateTrail(trail, glyph, opts.colour ?? '#ffd75f');
  return trail;
}

function digRay(game, dir) {
  const lvl = game.level;
  let x = game.player.x, y = game.player.y;
  for (let i = 0; i < 12; i++) {
    x += dir.dx; y += dir.dy;
    if (!lvl.inBounds(x, y)) break;
    const t = lvl.at(x, y);
    if (t === T.STONE || t === T.WALL || t === T.SDOOR || t === T.SCORR) {
      if (!isDiggable(t)) break;
      lvl.set(x, y, T.CORRIDOR);
    } else if (isDoor(t)) lvl.set(x, y, T.DOOR_BROKEN);
  }
  game.msg('You dig through the rock.');
}

// ===========================================================================
// spells
// ===========================================================================

export const SPELLS = {
  'force bolt':      { level: 1, cost: 5,  dir: true,  school: 'attack' },
  'healing':         { level: 1, cost: 5,  dir: false, school: 'healing' },
  'detect monsters': { level: 1, cost: 5,  dir: false, school: 'divination' },
  'light':           { level: 1, cost: 5,  dir: false, school: 'divination' },
  'sleep':           { level: 1, cost: 5,  dir: true,  school: 'enchantment' },
  'confuse monster': { level: 2, cost: 10, dir: false, school: 'enchantment' },
  'cure blindness':  { level: 2, cost: 10, dir: false, school: 'healing' },
  'magic missile':   { level: 2, cost: 10, dir: true,  school: 'attack' },
  'slow monster':    { level: 2, cost: 10, dir: true,  school: 'enchantment' },
  'extra healing':   { level: 3, cost: 15, dir: false, school: 'healing' },
  'haste self':      { level: 3, cost: 15, dir: false, school: 'escape' },
  'remove curse':    { level: 3, cost: 15, dir: false, school: 'clerical' },
  'dig':             { level: 5, cost: 25, dir: true,  school: 'matter' },
  'magic mapping':   { level: 5, cost: 25, dir: false, school: 'divination' },
  'finger of death': { level: 7, cost: 35, dir: true,  school: 'attack' },
};

export function spellFailure(game, spellKey) {
  const p = game.player;
  const sp = SPELLS[spellKey];
  if (!sp) return 100;
  let base = 5 + sp.level * 12;
  base -= (p.attr.int - 10) * 3;
  base -= (p.skills.magic ?? 0) * 8;
  base -= p.xpLevel;
  const body = p.equip.body;
  if (body && (objBase(body)?.ac ?? 0) >= 4) base += 25;   // metal armour interferes
  if (p.equip.shield) base += 10;
  return Math.max(0, Math.min(95, base));
}

export async function castSpell(game, spellKey, dir) {
  const p = game.player;
  const rng = game.rng;
  const sp = SPELLS[spellKey];
  if (!sp) { game.msg('You do not know that spell.'); return false; }
  if (p.pw < sp.cost) { game.msg('You do not have enough energy to cast that spell.'); return false; }
  p.pw -= sp.cost;

  if (rng.rn2(100) < spellFailure(game, spellKey)) {
    game.msg('You fail to cast the spell correctly.', 'bad');
    return true;
  }

  switch (spellKey) {
    case 'force bolt':
      if (!dir) return true;
      fireBeam(game, p.x, p.y, dir, {
        range: 8, glyph: '*', colour: '#ffe08a',
        onMonster: (m) => { game.msg(`The force bolt hits ${m.displayName()}!`);
                            hurtMonster(game, m, rng.d(2, 6) + Math.floor(p.xpLevel / 2)); return 'stop'; },
      });
      break;
    case 'magic missile':
      if (!dir) return true;
      fireBeam(game, p.x, p.y, dir, {
        ray: true, range: 12, glyph: '-', colour: '#bc8cff',
        onMonster: (m) => { game.msg(`The missiles hit ${m.displayName()}.`);
                            hurtMonster(game, m, rng.d(2, 6)); return 'continue'; },
      });
      break;
    case 'finger of death':
      if (!dir) return true;
      fireBeam(game, p.x, p.y, dir, {
        range: 10, glyph: '*', colour: '#f85149',
        onMonster: (m) => {
          if (m.spec.undead) { game.msg(`${capitalise(m.displayName())} absorbs the deathly energy!`); m.hp = m.hpMax; }
          else { game.msg(`${capitalise(m.displayName())} is destroyed!`, 'good'); killMonster(game, m, 'kill'); }
          return 'stop';
        },
      });
      break;
    case 'sleep':
      if (!dir) return true;
      fireBeam(game, p.x, p.y, dir, {
        ray: true, range: 10, glyph: '*', colour: '#8ac0d8',
        onMonster: (m) => {
          if (m.spec.sleepRes || (m.spec.mr && rng.rn2(100) < m.spec.mr)) game.msg(`${capitalise(m.displayName())} resists.`);
          else { m.setStatus('sleeping', rng.int(10, 40)); game.msg(`${capitalise(m.displayName())} falls asleep.`); }
          return 'continue';
        },
      });
      break;
    case 'slow monster':
      if (!dir) return true;
      fireBeam(game, p.x, p.y, dir, {
        range: 8, glyph: '*', colour: '#8ac0d8',
        onMonster: (m) => { m.setStatus('slow', rng.int(20, 60)); game.msg(`${capitalise(m.displayName())} slows down.`); return 'stop'; },
      });
      break;
    case 'healing':
      healPlayer(game, rng.d(4, 4), 1); game.msg('You feel better.', 'good'); break;
    case 'extra healing':
      healPlayer(game, rng.d(6, 8), 2); p.clearStatus('blind'); game.msg('You feel much better.', 'good'); break;
    case 'cure blindness':
      p.clearStatus('blind'); game.msg('Your vision clears.', 'good'); break;
    case 'detect monsters':
      detectMonsters(game, 0); break;
    case 'light':
      lightArea(game, 1); game.msg('A lit field surrounds you.', 'magic'); break;
    case 'confuse monster':
      p.setStatus('confusing touch', 25); game.msg('Your hands begin to glow red.', 'magic'); break;
    case 'haste self':
      p.setStatus('fast', rng.int(20, 50)); game.msg('You are suddenly moving faster.', 'good'); break;
    case 'remove curse':
      for (const it of p.inventory) if ((it.worn || it.wielded) && it.bless < 0) { it.bless = 0; it.blessKnown = true; }
      game.msg('You feel like someone is helping you.', 'good'); break;
    case 'magic mapping':
      magicMap(game, true); break;
    case 'dig':
      if (!dir) { game.digDown(); } else digRay(game, dir); break;
    default:
      game.msg('Nothing happens.');
  }
  return true;
}

export function castMonsterSpell(game, mon, forced = null) {
  const p = game.player;
  const rng = game.rng;
  const kinds = forced ? [forced] : ['bolt', 'summon', 'curse', 'sleep', 'drain'];
  const kind = rng.pick(kinds);
  if (!game.level.isVisible(mon.x, mon.y)) game.msg('You hear a distant chant.');
  else game.msg(`${capitalise(mon.displayName())} casts a spell!`, 'warn');

  switch (kind) {
    case 'bolt':
      if (p.has('magicRes')) { game.msg('You feel a mild tingle.'); break; }
      damagePlayer(game, rng.d(Math.max(1, Math.floor(mon.level / 2)), 6), `${mon.name}'s spell`);
      break;
    case 'summon': {
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) game.spawnMonsterNear(mon.x, mon.y, 2);
      game.msg('Monsters appear from nowhere!', 'bad');
      break;
    }
    case 'curse': {
      const cands = p.inventory.filter((o) => o.bless >= 0 && (o.worn || o.wielded));
      if (cands.length && !p.has('magicRes')) {
        const o = rng.pick(cands);
        o.bless = -1;
        game.msg('You feel a malignant aura surround you.', 'bad');
      } else game.msg('You feel a strange sense of loss.');
      break;
    }
    case 'sleep':
      if (p.has('sleepRes') || p.has('freeAction')) { game.msg('You yawn.'); break; }
      game.msg('You fall asleep!', 'bad');
      p.setStatus('paralyzed', rng.int(5, 15));
      break;
    case 'drain':
      if (p.has('magicRes')) { game.msg('You feel momentarily weak.'); break; }
      game.msg('You feel your energy drain away.', 'bad');
      p.pw = Math.max(0, p.pw - rng.int(5, 20));
      break;
    default: break;
  }
}

export function breatheAt(game, mon, atk) {
  const p = game.player;
  const dx = Math.sign(p.x - mon.x), dy = Math.sign(p.y - mon.y);
  const elem = atk.effect;
  game.msg(`${capitalise(mon.displayName())} breathes ${elem}!`, 'bad');
  fireBeam(game, mon.x, mon.y, { dx, dy }, {
    ray: true, range: 10, glyph: '*',
    colour: elem === 'fire' ? '#ff7a3a' : elem === 'cold' ? '#8ad8f0' : '#ffe08a',
    hitsPlayer: () => {
      const resist = (elem === 'fire' && p.has('fireRes')) || (elem === 'cold' && p.has('coldRes')) ||
                     (elem === 'elec' && p.has('shockRes'));
      if (p.has('reflection')) { game.msg('The breath is reflected!', 'good'); hurtMonster(game, mon, game.rng.d(atk.n, atk.d)); return 'stop'; }
      if (resist) { game.msg('You are unharmed.'); return 'stop'; }
      damagePlayer(game, game.rng.d(atk.n, atk.d), `${mon.name}'s breath`);
      return 'stop';
    },
    onMonster: (m) => (m === mon ? 'continue' : 'continue'),
  });
}

// ===========================================================================
// shared utilities
// ===========================================================================

export function detectMonsters(game, permanent) {
  const lvl = game.level;
  if (!lvl.monsters.some((m) => m.alive)) { game.msg('You feel lonely.', 'warn'); return; }
  game.detectedMonsters = new Set(lvl.monsters.filter((m) => m.alive).map((m) => m.uid));
  game.detectUntil = game.turn + (permanent < 0 ? 999999 : 1);
  game.msg('You sense the presence of monsters.', 'magic');
}

export function detectObjects(game) {
  const lvl = game.level;
  if (!lvl.items.length) { game.msg('You feel a lack of something.', 'warn'); return; }
  for (const it of lvl.items) { lvl.seen[lvl.idx(it.x, it.y)] = 1; game.rememberObject(it); }
  game.msg('You sense the presence of objects.', 'magic');
}

export function magicMap(game, full) {
  const lvl = game.level;
  for (let i = 0; i < lvl.tiles.length; i++) {
    if (!full && game.rng.oneIn(3)) continue;
    if (lvl.tiles[i] === T.SDOOR) lvl.tiles[i] = T.DOOR_CLOSED;
    if (lvl.tiles[i] === T.SCORR) lvl.tiles[i] = T.CORRIDOR;
    if (lvl.tiles[i] !== T.STONE) lvl.seen[i] = 1;
  }
  game.msg('A map coalesces in your mind!', 'magic');
}

export function forgetMap(game, fraction) {
  const lvl = game.level;
  for (let i = 0; i < lvl.seen.length; i++) {
    if (game.rng.float() < fraction) { lvl.seen[i] = 0; lvl.memObj[i] = null; }
  }
}

export function lightArea(game, sign) {
  const lvl = game.level;
  const p = game.player;
  const room = lvl.roomAt(p.x, p.y);
  if (room) {
    room.lit = sign > 0;
    for (let y = room.y - 1; y <= room.y + room.h; y++)
      for (let x = room.x - 1; x <= room.x + room.w; x++)
        if (lvl.inBounds(x, y)) lvl.lit[lvl.idx(x, y)] = sign > 0 ? 1 : 0;
  } else {
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
      const x = p.x + dx, y = p.y + dy;
      if (lvl.inBounds(x, y)) lvl.lit[lvl.idx(x, y)] = sign > 0 ? 1 : 0;
    }
  }
}

export function teleportPlayer(game, mode) {
  const lvl = game.level;
  if (lvl.flags.noTeleport) { game.msg('You feel a wrenching sensation, but nothing happens.'); return; }
  const spot = lvl.randomFreeSpot(game.rng, { avoidStairs: false });
  if (!spot) { game.msg('You feel disoriented for a moment.'); return; }
  game.player.x = spot.x; game.player.y = spot.y;
  game.msg('You feel a wrenching sensation.', 'magic');
  game.afterMove();
}

export function polymorphPlayer(game) {
  // The hero does not change species in this game; polymorph instead scrambles
  // attributes and hit points, which preserves the "something happened and you
  // do not know if it was good" feel without a second creature model.
  const p = game.player;
  const rng = game.rng;
  const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  for (const k of keys) p.adjustAttr(k, rng.rn2(3) - 1, game);
  const d = rng.int(-6, 8);
  p.hpMax = Math.max(1, p.hpMax + d);
  p.hp = Math.min(p.hp, p.hpMax);
  game.msg('You feel like a new person!', 'magic');
}

// ===========================================================================
// traps
// ===========================================================================

export const TRAP_TYPES = [
  { key: 'arrow',     name: 'arrow trap',        minDepth: 1, glyph: '^', colour: '#b8bcc4' },
  { key: 'dart',      name: 'dart trap',         minDepth: 1, glyph: '^', colour: '#b8bcc4' },
  { key: 'pit',       name: 'pit',               minDepth: 1, glyph: '^', colour: '#7a6a52' },
  { key: 'squeaky',   name: 'squeaky board',     minDepth: 1, glyph: '^', colour: '#a9743a' },
  { key: 'bear',      name: 'bear trap',         minDepth: 2, glyph: '^', colour: '#8a8a94' },
  { key: 'sleep',     name: 'sleeping gas trap', minDepth: 3, glyph: '^', colour: '#8ac0d8' },
  { key: 'rust',      name: 'rust trap',         minDepth: 3, glyph: '^', colour: '#5a8ab0' },
  { key: 'spiked pit',name: 'spiked pit',        minDepth: 4, glyph: '^', colour: '#8a5a4a' },
  { key: 'anti magic',name: 'anti-magic field',  minDepth: 6, glyph: '^', colour: '#bc8cff' },
  { key: 'teleport',  name: 'teleportation trap',minDepth: 5, glyph: '^', colour: '#bc8cff' },
  { key: 'trapdoor',  name: 'trap door',         minDepth: 4, glyph: '^', colour: '#3a3a44' },
  { key: 'fire',      name: 'fire trap',         minDepth: 5, glyph: '^', colour: '#d9531e' },
  { key: 'magic',     name: 'magic trap',        minDepth: 7, glyph: '^', colour: '#bc8cff' },
  { key: 'polymorph', name: 'polymorph trap',    minDepth: 10, glyph: '^', colour: '#bc8cff' },
];

export function randomTrapType(rng, depth) {
  const pool = TRAP_TYPES.filter((t) => t.minDepth <= depth);
  return rng.pick(pool.length ? pool : TRAP_TYPES);
}

export function triggerTrap(game, trap, x, y) {
  const p = game.player;
  const rng = game.rng;
  trap.seen = true;

  switch (trap.key) {
    case 'arrow':
      game.msg('An arrow shoots out at you!', 'bad');
      if (rng.rn2(20) < 10 + p.ac) damagePlayer(game, rng.d(1, 6), 'an arrow trap');
      else game.msg('It misses.');
      break;
    case 'dart':
      game.msg('A little dart shoots out at you!', 'bad');
      if (rng.rn2(20) < 10 + p.ac) {
        damagePlayer(game, rng.d(1, 3), 'a dart trap');
        if (!p.has('poisonRes') && rng.oneIn(3)) { game.msg('The dart was poisoned!', 'bad'); p.adjustAttr('str', -1, game); }
      } else game.msg('It misses.');
      break;
    case 'pit':
      if (p.has('levitation')) { game.msg('You float over a pit.'); break; }
      game.msg('You fall into a pit!', 'bad');
      damagePlayer(game, rng.d(1, 6), 'a pit');
      p.setStatus('trapped', rng.int(2, 5));
      break;
    case 'spiked pit':
      if (p.has('levitation')) { game.msg('You float over a spiked pit.'); break; }
      game.msg('You fall into a pit of spikes!', 'bad');
      damagePlayer(game, rng.d(2, 6), 'a spiked pit');
      if (!p.has('poisonRes') && rng.oneIn(3)) { game.msg('The spikes were poisoned!', 'bad'); p.adjustAttr('str', -1, game); }
      p.setStatus('trapped', rng.int(3, 6));
      break;
    case 'bear':
      if (p.has('levitation')) { game.msg('You float over a bear trap.'); break; }
      game.msg('A bear trap closes on your foot!', 'bad');
      damagePlayer(game, rng.d(1, 4), 'a bear trap');
      p.setStatus('trapped', rng.int(4, 8));
      break;
    case 'squeaky':
      game.msg('A board beneath you squeaks loudly.', 'warn');
      for (const m of game.level.monsters) if (m.alive) { m.asleep = false; m.lastKnown = { x: p.x, y: p.y }; }
      break;
    case 'sleep':
      if (p.has('sleepRes') || p.has('freeAction')) { game.msg('You are enveloped in a cloud of gas!'); break; }
      game.msg('A cloud of gas puts you to sleep!', 'bad');
      p.setStatus('paralyzed', rng.int(5, 20));
      break;
    case 'rust': {
      game.msg('A gush of water hits you!', 'bad');
      const worn = ['body', 'helm', 'shield'].map((s) => p.equip[s]).filter(Boolean);
      if (worn.length) {
        const a = rng.pick(worn);
        if (a.erode < 3) { a.erode++; game.msg(`Your ${objName(a, game.disc, { article: false })} rusts.`, 'bad'); }
        else game.msg('Your armor is already thoroughly rusty.');
      }
      break;
    }
    case 'anti magic':
      game.msg('You feel your magical energy drain away.', 'bad');
      p.pw = 0;
      break;
    case 'teleport':
      teleportPlayer(game);
      break;
    case 'trapdoor':
      if (p.has('levitation')) { game.msg('You float over a trap door.'); break; }
      game.msg('A trap door opens up under you!', 'bad');
      game.changeLevel(1, true);
      return true;
    case 'fire':
      game.msg('A tower of flame erupts from the floor!', 'bad');
      if (p.has('fireRes')) game.msg('You are uninjured.');
      else damagePlayer(game, rng.d(2, 6), 'a fire trap');
      break;
    case 'magic': {
      const r = rng.rn2(20);
      if (r < 3) { game.msg('You are momentarily blinded by a flash of light!', 'bad'); p.setStatus('blind', rng.int(10, 30)); }
      else if (r < 6) { game.msg('You hear a deafening roar!', 'bad'); for (const m of game.level.monsters) m.asleep = false; }
      else if (r < 9) { game.msg('You feel deafened.'); }
      else if (r < 12) { game.msg('A shiver runs up and down your spine.'); }
      else if (r < 15) { game.msg('You suddenly yearn for your distant homeland.'); }
      else { game.msg('Suddenly you are surrounded by monsters!', 'bad');
             for (let i = 0; i < rng.int(2, 4); i++) game.spawnMonsterNear(p.x, p.y, 2); }
      break;
    }
    case 'polymorph':
      polymorphPlayer(game);
      break;
    default:
      game.msg('Nothing happens.');
  }
  return false;
}

// ===========================================================================
// eating
// ===========================================================================

const CORPSE_INTRINSIC = {
  'floating eye':  { grant: 'telepathy',  msg: 'You feel a strange mental acuity.' },
  'snake':         { grant: 'poisonRes',  msg: 'You feel healthy.' },
  'water moccasin':{ grant: 'poisonRes',  msg: 'You feel healthy.' },
  'giant beetle':  { grant: 'poisonRes',  msg: 'You feel healthy.' },
  'killer bee':    { grant: 'poisonRes',  msg: 'You feel healthy.' },
  'winter wolf':   { grant: 'coldRes',    msg: 'You feel a cold chill inside you.' },
  'hell hound':    { grant: 'fireRes',    msg: 'You feel a burning inside you.' },
  'red dragon':    { grant: 'fireRes',    msg: 'You feel a burning inside you.' },
  'gold dragon':   { grant: 'reflection', msg: 'Your scales feel harder.' },
  'quasit':        { grant: 'poisonRes',  msg: 'You feel healthy.' },
  'homunculus':    { grant: 'sleepRes',   msg: 'You feel wide awake.' },
  'mind flayer':   { grant: 'telepathy',  msg: 'Your mind expands.' },
};

export function eatObject(game, o) {
  const p = game.player;
  const base = objBase(o);
  const rng = game.rng;
  p.conductFoodless = false;

  if (o.corpseOf) {
    const spec = MONSTER_BY_KEY[o.monKey];
    const age = game.turn - (o.age ?? 0);
    game.msg(`You finish eating the ${o.corpseOf} corpse.`);

    if (spec?.stoner && !p.has('stoneRes')) {
      game.msg('You are turning to stone!', 'bad');
      p.setStatus('stoning', 5);
    }
    if (spec?.poisonous && !p.has('poisonRes')) {
      game.msg('Ecch - that must have been poisonous!', 'bad');
      p.adjustAttr('str', -1, game);
      damagePlayer(game, rng.rnd(15), 'a poisonous corpse');
    }
    if (age > 200 && rng.oneIn(2)) {
      game.msg('Ulch - that food was tainted!', 'bad');
      p.setStatus('sick', rng.int(10, 20));
    }
    if (spec?.undead || o.corpseOf.includes('zombie') || o.corpseOf.includes('mummy')) {
      if (rng.oneIn(3)) { game.msg('Ulch - that was rotten!', 'bad'); p.setStatus('confused', rng.int(5, 12)); }
    }
    const gift = CORPSE_INTRINSIC[o.monKey] || CORPSE_INTRINSIC[o.corpseOf];
    if (gift && rng.rn2(100) < Math.max(20, (spec?.lvl ?? 1) * 8)) {
      if (!p.intrinsics.has(gift.grant)) { p.intrinsics.add(gift.grant); game.msg(gift.msg, 'good'); }
    }
    if (spec?.corpseLevelUp) { game.msg('You feel more experienced.', 'good'); p.levelUp(game); }
    p.nutrition += o.nutrition ?? 100;
    return true;
  }

  game.msg(`You finish eating ${objName(o, game.disc, { article: 'the' })}.`);
  p.nutrition += base.nutrition ?? 100;

  if (base.curesBlind && p.hasStatus('blind')) { p.clearStatus('blind'); game.msg('Your vision clears.', 'good'); }
  if (base.gainStr) { p.adjustAttr('str', 1, game); game.msg('You feel much stronger.', 'good'); }
  if (base.fortune) game.msg(`This fortune cookie says: "${rng.pick(FORTUNES)}"`, 'magic');
  if (base.tripe && !p.hasStatus('hallucinating')) {
    game.msg('Yak - dog food!', 'warn');
    if (rng.oneIn(2)) { game.msg('You vomit.', 'bad'); p.nutrition = Math.max(0, p.nutrition - 100); }
  }
  return true;
}

const FORTUNES = [
  'Perhaps you should try dipping things into water.',
  'A nurse a day keeps the doctor away.',
  'Always attack a floating eye with a wielded weapon.',
  'Digging is a lot of work.',
  'Elbereth is a good word to know.',
  'Don Quixote wants his lance back.',
  'The gods are not impressed by your armour.',
  'Never ask a shopkeeper for a discount twice.',
  'Extra staircases are a sign of a generous architect.',
  'It is bad luck to eat your own corpse.',
];

// ===========================================================================
// engraving - Elbereth and friends
// ===========================================================================

export function engrave(game, text, type = 'dust') {
  const lvl = game.level;
  const i = lvl.idx(game.player.x, game.player.y);
  lvl.engravings.set(i, { text, type });
  game.msg(`You write in the dust with your fingertip: "${text}"`);
}

/** Does the square under a monster carry a ward it will not step on? */
export function scaresMonster(game, x, y, mon) {
  const e = game.level.engravingAt(x, y);
  if (!e) return false;
  if (!/elbereth/i.test(e.text)) return false;
  if (mon.spec.human || mon.spec.mindless || mon.specKey === 'wizard') return false;
  return true;
}
