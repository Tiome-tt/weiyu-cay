use crate::{
    commands::notes::NoteCommandState,
    domain::{FolderId, NoteDocument, NoteId, NoteKind, SearchResult},
    error::CommandError,
    storage::{
        database::Database,
        paths::StoragePaths,
        repository::{
            normalized_tag_value, normalized_tags, note_id_from_blob, DocumentWriter,
            NoteRepository,
        },
    },
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use std::collections::HashSet;
use tauri::State;

const MAX_QUERY_LENGTH: usize = 256;
const MAX_RESULTS: usize = 100;

pub struct SearchRepository {
    paths: StoragePaths,
    writer: Option<DocumentWriter>,
}

impl SearchRepository {
    pub fn new(paths: StoragePaths) -> Self {
        Self {
            paths,
            writer: None,
        }
    }

    #[doc(hidden)]
    pub fn new_with_writer(paths: StoragePaths, writer: DocumentWriter) -> Self {
        Self {
            paths,
            writer: Some(writer),
        }
    }

    pub fn update_tags(
        &self,
        note_id: NoteId,
        tags: Vec<String>,
    ) -> Result<NoteDocument, CommandError> {
        let requested = normalized_tags(&tags)?;
        let database = self.database()?;
        let mut canonical = Vec::with_capacity(requested.len());
        {
            let mut statement = database
                .connection()
                .prepare("SELECT display_name FROM tags WHERE normalized_name = ?1")
                .map_err(database_error("could not prepare canonical tag lookup"))?;
            for (display, normalized) in requested {
                let existing = statement
                    .query_row([normalized], |row| row.get::<_, String>(0))
                    .optional()
                    .map_err(database_error("could not resolve canonical tag display"))?;
                canonical.push(existing.unwrap_or(display));
            }
        }
        let repository = match self.writer {
            Some(writer) => NoteRepository::new_with_writer(self.paths.clone(), database, writer),
            None => NoteRepository::new(self.paths.clone(), database),
        };
        let mut document = repository.load(note_id)?;
        if document.kind != NoteKind::Formal {
            return Err(CommandError::validation(
                "temporary captures cannot receive formal note tags",
            ));
        }
        let revision = document.revision;
        document.tags = canonical;
        repository.save(document, revision)
    }

    pub fn search_tag(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, CommandError> {
        let normalized = normalize_query(query)?;
        let escaped = escape_like(&normalized);
        let contains = format!("%{escaped}%");
        let prefix = format!("{escaped}%");
        let bounded_limit = limit.clamp(1, MAX_RESULTS);
        let database = self.database()?;
        let mut statement = database.connection().prepare(
            "SELECT n.id, n.title, n.folder_id, MIN(CASE WHEN t.normalized_name = ?1 THEN 0 WHEN t.normalized_name LIKE ?2 ESCAPE '\\' THEN 1 ELSE 2 END) AS tag_rank \
             FROM notes n JOIN note_tags nt ON nt.note_id = n.id JOIN tags t ON t.id = nt.tag_id \
             WHERE n.kind = 'formal' AND n.deleted_at IS NULL AND t.normalized_name LIKE ?3 ESCAPE '\\' \
             GROUP BY n.id, n.title, n.folder_id, n.updated_at \
             ORDER BY tag_rank ASC, n.updated_at DESC, n.id ASC, n.title ASC LIMIT ?4",
        ).map_err(database_error("could not prepare tag search"))?;
        let rows = statement
            .query_map(
                params![
                    normalized,
                    prefix,
                    contains,
                    i64::try_from(bounded_limit).unwrap_or(100)
                ],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<Vec<u8>>>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .map_err(database_error("could not search tags"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read tag search"))?;

        rows.into_iter()
            .map(|(id, title, folder_id, rank)| {
                let note_id = note_id_from_blob(&id)?;
                Ok(SearchResult {
                    note_id,
                    title,
                    folder_breadcrumb: folder_breadcrumb(
                        database.connection(),
                        folder_id.as_deref(),
                    )?,
                    tags: note_tags(database.connection(), &id)?,
                    excerpt: String::new(),
                    score: 3.0 - rank as f64,
                })
            })
            .collect()
    }

    fn database(&self) -> Result<Database, CommandError> {
        let database = Database::open(self.paths.database())?;
        database.migrate()?;
        Ok(database)
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SearchQuery {
    Tag { value: String },
    Text { value: String },
}

#[tauri::command(rename_all = "camelCase")]
pub fn search_notes(
    state: State<'_, NoteCommandState>,
    query: SearchQuery,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, CommandError> {
    match query {
        SearchQuery::Tag { value } => {
            SearchRepository::new(state.paths().clone()).search_tag(&value, limit.unwrap_or(50))
        }
        SearchQuery::Text { value } => {
            let _ = value;
            Err(CommandError::unsupported(
                "text search is not available yet",
            ))
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_note_tags(
    state: State<'_, NoteCommandState>,
    note_id: NoteId,
    tags: Vec<String>,
) -> Result<NoteDocument, CommandError> {
    SearchRepository::new(state.paths().clone()).update_tags(note_id, tags)
}

fn normalize_query(input: &str) -> Result<String, CommandError> {
    normalized_tag_value(input, MAX_QUERY_LENGTH).map(|(_, normalized)| normalized)
}

fn escape_like(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn note_tags(
    connection: &rusqlite::Connection,
    note_id: &[u8],
) -> Result<Vec<String>, CommandError> {
    let mut statement = connection.prepare(
        "SELECT t.display_name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ?1 ORDER BY t.normalized_name, t.id",
    ).map_err(database_error("could not prepare result tags"))?;
    let tags = statement
        .query_map([note_id], |row| row.get(0))
        .map_err(database_error("could not query result tags"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error("could not read result tags"))?;
    Ok(tags)
}

fn folder_breadcrumb(
    connection: &rusqlite::Connection,
    folder_id: Option<&[u8]>,
) -> Result<Vec<String>, CommandError> {
    let mut current = folder_id.map(valid_folder_blob).transpose()?;
    let mut reversed = Vec::new();
    let mut seen = HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Err(CommandError::database(
                "stored folder hierarchy contains a cycle",
            ));
        }
        let row = connection
            .query_row(
                "SELECT name, parent_id FROM folders WHERE id = ?1",
                [&id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)),
            )
            .optional()
            .map_err(database_error("could not read folder breadcrumb"))?
            .ok_or_else(|| CommandError::database("stored note folder is missing"))?;
        reversed.push(row.0);
        current = row.1.as_deref().map(valid_folder_blob).transpose()?;
    }
    reversed.reverse();
    Ok(reversed)
}

fn valid_folder_blob(bytes: &[u8]) -> Result<Vec<u8>, CommandError> {
    let uuid = uuid::Uuid::from_slice(bytes).map_err(|source| {
        CommandError::database(format!("stored folder ID is invalid: {source}"))
    })?;
    FolderId::parse_str(&uuid.hyphenated().to_string()).map_err(|source| {
        CommandError::database(format!("stored folder ID is invalid: {source}"))
    })?;
    Ok(bytes.to_vec())
}

fn database_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> CommandError {
    move |source| CommandError::database(format!("{context}: {source}"))
}
