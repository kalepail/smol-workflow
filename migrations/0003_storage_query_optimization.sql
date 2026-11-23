-- Apply once through D1's migration ledger. SQLite has no ADD COLUMN IF NOT EXISTS.
-- For a manual rehearsal on a provisioned schema, skip the ALTER if pragma_table_info('Smols')
-- already contains Tags. The remaining statements can be replayed.
ALTER TABLE Smols ADD COLUMN Tags TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_smols_minted_created
ON Smols(Created_At DESC, Id DESC) WHERE Mint_Token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_playlists_title_id
ON Playlists(Title, Id);

CREATE INDEX IF NOT EXISTS idx_smols_artist_public_created
ON Smols("Address", Public, Created_At DESC, Id DESC);

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
    Phase TEXT NOT NULL DEFAULT 'queued'
        CHECK (Phase IN ('queued', 'submitting', 'submitted', 'confirmed', 'persisted', 'failed')),
    Tx_Hash TEXT,
    Confirmed_Ledger INTEGER
);

ANALYZE;
