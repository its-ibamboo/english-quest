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

const BUILD = "v2026.09.03n";            // 跟 index.html 的版本號一起往上帶
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

    // ---------- 1.3 單字答錯率 ----------
    // 前端在瀏覽器裡累積，切換模式或離開頁面時整批送一次。
    // 不是每答一題打一次 —— 那會是現在請求量的幾十倍。
    if (url.pathname === "/w") {
      if (env.DB) ctx.waitUntil(saveWords(env, url.searchParams.get("d")));
      return new Response(GIF, {
        headers: {
          "Content-Type": "image/gif",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    }

    // ---------- 1.4 每日挑戰 ----------
    // 帶 score 就記一筆並回傳分佈，不帶就只查詢。
    // 一個裝置一天只計一次；重玩不會再累加。
    if (url.pathname === "/d") {
      if (!env.DB) return json({ error: "no db" });
      return json(await dailyChallenge(
        env,
        url.searchParams.get("day"),
        url.searchParams.get("score"),
        url.searchParams.get("aid")
      ));
    }

    // ---------- 1.6 問題回報 ----------
    // 公開端點，任何人都能打，所以：限流（同 IP 一分鐘 3 次）+ 限大小（200KB）
    if (url.pathname === "/report" && request.method === "POST") {
      if (!env.DB) return new Response("no db", { status: 503 });
      const cl = Number(request.headers.get("content-length") || 0);
      if (cl > 200000) return new Response("too big", { status: 413 });
      const ip = request.headers.get("cf-connecting-ip") || "?";
      if (!reportGate(ip)) return new Response("slow down", { status: 429 });
      const body = await request.text();
      if (body.length > 200000) return new Response("too big", { status: 413 });
      try {
        await addReport(env, JSON.parse(body));
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }

    // 檢視與刪除。這裡面是使用者打的字和他手機的截圖，
    // 絕對不能像 /admin 那樣公開，所以另外上鎖。
    // 密碼優先用 Cloudflare 環境變數 ADMIN_KEY，沒設才退回程式裡的預設值。
    if (url.pathname === "/reports/login" && request.method === "POST") {
      const pw = (await request.formData()).get("pw") || "";
      const want = env.ADMIN_KEY || REPORTS_PW;
      if (String(pw) !== want) {
        return new Response(loginPage("密碼不對"), {
          status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(null, { status: 302, headers: {
        "location": "/reports",
        "set-cookie": "rp=" + encodeURIComponent(want) +
          "; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax"
      }});
    }

    if (url.pathname === "/reports" || url.pathname === "/reports/del") {
      const want = env.ADMIN_KEY || REPORTS_PW;
      const ck = (request.headers.get("cookie") || "")
        .split(";").map(function (x) { return x.trim(); })
        .find(function (x) { return x.indexOf("rp=") === 0; });
      const fromCookie = ck ? decodeURIComponent(ck.slice(3)) : "";
      const k = url.searchParams.get("k") || fromCookie;
      if (!want || k !== want) {
        return new Response(loginPage(""), {
          status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (!env.DB) return new Response("no db", { status: 503 });
      if (url.pathname === "/reports/del") {
        await delReport(env, url.searchParams.get("id") || "");
        return Response.redirect(url.origin + "/reports", 302);
      }
      return new Response(reportsPage(await listReports(env)), {
        headers: { "content-type": "text/html; charset=utf-8" } });
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
        out.push("複製偵測：" + (html.indexOf("var REPORT = ") >= 0 ? "有，已部署" : "沒有！部署的是舊版 index.html"));
        out.push("每日挑戰：" + (html.indexOf("var CHAL_KEY") >= 0 ? "有，已部署" : "沒有！部署的是舊版 index.html"));
        out.push("答錯率追蹤：" + (html.indexOf("var WSTAT") >= 0 ? "有，已部署" : "沒有！部署的是舊版 index.html"));
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
    const ev = (rawEv === "open" || rawEv === "mode" || rawEv === "diff") ? rawEv : null;
    if (!ev) return;

    // 模式與難度共用 mode 欄位。既有查詢都有 WHERE ev='mode'，
    // 所以難度事件不會污染任何現有的數字。
    const ALLOWED = ["home", "flash", "quiz", "grammar", "scramble", "adventure", "badges", "bee"];
    const DIFFS = ["basic", "advanced", "hell", "all"];
    const list = ev === "diff" ? DIFFS : ALLOWED;
    const mode = rawMode && list.indexOf(rawMode) >= 0 ? rawMode : null;
    if (ev === "diff" && !mode) return;

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

// 單字統計。格式：word*shown*wrong~word*shown*wrong~...
// 只接受長得像英文單字的字串；新單字在表已經很大時不再新增，避免被灌爆。
const WORD_RE = /^[a-zA-Z][a-zA-Z '.\\-]{0,29}$/;
const WORD_TABLE_CAP = 3000;

async function saveWords(env, raw) {
  try {
    if (typeof raw !== "string" || !raw) return;

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS word_stats (
         en TEXT PRIMARY KEY,
         shown INTEGER NOT NULL DEFAULT 0,
         wrong INTEGER NOT NULL DEFAULT 0)`
    ).run();

    const parts = raw.split("~").slice(0, 120);
    const rows = [];
    for (const p of parts) {
      const f = p.split("*");
      if (f.length !== 3) continue;
      const en = f[0].trim();
      const shown = parseInt(f[1], 10);
      const wrong = parseInt(f[2], 10);
      if (!WORD_RE.test(en)) continue;
      if (!(shown >= 1 && shown <= 200)) continue;
      if (!(wrong >= 0 && wrong <= shown)) continue;
      rows.push([en, shown, wrong]);
    }
    if (!rows.length) return;

    // 表已經夠大時就不再收新單字，只更新既有的，避免有人塞垃圾把表灌爆
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM word_stats").first();
    const full = c && c.n >= WORD_TABLE_CAP;

    const sql = full
      ? "UPDATE word_stats SET shown = shown + ?2, wrong = wrong + ?3 WHERE en = ?1"
      : `INSERT INTO word_stats (en, shown, wrong) VALUES (?1, ?2, ?3)
         ON CONFLICT(en) DO UPDATE SET shown = shown + ?2, wrong = wrong + ?3`;

    await env.DB.batch(rows.map(function (r) {
      return env.DB.prepare(sql).bind(r[0], r[1], r[2]);
    }));
  } catch (e) {
    // 靜默：統計壞掉絕對不能影響使用者
  }
}

// 每日挑戰。一天一列，一年 365 列，不會長大。
// s0..s10 存各分數的人數，才能算出「你贏過幾 %」，只有平均分是不夠的。
async function dailyChallenge(env, day, rawScore, aid) {
  const today = new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10);
  if (day !== today) day = today;   // 只接受今天，避免有人回頭灌舊資料

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS daily_challenge (
       day TEXT PRIMARY KEY, plays INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
       s0 INTEGER DEFAULT 0, s1 INTEGER DEFAULT 0, s2 INTEGER DEFAULT 0, s3 INTEGER DEFAULT 0,
       s4 INTEGER DEFAULT 0, s5 INTEGER DEFAULT 0, s6 INTEGER DEFAULT 0, s7 INTEGER DEFAULT 0,
       s8 INTEGER DEFAULT 0, s9 INTEGER DEFAULT 0, s10 INTEGER DEFAULT 0)`
  ).run();

  let rank = null;
  const score = parseInt(rawScore, 10);
  if (rawScore !== null && score >= 0 && score <= 10) {
    // 一人一天一次。dedupe 表只留最近 30 天，不會無限成長。
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS daily_plays (day TEXT, aid TEXT, PRIMARY KEY (day, aid))`
    ).run();
    const who = (typeof aid === "string" && /^[a-z0-9-]{1,40}$/.test(aid)) ? aid : null;
    let fresh = true;
    if (who) {
      const r = await env.DB.prepare(
        "INSERT OR IGNORE INTO daily_plays (day, aid) VALUES (?, ?)"
      ).bind(day, who).run();
      fresh = !!(r && r.meta && r.meta.changes);
    }
    if (fresh) {
      await env.DB.prepare(
        `INSERT INTO daily_challenge (day, plays, total, s${score}) VALUES (?, 1, ?, 1)
         ON CONFLICT(day) DO UPDATE SET plays = plays + 1, total = total + ?, s${score} = s${score} + 1`
      ).bind(day, score, score).run();
      await env.DB.prepare("DELETE FROM daily_plays WHERE day < date(?, '-30 days')").bind(day).run();
      // 剛寫進去的這筆就是第幾個完成的。之後 plays 還會繼續長，
      // 所以名次一定要在完成的當下記下來，不能事後用 plays 當名次。
      const after = await env.DB.prepare(
        "SELECT plays FROM daily_challenge WHERE day = ?"
      ).bind(day).first();
      rank = (after && after.plays) || null;
    }
  }

  const row = await env.DB.prepare("SELECT * FROM daily_challenge WHERE day = ?").bind(day).first();
  if (!row) return { day: day, plays: 0, total: 0, rank: rank, d: new Array(11).fill(0) };
  const d = [];
  for (let i = 0; i <= 10; i++) d.push(row["s" + i] || 0);
  return { day: day, plays: row.plays || 0, total: row.total || 0, rank: rank, d: d };
}

// 問題回報。密碼沒設環境變數時用這個。
const REPORTS_PW = "1234";
const REPORT_MAX = 60;          // 最多留幾筆，滿了丟掉最舊的（圖片很佔空間）

const REPORT_HITS = new Map();
function reportGate(ip) {
  const now = Date.now();
  const arr = (REPORT_HITS.get(ip) || []).filter(function (t) { return now - t < 60000; });
  if (arr.length >= 3) return false;
  arr.push(now);
  REPORT_HITS.set(ip, arr);
  if (REPORT_HITS.size > 500) REPORT_HITS.clear();   // 不要無限長大
  return true;
}
async function ensureReports(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS reports (
       id TEXT PRIMARY KEY, t INTEGER NOT NULL,
       text TEXT, diag TEXT, img TEXT)`
  ).run();
}
async function addReport(env, body) {
  await ensureReports(env);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const img = (typeof body.img === "string" && body.img.indexOf("data:image/") === 0)
    ? body.img.slice(0, 140000) : "";
  await env.DB.prepare(
    "INSERT INTO reports (id, t, text, diag, img) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, Date.now(),
         String(body.text || "").slice(0, 500),
         String(body.diag || "").slice(0, 4000), img).run();
  // 只留最新的 REPORT_MAX 筆
  await env.DB.prepare(
    `DELETE FROM reports WHERE id NOT IN
       (SELECT id FROM reports ORDER BY t DESC LIMIT ?)`
  ).bind(REPORT_MAX).run();
  return id;
}
async function listReports(env) {
  try {
    await ensureReports(env);
    const r = await env.DB.prepare(
      "SELECT id, t, text, diag, img FROM reports ORDER BY t DESC"
    ).all();
    return r.results || [];
  } catch (e) { return []; }
}
async function delReport(env, id) {
  try {
    await ensureReports(env);
    if (id === "*") await env.DB.prepare("DELETE FROM reports").run();
    else if (id) await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id).run();
  } catch (e) {}
}
function esc(x) {
  return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function loginPage(msg) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>問題回報</title></head>
<body style="background:#141613;color:#E8EAE4;font-family:system-ui,-apple-system,'Noto Sans TC',sans-serif;padding:20px;max-width:360px;margin:0 auto">
<h1 style="font-size:19px;margin-top:40px">問題回報</h1>
${msg ? `<p style="color:#D9705E;font-size:14px">${esc(msg)}</p>` : ""}
<form method="POST" action="/reports/login">
  <input type="password" name="pw" placeholder="密碼" autocomplete="current-password"
    style="width:100%;box-sizing:border-box;padding:12px;font-size:16px;border-radius:8px;
           border:1px solid #2E322C;background:#1E211D;color:#E8EAE4;margin-top:12px">
  <button style="width:100%;margin-top:12px;padding:12px;border:none;border-radius:8px;
    background:#D9A441;color:#141613;font-size:16px;font-weight:700">登入</button>
</form>
</body></html>`;
}
function reportsPage(list) {
  const rows = list.map(function (r) {
    const when = new Date(r.t + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
    // 圖片不直接展開 —— 要點才載入，列表才不會因為十張圖變得又長又慢
    const img = r.img
      ? `<details><summary style="cursor:pointer;color:#6FBF9A">看圖片</summary>
         <img src="${esc(r.img)}" style="max-width:100%;margin-top:8px;border-radius:6px"></details>`
      : `<div style="opacity:.5">（沒有附圖）</div>`;
    return `<div style="border:1px solid #2E322C;border-radius:10px;padding:12px;margin-bottom:12px">
      <div style="font-size:12px;opacity:.6">${esc(when)}\u3000#${esc(r.id)}</div>
      <div style="font-size:16px;margin:8px 0;white-space:pre-wrap">${esc(r.text) || "（沒有寫文字）"}</div>
      ${img}
      <details style="margin-top:8px"><summary style="cursor:pointer;opacity:.7">診斷資料</summary>
        <pre style="white-space:pre-wrap;font-size:12px;opacity:.8">${esc(r.diag)}</pre></details>
      <form method="POST" action="/reports/del?id=${encodeURIComponent(r.id)}" style="margin-top:10px">
        <button style="background:#D9705E;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:14px">刪除這筆</button>
      </form>
    </div>`;
  }).join("");
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>問題回報</title></head>
<body style="background:#141613;color:#E8EAE4;font-family:system-ui,-apple-system,'Noto Sans TC',sans-serif;padding:14px;max-width:720px;margin:0 auto">
<h1 style="font-size:20px">問題回報（${list.length} 筆）</h1>
<p style="font-size:13px;opacity:.6">最多保留 ${REPORT_MAX} 筆，滿了會自動丟掉最舊的。看完記得刪，圖片很佔空間。</p>
${rows || '<p style="opacity:.6">目前沒有回報。</p>'}
${list.length ? `<form method="POST" action="/reports/del?id=*" style="margin-top:20px"
  onsubmit="return confirm('全部刪掉？不能復原。')">
  <button style="background:#7a3a30;color:#fff;border:none;border-radius:8px;padding:12px;width:100%;font-size:15px">全部刪除</button>
</form>` : ""}
</body></html>`;
}

async function stats(env) {
  // 每天的人數再拆成「第一次來」與「以前來過」。
  // 只有總人數的話，看不出成長是新客灌進來還是舊客回來，那是兩件完全不同的事。
  const daily = await env.DB.prepare(
    `SELECT e.day AS day,
            COUNT(DISTINCT e.aid) AS people,
            COUNT(DISTINCT CASE WHEN f.fd = e.day THEN e.aid END) AS fresh,
            SUM(CASE WHEN e.ev='open' THEN 1 ELSE 0 END) AS opens
       FROM events e
       JOIN (SELECT aid, MIN(day) AS fd FROM events GROUP BY aid) f
         ON f.aid = e.aid
      GROUP BY e.day
      ORDER BY e.day DESC
      LIMIT 30`
  ).all();

  // 最近七天的活躍人數。模式的滲透率要拿它當分母，
  // 不然「128 人玩過小蜜蜂」這個數字沒有比較基準。
  let active7 = 0;
  try {
    const a7 = await env.DB.prepare(
      `SELECT COUNT(DISTINCT aid) AS n FROM events
        WHERE day >= date('now','+8 hours','-7 days')`
    ).first();
    active7 = (a7 && a7.n) || 0;
  } catch (e) { active7 = 0; }

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

  // 每日挑戰的歷史
  let chal = [];
  try {
    const cq = await env.DB.prepare(
      "SELECT day, plays, total FROM daily_challenge ORDER BY day DESC LIMIT 14"
    ).all();
    chal = cq.results || [];
  } catch (e) { chal = []; }

  // 難度分佈。這是判斷使用者程度唯一不用問人的訊號。
  // 只算最近 30 天，而且「主動選過難度」的人才算 —— 進站的預設值
  // 每個人都會送一次 all，混在一起的話 all 會永遠是第一名。
  let diffs = [], diffPeople = 0;
  try {
    const dq = await env.DB.prepare(
      `SELECT mode, COUNT(DISTINCT aid) AS people, COUNT(*) AS hits
         FROM events
        WHERE ev='diff' AND mode IS NOT NULL
          AND day >= date('now','+8 hours','-30 days')
          AND aid IN (SELECT aid FROM events
                       WHERE ev='diff' AND mode IS NOT NULL AND mode <> 'all')
        GROUP BY mode
        ORDER BY people DESC`
    ).all();
    diffs = dq.results || [];
    const dp = await env.DB.prepare(
      `SELECT COUNT(DISTINCT aid) AS n FROM events
        WHERE ev='diff' AND mode IS NOT NULL AND mode <> 'all'
          AND day >= date('now','+8 hours','-30 days')`
    ).first();
    diffPeople = (dp && dp.n) || 0;
  } catch (e) { diffs = []; diffPeople = 0; }

  // 同期群回訪：只看「第一次來至少是 7 天前」的人。
  // 直接用全體算回訪率會嚴重低估 —— 每天湧入的新人還沒有機會回訪，
  // 卻全部被算進「只來過 1 天」那一桶。
  const cutoff = new Date(Date.now() + TZ_OFFSET - 7 * 86400000)
    .toISOString().slice(0, 10);
  let cohort = {};
  try {
    cohort = await env.DB.prepare(
      `SELECT COUNT(*) AS people,
              SUM(CASE WHEN days >= 2 THEN 1 ELSE 0 END) AS d2,
              SUM(CASE WHEN days >= 3 THEN 1 ELSE 0 END) AS d3,
              SUM(CASE WHEN days >= 5 THEN 1 ELSE 0 END) AS d5,
              SUM(CASE WHEN days >= 7 THEN 1 ELSE 0 END) AS d7
         FROM (SELECT aid, MIN(day) AS fd, COUNT(DISTINCT day) AS days
                 FROM events GROUP BY aid)
        WHERE fd <= ?`
    ).bind(cutoff).first() || {};
  } catch (e) { cohort = {}; }
  cohort.cutoff = cutoff;

  // 最常錯的字。門檻 100 次是必要的：只出現 3 次、錯 2 次的字
  // 答錯率是 67%，會直接壓過真正的難字。
  let hardWords = [], wordTotal = {};
  try {
    const hw = await env.DB.prepare(
      `SELECT en, shown, wrong,
              ROUND(wrong * 100.0 / shown, 1) AS pct
         FROM word_stats
        WHERE shown >= 100
        ORDER BY pct DESC, shown DESC
        LIMIT 30`
    ).all();
    hardWords = hw.results || [];
    wordTotal = await env.DB.prepare(
      `SELECT COUNT(*) AS words, SUM(shown) AS shown, SUM(wrong) AS wrong,
              SUM(CASE WHEN shown >= 100 THEN 1 ELSE 0 END) AS ready
         FROM word_stats`
    ).first() || {};
  } catch (e) { hardWords = []; wordTotal = {}; }

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
    active7: active7,
    modes: modes.results || [],
    modes7: modes7.results || [],
    retention: retention.results || [],
    chal: chal,
    diffs: diffs,
    diffPeople: diffPeople,
    cohort: cohort,
    hardWords: hardWords,
    wordTotal: wordTotal,
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
:root{--bg:#141613;--card:#1E211D;--line:#2E322C;--ink:#E8EAE4;--dim:#8B9086;--go:#6FBF9A;--hot:#D9A441;--bad:#D9705E}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Noto Sans TC",system-ui,sans-serif;padding:18px 14px 60px}
main{max-width:640px;margin:0 auto}
h1{font-size:19px;font-weight:600;margin:0 0 3px}
.sub{color:var(--dim);font-size:13px;margin:0 0 22px}
h2{font-size:12px;letter-spacing:.16em;color:var(--hot);font-weight:600;margin:30px 0 2px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.hint{color:var(--dim);font-size:12px;line-height:1.65;margin:6px 0 10px}
.cards{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 4px}
.card{flex:1 1 100px;min-width:100px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card b{display:block;font-size:24px;font-weight:600;line-height:1.25;font-family:Georgia,serif}
.card span{font-size:12px;opacity:.9}
.card em{display:block;font-style:normal;font-size:11px;color:var(--dim);margin-top:3px;line-height:1.45}
.card i{display:block;font-style:normal;font-size:11px;color:var(--dim);opacity:.75;margin-top:3px}
.row{display:flex;align-items:center;gap:9px;margin-bottom:7px}
.row .nm{width:80px;flex:0 0 auto;font-size:13.5px}
.row .tr{flex:1;height:20px;background:#191C18;border:1px solid var(--line);border-radius:3px;overflow:hidden}
.row .fl{display:block;height:100%;background:var(--go)}
.row .fl.top{background:var(--hot)}
.row .vl{width:104px;flex:0 0 auto;text-align:right;font-size:12px;color:var(--dim);font-family:Georgia,serif}
.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:4px}
th,td{padding:7px 4px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{color:var(--dim);font-weight:500;font-size:12px}
td.n{font-family:Georgia,serif}
td.hot{color:var(--hot)}
details{margin-top:8px}
summary{font-size:12px;color:var(--dim);cursor:pointer;padding:6px 0}
.note{color:var(--dim);font-size:12.5px;line-height:1.85;margin-top:30px;padding-top:12px;border-top:1px solid var(--line)}
.note b{color:var(--ink)}
.load{color:var(--dim);padding:40px 0;text-align:center}
.golink{display:block;background:var(--card);border:1px solid var(--line);border-radius:8px;
        padding:11px 13px;margin:0 0 20px;color:var(--hot);text-decoration:none;font-size:14px}
.golink span{display:block;color:var(--dim);font-size:11.5px;margin-top:2px}
</style></head><body><main>
<h1>英文任務系統</h1>
<p class="sub">使用統計 · 匿名，不含任何個人資訊 · <span id="build">${BUILD}</span></p>
<a href="/reports" class="golink">💬 問題回報　<span>使用者送出的回報與截圖 · 需要密碼</span></a>
<div id="app" class="load">載入中…</div>
</main>
<script>
var DIFF_LABEL={basic:"基礎",advanced:"進階",hell:"地獄",all:"全部"};
var LABEL={home:"主頁",flash:"閃卡",quiz:"單字測驗",grammar:"文法",scramble:"重組句子",adventure:"闖關地圖",badges:"徽章",bee:"拼字小蜜蜂"};

function nz(v){ return (v===0||v===null||v===undefined)?"—":v; }
function pct(a,b){ return b?Math.round(a*100/b)+"%":"—"; }

/* 每張卡都要有一句白話解釋。只有標籤的話，「活躍」「滲透率」這種詞
   隔三個月自己回來看也不會記得當初算的是什麼。 */
function card(v,label,why,sub){
  return '<div class="card"><b>'+v+'</b><span>'+label+'</span>'
       + (why?'<em>'+why+'</em>':'')
       + (sub?'<i>'+sub+'</i>':'')+'</div>';
}
function cmp(v){ return (v===undefined||v===null)?"":"昨天 "+v; }

fetch("/admin/data").then(function(r){return r.json()}).then(function(d){
  var app=document.getElementById("app");
  if(d.error){app.className="";app.textContent=d.error;return;}
  var h="";
  var t=d.daily[0]||{}, y=d.daily[1]||null;
  var tBack=(t.people||0)-(t.fresh||0);
  var yBack=y?((y.people||0)-(y.fresh||0)):null;

  /* --- 人 --- */
  h+='<h2>今天 · 有多少人</h2>';
  h+='<p class="hint">這一區算的是<b>人</b>：同一台裝置一天只算一次。跟下面的「次數」不能互相加減。</p>';
  h+='<div class="cards">'
    + card(nz(t.people),"活躍人數","今天有幾個人打開系統",cmp(y&&y.people))
    + card(nz(t.fresh),"新增","第一次來的人",cmp(y&&y.fresh))
    + card(nz(tBack),"回訪","以前來過、今天又來",cmp(yBack))
    + '</div>';

  /* --- 次數 --- */
  h+='<h2>今天 · 開了幾次</h2>';
  h+='<p class="hint">這一區是<b>次數</b>：一個人一天可能開很多次。</p>';
  h+='<div class="cards">'
    + card(nz(t.opens),"網頁開啟","系統被打開幾次",cmp(y&&y.opens))
    + card(t.people?(Math.round((t.opens||0)/t.people*10)/10):"—","平均每人開啟","開啟次數 ÷ 活躍人數","")
    + card(nz(d.total.people),"累計人數","從開始統計到現在的不重複裝置","")
    + '</div>';

  /* --- 模式 --- */
  h+='<h2>最近七天 · 各模式</h2>';
  h+='<p class="hint">百分比是<b>滲透率</b>：這七天的活躍者裡，有多少比例碰過這個模式（分母 '+(d.active7||0)+' 人）。</p>';
  h+=bars(d.modes7,d.active7);

  h+='<h2>累計 · 各模式</h2>';
  h+='<p class="hint">跨越多次改版，定義前後不同，只能當粗略的量級參考。</p>';
  h+=bars(d.modes,0);

  /* --- 每日 --- */
  h+='<h2>每日 · 最近 14 天</h2>';
  var HEAD='<tr><th>日期</th><th>活躍</th><th>新增</th><th>回訪</th><th>開啟</th></tr>';
  function dayRow(r){
    var b=(r.people||0)-(r.fresh||0);
    return '<tr><td>'+String(r.day).slice(5)+'</td>'
      +'<td class="n">'+nz(r.people)+'</td>'
      +'<td class="n">'+nz(r.fresh)+'</td>'
      +'<td class="n hot">'+nz(b)+'</td>'
      +'<td class="n">'+nz(r.opens)+'</td></tr>';
  }
  h+='<div class="wrap"><table>'+HEAD;
  d.daily.slice(0,14).forEach(function(r){ h+=dayRow(r); });
  h+='</table></div>';
  if(d.daily.length>14){
    h+='<details><summary>更早的 '+(d.daily.length-14)+' 天</summary><div class="wrap"><table>'+HEAD;
    d.daily.slice(14).forEach(function(r){ h+=dayRow(r); });
    h+='</table></div></details>';
  }

  /* --- 每日挑戰 --- */
  if(d.chal&&d.chal.length){
    var c0=d.chal[0];
    h+='<h2>每日挑戰</h2>';
    h+='<p class="hint">全站同一份 10 題。一個裝置一天只計一次，重玩不累加。</p>';
    h+='<div class="cards">'
      + card(nz(c0.plays),"今天玩過","完成今日挑戰的人數","")
      + card(c0.plays?(Math.round(c0.total/c0.plays*10)/10):"—","今天平均分","總分 ÷ 人數（滿分 10）","")
      + card(t.people?pct(c0.plays,t.people):"—","參與率","玩過的人 ÷ 今天活躍人數","")
      + '</div>';
    h+='<div class="wrap"><table><tr><th>日期</th><th>人數</th><th>平均</th></tr>';
    d.chal.forEach(function(r){
      h+='<tr><td>'+String(r.day).slice(5)+'</td><td class="n">'+nz(r.plays)+'</td>'
        +'<td class="n hot">'+(r.plays?(Math.round(r.total/r.plays*10)/10):"—")+'</td></tr>';
    });
    h+='</table></div>';
  }

  /* --- 難度分佈 --- */
  h+='<h2>程度 · 選了哪個難度</h2>';
  h+='<p class="hint">我們沒有問使用者的年級 —— 自陳的身分準確度差、會擋在漏斗前面，一年後還會過期。'
    +'改看<b>實際選了哪個難度</b>：不打擾人、不會過期。'
    +'只算<b>主動改過難度</b>的人（進站預設是「全部」，每個人都會送一次，混進來的話「全部」會永遠第一）。</p>';
  if(d.diffs&&d.diffs.length){
    h+='<p class="hint">最近 30 天有 <b>'+(d.diffPeople||0)+'</b> 人主動選過難度。</p>';
    h+='<div class="wrap"><table><tr><th>難度</th><th>人數</th><th>比例</th><th>切換次數</th></tr>';
    d.diffs.forEach(function(r){
      h+='<tr><td>'+(DIFF_LABEL[r.mode]||r.mode)+'</td><td class="n">'+nz(r.people)+'</td>'
        +'<td class="n hot">'+pct(r.people,d.diffPeople||0)+'</td><td class="n">'+nz(r.hits)+'</td></tr>';
    });
    h+='</table></div>';
    h+='<p class="hint">怎麼讀：只停在<b>基礎</b>的人偏國小或國中低年級；會往<b>進階</b>跑的多半是國二國三；'
      +'碰<b>地獄</b>的是高中或程度特別好的。搭配上面的「整體答錯率」一起看更準。</p>';
  }else{
    h+='<p class="hint">還沒有人主動切換過難度，或這版剛部署。累積幾天再回來看。</p>';
  }

  /* --- 回訪同期群 --- */
  if(d.cohort&&d.cohort.people){
    var co=d.cohort,N=co.people;
    h+='<h2>回訪 · 同期群</h2>';
    h+='<p class="hint">只看第一次來在 '+co.cutoff+' 以前的 <b>'+N+'</b> 人。昨天才來的人還沒有機會回訪，算進去會把回訪率壓低。</p>';
    h+='<table><tr><th>至少回來</th><th>人數</th><th>比例</th></tr>';
    [["2 天",co.d2],["3 天",co.d3],["5 天",co.d5],["7 天",co.d7]].forEach(function(x){
      h+='<tr><td>'+x[0]+'</td><td class="n">'+nz(x[1])+'</td><td class="n hot">'+pct(x[1]||0,N)+'</td></tr>';
    });
    h+='</table>';
  }

  /* --- 最常錯的字 --- */
  h+='<h2>最常錯的字</h2>';
  var wt=d.wordTotal||{};
  h+='<p class="hint">排名用的是<b>答錯率</b>（答錯 ÷ 出現），不是答錯次數。答錯過的字之後會更常被抽到，只看次數的話排出來的是「被抽到最多的字」。</p>';
  if(wt.words){
    h+='<div class="cards">'
      + card(nz(wt.words),"已收集單字","有紀錄的字數（滿 2122 就是全部）","")
      + card(nz(wt.ready),"已達門檻","出現滿 100 次、可以進榜的字","")
      + card(wt.shown?pct(wt.wrong||0,wt.shown):"—","整體答錯率","全部答錯 ÷ 全部出現",(wt.wrong||0)+" 錯 / "+(wt.shown||0)+" 次")
      + '</div>';
  }
  if(d.hardWords&&d.hardWords.length){
    h+='<div class="wrap"><table><tr><th>單字</th><th>答錯率</th><th>答錯</th><th>出現</th></tr>';
    d.hardWords.forEach(function(r){
      h+='<tr><td>'+r.en+'</td><td class="n hot">'+r.pct+'%</td><td class="n">'+r.wrong+'</td><td class="n">'+r.shown+'</td></tr>';
    });
    h+='</table></div>';
  }else{
    h+='<p class="hint">還沒有單字出現滿 100 次。以目前流量估計約需兩週，在那之前這裡是空的，屬正常。</p>';
  }

  /* --- 複製偵測 --- */
  if(d.copies&&d.copies.length){
    h+='<h2>⚠️ 偵測到的複製網域</h2>';
    h+='<p class="hint">這份 index.html 被架在非官方網址時會回報一次。只收網域，不收任何使用者資料。</p>';
    h+='<div class="wrap"><table><tr><th>網域</th><th>開啟</th><th>最後一次</th></tr>';
    d.copies.forEach(function(r){
      h+='<tr><td>'+r.host+'</td><td class="n">'+r.hits+'</td><td class="n">'+new Date(r.last_seen).toISOString().slice(0,10)+'</td></tr>';
    });
    h+='</table></div>';
  }

  /* --- 誠實說明 --- */
  h+='<p class="note"><b>看數字前要知道的</b><br>'
    +'活躍／新增／回訪是<b>人數</b>，同一台裝置一天只算一次；開啟以後是<b>次數</b>。兩者不能互相加減。<br>'
    +'匿名 ID 存在裝置上，<b>清瀏覽器資料、換瀏覽器、無痕視窗都會被算成新的人</b>，所以人數是高估的。<br>'
    +'Threads 的內建瀏覽器跟 Chrome 是<b>分開的儲存空間</b>，同一個學生從兩邊進來會被算成兩個人。流量大宗來自 Threads，這個影響不小。<br>'
    +'「閃卡」的歷史數字<b>嚴重虛胖</b>：2026/09/03 以前閃卡是預設落地頁，每個開啟系統的人都會被記一次閃卡。主頁上線後才是真實偏好。<br>'
    +'「主頁」這個模式從 2026/09/03 才開始有，之前的數字是 0，不是沒人用。<br>'
    +'答錯率只計單字測驗與闖關地圖；文法與重組句子不是單字題，不列入。<br>'
    +'顯示「—」代表沒有資料，不是 0。台北時區。</p>';

  app.className="";
  app.innerHTML=h;
}).catch(function(e){
  var app=document.getElementById("app");
  app.className="";app.textContent="讀取失敗："+e;
});

function bars(rows,denom){
  if(!rows||!rows.length) return '<p class="hint">還沒有資料。</p>';
  var max=Math.max.apply(null,rows.map(function(r){return r.hits}));
  return rows.map(function(r,i){
    var w=Math.round(r.hits/max*100);
    var tail=denom?(r.people+' 人 \u00B7 '+pct(r.people,denom)):(r.hits+' 次 / '+r.people+' 人');
    return '<div class="row"><span class="nm">'+(LABEL[r.mode]||r.mode)+'</span>'
      +'<span class="tr"><span class="fl'+(i===0?" top":"")+'" style="width:'+w+'%"></span></span>'
      +'<span class="vl">'+tail+'</span></div>';
  }).join("");
}
</script></body></html>
`;
