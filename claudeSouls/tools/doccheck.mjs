// Does the design document still describe this game?
//
// The honest fix for a problem that has now happened three times. "Keep the
// docs updated" is not a practice, it is a wish - and the one piece of
// documentation in this repository that has never gone stale is the splash
// line, because it is `${DUNGEON_DEPTH} 層 · ${ENEMIES.length} 種敵人`,
// generated from the data it describes.
//
// Prose cannot be generated, but the numbers inside it can be checked. So this
// reads the headline counts out of the live modules and asserts the document
// says them. It cannot tell whether a paragraph still describes the system
// truthfully; it can tell you that eleven enemies became twelve and nobody
// noticed, which is how the drift always starts.
//
//   node tools/doccheck.mjs

import { readFileSync } from 'node:fs';
import { SKILLS } from '../js/data/skills.js';
import { ITEMS, CONSUMABLES } from '../js/data/items.js';
import { ENEMIES } from '../js/data/enemies.js';
import { DUNGEON_DEPTH, MAX_STRAIT } from '../js/map/mapgen.js';
import { TRACKS } from '../js/data/souls.js';
import { AFFIXES } from '../js/data/affixes.js';

const doc = readFileSync(new URL('../docs/DESIGN.md', import.meta.url), 'utf8');

const weapons = ITEMS.filter((i) => i.kind === 'weapon').length;
const shields = ITEMS.filter((i) => i.kind === 'shield').length;
const armour = ITEMS.filter((i) => i.kind === 'armour').length;

let combos = 0, reaim = 0, silent = 0;
for (const spec of ENEMIES) {
  for (const a of spec.attacks) {
    if (a.windup === 0) silent++;
    if (a.next) { combos++; if (a.next.reaim) reaim++; }
  }
}

/** Each entry: what the document must contain, and why it is worth pinning. */
const CLAIMS = [
  [`${DUNGEON_DEPTH} 層`, 'dungeon depth'],
  [`${ENEMIES.length} 種敵人`, 'species count'],
  [`${SKILLS.length} 個技能`, 'skill count'],
  [`${ITEMS.length} 件裝備`, 'equipment count'],
  [`${CONSUMABLES.length} 個消耗品`, 'consumable count'],
  [`${AFFIXES.length} 種詞條`, 'affixes'],
  [`${TRACKS.length} 條成長線`, 'soul tracks'],
  [`${weapons} 把武器`, 'weapons'],
  [`${shields} 面盾`, 'shields'],
  [`${armour} 件防具`, 'armour'],
  [`${combos} 招有第二段`, 'multi-stage attacks'],
  [`${reaim} 段會**重新瞄準**`, 're-aiming stages'],
  [`超過 ${MAX_STRAIT} 格無法側移`, 'corridor guarantee'],
];

const missing = CLAIMS.filter(([text]) => !doc.includes(text));

// The contract itself, which is prose but checkable: the document must not
// claim anything is unannounced while the roster agrees.
if (silent === 0 && !doc.includes('每一擊都會被宣告')) {
  missing.push(['每一擊都會被宣告', 'the telegraph contract']);
}
if (silent > 0 && doc.includes('遊戲裡沒有任何一擊是沒有預告的')) {
  missing.push([`${silent} unannounced attacks exist`, 'the document says otherwise']);
}

for (const [text, why] of CLAIMS) {
  if (doc.includes(text)) console.log(`ok    ${why.padEnd(22)} "${text}"`);
}

if (missing.length) {
  console.log('\ndocs/DESIGN.md no longer matches the game:');
  for (const [text, why] of missing) console.log(`  ${why}: expected to find "${text}"`);
  console.log('\nThe 現況 section is meant to be built from the modules, not recalled.');
  process.exit(1);
}

console.log(`\n=== docs/DESIGN.md matches the game (${CLAIMS.length} claims) ===`);
