use crate::{
    domain::NoteId,
    error::CommandError,
    storage::{
        database::Database,
        paths::StoragePaths,
        repository::{note_id_blob, note_id_from_blob},
    },
};
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};

#[derive(Serialize)]
pub struct GraphNode {
    pub id: NoteId,
    pub title: String,
    pub distance: u8,
}
#[derive(Serialize)]
pub struct GraphEdge {
    pub source: NoteId,
    pub target: NoteId,
}
#[derive(Serialize)]
pub struct LinkNeighborhood {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

/// A bounded index projection: no note bodies or attachment payloads are opened.
pub fn neighborhood(paths: &StoragePaths, id: NoteId) -> Result<LinkNeighborhood, CommandError> {
    let _guard = crate::platform::IndexMutationLock::acquire(paths.root())?;
    let database = Database::open(paths.database())?;
    database.migrate()?;
    let connection = database.connection();
    let title = connection
        .query_row(
            "SELECT title FROM notes WHERE id=?1 AND kind='formal' AND deleted_at IS NULL",
            [note_id_blob(id)],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| CommandError::database("could not read graph root"))?;
    let mut result = LinkNeighborhood {
        nodes: Vec::new(),
        edges: Vec::new(),
        truncated: false,
    };
    let Some(title) = title else {
        return Ok(result);
    };
    result.nodes.push(GraphNode {
        id,
        title,
        distance: 0,
    });
    let mut known = HashSet::from([id]);
    let mut edges = HashSet::new();
    let mut queue = VecDeque::from([(id, 0u8)]);
    let mut query=connection.prepare("SELECT DISTINCT s.id,s.title,t.id,t.title FROM note_links l JOIN notes s ON s.id=l.source_note_id JOIN notes t ON t.id=l.target_note_id WHERE (l.source_note_id=?1 OR l.target_note_id=?1) AND s.kind='formal' AND t.kind='formal' AND s.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY s.title COLLATE NOCASE,s.id,t.title COLLATE NOCASE,t.id LIMIT 49").map_err(|_|CommandError::database("could not prepare graph query"))?;
    while let Some((current, distance)) = queue.pop_front() {
        if distance >= 2 {
            continue;
        }
        let rows = query
            .query_map([note_id_blob(current)], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|_| CommandError::database("could not query graph"))?;
        for (index, row) in rows.enumerate() {
            let (source, source_title, target, target_title) =
                row.map_err(|_| CommandError::database("could not read graph edge"))?;
            if index == 48 {
                result.truncated = true;
                break;
            }
            let source = note_id_from_blob(&source)?;
            let target = note_id_from_blob(&target)?;
            let (neighbor, title) = if source == current {
                (target, target_title)
            } else {
                (source, source_title)
            };
            if !known.contains(&neighbor) {
                if known.len() >= 24 || result.edges.len() >= 48 {
                    result.truncated = true;
                    continue;
                }
                known.insert(neighbor);
                result.nodes.push(GraphNode {
                    id: neighbor,
                    title,
                    distance: distance + 1,
                });
                queue.push_back((neighbor, distance + 1));
            }
            if edges.insert((source, target)) {
                if result.edges.len() >= 48 {
                    result.truncated = true;
                    continue;
                }
                result.edges.push(GraphEdge { source, target });
            }
        }
    }
    Ok(result)
}
