/* =============================================================
   英文任務系統 · Service Worker
   版本：v2026.09.03p

   策略：網路優先，離線才回快取（network-first, cache fallback）
   ------------------------------------------------------------
   為什麼不用「快取優先」：
   快取優先雖然開得快，但學生會卡在舊版本，而且沒有 CLI 可以
   遠端清除，出事很難補救。網路優先只在「真的連不上」時才拿
   快取，有訊號永遠是最新版，代價只是開啟時多幾十毫秒。

   注意：/t、/h、/admin 這幾支永遠不進快取，統計與偵測必須
   實時打到伺服器，離線時就讓它失敗，不要重送、不要留存。
   ============================================================= */

var SW_VERSION = "v2026.09.03p";
var CACHE = "eq-" + SW_VERSION;

// 不碰這些路徑：統計回報、複製偵測、後台
var BYPASS = ["/t", "/h", "/w", "/d", "/report", "/reports", "/admin", "/ping"];

self.addEventListener("install", function (e) {
  // 立刻換上新的 SW，不等舊分頁全部關掉
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      // 刪掉所有舊版本的快取，只留當前這一份
      return Promise.all(
        names.map(function (n) {
          return n === CACHE ? null : caches.delete(n);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;

  // 只處理 GET，其他一律放行
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 跨網域資源（例如 Cloudflare 分析）不快取
  if (url.origin !== self.location.origin) return;

  // 統計、偵測、後台一律直接走網路，不快取也不回舊資料
  for (var i = 0; i < BYPASS.length; i++) {
    if (url.pathname === BYPASS[i] || url.pathname.indexOf(BYPASS[i] + "/") === 0) return;
  }

  e.respondWith(
    fetch(req)
      .then(function (res) {
        // 只快取成功的同源回應
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(req, copy);
          }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        // 連不上網路，改用上一次存下來的
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          // 導覽請求（重新整理、從桌面開啟）退回首頁
          if (req.mode === "navigate") {
            return caches.match("./") ||
                   caches.match("/index.html") ||
                   caches.match("/");
          }
          return new Response("離線中", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        });
      })
  );
});
