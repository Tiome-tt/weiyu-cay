use crate::{
    commands::storage::{StorageCommandState, StorageConsumer},
    domain::{FolderId, NoteDocument, NoteId, NoteKind, SearchResult},
    error::CommandError,
    storage::{
        database::Database,
        paths::StoragePaths,
        rebuild::rebuild_index_strict_locked,
        repository::{
            normalized_tag_value, normalized_tags, note_id_from_blob, DocumentWriter,
            NoteRepository,
        },
    },
};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
};
use tauri::State;
use unicode_normalization::UnicodeNormalization;

const MAX_QUERY_LENGTH: usize = 256;
const MAX_RESULTS: usize = 100;
const EXCERPT_LENGTH: usize = 160;

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
        let guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        let requested = normalized_tags(&tags)?;
        let database = self.database_locked(&guard)?;
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
        drop(database);
        let repository = match self.writer {
            Some(writer) => NoteRepository::new_with_writer(self.paths.clone(), writer),
            None => NoteRepository::new(self.paths.clone()),
        };
        let mut document = repository.load_locked(note_id, &guard)?;
        if document.kind != NoteKind::Formal {
            return Err(CommandError::validation(
                "temporary captures cannot receive formal note tags",
            ));
        }
        let revision = document.revision;
        document.tags = canonical;
        repository.save_locked(document, revision, &guard)
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
        let context = load_search_context(
            database.connection(),
            rows.iter().map(|row| (row.0.clone(), row.2.clone())),
        )?;

        rows.into_iter()
            .map(|(id, title, folder_id, rank)| {
                let note_id = note_id_from_blob(&id)?;
                Ok(SearchResult {
                    note_id,
                    title,
                    folder_breadcrumb: context.folder_breadcrumb(folder_id.as_deref())?,
                    tags: context.tags_for(&id),
                    excerpt: String::new(),
                    score: 3.0 - rank as f64,
                })
            })
            .collect()
    }

    pub fn search_text(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, CommandError> {
        let query = normalize_text_query(query)?;
        let bounded_limit = limit.clamp(1, MAX_RESULTS);
        let database = self.database()?;
        let rows = if query.chars().count() >= 3 {
            search_fts(database.connection(), &query, bounded_limit)?
        } else {
            search_short(database.connection(), &query, bounded_limit)?
        };
        let context = load_search_context(
            database.connection(),
            rows.iter().map(|row| (row.0.clone(), row.2.clone())),
        )?;
        rows.into_iter()
            .map(|(id, title, folder_id, plain_text, score)| {
                let note_id = note_id_from_blob(&id)?;
                Ok(SearchResult {
                    note_id,
                    title,
                    folder_breadcrumb: context.folder_breadcrumb(folder_id.as_deref())?,
                    tags: context.tags_for(&id),
                    excerpt: excerpt(&plain_text, &query, EXCERPT_LENGTH),
                    score,
                })
            })
            .collect()
    }

    fn database(&self) -> Result<Database, CommandError> {
        let guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        self.database_locked(&guard)
    }

    fn database_locked(
        &self,
        guard: &crate::platform::IndexMutationLock,
    ) -> Result<Database, CommandError> {
        // Another process may have repaired the index before this caller acquired
        // the mutation lock, so state must always be checked again under the guard.
        let database = Database::open(self.paths.database())?;
        database.migrate()?;
        if !search_index_needs_rebuild(database.connection())?
            && !rebuild_marker_exists(&self.paths)?
        {
            return Ok(database);
        }
        drop(database);
        rebuild_index_strict_locked(&self.paths, guard)?;
        let rebuilt = Database::open(self.paths.database())?;
        rebuilt.migrate()?;
        if search_index_needs_rebuild(rebuilt.connection())? || rebuild_marker_exists(&self.paths)?
        {
            return Err(CommandError::database(
                "the rebuilt search index is incomplete",
            ));
        }
        Ok(rebuilt)
    }
}

