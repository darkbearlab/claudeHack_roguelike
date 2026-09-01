// Input, HUD and prompts.
//
// The interesting part is the aiming gesture, which is the whole reason this
// game has its own UI layer instead of borrowing claudeHack's.
//
//   press a skill -> drag out from your character -> release to commit
//
// Both halves of that work as one continuous gesture *or* as two taps, because
// on a phone people do both without thinking about it. Pointer Events give
// touch, mouse and pen from one code path; `setPointerCapture` keeps the
// gesture alive when the finger leaves the button it started on; and
// `touch-action: none` on the canvas stops the browser stealing the drag for
// scrolling.
//
// Three things here exist only because a real thumb on a real phone hits them:
//
//   * **Releasing over the control bar cancels.** "Release commits" otherwise
//     leaves no way out of a gesture you have changed your mind about, and the
//     bar is where the finger came from - big, low, and impossible to miss.
//   * **`pointercancel` is handled.** An incoming call or a system edge-swipe
//     takes the pointer away; without this the game stays stuck in aim mode and
//     looks broken.
//   * **The aim readout is text, not just tiles.** A finger covers the tiles it
//     is pointing at, so the direction and cost are also written in the message
//     line where nothing is on top of them.

import { Renderer } from './render.js';
import { DIRS, DIR_BY_KEY, capitalise, fmtDuration } from '../../../engine/util.js';
import { SKILLS, SKILL_BY_KEY } from '../data/skills.js';
import { attackTiles, snapDir } from '../game/patterns.js';
import { DUNGEON_DEPTH } from '../map/mapgen.js';
import { T, isBonfire, isChest, isCorpse } from '../map/tiles.js';
import { SLOT, ITEM_BY_KEY, slotsFor, isConsumable, CONSUMABLE_BY_KEY } from '../data/items.js';
import { saveSettings, loadSettings } from '../game/save.js';
import { HELP_HTML } from './help.js';

const AIM_DEADZONE = 18;     // CSS px before a drag counts as a direction

export class UI {
  constructor(game) {
    this.game = game;
    game.ui = this;

    this.el = {
      canvas:   document.getElementById('map'),
      overlay:  document.getElementById('overlay'),
      msg:      document.getElementById('msglines'),
      hpbar:    document.getElementById('hpbar'),
      stbar:    document.getElementById('stbar'),
      status:   document.getElementById('statusline'),
      skills:   document.getElementById('skillbar'),
      pad:      document.getElementById('pad'),
      action:   null,     // built with the skill bar
      controls: document.getElementById('controls'),
      splash:   document.getElementById('splash'),
      flash:    document.getElementById('flash'),
    };

    this.renderer = new Renderer(this.el.canvas, game);
    this.settings = loadSettings();
    this.renderer.mode = this.settings.mode ?? 'tiles';
    this.renderer.zoom = this.settings.zoom ?? 1;

    this.pending = null;
    this.recent = [];
    this.aimSkill = null;     // armed skill key
    this.aimDir = null;
    this.gesture = null;

    this.buildSkillBar();
    this.bindKeys();
    this.bindPointer();
    this.bindButtons();
    window.addEventListener('resize', () => { this.renderer.resize(); this.render(); });
    if (window.visualViewport) {
      visualViewport.addEventListener('resize', () => { this.renderer.resize(); this.render(); });
    }
  }

  // =========================================================================
  // keyboard
  // =========================================================================

  bindKeys() {
    window.addEventListener('keydown', (ev) => {
      if (!this.el.splash.hidden) return;
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
      const key = normaliseKey(ev);
      if (key === null) return;
      if (ev.metaKey || (ev.ctrlKey && key !== 'C-p')) return;
      ev.preventDefault();
      this.feed(key);
    }, { passive: false });
  }

  feed(key) {
    if (this.pending) { this.pending.onKey(key); return; }
    if (!this.game.running) return;
    this.game.command(key);
  }

  // =========================================================================
  // the aiming gesture
  // =========================================================================

  /**
   * The nine buttons, in a fixed 3x3.
   *
   * Fixed is the point. Which skills you have changes every time you swap a
   * weapon, and a grid that reflows under your thumb every time you draw a
   * different sword is worse than one with a greyed-out hole in it. So the
   * layout is positional and empty slots stay where they are:
   *
   *     main-primary   main-secondary   off-primary
   *     magic          item             block
   *     roll           interact         pack
   *
   * Roll sits bottom-left, nearest the thumb coming across from the d-pad,
   * because it is the button you press when something has gone wrong.
   */
  buttonLayout() {
    const p = this.game.player;
    const main = p?.item(SLOT.MAIN) ?? null;
    const off = p?.item(SLOT.OFF) ?? null;
    const offIsWeapon = off && off.kind === 'weapon';
    return [
      { kind: 'skill', key: main ? main.primary : null, label: 'Main' },
      { kind: 'skill', key: main ? main.secondary : null, label: 'Main 2' },
      { kind: 'skill', key: offIsWeapon ? off.primary : null, label: 'Off' },
      { kind: 'prep', slot: 'magic', label: 'Magic' },
      { kind: 'prep', slot: 'item', label: 'Item' },
      { kind: 'skill', key: p?.shield ? 'block' : null, label: 'Block' },
      { kind: 'skill', key: 'roll', label: 'Roll' },
      { kind: 'action' },
      { kind: 'pack' },
    ];
  }

