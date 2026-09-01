// Saving.
//
// Far simpler than claudeHack's, and the reason is the seed. There is no loot,
// nothing on the ground, and every enemy on a floor respawns whenever you rest
// or die - so the entire world is reproducible from `seed + depth`, and the
// save only has to hold the player and what the player has *seen*.
//
// That is the payoff of the persistent-seed design: a save is under 30 KB no
// matter how deep you have been.

import { RNG } from '../../../engine/rng.js';
import { Player } from './actors.js';

const KEY = 'claudesouls.save.v1';
const SETTINGS_KEY = 'claudesouls.settings.v1';

function b64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function saveGame(game) {
  try {
    const p = game.player;
    const data = {
      version: 1,
      seed: game.seed,
      vow: game.vow,
      turn: game.turn,
      stats: game.stats,
      elapsed: (game.elapsedBefore ?? 0) + (Date.now() - game.startedAt),
      player: {
        name: p.name, x: p.x, y: p.y, depth: p.depth, maxDepth: p.maxDepth,
        hp: p.hp, hpMax: p.hpMax, stamina: p.stamina, staminaMax: p.staminaMax,
        heavyArmour: p.heavyArmour, facing: p.facing, sprite: p.sprite,
        skills: p.skills, deaths: p.deaths, kills: p.kills, turns: p.turns,
        bonfire: p.bonfire,
      },
      // Only map memory is worth keeping; everything else regenerates.
      seen: [...game.levels.entries()].map(([d, l]) => [d, b64(l.seen)]),
      messages: game.messages.slice(-40),
    };
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('save failed', err);
    return false;
  }
}

export function hasSave() {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}

export function saveSummary() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (!d) return null;
    return {
      name: d.player.name, depth: d.player.depth, maxDepth: d.player.maxDepth,
      deaths: d.player.deaths, turn: d.turn, seed: d.seed, vow: d.vow,
      hp: d.player.hp, hpMax: d.player.hpMax,
    };
  } catch { return null; }
}

export function loadGame(game) {
  const raw = localStorage.getItem(KEY);
  if (!raw) return false;
  const d = JSON.parse(raw);

  game.seed = d.seed;
  game.vow = d.vow ?? 'light';
  game.rng = new RNG(d.seed);
  game.turn = d.turn;
  game.stats = d.stats;
  game.startedAt = Date.now();
  game.elapsedBefore = d.elapsed ?? 0;
  game.messages = d.messages ?? [];
  game.levels = new Map();
  game.running = true;
  game.gameOver = null;
  game.aiming = null;

  const p = new Player(d.player.name);
  Object.assign(p, {
    x: d.player.x, y: d.player.y, depth: d.player.depth, maxDepth: d.player.maxDepth,
    hp: d.player.hp, hpMax: d.player.hpMax,
    stamina: d.player.stamina, staminaMax: d.player.staminaMax,
    heavyArmour: d.player.heavyArmour, facing: d.player.facing,
    sprite: d.player.sprite, skills: d.player.skills,
    deaths: d.player.deaths, kills: d.player.kills, turns: d.player.turns,
    bonfire: d.player.bonfire,
  });
  game.player = p;

  // Rebuild every floor from the seed, then paint the remembered map back on.
  for (const [depth, seen] of d.seen ?? []) {
    const lvl = game.levelAt(Number(depth));
    const bytes = unb64(seen);
    if (bytes.length === lvl.seen.length) lvl.seen.set(bytes);
  }
  game.level = game.levelAt(p.depth);
  return true;
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}; } catch { return {}; }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
