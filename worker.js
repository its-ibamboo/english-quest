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

const BUILD = "v2026.11.02b";            // 跟 index.html 的版本號一起往上帶
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
      if (env.DB) ctx.waitUntil(saveWords(env, url.searchParams.get("d"), url.searchParams.get("m")));
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

    // 排行榜管理。跟 /reports 共用同一把密碼。
    // 學生端沒有撤下鍵，真的有人要求移除時由這裡處理。
    if (url.pathname === "/board/admin") {
      const want = env.ADMIN_KEY || REPORTS_PW;
      const ck = (request.headers.get("cookie") || "")
        .split(";").map(function (x) { return x.trim(); })
        .find(function (x) { return x.indexOf("rp=") === 0; });
      const k = url.searchParams.get("k") || (ck ? decodeURIComponent(ck.slice(3)) : "");
      if (!want || k !== want) {
        return new Response(loginPage(""), {
          status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (!env.DB) return new Response("no db", { status: 503 });
      const act = url.searchParams.get("act"), id = url.searchParams.get("aid") || "";
      // v2026.11.01a：小遊戲排行榜的管理（act 前面加 g-，另外帶 game）
      const gm = url.searchParams.get("game") || "";
      if (act && id && act.indexOf("g-") === 0 && GAMES[gm]) {
        await ensureGameTables(env);
        const sqlMap = {
          "g-anon": "UPDATE game_board SET nick = '匿名玩家', ava = '' WHERE game = ? AND aid = ?",
          "g-hide": "UPDATE game_board SET hidden = 1 WHERE game = ? AND aid = ?",
          "g-ok":   "UPDATE game_board SET hidden = 3 WHERE game = ? AND aid = ?",
          "g-del":  "DELETE FROM game_board WHERE game = ? AND aid = ?"
        };
        if (sqlMap[act]) await env.DB.prepare(sqlMap[act]).bind(gm, id).run();
        return Response.redirect(url.origin + "/board/admin#g-" + gm, 302);
      }
      if (act && id) {
        await ensureBoard(env);
        if (act === "anon") {
          await env.DB.prepare("UPDATE board SET nick = '匿名玩家', ava = '' WHERE aid = ?").bind(id).run();
        } else if (act === "hide") {
          await env.DB.prepare("UPDATE board SET hidden = 1 WHERE aid = ?").bind(id).run();
        } else if (act === "del") {
          // v2026.11.02a：整筆刪掉。對方如果再按「更新成績」會重新上傳；要擋住請用「隱藏」
          await env.DB.prepare("DELETE FROM board WHERE aid = ?").bind(id).run();
        } else if (act === "show" || act === "ok") {
          // 放行 = 3：之後重新上傳也不會再被自動擋
          await env.DB.prepare("UPDATE board SET hidden = 3 WHERE aid = ?").bind(id).run();
        }
        return Response.redirect(url.origin + "/board/admin", 302);
      }
      await ensureBoard(env);
      const all = await env.DB.prepare(
        `SELECT aid, nick, ava, stars, cleared, badges, hidden,
                (SELECT COUNT(*) FROM events e
                  WHERE e.aid = board.aid AND e.ev = 'mode' AND e.mode = 'adventure') AS adv,
                (SELECT COUNT(*) FROM events e
                  WHERE e.aid = board.aid AND e.ev = 'open') AS opens
           FROM board ORDER BY (hidden = 2) DESC, stars DESC LIMIT 200`
      ).all();
      await ensureGameTables(env);
      const gl = {};
      for (const g of Object.keys(GAMES)) {
        const r = await env.DB.prepare(
          `SELECT aid, nick, score, cleared, secs, hidden, priv FROM game_board WHERE game = ?
            ORDER BY (hidden = 2) DESC, score DESC LIMIT 100`).bind(g).all();
        gl[g] = r.results || [];
      }
      return new Response(boardAdminPage(all.results || [], gl), {
        headers: { "content-type": "text/html; charset=utf-8" } });
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

    // ---------- 1.7 闖關榜 ----------
    // 帶 nick 就寫入/更新，不帶就只查詢。
    if (url.pathname === "/lb") {
      if (!env.DB) return json({ top: [], rank: null });
      return json(await leaderboard(env, url.searchParams));
    }

    // ---------- 1.9 目前線上版本（v2026.11.02a）----------
    // 前端拿自己的 BUILD 來比，不一樣就在畫面下方顯示「有新版本」。
    if (url.pathname === "/v") {
      return new Response(JSON.stringify({ v: BUILD }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" }
      });
    }

    // ---------- 1.8 小遊戲排行榜（v2026.11.01a）----------
    // /gs/start   開局號碼牌        /gs/submit  上傳成績（只在破紀錄時）
    // /gs/board   查榜              /gs/profile 改名、不顯示我的成績
    // /gs/cand    切切樂的「待確認名單」
    if (url.pathname.indexOf("/gs/") === 0) {
      if (!env.DB) return json({ error: "no db" });
      try {
        return json(await gameApi(env, url.pathname.slice(4), url.searchParams));
      } catch (e) {
        return json({ error: "fail" });
      }
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
        out.push("切切樂：" + (html.indexOf("var SLICE") >= 0 ? "有，已部署" : "沒有！部署的是舊版 index.html"));
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
    const ev = (rawEv === "open" || rawEv === "mode" || rawEv === "diff" || rawEv === "pwa") ? rawEv : null;
    if (!ev) return;

    // 模式與難度共用 mode 欄位。既有查詢都有 WHERE ev='mode'，
    // 所以難度事件不會污染任何現有的數字。
    const ALLOWED = ["home", "flash", "quiz", "grammar", "scramble", "adventure", "badges", "bee", "slice"];
    const DIFFS = ["basic", "advanced", "hell", "all"];
    const PWAS = ["yes", "no"];
    const list = ev === "diff" ? DIFFS : (ev === "pwa" ? PWAS : ALLOWED);
    const mode = rawMode && list.indexOf(rawMode) >= 0 ? rawMode : null;
    if ((ev === "diff" || ev === "pwa") && !mode) return;

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

// v2026.11.01a：多帶一個模式 m。
//   · stage / quiz / chal（看英文選中文的舊模式）→ 舊表 word_stats 照舊累加，另外記一份到 word_stats_m
//   · slice（切切樂）→ 只記 word_stats_m，不碰舊表
//   · 沒帶 m（還在用舊版的手機）→ 只記舊表，跟以前一模一樣
const WORD_MODES = ["stage", "quiz", "chal", "slice"];
const OLD_MODES = ["stage", "quiz", "chal"];

async function saveWords(env, raw, rawMode) {
  try {
    if (typeof raw !== "string" || !raw) return;
    const mode = WORD_MODES.indexOf(rawMode) >= 0 ? rawMode : null;

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS word_stats (
         en TEXT PRIMARY KEY,
         shown INTEGER NOT NULL DEFAULT 0,
         wrong INTEGER NOT NULL DEFAULT 0)`
    ).run();
    if (mode) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS word_stats_m (
           en TEXT NOT NULL, mode TEXT NOT NULL,
           shown INTEGER NOT NULL DEFAULT 0,
           wrong INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (en, mode))`
      ).run();
    }

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

    const stmts = [];
    // 舊表：舊模式或沒帶模式才寫
    if (!mode || OLD_MODES.indexOf(mode) >= 0) {
      // 表已經夠大時就不再收新單字，只更新既有的，避免有人塞垃圾把表灌爆
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM word_stats").first();
      const full = c && c.n >= WORD_TABLE_CAP;
      const sql = full
        ? "UPDATE word_stats SET shown = shown + ?2, wrong = wrong + ?3 WHERE en = ?1"
        : `INSERT INTO word_stats (en, shown, wrong) VALUES (?1, ?2, ?3)
           ON CONFLICT(en) DO UPDATE SET shown = shown + ?2, wrong = wrong + ?3`;
      rows.forEach(function (r) { stmts.push(env.DB.prepare(sql).bind(r[0], r[1], r[2])); });
    }
    if (mode) {
      const c2 = await env.DB.prepare("SELECT COUNT(*) AS n FROM word_stats_m").first();
      const full2 = c2 && c2.n >= WORD_TABLE_CAP * WORD_MODES.length;
      const sql2 = full2
        ? "UPDATE word_stats_m SET shown = shown + ?3, wrong = wrong + ?4 WHERE en = ?1 AND mode = ?2"
        : `INSERT INTO word_stats_m (en, mode, shown, wrong) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(en, mode) DO UPDATE SET shown = shown + ?3, wrong = wrong + ?4`;
      rows.forEach(function (r) { stmts.push(env.DB.prepare(sql2).bind(r[0], mode, r[1], r[2])); });
    }
    if (stmts.length) await env.DB.batch(stmts);
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
const REPORTS_PW = "073957097";
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
function gameAdminHtml(gl) {
  const NAME = { slice: "切切樂", bee: "拼字小蜜蜂" };
  return Object.keys(gl).map(function (g) {
    const list = gl[g], pend = list.filter(function (r) { return r.hidden === 2; }).length;
    const rows = list.map(function (r) {
      const id = encodeURIComponent(r.aid), base = `/board/admin?game=${g}&aid=${id}&act=`;
      const tag = r.hidden === 1 ? ' <span style="color:#D9705E">（已隱藏）</span>'
                : r.hidden === 2 ? ' <span style="color:#E8C14A">（待審）</span>'
                : r.hidden === 3 ? ' <span style="color:#6FBF9A">（已放行）</span>' : "";
      const pv = r.priv ? ' <span style="opacity:.6">（本人選擇不公開）</span>' : "";
      const btn = r.hidden === 2
        ? `<a href="${base}g-ok" style="color:#6FBF9A">放行</a>　<a href="${base}g-hide" style="color:#D9705E">隱藏</a>`
        : r.hidden === 1 ? `<a href="${base}g-ok" style="color:#6FBF9A">取消隱藏</a>`
        : `<a href="${base}g-hide" style="color:#D9705E">隱藏</a>`;
      return `<tr${r.hidden === 2 ? ' style="background:#2A2615"' : ""}>
        <td>${esc(r.nick)}${tag}${pv}<div style="font-size:11px;opacity:.5">${esc(r.aid)}</div></td>
        <td style="text-align:right">${r.score}</td>
        <td style="text-align:right">${r.cleared} / ${r.secs}s</td>
        <td style="text-align:right;white-space:nowrap"><a href="${base}g-anon" style="color:#D9A441">改匿名</a>　${btn}　
          <a href="${base}g-del" style="color:#E06A55" onclick="return confirm('刪除這筆成績？不能復原。\n（對方破紀錄會重新上傳；要擋住請用「隱藏」）')">刪除</a></td></tr>`;
    }).join("");
    return `<h2 id="g-${g}" style="font-size:18px;margin-top:30px">${NAME[g] || g}排行榜（${list.length} 人${pend ? `，<span style="color:#E8C14A">${pend} 筆待審</span>` : ""}）</h2>
<p style="font-size:13px;opacity:.6">成績是自動上傳的。「待審」＝分數超過題數上限、題數超過時間允許的量、或宣稱的遊戲時間比實際經過的還長。「題數/秒」可以自己判斷合不合理。</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
<tr style="opacity:.6;font-size:12px"><th style="text-align:left">暱稱</th><th style="text-align:right">分數</th><th style="text-align:right">題數/秒</th><th></th></tr>
${rows || '<tr><td colspan="4" style="opacity:.6;padding:14px 0">還沒有成績。</td></tr>'}
</table>`;
  }).join("");
}

function boardAdminPage(list, gl) {
  const pending = list.filter(function (r) { return r.hidden === 2; }).length;
  const rows = list.map(function (r) {
    const id = encodeURIComponent(r.aid);
    const tag = r.hidden === 1 ? ' <span style="color:#D9705E">（已隱藏）</span>'
              : r.hidden === 2 ? ' <span style="color:#E8C14A">（待審）</span>'
              : r.hidden === 3 ? ' <span style="color:#6FBF9A">（已放行）</span>' : "";
    const btn = r.hidden === 2
      ? `<a href="/board/admin?act=ok&aid=${id}" style="color:#6FBF9A">放行</a>　
         <a href="/board/admin?act=hide&aid=${id}" style="color:#D9705E">隱藏</a>`
      : `<a href="/board/admin?act=${r.hidden === 1 ? "show" : "hide"}&aid=${id}"
           style="color:#D9705E">${r.hidden === 1 ? "取消隱藏" : "隱藏"}</a>`;
    return `<tr${r.hidden === 2 ? ' style="background:#2A2615"' : ""}>
      <td>${esc(r.nick)}${tag}<div style="font-size:11px;opacity:.5">${esc(r.aid)}</div></td>
      <td style="text-align:right">${r.stars} ⭐</td>
      <td style="text-align:right">${r.cleared}</td>
      <td style="text-align:right">${r.adv} / ${r.opens}</td>
      <td style="text-align:right;white-space:nowrap">
        <a href="/board/admin?act=anon&aid=${id}" style="color:#D9A441">改匿名</a>　${btn}　
        <a href="/board/admin?act=del&aid=${id}" style="color:#E06A55" onclick="return confirm('刪除這筆闖關榜紀錄？不能復原。\n（對方再上傳會重新出現；要擋住請用「隱藏」）')">刪除</a>
      </td></tr>`;
  }).join("");
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>闖關榜管理</title></head>
<body style="background:#141613;color:#E8EAE4;font-family:system-ui,-apple-system,'Noto Sans TC',sans-serif;padding:14px;max-width:720px;margin:0 auto">
<h1 style="font-size:20px">闖關榜管理（${list.length} 人${pending ? `，<span style="color:#E8C14A">${pending} 筆待審</span>` : ""}）</h1>
<p style="font-size:13px;opacity:.6">「待審」= 通關數跟實際進闖關地圖的次數對不上，系統自動先不上榜。「闖關/開啟」是後台記到的次數：通關很多、闖關卻是 0，多半是改了瀏覽器資料。真的玩的人（例如擋廣告外掛把統計擋掉）按「放行」，之後不會再被擋。</p>
<p style="font-size:13px;opacity:.6">學生端沒有撤下鍵。有人要求移除時，用「隱藏」；名字不妥時用「改匿名」。隱藏之後不列入排名，也不佔名次。</p>
<p style="font-size:13px;opacity:.6">「刪除」會把整筆紀錄刪掉，但對方下次上傳會重新出現。<b>作弊的人請用「隱藏」</b>：隱藏是永久的，他之後再上傳也一樣不會上榜。</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
<tr style="opacity:.6;font-size:12px"><th style="text-align:left">暱稱</th><th style="text-align:right">星</th><th style="text-align:right">通關</th><th style="text-align:right">闖關/開啟</th><th></th></tr>
${rows || '<tr><td colspan="5" style="opacity:.6;padding:14px 0">還沒有人上榜。</td></tr>'}
</table>
${gl ? gameAdminHtml(gl) : ""}
<p style="margin-top:20px"><a href="/admin" style="color:#D9A441">← 回統計頁</a></p>
</body></html>`;
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

// 闖關榜。一個裝置一列，upsert，不會無限成長。
// 三個數字都有上限（星 321 / 關 107 / 徽章 10），超出就當作無效 ——
// 有上限就沒有炫耀價值，作弊者最多跟高手同分。
// v2026.10.14a：實際發生改 localStorage 直接 321 星上榜，所以加了自動待審（見 lbSuspicious）。
//
// hidden 欄位的值：
//   0 = 正常上榜
//   1 = 後台手動隱藏
//   2 = 自動待審（通關數對不上闖關紀錄）—— 不上榜，等後台放行
//   3 = 後台放行過 —— 上榜，之後重新上傳不再檢查
const LB_SHOWN = "hidden IN (0, 3)";
const LB_LIMIT = { stars: 321, cleared: 107, badges: 10 };
const LB_NICK_BAD = /[@＠]|[a-zA-Z0-9_.]{6,}|加我|私訊|密我|賴|來找我|聯絡/;

async function ensureBoard(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS board (
       aid TEXT PRIMARY KEY, nick TEXT NOT NULL, ava TEXT,
       stars INTEGER NOT NULL DEFAULT 0,
       cleared INTEGER NOT NULL DEFAULT 0,
       badges INTEGER NOT NULL DEFAULT 0,
       t INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)`
  ).run();
}
function lbInt(v, max) {
  const n = parseInt(v, 10);
  return (n >= 0 && n <= max) ? n : null;
}
// 通關 10 關以上，但後台記到「進入闖關地圖」的次數太少 → 待審。
// 門檻刻意放很寬：每 20 關只要求進過地圖 1 次（107 關 → 5 次），
// 真的玩的人一定遠超過這個數字；改資料的人通常是 0。
async function lbSuspicious(env, aid, cleared) {
  if (cleared < 10) return false;
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE aid = ? AND ev = 'mode' AND mode = 'adventure'`
    ).bind(aid).first();
    const adv = (r && r.n) || 0;
    return adv < Math.max(1, Math.floor(cleared / 20));
  } catch (e) {
    return false; // 查詢壞掉就不擋，不能讓正常玩家上不了榜
  }
}

async function leaderboard(env, q) {
  await ensureBoard(env);
  const aid = q.get("aid") || "";
  const nick = (q.get("nick") || "").trim().slice(0, 8);

  if (aid && /^[a-z0-9-]{1,40}$/.test(aid) && nick && !LB_NICK_BAD.test(nick)) {
    const stars = lbInt(q.get("stars"), LB_LIMIT.stars);
    const cleared = lbInt(q.get("cleared"), LB_LIMIT.cleared);
    const badges = lbInt(q.get("badges"), LB_LIMIT.badges);
    const ava = (q.get("ava") || "").slice(0, 20).replace(/[^a-z]/g, "");
    if (stars !== null && cleared !== null && badges !== null) {
      // 手動隱藏(1)和已放行(3)維持不變；其他情況每次上傳都重新檢查
      const old = await env.DB.prepare("SELECT hidden FROM board WHERE aid = ?").bind(aid).first();
      let hidden;
      if (old && (old.hidden === 1 || old.hidden === 3)) hidden = old.hidden;
      else hidden = (await lbSuspicious(env, aid, cleared)) ? 2 : 0;
      await env.DB.prepare(
        `INSERT INTO board (aid, nick, ava, stars, cleared, badges, t, hidden) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(aid) DO UPDATE SET nick=?2, ava=?3, stars=?4, cleared=?5, badges=?6, t=?7, hidden=?8`
      ).bind(aid, nick, ava, stars, cleared, badges, Date.now(), hidden).run();
    }
  }

  // 前 10 名（v2026.11.02a，原本 20 名，後面分數太低）。隱藏(1)和待審(2)都不列入，也不佔名次。
  const top = await env.DB.prepare(
    `SELECT nick, ava, stars, cleared, badges FROM board
      WHERE ${LB_SHOWN} ORDER BY stars DESC, cleared DESC, t ASC LIMIT 10`
  ).all();

  // 自己的名次：算出「分數比我高的人數 + 1」，不必把整張榜撈下來。
  let rank = null;
  if (aid) {
    const me = await env.DB.prepare(
      `SELECT stars, cleared, t FROM board WHERE aid = ? AND ${LB_SHOWN}`
    ).bind(aid).first();
    if (me) {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM board WHERE ${LB_SHOWN} AND (
           stars > ?1 OR (stars = ?1 AND cleared > ?2)
           OR (stars = ?1 AND cleared = ?2 AND t < ?3))`
      ).bind(me.stars, me.cleared, me.t).first();
      rank = ((r && r.n) || 0) + 1;
    }
  }
  return { top: top.results || [], rank: rank };
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

  // 安裝率：近 7 天有回報過 pwa 事件的人裡，有多少是從主畫面開的。
  // 同一個人可能兩種都回報過（先用瀏覽器、後來裝了），以「曾經 yes」為準。
  let pwa = {};
  try {
    pwa = await env.DB.prepare(
      `SELECT COUNT(*) AS people,
              SUM(CASE WHEN inst = 1 THEN 1 ELSE 0 END) AS installed
         FROM (SELECT aid, MAX(CASE WHEN mode='yes' THEN 1 ELSE 0 END) AS inst
                 FROM events
                WHERE ev = 'pwa'
                  AND day >= date('now','+8 hours','-7 days')
                GROUP BY aid)`
    ).first() || {};
  } catch (e) { pwa = {}; }

  // 裝了的人 vs 沒裝的人，回訪表現差多少。
  // 只看第一次來至少 7 天前的人，理由跟上面的同期群一樣。
  let pwaCohort = [];
  try {
    const pc = await env.DB.prepare(
      `SELECT inst,
              COUNT(*) AS people,
              SUM(CASE WHEN days >= 2 THEN 1 ELSE 0 END) AS d2,
              SUM(CASE WHEN days >= 5 THEN 1 ELSE 0 END) AS d5,
              ROUND(AVG(days), 1) AS avgd
         FROM (SELECT e.aid,
                      MIN(e.day) AS fd,
                      COUNT(DISTINCT e.day) AS days,
                      MAX(CASE WHEN e.ev='pwa' AND e.mode='yes' THEN 1 ELSE 0 END) AS inst
                 FROM events e
                WHERE e.aid IN (SELECT DISTINCT aid FROM events WHERE ev='pwa')
                GROUP BY e.aid)
        WHERE fd <= ?
        GROUP BY inst`
    ).bind(cutoff).all();
    pwaCohort = (pc && pc.results) || [];
  } catch (e) { pwaCohort = []; }

  // 最常錯的字（v2026.11.01a 新算法，見 rankWords）
  // 闖關＋單字測驗＋今日挑戰＋切切樂全部算進來，但先扣掉各模式本身的難度，
  // 排名用「換算成同一把尺之後的答錯率」的 95% 下限。地獄字不列入。
  let hardWords = [], wordTotal = {}, wordModes = [];
  try {
    const meta = await wordOrigins(env);
    const rk = await rankWords(env, meta);
    hardWords = rk.rows.slice(0, HARD_TOP).map(function (r) {
      const m = meta && meta[r.en];
      return {
        en: r.en, shown: r.n, wrong: r.w, slice: r.slice,
        pct: Math.round(r.w * 1000 / r.n) / 10,          // 原始答錯率（全部直接加總）
        est: Math.round(r.est * 1000) / 10,              // 換算答錯率
        stage: m ? m.stage : undefined, lvl: m ? m.lvl : undefined, chal: m ? (m.chal || null) : null
      };
    });
    wordModes = rk.modes;

    wordTotal = await env.DB.prepare(
      `SELECT COUNT(*) AS words, SUM(shown) AS shown, SUM(wrong) AS wrong,
              SUM(CASE WHEN shown >= ? THEN 1 ELSE 0 END) AS ready
         FROM word_stats`
    ).bind(HARD_MIN).first() || {};
    wordTotal.ready = rk.ready;
    wordTotal.growing = rk.growing;
  } catch (e) { hardWords = []; wordTotal = {}; }

  // 未處理的回報筆數。只給數字，內容要密碼才看得到。
  let reportCount = 0;
  try {
    const rc = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first();
    reportCount = (rc && rc.n) || 0;
  } catch (e) { reportCount = 0; }

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
    wordModes: wordModes,
    diffs: diffs,
    diffPeople: diffPeople,
    cohort: cohort,
    pwa: pwa,
    pwaCohort: pwaCohort,
    hardWords: hardWords,
    wordTotal: wordTotal,
    reportCount: reportCount,
    copies: copies,
    total: total || {}
  };
}

