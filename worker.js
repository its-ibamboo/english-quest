/**
 * 英文任務系統 · Worker
 *
 * 三件事：
 *   1. 一般網址 → 照舊回傳靜態檔案（index.html），使用者完全無感
 *   2. POST /t  → 收使用統計，寫入 D1
 *   3. /admin   → 後台，看每天多少人、玩哪個模式
 *
 * 隱私：只存匿名隨機 ID、模式、時間。不存 IP、不存 UA、不存任何個人資訊。
 */

const TZ_OFFSET = 8 * 60 * 60 * 1000;   // 台北時間

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- 1. 收埋點 ----------
    if (url.pathname === "/t" && request.method === "POST") {
      if (env.DB) ctx.waitUntil(record(request, env));
      return new Response(null, { status: 204 });
    }

    // ---------- 2. 後台 ----------
    if (url.pathname === "/admin") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname === "/admin/data") {
      if (!env.DB) {
        return json({ error: "尚未綁定 D1。到 Settings → Bindings 新增 D1 database，變數名稱填 DB。" });
      }
      return json(await stats(env));
    }

    // ---------- 3. 其他全部照舊 ----------
    return env.ASSETS.fetch(request);
  }
};

/* ------------------------------------------------------------------ */

async function record(request, env) {
  try {
    const b = await request.json();
    if (!b || typeof b.aid !== "string" || typeof b.ev !== "string") return;

    // 只接受預期的值，其他一律丟掉
    const aid = b.aid.slice(0, 32);
    const ev = b.ev === "open" || b.ev === "mode" ? b.ev : null;
    if (!ev) return;

    const ALLOWED = ["flash", "quiz", "grammar", "scramble", "adventure", "badges", "bee"];
    const mode = b.mode && ALLOWED.indexOf(b.mode) >= 0 ? b.mode : null;

    const ts = Date.now();
    const day = new Date(ts + TZ_OFFSET).toISOString().slice(0, 10);

    await env.DB.prepare(
      "INSERT INTO events (ts, day, aid, ev, mode) VALUES (?, ?, ?, ?, ?)"
    ).bind(ts, day, aid, ev, mode).run();
  } catch (e) {
    // 靜默：統計壞掉絕對不能影響使用者
  }
}

async function stats(env) {
  const daily = await env.DB.prepare(
    `SELECT day,
            COUNT(DISTINCT aid) AS people,
            SUM(CASE WHEN ev='open' THEN 1 ELSE 0 END) AS opens
       FROM events
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30`
  ).all();

  const modes = await env.DB.prepare(
    `SELECT mode,
            COUNT(*) AS hits,
            COUNT(DISTINCT aid) AS people
       FROM events
      WHERE ev='mode' AND mode IS NOT NULL
      GROUP BY mode
      ORDER BY hits DESC`
  ).all();

  const modes7 = await env.DB.prepare(
    `SELECT mode,
            COUNT(*) AS hits,
            COUNT(DISTINCT aid) AS people
       FROM events
      WHERE ev='mode' AND mode IS NOT NULL
        AND day >= date('now','+8 hours','-7 days')
      GROUP BY mode
      ORDER BY hits DESC`
  ).all();

  const retention = await env.DB.prepare(
    `SELECT visits, COUNT(*) AS people FROM (
       SELECT aid, COUNT(DISTINCT day) AS visits
         FROM events
        GROUP BY aid
     ) GROUP BY visits ORDER BY visits`
  ).all();

  const total = await env.DB.prepare(
    `SELECT COUNT(DISTINCT aid) AS people, COUNT(*) AS rows FROM events`
  ).first();

  return {
    daily: daily.results || [],
    modes: modes.results || [],
    modes7: modes7.results || [],
    retention: retention.results || [],
    total: total || {}
  };
}

