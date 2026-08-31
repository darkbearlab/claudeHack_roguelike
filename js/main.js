// Boot: the title screen, character choice, and wiring the game to the UI.

import { Game, VERSION } from './game/game.js';
import { UI } from './ui/ui.js';
import { ROLES } from './data/roles.js';
import { RNG, makeSeedPhrase } from './core/rng.js';
import { hasSave, loadGame, saveSummary, clearSave, saveGame } from './game/save.js';
import { MONSTERS } from './data/monsters.js';
import { OBJECTS } from './data/items.js';

const splash = document.getElementById('splash');
const body = document.getElementById('splash-body');

let chosenRole = 'valkyrie';

function render() {
  const save = saveSummary();
  const params = new URLSearchParams(location.search);
  const seedParam = params.get('seed') ?? '';

  body.innerHTML = `
    ${save ? `
      <h2>Continue</h2>
      <div class="note" style="margin-bottom:8px">
        ${escapeHtml(save.name)} the ${escapeHtml(roleName(save.role))},
        dungeon level ${save.depth}, experience level ${save.xpLevel},
        ${save.hp}/${save.hpMax} HP, turn ${save.turn}.
      </div>
      <div class="splash-row" style="margin-top:0">
        <button class="big-btn" id="btn-continue">Continue this run</button>
        <button class="btn" id="btn-abandon">Abandon it</button>
      </div>
    ` : ''}

    <h2>New game</h2>
    <div class="choice-grid">
      ${ROLES.map((r) => `
        <button class="choice ${r.key === chosenRole ? 'sel' : ''}" data-role="${r.key}">
          <b>${escapeHtml(r.name)}</b>
          <small>${escapeHtml(r.blurb)}</small>
        </button>`).join('')}
    </div>

    <div class="splash-row">
      <input type="text" id="name" placeholder="your name" maxlength="20"
             autocomplete="off" autocapitalize="words" spellcheck="false">
      <input type="text" id="seed" placeholder="seed (optional)" value="${escapeHtml(seedParam)}"
             autocomplete="off" autocapitalize="off" spellcheck="false">
    </div>
    <div class="splash-row">
      <button class="big-btn" id="btn-start">Enter the dungeon</button>
      <button class="btn" id="btn-guide-zh">中文遊戲指南</button>
      <button class="btn" id="btn-help">How to play</button>
    </div>

    <div class="note" style="margin-top:18px">
      <p><b>沒玩過 NetHack?</b> 按上面的「中文遊戲指南」,那是一份寫給新手的完整說明 &mdash;
      看畫面、打架、鑑定物品、常見死法都有。遊戲中隨時按 <code>?</code> 也叫得出來。</p>
      <p><b>Two words on what this is.</b> A roguelike in the NetHack tradition: one life,
      no undo, a dungeon that is different every run, and objects whose identities are
      shuffled at the start of each game. The same <i>seed</i> always produces the same
      dungeon, so a run can be handed to someone else exactly as you played it.</p>
      <p>It plays with a keyboard or entirely with a thumb. Nothing installs; the save
      lives in this browser.</p>
      <p>${MONSTERS.length} monster species &middot; ${OBJECTS.length} object types &middot;
      26 dungeon levels &middot; version ${VERSION}</p>
    </div>`;

  for (const b of body.querySelectorAll('.choice')) {
    b.addEventListener('click', () => { chosenRole = b.dataset.role; render(); });
  }
  body.querySelector('#btn-start').addEventListener('click', startNew);
  body.querySelector('#btn-help').addEventListener('click', () => showDocFromSplash('en'));
  body.querySelector('#btn-guide-zh').addEventListener('click', () => showDocFromSplash('zh'));
  body.querySelector('#btn-continue')?.addEventListener('click', continueRun);
  body.querySelector('#btn-abandon')?.addEventListener('click', () => {
    if (confirm('Delete the saved run? This cannot be undone.')) { clearSave(); render(); }
  });
  body.querySelector('#seed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startNew();
    e.stopPropagation();
  });
  body.querySelector('#name').addEventListener('keydown', (e) => e.stopPropagation());
}

function roleName(key) {
  return ROLES.find((r) => r.key === key)?.name ?? key;
}

function startNew() {
  const name = body.querySelector('#name').value.trim() || randomName();
  let seed = body.querySelector('#seed').value.trim();
  if (!seed) seed = makeSeedPhrase(new RNG(Date.now() ^ Math.floor(performance.now() * 1000)));
  launch((game) => game.newGame({ seed, role: chosenRole, name }));
}

function continueRun() {
  launch((game) => {
    if (!loadGame(game)) { alert('That save could not be read.'); clearSave(); render(); return false; }
    game.msg('Welcome back.', 'good');
    return true;
  });
}

function launch(setup) {
  const game = new Game(null);
  const ui = new UI(game);
  if (setup(game) === false) return;

  splash.hidden = true;
  ui.render();
  game.afterMove();
  ui.render();

  // Warm the sprite cache for what is on this level right away, so the first
  // few frames are not a mosaic of missing tiles.
  const names = new Set([game.player.sprite]);
  for (const m of game.level.monsters) if (m.sprite) names.add(m.sprite);
  for (const o of game.level.items) { const s = spriteOf(o); if (s) names.add(s); }
  ['feat_stairs_down', 'feat_stairs_up', 'feat_door', 'feat_altar', 'feat_fountain'].forEach((n) => names.add(n));
  ui.renderer.preload(names);

  // Autosave every 50 turns; a phone that gets backgrounded should not lose a run.
  let lastSaved = 0;
  setInterval(() => {
    if (!game.running) return;
    if (game.turn - lastSaved < 50) return;
    lastSaved = game.turn;
    saveGame(game);
  }, 5000);
  window.addEventListener('pagehide', () => { if (game.running) saveGame(game); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && game.running) saveGame(game);
  });

  window.CH = { game, ui };   // handy in the console; harmless in play
}

function spriteOf(o) {
  const t = OBJECTS.find((b) => b.key === o.key && b.cls === o.cls);
  return t?.sprite ?? null;
}

// Reading the manual before starting needs a UI object, because that is where
// the overlay lives - but not a running game. One inert UI is built lazily and
// reused; building a fresh one per click would stack duplicate key listeners,
// and the previous version dodged that by reloading the page afterwards, which
// threw away whatever the player had already typed into the name and seed
// fields.
let docUI = null;

async function showDocFromSplash(which) {
  if (!docUI) docUI = new UI(new Game(null));
  splash.hidden = true;
  try {
    await (which === 'zh' ? docUI.showGuideZh() : docUI.showHelpEn());
  } finally {
    splash.hidden = false;
  }
}

function randomName() {
  const a = ['Ari', 'Bel', 'Cor', 'Dag', 'Eld', 'Fen', 'Gar', 'Hal', 'Ing', 'Jor',
             'Kel', 'Lun', 'Mor', 'Nim', 'Osk', 'Per', 'Quen', 'Rav', 'Syl', 'Tor'];
  const b = ['a', 'ic', 'wyn', 'dor', 'is', 'mund', 'ra', 'thas', 'vin', 'ok'];
  const r = new RNG(Date.now());
  return r.pick(a) + r.pick(b);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

render();