  /**
   * A cheap signature, so the bar is rebuilt only when it actually changed.
   *
   * The shield's arc is in here even though it does not change which buttons
   * exist, because it changes what one of them is *drawn as* - swapping a
   * buckler for a tower shield left the block button still showing a
   * one-direction guard.
   */
  layoutSignature() {
    const arc = this.game.player?.shield?.block?.arc ?? 0;
    const prep = ['item', 'magic'].map((k) => this.game.player?.prep?.[k] ?? '-').join(',');
    return this.buttonLayout().map((c) => `${c.kind}:${c.key ?? c.label ?? ''}`).join('|') + `#${arc}#${prep}`;
  }

  buildSkillBar() {
    const bar = this.el.skills;
    const p = this.game.player;
    bar.innerHTML = '';
    this.el.action = null;

    this.buttonLayout().forEach((cell, i) => {
      if (cell.kind === 'skill' && cell.key) {
        const def = SKILL_BY_KEY[cell.key];
        const b = document.createElement('button');
        b.className = 'skill';
        b.dataset.skill = cell.key;
        b.title = def.hint ?? '';
        b.innerHTML = `<span class="num">${i + 1}</span>${skillIcon(def, p?.shield?.block?.arc ?? 1)}` +
                      `<span class="nm">${escapeHtml(def.name)}</span>` +
                      `<span class="cost"></span><span class="cd"></span>`;
        b.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          this.startGesture(ev, cell.key, b);
        });
        bar.appendChild(b);
        return;
      }

      if (cell.kind === 'prep') {
        const c = p?.prepared(cell.slot) ?? null;
        const b = document.createElement('button');
        b.className = c ? 'skill prep' : 'skill empty';
        b.disabled = !c;
        b.dataset.prep = cell.slot;
        if (c) {
          b.title = c.desc ?? '';
          b.innerHTML = `<span class="num">${i + 1}</span>` +
                        `<span class="nm">${escapeHtml(c.name)}</span>` +
                        `<span class="cost"></span><span class="cd"></span>`;
          if (c.directional) {
            // Directional ones are aimed like any other skill: press, drag out,
            // release. Keeping one gesture for everything is why there is no
            // separate targeting mode to learn.
            b.addEventListener('pointerdown', (ev) => {
              ev.preventDefault();
              this.startGesture(ev, `prep:${cell.slot}`, b);
            });
          } else {
            b.addEventListener('click', (ev) => {
              ev.preventDefault();
              if (this.game.usePrepared(cell.slot, null)) this.feed('.');
            });
          }
        } else {
          b.innerHTML = `<span class="num">${i + 1}</span>` +
                        `<span class="nm">${escapeHtml(cell.label)}</span>`;
        }
        bar.appendChild(b);
        return;
      }

      if (cell.kind === 'action') {
        const act = document.createElement('button');
        act.id = 'btn-action';
        act.className = 'skill action';
        act.innerHTML = '<span class="act-name"></span><span class="act-sub"></span>';
        act.addEventListener('click', (ev) => {
          ev.preventDefault();
          const a = this.contextAction();
          if (!a.cmd) return;
          if (a.kind === 'cancel') {
            this.clearAim();
            this.feed('Escape');
            return;
          }
          this.feed(a.cmd);
        });
        bar.appendChild(act);
        this.el.action = act;
        return;
      }

      if (cell.kind === 'pack') {
        const b = document.createElement('button');
        b.className = 'skill action is-pack';
        b.innerHTML = '<span class="act-name">Pack</span><span class="act-sub"></span>';
        b.addEventListener('click', (ev) => { ev.preventDefault(); this.showPack(); });
        bar.appendChild(b);
        return;
      }

      const b = document.createElement('button');
      b.className = 'skill empty';
      b.disabled = true;
      b.innerHTML = `<span class="num">${i + 1}</span>` +
                    `<span class="nm">${escapeHtml(cell.label ?? '')}</span>`;
      bar.appendChild(b);
    });

    this.builtSignature = this.layoutSignature();
  }

  /**
   * What the one context button does right now.
   *
   * Descending and resting can never both apply - you are standing on a
   * staircase or on a bonfire, never on both - which is what makes one button
   * honest rather than a mode. Cancelling an aim joins them for the same
   * reason: while a skill is armed you are not descending anywhere.
   *
   * New verbs go in this list. The only rule is the one that earns the button:
   * no two entries may be available at the same time.
   */
  contextAction() {
    const g = this.game;
    if (!g.running || !g.level) return { name: '—', cmd: null };
    if (this.aimSkill || g.aiming) {
      return { name: 'Cancel', sub: 'aiming', cmd: 'ESC', kind: 'cancel' };
    }
    const p = g.player;
    const here = g.level.at(p.x, p.y);
    if (isChest(here)) {
      return { name: 'Open', sub: 'chest', cmd: 'g', kind: 'take' };
    }
    if (isCorpse(here)) {
      const n = g.corpse?.items?.length ?? 0;
      return { name: 'Take back', sub: `${n} item${n === 1 ? '' : 's'}`, cmd: 'g', kind: 'take' };
    }
    if (isBonfire(here)) {
      // Say WHY it is unavailable. A button that silently refuses is a bug as
      // far as the player is concerned, and "something is still hunting you" is
      // information they can act on.
      const n = g.hunters();
      if (n > 0) return { name: 'Hunted', sub: `${n} aware`, cmd: null, kind: 'blocked' };
      return { name: 'Rest', sub: 'bonfire', cmd: 'e', kind: 'rest' };
    }
    if (here === T.STAIRS_DOWN) {
      return { name: 'Descend', sub: `to ${p.depth + 1}`, cmd: '>', kind: 'descend' };
    }
    return { name: '—', sub: '', cmd: null };
  }

  renderAction() {
    const el = this.el.action;
    if (!el) return;
    const a = this.contextAction();
    el.querySelector('.act-name').textContent = a.name;
    el.querySelector('.act-sub').textContent = a.sub ?? '';
    el.disabled = !a.cmd;
    el.classList.toggle('idle', !a.cmd);
    for (const k of ['cancel', 'rest', 'descend', 'take', 'blocked'])
      el.classList.toggle(`is-${k}`, a.kind === k);
  }

  /** A skill, or one of the two prepared slots dressed up as one. */
  skillDef(key) {
    if (typeof key === 'string' && key.startsWith('prep:')) {
      return this.game.player?.prepared(key.slice(5)) ?? null;
    }
    return SKILL_BY_KEY[key] ?? null;
  }

  startGesture(ev, skillKey, fromEl) {
    if (!this.game.running || this.game.busy) return;
    if (this.game.player.recovering) {
      this.pushMessage(`Still recovering (${this.game.player.recover}).`, 'warn');
      return;
    }
    const def = this.skillDef(skillKey);
    if (!def) return;
    const slot = this.game.player.skill(skillKey);
    if (slot && slot.cd > 0) { this.pushMessage(`${def.name} is not ready (${slot.cd}).`, 'warn'); return; }
    if (skillKey.startsWith('prep:') && this.game.player.chargesOf(def.key) <= 0) {
      this.pushMessage(`The ${def.name} is spent.`, 'warn'); return;
    }
    const cost = this.game.player.costOf(skillKey);
    if (this.game.player.stamina < cost) {
      this.pushMessage(`Not enough stamina for ${def.name}.`, 'warn');
      return;
    }

    this.aimSkill = skillKey;
    this.aimDir = null;
    this.gesture = {
      id: ev.pointerId, from: fromEl,
      startX: ev.clientX, startY: ev.clientY,
      moved: false, fromSkillBar: !!fromEl,
    };
    try { (fromEl ?? this.el.canvas).setPointerCapture(ev.pointerId); } catch { /* not fatal */ }
    this.updateAim(ev.clientX, ev.clientY);
    this.renderSkillBar();
  }

  bindPointer() {
    const c = this.el.canvas;

    c.addEventListener('pointerdown', (ev) => {
      if (!this.game.running) return;
      ev.preventDefault();
      if (this.aimSkill) {
        // Already armed by a tap on the skill; this press starts the aim drag.
        this.gesture = {
          id: ev.pointerId, from: null,
          startX: ev.clientX, startY: ev.clientY, moved: false, fromSkillBar: false,
        };
        try { c.setPointerCapture(ev.pointerId); } catch { /* not fatal */ }
        this.updateAim(ev.clientX, ev.clientY);
        return;
      }
      this.tapStart = { x: ev.clientX, y: ev.clientY, t: Date.now() };
    });

    const move = (ev) => {
      if (!this.gesture || ev.pointerId !== this.gesture.id) return;
      const d = Math.hypot(ev.clientX - this.gesture.startX, ev.clientY - this.gesture.startY);
      if (d > 6) this.gesture.moved = true;
      this.updateAim(ev.clientX, ev.clientY);
    };
    c.addEventListener('pointermove', move);
    window.addEventListener('pointermove', move);

    const up = (ev) => {
      if (this.gesture && ev.pointerId === this.gesture.id) { this.endGesture(ev); return; }
      if (!this.tapStart) return;
      const dx = ev.clientX - this.tapStart.x, dy = ev.clientY - this.tapStart.y;
      const quick = Date.now() - this.tapStart.t < 700;
      this.tapStart = null;
      if (!quick) return;
      if (Math.hypot(dx, dy) > 26) {
        // A swipe on the map with nothing armed is a step.
        const k = ['h', 'b', 'j', 'n', 'l', 'u', 'k', 'y', 'h'][Math.round((Math.atan2(dy, dx) / Math.PI) * 4) + 4];
        this.feed(k);
        return;
      }
      this.onMapTap(ev);
    };
    c.addEventListener('pointerup', up);
    window.addEventListener('pointerup', up);

    // The pointer can be taken away by the OS mid-gesture. If that is not
    // handled the game sits in aim mode forever and looks broken.
    const cancel = (ev) => {
      if (this.gesture && ev.pointerId === this.gesture.id) this.abortAim('interrupted');
      this.tapStart = null;
    };
    c.addEventListener('pointercancel', cancel);
    window.addEventListener('pointercancel', cancel);
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  /** Direction from the player's tile to the finger, snapped to eight ways. */
  updateAim(clientX, clientY) {
    if (!this.aimSkill) return;
    const rect = this.el.canvas.getBoundingClientRect();
    const p = this.game.player;
    const c = this.renderer.cellCentre(p.x, p.y);
    const dx = (clientX - rect.left) - c.x;
    const dy = (clientY - rect.top) - c.y;

    if (Math.hypot(dx, dy) < AIM_DEADZONE) {
      this.aimDir = null;
      this.renderer.aim = null;
      this.renderMessages(`${this.skillDef(this.aimSkill).name}: drag away from yourself to aim.`);
      this.render();
      return;
    }

    const dir = snapDir(dx, dy);
    const changed = !this.aimDir || this.aimDir.dx !== dir.dx || this.aimDir.dy !== dir.dy;
    this.aimDir = dir;
    if (changed && navigator.vibrate) { try { navigator.vibrate(8); } catch { /* ignore */ } }

    this.renderer.aim = { dir, tiles: this.previewTiles(this.aimSkill, dir) };
    const def = this.skillDef(this.aimSkill);
    const cost = this.game.player.costOf(this.aimSkill);
    // The readout goes in the message line because a finger covers the tiles.
    this.renderMessages(`${def.name} → ${dirName(dir)}   (${cost} stamina` +
      `${def.advancesTurn === false ? ', free turn' : ''})   release to commit`);
    this.render();
  }

  previewTiles(key, dir) {
    const def = this.skillDef(key);
    const p = this.game.player;
    const lvl = this.game.level;
    if (!def) return [];

    if (def.ranged || def.projectile) {
      const out = [];
      let x = p.x, y = p.y;
      for (let i = 0; i < def.range; i++) {
        x += dir.dx; y += dir.dy;
        if (!lvl.flyable(x, y)) break;
        out.push({ x, y });
        if (lvl.enemyAt(x, y)) break;
      }
      return out;
    }

    if (def.move) {
      const out = [];
      let x = p.x, y = p.y;
      for (let i = 0; i < p.rollDistance(); i++) {
        const nx = x + dir.dx, ny = y + dir.dy;
        if (!lvl.passable(nx, ny) || lvl.enemyAt(nx, ny) || !lvl.diagonalOk(x, y, nx, ny)) break;
        x = nx; y = ny;
        out.push({ x, y });
      }
      return out;
    }

    // A lunge moves first, so the preview has to show where it will hit *from*.
    let ox = p.x, oy = p.y;
    if (def.dash) {
      for (let i = 0; i < def.dash; i++) {
        const nx = ox + dir.dx, ny = oy + dir.dy;
        if (!lvl.passable(nx, ny) || lvl.enemyAt(nx, ny)) break;
        ox = nx; oy = ny;
      }
    }
    return attackTiles(ox, oy, dir.dx, dir.dy, def.pattern);
  }

  endGesture(ev) {
    const g = this.gesture;
    this.gesture = null;
    const skill = this.aimSkill;
    if (!skill) return;

    // Released over the controls? That is the cancel target.
    const overControls = this.el.controls.contains(document.elementFromPoint(ev.clientX, ev.clientY));
    if (overControls && g.moved) { this.abortAim('cancelled'); return; }

    // A quick tap on the skill button arms it and waits for a second gesture.
    if (g.fromSkillBar && !g.moved) {
      this.renderMessages(`${this.skillDef(skill).name}: drag out from yourself, or press a direction key.`);
      this.render();
      return;
    }

    if (!this.aimDir) { this.abortAim('no direction'); return; }
    const dir = this.aimDir;
    this.clearAim();
    this.game.busy = false;
    this.commit(skill, dir);
  }

  commit(skillKey, dir) {
    if (!this.game.running || this.game.busy) return;
    this.game.busy = true;
    Promise.resolve(this.game.useSkill(skillKey, dir))
      .then((spent) => { if (spent && this.game.running) this.game.worldTurn(); })
      .catch((e) => { console.error(e); this.game.msg(`(error: ${e.message})`, 'bad'); })
      .finally(() => { this.game.busy = false; this.render(); });
  }

  abortAim(why) {
    this.clearAim();
    if (why) this.pushMessage(`(${why})`);
    this.render();
  }

  clearAim() {
    this.aimSkill = null;
    this.aimDir = null;
    this.gesture = null;
    this.renderer.aim = null;
    this.renderSkillBar();
    this.renderMessages();
  }

  onMapTap(ev) {
    if (!this.game.running || this.game.busy) return;
    const rect = this.el.canvas.getBoundingClientRect();
    const cell = this.renderer.cellAt(ev.clientX - rect.left, ev.clientY - rect.top);
    const p = this.game.player;
    const dx = cell.x - p.x, dy = cell.y - p.y;
    if (!dx && !dy) { this.feed('.'); return; }
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      const d = DIRS.find((q) => q.dx === dx && q.dy === dy);
      if (d) this.feed(d.key);
      return;
    }
    // A distant tap is a look, not a travel: in this game walking somewhere
    // without watching is how you die.
    this.game.msg(this.describe(cell.x, cell.y));
  }

  describe(x, y) {
    const lvl = this.game.level;
    if (!lvl.isSeen(x, y)) return 'You have not seen there.';
    const e = lvl.enemyAt(x, y);
    if (e && e.alive && lvl.isVisible(x, y)) {
      return `${e.name}: ${e.hp}/${e.hpMax} hp, ${e.stamina}/${e.staminaMax} stamina` +
             (e.state === 'windup' ? `, winding up ${e.attack?.name} (${e.timer})` :
              e.state === 'recover' ? ', recovering' :
              e.state === 'resting' ? ', winded' : '');
    }
    return lvl.describeTile(x, y);
  }

  // =========================================================================
  // buttons
  // =========================================================================

  bindButtons() {
    for (const b of this.el.pad.querySelectorAll('button')) {
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        const cmd = b.dataset.cmd;
        if (this.aimSkill && DIR_BY_KEY[cmd]) {
          const d = DIR_BY_KEY[cmd];
          const skill = this.aimSkill;
          this.clearAim();
          this.commit(skill, { dx: d.dx, dy: d.dy });
          return;
        }
        this.feed(cmd === 'ESC' ? 'Escape' : cmd);
      });
    }
    document.getElementById('btn-mode').addEventListener('click', () => {
      this.renderer.mode = this.renderer.mode === 'tiles' ? 'ascii' : 'tiles';
      document.getElementById('btn-mode').textContent = this.renderer.mode === 'tiles' ? 'Tiles' : 'ASCII';
      this.settings.mode = this.renderer.mode; saveSettings(this.settings);
      this.render();
    });
    document.getElementById('btn-zoom').addEventListener('click', () => {
      const steps = [0.75, 0.9, 1, 1.2, 1.5];
      this.renderer.zoom = steps[(steps.indexOf(this.renderer.zoom) + 1) % steps.length];
      this.settings.zoom = this.renderer.zoom; saveSettings(this.settings);
      this.render();
    });
    document.getElementById('btn-help').addEventListener('click', () => this.showHelp());
    document.getElementById('btn-save').addEventListener('click', () => this.feed('S'));
  }

  // =========================================================================
  // rendering the frame
  // =========================================================================

  pushMessage(text, cls) {
    this.recent.push({ text, cls });
    if (this.recent.length > 40) this.recent.shift();
    this.renderMessages();
  }

  renderMessages(prompt = null) {
    const max = window.innerWidth <= 560 || window.innerHeight <= 560 ? 2 : 3;
    const html = [];
    if (prompt) html.push(`<div class="aim">${escapeHtml(prompt)}</div>`);
    for (const m of this.recent.slice(-(prompt ? max - 1 : max))) {
      html.push(`<div class="${m.cls ? 'm-' + m.cls : ''}">${escapeHtml(m.text)}</div>`);
    }
    this.el.msg.innerHTML = html.join('');
  }

  render() {
    this.renderer.draw();
    this.renderBars();
    this.renderSkillBar();
    this.renderAction();
  }

  /**
   * Health as pips, stamina as a bar.
   *
   * Pips because health is small and countable and "how many hits can I take"
   * must be answerable at a glance; a continuous bar hides exactly that.
   */
  renderBars() {
    const p = this.game.player;
    if (!p) return;
    let hp = '';
    for (let i = 0; i < p.hpMax; i++) hp += `<i class="${i < p.hp ? 'on' : ''}"></i>`;
    this.el.hpbar.innerHTML = hp;

    const frac = p.stamina / p.staminaMax;
    const rollCost = p.rollCost();
    this.el.stbar.innerHTML =
      `<span class="fill${p.stamina < rollCost ? ' low' : ''}" style="width:${frac * 100}%"></span>` +
      `<span class="mark" style="left:${(rollCost / p.staminaMax) * 100}%"></span>`;

    const lvl = this.game.level;
    const alive = lvl ? lvl.livingEnemies().length : 0;
    this.el.status.innerHTML =
      `<span class="lo">Floor</span> <b>${p.depth}</b>/${DUNGEON_DEPTH}` +
      `　<span class="lo">Foes</span> <b>${alive}</b>` +
      // Deaths and turn count are how a run reads afterwards, not how it is
      // played. On a phone the line is one ellipsis away from hiding the floor
      // number, so the retrospective half steps aside.
      `<span class="roomy">　<span class="lo">Deaths</span> <b>${p.deaths}</b>` +
      `　<span class="lo">T</span> ${this.game.turn}</span>`;
  }

  renderSkillBar() {
    const p = this.game.player;
    if (!p) return;
    // Swapping a weapon changes which buttons exist, and the bar is built once.
    if (this.layoutSignature() !== this.builtSignature) this.buildSkillBar();
    const stuck = p.recovering;
    this.el.skills.classList.toggle('recovering', stuck);

    for (const b of this.el.skills.querySelectorAll('.skill[data-prep]')) {
      const c = p.prepared(b.dataset.prep);
      if (!c) continue;
      const left = p.chargesOf(c.key);
      b.querySelector('.cost').textContent = c.stamina ? `${c.stamina}` : '';
      b.querySelector('.cd').textContent = `${left}`;
      b.classList.toggle('cooling', left <= 0);
      b.classList.toggle('poor', !!c.stamina && p.stamina < c.stamina);
      b.classList.toggle('armed', this.aimSkill === `prep:${b.dataset.prep}`);
      b.disabled = left <= 0;
    }

    for (const b of this.el.skills.querySelectorAll('.skill[data-skill]')) {
      const key = b.dataset.skill;
      const def = SKILL_BY_KEY[key];
      const slot = p.skill(key);
      const cost = p.costOf(key);
      b.querySelector('.cost').textContent = `${cost}`;
      b.querySelector('.cd').textContent = slot && slot.cd > 0 ? slot.cd : '';
      b.classList.toggle('cooling', !!slot && slot.cd > 0);
      b.classList.toggle('poor', p.stamina < cost);
      b.classList.toggle('armed', this.aimSkill === key);
    }
  }

  animateTrail(cells, glyph, colour) {
    if (!cells?.length) return;
    this.renderer.overlayTrail = { cells, glyph, colour };
    this.renderer.draw();
    setTimeout(() => { this.renderer.overlayTrail = null; this.renderer.draw(); }, 110);
  }

  /** A red wash on death, so it is unmistakable that the run reset. */
  onDeath() {
    const f = this.el.flash;
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }


  // =========================================================================
  // the pack
  // =========================================================================

  /**
   * Looking is free; changing something costs a turn.
   *
   * That split matters. If opening the pack cost a turn the game would be
   * punishing you for checking what you are carrying, which teaches people to
   * memorise a menu instead of reading it. The turn is charged on the swap,
   * which is the decision worth pricing.
   */
  showPack() {
    if (!this.game.running || this.game.busy) return;
    const p = this.game.player;
    const ov = this.el.overlay;
    ov.hidden = false;

    const worn = (slot, label) => {
      const it = p.item(slot);
      return `<tr><td class="key">${label}</td><td>${it ? escapeHtml(it.name) : '<i>空</i>'}</td>` +
             `<td>${it ? `<button class="btn" data-off="${slot}">取下</button>` : ''}</td></tr>`;
    };

    const readied = (kind, label) => {
      const c = p.prepared(kind);
      return `<tr><td class="key">${label}</td>` +
             `<td>${c ? `${escapeHtml(c.name)} <span class="dim">(${p.chargesOf(c.key)})</span>` : '<i>空</i>'}</td>` +
             `<td>${c ? `<button class="btn" data-unprep="${kind}">收起</button>` : ''}</td></tr>`;
    };

    const rows = p.pack.length
      ? p.pack.map((k, i) => {
          if (isConsumable(k)) {
            const c = CONSUMABLE_BY_KEY[k];
            return `<tr><td class="key">${i + 1}</td><td>${escapeHtml(c.name)}<br>` +
                   `<span class="dim">${escapeHtml(c.desc ?? '')}</span></td>` +
                   `<td><button class="btn" data-prepare="${c.kind}" data-item="${escapeHtml(k)}">` +
                   `${c.kind === 'magic' ? '記憶' : '備用'}</button></td></tr>`;
          }
          const it = ITEM_BY_KEY[k];
          if (!it) return '';
          const where = slotsFor(it).map((sl) =>
            `<button class="btn" data-on="${sl}" data-item="${escapeHtml(k)}">` +
            `${sl === SLOT.ARMOUR ? '穿上' : sl === SLOT.MAIN ? '主手' : '副手'}</button>`).join(' ');
          return `<tr><td class="key">${i + 1}</td><td>${escapeHtml(it.name)}<br>` +
                 `<span class="dim">${escapeHtml(it.desc ?? '')}</span></td><td>${where}</td></tr>`;
        }).join('')
      : '<tr><td colspan="3"><i>背包是空的。</i></td></tr>';

    ov.innerHTML = `<h2>背包</h2>
      <p>看是免費的。<b>換裝會推進一個回合</b>——所以帶第二把武器是計畫,不是選單。</p>
      <table>${worn(SLOT.MAIN, '主手')}${worn(SLOT.OFF, '副手')}${worn(SLOT.ARMOUR, '防具')}
      ${readied('magic', '記憶')}${readied('item', '備用')}</table>
      <h2>攜帶</h2>
      <table>${rows}</table>
      <div class="foot"><button class="btn" data-act="close">關閉 (Esc)</button></div>`;

    const close = () => this.closeOverlay();
    const swap = (slot, key) => {
      if (!this.game.equipFromPack(slot, key)) { this.showPack(); return; }
      close();
      this.feed('.');                 // the swap is what spends the turn
    };
    ov.querySelector('[data-act="close"]').addEventListener('click', close);
    for (const b of ov.querySelectorAll('[data-on]')) {
      b.addEventListener('click', () => swap(b.dataset.on, b.dataset.item));
    }
    for (const b of ov.querySelectorAll('[data-off]')) {
      b.addEventListener('click', () => swap(b.dataset.off, null));
    }
    const ready = (kind, key) => {
      if (!this.game.prepareFromPack(kind, key)) { this.showPack(); return; }
      close();
      this.feed('.');
    };
    for (const b of ov.querySelectorAll('[data-prepare]')) {
      b.addEventListener('click', () => ready(b.dataset.prepare, b.dataset.item));
    }
    for (const b of ov.querySelectorAll('[data-unprep]')) {
      b.addEventListener('click', () => ready(b.dataset.unprep, null));
    }
    ov.scrollTop = 0;
    this.pending = { onKey: () => close() };
  }

  // =========================================================================
  // overlays
  // =========================================================================

  closeOverlay() {
    this.el.overlay.hidden = true;
    this.el.overlay.innerHTML = '';
    this.pending = null;
    this.renderMessages();
  }

  showText(title, body) {
    return new Promise((resolve) => {
      const ov = this.el.overlay;
      ov.hidden = false;
      const html = Array.isArray(body)
        ? body.map((l) => `<div>${escapeHtml(l) || '&nbsp;'}</div>`).join('')
        : body;
      ov.innerHTML = `<h2>${escapeHtml(title)}</h2>${html}
        <div class="foot"><button class="btn" data-act="close">Close (Esc)</button></div>`;
      const done = () => { this.closeOverlay(); resolve(); };
      ov.querySelector('button').addEventListener('click', done);
      ov.scrollTop = 0;
      this.pending = { onKey: () => done() };
    });
  }

  showHelp() { return this.showText('claudeSouls', HELP_HTML); }

  showSaved() {
    this.showText('Saved', [
      'Your run is stored in this browser.',
      'Reload and choose Continue to pick it up.',
      '',
      'The floor you are on comes back exactly as you left it - it is derived',
      'from the run seed, not stored - so nothing is lost by closing the tab.',
    ]);
  }

  showGameOver(r) {
    const ov = this.el.overlay;
    ov.hidden = false;
    const won = r.how === 'won';
    ov.innerHTML = `
      <h2>${won ? 'The flame goes out' : 'Ashes'}</h2>
      <p>${won
        ? 'You reached the bottom and put out the First Flame.'
        : `You fell for good on floor ${r.depth}.`}</p>
      <table>
        <tr><td class="key">Deepest floor</td><td>${r.maxDepth} / ${DUNGEON_DEPTH}</td></tr>
        <tr><td class="key">Deaths</td><td>${r.deaths}</td></tr>
        <tr><td class="key">Kills</td><td>${r.kills}</td></tr>
        <tr><td class="key">Turns</td><td>${r.turns}</td></tr>
        <tr><td class="key">Time</td><td>${fmtDuration(r.elapsed)}</td></tr>
        <tr><td class="key">Seed</td><td>${escapeHtml(String(r.seed))}</td></tr>
      </table>
      <div class="foot">
        <button class="big-btn" id="again">Again</button>
        <button class="btn" id="same">Same seed</button>
      </div>`;
    ov.querySelector('#again').addEventListener('click', () => location.reload());
    ov.querySelector('#same').addEventListener('click', () => {
      const u = new URL(location.href);
      u.searchParams.set('seed', String(r.seed));
      location.href = u.toString();
    });
    this.pending = { onKey: () => {} };
  }
}

