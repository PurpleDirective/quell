-- Quell breakage reports: aggregate counts only. No IP, no user-agent, no
-- timestamp finer than the UTC day.
CREATE TABLE IF NOT EXISTS reports (
  day     TEXT    NOT NULL,          -- YYYY-MM-DD (UTC)
  host    TEXT    NOT NULL,          -- the reported site's hostname
  version TEXT    NOT NULL,          -- Quell version that reported it
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, host, version)
);
CREATE INDEX IF NOT EXISTS reports_day ON reports (day);
