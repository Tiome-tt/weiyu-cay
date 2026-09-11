ALTER TABLE notes ADD COLUMN content_type TEXT NOT NULL DEFAULT 'markdown' CHECK(content_type IN ('markdown','document','text','file'));
