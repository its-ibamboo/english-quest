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

const BUILD = "v2026.09.03e";            // 跟 index.html 的版本號一起往上帶
const TZ_OFFSET = 8 * 60 * 60 * 1000;   // 台北時間

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- 1. 收埋點 ----------
    if (url.pathname === "/t") {
      if (env.DB) {
        if (request.method === "POST") {
          ctx.waitUntil(record(request, env));
        } else {
          ctx.waitUntil(save(env, url.searchParams.get("aid"),
                                 url.searchParams.get("ev"),
                                 url.searchParams.get("mode")));
        }
      }
      // 回傳 1x1 透明 GIF，讓 <img> 正常收尾
      return new Response(GIF, {
        headers: {
          "Content-Type": "image/gif",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    }

    // ---------- 1.2 複製偵測 ----------
    // 只有當這份 index.html 被架在「不是官方網址」的地方時，前端才會打這支。
    // 不收任何使用者資料，只收網域名稱。
    if (url.pathname === "/h") {
      if (env.DB) ctx.waitUntil(saveHost(env, url.searchParams.get("host")));
      return new Response(GIF, {
        headers: {
          "Content-Type": "image/gif",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    }

    // ---------- 1.5 診斷頁 ----------
    if (url.pathname === "/ping") {
      const out = [];
      out.push("Worker 版本：" + BUILD);
      out.push("D1 綁定：" + (env.DB ? "正常" : "沒有綁到（binding 名稱要叫 DB）"));

      if (env.DB) {
        try {
          const d = await env.DB.prepare(
            "DELETE FROM events WHERE aid = 'a-pingtest'"
          ).run();
          out.push("已清除先前的測試假資料");
        } catch (e) {
          out.push("清除測試資料失敗 → " + e.message);
        }
        try {
          const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first();
          out.push("目前資料筆數：" + r.n);
        } catch (e) {
          out.push("讀取失敗 → " + e.message);
        }
      }

      try {
        const a = await env.ASSETS.fetch(new URL("/index.html", request.url));
        const html = await a.text();
        out.push("index.html 大小：" + Math.round(html.length / 1024) + " KB");
        const m = html.match(/var BUILD = "([^"]+)"/);
        out.push("index.html 版本：" + (m ? m[1] : "找不到版本號（部署的是舊版）"));
        out.push("版本是否一致：" + (m && m[1] === BUILD ? "一致" : "不一致！兩個檔案要一起更新"));
        out.push("埋點程式碼：" + (html.indexOf("ibq_aid") >= 0 ? "有，已部署" : "沒有！部署的是舊版 index.html"));
        out.push("複製偵測：" + (html.indexOf("/h?host=") >= 0 ? "有，已部署" : "沒有！部署的是舊版 index.html"));
      } catch (e) {
        out.push("讀不到 index.html → " + e.message);
      }

      out.push("");
      out.push("看完請開 /admin 確認筆數有沒有增加。");
      out.push("確認完成後這個 /ping 頁面就可以移除了。");

      return new Response(out.join("\n"), {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
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

const GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  function (c) { return c.charCodeAt(0); }
);

async function record(request, env) {
  try {
    const b = await request.json();
    await save(env, b && b.aid, b && b.ev, b && b.mode);
  } catch (e) { /* 靜默 */ }
}

async function save(env, rawAid, rawEv, rawMode) {
  try {
    if (typeof rawAid !== "string" || typeof rawEv !== "string") return;

    // 只接受預期的值，其他一律丟掉
    const aid = rawAid.slice(0, 32);
    const ev = rawEv === "open" || rawEv === "mode" ? rawEv : null;
    if (!ev) return;

    const ALLOWED = ["home", "flash", "quiz", "grammar", "scramble", "adventure", "badges", "bee"];
    const mode = rawMode && ALLOWED.indexOf(rawMode) >= 0 ? rawMode : null;

    const ts = Date.now();
    const day = new Date(ts + TZ_OFFSET).toISOString().slice(0, 10);

    await env.DB.prepare(
      "INSERT INTO events (ts, day, aid, ev, mode) VALUES (?, ?, ?, ?, ?)"
    ).bind(ts, day, aid, ev, mode).run();
  } catch (e) {
    // 靜默：統計壞掉絕對不能影響使用者
  }
}

// 只留網域名稱，一個網域一列，不會無限長大。
const OWN_HOSTS = ["english-quest.boll090292.workers.dev"];

async function saveHost(env, rawHost) {
  try {
    if (typeof rawHost !== "string") return;
    const host = rawHost.trim().toLowerCase().slice(0, 120);
    // 只接受長得像網域的字串，擋掉亂送的垃圾
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return;
    if (OWN_HOSTS.indexOf(host) >= 0) return;
    if (host === "localhost" || host.indexOf("127.0.0.1") === 0) return;

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS copies (
         host TEXT PRIMARY KEY,
         first_seen INTEGER NOT NULL,
         last_seen INTEGER NOT NULL,
         hits INTEGER NOT NULL)`
    ).run();

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO copies (host, first_seen, last_seen, hits) VALUES (?, ?, ?, 1)
       ON CONFLICT(host) DO UPDATE SET last_seen = ?, hits = hits + 1`
    ).bind(host, now, now, now).run();
  } catch (e) {
    // 靜默：偵測壞掉不能影響任何人
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

  // 被複製到別的網域的紀錄。表可能還不存在，查不到就當作空的。
  let copies = [];
  try {
    const c = await env.DB.prepare(
      `SELECT host, first_seen, last_seen, hits FROM copies ORDER BY last_seen DESC LIMIT 50`
    ).all();
    copies = c.results || [];
  } catch (e) { copies = []; }

  return {
    daily: daily.results || [],
    modes: modes.results || [],
    modes7: modes7.results || [],
    retention: retention.results || [],
    copies: copies,
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
details{margin-top:8px;}
summary{font-size:12px;color:#9aa;cursor:pointer;padding:6px 0;}
th,td{padding:7px 4px;border-bottom:1px solid var(--line);text-align:right}
th:first-child,td:first-child{text-align:left}
th{color:var(--dim);font-weight:500;font-size:12px}
td.n{font-family:Georgia,serif}
.note{color:var(--dim);font-size:12.5px;line-height:1.8;margin-top:26px;padding-top:12px;border-top:1px solid var(--line)}
.load{color:var(--dim);padding:40px 0;text-align:center}
</style></head><body><main>
<h1>英文任務系統</h1>
<p class="sub">使用統計 · 匿名，不含任何個人資訊 · <span id="build">${BUILD}</span></p>
<div id="app" class="load">載入中…</div>
<p class="note">匿名 ID 存在使用者裝置上，清除瀏覽器資料就會產生新的，所以人數是估計值、略為高估。<br>
「玩了幾天」只算有實際開啟的日子。</p>
</main>
<script>
var LABEL={home:"主頁",flash:"閃卡",quiz:"單字測驗",grammar:"文法",scramble:"重組句子",adventure:"闖關地圖",badges:"徽章",bee:"拼字小蜜蜂"};
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

  var HEAD='<tr><th>日期</th><th>人數</th><th>開啟</th></tr>';
  function dayRow(r){
    return '<tr><td>'+r.day+'</td><td class="n">'+r.people+'</td><td class="n">'+r.opens+'</td></tr>';
  }
  h+='<h2>每日 \u00B7 最近 14 天</h2><table>'+HEAD;
  d.daily.slice(0,14).forEach(function(r){ h+=dayRow(r); });
  h+='</table>';
  if(d.daily.length>14){
    h+='<details><summary>更早的 '+(d.daily.length-14)+' 天</summary><table>'+HEAD;
    d.daily.slice(14).forEach(function(r){ h+=dayRow(r); });
    h+='</table></details>';
  }

  if(d.copies&&d.copies.length){
    h+='<h2>\u26A0\uFE0F 偵測到的複製網域</h2><table><tr><th>網域</th><th>開啟</th><th>最後一次</th></tr>';
    d.copies.forEach(function(r){
      h+='<tr><td>'+r.host+'</td><td class="n">'+r.hits+'</td><td class="n">'+new Date(r.last_seen).toISOString().slice(0,10)+'</td></tr>';
    });
    h+='</table>';
  }

  h+='<h2>回訪 \u00B7 玩了幾天</h2><table><tr><th>天數</th><th>人數</th></tr>';
  var BUCKETS=[
    {label:'只來過 1 天', lo:1,  hi:1},
    {label:'2\u20133 天',   lo:2,  hi:3},
    {label:'4\u20137 天',   lo:4,  hi:7},
    {label:'8\u201314 天',  lo:8,  hi:14},
    {label:'15 天以上',   lo:15, hi:1e9}
  ];
  var totalPeople=0;
  d.retention.forEach(function(r){ totalPeople+=r.people; });
  BUCKETS.forEach(function(bk){
    var n=0;
    d.retention.forEach(function(r){ if(r.visits>=bk.lo&&r.visits<=bk.hi) n+=r.people; });
    var pct=totalPeople?Math.round(n*100/totalPeople):0;
    h+='<tr><td>'+bk.label+'</td><td class="n">'+n+(n?' \u00B7 '+pct+'%':'')+'</td></tr>';
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
