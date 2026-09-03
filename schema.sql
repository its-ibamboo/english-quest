-- 在 Cloudflare 後台 → D1 → eq-stats → Console 貼上執行一次即可

CREATE TABLE IF NOT EXISTS events (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   INTEGER NOT NULL,   -- 毫秒時間戳
  day  TEXT    NOT NULL,   -- YYYY-MM-DD（台北時間）
  aid  TEXT    NOT NULL,   -- 匿名隨機 ID，無法對應到個人
  ev   TEXT    NOT NULL,   -- open | mode
  mode TEXT               -- flash / quiz / grammar / scramble / adventure / badges / bee
);

CREATE INDEX IF NOT EXISTS idx_events_day  ON events(day);
CREATE INDEX IF NOT EXISTS idx_events_aid  ON events(aid);
CREATE INDEX IF NOT EXISTS idx_events_mode ON events(mode);

-- 註：events.ev 現在有三種值：
--   open  進站
--   mode  切換模式（mode 欄位存模式名稱）
--   diff  切換難度（mode 欄位存 basic / advanced / hell / all）
-- 難度共用 mode 欄位，既有查詢都有 WHERE ev='mode'，不會互相污染。

-- 被複製的網域偵測。一個網域只會有一列，不會無限增長。
-- Worker 第一次收到回報時會自動建立，這裡留一份給手動建立用。
CREATE TABLE IF NOT EXISTS copies (
  host       TEXT PRIMARY KEY,   -- 回報的網域名稱
  first_seen INTEGER NOT NULL,   -- 第一次看到的時間（毫秒）
  last_seen  INTEGER NOT NULL,   -- 最後一次看到的時間
  hits       INTEGER NOT NULL    -- 累計開啟次數
);

-- 單字答對答錯統計。一個單字一列，upsert 累加，最多 2122 列，不會無限成長。
-- 只存聚合，不存明細 —— 存明細會讓 events 表爆掉，存聚合不會。
-- shown 是「這個字出現過幾次」，wrong 是「答錯幾次」。
-- 排名必須用 wrong / shown 的比率，不能用 wrong 的絕對值：
-- 前端的 weightedRandomIndex 會讓答錯過的字出現得更頻繁，
-- 只看絕對次數的話，排出來的是「被抽到最多次的字」而不是「最難的字」。
CREATE TABLE IF NOT EXISTS word_stats (
  en    TEXT PRIMARY KEY,
  shown INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0
);
