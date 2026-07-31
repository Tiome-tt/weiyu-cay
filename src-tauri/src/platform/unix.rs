use crate::error::CommandError;
use std::{fs, path::Path};

pub fn replace_file(source: &Path, destination: &Path) -> Result<(), CommandError> {
    fs::rename(source, destination).map_err(|error| {
        CommandError::io(format!("could not atomically replace document: {error}"))
    })
}

pub fn sync_parent(parent: &Path) -> Result<(), CommandError> {
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| CommandError::io(format!("could not sync document directory: {error}")))
}
