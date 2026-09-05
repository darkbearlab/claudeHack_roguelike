// Boot: the title screen and wiring.

import { Game, VERSION, DUNGEON_DEPTH } from './game/game.js';
import { UI } from './ui/ui.js';
import { RNG, makeSeedPhrase } from '../../engine/rng.js';
import { ENEMIES } from './data/enemies.js';
import { ITEMS, CONSUMABLES } from './data/items.js';
import { NPC_BY_KEY } from './data/npcs.js';
import { SKILLS } from './data/skills.js';
import { HEROES } from './data/heroes.js';
import { saveSummary, loadGame, clearSave, saveGame } from './game/save.js';

const splash = document.getElementById('splash');
const body = document.getElementById('splash-body');

function render() {
  const save = saveSummary();
  const seedParam = new URLSearchParams(location.search).get('seed') ?? '';

  // Rendered from HEROES rather than written out, for the same reason the hall
  // places them from HEROES: two lists of the same people go out of step, and
  // this one is the list a new player reads first.
  //
  // These are not buttons. The vow they replaced WAS a button and had stopped
  // doing anything at all - `start()` went straight to the hall and never read
  // the variable - so it was promising a choice the screen could not make and
  // describing stamina costs that belong to the people below. The choice is a
  // room now, so this is a cast list.
  const roster = HEROES.map((h) => `
      <div class="choice">
        <b>${escapeHtml(h.name)}</b>
        <small>${escapeHtml(h.blurb)}</small>
      </div>`).join('');

  body.innerHTML = `
    ${save ? `
      <h2>繼續</h2>
      <div class="note" style="margin-bottom:8px">
        ${escapeHtml(save.name)}${save.hero ? `(${escapeHtml(save.hero)})` : ''}・第 ${save.depth} 層(最深 ${save.maxDepth})・
        死亡 ${save.deaths} 次・${save.hp}/${save.hpMax} HP・回合 ${save.turn}
      </div>
      <div class="row" style="margin-top:0">
        <button class="big-btn" id="btn-continue">繼續這一趟</button>
        <button class="btn" id="btn-abandon">放棄</button>
      </div>` : ''}

    <h2>你是誰,在裡面決定</h2>
    <div class="note" style="margin-bottom:10px">
      走下去會先到<b>灰燼之廳</b>。這幾個人站在火邊,走到誰旁邊跟他說話,你就是誰。
      技能是綁人的,不是綁武器的 —— 換人等於換一整套打法。
    </div>
    <div class="choice-grid">
${roster}
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
      ${HEROES.length} 個角色 &middot; ${SKILLS.length} 個技能 &middot; v${VERSION}</p>
    </div>`;

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

/**
 * Testing switch: start holding one of everything.
 *
 * Deliberately here, in the thing that starts an *interactive* run, and NOT in
 * `newGame()`. The bot and the test suite both call newGame, and if they
 * inherited this then every balance number in DESIGN.md would quietly become a
 * measurement of a different game - the bot would be choosing from twelve
 * weapons instead of playing the kit its numbers were gathered with.
 *
 * On by default because it was asked for; `?gear=kit` gives the real start
 * back without editing anything, and flipping the constant turns it off for
 * good. Nothing else in the codebase can reach it.
 */
const TEST_ALL_GEAR = true;

function stockEverything(game) {
  const p = game.player;
  const worn = new Set([p.equip.main, p.equip.off, p.equip.armour]);
  for (const it of ITEMS) {
    if (!worn.has(it.key) && !p.pack.includes(it.key)) p.pack.push(it.key);
  }
  for (const c of CONSUMABLES) {
    if (!p.pack.includes(c.key)) p.pack.push(c.key);
    // Stocked full, and a bonfire refills them like anything else.
    if (p.charges[c.key] === undefined) p.charges[c.key] = c.charges;
  }
  game.msg(`測試模式:全部 ${ITEMS.length} 件裝備、${CONSUMABLES.length} 個消耗品都給你了(?gear=kit 可以拿掉)。`, 'good');
}

function start() {
  const name = body.querySelector('#name').value.trim() || randomName();
  const seed = body.querySelector('#seed').value.trim() ||
               makeSeedPhrase(new RNG(Date.now() ^ Math.floor(performance.now() * 1000)));
  launch((game) => {
    // Into the hall, not into the dungeon. Which person you are is decided by
    // walking up to one of them, and the run starts when you take the stair -
    // so there is no character-select screen to keep in step with the roster,
    // because the room IS the roster.
    game.pendingSeed = seed;
    game.onRunStart = (g) => {
      const params = new URLSearchParams(location.search);
      if (TEST_ALL_GEAR && params.get('gear') !== 'kit') stockEverything(g);
    };
    game.enterHub();
    game.player.name = name;
    return true;
  });
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
  for (const n of game.level.npcs ?? []) {
    const spec = NPC_BY_KEY[n.key];
    if (spec?.sprite) names.add(spec.sprite);
  }
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
