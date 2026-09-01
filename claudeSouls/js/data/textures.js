// The surfaces the interface can wear.
//
// Kept as data rather than as a list inside the settings screen so that adding
// one means writing a CSS class and one line here, and so the tests can check
// that every name offered actually exists.

export const TEXTURES = [
  { key: 'none',   name: '無',   hint: '完全平的面板,和加這個系統之前一模一樣' },
  { key: 'grain',  name: '顆粒', hint: '極細的底噪。拿掉大面板的死板,但眼睛抓不到圖案' },
  { key: 'weave',  name: '織紋', hint: '6px 的交叉織理,像粗布' },
  { key: 'slate',  name: '板岩', hint: '大塊柔和的明暗,看不出重複——適合方形地圖旁邊的大片留白' },
  { key: 'carved', name: '鑿痕', hint: '斜向的淺刻。唯一有方向性的,也最容易過頭' },
  { key: 'ash',    name: '灰燼', hint: '疏落的斑點,兩種不同週期疊在一起' },
];

export const TEXTURE_KEYS = TEXTURES.map((t) => t.key);
