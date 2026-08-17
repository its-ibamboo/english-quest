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