// ---------- 最常錯的字：排序與來源標記 ----------
const HARD_TOP = 50;   // 榜單取前幾名
const HARD_MIN = 50;   // 後台「最常錯的字」：至少出現 50 次才上榜（v2026.11.02a，原本 10 次參考量太低）
const CAND_MIN = 10;   // 待確認名單：10 次以上就可以進來（就是要靠它把次數補到 50）
const CHAL_START = "2026-09-03";   // 今日挑戰上線日
const CHAL_ROT_START = "2026-11-02";   // 今日挑戰改輪播的日期（同 index.html）
const CHAL_ROT_SEED = 20261102;

// 答錯率的 Wilson 95% 信賴下限。次數少的字會被往下壓，次數多的接近真實比例。
function wilsonLow(wrong, n) {
  if (!n) return 0;
  const z = 1.96, p = wrong / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

// 以下三個函式必須跟 index.html 裡的 seededRandom / seededShuffle / buildStages /
// chalQuestions 保持一致；那邊改了出題規則，這邊要跟著改，否則標記會錯（榜單本身不受影響）。
function eqSeededShuffle(arr, seed) {
  let s = seed;
  const rand = function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

let ORIGIN_CACHE = null;   // 同一個 Worker 實例內重複使用，不用每次重抓

// 回傳 { 單字: { stage: 第幾關, lvl: 等級, chal: [今日挑戰日期...] } }
// WORD_BANK 直接從線上的 index.html 讀，永遠跟前端同一份。
async function wordOrigins(env) {
  if (ORIGIN_CACHE && ORIGIN_CACHE.day === eqToday()) return ORIGIN_CACHE.map;
  try {
    if (!env.ASSETS) return null;
    const res = await env.ASSETS.fetch(new Request("https://assets.local/index.html"));
    if (!res.ok) return null;
    const html = await res.text();
    const start = html.indexOf("var WORD_BANK = [");
    const end = html.indexOf("\n];", start);
    if (start < 0 || end < 0) return null;
    const body = html.slice(start, end);
    const bank = [];
    const re = /\{\s*en:\s*"([^"]*)"[^}]*?level:\s*"([a-z]+)"/g;
    let m;
    while ((m = re.exec(body))) bank.push({ en: m[1], level: m[2] });
    if (bank.length < 1000) return null;   // 解析失敗就別亂標

    const map = {};
    // 闖關：同 buildStages()，STAGE_SIZE = 20
    let idx = 0;
    ["basic", "advanced", "hell"].forEach(function (lvl, li) {
      const words = eqSeededShuffle(bank.filter(function (w) { return w.level === lvl; }), 20260710 + li);
      for (let i = 0; i < words.length; i += 20) {
        idx++;
        words.slice(i, i + 20).forEach(function (w) { map[w.en] = { stage: idx, lvl: lvl }; });
      }
    });

    // 今日挑戰：同 chalQuestions()，從上線日算到今天
    const pool = bank.filter(function (w) { return w.level === "basic" || w.level === "advanced"; });
    const d0 = Math.floor(Date.parse(CHAL_START + "T00:00:00Z") / 86400000);
    const d1 = Math.floor((Date.now() + TZ_OFFSET) / 86400000);
    // v2026.10.31a：CHAL_ROT_START 起改成輪播（同 index.html 的 chalPickWords）
    const rs = Math.floor(Date.parse(CHAL_ROT_START + "T00:00:00Z") / 86400000);
    const rotOrder = eqSeededShuffle(pool, CHAL_ROT_SEED);
    for (let d = d0; d <= d1; d++) {
      const label = new Date(d * 86400000).toISOString().slice(5, 10).replace("-", "/");
      let picked;
      if (d < rs) picked = eqSeededShuffle(pool, d * 7919).slice(0, 10);
      else {
        picked = [];
        for (let i = 0; i < 10; i++) picked.push(rotOrder[((d - rs) * 10 + i) % rotOrder.length]);
      }
      picked.forEach(function (w) {
        const e = map[w.en] || (map[w.en] = {});
        (e.chal || (e.chal = [])).push(label);
      });
    }

    ORIGIN_CACHE = { day: eqToday(), map: map };
    return map;
  } catch (e) { return null; }
}
function eqToday() { return new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10); }

