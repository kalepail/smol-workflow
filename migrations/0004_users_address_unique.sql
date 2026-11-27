-- Applied on live smol-d1 and recorded in its d1_migrations ledger.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_address_unique ON Users("Address");
