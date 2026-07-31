CREATE TABLE schema_migrations (
    version INTEGER NOT NULL PRIMARY KEY CHECK (version > 0),
    applied_at TEXT NOT NULL
);

CREATE TABLE folders (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    parent_id BLOB CHECK (parent_id IS NULL OR length(parent_id) = 16),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES folders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    UNIQUE (parent_id, name)
);

CREATE UNIQUE INDEX folders_root_name_unique
    ON folders(name)
    WHERE parent_id IS NULL;
CREATE INDEX folders_parent_sort_order
    ON folders(parent_id, sort_order, name);

CREATE TABLE notes (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    kind TEXT NOT NULL CHECK (kind IN ('formal', 'temporary')),
    title TEXT NOT NULL,
    folder_id BLOB CHECK (folder_id IS NULL OR length(folder_id) = 16),
    relative_path TEXT NOT NULL UNIQUE CHECK (length(relative_path) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX notes_folder_updated
    ON notes(folder_id, updated_at DESC);
CREATE INDEX notes_kind_deleted_updated
    ON notes(kind, deleted_at, updated_at DESC);

CREATE TABLE tags (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    normalized_name TEXT NOT NULL UNIQUE CHECK (length(normalized_name) > 0)
);

CREATE TABLE note_tags (
    note_id BLOB NOT NULL CHECK (length(note_id) = 16),
    tag_id BLOB NOT NULL CHECK (length(tag_id) = 16),
    PRIMARY KEY (note_id, tag_id),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE INDEX note_tags_tag_id ON note_tags(tag_id, note_id);

CREATE TABLE note_links (
    source_note_id BLOB NOT NULL CHECK (length(source_note_id) = 16),
    target_note_id BLOB NOT NULL CHECK (length(target_note_id) = 16),
    visible_label TEXT NOT NULL,
    source_start INTEGER NOT NULL CHECK (source_start >= 0),
    source_end INTEGER NOT NULL CHECK (source_end > source_start),
    PRIMARY KEY (source_note_id, source_start),
    FOREIGN KEY (source_note_id) REFERENCES notes(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    FOREIGN KEY (target_note_id) REFERENCES notes(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX note_links_target ON note_links(target_note_id, source_note_id);

CREATE TABLE temporary_windows (
    note_id BLOB NOT NULL PRIMARY KEY CHECK (length(note_id) = 16),
    visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL CHECK (width > 0),
    height REAL NOT NULL CHECK (height > 0),
    always_on_top INTEGER NOT NULL DEFAULT 1 CHECK (always_on_top IN (0, 1)),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE TABLE search_documents (
    note_id BLOB NOT NULL PRIMARY KEY CHECK (length(note_id) = 16),
    title TEXT NOT NULL,
    plain_text TEXT NOT NULL,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON UPDATE RESTRICT ON DELETE CASCADE
);
