use crate::{
    domain::{NoteId, NoteKind},
    error::CommandError,
    platform,
};
use std::{
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct StoragePaths {
    root: PathBuf,
    notes: PathBuf,
    temporary: PathBuf,
    trash: PathBuf,
    folders_manifest: PathBuf,
    database: PathBuf,
}

impl StoragePaths {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, CommandError> {
        let requested_root = root.as_ref();
        if requested_root.as_os_str().is_empty() {
            return Err(CommandError::validation("storage root is empty"));
        }

        fs::create_dir_all(requested_root).map_err(|source| {
            CommandError::io(format!("could not create storage root: {source}"))
        })?;
        let root = requested_root.canonicalize().map_err(|source| {
            CommandError::io(format!("could not resolve storage root: {source}"))
        })?;
        if !root.is_dir() {
            return Err(CommandError::validation("storage root is not a directory"));
        }

        let notes = ensure_directory(&root, "notes")?;
        let temporary = ensure_directory(&root, "temporary")?;
        let trash = ensure_directory(&root, "trash")?;
        let folders_manifest = child_under(&root, &["folders.json"])?;
        let database = child_under(&root, &["index.sqlite"])?;
        platform::SafeDirectory::open(&root, &[], false)?.recover("index.sqlite")?;

        Ok(Self {
            root,
            notes,
            temporary,
            trash,
            folders_manifest,
            database,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn notes(&self) -> &Path {
        &self.notes
    }

    pub fn temporary(&self) -> &Path {
        &self.temporary
    }

    pub fn trash(&self) -> &Path {
        &self.trash
    }

    pub fn folders_manifest(&self) -> &Path {
        &self.folders_manifest
    }

    pub fn database(&self) -> &Path {
        &self.database
    }

    pub fn note_dir(&self, id: NoteId, kind: NoteKind) -> Result<PathBuf, CommandError> {
        let collection = match kind {
            NoteKind::Formal => "notes",
            NoteKind::Temporary => "temporary",
        };
        self.child(&[collection, &id.to_string()])
    }

    pub fn assets_dir(&self, id: NoteId, kind: NoteKind) -> Result<PathBuf, CommandError> {
        let collection = match kind {
            NoteKind::Formal => "notes",
            NoteKind::Temporary => "temporary",
        };
        self.child(&[collection, &id.to_string(), "assets"])
    }

    pub fn trash_note_dir(&self, id: NoteId) -> Result<PathBuf, CommandError> {
        self.child(&["trash", &id.to_string()])
    }

    pub fn child(&self, segments: &[&str]) -> Result<PathBuf, CommandError> {
        child_under(&self.root, segments)
    }
}

pub fn child_under(root: &Path, segments: &[&str]) -> Result<PathBuf, CommandError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|source| CommandError::io(format!("could not resolve storage root: {source}")))?;
    let mut path = canonical_root.clone();

    for segment in segments {
        validate_segment(segment)?;
        path.push(segment);
        validate_existing_path(&canonical_root, &path)?;
    }

    Ok(path)
}

fn validate_segment(segment: &str) -> Result<(), CommandError> {
    let path = Path::new(segment);
    let mut components = path.components();
    let single_normal = matches!(components.next(), Some(Component::Normal(value)) if value == segment)
        && components.next().is_none();
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.contains(['/', '\\', ':', '\0'])
        || !single_normal
    {
        return Err(CommandError::validation("invalid storage path segment"));
    }
    Ok(())
}

fn validate_existing_path(root: &Path, path: &Path) -> Result<(), CommandError> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let resolved = path.canonicalize().map_err(|_| {
                CommandError::validation("storage path could not be resolved safely")
            })?;
            if !resolved.starts_with(root) {
                return Err(CommandError::validation(
                    "storage path escapes the data root",
                ));
            }
        }
        Err(source) if source.kind() == ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CommandError::io(format!(
                "could not inspect storage path: {source}"
            )));
        }
    }
    Ok(())
}

fn ensure_directory(root: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let path = child_under(root, &[name])?;
    match fs::symlink_metadata(&path) {
        Ok(_) if path.is_dir() => {}
        Ok(_) => {
            return Err(CommandError::validation(
                "storage layout entry is not a directory",
            ))
        }
        Err(source) if source.kind() == ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|source| {
                CommandError::io(format!("could not create storage directory: {source}"))
            })?;
        }
        Err(source) => {
            return Err(CommandError::io(format!(
                "could not inspect storage directory: {source}"
            )));
        }
    }
    validate_existing_path(root, &path)?;
    Ok(path)
}
