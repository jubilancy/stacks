-- 0001_init.sql: the Stacks catalog. Books are just metadata plus a source URL.

CREATE TABLE books (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  author          TEXT    NOT NULL DEFAULT '',
  series          TEXT    NOT NULL DEFAULT '',
  series_index    REAL,
  url             TEXT    NOT NULL UNIQUE,
  format          TEXT    NOT NULL DEFAULT 'other',
  size_bytes      INTEGER,
  cover_url       TEXT    NOT NULL DEFAULT '',
  isbn            TEXT    NOT NULL DEFAULT '',
  year            INTEGER,
  publisher       TEXT    NOT NULL DEFAULT '',
  language        TEXT    NOT NULL DEFAULT '',
  description     TEXT    NOT NULL DEFAULT '',
  notes           TEXT    NOT NULL DEFAULT '',
  -- tags are stored as ",tag one,tag two," so a tag can be matched exactly
  tags            TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'reading', 'read')),
  rating          INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  favorite        INTEGER NOT NULL DEFAULT 0,
  -- 1 if the source server allows this site to read the file in the browser
  cors_ok         INTEGER,
  link_status     TEXT    NOT NULL DEFAULT 'unknown' CHECK (link_status IN ('unknown', 'ok', 'dead')),
  link_checked_at TEXT,
  http_status     INTEGER,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  archive_url     TEXT    NOT NULL DEFAULT '',
  added_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_books_format      ON books (format);
CREATE INDEX idx_books_status      ON books (status);
CREATE INDEX idx_books_link_status ON books (link_status);
CREATE INDEX idx_books_added_at    ON books (added_at);

-- Full-text search over the fields people actually search.
CREATE VIRTUAL TABLE books_fts USING fts5(
  title, author, series, tags, description, notes,
  content = 'books',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Keep the search index in sync with the books table.
CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
  INSERT INTO books_fts (rowid, title, author, series, tags, description, notes)
  VALUES (new.id, new.title, new.author, new.series, new.tags, new.description, new.notes);
END;

CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
  INSERT INTO books_fts (books_fts, rowid, title, author, series, tags, description, notes)
  VALUES ('delete', old.id, old.title, old.author, old.series, old.tags, old.description, old.notes);
END;

CREATE TRIGGER books_au AFTER UPDATE OF title, author, series, tags, description, notes ON books BEGIN
  INSERT INTO books_fts (books_fts, rowid, title, author, series, tags, description, notes)
  VALUES ('delete', old.id, old.title, old.author, old.series, old.tags, old.description, old.notes);
  INSERT INTO books_fts (rowid, title, author, series, tags, description, notes)
  VALUES (new.id, new.title, new.author, new.series, new.tags, new.description, new.notes);
END;
