// The Game object: state, the turn loop, and every command the hero can give.
//
// Turn model
// ----------
// Energy-based, not round-based. Everything that acts accumulates `speed`
// points per tick and spends 12 to take a turn, so a speed-18 giant ant gets
// three moves to your two and a speed-6 kobold gets one to your two. This is
// the single most important thing to get right in a roguelike: if speed is a
// flat "sometimes it moves twice", the player cannot reason about escape, and
// escape is most of the game.
//
// Commands are async because prompts are. `w` has to stop and ask *which*
// weapon, and the answer arrives from a DOM event several frames later. Making
// the whole command path `async` and awaiting the UI is far less error-prone
// than a callback-driven state machine, which is what this was before and it
// leaked half-finished commands on every escape key.

import { RNG, makeSeedPhrase } from '../core/rng.js';
import { DIRS, DIR_BY_KEY, dist, capitalise, listJoin, signed, clamp } from '../core/util.js';
import { Level, MAP_W, MAP_H } from '../map/level.js';
import { T, TILE, isDoor, isWalkable, isStairs, isDown, isUp, tileName, isDiggable,
         diagonalOk } from '../map/tiles.js';
import { generateLevel, DUNGEON_DEPTH } from '../map/mapgen.js';
import { computeFOV, lightRadius, hasLOS } from '../sys/fov.js';
import { astar, flowField, stepAlong } from '../sys/path.js';
import { Player, Monster, NORMAL_SPEED, resetMonUids } from './actors.js';
import { makeObj, makeGold, randomObj, objName, objBase, objWeight, objValue,
         shopPriceOf, damageDice, armorClassOf, resetObjIds } from './obj.js';
import { buildIdentityMap, OBJECTS, objType, NEEDS_ID } from '../data/items.js';
import { playerAttack, damagePlayer, hurtMonster, killMonster } from './combat.js';
import { monsterTurn } from './ai.js';
import { quaffPotion, readScroll, zapWand, castSpell, SPELLS, spellFailure,
         eatObject, engrave, triggerTrap, teleportPlayer, fireBeam,
         detectMonsters, magicMap, healPlayer, scaresMonster } from './effects.js';
import { populateLevel, spawnAt } from './populate.js';
import { pickMonsterSpec, MONSTERS, MONSTER_BY_KEY } from '../data/monsters.js';
import { ROLE_BY_KEY, xpForLevel, carryCapacity } from '../data/roles.js';

export const HUNGER = [
  { at: 2000, name: 'Satiated', cls: 'warn' },
  { at: 1000, name: 'Satiated', cls: 'warn' },
  { at: 150,  name: '',         cls: '' },
  { at: 50,   name: 'Hungry',   cls: 'warn' },
  { at: 0,    name: 'Weak',     cls: 'bad' },
  { at: -400, name: 'Fainting', cls: 'bad' },
];

