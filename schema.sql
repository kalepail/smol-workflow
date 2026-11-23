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
    Actual_Provider TEXT DEFAULT NULL CHECK(Actual_Provider IN ('aisonggenerator', 'elevenlabs')),
    Tags TEXT DEFAULT NULL
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
-- Finalized: 0 = classification in progress, 1 = classification committed, 2 = classification
-- failed. A concurrent replay waits for 1 (and reports the winner's final visibility), gets a
-- retryable 503 while 0 is fresh, and takes over recovery of the SAME row when 2 or abandoned.
CREATE TABLE IF NOT EXISTS MixtapeRetryClaim (
    Retry_Key TEXT PRIMARY KEY,
    Mixtape_Id TEXT NOT NULL,
    Created_At DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    Finalized INTEGER NOT NULL DEFAULT 0 CHECK (Finalized IN (0, 1, 2)),
    -- Fresh per ownership attempt (initial claim and every recovery takeover). Completion is only
    -- recorded by the attempt holding the current token, so an expired holder can never overwrite it.
    Attempt_Token TEXT NOT NULL DEFAULT ''
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

-- Mirrors migrations/0003_storage_query_optimization.sql.
CREATE INDEX IF NOT EXISTS idx_smols_minted_created
ON Smols(Created_At DESC, Id DESC) WHERE Mint_Token IS NOT NULL;

-- 0002 stores ordered membership in Mixtapes.Smols. Keep an ordered reverse index in sync
-- with every insert/edit/merge, including writes by the previous worker during rollout.
CREATE TABLE IF NOT EXISTS MixtapeMember (
    mix_id TEXT NOT NULL,
    smol_id TEXT NOT NULL,
    pos INTEGER NOT NULL,
    PRIMARY KEY (mix_id, smol_id)
);

CREATE INDEX IF NOT EXISTS idx_mixtape_member_smol
ON MixtapeMember(smol_id, mix_id);

CREATE VIEW IF NOT EXISTS MixtapeCsvMember AS
SELECT mix_id, smol_id, min(pos) AS pos
FROM (
    SELECT m.Id AS mix_id, CAST(j.key AS INTEGER) AS pos,
        trim(j.value, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS smol_id
    FROM Mixtapes m CROSS JOIN json_each(replace('[' || json_quote(m.Smols) || ']', ',', '","')) j
)
WHERE smol_id <> ''
GROUP BY mix_id, smol_id;

INSERT OR IGNORE INTO MixtapeMember (mix_id, smol_id, pos)
SELECT mix_id, smol_id, pos FROM MixtapeCsvMember;

CREATE TRIGGER IF NOT EXISTS trg_mixtape_member_insert
AFTER INSERT ON Mixtapes
BEGIN
    INSERT INTO MixtapeMember (mix_id, smol_id, pos)
    SELECT mix_id, smol_id, pos FROM MixtapeCsvMember WHERE mix_id = NEW.Id;
END;

CREATE TRIGGER IF NOT EXISTS trg_mixtape_member_update
AFTER UPDATE OF Smols ON Mixtapes
WHEN OLD.Smols IS NOT NEW.Smols
BEGIN
    DELETE FROM MixtapeMember WHERE mix_id = NEW.Id;
    INSERT INTO MixtapeMember (mix_id, smol_id, pos)
    SELECT mix_id, smol_id, pos FROM MixtapeCsvMember WHERE mix_id = NEW.Id;
END;

CREATE TRIGGER IF NOT EXISTS trg_mixtape_member_delete
AFTER DELETE ON Mixtapes
BEGIN
    DELETE FROM MixtapeMember WHERE mix_id = OLD.Id;
END;

-- Publish mint metadata under a new public cache key in the same D1 transaction.
CREATE TRIGGER IF NOT EXISTS trg_mixtape_epoch_smol_mint
AFTER UPDATE OF Mint_Token, Mint_Amm ON Smols
WHEN (OLD.Mint_Token IS NOT NEW.Mint_Token OR OLD.Mint_Amm IS NOT NEW.Mint_Amm)
AND EXISTS (SELECT 1 FROM MixtapeMember WHERE smol_id = NEW.Id)
BEGIN
    UPDATE MixtapeState SET Epoch = Epoch + 1 WHERE Id = 1;
END;

-- Wallet-scoped progress for status polling. Never store signed envelopes here.
CREATE TABLE IF NOT EXISTS MintBatchStatus (
    Workflow_Id TEXT PRIMARY KEY,
    "Address" TEXT NOT NULL,
    Ids TEXT NOT NULL,
    Phase TEXT NOT NULL DEFAULT 'unverified'
        CHECK (Phase IN ('unverified', 'existing', 'queued', 'submitting', 'submitted', 'confirmed', 'persisted', 'failed')),
    Tx_Hash TEXT,
    Confirmed_Ledger INTEGER
);
