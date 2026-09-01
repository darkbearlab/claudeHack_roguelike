// Boot: the title screen and wiring.

import { Game, VERSION, DUNGEON_DEPTH } from './game/game.js';
import { UI } from './ui/ui.js';
import { RNG, makeSeedPhrase } from '../../engine/rng.js';
import { ENEMIES } from './data/enemies.js';
import { SKILLS } from './data/skills.js';
import { saveSummary, loadGame, clearSave, saveGame } from './game/save.js';

const splash = document.getElementById('splash');
const body = document.getElementById('splash-body');
let vow = 'light';

function render() {
  const save = saveSummary();
  const seedParam = new URLSearchParams(location.search).get('seed') ?? '';

  body.innerHTML = `
    ${save ? `
      <h2>繼續</h2>
      <div class="note" style="margin-bottom:8px">
        ${escapeHtml(save.name)}・第 ${save.depth} 層(最深 ${save.maxDepth})・
        死亡 ${save.deaths} 次・${save.hp}/${save.hpMax} HP・回合 ${save.turn}
      </div>
      <div class="row" style="margin-top:0">
        <button class="big-btn" id="btn-continue">繼續這一趟</button>
        <button class="btn" id="btn-abandon">放棄</button>
      </div>` : ''}

    <h2>誓約</h2>
    <div class="choice-grid">
      <button class="choice ${vow === 'light' ? 'sel' : ''}" data-vow="light">
        <b>輕裝</b>
        <small>12 點生命,翻滾只要 4 點精力。滿條可以滾五次。
               打不起,但可以一直閃 —— 新手建議這個。</small>
      </button>
      <button class="choice ${vow === 'heavy' ? 'sel' : ''}" data-vow="heavy">
        <b>重甲</b>
        <small>16 點生命,受到的傷害 −1,但翻滾要 7 點精力,滿條只能滾兩到三次。
               你得看得更遠、更早決定。</small>
      </button>
    </div>

    <div class="row">
      <input type="text" id="name" placeholder="名字" maxlength="18"
             autocomplete="off" autocapitalize="words" spellcheck="false">
      <input type="text" id="seed" placeholder="種子(可留空)" value="${escapeHtml(seedParam)}"
             autocomplete="off" autocapitalize="off" spellcheck="false">
    </div>
    <div class="row">
      <button class="big-btn" id="btn-start">走下去</button>
      <button class="btn" id="btn-help">怎麼玩</button>
    </div>

    <div class="note" style="margin-top:18px">
      <p><b>你不能硬扛傷害。</b>三到五下就死,而且攻擊必中。敵人出手前會舉手、會轉向你、
      會把要打的格子染紅 —— 看到之後翻滾走開,或者打斷它。</p>
      <p><b>翻滾花精力,但不推進回合。</b>所以真正的時鐘是精力,不是回合。
      每一刻的問題都是:再貪一刀,還是留著閃?</p>
      <p><b>死了不是結束。</b>你會回到最後的篝火,整層敵人復活 ——
      但樓層是從種子長出來的,永遠一樣。死幾次之後你就記住它了,那就是成長。</p>
      <p>${DUNGEON_DEPTH} 層 &middot; ${ENEMIES.length} 種敵人 &middot;
      ${SKILLS.length} 個技能 &middot; v${VERSION}</p>
    </div>`;

  for (const b of body.querySelectorAll('.choice')) {
    b.addEventListener('click', () => { vow = b.dataset.vow; render(); });
  }
  body.querySelector('#btn-start').addEventListener('click', start);
  body.querySelector('#btn-help').addEventListener('click', showHelpEarly);
  body.querySelector('#btn-continue')?.addEventListener('click', resume);
  body.querySelector('#btn-abandon')?.addEventListener('click', () => {
    if (confirm('放棄這一趟?存檔會被刪除。')) { clearSave(); render(); }
  });
  for (const id of ['#name', '#seed']) {
    body.querySelector(id).addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') start();
    });
  }
}

function start() {
  const name = body.querySelector('#name').value.trim() || randomName();
  const seed = body.querySelector('#seed').value.trim() ||
               makeSeedPhrase(new RNG(Date.now() ^ Math.floor(performance.now() * 1000)));
  launch((game) => game.newGame({ seed, name, vow }));
}

function resume() {
  launch((game) => {
    if (!loadGame(game)) { alert('存檔讀不起來。'); clearSave(); render(); return false; }
    game.msg('你在篝火旁醒來。', 'good');
    return true;
  });
}

function launch(setup) {
  const game = new Game(null);
  const ui = new UI(game);
  if (setup(game) === false) return;

  splash.hidden = true;
  game.afterMove();
  ui.render();

  // Warm what is on this floor so the first frames are not a mosaic.
  const names = new Set([game.player.sprite, 'feat_stairs_down', 'feat_stairs_up', 'feat_door']);
  for (const e of game.level.enemies) if (e.sprite) names.add(e.sprite);
  ui.renderer.preload(names);

  let lastSaved = 0;
  setInterval(() => {
    if (!game.running || game.turn - lastSaved < 40) return;
    lastSaved = game.turn;
    saveGame(game);
  }, 5000);
  window.addEventListener('pagehide', () => { if (game.running) saveGame(game); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && game.running) saveGame(game);
  });

  window.CS = { game, ui };
}

let docUI = null;
async function showHelpEarly() {
  if (!docUI) docUI = new UI(new Game(null));
  splash.hidden = true;
  try { await docUI.showHelp(); } finally { splash.hidden = false; }
}

function randomName() {
  const a = ['Ash', 'Cin', 'Ember', 'Grey', 'Hollow', 'Kir', 'Mour', 'Pale', 'Rook', 'Vell'];
  const b = ['en', 'ric', 'wyn', 'dan', 'is', 'mund', 'ra', 'thas', 'vin', 'ok'];
  const r = new RNG(Date.now());
  return r.pick(a) + r.pick(b);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

render();