const INV_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export class Game {
  constructor(ui) {
    this.ui = ui;
    this.running = false;
    this.busy = false;
  }

  // =========================================================================
  // lifecycle
  // =========================================================================

  newGame({ seed, role, name }) {
    resetObjIds(1);
    resetMonUids(1);
    this.seed = seed || makeSeedPhrase(new RNG(Date.now()));
    this.rng = new RNG(this.seed);
    this.player = new Player(role, name);
    this.turn = 0;
    this.startedAt = Date.now();
    this.levels = new Map();
    this.messages = [];
    this.msgQueue = [];
    this.stats = { kills: 0, deepest: 1, itemsFound: 0, goldFound: 0 };
    this.detectedMonsters = null;
    this.detectUntil = 0;
    this.running = true;
    this.gameOver = null;
    this.travelPath = null;
    this.runDir = null;

    this.disc = {
      idMap: buildIdentityMap(this.rng),
      known: new Set(),
      calledBy: new Map(),
      seenTypes: new Set(),
    };

    this.giveStartingKit();
    this.gotoLevel(1, 'up');

    this.msg(`Hello ${this.player.name}, welcome to claudeHack!  You are a ${this.player.roleName}.`, 'good');
    this.msg('Find the Amulet of Yendor, and bring it back to the surface.');
    return this;
  }

  giveStartingKit() {
    const role = ROLE_BY_KEY[this.player.role];
    for (const spec of role.startItems) {
      const o = makeObj(spec.key, spec.cls, this.rng, {
        count: spec.count ?? 1,
        bless: 0, blessKnown: true,
        enchant: spec.enchant ?? 0,
        ided: true,
        random: false,
      });
      o.enchantKnown = true;
      this.addToInventory(o);
      this.disc.known.add(`${o.cls}/${o.key}`);
      if (spec.wield) this.equipWeapon(o, true);
      if (spec.wear) this.wearArmor(o, true);
    }
    // Everyone gets a light source; a roguelike without one is a roguelike
    // played one square at a time.
    const lamp = makeObj('oil lamp', 'tool', this.rng, { bless: 0, blessKnown: true, ided: true, random: false });
    lamp.lit = true;
    this.addToInventory(lamp);
    this.player.equip.light = lamp;
  }

  // =========================================================================
  // levels
  // =========================================================================

  levelAt(depth) {
    if (!this.levels.has(depth)) {
      // Each level gets its own RNG stream derived from the run seed, so the
      // dungeon is the same whichever order you visit it in.
      const sub = new RNG(`${this.seed}#${depth}`);
      const saveRng = this.rng;
      this.rng = sub;
      const lvl = generateLevel(depth, sub);
      this.levels.set(depth, lvl);
      populateLevel(this, lvl);
      this.rng = saveRng;
    }
    return this.levels.get(depth);
  }

  gotoLevel(depth, arriveAt = 'up', keepPos = null) {
    const p = this.player;
    depth = clamp(depth, 0, DUNGEON_DEPTH);
    this.level = this.levelAt(depth);
    p.depth = depth;
    p.maxDepth = Math.max(p.maxDepth, depth);
    this.stats.deepest = Math.max(this.stats.deepest, depth);

    let spot;
    if (keepPos && this.level.walkable(keepPos.x, keepPos.y)) spot = keepPos;
    else if (arriveAt === 'up' && this.level.upStair) spot = this.level.upStair;
    else if (arriveAt === 'down' && this.level.downStair) spot = this.level.downStair;
    else spot = this.level.upStair || this.level.downStair || this.level.randomFreeSpot(this.rng);
    if (!spot) spot = { x: 1, y: 1 };

    // Never land on top of something.
    if (this.level.monsterAt(spot.x, spot.y)) {
      const alt = this.level.randomFreeSpot(this.rng);
      if (alt) spot = alt;
    }
    p.x = spot.x; p.y = spot.y;

    if (this.level.name) this.msg(`You enter ${this.level.name}.`, 'magic');
    this.afterMove();
  }

  changeLevel(delta, forced = false) {
    const p = this.player;
    const to = p.depth + delta;

    if (to < 1) {
      if (p.hasAmulet) { this.win(); return; }
      this.msg('You have nothing to return to the surface for. The dungeon is not finished with you.');
      return;
    }
    if (to > DUNGEON_DEPTH) { this.msg('You cannot go any deeper.'); return; }

    if (forced && delta > 0) this.msg('You fall through!', 'bad');
    this.gotoLevel(to, delta > 0 ? 'up' : 'down');
    this.msg(`You are now on dungeon level ${to}.`);

    // Monsters adjacent to the stairs follow you down. This is why you do not
    // take a staircase with a wounded troll next to you.
    if (!forced) this.followMonsters(delta);
  }

  followMonsters(delta) {
    const from = this.levels.get(this.player.depth - delta);
    if (!from) return;
    const stairT = delta > 0 ? T.STAIRS_DOWN : T.STAIRS_UP;
    let sx = -1, sy = -1;
    for (let y = 0; y < from.h && sx < 0; y++)
      for (let x = 0; x < from.w; x++) if (from.at(x, y) === stairT) { sx = x; sy = y; break; }
    if (sx < 0) return;
    for (const m of [...from.monsters]) {
      if (!m.alive || m.shopkeeper || m.spec.neverMove) continue;
      if (dist(m.x, m.y, sx, sy) > 1) continue;
      if (m.peaceful && !m.tame) continue;
      from.monsters.splice(from.monsters.indexOf(m), 1);
      const spot = this.freeNear(this.player.x, this.player.y, 2);
      if (spot) { this.level.addMonster(m, spot.x, spot.y); this.msg(`${capitalise(m.displayName())} follows you!`, 'warn'); }
    }
  }

  freeNear(x, y, radius) {
    const cands = [];
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!this.level.walkable(nx, ny)) continue;
        if (this.level.monsterAt(nx, ny)) continue;
        if (nx === this.player.x && ny === this.player.y) continue;
        cands.push({ x: nx, y: ny });
      }
    return cands.length ? this.rng.pick(cands) : null;
  }

  digDown() {
    if (this.player.depth >= DUNGEON_DEPTH) { this.msg('The floor here is too hard to dig in.'); return; }
    this.msg('You dig a hole through the floor.');
    this.changeLevel(1, true);
  }

  // =========================================================================
  // messages, prompts and discovery
  // =========================================================================

  msg(text, cls = '') {
    if (!text) return;
    if (this.player?.hasStatus('hallucinating') && this.rng.oneIn(6)) {
      text = text.replace(/\b(kill|hit|attack)\b/gi, (m) => this.rng.pick(['boogie with', 'tickle', 'high-five']));
    }
    this.messages.push({ text, cls, turn: this.turn });
    if (this.messages.length > 400) this.messages.shift();
    this.ui?.pushMessage(text, cls);
  }

  discover(o) {
    if (!NEEDS_ID.has(o.cls)) return;
    const k = `${o.cls}/${o.key}`;
    if (this.disc.known.has(k)) return;
    this.disc.known.add(k);
    this.msg(`You have discovered ${objName(o, this.disc, { article: 'a', count: false })
      .replace(/^\d+ /, '')}.`, 'magic');
  }

  identifyObject(o) {
    o.ided = true;
    o.blessKnown = true;
    o.enchantKnown = true;
    if (o.charges !== null) o.chargesKnown = true;
    if (NEEDS_ID.has(o.cls)) this.disc.known.add(`${o.cls}/${o.key}`);
  }

  /** Flash a beam or missile path. Purely cosmetic; the UI may ignore it. */
  animateTrail(cells, glyph, colour) {
    this.ui?.animateTrail?.(cells, glyph, colour);
  }

  rememberObject(o) {
    const lvl = this.level;
    const base = objBase(o);
    lvl.memObj[lvl.idx(o.x, o.y)] = { glyph: base.glyph, colour: base.colour, sprite: base.sprite };
  }

  // =========================================================================
  // inventory
  // =========================================================================

  nextLetter() {
    const used = new Set(this.player.inventory.map((o) => o.letter));
    for (const c of INV_LETTERS) if (!used.has(c)) return c;
    return '#';
  }

  addToInventory(o) {
    const p = this.player;
    if (o.cls === 'coin') { p.gold += o.count; this.stats.goldFound += o.count; return null; }
    for (const it of p.inventory) {
      if (canStack(it, o)) { it.count += o.count; return it; }
    }
    o.letter = this.nextLetter();
    p.inventory.push(o);
    p.inventory.sort((a, b) => INV_LETTERS.indexOf(a.letter) - INV_LETTERS.indexOf(b.letter));
    return o;
  }

  removeFromInventory(o, count = null) {
    const p = this.player;
    if (count !== null && count < o.count) { o.count -= count; return { ...o, count, letter: null }; }
    const i = p.inventory.indexOf(o);
    if (i >= 0) p.inventory.splice(i, 1);
    this.unequip(o, true);
    return o;
  }

  unequip(o, silent = false) {
    const e = this.player.equip;
    for (const slot of Object.keys(e)) if (e[slot] === o) { e[slot] = null; o.worn = false; o.wielded = false; o.quivered = false; }
  }

  invByClass(...classes) {
    return this.player.inventory.filter((o) => classes.includes(o.cls));
  }

  // =========================================================================
  // the turn loop
  // =========================================================================

  /** Entry point from the UI. Runs one command and then everyone else's turn. */
  async command(key) {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const spent = await this.doCommand(key);
      if (spent && this.running) await this.endPlayerTurn();
    } catch (err) {
      console.error(err);
      this.msg(`(internal error: ${err.message})`, 'bad');
    } finally {
      this.busy = false;
      this.ui.render();
    }
  }

  async endPlayerTurn() {
    // The hero has spent their action; now everything else gets a chance.
    let guard = 0;
    do {
      this.turn++;
      this.upkeep();
      if (!this.running) return;
      this.monstersAct();
      if (!this.running) return;
      this.level.removeDead();
    } while (!this.player.takesTurn() && guard++ < 60);

    this.afterMove();

    // Anything that removes agency keeps running turns until it lapses.
    if (this.running && this.isIncapacitated()) {
      this.ui.render();
      await this.ui.sleep(80);
      if (this.running) await this.endPlayerTurn();
    }
  }

  isIncapacitated() {
    const p = this.player;
    return p.hasStatus('paralyzed') || p.hasStatus('sleeping');
  }

  monstersAct() {
    const list = [...this.level.monsters];
    for (const m of list) {
      if (!m.alive) continue;
      m.gainEnergy();
      let guard = 0;
      while (m.canAct() && guard++ < 4) {
        if (!m.alive || !this.running) break;
        // Elbereth: most things will not step onto the ward.
        if (scaresMonster(this, this.player.x, this.player.y, m) && dist(m.x, m.y, this.player.x, this.player.y) <= 1) {
          m.fleeing = Math.max(m.fleeing, 3);
        }
        monsterTurn(this, m);
      }
    }
  }

  upkeep() {
    const p = this.player;
    const rng = this.rng;

    // ---- hunger
    let burn = 1;
    for (const slot of ['ringL', 'ringR']) {
      const r = p.equip[slot];
      if (r) burn += objBase(r)?.hunger ?? 1;
    }
    if (p.has('regeneration')) burn += 1;
    if (p.has('slowDigestion')) burn = Math.max(0, burn - 1);
    const before = p.nutrition;
    p.nutrition -= burn;
    this.hungerMessages(before, p.nutrition);
    if (p.nutrition < -400) { this.die('starvation'); return; }
    if (p.nutrition < 0 && rng.oneIn(20)) {
      this.msg('You faint from lack of food.', 'bad');
      p.setStatus('paralyzed', rng.int(3, 8));
    }

    // ---- regeneration
    const healEvery = p.has('regeneration') ? 3 : Math.max(3, 20 - p.xpLevel);
    if (p.hp < p.hpMax && this.turn % healEvery === 0 && p.nutrition > 0) p.hp++;
    const pwEvery = Math.max(4, 25 - p.xpLevel - Math.floor(p.attr.wis / 3));
    if (p.pw < p.pwMax && this.turn % pwEvery === 0) p.pw++;

    // ---- statuses
    const expired = p.tickStatuses();
    for (const s of expired) {
      if (s === 'blind') this.msg('You can see again.', 'good');
      if (s === 'confused') this.msg('You feel less confused.');
      if (s === 'hallucinating') this.msg('Everything looks SO boring now.');
      if (s === 'levitating') this.msg('You float gently to the ground.');
      if (s === 'invisible') this.msg('You are no longer invisible.');
      if (s === 'fast') this.msg('You slow down.');
      if (s === 'slow') this.msg('You speed up.');
      if (s === 'paralyzed') this.msg('You can move again.');
      if (s === 'trapped') this.msg('You climb out.');
      if (s === 'stuck') this.msg('You are free.');
    }
    if (p.hasStatus('stoning')) {
      const t = p.statusTurns('stoning');
      if (t === 4) this.msg('You are slowing down.', 'bad');
      else if (t === 3) this.msg('Your limbs are stiffening.', 'bad');
      else if (t === 2) this.msg('Your limbs have turned to stone.', 'bad');
      else if (t <= 1) { this.die('petrification'); return; }
    }
    if (p.hasStatus('sick') && p.statusTurns('sick') <= 1) { this.die('illness'); return; }
    if (p.equip.amulet?.key === 'strangulation' && this.turn % 6 === 0) {
      this.msg('It constricts your throat!', 'bad');
      damagePlayer(this, 6, 'strangulation');
    }
    if (p.hasStatus('lycanthropy') && rng.oneIn(80)) {
      this.msg('You feel feverish.', 'bad');
      for (let i = 0; i < 2; i++) this.spawnMonsterNear(p.x, p.y, 3);
    }

    // ---- lamp fuel
    const lamp = p.equip.light;
    if (lamp && lamp.lit && lamp.fuel > 0) {
      lamp.fuel--;
      if (lamp.fuel === 50) this.msg('Your lamp is getting dim.', 'warn');
      if (lamp.fuel <= 0) { lamp.lit = false; this.msg('Your lamp goes out.', 'warn'); }
    }

    // ---- new arrivals
    if (rng.oneIn(70 + this.level.depth * 2)) {
      const spot = this.level.randomFreeSpot(rng, { awayFrom: p, minDist: 12 });
      if (spot) spawnAt(this, this.level, spot.x, spot.y, { asleep: false });
    }

    // ---- searching
    if (p.has('searching') && rng.oneIn(3)) this.doSearch(1, true);

    if (this.detectedMonsters && this.turn > this.detectUntil) this.detectedMonsters = null;
  }

  hungerMessages(before, after) {
    const cross = (n) => before >= n && after < n;
    if (cross(1000)) this.msg('You are no longer satiated.');
    if (cross(150))  this.msg('You are beginning to feel hungry.', 'warn');
    if (cross(50))   this.msg('You are getting weak from hunger.', 'bad');
    if (cross(0))    this.msg('You are beginning to faint from lack of food.', 'bad');
  }

  afterMove() {
    const p = this.player;
    computeFOV(this.level, p.x, p.y, lightRadius(p, this.level), p.hasStatus('blind'));
    // Remember every object currently in view.
    for (const o of this.level.items) {
      if (this.level.isVisible(o.x, o.y)) this.rememberObject(o);
    }
    for (let i = 0; i < this.level.visible.length; i++) {
      if (this.level.visible[i] && !this.level.items.some((o) => this.level.idx(o.x, o.y) === i)) {
        this.level.memObj[i] = null;
      }
    }
    this.ui.render();
  }

  monsterSteppedOn(mon) {
    const trap = this.level.trapAt(mon.x, mon.y);
    if (!trap) return;
    if (trap.key === 'pit' || trap.key === 'bear' || trap.key === 'spiked pit') {
      if (!mon.spec.flies) {
        mon.setStatus('paralyzed', this.rng.int(2, 5));
        if (this.level.isVisible(mon.x, mon.y)) {
          this.msg(`${capitalise(mon.displayName())} falls into a ${trap.name}!`);
          trap.seen = true;
        }
      }
    }
  }

  spawnMonsterNear(x, y, radius) {
    const spot = this.freeNear(x, y, radius) || this.level.randomFreeSpot(this.rng);
    if (!spot) return null;
    return spawnAt(this, this.level, spot.x, spot.y, { noGroup: true });
  }

  angerNeighbours(mon) {
    if (!mon.spec.human && !mon.shopkeeper) return;
    for (const m of this.level.monsters) {
      if (m.alive && m.peaceful && m.spec.human && dist(m.x, m.y, mon.x, mon.y) < 8) m.peaceful = false;
    }
  }

  // =========================================================================
  // command dispatch
  // =========================================================================

  async doCommand(key) {
    const p = this.player;

    if (this.isIncapacitated()) return true;     // burn the turn

    // Movement, running and travel first - they are 90% of all input.
    const dir = this.dirFromKey(key);
    if (dir) return await this.tryMove(dir.dx, dir.dy);
    const run = this.runDirFromKey(key);
    if (run) return await this.doRun(run);

    switch (key) {
      case '.': case ' ': case 'numpad5': return this.doRest();
      case 's': return this.doSearch(1);
      case 'S': await this.doSaveAndQuit(); return false;

      case ',': case 'g': return await this.doPickup();
      case 'd': return await this.doDrop(false);
      case 'D': return await this.doDrop(true);
      case 'i': await this.showInventory(); return false;
      case 'I': await this.showInventory(); return false;

      case 'w': return await this.doWield();
      case 'W': return await this.doWear();
      case 'T': return await this.doTakeOff();
      case 'P': return await this.doPutOn();
      case 'R': return await this.doRemove();
      case 'x': return this.doSwapWeapon();

      case 'q': return await this.doQuaff();
      case 'r': return await this.doRead();
      case 'z': return await this.doZap();
      case 'Z': return await this.doCast();
      case 'e': return await this.doEat();
      case 'a': return await this.doApply();
      case 't': return await this.doThrow();
      case 'f': return await this.doFire();
      case 'Q': return await this.doQuiver();
      case 'E': return await this.doEngrave();
      case 'p': return await this.doPay();
      case 'c': return await this.doClose();
      case 'o': return await this.doOpen();
      case 'k': return false;   // unreachable; movement handled above
      case '#': return await this.doExtended();

      case '>': return this.doDownstairs();
      case '<': return this.doUpstairs();

      case ':': return this.lookHere();
      case ';': await this.doFarLook(); return false;
      case '^': return await this.doIdentifyTrap();
      case '_': await this.doTravel(); return false;
      case '\\': await this.showDiscoveries(); return false;
      case '?': await this.ui.showHelp(); return false;
      case 'C-x': await this.showEnlightenment(); return false;
      case 'C-p': await this.showMessageHistory(); return false;
      case 'C-f': return await this.doAutoExplore();
      case 'v': await this.ui.showText('Version', ['claudeHack ' + VERSION,
                  'A NetHack-like, written for the browser.', `Seed: ${this.seed}`]); return false;
      default:
        if (key.length === 1) this.msg(`Unknown command '${key}'.  Press ? for help.`);
        return false;
    }
  }

  dirFromKey(key) {
    if (DIR_BY_KEY[key]) return DIR_BY_KEY[key];
    const arrows = { ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j' };
    if (arrows[key]) return DIR_BY_KEY[arrows[key]];
    const numpad = { numpad1: 'b', numpad2: 'j', numpad3: 'n', numpad4: 'h',
                     numpad6: 'l', numpad7: 'y', numpad8: 'k', numpad9: 'u' };
    if (numpad[key]) return DIR_BY_KEY[numpad[key]];
    return null;
  }

  runDirFromKey(key) {
    const map = { H: 'h', J: 'j', K: 'k', L: 'l', Y: 'y', U: 'u', B: 'b', N: 'n' };
    return map[key] ? DIR_BY_KEY[map[key]] : null;
  }

  // ------------------------------------------------------------- movement

  async tryMove(dx, dy) {
    const p = this.player;
    const lvl = this.level;

    if (p.hasStatus('trapped')) {
      this.msg('You are stuck.');
      if (this.rng.oneIn(3)) { p.clearStatus('trapped'); this.msg('You pull free.'); }
      return true;
    }
    if (p.hasStatus('stuck')) {
      this.msg('You are held fast.');
      if (this.rng.oneIn(3)) { p.clearStatus('stuck'); this.msg('You break free.'); }
      return true;
    }
    if (p.hasStatus('confused') && this.rng.oneIn(2)) {
      const d = this.rng.pick(DIRS); dx = d.dx; dy = d.dy;
    }
    if (p.hasStatus('scared')) {
      this.msg('You are too frightened to advance.');
      return true;
    }

    const nx = p.x + dx, ny = p.y + dy;
    if (!lvl.inBounds(nx, ny)) { this.msg('You cannot go that way.'); return false; }

    const mon = lvl.monsterAt(nx, ny);
    if (mon && mon.alive) {
      if (mon.peaceful) {
        const yes = await this.ui.yesno(`Really attack ${mon.displayName()}?`);
        if (!yes) { this.msg('You stop.'); return false; }
      }
      if (p.hasStatus('confusing touch')) {
        mon.setStatus('confused', this.rng.int(5, 12));
        p.clearStatus('confusing touch');
        this.msg(`${capitalise(mon.displayName())} looks confused.`, 'magic');
      }
      return playerAttack(this, mon);
    }

    const t = lvl.at(nx, ny);
    if (t === T.DOOR_CLOSED) {
      lvl.set(nx, ny, T.DOOR_OPEN);
      this.msg('You open the door.');
      return true;
    }
    if (t === T.DOOR_LOCKED) {
      this.msg('This door is locked.');
      return false;
    }
    if (!lvl.passable(nx, ny)) {
      if (t === T.STONE || t === T.WALL || t === T.SDOOR || t === T.SCORR) {
        // Bumping into rock while confused should still cost a turn; walking
        // into a wall you can see should not.
        if (p.hasStatus('confused') || p.hasStatus('blind')) {
          this.msg('You bump into a wall.');
          if (p.hasStatus('blind')) lvl.markSeen(nx, ny);
          return true;
        }
      }
      this.msg(`There is ${tileName(t) === 'solid rock' ? 'solid rock' : 'a ' + tileName(t)} in the way.`);
      return false;
    }
    // No squeezing diagonally through a doorway - into one, out of one, or
    // past its frame. Same predicate the pathfinder uses.
    if (!diagonalOk(lvl, p.x, p.y, nx, ny)) {
      this.msg('You cannot pass diagonally through a doorway.');
      return false;
    }
    if (p.encumbrance() >= 4) { this.msg('You collapse under your load.', 'bad'); return true; }

    p.x = nx; p.y = ny;
    this.afterMove();
    this.onEnterTile();
    return true;
  }

  onEnterTile() {
    const p = this.player;
    const lvl = this.level;
    const t = lvl.at(p.x, p.y);

    if (t === T.LAVA && !p.has('levitation')) {
      if (p.has('fireRes')) this.msg('The lava here is not hot enough to burn you.');
      else { this.msg('You burn to a crisp.', 'bad'); this.die('molten lava'); return; }
    }
    if (t === T.WATER && !p.has('levitation')) {
      this.msg('You are in the water.', 'warn');
      if (this.rng.oneIn(3)) {
        const drop = p.inventory.filter((o) => !o.worn && !o.wielded && o.cls === 'scroll');
        if (drop.length) { const o = this.rng.pick(drop); o.key = 'blank paper'; this.msg('Your scroll fades.', 'bad'); }
      }
    }

    const trap = lvl.trapAt(p.x, p.y);
    if (trap && !p.has('levitation')) {
      if (!trap.seen || this.rng.oneIn(4)) {
        this.msg(`There is ${trap.name === 'pit' ? 'a pit' : 'a ' + trap.name} here.`, 'warn');
        if (triggerTrap(this, trap, p.x, p.y)) return;
      } else this.msg(`There is ${trap.name} here.`);
    }

    const items = lvl.itemsAt(p.x, p.y);
    if (items.length === 1) {
      const o = items[0];
      if (o.cls === 'coin' && !o.shopOwned) {
        p.gold += o.count; this.stats.goldFound += o.count;
        this.msg(`${o.count} gold piece${o.count === 1 ? '' : 's'}.`, 'good');
        lvl.removeItem(o);
      } else {
        this.msg(`You see here ${objName(o, this.disc)}${o.shopOwned ? ` (${shopPriceOf(o, p)} zorkmids)` : ''}.`);
      }
    } else if (items.length > 1) {
      this.msg(`There are ${items.length} objects here.`);
    }

    const eng = lvl.engravingAt(p.x, p.y);
    if (eng) this.msg(`Something is written here in the dust. You read: "${eng.text}"`);

    if (isStairs(t)) this.msg(`There is ${tileName(t)} here.`);
    if (t === T.FOUNTAIN) this.msg('There is a fountain here.');
    if (t === T.ALTAR) this.msg('There is an altar here.');
    if (t === T.GRAVE) this.msg('There is a grave here.');

    const shop = this.inShop(p.x, p.y);
    if (shop && shop !== this.lastShop) {
      this.lastShop = shop;
      if (!shop.abandoned) this.msg(`"Welcome to ${shop.shk.customName}'s ${shop.kind}!"`, 'good');
    } else if (!shop) this.lastShop = null;
  }

  async doRun(dir) {
    // Run until something interesting happens. "Interesting" is the same list
    // NetHack uses, minus the ones that need a full dungeon feature model.
    let steps = 0;
    while (steps++ < 60 && this.running) {
      const p = this.player;
      const nx = p.x + dir.dx, ny = p.y + dir.dy;
      if (!this.level.passable(nx, ny)) break;
      if (this.level.monsterAt(nx, ny)) break;
      if (this.visibleThreat()) break;
      const moved = await this.tryMove(dir.dx, dir.dy);
      if (!moved) break;
      await this.endPlayerTurn();
      if (this.level.itemsAt(p.x, p.y).length) break;
      if (this.level.trapAt(p.x, p.y)) break;
      if (isStairs(this.level.at(p.x, p.y))) break;
      if (isDoor(this.level.at(p.x, p.y))) break;
      if (this.branchingCorridor()) break;
      this.ui.render();
      await this.ui.sleep(12);
    }
    return false;
  }

  /**
   * Is there something in view worth stopping a run or an autoexplore for?
   *
   * A sleeping newt and a green mold are technically hostile and technically
   * visible, and treating them as threats made autoexplore refuse to take
   * another step for the rest of the level. What actually warrants interrupting
   * is something that can close on you: awake, mobile, and near.
   */
  visibleThreat() {
    const p = this.player;
    for (const m of this.level.monsters) {
      if (!m.alive || m.peaceful) continue;
      if (!this.level.isVisible(m.x, m.y)) continue;
      const d = dist(m.x, m.y, p.x, p.y);
      if (d <= 1) return true;
      if (m.asleep || m.hasStatus('sleeping') || m.spec.neverMove) continue;
      if (d < 8) return true;
    }
    return false;
  }

  branchingCorridor() {
    const p = this.player;
    if (this.level.at(p.x, p.y) !== T.CORRIDOR) return false;
    let exits = 0;
    for (const d of DIRS) if (this.level.passable(p.x + d.dx, p.y + d.dy)) exits++;
    return exits > 2;
  }

  doRest() {
    return true;
  }

  doSearch(times = 1, silent = false) {
    const p = this.player;
    let found = 0;
    for (let n = 0; n < times; n++) {
      for (const d of DIRS) {
        const x = p.x + d.dx, y = p.y + d.dy;
        if (!this.level.inBounds(x, y)) continue;
        if (this.level.hasSecretAt(x, y)) {
          const chance = 5 + (p.skills.search ?? 0) * 3 + (p.has('searching') ? 6 : 0) + Math.floor(p.attr.wis / 4);
          if (this.rng.rn2(20) < chance) {
            const what = this.level.revealSecret(x, y);
            this.msg(what === 'door' ? 'You find a hidden door!' : 'You find a hidden passage!', 'good');
            found++;
          }
        }
        const trap = this.level.trapAt(x, y);
        if (trap && !trap.seen && this.rng.oneIn(3)) {
          trap.seen = true;
          this.msg(`You find ${trap.name}.`, 'warn');
          found++;
        }
      }
    }
    if (found) this.afterMove();
    return !silent;
  }

  // ------------------------------------------------------------- stairs

  doDownstairs() {
    const t = this.level.at(this.player.x, this.player.y);
    if (!isDown(t)) { this.msg("You can't go down here."); return false; }
    this.changeLevel(1);
    return true;
  }

  doUpstairs() {
    const t = this.level.at(this.player.x, this.player.y);
    if (!isUp(t)) { this.msg("You can't go up here."); return false; }
    if (this.player.depth === 1) {
      if (this.player.hasAmulet) { this.win(); return true; }
      this.msg('You are not ready to leave the dungeon empty-handed.');
      return false;
    }
    this.changeLevel(-1);
    return true;
  }

  // ------------------------------------------------------------- objects

  async doPickup() {
    const p = this.player;
    const here = this.level.itemsAt(p.x, p.y);
    if (!here.length) { this.msg('There is nothing here to pick up.'); return false; }

    let chosen = here;
    if (here.length > 1) {
      chosen = await this.ui.pickMany('Pick up what?', here.map((o) => ({
        obj: o, label: objName(o, this.disc) + (o.shopOwned ? ` (${shopPriceOf(o, p)} zorkmids)` : ''),
      })));
      if (!chosen || !chosen.length) return false;
    }

    let any = false;
    for (const o of chosen) {
      if (o.cls === 'coin' && !o.shopOwned) {
        p.gold += o.count; this.stats.goldFound += o.count;
        this.msg(`${o.count} gold piece${o.count === 1 ? '' : 's'}.`, 'good');
        this.level.removeItem(o); any = true; continue;
      }
      if (p.totalWeight() + objWeight(o) > p.maxCarry * 2.5) {
        this.msg(`You are carrying too much to pick up ${objName(o, this.disc)}.`, 'warn');
        continue;
      }
      this.level.removeItem(o);
      if (o.shopOwned) {
        const shop = this.shopOwning(o);
        // Name it before pricing it: objName() appends "(unpaid, N zorkmids)"
        // once shopPrice is set, and the quote would read
        // "the crossbow (unpaid, 53 zorkmids) will cost 53 zorkmids".
        const quoted = objName(o, this.disc, { article: 'the' });
        const price = shopPriceOf(o, p);
        if (shop && !shop.abandoned) {
          o.shopPrice = price;
          this.msg(`"For you, ${quoted} will cost ${price} zorkmids."`, 'warn');
        } else o.shopPrice = 0;
        o.shopOwned = false;
      }
      const held = this.addToInventory(o);
      this.stats.itemsFound++;
      this.msg(`${held.letter} - ${objName(held, this.disc)}`);
      if (o.key === 'Amulet of Yendor') {
        p.hasAmulet = true;
        this.msg('You feel a strange sense of destiny. Now get out of here alive.', 'magic');
      }
      any = true;
    }
    return any;
  }

  shopOwning(o) {
    for (const s of this.level.shops) if (s.items.includes(o)) return s;
    return null;
  }

  inShop(x, y) {
    for (const s of this.level.shops) {
      const r = s.room;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return s;
    }
    return null;
  }

  shopDebt(shop) {
    let owed = 0;
    for (const o of this.player.inventory) if (o.shopPrice > 0) owed += o.shopPrice;
    return owed;
  }

  async doDrop(multiple) {
    const p = this.player;
    if (!p.inventory.length) { this.msg('You are not carrying anything.'); return false; }

    let list;
    if (multiple) {
      const chosen = await this.ui.pickMany('Drop what?', p.inventory.map((o) => ({
        obj: o, letter: o.letter, label: objName(o, this.disc),
      })));
      list = chosen || [];
    } else {
      const o = await this.ui.pickItem('What do you want to drop?', p.inventory.map((it) => ({
        obj: it, letter: it.letter, label: objName(it, this.disc),
      })));
      list = o ? [o] : [];
    }
    if (!list.length) return false;

    for (const o of list) {
      if (o.key === 'Amulet of Yendor') p.hasAmulet = false;
      if (o.bless < 0 && (o.worn || o.wielded)) {
        this.msg(`You cannot. ${capitalise(objName(o, this.disc, { article: 'the' }))} is welded to you.`, 'bad');
        o.blessKnown = true;
        continue;
      }
      this.removeFromInventory(o);
      o.shopOwned = false;
      if (o.shopPrice > 0 && this.inShop(p.x, p.y)) {
        this.msg(`"Thank you for returning ${objName(o, this.disc, { article: 'the' })}."`);
        o.shopPrice = 0;
        const shop = this.inShop(p.x, p.y);
        if (shop) { o.shopOwned = true; shop.items.push(o); }
      }
      this.level.addItem(o, p.x, p.y);
      this.msg(`You drop ${objName(o, this.disc)}.`);
    }
    return true;
  }

  async showInventory() {
    const p = this.player;
    if (!p.inventory.length) { this.msg('You are not carrying anything.'); return; }
    const groups = groupInventory(p.inventory, this.disc);
    await this.ui.showMenu('Inventory', groups, { readonly: true });
  }

  // ------------------------------------------------------------ equipment

  equipWeapon(o, silent = false) {
    const p = this.player;
    const old = p.equip.weapon;
    if (old) { old.wielded = false; }
    if (o) { o.wielded = true; p.equip.weapon = o; }
    else p.equip.weapon = null;
    if (!silent) {
      if (o) this.msg(`${o.letter} - ${objName(o, this.disc)} (weapon in hand).`);
      else this.msg('You are empty handed.');
    }
  }

  async doWield() {
    const p = this.player;
    const cands = p.inventory.filter((o) => o.cls === 'weapon' || (o.cls === 'tool' && objBase(o)?.weapon));
    const entries = cands.map((o) => ({ obj: o, letter: o.letter, label: objName(o, this.disc) }));
    entries.push({ obj: null, letter: '-', label: 'nothing (fight bare-handed)' });
    const o = await this.ui.pickItem('What do you want to wield?', entries);
    if (o === undefined) return false;
    if (p.equip.weapon && p.equip.weapon.bless < 0) {
      this.msg('You cannot. Your weapon is welded to your hand!', 'bad');
      p.equip.weapon.blessKnown = true;
      return true;
    }
    if (o && objBase(o)?.twoHanded && p.equip.shield) {
      this.msg('You cannot wield a two-handed weapon while wearing a shield.');
      return false;
    }
    this.equipWeapon(o);
    if (o && o.bless < 0) { o.blessKnown = true; this.msg('The weapon welds itself to your hand!', 'bad'); }
    return true;
  }

  doSwapWeapon() {
    const p = this.player;
    const alt = p.altWeapon ?? null;
    const cur = p.equip.weapon;
    if (cur && cur.bless < 0) { this.msg('Your weapon is welded to your hand!'); return true; }
    p.altWeapon = cur;
    this.equipWeapon(alt);
    return true;
  }

  wearArmor(o, silent = false) {
    const p = this.player;
    const slot = objBase(o).slot;
    p.equip[slot] = o;
    o.worn = true;
    if (!silent) this.msg(`You are now wearing ${objName(o, this.disc)}.`);
  }

  async doWear() {
    const p = this.player;
    const cands = p.inventory.filter((o) => o.cls === 'armor' && !o.worn);
    if (!cands.length) { this.msg('You have nothing else to wear.'); return false; }
    const o = await this.ui.pickItem('What do you want to wear?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    const slot = objBase(o).slot;
    if (p.equip[slot]) { this.msg(`You are already wearing something on your ${slotName(slot)}.`); return false; }
    if (slot === 'body' && p.equip.cloak) { this.msg('You must take off your cloak first.'); return false; }
    if (slot === 'shield' && p.equip.weapon && objBase(p.equip.weapon)?.twoHanded) {
      this.msg('You cannot wear a shield while wielding a two-handed weapon.'); return false;
    }
    this.wearArmor(o);
    if (o.bless < 0) { o.blessKnown = true; this.msg('You feel a malignant aura surround you.', 'bad'); }
    return true;
  }

  async doTakeOff() {
    const p = this.player;
    const worn = ['body', 'cloak', 'helm', 'gloves', 'boots', 'shield'].map((s) => p.equip[s]).filter(Boolean);
    if (!worn.length) { this.msg('You are not wearing any armor.'); return false; }
    const o = worn.length === 1 ? worn[0] : await this.ui.pickItem('What do you want to take off?',
      worn.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    if (o.bless < 0) { o.blessKnown = true; this.msg('You cannot. It is cursed.', 'bad'); return true; }
    if (objBase(o).slot === 'body' && p.equip.cloak) { this.msg('You must take off your cloak first.'); return false; }
    p.equip[objBase(o).slot] = null;
    o.worn = false;
    this.msg(`You were wearing ${objName(o, this.disc)}.`);
    return true;
  }

  async doPutOn() {
    const p = this.player;
    const cands = p.inventory.filter((o) => (o.cls === 'ring' || o.cls === 'amulet') && !o.worn);
    if (!cands.length) { this.msg('You have nothing to put on.'); return false; }
    const o = await this.ui.pickItem('What do you want to put on?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    if (o.cls === 'amulet') {
      if (p.equip.amulet) { this.msg('You are already wearing an amulet.'); return false; }
      p.equip.amulet = o; o.worn = true;
      this.msg(`${objName(o, this.disc)} (being worn).`);
      if (o.key === 'strangulation') { this.msg('It constricts your throat!', 'bad'); o.bless = -1; o.blessKnown = true; }
      if (o.key === 'ESP') { p.intrinsics.add('telepathy'); }
    } else {
      const slot = !p.equip.ringL ? 'ringL' : !p.equip.ringR ? 'ringR' : null;
      if (!slot) { this.msg('You are already wearing two rings.'); return false; }
      p.equip[slot] = o; o.worn = true;
      this.msg(`${objName(o, this.disc)} (on ${slot === 'ringL' ? 'left' : 'right'} hand).`);
      if (o.key === 'levitation') { p.setStatus('levitating', -1); this.msg('You float up!', 'magic'); this.discover(o); }
      if (o.key === 'invisibility') { p.setStatus('invisible', -1); this.discover(o); }
      if (o.key === 'hunger') this.msg('You feel hungry.', 'warn');
      if (o.key === 'aggravate monster') this.msg('You feel a strange sense of being watched.', 'warn');
    }
    if (o.bless < 0) { o.blessKnown = true; this.msg('Oops. That felt deadly cold.', 'bad'); }
    return true;
  }

  async doRemove() {
    const p = this.player;
    const worn = ['ringL', 'ringR', 'amulet'].map((s) => p.equip[s]).filter(Boolean);
    if (!worn.length) { this.msg('You are not wearing any rings or amulets.'); return false; }
    const o = worn.length === 1 ? worn[0] : await this.ui.pickItem('What do you want to remove?',
      worn.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    if (o.bless < 0) { o.blessKnown = true; this.msg('You cannot remove it. It is cursed.', 'bad'); return true; }
    for (const s of ['ringL', 'ringR', 'amulet']) if (p.equip[s] === o) p.equip[s] = null;
    o.worn = false;
    if (o.key === 'levitation') { p.clearStatus('levitating'); this.msg('You float gently to the ground.'); }
    if (o.key === 'invisibility') p.clearStatus('invisible');
    this.msg(`You were wearing ${objName(o, this.disc)}.`);
    return true;
  }

  // -------------------------------------------------------------- consume

  async doQuaff() {
    const p = this.player;
    if (this.level.at(p.x, p.y) === T.FOUNTAIN) {
      const yes = await this.ui.yesno('Drink from the fountain?');
      if (yes) return this.quaffFountain();
    }
    const cands = this.invByClass('potion');
    if (!cands.length) { this.msg('You have nothing to drink.'); return false; }
    const o = await this.ui.pickItem('What do you want to drink?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    const one = this.removeFromInventory(o, 1);
    await quaffPotion(this, one);
    return true;
  }

  quaffFountain() {
    const rng = this.rng;
    const p = this.player;
    const r = rng.rn2(30);
    if (r < 6) { this.msg('This water is delicious!'); p.nutrition += 30; }
    else if (r < 10) { this.msg('The cool draught refreshes you.', 'good'); p.pw = Math.min(p.pwMax, p.pw + rng.rnd(5)); }
    else if (r < 14) { this.msg('This water tastes foul.', 'warn'); damagePlayer(this, rng.rnd(4), 'foul water'); }
    else if (r < 17) { this.msg('You feel a sudden chill.'); for (let i = 0; i < 2; i++) this.spawnMonsterNear(p.x, p.y, 2); }
    else if (r < 20) { this.msg('Water gushes forth from the throne of the fountain!', 'warn');
                       p.setStatus('confused', rng.int(4, 10)); }
    else if (r < 23) { this.msg('An endless stream of snakes pours forth!', 'bad');
                       for (let i = 0; i < 3; i++) {
                         const s = this.freeNear(p.x, p.y, 2);
                         if (s) spawnAt(this, this.level, s.x, s.y, { spec: MONSTER_BY_KEY['snake'], noGroup: true }); } }
    else if (r < 26) { this.msg('You feel self-knowledgeable.', 'magic'); this.showEnlightenment(); }
    else if (r < 28) { this.msg('A wish!  A wish!', 'magic'); this.wishPrompt(); }
    else { this.msg('This tepid water is tasteless.'); }
    if (rng.oneIn(3)) { this.level.set(p.x, p.y, T.FLOOR); this.msg('The fountain dries up!'); }
    return true;
  }

  async doRead() {
    const cands = this.invByClass('scroll', 'spellbook');
    if (!cands.length) { this.msg('You have nothing to read.'); return false; }
    const o = await this.ui.pickItem('What do you want to read?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;

    if (o.cls === 'spellbook') return this.studySpellbook(o);
    const one = this.removeFromInventory(o, 1);
    await readScroll(this, one);
    return true;
  }

  studySpellbook(o) {
    const p = this.player;
    const base = objBase(o);
    const spellKey = base.spell;
    if (p.hasStatus('blind')) { this.msg('You cannot see to read.'); return false; }
    if (o.bless < 0) {
      this.msg('The book was coated with contact poison!', 'bad');
      o.blessKnown = true;
      damagePlayer(this, this.rng.d(2, 6), 'a contact-poisoned spellbook');
      return true;
    }
    const diff = base.spellLevel * 4 - p.attr.int - Math.floor(p.xpLevel / 2);
    if (diff > 6 && this.rng.oneIn(3)) {
      this.msg('You find yourself unable to finish the last page.', 'bad');
      p.setStatus('confused', this.rng.int(5, 15));
      return true;
    }
    const existing = p.spells.find((s) => s.key === spellKey);
    if (existing) { existing.memory = 20000; this.msg(`Your knowledge of ${spellKey} is refreshed.`, 'good'); }
    else { p.spells.push({ key: spellKey, level: base.spellLevel, memory: 20000 });
           this.msg(`You add ${spellKey} to your repertoire.`, 'good'); }
    this.discover(o);
    return true;
  }

  async doEat() {
    const p = this.player;
    const floor = this.level.itemsAt(p.x, p.y).filter((o) => o.cls === 'food');
    if (floor.length) {
      const yes = await this.ui.yesno(`There is ${objName(floor[0], this.disc)} here; eat it?`);
      if (yes) {
        const o = floor[0];
        this.level.removeItem(o);
        eatObject(this, o.count > 1 ? { ...o, count: 1 } : o);
        if (o.count > 1) { o.count--; this.level.addItem(o, p.x, p.y); }
        return true;
      }
    }
    const cands = this.invByClass('food');
    if (!cands.length) { this.msg('You have nothing to eat.'); return false; }
    const o = await this.ui.pickItem('What do you want to eat?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    if (p.nutrition > 1500) {
      const yes = await this.ui.yesno('You are having a hard time getting all of it down. Continue?');
      if (!yes) return false;
      if (p.nutrition > 2500) { this.msg('You choke over your food.', 'bad'); this.die('choking'); return true; }
    }
    const one = this.removeFromInventory(o, 1);
    eatObject(this, one);
    return true;
  }

  async doZap() {
    const cands = this.invByClass('wand');
    if (!cands.length) { this.msg('You have nothing to zap.'); return false; }
    const o = await this.ui.pickItem('What do you want to zap?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    const base = objBase(o);
    const needsDir = !['light', 'nothing', 'secret door detection', 'create monster',
                       'enlightenment', 'wishing'].includes(o.key);
    let dir = null;
    if (needsDir) {
      dir = await this.ui.getDirection('In what direction?');
      if (dir === null) return false;
    }
    await zapWand(this, o, dir);
    return true;
  }

  async doCast() {
    const p = this.player;
    if (!p.spells.length) { this.msg('You do not know any spells.'); return false; }
    const entries = p.spells.map((s, i) => {
      const fail = spellFailure(this, s.key);
      return { obj: s, letter: INV_LETTERS[i],
               label: `${s.key}  (level ${SPELLS[s.key]?.level ?? s.level}, ${SPELLS[s.key]?.cost ?? 5} Pw, ${fail}% fail)` };
    });
    const s = await this.ui.pickItem('Cast which spell?', entries);
    if (!s) return false;
    const meta = SPELLS[s.key];
    let dir = null;
    if (meta?.dir) {
      dir = await this.ui.getDirection('In what direction?');
      if (dir === null) return false;
    }
    await castSpell(this, s.key, dir);
    return true;
  }

  async doApply() {
    const p = this.player;
    const cands = p.inventory.filter((o) => o.cls === 'tool');
    if (!cands.length) { this.msg('You have nothing to apply.'); return false; }
    const o = await this.ui.pickItem('What do you want to use or apply?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    const base = objBase(o);

    if (base.light !== undefined) {
      if (o.lit) { o.lit = false; this.msg('You snuff out the lamp.'); }
      else if (o.fuel === 0) this.msg('This lamp has no oil left.');
      else { o.lit = true; p.equip.light = o; this.msg('The lamp is now on.', 'good'); }
      this.afterMove();
      return true;
    }
    if (base.dig) {
      const dir = await this.ui.getDirection('In what direction do you want to dig?');
      if (dir === null) return false;
      if (dir.dx === 0 && dir.dy === 0) { this.digDown(); return true; }
      const x = p.x + dir.dx, y = p.y + dir.dy;
      const t = this.level.at(x, y);
      if (!isDiggable(t) || isWalkable(t)) { this.msg('You cannot dig there.'); return false; }
      this.level.set(x, y, T.CORRIDOR);
      this.msg('You dig through the rock.');
      this.afterMove();
      return true;
    }
    if (base.unlocks) {
      const dir = await this.ui.getDirection('In what direction?');
      if (dir === null) return false;
      const x = p.x + dir.dx, y = p.y + dir.dy;
      if (this.level.at(x, y) === T.DOOR_LOCKED) {
        const chance = 6 + (p.skills.search ?? 0) * 2 + Math.floor(p.attr.dex / 3);
        if (this.rng.rn2(20) < chance) { this.level.set(x, y, T.DOOR_CLOSED); this.msg('You succeed in picking the lock.', 'good'); }
        else this.msg('You fail to pick the lock.');
        return true;
      }
      this.msg('There is no lock there.');
      return false;
    }
    if (base.cures) {
      let cured = false;
      for (const s of ['sick', 'confused', 'blind', 'stoning', 'hallucinating']) {
        if (p.hasStatus(s)) { p.clearStatus(s); cured = true; }
      }
      this.msg(cured ? 'You feel much better.' : 'Nothing happens.', cured ? 'good' : '');
      return true;
    }
    if (o.key === 'mirror') {
      const adj = DIRS.map((d) => this.level.monsterAt(p.x + d.dx, p.y + d.dy)).filter(Boolean);
      if (!adj.length) { this.msg('You look as ugly as ever.'); return true; }
      const m = adj[0];
      if (m.spec.undead || m.spec.mindless) this.msg(`${capitalise(m.displayName())} doesn't seem to notice.`);
      else { this.msg(`${capitalise(m.displayName())} is frightened by its reflection!`, 'good'); m.fleeing = this.rng.int(5, 15); }
      return true;
    }
    if (o.key === 'magic whistle') {
      this.msg('You produce a strange whistling sound.', 'magic');
      for (const m of this.level.monsters) if (m.tame) { const s = this.freeNear(p.x, p.y, 2); if (s) this.level.moveMonster(m, s.x, s.y); }
      return true;
    }
    if (o.key === 'blindfold') {
      if (p.hasStatus('blind')) { p.clearStatus('blind'); this.msg('You take off the blindfold.'); }
      else { p.setStatus('blind', -1); this.msg('You are now wearing a blindfold.'); }
      this.afterMove();
      return true;
    }
    if (base.container) {
      this.msg(`You open ${objName(o, this.disc, { article: 'the' })}. It is empty.`);
      return true;
    }
    this.msg('You cannot think of anything to do with that.');
    return false;
  }

  // -------------------------------------------------------------- throwing

  async doThrow() {
    const p = this.player;
    const cands = p.inventory.filter((o) => !o.worn);
    if (!cands.length) { this.msg('You have nothing to throw.'); return false; }
    const o = await this.ui.pickItem('What do you want to throw?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    const dir = await this.ui.getDirection('In what direction?');
    if (dir === null) return false;
    return this.throwObject(o, dir);
  }

  async doQuiver() {
    const p = this.player;
    const cands = p.inventory.filter((o) => objBase(o)?.throwable || objBase(o)?.ammo);
    if (!cands.length) { this.msg('You have nothing to ready.'); return false; }
    const o = await this.ui.pickItem('What do you want to ready?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    if (p.equip.quiver) p.equip.quiver.quivered = false;
    p.equip.quiver = o; o.quivered = true;
    this.msg(`${o.letter} - ${objName(o, this.disc)} (in quiver).`);
    return false;
  }

  async doFire() {
    const p = this.player;
    let ammo = p.equip.quiver;
    if (!ammo || !p.inventory.includes(ammo)) {
      const launcher = p.equip.weapon;
      const wants = launcher ? objBase(launcher)?.launcher : null;
      const cands = p.inventory.filter((o) => (wants && objBase(o)?.ammo &&
        objBase(o).ammo === objBase(launcher).skill) || objBase(o)?.throwable);
      if (!cands.length) { this.msg('You have nothing to fire.'); return false; }
      ammo = await this.ui.pickItem('Fire what?',
        cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
      if (!ammo) return false;
      p.equip.quiver = ammo; ammo.quivered = true;
    }
    const dir = await this.ui.getDirection('In what direction?');
    if (dir === null) return false;
    return this.throwObject(ammo, dir, true);
  }

  throwObject(o, dir, fired = false) {
    const p = this.player;
    if (dir.dx === 0 && dir.dy === 0) { this.msg('You cannot throw that at yourself.'); return false; }
    if (o.worn || (o.wielded && o.bless < 0)) { this.msg('You cannot let go of it.'); return true; }

    const one = this.removeFromInventory(o, 1);
    const base = objBase(one);
    const launcher = p.equip.weapon;
    const usingLauncher = fired && launcher && objBase(launcher)?.launcher &&
                          base.ammo === objBase(launcher).skill;

    let range = usingLauncher ? 12 : Math.max(3, 8 + Math.floor(p.attr.str / 4) - Math.floor(objWeight(one) / 20));
    let landed = { x: p.x, y: p.y };
    let hitSomething = false;

    fireBeam(this, p.x, p.y, dir, {
      range, glyph: base.glyph, colour: base.colour,
      onTile: (x, y) => { landed = { x, y }; return null; },
      onMonster: (m) => {
        const bonus = (usingLauncher ? (launcher.enchant ?? 0) + 2 : 0) + (p.skills.ranged ?? 0);
        const target = m.ac + p.xpLevel + bonus + 1;
        if (this.rng.rnd(20) >= target) { this.msg(`The ${base.name} misses ${m.displayName()}.`); return 'continue'; }
        const [n, d] = damageDice(one);
        let dmg = this.rng.d(n, d) + (one.enchant ?? 0);
        if (usingLauncher) dmg += this.rng.rnd(6) + (launcher.enchant ?? 0);
        this.msg(`The ${base.name} hits ${m.displayName()}.`, 'good');
        hitSomething = true;
        hurtMonster(this, m, Math.max(1, dmg));
        return 'stop';
      },
    });

    // The object lands where it stopped, unless it shattered.
    if (one.cls === 'potion') {
      this.msg('The potion shatters!');
      const m = this.level.monsterAt(landed.x, landed.y);
      if (m) { m.setStatus('confused', this.rng.int(3, 8)); }
      this.discover(one);
    } else {
      this.level.addItem(one, landed.x, landed.y);
    }
    void hitSomething;
    return true;
  }

  // ----------------------------------------------------------- doors, etc.

  async doOpen() {
    const dir = await this.ui.getDirection('In what direction?');
    if (dir === null) return false;
    const p = this.player;
    const x = p.x + dir.dx, y = p.y + dir.dy;
    const t = this.level.at(x, y);
    if (t === T.DOOR_CLOSED) { this.level.set(x, y, T.DOOR_OPEN); this.msg('The door opens.'); this.afterMove(); return true; }
    if (t === T.DOOR_LOCKED) {
      this.msg('This door is locked.');
      const yes = await this.ui.yesno('Kick it?');
      if (yes) return this.kickDoor(x, y);
      return false;
    }
    this.msg('You see no door there.');
    return false;
  }

  kickDoor(x, y) {
    const p = this.player;
    const chance = 3 + Math.floor(p.attr.str / 4) + Math.floor(p.xpLevel / 3);
    if (this.rng.rn2(20) < chance) {
      this.level.set(x, y, T.DOOR_BROKEN);
      this.msg('As you kick the door, it crashes open!', 'good');
      for (const m of this.level.monsters) if (m.alive && dist(m.x, m.y, x, y) < 10) m.asleep = false;
    } else {
      this.msg('WHAMM!!');
      if (this.rng.oneIn(6)) { this.msg('Ouch! That hurts!', 'bad'); damagePlayer(this, this.rng.rnd(3), 'a door'); }
    }
    this.afterMove();
    return true;
  }

  async doClose() {
    const dir = await this.ui.getDirection('In what direction?');
    if (dir === null) return false;
    const p = this.player;
    const x = p.x + dir.dx, y = p.y + dir.dy;
    const t = this.level.at(x, y);
    if (t !== T.DOOR_OPEN) { this.msg('You see no open door there.'); return false; }
    if (this.level.monsterAt(x, y)) { this.msg('There is something in the way.'); return false; }
    if (this.level.itemsAt(x, y).length) { this.msg('Something is blocking the doorway.'); return false; }
    this.level.set(x, y, T.DOOR_CLOSED);
    this.msg('The door closes.');
    this.afterMove();
    return true;
  }

  async doEngrave() {
    const p = this.player;
    const text = await this.ui.getText('What do you want to write in the dust here?');
    if (!text) return false;
    engrave(this, text, 'dust');
    if (/elbereth/i.test(text)) this.msg('You feel a strange sense of protection.', 'magic');
    return true;
  }

  async doPay() {
    const p = this.player;
    const shop = this.inShop(p.x, p.y);
    const owed = this.shopDebt();
    if (!owed) { this.msg('You do not owe anyone anything.'); return false; }
    const shk = shop?.shk ?? this.level.monsters.find((m) => m.shopkeeper && m.alive);
    if (!shk) { this.msg('There is nobody here to pay.'); return false; }
    if (p.gold < owed) { this.msg(`You do not have enough gold. You owe ${owed} zorkmids.`, 'bad'); return false; }
    p.gold -= owed;
    for (const o of p.inventory) o.shopPrice = 0;
    this.msg(`You pay ${shk.customName ?? 'the shopkeeper'} ${owed} gold pieces. "Thank you, come again!"`, 'good');
    return true;
  }

  async doIdentifyTrap() {
    const dir = await this.ui.getDirection('In what direction?');
    if (dir === null) return false;
    const trap = this.level.trapAt(this.player.x + dir.dx, this.player.y + dir.dy);
    if (trap && trap.seen) this.msg(`That is ${trap.name}.`);
    else this.msg('You see no trap there.');
    return false;
  }

  lookHere() {
    const p = this.player;
    const items = this.level.itemsAt(p.x, p.y);
    const t = this.level.at(p.x, p.y);
    const parts = [];
    if (items.length) parts.push(`You see here ${listJoin(items.map((o) => objName(o, this.disc)))}.`);
    else parts.push(`There is nothing here.`);
    if (t !== T.FLOOR && t !== T.CORRIDOR) parts.push(`There is ${tileName(t)} here.`);
    const trap = this.level.trapAt(p.x, p.y);
    if (trap && trap.seen) parts.push(`There is ${trap.name} here.`);
    this.msg(parts.join(' '));
    return false;
  }

  async doFarLook() {
    const pos = await this.ui.pickPosition('Pick a spot to examine.');
    if (!pos) return;
    this.describeAt(pos.x, pos.y);
  }

  describeAt(x, y) {
    const lvl = this.level;
    if (!lvl.inBounds(x, y)) return;
    const bits = [];
    const m = lvl.monsterAt(x, y);
    if (m && m.alive && (lvl.isVisible(x, y) || this.player.has('telepathy'))) {
      bits.push(`${capitalise(m.displayName())}${m.peaceful ? ' (peaceful)' : ''}${m.asleep ? ' (asleep)' : ''}` +
                ` - level ${m.level}, ${m.hp}/${m.hpMax} HP, AC ${m.ac}`);
    }
    const items = lvl.itemsAt(x, y);
    if (items.length && lvl.isSeen(x, y)) bits.push(listJoin(items.map((o) => objName(o, this.disc))));
    if (lvl.isSeen(x, y)) bits.push(tileName(lvl.at(x, y)));
    const trap = lvl.trapAt(x, y);
    if (trap && trap.seen) bits.push(trap.name);
    this.msg(bits.length ? bits.join('; ') : 'You see nothing there.');
  }

  // ------------------------------------------------------------- travel

  async doTravel() {
    const pos = await this.ui.pickPosition('Travel where?');
    if (!pos) return;
    await this.travelTo(pos.x, pos.y);
  }

  async travelTo(tx, ty) {
    const p = this.player;
    if (!this.level.isSeen(tx, ty)) { this.msg('You have not been there.'); return; }
    const path = astar(this.level, p.x, p.y, tx, ty,
                       { maxNodes: 6000, ignoreMonsters: false, avoidHazards: true });
    if (!path || !path.length) { this.msg('There is no path there.'); return; }
    for (const step of path) {
      if (!this.running) break;
      if (this.visibleThreat()) { this.msg('You stop.'); break; }
      const dx = step.x - p.x, dy = step.y - p.y;
      const moved = await this.tryMove(dx, dy);
      if (!moved) break;
      await this.endPlayerTurn();
      this.ui.render();
      await this.ui.sleep(14);
      if (this.level.itemsAt(p.x, p.y).length) break;
    }
  }

  async doAutoExplore() {
    const p = this.player;
    for (let iter = 0; iter < 400 && this.running; iter++) {
      if (this.visibleThreat()) { this.msg('There is a monster in the way.'); return false; }
      const goals = [];
      for (let y = 0; y < this.level.h; y++) {
        for (let x = 0; x < this.level.w; x++) {
          const i = this.level.idx(x, y);
          if (this.level.seen[i]) continue;
          if (!isWalkable(this.level.tiles[i])) continue;
          goals.push({ x, y });
        }
      }
      if (!goals.length) { this.msg('You have explored this level.'); return false; }
      const field = flowField(this.level, goals, { maxDist: 300, avoidHazards: true });
      const step = stepAlong(this.level, field, p.x, p.y);
      if (!step) { this.msg('You cannot reach anywhere new.'); return false; }
      const moved = await this.tryMove(step.x - p.x, step.y - p.y);
      if (!moved) return false;
      await this.endPlayerTurn();
      this.ui.render();
      await this.ui.sleep(10);
      if (this.level.itemsAt(p.x, p.y).length) return false;
    }
    return false;
  }

  // =========================================================================
  // menus driven from effects
  // =========================================================================

  async identifyMenu(n) {
    const p = this.player;
    const cands = p.inventory.filter((o) => !o.ided);
    if (!cands.length) { this.msg('You have nothing to identify.'); return; }
    if (n >= cands.length) {
      for (const o of cands) this.identifyObject(o);
      this.msg('You identify your possessions.', 'magic');
      await this.showInventory();
      return;
    }
    for (let i = 0; i < n; i++) {
      const left = p.inventory.filter((o) => !o.ided);
      if (!left.length) break;
      const o = await this.ui.pickItem(`Identify which item?${n > 1 ? ` (${n - i} left)` : ''}`,
        left.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
      if (!o) break;
      this.identifyObject(o);
      this.msg(`${o.letter} - ${objName(o, this.disc)}`, 'magic');
    }
  }

  async chargeMenu(blessed) {
    const cands = this.player.inventory.filter((o) => o.charges !== null || o.cls === 'wand');
    if (!cands.length) { this.msg('You have nothing to charge.'); return; }
    const o = await this.ui.pickItem('What do you want to charge?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return;
    o.charges = (o.charges ?? 0) + (blessed ? this.rng.int(6, 10) : this.rng.int(3, 6));
    o.recharged = (o.recharged ?? 0) + 1;
    this.msg(`${capitalise(objName(o, this.disc, { article: 'your' }))} glows blue for a moment.`, 'magic');
  }

  async genocideMenu(blessed) {
    const name = await this.ui.getText('What monster do you want to genocide?');
    if (!name) return;
    const spec = MONSTERS.find((m) => m.name.toLowerCase() === name.trim().toLowerCase() ||
                                      m.key.toLowerCase() === name.trim().toLowerCase());
    if (!spec) { this.msg('Such creatures do not exist in this world.'); return; }
    this.genocided = this.genocided ?? new Set();
    this.genocided.add(spec.key);
    let n = 0;
    for (const lvl of this.levels.values()) {
      for (const m of lvl.monsters) if (m.alive && m.specKey === spec.key) { m.alive = false; n++; }
    }
    this.level.removeDead();
    this.msg(`Wiped out all ${spec.name}s.`, 'magic');
    void n;
  }

  async wishPrompt() {
    const text = await this.ui.getText('You may wish for an object. What do you want?');
    if (!text) { this.msg('You wish for nothing at all.'); return; }
    const wanted = text.trim().toLowerCase();
    let bless = 0, ench = 0;
    let s = wanted;
    if (s.startsWith('blessed ')) { bless = 1; s = s.slice(8); }
    else if (s.startsWith('cursed ')) { bless = -1; s = s.slice(7); }
    else if (s.startsWith('uncursed ')) { s = s.slice(9); }
    const m = s.match(/^([+-]\d+)\s+/);
    if (m) { ench = parseInt(m[1], 10); s = s.slice(m[0].length); }
    s = s.replace(/^(scroll|potion|wand|ring|amulet|spellbook)s? of /, '');

    const type = OBJECTS.find((o) => o.name.toLowerCase() === s || o.key.toLowerCase() === s) ||
                 OBJECTS.find((o) => o.name.toLowerCase().includes(s) && s.length > 3);
    if (!type || type.unique) {
      this.msg('You feel a strange sense of loss.', 'warn');
      return;
    }
    const o = makeObj(type.key, type.cls, this.rng, {
      bless, blessKnown: true, enchant: clamp(ench, -5, 5), ided: true, random: false,
      count: type.stackable ? (type.cls === 'weapon' ? 20 : 1) : 1,
    });
    o.enchantKnown = true;
    this.identifyObject(o);
    const held = this.addToInventory(o);
    this.msg(`${held.letter} - ${objName(held, this.disc)}`, 'magic');
  }

  async showEnlightenment() {
    const p = this.player;
    const lines = [];
    lines.push(`You are a level ${p.xpLevel} ${p.roleName}, ${p.alignment}.`);
    lines.push(`Strength ${p.attr.str}, Dexterity ${p.attr.dex}, Constitution ${p.attr.con},`);
    lines.push(`Intelligence ${p.attr.int}, Wisdom ${p.attr.wis}, Charisma ${p.attr.cha}.`);
    lines.push(`Armor class ${p.ac}, ${p.hp}/${p.hpMax} hit points, ${p.pw}/${p.pwMax} power.`);
    lines.push(`You have ${p.gold} gold pieces and ${p.xp} experience points.`);
    lines.push(`Carrying ${p.totalWeight()} of a possible ${p.maxCarry}.`);
    lines.push('');
    const props = ['fireRes', 'coldRes', 'shockRes', 'poisonRes', 'sleepRes', 'telepathy',
                   'seeInvis', 'stealth', 'searching', 'warning', 'regeneration', 'reflection',
                   'freeAction', 'magicRes', 'lifeSaving', 'levitation', 'invisible',
                   'displacement', 'conflict', 'aggravate', 'teleportitis', 'slowDigestion'];
    const have = props.filter((k) => p.has(k));
    lines.push(have.length ? `You are: ${have.join(', ')}.` : 'You have no special properties.');
    if (p.statuses.size) {
      lines.push('');
      lines.push('Afflictions: ' + [...p.statuses.keys()].join(', ') + '.');
    }
    if (p.spells.length) {
      lines.push('');
      lines.push('Spells known: ' + p.spells.map((s) => s.key).join(', ') + '.');
    }
    await this.ui.showText('Enlightenment', lines);
  }

  async showMessageHistory() {
    const lines = this.messages.slice(-120).map((m) => `${String(m.turn).padStart(6)}  ${m.text}`);
    await this.ui.showText('Message history', lines.length ? lines : ['Nothing has happened yet.']);
  }

  async showDiscoveries() {
    const byClass = {};
    for (const k of this.disc.known) {
      const [cls, key] = k.split('/');
      const t = objType(key, cls);
      if (!t) continue;
      (byClass[cls] ??= []).push(`${t.name}  (${this.disc.idMap[k] ?? ''})`);
    }
    const lines = [];
    for (const cls of Object.keys(byClass).sort()) {
      lines.push(`--- ${cls}s ---`);
      for (const s of byClass[cls].sort()) lines.push('  ' + s);
      lines.push('');
    }
    await this.ui.showText('Discoveries', lines.length ? lines : ['You have not discovered anything yet.']);
  }

  async doExtended() {
    const cmds = [
      { key: 'pray',      label: '#pray - call on your god for help' },
      { key: 'sit',       label: '#sit - sit down where you are' },
      { key: 'force',     label: '#force - force a lock' },
      { key: 'name',      label: '#name - call an object type something' },
      { key: 'terrain',   label: '#terrain - show the map you remember' },
      { key: 'quit',      label: '#quit - give up this game' },
    ];
    const c = await this.ui.pickItem('Extended command:',
      cmds.map((x, i) => ({ obj: x, letter: INV_LETTERS[i], label: x.label })));
    if (!c) return false;
    switch (c.key) {
      case 'pray': return this.doPray();
      case 'sit':  return this.doSit();
      case 'name': return await this.doName();
      case 'terrain': await this.ui.showTerrain(); return false;
      case 'quit': {
        const yes = await this.ui.yesno('Really quit and end this game?');
        if (yes) { this.die('quitting', true); }
        return false;
      }
      default: this.msg('Nothing happens.'); return false;
    }
  }

  doPray() {
    const p = this.player;
    const sinceLast = this.turn - (this.lastPrayer ?? -1000);
    const troubled = p.hp < p.hpMax / 7 || p.nutrition < 0 || p.hasStatus('sick') ||
                     p.hasStatus('stoning') || p.hasStatus('lycanthropy');
    this.lastPrayer = this.turn;
    this.msg('You begin praying to your god.');
    if (sinceLast < 800 && !troubled) {
      this.msg('You feel that your god is displeased.', 'bad');
      p.luck--;
      damagePlayer(this, this.rng.rnd(4), 'divine wrath');
      return true;
    }
    if (troubled) {
      this.msg('You feel a surge of divine protection.', 'good');
      if (p.hp < p.hpMax / 7) { p.hp = p.hpMax; this.msg('You feel much better.', 'good'); }
      if (p.nutrition < 0) { p.nutrition = 900; this.msg('Your stomach feels content.', 'good'); }
      p.clearStatus('sick'); p.clearStatus('stoning'); p.clearStatus('lycanthropy'); p.clearStatus('blind');
      return true;
    }
    this.msg('You feel a feeling of hopelessness. Nothing happens.');
    return true;
  }

  doSit() {
    const p = this.player;
    const t = this.level.at(p.x, p.y);
    if (t === T.THRONE) {
      this.msg('You sit on the opulent throne.');
      const r = this.rng.rn2(6);
      if (r === 0) { this.msg('A voice echoes: "Thy audience hath been summoned."', 'magic');
                     for (let i = 0; i < 2; i++) this.spawnMonsterNear(p.x, p.y, 3); }
      else if (r === 1) { this.msg('You feel a wrenching sensation.'); teleportPlayer(this); }
      else if (r === 2) { this.msg('A voice echoes: "Thy commands art meaningless."'); }
      else if (r === 3) { this.msg('You feel your luck improving.', 'good'); p.luck++; }
      else if (r === 4) { this.msg('A wish!  A wish!', 'magic'); this.wishPrompt(); }
      else this.msg('You feel somehow out of place.');
      if (this.rng.oneIn(3)) { this.level.set(p.x, p.y, T.FLOOR); this.msg('The throne vanishes in a puff of logic.'); }
      return true;
    }
    this.msg('You sit on the floor.');
    return true;
  }

  async doName() {
    const p = this.player;
    const cands = p.inventory.filter((o) => NEEDS_ID.has(o.cls) && !this.disc.known.has(`${o.cls}/${o.key}`));
    if (!cands.length) { this.msg('You have nothing worth naming.'); return false; }
    const o = await this.ui.pickItem('Name which type of object?',
      cands.map((it) => ({ obj: it, letter: it.letter, label: objName(it, this.disc) })));
    if (!o) return false;
    const name = await this.ui.getText(`Call ${objName(o, this.disc, { article: 'a' })}:`);
    if (name === null) return false;
    this.disc.calledBy.set(`${o.cls}/${o.key}`, name);
    return false;
  }

  // =========================================================================
  // ending
  // =========================================================================

  die(killer, quit = false) {
    if (!this.running) return;
    this.running = false;
    const p = this.player;
    p.killer = killer;
    this.gameOver = {
      how: quit ? 'quit' : 'died',
      killer,
      turns: this.turn,
      depth: p.depth,
      maxDepth: p.maxDepth,
      score: this.computeScore(),
      elapsed: Date.now() - this.startedAt,
    };
    this.msg(quit ? 'You give up.' : `You die...`, 'bad');
    clearSave();
    this.ui.showGameOver(this.gameOver);
  }

  win() {
    this.running = false;
    this.player.escaped = true;
    this.gameOver = {
      how: 'ascended',
      killer: null,
      turns: this.turn,
      depth: this.player.depth,
      maxDepth: this.player.maxDepth,
      score: this.computeScore() * 2 + 50000,
      elapsed: Date.now() - this.startedAt,
    };
    this.msg('You escape the dungeon with the Amulet of Yendor!', 'good');
    clearSave();
    this.ui.showGameOver(this.gameOver);
  }

  computeScore() {
    const p = this.player;
    let s = p.xp;
    s += p.gold;
    s += 50 * (p.maxDepth - 1);
    for (const o of p.inventory) {
      if (o.cls === 'gem' || o.cls === 'amulet') s += objValue(o);
    }
    if (p.hasAmulet) s += 20000;
    return Math.max(0, Math.floor(s));
  }

  async doSaveAndQuit() {
    saveGame(this);
    this.msg('Game saved. You can close the tab; the game will be here.', 'good');
    this.ui.showSaved();
  }
}

export const VERSION = '1.0.0';

// ===========================================================================
// helpers
// ===========================================================================

function canStack(a, b) {
  if (a.key !== b.key || a.cls !== b.cls) return false;
  if (!a.stackable || !b.stackable) return false;
  return a.enchant === b.enchant && a.bless === b.bless && a.blessKnown === b.blessKnown &&
         a.erode === b.erode && (a.charges ?? null) === (b.charges ?? null) &&
         !!a.corpseOf === !!b.corpseOf && a.corpseOf === b.corpseOf;
}

const CLASS_ORDER = ['coin', 'amulet', 'weapon', 'armor', 'food', 'scroll', 'spellbook',
                     'potion', 'ring', 'wand', 'tool', 'gem'];
const CLASS_TITLE = {
  coin: 'Coins', amulet: 'Amulets', weapon: 'Weapons', armor: 'Armor', food: 'Comestibles',
  scroll: 'Scrolls', spellbook: 'Spellbooks', potion: 'Potions', ring: 'Rings',
  wand: 'Wands', tool: 'Tools', gem: 'Gems and Stones',
};

export function groupInventory(inventory, disc) {
  const out = [];
  for (const cls of CLASS_ORDER) {
    const items = inventory.filter((o) => o.cls === cls);
    if (!items.length) continue;
    out.push({ header: CLASS_TITLE[cls] ?? cls });
    for (const o of items) out.push({ obj: o, letter: o.letter, label: objName(o, disc) });
  }
  const rest = inventory.filter((o) => !CLASS_ORDER.includes(o.cls));
  if (rest.length) {
    out.push({ header: 'Other' });
    for (const o of rest) out.push({ obj: o, letter: o.letter, label: objName(o, disc) });
  }
  return out;
}

function slotName(slot) {
  return { body: 'body', cloak: 'shoulders', helm: 'head', gloves: 'hands',
           boots: 'feet', shield: 'arm' }[slot] ?? slot;
}

// Save/load live in save.js but the Game needs two of their entry points.
import { saveGame, clearSave } from './save.js';
