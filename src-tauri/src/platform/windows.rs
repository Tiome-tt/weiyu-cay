use crate::{
    error::CommandError,
    storage::atomic_file::{PublishFailure, PublishResult, PublishState},
};
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::Read,
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    ptr,
};
use uuid::Uuid;

const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
const ERROR_UNABLE_TO_REMOVE_REPLACED: i32 = 1175;
const ERROR_UNABLE_TO_MOVE_REPLACEMENT: i32 = 1176;
const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: i32 = 1177;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

#[link(name = "kernel32")]
extern "system" {
    fn ReplaceFileW(
        replaced: *const u16,
        replacement: *const u16,
        backup: *const u16,
        flags: u32,
        exclude: *mut core::ffi::c_void,
        reserved: *mut core::ffi::c_void,
    ) -> i32;
    fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
}

pub fn replace_file(source: &Path, destination: &Path) -> PublishResult {
    let backup_storage = destination.with_file_name(format!(
        ".{}.{}.replace-backup",
        destination
            .file_name()
            .unwrap_or_else(|| OsStr::new("file"))
            .to_string_lossy(),
        Uuid::now_v7()
    ));
    let result = replace_file_with_backup(source, destination, &backup_storage);
    if matches!(result, Ok(PublishState::Published)) {
        let _ = std::fs::remove_file(&backup_storage);
    }
    result
}

pub fn replace_file_with_backup(
    source: &Path,
    destination: &Path,
    backup_storage: &Path,
) -> PublishResult {
    let destination_exists = destination.exists();
    let source = wide(source.as_os_str());
    let destination = wide(destination.as_os_str());
    let backup = wide(backup_storage.as_os_str());
    let succeeded = unsafe {
        if destination_exists {
            ReplaceFileW(
                destination.as_ptr(),
                source.as_ptr(),
                backup.as_ptr(),
                0,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if succeeded == 0 {
        let os_error = std::io::Error::last_os_error();
        let raw = os_error.raw_os_error().unwrap_or_default();
        let error = CommandError::io(format!("could not atomically replace document: {os_error}"));
        if classify_replace_error(raw) == ReplaceFailureAction::RestoreBackup && destination_exists
        {
            let restored = unsafe {
                MoveFileExW(
                    backup.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            return if restored != 0 {
                Err(PublishFailure::not_published(error))
            } else {
                Err(PublishFailure::not_published_preserve_source(error))
            };
        }
        if classify_replace_error(raw) == ReplaceFailureAction::OriginalNamesIntact {
            return Err(PublishFailure::not_published(error));
        }
        return Err(PublishFailure::not_published(error));
    }
    Ok(PublishState::Published)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplaceFailureAction {
    RestoreBackup,
    OriginalNamesIntact,
}

fn classify_replace_error(error: i32) -> ReplaceFailureAction {
    match error {
        ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 => ReplaceFailureAction::RestoreBackup,
        ERROR_UNABLE_TO_REMOVE_REPLACED | ERROR_UNABLE_TO_MOVE_REPLACEMENT => {
            ReplaceFailureAction::OriginalNamesIntact
        }
        _ => ReplaceFailureAction::OriginalNamesIntact,
    }
}

pub fn sync_parent(_parent: &Path) -> Result<(), CommandError> {
    // ReplaceFileW/MoveFileExW use write-through. Windows does not provide a
    // portable directory fsync equivalent for ordinary application handles.
    Ok(())
}

pub struct SafeDirectory {
    path: PathBuf,
    _pins: Vec<File>,
}

impl SafeDirectory {
    pub fn open(root: &Path, segments: &[&str], create: bool) -> Result<Self, CommandError> {
        let root = root.canonicalize().map_err(|source| {
            CommandError::io(format!("could not resolve safe directory root: {source}"))
        })?;
        let mut path = root;
        let mut pins = vec![open_pinned_directory(&path)?];
        for segment in segments {
            validate_child_name(segment)?;
            path.push(segment);
            if !path.exists() && create {
                fs::create_dir(&path).map_err(|source| {
                    CommandError::io(format!("could not create contained directory: {source}"))
                })?;
                sync_parent(path.parent().expect("created directory has parent"))?;
            }
            pins.push(open_pinned_directory(&path)?);
        }
        Ok(Self { path, _pins: pins })
    }

    pub fn child_path(&self, name: &str) -> Result<PathBuf, CommandError> {
        validate_child_name(name)?;
        Ok(self.path.join(name))
    }

    pub fn create_new(&self, name: &str) -> Result<File, CommandError> {
        let path = self.child_path(name)?;
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
            .map_err(|source| {
                CommandError::io(format!("could not create contained file: {source}"))
            })
    }

    pub fn read(&self, name: &str, max_bytes: u64) -> Result<Vec<u8>, CommandError> {
        let path = self.child_path(name)?;
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|source| {
                CommandError::io(format!("could not open contained file: {source}"))
            })?;
        let metadata = file.metadata().map_err(|source| {
            CommandError::io(format!("could not inspect contained file: {source}"))
        })?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !metadata.is_file() {
            return Err(CommandError::validation(
                "contained file is a reparse point or not a file",
            ));
        }
        if metadata.len() > max_bytes {
            return Err(CommandError::validation(
                "contained file exceeds the supported size",
            ));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes).map_err(|source| {
            CommandError::io(format!("could not read contained file: {source}"))
        })?;
        Ok(bytes)
    }

    pub fn publish(&self, source: &str, destination: &str) -> PublishResult {
        let source = match self.child_path(source) {
            Ok(path) => path,
            Err(error) => return Err(PublishFailure::not_published(error)),
        };
        let destination = match self.child_path(destination) {
            Ok(path) => path,
            Err(error) => return Err(PublishFailure::not_published(error)),
        };
        replace_file(&source, &destination)
    }

    pub fn remove(&self, name: &str) {
        if let Ok(path) = self.child_path(name) {
            let _ = fs::remove_file(path);
        }
    }

    pub fn sync(&self) -> Result<(), CommandError> {
        sync_parent(&self.path)
    }
}

fn open_pinned_directory(path: &Path) -> Result<File, CommandError> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|source| {
            CommandError::io(format!("could not pin contained directory: {source}"))
        })?;
    let metadata = file.metadata().map_err(|source| {
        CommandError::io(format!("could not inspect contained directory: {source}"))
    })?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !metadata.is_dir() {
        return Err(CommandError::validation(
            "contained directory is a reparse point or not a directory",
        ));
    }
    Ok(file)
}

fn validate_child_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err(CommandError::validation("invalid contained path segment"));
    }
    Ok(())
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::{classify_replace_error, ReplaceFailureAction};

    #[test]
    fn official_partial_replace_states_choose_recovery_before_cleanup() {
        assert_eq!(
            classify_replace_error(1177),
            ReplaceFailureAction::RestoreBackup
        );
        assert_eq!(
            classify_replace_error(1175),
            ReplaceFailureAction::OriginalNamesIntact
        );
        assert_eq!(
            classify_replace_error(1176),
            ReplaceFailureAction::OriginalNamesIntact
        );
        assert_eq!(
            classify_replace_error(87),
            ReplaceFailureAction::OriginalNamesIntact
        );
    }
}
