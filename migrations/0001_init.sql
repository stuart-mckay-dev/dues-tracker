-- DuesTracker initial schema.
-- See docs/DATA-MODEL.md for the reasoning behind each constraint.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- statuses: a reference table rather than a CHECK enum, because whether a
-- status accrues dues is a club policy decision the treasurer can change in
-- Settings without a migration. (DECISIONS.md D9)
-- ---------------------------------------------------------------------------
CREATE TABLE statuses (
  code         TEXT PRIMARY KEY,
  label        TEXT    NOT NULL,
  accrues_dues INTEGER NOT NULL DEFAULT 1 CHECK (accrues_dues IN (0, 1)),
  sort_order   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO statuses (code, label, accrues_dues, sort_order) VALUES
  ('active',    'Active',              1, 10),
  ('prospect',  'Prospect',            1, 20),
  ('suspended', 'Suspended',           1, 30),
  ('inactive',  'Inactive / on leave', 0, 40),
  ('lifetime',  'Lifetime / exempt',   0, 50);

-- ---------------------------------------------------------------------------
-- members
-- ---------------------------------------------------------------------------
CREATE TABLE members (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  nickname          TEXT,
  email             TEXT,
  phone             TEXT,
  status            TEXT NOT NULL REFERENCES statuses(code),

  -- First period this member is charged for. Setting this to the NEXT period
  -- is what makes new members non-retroactive; setting it backwards lets
  -- catch-up post the intervening months for someone entered late.
  dues_start_period TEXT NOT NULL CHECK (dues_start_period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),

  joined_on         TEXT CHECK (joined_on IS NULL OR joined_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes             TEXT,

  -- Archive rather than delete: a departed member's ledger stays intact for
  -- the record, but they leave the roster and stop accruing.
  archived_at       TEXT,

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX ix_members_active ON members (archived_at, display_name);

-- ---------------------------------------------------------------------------
-- transactions: the ledger itself.
--
-- amount_cents is ALWAYS positive; `direction` carries the sign. This is what
-- makes the two-column ledger render trivially (each row lands in one column
-- by its direction, no negative numbers displayed) and makes "negative debit"
-- states unrepresentable.
--
-- The `% 100 = 0` constraint enforces the whole-dollar rule at the storage
-- layer, so no future import script or manual `d1 execute` can introduce a
-- stray 83c. Whole dollars are what keep credit/dues an exact number of
-- months. (DECISIONS.md D6)
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id                TEXT    PRIMARY KEY,
  member_id         TEXT    NOT NULL REFERENCES members(id) ON DELETE CASCADE,

  kind              TEXT    NOT NULL CHECK (kind IN (
                              'dues_charge', 'misc_debit',
                              'payment', 'reimbursement_credit',
                              'opening_balance')),
  direction         TEXT    NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0 AND amount_cents % 100 = 0),

  occurred_on       TEXT    NOT NULL CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- Set on dues charges only; the period the charge covers.
  period            TEXT    CHECK (period IS NULL OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),

  method            TEXT    CHECK (method IS NULL OR method IN ('cash', 'venmo', 'zelle', 'check', 'other')),
  memo              TEXT,

  -- Records that the entry was typed in months rather than dollars. Kept for
  -- display only; never used in arithmetic.
  entered_as_months INTEGER CHECK (entered_as_months IS NULL OR entered_as_months > 0),

  voided_at         TEXT,
  void_reason       TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),

  -- direction must follow from kind; opening_balance legitimately goes either way
  CHECK (
    (kind IN ('dues_charge', 'misc_debit')          AND direction = 'debit')  OR
    (kind IN ('payment', 'reimbursement_credit')    AND direction = 'credit') OR
    (kind = 'opening_balance')
  ),

  -- A dues charge always declares the month it covers, and nothing else claims
  -- one. The idempotency index below depends on this holding.
  CHECK ((kind = 'dues_charge') = (period IS NOT NULL)),

  -- Payment method is only meaningful on money actually received.
  CHECK (method IS NULL OR kind = 'payment')
);

-- THE most important line in the schema. Makes double-charging impossible at
-- the storage layer rather than merely unlikely in application logic: a cron
-- firing twice, a retried request, a "Post dues now" tap after the cron
-- already ran, or two open browser tabs all collapse into a no-op.
--
-- This is what lets the accrual job be a naive "insert everything missing"
-- loop that is safe to run at any frequency -- which is what makes catch-up
-- self-healing. (DECISIONS.md D5)
--
-- The voided_at clause frees a period to be re-posted after a bad posting is
-- voided.
CREATE UNIQUE INDEX ux_dues_once ON transactions (member_id, period)
  WHERE kind = 'dues_charge' AND voided_at IS NULL;

CREATE INDEX ix_tx_member   ON transactions (member_id, occurred_on);
CREATE INDEX ix_tx_occurred ON transactions (occurred_on);
CREATE INDEX ix_tx_live     ON transactions (voided_at);

-- ---------------------------------------------------------------------------
-- settings: key/value so adding one never needs a migration.
-- Thresholds are in cents rather than months so they stay correct when
-- reimbursements and misc debits move a balance off an exact multiple of dues.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO settings (key, value) VALUES
  ('monthly_dues_cents',           '2500'),   -- placeholder; set the real rate in Settings
  ('warn_threshold_cents',         '15000'),  -- 6 months at the placeholder rate
  ('bad_standing_threshold_cents', '45000'),  -- 18 months at the placeholder rate
  ('club_timezone',                'America/Los_Angeles'),
  ('club_name',                    ''),
  ('posting_rule',                 'first_saturday_plus_5');

-- ---------------------------------------------------------------------------
-- posting_runs: one row per period actually posted. A catch-up run covering
-- 20 months writes 20 rows. This is the audit trail for the automatic
-- behaviour -- what you check when a member insists they were charged twice.
-- ---------------------------------------------------------------------------
CREATE TABLE posting_runs (
  id           TEXT    PRIMARY KEY,
  period       TEXT    NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  posting_date TEXT    NOT NULL,
  posted_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  member_count INTEGER NOT NULL,
  total_cents  INTEGER NOT NULL,
  triggered_by TEXT    NOT NULL CHECK (triggered_by IN ('cron', 'manual'))
);

CREATE INDEX ix_posting_period ON posting_runs (period);

-- ---------------------------------------------------------------------------
-- audit_log: every mutation. actor_email comes from the verified
-- Cf-Access-Authenticated-User-Email header, so attribution is free and needs
-- no users table.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor_email TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT
);

CREATE INDEX ix_audit_at ON audit_log (at DESC);
