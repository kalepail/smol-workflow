-- Migration 0001: Support nullable Song_2 (1-track Smols) and provider provenance columns.
-- Note: Cloudflare D1 executes each migration file inside a transaction automatically;
-- do not include explicit BEGIN/COMMIT statements here.
-- Columns are copied strictly by name because live D1 column order around Instrumental
-- differs from fresh schema.sql. Historical rows keep NULL provider provenance
-- (no unconditional backfill).

CREATE TABLE Smols_v3 (
    Id TEXT PRIMARY KEY,
    Title TEXT NOT NULL,
    Song_1 TEXT NOT NULL,
    Song_2 TEXT DEFAULT NULL,
    Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
    Public BOOLEAN DEFAULT 1,
    Instrumental BOOLEAN DEFAULT 0,
    Plays INTEGER DEFAULT 0,
    Views INTEGER DEFAULT 0,
    "Address" TEXT NOT NULL,
    Mint_Token TEXT DEFAULT NULL,
    Mint_Amm TEXT DEFAULT NULL,
    Requested_Provider TEXT DEFAULT NULL CHECK(Requested_Provider IN ('aisonggenerator', 'elevenlabs')),
    Actual_Provider TEXT DEFAULT NULL CHECK(Actual_Provider IN ('aisonggenerator', 'elevenlabs'))
);

INSERT INTO Smols_v3 (
    Id,
    Title,
    Song_1,
    Song_2,
    Created_At,
    Public,
    Instrumental,
    Plays,
    Views,
    "Address",
    Mint_Token,
    Mint_Amm
)
SELECT
    Id,
    Title,
    Song_1,
    NULLIF(Song_2, ''),
    Created_At,
    Public,
    Instrumental,
    Plays,
    Views,
    "Address",
    Mint_Token,
    Mint_Amm
FROM Smols;

DROP TABLE Smols;

ALTER TABLE Smols_v3 RENAME TO Smols;

CREATE INDEX IF NOT EXISTS idx_smols_public_created
ON Smols(Public, Created_At DESC, Id DESC);

CREATE INDEX IF NOT EXISTS idx_smols_address_created
ON Smols("Address", Created_At DESC, Id DESC);

CREATE INDEX IF NOT EXISTS idx_smols_artist_public_created
ON Smols("Address", Public, Created_At DESC, Id DESC);

CREATE INDEX IF NOT EXISTS idx_smols_song_1
ON Smols(Song_1);

CREATE INDEX IF NOT EXISTS idx_smols_song_2
ON Smols(Song_2);