// =====================================================================
// v2026.11.01a 最常錯的字：跨模式排名
// ---------------------------------------------------------------------
// 問題：切切樂有時間壓力、字卡會掉，同一個字在切切樂的答錯率一定比闖關高。
//       直接加總的話，常在切切樂出現的字會被冤枉。
// 做法：在 log-odds 尺度上扣掉「每個模式比參考模式難多少」，再合併。
//   · 參考模式 = 舊的看英文選中文（舊表的歷史資料 + stage + quiz + chal）
//   · 舊表 word_stats 裡「還沒分模式之前」的歷史資料，當成一個模式 "old"
//       old = 舊表總數 − 新表裡 stage/quiz/chal 的數（因為新資料兩邊都會記）
//   · 某模式的總量太少（< MODE_MIN 次）就先不扣，避免用雜訊去校正
// 排名用估計值的 95% 下限（資料越少、下限越低，自然往後排）。
// 用模擬資料比較過：搭配「待確認名單」時，比直接加總更接近真相。
// =====================================================================
const MODE_MIN = 300;
const logit = function (p) { return Math.log(p / (1 - p)); };
const sigm = function (x) { return 1 / (1 + Math.exp(-x)); };

async function rankWords(env, meta, minN) {
  minN = minN || HARD_MIN;
  const legacy = await env.DB.prepare("SELECT en, shown, wrong FROM word_stats").all();
  let byMode = { results: [] };
  try { byMode = await env.DB.prepare("SELECT en, mode, shown, wrong FROM word_stats_m").all(); } catch (e) {}

  const W = {};   // en → { old:[n,w], stage:[n,w], ... }
  function cell(en) {
    if (!W[en]) W[en] = { old: [0, 0], stage: [0, 0], quiz: [0, 0], chal: [0, 0], slice: [0, 0] };
    return W[en];
  }
  (legacy.results || []).forEach(function (r) { const c = cell(r.en); c.old = [r.shown, r.wrong]; });
  (byMode.results || []).forEach(function (r) {
    if (WORD_MODES.indexOf(r.mode) < 0) return;
    cell(r.en)[r.mode] = [r.shown, r.wrong];
  });
  // 舊表裡已經包含新的 stage/quiz/chal，扣掉才不會重複算
  Object.keys(W).forEach(function (en) {
    const c = W[en];
    OLD_MODES.forEach(function (m) { c.old[0] -= c[m][0]; c.old[1] -= c[m][1]; });
    c.old[0] = Math.max(0, c.old[0]); c.old[1] = Math.max(0, Math.min(c.old[1], c.old[0]));
  });
  const isHell = function (en) { return !!(meta && meta[en] && meta[en].lvl === "hell"); };
  const MODES = ["old"].concat(WORD_MODES);

  // 各模式的整體答錯率（不含地獄字）
  const tot = {};
  MODES.forEach(function (m) { tot[m] = [0, 0]; });
  Object.keys(W).forEach(function (en) {
    if (isHell(en)) return;
    MODES.forEach(function (m) { tot[m][0] += W[en][m][0]; tot[m][1] += W[en][m][1]; });
  });
  let refN = 0, refW = 0;
  ["old"].concat(OLD_MODES).forEach(function (m) { refN += tot[m][0]; refW += tot[m][1]; });
  const refP = refN ? refW / refN : 0;
  const off = {}, modesOut = [];
  MODES.forEach(function (m) {
    const n = tot[m][0], p = n ? tot[m][1] / n : 0;
    const usable = n >= MODE_MIN && p > 0 && p < 1 && refP > 0 && refP < 1;
    off[m] = usable ? logit(p) - logit(refP) : 0;
    modesOut.push({ mode: m, shown: n, wrong: tot[m][1], pct: n ? Math.round(p * 1000) / 10 : 0,
                    adj: usable ? Math.round(off[m] * 100) / 100 : null });
  });

  const rows = [];
  let ready = 0, growing = 0;
  Object.keys(W).forEach(function (en) {
    if (isHell(en)) return;
    let n = 0, w = 0, offSum = 0;
    MODES.forEach(function (m) { n += W[en][m][0]; w += W[en][m][1]; offSum += W[en][m][0] * off[m]; });
    if (n < minN) { if (n > 0) growing++; return; }
    ready++;
    const est = logit((w + 0.5) / (n + 1)) - offSum / n;
    const se = Math.sqrt(1 / (w + 0.5) + 1 / (n - w + 0.5));
    rows.push({ en: en, n: n, w: w, slice: W[en].slice[0], est: sigm(est), score: est - 1.96 * se });
  });
  rows.sort(function (a, b) { return b.score - a.score || b.n - a.n; });
  return { rows: rows, modes: modesOut, ready: ready, growing: growing };
}

