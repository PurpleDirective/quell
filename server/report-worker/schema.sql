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

-- Quell usage counts (POST /api/quell/events): sent only by installs whose user
-- ticked the first-run box. No IP, no user-agent, no timestamp finer than the UTC
-- day, no URL/domain/search/page data (the schema has nowhere to put any).
--
-- One row per (install, UTC day): lets "active installs" be counted, and makes a
-- replayed POST a no-op. `install_id` is a random uuid the extension made; it
-- is deleted from the extension when the user turns counts off. Purged after
-- 90 days. events/errors are the small JSON the client sent, already validated.
CREATE TABLE IF NOT EXISTS quell_install_days (
  install_id TEXT    NOT NULL,
  day        TEXT    NOT NULL,       -- YYYY-MM-DD (UTC)
  version    TEXT    NOT NULL,
  browser    TEXT    NOT NULL,       -- chrome | firefox | opera
  sw_enabled INTEGER NOT NULL,
  sw_ai      INTEGER NOT NULL,
  sw_cookies INTEGER NOT NULL,
  sw_popups  INTEGER NOT NULL,
  sw_engines INTEGER NOT NULL,
  sw_reject  INTEGER NOT NULL,
  hides_ai      INTEGER NOT NULL DEFAULT 0,
  hides_cookies INTEGER NOT NULL DEFAULT 0,
  hides_popups  INTEGER NOT NULL DEFAULT 0,
  events_json TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX IF NOT EXISTS quell_install_days_day ON quell_install_days (day);

-- Aggregates per (day, version, browser). No install id. Kept 180 days.
CREATE TABLE IF NOT EXISTS quell_daily (
  day     TEXT    NOT NULL,
  version TEXT    NOT NULL,
  browser TEXT    NOT NULL,
  installs      INTEGER NOT NULL DEFAULT 0,   -- active installs that day
  sw_enabled    INTEGER NOT NULL DEFAULT 0,   -- how many had each switch on
  sw_ai         INTEGER NOT NULL DEFAULT 0,
  sw_cookies    INTEGER NOT NULL DEFAULT 0,
  sw_popups     INTEGER NOT NULL DEFAULT 0,
  sw_engines    INTEGER NOT NULL DEFAULT 0,
  sw_reject     INTEGER NOT NULL DEFAULT 0,
  hides_ai      INTEGER NOT NULL DEFAULT 0,
  hides_cookies INTEGER NOT NULL DEFAULT 0,
  hides_popups  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version, browser)
);
CREATE INDEX IF NOT EXISTS quell_daily_day ON quell_daily (day);

CREATE TABLE IF NOT EXISTS quell_events (
  day     TEXT NOT NULL,
  version TEXT NOT NULL,
  browser TEXT NOT NULL,
  name    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version, browser, name)
);
CREATE INDEX IF NOT EXISTS quell_events_day ON quell_events (day);

-- Error text is scrubbed of URLs by the client and again by the Worker.
CREATE TABLE IF NOT EXISTS quell_errors (
  day     TEXT NOT NULL,
  version TEXT NOT NULL,
  browser TEXT NOT NULL,
  source  TEXT NOT NULL,             -- file name only
  message TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version, browser, source, message)
);
CREATE INDEX IF NOT EXISTS quell_errors_day ON quell_errors (day);