function json(o) {
  return new Response(JSON.stringify(o), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

/* ------------------------------------------------------------------ */

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>英文任務系統 · 後台</title>
<style>
:root{--bg:#141613;--card:#1E211D;--line:#2E322C;--ink:#E8EAE4;--dim:#8B9086;--go:#6FBF9A;--hot:#D9A441}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Noto Sans TC",system-ui,sans-serif;padding:18px 14px 60px}
main{max-width:640px;margin:0 auto}
h1{font-size:19px;font-weight:600;margin:0 0 3px}
.sub{color:var(--dim);font-size:13px;margin:0 0 22px}
h2{font-size:12px;letter-spacing:.16em;color:var(--dim);font-weight:500;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.big{display:flex;gap:10px;margin-bottom:4px}
.kpi{flex:1;background:var(--card);border:1px solid var(--line);border-radius:3px;padding:12px 13px}
.kpi b{display:block;font-size:26px;font-weight:600;line-height:1.2;font-family:Georgia,serif}
.kpi span{font-size:12px;color:var(--dim)}
.row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.row .nm{width:88px;flex:0 0 auto;font-size:14px}
.row .tr{flex:1;height:20px;background:var(--card);border:1px solid var(--line);position:relative;overflow:hidden}
.row .fl{height:100%;background:var(--go)}
.row .fl.top{background:var(--hot)}
.row .vl{width:96px;flex:0 0 auto;text-align:right;font-size:12.5px;color:var(--dim);font-family:Georgia,serif}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:7px 4px;border-bottom:1px solid var(--line);text-align:right}
th:first-child,td:first-child{text-align:left}
th{color:var(--dim);font-weight:500;font-size:12px}
td.n{font-family:Georgia,serif}
.note{color:var(--dim);font-size:12.5px;line-height:1.8;margin-top:26px;padding-top:12px;border-top:1px solid var(--line)}
.load{color:var(--dim);padding:40px 0;text-align:center}
</style></head><body><main>
<h1>英文任務系統</h1>
<p class="sub">使用統計 · 匿名，不含任何個人資訊</p>
<div id="app" class="load">載入中…</div>
<p class="note">匿名 ID 存在使用者裝置上，清除瀏覽器資料就會產生新的，所以人數是估計值、略為高估。<br>
「玩了幾天」只算有實際開啟的日子。</p>
</main>
<script>
var LABEL={flash:"閃卡",quiz:"單字測驗",grammar:"文法",scramble:"重組句子",adventure:"闖關地圖",badges:"徽章",bee:"拼字小蜜蜂"};
fetch("/admin/data").then(function(r){return r.json()}).then(function(d){
  if(d.error){document.getElementById("app").className="";document.getElementById("app").textContent=d.error;return;}
  var h="";
  var today=d.daily[0]||{};
  h+='<div class="big">'
    +'<div class="kpi"><b>'+(today.people||0)+'</b><span>今天不重複人數</span></div>'
    +'<div class="kpi"><b>'+(today.opens||0)+'</b><span>今天開啟次數</span></div>'
    +'<div class="kpi"><b>'+(d.total.people||0)+'</b><span>累計人數</span></div>'
    +'</div>';

  h+='<h2>最近七天 · 各模式</h2>';
  h+=bars(d.modes7);

  h+='<h2>累計 · 各模式</h2>';
  h+=bars(d.modes);

  h+='<h2>每日</h2><table><tr><th>日期</th><th>人數</th><th>開啟</th></tr>';
  d.daily.forEach(function(r){
    h+='<tr><td>'+r.day+'</td><td class="n">'+r.people+'</td><td class="n">'+r.opens+'</td></tr>';
  });
  h+='</table>';

  h+='<h2>回訪 · 玩了幾天</h2><table><tr><th>天數</th><th>人數</th></tr>';
  d.retention.forEach(function(r){
    h+='<tr><td>'+r.visits+' 天</td><td class="n">'+r.people+'</td></tr>';
  });
  h+='</table>';

  document.getElementById("app").className="";
  document.getElementById("app").innerHTML=h;
}).catch(function(){
  document.getElementById("app").textContent="讀取失敗，稍後再試。";
});

function bars(rows){
  if(!rows.length) return '<p class="sub">還沒有資料。</p>';
  var max=Math.max.apply(null,rows.map(function(r){return r.hits}));
  return rows.map(function(r,i){
    var w=Math.round(r.hits/max*100);
    return '<div class="row"><span class="nm">'+(LABEL[r.mode]||r.mode)+'</span>'
      +'<span class="tr"><span class="fl'+(i===0?" top":"")+'" style="width:'+w+'%"></span></span>'
      +'<span class="vl">'+r.hits+' 次 / '+r.people+' 人</span></div>';
  }).join("");
}
</script>
</body></html>`;