// =====================================================================
// v2026.11.01a 小遊戲排行榜（切切樂、拼字小蜜蜂）
// ---------------------------------------------------------------------
// · 一台裝置在一個遊戲只留一筆最高分；不重置
// · 名字是前端自動取的（形容詞＋動物＋兩位數字），可以改，一天一次（前端限制）
// · priv = 1：玩家選了「不顯示我的成績」，別人看不到，但自己的名次照算
// · hidden：0 正常 / 1 後台隱藏 / 2 自動待審 / 3 後台放行過（同闖關榜）
// · 防作弊：
//     1. 開局要拿號碼牌（/gs/start），上傳時交回，一張只能用一次
//     2. 伺服器比對「號碼牌發出到現在」的真實時間，不能比宣稱的遊戲秒數短
//     3. 分數不能超過題數能拿到的上限；題數不能超過時間允許的量
//     不合理就照收但設成待審（hidden = 2），不上榜，等後台放行
// =====================================================================
const GAMES = {
  // maxPer：每題最高分；minSec：每題至少要幾秒
  slice: { maxPer: 45, minSec: 0.8 },     // (10 + 20 連擊) × 1.5 進階
  bee:   { maxPer: 4200, minSec: 1.2 }    // 字長 14 × 10 × 連擊 5 × 魔王 3 × 難度倍率 2
};
const GB_SHOWN = "hidden IN (0, 3) AND priv = 0";

