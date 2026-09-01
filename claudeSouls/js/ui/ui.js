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

  buildSkillBar() {
    const bar = this.el.skills;
    bar.innerHTML = SKILLS.map((s, i) => `
      <button class="skill" data-skill="${s.key}" title="${escapeHtml(s.hint)}">
        <span class="num">${i + 1}</span>
        <span class="nm">${escapeHtml(s.name)}</span>
        <span class="cost"></span>
        <span class="cd"></span>
      </button>`).join('');

    for (const b of bar.querySelectorAll('.skill')) {
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        this.startGesture(ev, b.dataset.skill, b);
      });
    }
  }

  startGesture(ev, skillKey, fromEl) {
    if (!this.game.running || this.game.busy) return;
    const def = SKILL_BY_KEY[skillKey];
    const slot = this.game.player.skill(skillKey);
    if (!def || !slot) return;
    if (slot.cd > 0) { this.pushMessage(`${def.name} is not ready (${slot.cd}).`, 'warn'); return; }
    const cost = skillKey === 'roll' ? this.game.player.rollCost() : def.stamina;
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
      this.renderMessages(`${SKILL_BY_KEY[this.aimSkill].name}: drag away from yourself to aim.`);
      this.render();
      return;
    }

    const dir = snapDir(dx, dy);
    const changed = !this.aimDir || this.aimDir.dx !== dir.dx || this.aimDir.dy !== dir.dy;
    this.aimDir = dir;
    if (changed && navigator.vibrate) { try { navigator.vibrate(8); } catch { /* ignore */ } }

    this.renderer.aim = { dir, tiles: this.previewTiles(this.aimSkill, dir) };
    const def = SKILL_BY_KEY[this.aimSkill];
    const cost = this.aimSkill === 'roll' ? this.game.player.rollCost() : def.stamina;
    // The readout goes in the message line because a finger covers the tiles.
    this.renderMessages(`${def.name} → ${dirName(dir)}   (${cost} stamina` +
      `${def.advancesTurn === false ? ', free turn' : ''})   release to commit`);
    this.render();
  }

  previewTiles(key, dir) {
    const def = SKILL_BY_KEY[key];
    const p = this.game.player;
    const lvl = this.game.level;

    if (def.ranged) {
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
      this.renderMessages(`${SKILL_BY_KEY[skill].name}: drag out from yourself, or press a direction key.`);
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
      `　<span class="lo">Deaths</span> <b>${p.deaths}</b>` +
      `　<span class="lo">Foes</span> <b>${alive}</b>` +
      `　<span class="lo">T</span> ${this.game.turn}`;
  }

  renderSkillBar() {
    const p = this.game.player;
    if (!p) return;
    for (const b of this.el.skills.querySelectorAll('.skill')) {
      const key = b.dataset.skill;
      const def = SKILL_BY_KEY[key];
      const slot = p.skill(key);
      const cost = key === 'roll' ? p.rollCost() : def.stamina;
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