// ---------------------------------------------------------------- helpers

function dirName(d) {
  const names = { '0,-1': 'north', '1,-1': 'north-east', '1,0': 'east', '1,1': 'south-east',
                  '0,1': 'south', '-1,1': 'south-west', '-1,0': 'west', '-1,-1': 'north-west' };
  return names[`${d.dx},${d.dy}`] ?? '';
}

function normaliseKey(ev) {
  const k = ev.key;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(k)) return null;
  if (ev.ctrlKey) return k.toLowerCase() === 'p' ? 'C-p' : null;
  if (k.startsWith('Arrow')) return k;
  if (k === 'Escape' || k === 'Enter') return k;
  if (k === ' ') return ' ';
  if (ev.code?.startsWith('Numpad') && /^[0-9]$/.test(k)) return 'numpad' + k;
  if (k.length === 1) return k;
  return null;
}

/**
 * A little map of what a skill actually does, drawn on the button.
 *
 * The complaint that prompted this was exact: the skills give no visual
 * feedback about what they correspond to. "Sweep" and "Strike" are words, and
 * a word does not tell you that one covers three tiles and the other covers
 * one - so the only way to learn the difference was to spend the stamina and
 * read the log afterwards. On a phone, where the buttons are the entire
 * interface, that is the difference between a game you can read and a game you
 * have to memorise.
 *
 * The shapes are derived from the same pattern table the attacks resolve
 * against, not drawn by hand, so an icon cannot quietly start lying about what
 * its skill does.
 */