async function ensureGameTables(env) {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS game_board (
         game TEXT NOT NULL, aid TEXT NOT NULL, nick TEXT NOT NULL, ava TEXT,
         score INTEGER NOT NULL DEFAULT 0, cleared INTEGER NOT NULL DEFAULT 0,
         secs INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL,
         hidden INTEGER NOT NULL DEFAULT 0, priv INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (game, aid))`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS game_runs (
         tok TEXT PRIMARY KEY, aid TEXT NOT NULL, game TEXT NOT NULL, t INTEGER NOT NULL)`)
  ]);
}

function gbAid(q) { const a = q.get("aid") || ""; return /^[a-z0-9-]{1,40}$/.test(a) ? a : ""; }
function gbNick(v) {
  v = String(v || "").trim().slice(0, 8);
  return v && !LB_NICK_BAD.test(v) ? v : "";
}
function gbAva(v) { return String(v || "").slice(0, 20).replace(/[^a-z]/g, ""); }

async function gameApi(env, act, q) {
  const game = q.get("game") || "";
  const aid = gbAid(q);

  if (act === "cand") return { words: await candWords(env) };

  if (!GAMES[game] && act !== "profile") return { error: "game" };
  await ensureGameTables(env);
  const now = Date.now();

  if (act === "start") {
    if (!aid) return { error: "aid" };
    // 順便清掉一天以前沒用掉的號碼牌，表不會長大
    await env.DB.prepare("DELETE FROM game_runs WHERE t < ?").bind(now - 86400000).run();
    const tok = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await env.DB.prepare("INSERT INTO game_runs (tok, aid, game, t) VALUES (?, ?, ?, ?)")
      .bind(tok, aid, game, now).run();
    return { tok: tok };
  }

  if (act === "submit") {
    const nick = gbNick(q.get("nick")), ava = gbAva(q.get("ava"));
    const score = parseInt(q.get("score"), 10), cleared = parseInt(q.get("cleared"), 10), secs = parseInt(q.get("secs"), 10);
    const priv = q.get("priv") === "1" ? 1 : 0;
    if (!aid || !nick || !(score >= 0 && score <= 10000000) || !(cleared >= 0 && cleared <= 100000) || !(secs >= 0 && secs <= 86400)) {
      return Object.assign({ ok: false, why: "bad" }, await gameBoard(env, game, aid));
    }
    const run = await env.DB.prepare("SELECT aid, game, t FROM game_runs WHERE tok = ?").bind(q.get("tok") || "").first();
    if (!run || run.aid !== aid || run.game !== game) {
      return Object.assign({ ok: false, why: "token" }, await gameBoard(env, game, aid));
    }
    await env.DB.prepare("DELETE FROM game_runs WHERE tok = ?").bind(q.get("tok")).run();   // 一張只能用一次

    const G = GAMES[game], realSecs = (now - run.t) / 1000;
    const suspicious =
      secs > realSecs + 5 ||                       // 宣稱玩的時間比號碼牌發出到現在還長
      score > cleared * G.maxPer ||                 // 分數超過題數上限
      cleared > Math.max(3, secs / G.minSec);       // 太快
    const old = await env.DB.prepare("SELECT score, hidden FROM game_board WHERE game = ? AND aid = ?").bind(game, aid).first();
    if (old && old.score >= score) {
      // 沒破自己的紀錄：只更新名字和公開設定
      await env.DB.prepare("UPDATE game_board SET nick = ?, ava = ?, priv = ? WHERE game = ? AND aid = ?")
        .bind(nick, ava, priv, game, aid).run();
    } else {
      let hidden = suspicious ? 2 : 0;
      if (old && (old.hidden === 1 || old.hidden === 3)) hidden = suspicious && old.hidden === 3 ? 2 : old.hidden;
      await env.DB.prepare(
        `INSERT INTO game_board (game, aid, nick, ava, score, cleared, secs, t, hidden, priv) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(game, aid) DO UPDATE SET nick=?3, ava=?4, score=?5, cleared=?6, secs=?7, t=?8, hidden=?9, priv=?10`
      ).bind(game, aid, nick, ava, score, cleared, secs, now, hidden, priv).run();
    }
    return Object.assign({ ok: true, held: suspicious }, await gameBoard(env, game, aid));
  }

  if (act === "profile") {
    // 改名、公開設定：所有遊戲一起改
    if (!aid) return { error: "aid" };
    const nick = gbNick(q.get("nick")), ava = gbAva(q.get("ava"));
    const priv = q.get("priv") === "1" ? 1 : 0;
    if (!nick) return { ok: false, why: "nick" };
    await env.DB.prepare("UPDATE game_board SET nick = ?, ava = ?, priv = ? WHERE aid = ?").bind(nick, ava, priv, aid).run();
    return GAMES[game] ? Object.assign({ ok: true }, await gameBoard(env, game, aid)) : { ok: true };
  }

  if (act === "board") return await gameBoard(env, game, aid);
  return { error: "act" };
}

