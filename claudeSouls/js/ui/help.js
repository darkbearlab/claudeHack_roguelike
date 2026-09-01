// In-game help.
//
// Written in Chinese first because that is what the person this was built for
// reads, with the key bindings in a table that works in either language.

export const HELP_HTML = `
<h3>這個遊戲怎麼玩</h3>
<p><b>你不能硬扛傷害。</b> 三到五下就會死,而且攻擊<b>必中</b>——沒有閃避率、沒有骰子。
活下來的唯一方法是<b>不要站在會被打到的格子上</b>。</p>

<h3>讀招</h3>
<p>敵人出手前會先<b>舉手</b>。這時候會發生三件事,全部畫在畫面上:</p>
<ul>
<li>牠頭上出現 <b style="color:#ff5a44">!</b>,旁邊的短橫是<b>還有幾回合會打下來</b></li>
<li>牠<b>即將打到的格子會變紅</b>,越接近越亮</li>
<li>牠<b>轉向</b>你——貼圖的朝向就是攻擊的方向</li>
</ul>
<p>看到之後你有兩個選擇,而且兩個都要花精力:</p>
<ul>
<li><b>翻滾走開</b>(離開紅色格子)</li>
<li><b>打斷牠</b>——在牠蓄力的時候打中,攻擊會<b>延後一回合</b></li>
</ul>
<p>牠打完之後會有<b>收招硬直</b>(頭上出現 <b style="color:#8fd48f">·</b>),那是你的輸出時間。
精力用光的敵人會停下來喘氣(<b style="color:#8fd48f">~</b>),那也是。</p>

<h3>精力就是一切</h3>
<p>攻擊和翻滾<b>吃同一條精力</b>,每回合只回一點點——<b>剛好不夠一次翻滾</b>。
所以每一回合的問題都是同一個:<b>再貪一刀,還是留著閃?</b></p>
<p>精力條上那條淡淡的直線是<b>一次翻滾的花費</b>。低於它就不要再攻擊了。</p>

<h3>翻滾不會推進回合</h3>
<p>這是全遊戲最重要的規則。<b>翻滾只花精力,不花時間</b>——你可以在同一個回合裡滾兩次、
再攻擊。走路會推進回合,翻滾不會。</p>
<p>所以真正的時鐘是精力,不是回合數。</p>

<h3>怎麼操作</h3>
<p><b>手機:</b>按住下面的技能鈕,<b>往你的角色外面拖</b>,預覽會跟著手指跑,<b>放開就發動</b>。
中途改變主意就把手指<b>拖回下面的控制列再放開</b>,那是取消。</p>
<p>也可以先<b>點一下</b>技能(不拖),然後再在地圖上按住拖曳、放開。兩種都行。</p>
<p><b>鍵盤:</b><code>1</code>~<code>5</code> 選技能,再按方向鍵發動。
移動走進敵人就是普通攻擊。<code>Shift</code>+方向 = 直接翻滾。</p>

<h3>篝火</h3>
<p>踩到篝火按 <code>e</code> 休息:<b>回滿血和精力、冷卻歸零</b>,但<b>整層的敵人會全部復活</b>。
死掉會回到最後坐過的篝火,一樣全部復活。</p>
<p><b>樓層是固定的。</b> 同一層永遠長一樣、敵人永遠在同一個位置——死幾次之後你會記住它,
而那就是這個遊戲的成長。</p>

<h3>可以跑</h3>
<p>不是每隻敵人都追得上你。<b>殭屍很慢、獵犬很快</b>——繞過去是正當戰術,
從篝火走回死掉的地方通常不需要重打整層。</p>

<h3>會飛的攻擊</h3>
<p>弓箭是<b>場上的物件</b>,不是瞬間的傷害。它每回合飛幾格,你有時間閃開——
而且<b>它會打到擋在路上的任何東西,包括其他敵人。</b></p>

<h3>按鍵</h3>
<table>
<tr><td class="key">hjkl / yubn / 方向鍵</td><td>移動;走進敵人 = 攻擊</td></tr>
<tr><td class="key">Shift + 方向</td><td>朝那個方向翻滾</td></tr>
<tr><td class="key">1 2 3 4 5</td><td>選技能,再按方向</td></tr>
<tr><td class="key">.</td><td>等一回合(回精力)</td></tr>
<tr><td class="key">e</td><td>在篝火休息</td></tr>
<tr><td class="key">&gt; &lt;</td><td>下樓 / 上樓</td></tr>
<tr><td class="key">:</td><td>看看附近有什麼</td></tr>
<tr><td class="key">Ctrl-P</td><td>訊息記錄</td></tr>
<tr><td class="key">S</td><td>存檔</td></tr>
<tr><td class="key">Esc</td><td>取消瞄準</td></tr>
</table>

<h3>Quick English</h3>
<p>You die in 3–5 hits and attacks never miss, so survival is positional.
Enemies telegraph: a <b>!</b>, red tiles, and they turn to face you. Roll out of
the red tiles, or hit them mid-wind-up to delay the blow. <b>Rolling costs
stamina but does not advance the turn</b> — stamina, not turns, is the clock.
Rest at a bonfire to heal; everything respawns. Floors are generated from the
run seed, so a floor you have died on is a floor you have learned.</p>
`;
