CREATE TABLE IF NOT EXISTS Smols (
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

CREATE TABLE IF NOT EXISTS Users (
    Username TEXT NOT NULL,
    "Address" TEXT NOT NULL,
    UNIQUE (Username, "Address")
);

CREATE TABLE IF NOT EXISTS Likes (
    Id TEXT NOT NULL,
    "Address" TEXT NOT NULL,
    UNIQUE (Id, "Address")
);

CREATE TABLE IF NOT EXISTS Playlists (
    Id TEXT NOT NULL,
    Title TEXT NOT NULL,
    UNIQUE (Id, Title)
);

CREATE TABLE IF NOT EXISTS Mixtapes (
    Id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    Title TEXT NOT NULL,
    Desc TEXT NOT NULL,
    Smols TEXT NOT NULL,
    "Address" TEXT NOT NULL,
    Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Lifecycle columns mirror migrations/0002_mixtapes_lifecycle.sql
    Updated_At DATETIME DEFAULT NULL,
    Deleted_At DATETIME DEFAULT NULL,
    Visibility TEXT NOT NULL DEFAULT 'public'
        CHECK (Visibility IN ('public', 'owner', 'deleted')),
    Hidden_Reason TEXT DEFAULT NULL
        CHECK (Hidden_Reason IS NULL OR Hidden_Reason IN ('empty', 'duplicate', 'superseded', 'overlap', 'semantic_duplicate', 'too_few', 'merged', 'deleted')),
    Related_Mixtape_Id TEXT DEFAULT NULL,
    Uniqueness_Score INTEGER DEFAULT NULL
        CHECK (Uniqueness_Score IS NULL OR Uniqueness_Score BETWEEN 0 AND 100),
    Ai_Verdict TEXT DEFAULT NULL,
    Revision INTEGER NOT NULL DEFAULT 1
        CHECK (Revision >= 1)
);

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

CREATE INDEX IF NOT EXISTS idx_likes_address_id
ON Likes("Address", Id);

CREATE INDEX IF NOT EXISTS idx_playlists_title_id
ON Playlists(Title, Id);

CREATE INDEX IF NOT EXISTS idx_mixtapes_created
ON Mixtapes(Created_At DESC, Id DESC);

CREATE INDEX IF NOT EXISTS idx_mixtapes_visibility_created
ON Mixtapes(Visibility, Created_At DESC, Id DESC);

CREATE INDEX IF NOT EXISTS idx_mixtapes_address_created
ON Mixtapes("Address", Created_At DESC, Id DESC);

CREATE INDEX IF NOT EXISTS idx_users_address
ON Users("Address");

-- Mirrors migrations/0002_mixtapes_lifecycle.sql.
-- Monotonic cache epoch for public mixtape reads. Public GET cache keys embed this value,
-- so a delayed in-flight GET can never refill the key that is current after a mutation.
-- Every mixtape write batch bumps it; the triggers below bump it when a song's public
-- state changes (songs are resolved live into every mixtape response).
-- Epoch >= 0 doubles as the abort switch for guarded write batches: a batch that must not
-- commit runs `UPDATE MixtapeState SET Epoch = -1 ...`, and the CHECK rolls everything back.
CREATE TABLE IF NOT EXISTS MixtapeState (
    Id INTEGER PRIMARY KEY CHECK (Id = 1),
    Epoch INTEGER NOT NULL DEFAULT 0 CHECK (Epoch >= 0)
);

INSERT OR IGNORE INTO MixtapeState (Id, Epoch) VALUES (1, 0);

-- Atomic idempotency claim for POST /mixtapes exact retries (15-minute window). The claim and
-- the Mixtapes INSERT run in one batch, so simultaneous identical creates never produce a
-- provisional duplicate row. Retry_Key = SHA-256(owner, ordered smols, normalized title/desc).
CREATE TABLE IF NOT EXISTS MixtapeRetryClaim (
    Retry_Key TEXT PRIMARY KEY,
    Mixtape_Id TEXT NOT NULL,
    Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mixtape_retry_claim_created
ON MixtapeRetryClaim(Created_At);

CREATE TRIGGER IF NOT EXISTS trg_mixtape_epoch_smol_public
AFTER UPDATE OF Public ON Smols
WHEN OLD.Public IS NOT NEW.Public
BEGIN
    UPDATE MixtapeState SET Epoch = Epoch + 1 WHERE Id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_mixtape_epoch_smol_delete
AFTER DELETE ON Smols
BEGIN
    UPDATE MixtapeState SET Epoch = Epoch + 1 WHERE Id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_mixtape_epoch_smol_insert
AFTER INSERT ON Smols
WHEN NEW.Public = 1 AND EXISTS (
    SELECT 1 FROM Mixtapes WHERE instr(',' || replace(Smols, ' ', '') || ',', ',' || NEW.Id || ',') > 0
)
BEGIN
    UPDATE MixtapeState SET Epoch = Epoch + 1 WHERE Id = 1;
END;
