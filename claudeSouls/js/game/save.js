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
import { TRACKS } from '../data/souls.js';

// v2: the player carries equipment and a pack now, and health and damage
// reduction are read off the armour rather than stored. A v1 save cannot be
// upgraded into that, so it is left where it is and simply not read.
const KEY = 'claudesouls.save.v2';
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
      version: 2,
      seed: game.seed,
      vow: game.vow,
      turn: game.turn,
      stats: game.stats,
      // Neither of these is in the floor seed, so neither survives without
      // being written down: which chests are already empty, and where the
      // last death left what you were carrying.
      opened: [...game.opened],
      corpse: game.corpse,
      elapsed: (game.elapsedBefore ?? 0) + (Date.now() - game.startedAt),
      player: {
        name: p.name, x: p.x, y: p.y, depth: p.depth, maxDepth: p.maxDepth,
        hp: p.hp, stamina: p.stamina, staminaMax: p.staminaMax,
        facing: p.facing, sprite: p.sprite,
        // hpMax and damage reduction are not stored: they are read off the
        // armour, and storing a derived value is how a save and a rules change
        // quietly start disagreeing.
        equip: p.equip, pack: p.pack, prep: p.prep, charges: p.charges,
        unbanked: p.unbanked, souls: p.souls, ranks: p.ranks,
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
    hp: d.player.hp,
    stamina: d.player.stamina, staminaMax: d.player.staminaMax,
    facing: d.player.facing,
    sprite: d.player.sprite, skills: d.player.skills,
    equip: { ...p.equip, ...(d.player.equip ?? {}) },
    pack: d.player.pack ?? [],
    unbanked: d.player.unbanked ?? [],
    souls: d.player.souls ?? 0,
    ranks: d.player.ranks ?? {},
    prep: { ...p.prep, ...(d.player.prep ?? {}) },
    charges: d.player.charges ?? {},
    deaths: d.player.deaths, kills: d.player.kills, turns: d.player.turns,
    bonfire: d.player.bonfire,
  });
  p.hp = Math.min(p.hp, p.hpMax);
  game.player = p;
  // Ranks change derived numbers (stamina max), so re-apply them after loading
  // rather than storing what they produced.
  for (const t of TRACKS) t.apply(p, p.ranks[t.key] ?? 0);
  p.stamina = Math.min(p.stamina, p.staminaMax);
  game.opened = new Set(d.opened ?? []);
  game.corpse = d.corpse ?? null;

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
