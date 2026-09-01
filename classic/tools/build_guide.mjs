// Generate docs/GUIDE.zh-TW.md from js/ui/guide-zh.js.
//
//   node tools/build_guide.mjs           write the file
//   node tools/build_guide.mjs --check   fail if it is out of date (CI)
//
// The guide has to exist in two places - inside the game, and as a document in
// the repository someone can read on GitHub. Writing it twice guarantees the
// two versions drift, and the drift is invisible until someone notices the
// in-game manual disagrees with the README. So it is authored once as data and
// rendered twice.
//
// The inline markup in the source (**bold** and `code`) is deliberately chosen
// to be valid Markdown already, so this renderer only has to handle block
// structure.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { GUIDE_ZH, GUIDE_ZH_TITLE, GUIDE_ZH_INTRO } from '../js/ui/guide-zh.js';

const OUT = new URL('../docs/GUIDE.zh-TW.md', import.meta.url);

/** GitHub's heading-anchor rules, near enough for CJK plus digits. */
function anchor(title) {
  return title
    .toLowerCase()
    .replace(/[^\w一-鿿\- ]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

function block(b) {
  if (b.h) return `### ${b.h}\n`;
  if (b.p) return `${b.p}\n`;
  if (b.note) return `> ${b.note}\n`;
  if (b.ul) return b.ul.map((i) => `- ${i}`).join('\n') + '\n';
  if (b.ol) return b.ol.map((i, n) => `${n + 1}. ${i}`).join('\n') + '\n';
  if (b.table) {
    const { head, rows } = b.table;
    return [
      `| ${head.map(cell).join(' | ')} |`,
      `| ${head.map(() => '---').join(' | ')} |`,
      ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    ].join('\n') + '\n';
  }
  return '';
}

function render() {
  const out = [];
  out.push(`# ${GUIDE_ZH_TITLE}\n`);
  out.push(
    '<!-- 這個檔案是產生出來的,不要直接編輯。內容的來源是 classic/js/ui/guide-zh.js,' +
    '改完之後在 classic/ 底下執行 node tools/build_guide.mjs。 -->\n'
  );
  out.push(
    '<!-- Generated from classic/js/ui/guide-zh.js by classic/tools/build_guide.mjs. ' +
    'Do not edit by hand. -->\n'
  );
  out.push(`${GUIDE_ZH_INTRO}\n`);
  out.push('遊戲中隨時按 `?` 也可以叫出同一份說明。\n');

  out.push('## 目錄\n');
  out.push(GUIDE_ZH.map((s) => `- [${s.title}](#${anchor(s.title)})`).join('\n') + '\n');

  for (const s of GUIDE_ZH) {
    out.push(`## ${s.title}\n`);
    for (const b of s.body) out.push(block(b));
  }

  out.push('---\n');
  out.push(
    '這份指南和遊戲內的說明面板是同一份來源(`classic/js/ui/guide-zh.js`),' +
    '由 `classic/tools/build_guide.mjs` 產生,所以兩邊永遠一致。\n'
  );
  return out.join('\n');
}

const text = render();

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current.replace(/\r\n/g, '\n') !== text) {
    console.error('docs/GUIDE.zh-TW.md is out of date; run: node tools/build_guide.mjs');
    process.exit(1);
  }
  console.log('docs/GUIDE.zh-TW.md is up to date');
} else {
  writeFileSync(OUT, text, 'utf8');
  const sections = GUIDE_ZH.length;
  const words = text.length;
  console.log(`wrote docs/GUIDE.zh-TW.md  (${sections} sections, ${words} characters)`);
}
