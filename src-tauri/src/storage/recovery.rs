use crate::{
    domain::{NoteId, NoteKind},
    error::CommandError,
    platform::SafeDirectory,
    storage::{
        atomic_file::{atomic_replace_contained, PublishFailure, PublishState},
        paths::StoragePaths,
        rebuild::rebuild_index_strict_locked,
        repository::parse_document,
    },
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use uuid::Uuid;

const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupRecoveryReport {
    pub recovered: Vec<RecoveredCandidate>,
    pub quarantined: Vec<QuarantinedCandidate>,
    pub ambiguous: Vec<String>,
    pub index_rebuilt: bool,
    pub index_quarantine: Option<IndexQuarantine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexQuarantine {
    pub database: String,
    pub sidecars: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredCandidate {
    pub note_id: NoteId,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedCandidate {
    pub note_id: NoteId,
    pub candidate: String,
    pub reason: &'static str,
}

pub fn recover_startup(paths: &StoragePaths) -> Result<StartupRecoveryReport, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(paths.root())?;
    let mut report = StartupRecoveryReport {
        recovered: Vec::new(),
        quarantined: Vec::new(),
        ambiguous: Vec::new(),
        index_rebuilt: false,
        index_quarantine: None,
    };
    for (collection, expected_kind) in [
        ("notes", NoteKind::Formal),
        ("temporary", NoteKind::Temporary),
    ] {
        scan_collection(paths, collection, expected_kind, &mut report)?;
    }
    let root = SafeDirectory::open(paths.root(), &[], false)?;
    let index_invalid = !index_is_complete_and_readable(paths);
    let has_rebuild_marker = root.regular_file_exists("rebuild-needed.json")?;
    let has_recovery_marker = root.regular_file_exists("recovery-needed.json")?;
    if !report.recovered.is_empty() {
        write_rebuild_marker(paths)?;
    }
    if index_invalid || has_rebuild_marker || has_recovery_marker || !report.recovered.is_empty() {
        if index_invalid {
            report.index_quarantine = quarantine_invalid_index(&root)?;
        }
        let before = root.entry_names()?;
        rebuild_index_strict_locked(paths, &guard)?;
        if report.index_quarantine.is_none() {
            let after = root.entry_names()?;
            report.index_quarantine = find_index_quarantine(&before, &after);
        }
        report.index_rebuilt = true;
        if root.regular_file_exists("recovery-needed.json")? {
            root.remove_checked("recovery-needed.json")?;
            root.sync()?;
        }
    }
    Ok(report)
}

fn index_is_complete_and_readable(paths: &StoragePaths) -> bool {
    let Ok(connection) = Connection::open_with_flags(
        paths.database(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return false;
    };
    let quick_check = connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0));
    if !matches!(quick_check.as_deref(), Ok("ok")) {
        return false;
    }
    [
        "schema_migrations",
        "notes",
        "folders",
        "tags",
        "note_tags",
        "note_links",
        "temporary_windows",
        "search_documents",
        "search_documents_fts",
    ]
    .into_iter()
    .all(|table| {
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type IN ('table', 'view') AND name=?1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .is_ok_and(|count| count == 1)
    })
}

fn quarantine_invalid_index(root: &SafeDirectory) -> Result<Option<IndexQuarantine>, CommandError> {
    let operation_id = Uuid::now_v7();
    let quarantine_name = format!(".index.sqlite.{operation_id}.quarantine");
    let mut moved: Vec<(String, String)> = Vec::new();
    for (source, destination) in [
        ("index.sqlite".to_owned(), quarantine_name.clone()),
        (
            "index.sqlite-wal".to_owned(),
            format!("{quarantine_name}-wal"),
        ),
        (
            "index.sqlite-shm".to_owned(),
            format!("{quarantine_name}-shm"),
        ),
    ] {
        if !root.regular_file_exists(&source)? {
            continue;
        }
        if let Err(error) = root.move_file(&source, &destination) {
            for (original, quarantined) in moved.iter().rev() {
                let _ = root.move_file(quarantined, original);
            }
            let _ = root.sync();
            return Err(error);
        }
        moved.push((source, destination));
    }
    if moved.is_empty() {
        return Ok(None);
    }
    root.sync()?;
    let database = moved
        .iter()
        .find(|(source, _)| source == "index.sqlite")
        .map(|(_, destination)| destination.clone())
        .ok_or_else(|| {
            CommandError::validation("index sidecars exist without an index database")
        })?;
    let mut sidecars = moved
        .into_iter()
        .filter(|(source, _)| source != "index.sqlite")
        .map(|(_, destination)| destination)
        .collect::<Vec<_>>();
    sidecars.sort();
    Ok(Some(IndexQuarantine { database, sidecars }))
}

fn write_rebuild_marker(paths: &StoragePaths) -> Result<(), CommandError> {
    atomic_replace_contained(
        paths.root(),
        &[],
        "rebuild-needed.json",
        br#"{"reason":"startup_content_recovery"}"#,
    )
    .map(|_| ())
    .map_err(PublishFailure::into_error)
}

fn find_index_quarantine(before: &[String], after: &[String]) -> Option<IndexQuarantine> {
    let mut created = after
        .iter()
        .filter(|name| !before.contains(name))
        .filter(|name| name.starts_with(".index.sqlite.") && name.contains(".rebuild-backup"))
        .cloned()
        .collect::<Vec<_>>();
    created.sort();
    let database = created
        .iter()
        .find(|name| name.ends_with(".rebuild-backup"))?
        .clone();
    let mut sidecars = created
        .into_iter()
        .filter(|name| name != &database)
        .collect::<Vec<_>>();
    sidecars.sort();
    Some(IndexQuarantine { database, sidecars })
}

fn scan_collection(
    paths: &StoragePaths,
    collection_name: &str,
    expected_kind: NoteKind,
    report: &mut StartupRecoveryReport,
) -> Result<(), CommandError> {
    let collection = SafeDirectory::open(paths.root(), &[collection_name], false)?;
    for owner_name in collection.entry_names()? {
        let Ok(owner_id) = NoteId::parse_str(&owner_name) else {
            continue;
        };
        let directory = match collection.open_child(&owner_name, false) {
            Ok(directory) => directory,
            Err(_) => continue,
        };
        recover_note_directory(&directory, owner_id, expected_kind, report)?;
    }
    Ok(())
}

struct Candidate {
    name: String,
    revision: u64,
}

fn recover_note_directory(
    directory: &SafeDirectory,
    owner_id: NoteId,
    expected_kind: NoteKind,
    report: &mut StartupRecoveryReport,
) -> Result<(), CommandError> {
    // Complete the existing Windows replace descriptor before considering unrelated orphans.
    directory.recover("note.md")?;
    let canonical_revision = read_candidate(directory, "note.md", owner_id, expected_kind)
        .ok()
        .map(|candidate| candidate.revision);
    let candidate_names = directory
        .entry_names()?
        .into_iter()
        .filter(|name| is_abandoned_candidate(name))
        .collect::<Vec<_>>();
    if candidate_names.is_empty() {
        return Ok(());
    }

    let mut valid = Vec::new();
    for name in &candidate_names {
        match read_candidate(directory, name, owner_id, expected_kind) {
            Ok(candidate) if candidate.revision <= i64::MAX as u64 => valid.push(candidate),
            _ => quarantine(directory, owner_id, name, "invalid", report)?,
        }
    }
    let Some(highest) = valid.iter().map(|candidate| candidate.revision).max() else {
        return Ok(());
    };
    let highest_names = valid
        .iter()
        .filter(|candidate| candidate.revision == highest)
        .map(|candidate| candidate.name.clone())
        .collect::<Vec<_>>();
    let should_promote =
        highest_names.len() == 1 && canonical_revision.is_none_or(|revision| highest > revision);
    if highest_names.len() > 1 {
        report.ambiguous.push(owner_id.to_string());
    }
    for candidate in valid {
        if should_promote && candidate.name == highest_names[0] {
            continue;
        }
        let reason = if highest_names.len() > 1 {
            "ambiguous"
        } else {
            "superseded"
        };
        quarantine(directory, owner_id, &candidate.name, reason, report)?;
    }
    if should_promote {
        match directory.publish(&highest_names[0], "note.md") {
            Ok(PublishState::Published) => report.recovered.push(RecoveredCandidate {
                note_id: owner_id,
                revision: highest,
            }),
            Ok(state) => {
                return Err(CommandError::io(format!(
                    "startup candidate publication returned invalid state: {state:?}"
                )))
            }
            Err(failure) => return Err(failure.into_error()),
        }
    }
    Ok(())
}

fn read_candidate(
    directory: &SafeDirectory,
    name: &str,
    owner_id: NoteId,
    expected_kind: NoteKind,
) -> Result<Candidate, CommandError> {
    let bytes = directory.read(name, MAX_DOCUMENT_BYTES)?;
    let contents = String::from_utf8(bytes)
        .map_err(|_| CommandError::validation("recovery candidate is not UTF-8"))?;
    let document = parse_document(&contents)?;
    if document.id != owner_id || document.kind != expected_kind {
        return Err(CommandError::validation(
            "recovery candidate identity does not match its owner",
        ));
    }
    Ok(Candidate {
        name: name.to_owned(),
        revision: document.revision,
    })
}

fn is_abandoned_candidate(name: &str) -> bool {
    let Some(identity) = name.strip_prefix(".note.md.").and_then(|rest| {
        rest.strip_suffix(".tmp")
            .or_else(|| rest.strip_suffix(".save"))
    }) else {
        return false;
    };
    Uuid::parse_str(identity).is_ok()
}

fn quarantine(
    directory: &SafeDirectory,
    note_id: NoteId,
    candidate: &str,
    reason: &'static str,
    report: &mut StartupRecoveryReport,
) -> Result<(), CommandError> {
    let destination = format!("quarantined-recovery-{}.invalid", Uuid::now_v7());
    directory.quarantine_entry_no_follow(candidate, &destination)?;
    report.quarantined.push(QuarantinedCandidate {
        note_id,
        candidate: candidate.to_owned(),
        reason,
    });
    Ok(())
}