function skillIcon(def, arc = 1) {
  let hit = [], step = [], guard = [];

  if (def.defend) {
    // Not an attack, so it is not drawn like one: the shield's arc, in the
    // defensive colour, so a buckler and a tower shield are visibly different
    // buttons rather than the same word.
    const ring = [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0]];
    for (let i = 0; i < Math.min(arc, ring.length); i++) {
      guard.push({ x: ring[i][0], y: ring[i][1] });
    }
  } else if (def.move) {
    // Roll: pure movement, no tiles struck.
    for (let i = 1; i <= (def.dash ?? 1); i++) step.push({ x: 0, y: -i });
  } else if (def.ranged) {
    // The knife keeps flying after your turn ends, so the lane fades out
    // rather than stopping at a tidy edge.
    for (let i = 1; i <= 3; i++) hit.push({ x: 0, y: -i, fade: i / 3 });
  } else {
    const reach = def.dash ?? 0;
    for (let i = 1; i <= reach; i++) step.push({ x: 0, y: -i });
    for (const t of attackTiles(0, -reach, 0, -1, def.pattern ?? 'front')) hit.push(t);
  }

  // Clamp the drawn grid. A six-tile lane is seven cells tall, which at button
  // height renders about three pixels wide - technically correct and completely
  // unreadable. Anything past the limit is dropped and the last cell kept is
  // faded, so a long shape reads as "and it keeps going".
  const LIMIT = 4;
  const clip = (cells) => cells.filter((c) => Math.abs(c.x) <= LIMIT && Math.abs(c.y) <= LIMIT);
  const truncated = (hit.length + step.length + guard.length) >
                    (clip(hit).length + clip(step).length + clip(guard).length);
  hit = clip(hit); step = clip(step); guard = clip(guard);
  if (truncated) {
    const far = [...hit, ...step].sort((a, b) =>
      (Math.abs(b.x) + Math.abs(b.y)) - (Math.abs(a.x) + Math.abs(a.y)))[0];
    if (far) far.fade = 1;
  }

  const all = [{ x: 0, y: 0 }, ...hit, ...step, ...guard];
  const minX = Math.min(...all.map((c) => c.x)), maxX = Math.max(...all.map((c) => c.x));
  const minY = Math.min(...all.map((c) => c.y)), maxY = Math.max(...all.map((c) => c.y));
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const S = 10, G = 1.8;

  const cell = (c, cls) =>
    `<rect class="${cls}" x="${(c.x - minX) * S + G / 2}" y="${(c.y - minY) * S + G / 2}" ` +
    `width="${S - G}" height="${S - G}" rx="1.7"` +
    (c.fade ? ` opacity="${(1.05 - c.fade * 0.55).toFixed(2)}"` : '') + '/>';

  return `<svg class="ico" viewBox="0 0 ${w * S} ${h * S}" width="${w * S}" height="${h * S}" aria-hidden="true">` +
    guard.map((c) => cell(c, 'ic-guard')).join('') +
    step.map((c) => cell(c, 'ic-step')).join('') +
    hit.map((c) => cell(c, 'ic-hit')).join('') +
    cell({ x: 0, y: 0 }, 'ic-me') +
    '</svg>';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
