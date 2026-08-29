ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0);

CREATE INDEX notes_folder_sort_order
    ON notes(folder_id, sort_order, updated_at DESC, id);
