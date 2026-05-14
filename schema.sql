-- ALTER TABLE Smols ADD COLUMN Instrumental BOOLEAN DEFAULT 0;

-- DROP TABLE IF EXISTS Mixtapes;

CREATE TABLE IF NOT EXISTS Smols (
    Id TEXT PRIMARY KEY,
    Title TEXT NOT NULL,
    Song_1 TEXT NOT NULL,
    Song_2 TEXT NOT NULL,
    Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
    Public BOOLEAN DEFAULT 1,
    Instrumental BOOLEAN DEFAULT 0,
    Plays INTEGER DEFAULT 0,
    Views INTEGER DEFAULT 0,
    "Address" TEXT NOT NULL,
    Mint_Token TEXT DEFAULT NULL,
    Mint_Amm TEXT DEFAULT NULL
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
    Created_At DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smols_public_created
ON Smols(Public, Created_At DESC, Id DESC);

CREATE INDEX IF NOT EXISTS idx_smols_address_created
ON Smols("Address", Created_At DESC, Id DESC);

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

CREATE INDEX IF NOT EXISTS idx_users_address
ON Users("Address");
