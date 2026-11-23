-- Migration 0002: Mixtape lifecycle, derived visibility, and owner management.
-- Note: Cloudflare D1 executes each migration file inside a transaction automatically;
-- do not include explicit BEGIN/COMMIT statements here.
--
-- Purely additive: every existing column (including the legacy CSV `Smols`) and the
-- immutable `Id` are untouched, so the currently deployed worker keeps working
-- before and after this migration. Apply it BEFORE deploying the worker that reads
-- these columns.
--
-- Visibility is DERIVED (Tier 1 deterministic rubric + optional Tier 2 clef-flash
-- verdict, see src/utils/mixtape-visibility.ts). Public reads re-derive Tier 1 from
-- live Smols.Public on every request, so legacy rows that still carry the default
-- 'public' value are never leaked when they are duplicates or have no public songs.

ALTER TABLE Mixtapes ADD COLUMN Updated_At DATETIME DEFAULT NULL;
ALTER TABLE Mixtapes ADD COLUMN Deleted_At DATETIME DEFAULT NULL;
ALTER TABLE Mixtapes ADD COLUMN Visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (Visibility IN ('public', 'owner', 'deleted'));
ALTER TABLE Mixtapes ADD COLUMN Hidden_Reason TEXT DEFAULT NULL
    CHECK (Hidden_Reason IS NULL OR Hidden_Reason IN ('empty', 'duplicate', 'superseded', 'overlap', 'semantic_duplicate', 'too_few', 'merged', 'deleted'));
ALTER TABLE Mixtapes ADD COLUMN Related_Mixtape_Id TEXT DEFAULT NULL;
ALTER TABLE Mixtapes ADD COLUMN Uniqueness_Score INTEGER DEFAULT NULL
    CHECK (Uniqueness_Score IS NULL OR Uniqueness_Score BETWEEN 0 AND 100);
ALTER TABLE Mixtapes ADD COLUMN Ai_Verdict TEXT DEFAULT NULL;
ALTER TABLE Mixtapes ADD COLUMN Revision INTEGER NOT NULL DEFAULT 1
    CHECK (Revision >= 1);

UPDATE Mixtapes SET Updated_At = COALESCE(Created_At, CURRENT_TIMESTAMP) WHERE Updated_At IS NULL;

CREATE INDEX IF NOT EXISTS idx_mixtapes_visibility_created
ON Mixtapes(Visibility, Created_At DESC, Id DESC);

CREATE INDEX IF NOT EXISTS idx_mixtapes_address_created
ON Mixtapes("Address", Created_At DESC, Id DESC);

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
