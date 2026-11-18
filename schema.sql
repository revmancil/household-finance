-- Household finance: Plaid items, accounts, transactions and daily balance snapshots.
-- Plaid amounts: positive = money out of the account, negative = money in.

CREATE TABLE IF NOT EXISTS items (
  item_id          TEXT PRIMARY KEY,
  institution_id   TEXT,
  institution_name TEXT,
  access_token_enc TEXT NOT NULL,          -- AES-GCM encrypted with ENC_KEY
  cursor           TEXT,                   -- /transactions/sync cursor
  status           TEXT NOT NULL DEFAULT 'ok',   -- ok | login_required | error
  error_code       TEXT,
  error_message    TEXT,
  last_synced_at   TEXT,
  logo             TEXT,                   -- base64 PNG from Plaid institution metadata (may be null)
  primary_color    TEXT,
  logo_checked_at  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id     TEXT PRIMARY KEY,
  item_id        TEXT NOT NULL,
  name           TEXT,
  official_name  TEXT,
  mask           TEXT,                     -- last 4 only
  type           TEXT,                     -- depository | credit | loan | investment
  subtype        TEXT,
  current        REAL,
  available      REAL,
  credit_limit   REAL,
  currency       TEXT,
  hidden         INTEGER NOT NULL DEFAULT 0,
  nickname       TEXT,
  purpose        TEXT,                     -- what the account is for (set by hand)
  keep_min       REAL,                     -- balance to keep in it, if any
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id    TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  date              TEXT NOT NULL,          -- YYYY-MM-DD posted (or pending) date
  authorized_date   TEXT,
  name              TEXT,
  merchant_name     TEXT,
  amount            REAL NOT NULL,          -- + out, - in
  currency          TEXT,
  category          TEXT,                   -- Plaid personal_finance_category.primary
  category_detailed TEXT,
  payment_channel   TEXT,
  pending           INTEGER NOT NULL DEFAULT 0,
  logo_url          TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, date);

CREATE TABLE IF NOT EXISTS balance_history (
  account_id TEXT NOT NULL,
  date       TEXT NOT NULL,
  current    REAL,
  available  REAL,
  PRIMARY KEY (account_id, date)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  item_id TEXT,
  ok      INTEGER NOT NULL,
  added   INTEGER DEFAULT 0,
  modified INTEGER DEFAULT 0,
  removed INTEGER DEFAULT 0,
  detail  TEXT
);