fn rebuild_marker_exists(paths: &StoragePaths) -> Result<bool, CommandError> {
    match fs::symlink_metadata(paths.root().join("rebuild-needed.json")) {
        Ok(_) => Ok(true),
        Err(source) if source.kind() == ErrorKind::NotFound => Ok(false),
        Err(source) => Err(CommandError::io(format!(
            "could not inspect the index rebuild marker: {source}"
        ))),
    }
}

fn search_index_needs_rebuild(connection: &rusqlite::Connection) -> Result<bool, CommandError> {
    connection
        .query_row(
            "SELECT needs_rebuild FROM search_index_state WHERE singleton = 1",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(database_error("could not inspect full-text search index"))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SearchQuery {
    Tag { value: String },
    Text { value: String },
}

#[tauri::command(rename_all = "camelCase")]
pub fn search_notes(
    state: State<'_, StorageCommandState>,
    query: SearchQuery,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, CommandError> {
    match query {
        SearchQuery::Tag { value } => {
            SearchRepository::new(state.paths_for(StorageConsumer::Search)?.clone())
                .search_tag(&value, limit.unwrap_or(50))
        }
        SearchQuery::Text { value } => {
            SearchRepository::new(state.paths_for(StorageConsumer::Search)?.clone())
                .search_text(&value, limit.unwrap_or(50))
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_note_tags(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
    tags: Vec<String>,
) -> Result<NoteDocument, CommandError> {
    SearchRepository::new(state.paths_for(StorageConsumer::Search)?.clone())
        .update_tags(note_id, tags)
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

type TextSearchRow = (Vec<u8>, String, Option<Vec<u8>>, String, f64);

fn search_fts(
    connection: &rusqlite::Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<TextSearchRow>, CommandError> {
    // One quoted phrase makes all FTS operators and punctuation user literals.
    let literal_match = format!("\"{}\"", query.replace('"', "\"\""));
    let mut statement = connection.prepare(
        "SELECT n.id, n.title, n.folder_id, sd.plain_text, \
         CASE WHEN lower(sd.title) = lower(?2) THEN 3.0 \
              WHEN instr(lower(sd.title), lower(?2)) > 0 THEN 2.0 ELSE 1.0 END AS score, \
         CASE WHEN lower(sd.title) = lower(?2) THEN 0 \
              WHEN instr(lower(sd.title), lower(?2)) > 0 THEN 1 ELSE 2 END AS title_rank, \
         CASE WHEN instr(lower(sd.title), lower(?2)) > 0 THEN instr(lower(sd.title), lower(?2)) ELSE 2147483647 END AS title_position, \
         CASE WHEN instr(lower(sd.plain_text), lower(?2)) > 0 THEN instr(lower(sd.plain_text), lower(?2)) ELSE 2147483647 END AS body_position, \
         bm25(search_documents_fts, 8.0, 1.0) AS relevance \
         FROM search_documents_fts \
         JOIN notes n ON n.id = search_documents_fts.note_id \
         JOIN search_documents sd ON sd.note_id = n.id \
         WHERE search_documents_fts MATCH ?1 AND n.kind = 'formal' AND n.deleted_at IS NULL \
           AND (instr(lower(sd.title), lower(?2)) > 0 OR instr(lower(sd.plain_text), lower(?2)) > 0) \
         ORDER BY title_rank, title_position, relevance, body_position, n.updated_at DESC, n.id ASC, n.title ASC LIMIT ?3",
    ).map_err(database_error("could not prepare full-text search"))?;
    let rows = statement
        .query_map(
            params![literal_match, query, i64::try_from(limit).unwrap_or(100)],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(database_error("could not search full text"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error("could not read full-text search"))?;
    Ok(rows)
}

fn search_short(
    connection: &rusqlite::Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<TextSearchRow>, CommandError> {
    let contains = format!("%{}%", escape_like(query));
    let mut statement = connection.prepare(
        "SELECT n.id, n.title, n.folder_id, sd.plain_text, \
         CASE WHEN lower(sd.title) = lower(?1) THEN 3.0 \
              WHEN sd.title LIKE ?2 ESCAPE '\\' COLLATE NOCASE THEN 2.0 ELSE 1.0 END AS score, \
         CASE WHEN lower(sd.title) = lower(?1) THEN 0 \
              WHEN sd.title LIKE ?2 ESCAPE '\\' COLLATE NOCASE THEN 1 ELSE 2 END AS title_rank, \
         CASE WHEN instr(lower(sd.title), lower(?1)) > 0 THEN instr(lower(sd.title), lower(?1)) ELSE 2147483647 END AS title_position, \
         CASE WHEN instr(lower(sd.plain_text), lower(?1)) > 0 THEN instr(lower(sd.plain_text), lower(?1)) ELSE 2147483647 END AS body_position \
         FROM notes n JOIN search_documents sd ON sd.note_id = n.id \
         WHERE n.kind = 'formal' AND n.deleted_at IS NULL \
           AND (sd.title LIKE ?2 ESCAPE '\\' COLLATE NOCASE OR sd.plain_text LIKE ?2 ESCAPE '\\' COLLATE NOCASE) \
         ORDER BY title_rank, title_position, body_position, n.updated_at DESC, n.id ASC, n.title ASC LIMIT ?3",
    ).map_err(database_error("could not prepare short text search"))?;
    let rows = statement
        .query_map(
            params![query, contains, i64::try_from(limit).unwrap_or(100)],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(database_error("could not search short text"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error("could not read short text search"))?;
    Ok(rows)
}

fn normalize_text_query(input: &str) -> Result<String, CommandError> {
    let value: String = input.nfkc().collect();
    let value = value.trim_matches(crate::storage::repository::is_application_whitespace);
    if value.is_empty() {
        return Err(CommandError::validation("search query is empty"));
    }
    if value.chars().any(|character| {
        character.is_control() && !crate::storage::repository::is_application_whitespace(character)
    }) {
        return Err(CommandError::validation(
            "search query contains a control character",
        ));
    }
    if value.chars().count() > MAX_QUERY_LENGTH {
        return Err(CommandError::validation("search query is too long"));
    }
    Ok(value.to_owned())
}

fn excerpt(plain_text: &str, query: &str, maximum: usize) -> String {
    if plain_text.chars().nth(maximum).is_none() {
        return plain_text.to_owned();
    }
    let characters = plain_text.chars().collect::<Vec<_>>();
    let content_limit = maximum.saturating_sub(2).max(1);
    let match_character = find_match_character(plain_text, query).unwrap_or(0);
    let query_length = query.chars().count().min(content_limit);
    let start = match_character
        .saturating_sub((content_limit.saturating_sub(query_length)) / 2)
        .min(characters.len().saturating_sub(content_limit));
    let end = (start + content_limit).min(characters.len());
    let mut result = String::new();
    if start > 0 {
        result.push('…');
    }
    result.extend(characters[start..end].iter());
    if end < characters.len() {
        result.push('…');
    }
    result
}

fn find_match_character(text: &str, query: &str) -> Option<usize> {
    let byte = text.find(query).or_else(|| {
        query
            .is_ascii()
            .then(|| text.to_ascii_lowercase().find(&query.to_ascii_lowercase()))
            .flatten()
    })?;
    Some(text[..byte].chars().count())
}

struct FolderRecord {
    name: String,
    parent_id: Option<Vec<u8>>,
}

struct SearchContext {
    folders: HashMap<Vec<u8>, FolderRecord>,
    tags: HashMap<Vec<u8>, Vec<String>>,
}

fn load_search_context(
    connection: &Connection,
    rows: impl IntoIterator<Item = (Vec<u8>, Option<Vec<u8>>)>,
) -> Result<SearchContext, CommandError> {
    let mut unique_note_ids = Vec::new();
    let mut seen_note_ids = HashSet::new();
    let mut unique_folder_ids = Vec::new();
    let mut seen_folder_ids = HashSet::new();
    for (id, folder_id) in rows {
        if seen_note_ids.insert(id.clone()) {
            unique_note_ids.push(id);
        }
        if let Some(folder_id) = folder_id {
            if seen_folder_ids.insert(folder_id.clone()) {
                unique_folder_ids.push(folder_id);
            }
        }
    }
    if unique_note_ids.is_empty() {
        return Ok(SearchContext {
            folders: HashMap::new(),
            tags: HashMap::new(),
        });
    }

    let tag_sql = format!(
        "SELECT nt.note_id, t.display_name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id IN ({}) ORDER BY t.normalized_name, t.id",
        sql_placeholders(unique_note_ids.len()),
    );
    let tag_parameters = unique_note_ids
        .iter()
        .map(|id| id as &dyn ToSql)
        .collect::<Vec<_>>();
    let mut tag_statement = connection
        .prepare(&tag_sql)
        .map_err(database_error("could not prepare result tags"))?;
    let tag_rows = tag_statement
        .query_map(params_from_iter(tag_parameters), |row| {
            Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(database_error("could not query result tags"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error("could not read result tags"))?;
    let mut tags = HashMap::new();
    for (note_id, display_name) in tag_rows {
        tags.entry(note_id)
            .or_insert_with(Vec::new)
            .push(display_name);
    }

    let mut folders = HashMap::new();
    if !unique_folder_ids.is_empty() {
        let folder_sql = format!(
            "WITH RECURSIVE result_folders(id) AS ( SELECT id FROM folders WHERE id IN ({}) UNION SELECT folders.parent_id FROM folders JOIN result_folders ON folders.id = result_folders.id WHERE folders.parent_id IS NOT NULL ) SELECT folders.id, folders.name, folders.parent_id FROM folders JOIN result_folders ON result_folders.id = folders.id",
            sql_placeholders(unique_folder_ids.len()),
        );
        let folder_parameters = unique_folder_ids
            .iter()
            .map(|id| id as &dyn ToSql)
            .collect::<Vec<_>>();
        let mut folder_statement = connection
            .prepare(&folder_sql)
            .map_err(database_error("could not prepare folder context"))?;
        let folder_rows = folder_statement
            .query_map(params_from_iter(folder_parameters), |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<Vec<u8>>>(2)?,
                ))
            })
            .map_err(database_error("could not query folder context"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read folder context"))?;
        for (id, name, parent_id) in folder_rows {
            folders.insert(id, FolderRecord { name, parent_id });
        }
    }

    Ok(SearchContext { folders, tags })
}

fn sql_placeholders(count: usize) -> String {
    (0..count).map(|_| "?").collect::<Vec<_>>().join(", ")
}

impl SearchContext {
    fn tags_for(&self, note_id: &[u8]) -> Vec<String> {
        self.tags.get(note_id).cloned().unwrap_or_default()
    }

    fn folder_breadcrumb(&self, folder_id: Option<&[u8]>) -> Result<Vec<String>, CommandError> {
        let mut current = folder_id.map(valid_folder_blob).transpose()?;
        let mut reversed = Vec::new();
        let mut seen = HashSet::new();
        while let Some(id) = current {
            if !seen.insert(id.clone()) {
                return Err(CommandError::database(
                    "stored folder hierarchy contains a cycle",
                ));
            }
            let folder = self
                .folders
                .get(&id)
                .ok_or_else(|| CommandError::database("stored note folder is missing"))?;
            reversed.push(folder.name.clone());
            current = folder
                .parent_id
                .as_deref()
                .map(valid_folder_blob)
                .transpose()?;
        }
        reversed.reverse();
        Ok(reversed)
    }
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

#[cfg(test)]
mod tests {
    use super::{excerpt, EXCERPT_LENGTH};

    #[test]
    fn excerpt_returns_short_unicode_text_unchanged() {
        let text = "短文本 with Unicode";
        assert_eq!(excerpt(text, "文本", EXCERPT_LENGTH), text);
    }

    #[test]
    fn excerpt_clips_long_unicode_text_within_the_existing_contract() {
        let text = format!("{}匹配词{}", "前".repeat(120), "后".repeat(120));
        let result = excerpt(&text, "匹配词", EXCERPT_LENGTH);
        assert!(result.starts_with('…'));
        assert!(result.ends_with('…'));
        assert!(result.chars().count() <= EXCERPT_LENGTH + 2);
    }
}
