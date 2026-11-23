-- Live smol-d1: apply this file using:
-- npx wrangler d1 execute smol-d1 --remote --file=migrations/0004_users_address_unique.sql
-- Never run wrangler d1 migrations apply on live smol-d1.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_address_unique ON Users("Address");
