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
CREATE TABLE IF NOT EXISTS MixtapeState (
    Id INTEGER PRIMARY KEY CHECK (Id = 1),
    Epoch INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO MixtapeState (Id, Epoch) VALUES (1, 0);

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
