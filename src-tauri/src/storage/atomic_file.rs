use crate::{error::CommandError, platform};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use uuid::Uuid;

pub fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    atomic_replace_with_hook(path, bytes, platform::replace_file)
}

/// Performs the real create-new/write/sync flow while allowing deterministic
/// replacement failure injection in integration tests.
#[doc(hidden)]
pub fn atomic_replace_with_hook<F>(
    path: &Path,
    bytes: &[u8],
    replace: F,
) -> Result<(), CommandError>
where
    F: FnOnce(&Path, &Path) -> Result<(), CommandError>,
{
    let parent = path
        .parent()
        .ok_or_else(|| CommandError::validation("document has no parent directory"))?;
    fs::create_dir_all(parent).map_err(|source| {
        CommandError::io(format!("could not create document directory: {source}"))
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| CommandError::validation("document has no file name"))?
        .to_string_lossy();
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::now_v7()));

    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|source| {
                CommandError::io(format!("could not create temporary document: {source}"))
            })?;
        file.write_all(bytes).map_err(|source| {
            CommandError::io(format!("could not write temporary document: {source}"))
        })?;
        file.sync_all().map_err(|source| {
            CommandError::io(format!("could not sync temporary document: {source}"))
        })?;
        drop(file);
        replace(&temporary, path)?;
        platform::sync_parent(parent)
    })();

    if result.is_err() {
        // This exact name was created by this operation. Never sweep siblings.
        let _ = fs::remove_file(&temporary);
    }
    result
}