// 前 10 名 + 自己的名次 + 自己前後各兩名 + 前一名（「再 X 分就超過」）
async function gameBoard(env, game, aid) {
  const top = await env.DB.prepare(
    `SELECT aid, nick, ava, score FROM game_board WHERE game = ? AND ${GB_SHOWN}
      ORDER BY score DESC, t ASC LIMIT 10`).bind(game).all();
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM game_board WHERE game = ? AND ${GB_SHOWN}`).bind(game).first();
  let me = null, near = [], above = null;
  if (aid) {
    const mine = await env.DB.prepare(
      "SELECT score, t, hidden, priv FROM game_board WHERE game = ? AND aid = ?").bind(game, aid).first();
    if (mine && (mine.hidden === 0 || mine.hidden === 3)) {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM game_board WHERE game = ?1 AND ${GB_SHOWN} AND aid != ?2
           AND (score > ?3 OR (score = ?3 AND t < ?4))`).bind(game, aid, mine.score, mine.t).first();
      const rank = ((r && r.n) || 0) + 1;
      me = { rank: rank, score: mine.score, priv: mine.priv };
      if (rank > 1) {
        const a = await env.DB.prepare(
          `SELECT nick, ava, score FROM game_board WHERE game = ?1 AND ${GB_SHOWN} AND aid != ?2
             AND (score > ?3 OR (score = ?3 AND t < ?4)) ORDER BY score ASC, t DESC LIMIT 1`
        ).bind(game, aid, mine.score, mine.t).first();
        if (a) above = { nick: a.nick, ava: a.ava, score: a.score, rank: rank - 1 };
      }
      if (rank > 10 && !mine.priv) {
        const nb = await env.DB.prepare(
          `SELECT aid, nick, ava, score FROM game_board WHERE game = ? AND ${GB_SHOWN}
            ORDER BY score DESC, t ASC LIMIT 5 OFFSET ?`).bind(game, Math.max(10, rank - 3)).all();
        near = (nb.results || []).map(function (x, i) {
          return { nick: x.nick, ava: x.ava, score: x.score, rank: Math.max(10, rank - 3) + i + 1, mine: x.aid === aid };
        });
      }
    } else if (mine) {
      me = { rank: null, score: mine.score, held: mine.hidden === 2, priv: mine.priv };
    }
  }
  return {
    top: (top.results || []).map(function (x, i) {
      return { nick: x.nick, ava: x.ava, score: x.score, rank: i + 1, mine: !!aid && x.aid === aid };
    }),
    total: (total && total.n) || 0, me: me, near: near, above: above
  };
}

