CREATE VIRTUAL TABLE search_documents_fts USING fts5(
    note_id UNINDEXED,
    title,
    plain_text,
    tokenize = 'trigram'
);

INSERT INTO search_documents_fts (note_id, title, plain_text)
SELECT note_id, title, plain_text FROM search_documents;
