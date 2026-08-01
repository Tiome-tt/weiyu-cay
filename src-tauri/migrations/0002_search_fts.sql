CREATE VIRTUAL TABLE search_documents_fts USING fts5(
    note_id UNINDEXED,
    title,
    plain_text,
    tokenize = 'trigram'
);

CREATE TABLE search_index_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    needs_rebuild INTEGER NOT NULL CHECK(needs_rebuild IN (0, 1))
) STRICT;

INSERT INTO search_index_state (singleton, needs_rebuild)
VALUES (1, CASE WHEN EXISTS(SELECT 1 FROM notes) THEN 1 ELSE 0 END);