// 待確認名單：排名 30～90 名，加上看起來偏難（前 300 名）但資料還不到 30 次的字。
// 切切樂每 3 題有 1 題從這裡抽，讓前 50 名更快穩定。一天算一次。
let CAND_CACHE = null;
async function candWords(env) {
  if (CAND_CACHE && CAND_CACHE.day === eqToday()) return CAND_CACHE.words;
  let words = [];
  try {
    const rk = await rankWords(env, await wordOrigins(env), CAND_MIN);
    const pick = {};
    rk.rows.slice(29, 90).forEach(function (r) { pick[r.en] = 1; });
    rk.rows.slice(0, 300).forEach(function (r) { if (r.n < 30) pick[r.en] = 1; });
    words = Object.keys(pick).slice(0, 200);
  } catch (e) { words = []; }
  CAND_CACHE = { day: eqToday(), words: words };
  return words;
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
.golink.hot{border-color:var(--hot);background:#231f14;font-weight:600}
.golink.quiet{background:none;border:none;padding:0;margin:0 0 18px;color:var(--dim);font-size:12.5px}
.golink.quiet span{display:inline;font-size:12.5px;margin:0}
.golink.quiet span:before{content:" · "}
</style></head><body><main>
<h1>英文任務系統</h1>
<p class="sub">使用統計 · 匿名，不含任何個人資訊 · <span id="build">${BUILD}</span></p>
<div id="rpbox"></div>
<div id="bdbox"></div>
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

  // 有回報就跳出來，沒有就退成一行小字（刪光之後還是要找得到入口）
  var bb=document.getElementById("bdbox");
  if(bb){
    bb.innerHTML = '<a href="/board/admin" class="golink quiet">\uD83C\uDFC6 闖關榜管理'
      + '<span>改匿名或隱藏 \u00B7 需要密碼</span></a>';
  }
  var rb=document.getElementById("rpbox");
  if(rb){
    rb.innerHTML = d.reportCount
      ? '<a href="/reports" class="golink hot">\uD83D\uDCEC 有 '+d.reportCount+' 筆問題回報'
        + '<span>點這裡查看與刪除 \u2192</span></a>'
      : '<a href="/reports" class="golink quiet">\uD83D\uDCAC 問題回報'
        + '<span>目前沒有新的回報 \u00B7 需要密碼</span></a>';
  }
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

  /* --- 安裝率 --- */
  if(d.pwa&&d.pwa.people){
    var pw=d.pwa,PN=pw.people,PI=nz(pw.installed);
    h+='<h2>裝到主畫面</h2>';
    h+='<p class="hint">近 7 天回報過的 <b>'+PN+'</b> 人裡，有多少是從主畫面開啟的（也就是裝成 App）。'
      +'裝了的人資料不容易被瀏覽器清掉，所以他們的留存才是比較接近真實的數字。</p>';
    h+='<div class="cards">'
      + card(PI,"已安裝","從主畫面開啟的人","")
      + card(PN-PI,"未安裝","用瀏覽器開的人","")
      + card(pct(PI,PN),"安裝率","已安裝 ÷ 回報人數","")
      + '</div>';
    if(d.pwaCohort&&d.pwaCohort.length){
      h+='<table><tr><th>族群</th><th>人數</th><th>回來 2 天以上</th><th>回來 5 天以上</th><th>平均天數</th></tr>';
      d.pwaCohort.slice().sort(function(a,b){return (b.inst||0)-(a.inst||0);}).forEach(function(r){
        var N=r.people||0;
        h+='<tr><td>'+(r.inst?'已安裝':'未安裝')+'</td><td class="n">'+N+'</td>'
          +'<td class="n hot">'+pct(r.d2||0,N)+'</td>'
          +'<td class="n hot">'+pct(r.d5||0,N)+'</td>'
          +'<td class="n">'+nz(r.avgd)+'</td></tr>';
      });
      h+='</table>';
      h+='<p class="hint">兩邊差距如果很明顯，那「引導安裝」就是最值得做的一件事。'
        +'如果差不多，代表安裝沒那麼關鍵，力氣該花在別的地方。<br>'
        +'注意：<b>沒裝的人被低估了</b>——他們的 ID 被清掉之後會被算成新的人，'
        +'所以真實差距會比表上看到的小。</p>';
    }
  }

  /* --- 最常錯的字 --- */
  h+='<h2>最常錯的字</h2>';
  var wt=d.wordTotal||{};
  h+='<p class="hint">闖關、單字測驗、今日挑戰、切切樂全部算進來。切切樂有時間壓力，同一個字在那邊比較容易錯，所以先換算成同一把尺：「換算答錯率」＝這個字在闖關大概會錯幾 %。排序用換算後的 95% 下限，次數太少的字會自動往後排。「原始」是全部直接加總的答錯率，給你參考。出現不到 50 次（參考量太低）、還有地獄字（不在國中小 2000 字內）不列入。「原第 N 關」是舊玩家看到的關卡編號；10/31 之後的新玩家，同難度內的關卡順序是打亂的。</p>';
  if(d.wordModes&&d.wordModes.length){
    var MN={old:"舊資料（分模式前）",stage:"闖關",quiz:"單字測驗",chal:"今日挑戰",slice:"切切樂"};
    h+='<div class="wrap"><table><tr><th>模式</th><th>出現</th><th>答錯率</th><th>校正</th></tr>';
    d.wordModes.forEach(function(m){
      h+='<tr><td>'+(MN[m.mode]||m.mode)+'</td><td class="n">'+nz(m.shown)+'</td><td class="n">'+(m.shown?m.pct+'%':'—')+'</td><td class="n">'+(m.adj===null?(m.shown?'資料不夠，先不校正':'—'):(m.adj>0?'+':'')+m.adj)+'</td></tr>';
    });
    h+='</table></div><p class="hint">「校正」是這個模式比「看英文選中文」難多少（log-odds）。正數＝比較容易錯，排名時會扣掉。一個模式累積滿 300 次才開始校正。</p>';
  }
  if(wt.words){
    h+='<div class="cards">'
      + card(nz(wt.words),"已收集單字","有紀錄的字數（滿 2122 就是全部）","")
      + card(nz(wt.ready),"列入排名","出現滿 50 次、參與排名的字",(wt.growing?nz(wt.growing)+" 字累積中":""))
      + card(wt.shown?pct(wt.wrong||0,wt.shown):"—","整體答錯率","全部答錯 ÷ 全部出現",(wt.wrong||0)+" 錯 / "+(wt.shown||0)+" 次")
      + '</div>';
  }
  if(d.hardWords&&d.hardWords.length){
    var LV={basic:"基礎",advanced:"進階",hell:"地獄"};
    h+='<div class="wrap"><table><tr><th>#</th><th>單字</th><th>換算答錯率</th><th>原始</th><th>出現</th></tr>';
    d.hardWords.forEach(function(r,i){
      var src=[];
      if(r.stage) src.push("原第 "+r.stage+" 關"+(LV[r.lvl]?"・"+LV[r.lvl]:""));
      if(r.chal&&r.chal.length) src.push("挑戰 "+r.chal.join("、"));
      h+='<tr><td class="n">'+(i+1)+'</td><td>'+r.en
        +(src.length?'<div style="font-size:11.5px;opacity:.6;margin-top:2px">'+src.join("｜")+'</div>':'')
        +'</td><td class="n hot">'+r.est+'%</td><td class="n">'+r.pct+'%<div style="font-size:11px;opacity:.6">'+r.wrong+' 錯</div></td><td class="n">'+r.shown+(r.slice?'<div style="font-size:11px;opacity:.6">切切樂 '+r.slice+'</div>':'')+'</td></tr>';
    });
    h+='</table></div>';
  }else{
    h+='<p class="hint">還沒有單字出現滿 50 次。切切樂的「待確認名單」會優先把快到門檻的字補上來。</p>';
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
