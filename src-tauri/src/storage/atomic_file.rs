use crate::{error::CommandError, platform};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishState {
    NotPublished,
    Published,
    PublishedButSyncFailed,
    RecoveryRequired,
}

#[derive(Debug)]
pub struct PublishFailure {
    state: PublishState,
    error: CommandError,
    cleanup_source: bool,
}

impl PublishFailure {
    pub fn not_published(error: CommandError) -> Self {
        Self {
            state: PublishState::NotPublished,
            error,
            cleanup_source: true,
        }
    }

    pub fn not_published_preserve_source(error: CommandError) -> Self {
        Self {
            state: PublishState::NotPublished,
            error,
            cleanup_source: false,
        }
    }

    pub fn published_but_sync_failed(error: CommandError) -> Self {
        Self {
            state: PublishState::PublishedButSyncFailed,
            error,
            cleanup_source: false,
        }
    }

    pub fn recovery_required(error: CommandError) -> Self {
        Self {
            state: PublishState::RecoveryRequired,
            error,
            cleanup_source: false,
        }
    }

    pub fn state(&self) -> PublishState {
        self.state
    }

    pub fn error(&self) -> &CommandError {
        &self.error
    }

    pub fn code(&self) -> crate::error::CommandErrorCode {
        self.error.code()
    }

    pub fn into_error(self) -> CommandError {
        self.error
    }

    pub fn cleanup_source(&self) -> bool {
        self.cleanup_source
    }
}

pub type PublishResult = Result<PublishState, PublishFailure>;

pub fn atomic_replace(path: &Path, bytes: &[u8]) -> PublishResult {
    atomic_replace_with_hook(path, bytes, platform::replace_file)
}

pub fn atomic_replace_contained(
    root: &Path,
    directory_segments: &[&str],
    file_name: &str,
    bytes: &[u8],
) -> PublishResult {
    atomic_replace_contained_with_hook(root, directory_segments, file_name, bytes, |_| Ok(()))
}

#[doc(hidden)]
pub fn atomic_replace_contained_with_hook<F>(
    root: &Path,
    directory_segments: &[&str],
    file_name: &str,
    bytes: &[u8],
    before_publish: F,
) -> PublishResult
where
    F: FnOnce(&Path) -> Result<(), CommandError>,
{
    let directory = platform::SafeDirectory::open(root, directory_segments, true)
        .map_err(PublishFailure::not_published)?;
    let temporary_name = format!(".{file_name}.{}.tmp", Uuid::now_v7());
    let temporary_path = directory
        .child_path(&temporary_name)
        .map_err(PublishFailure::not_published)?;
    let mut owned_identity = None;
    let result: PublishResult = (|| {
        let mut file = directory
            .create_new(&temporary_name)
            .map_err(PublishFailure::not_published)?;
        owned_identity =
            Some(FileIdentity::from_file(&file).map_err(PublishFailure::not_published)?);
        file.write_all(bytes).map_err(|source| {
            PublishFailure::not_published(CommandError::io(format!(
                "could not write contained temporary file: {source}"
            )))
        })?;
        file.sync_all().map_err(|source| {
            PublishFailure::not_published(CommandError::io(format!(
                "could not sync contained temporary file: {source}"
            )))
        })?;
        drop(file);
        let parent = temporary_path
            .parent()
            .ok_or_else(|| CommandError::validation("contained temporary has no parent"))
            .map_err(PublishFailure::not_published)?;
        before_publish(parent).map_err(PublishFailure::not_published)?;
        match directory.publish(&temporary_name, file_name) {
            Ok(PublishState::Published) => match directory.sync() {
                Ok(()) => Ok(PublishState::Published),
                Err(error) => Err(PublishFailure::published_but_sync_failed(error)),
            },
            other => other,
        }
    })();
    if matches!(&result, Err(failure) if failure.state == PublishState::NotPublished && failure.cleanup_source)
        && owned_identity.is_some_and(|identity| same_file_identity(&temporary_path, identity))
    {
        directory.remove(&temporary_name);
    }
    result
}

/// Performs the real create-new/write/sync flow while allowing deterministic
/// replacement failure injection in integration tests.
#[doc(hidden)]
pub fn atomic_replace_with_hook<F>(path: &Path, bytes: &[u8], replace: F) -> PublishResult
where
    F: FnOnce(&Path, &Path) -> PublishResult,
{
    let parent = path.parent().ok_or_else(|| {
        PublishFailure::not_published(CommandError::validation("document has no parent directory"))
    })?;
    fs::create_dir_all(parent).map_err(|source| {
        PublishFailure::not_published(CommandError::io(format!(
            "could not create document directory: {source}"
        )))
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| {
            PublishFailure::not_published(CommandError::validation("document has no file name"))
        })?
        .to_string_lossy();
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::now_v7()));

    let mut owned_identity = None;
    let result: PublishResult = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|source| {
                PublishFailure::not_published(CommandError::io(format!(
                    "could not create temporary document: {source}"
                )))
            })?;
        owned_identity =
            Some(FileIdentity::from_file(&file).map_err(PublishFailure::not_published)?);
        file.write_all(bytes).map_err(|source| {
            PublishFailure::not_published(CommandError::io(format!(
                "could not write temporary document: {source}"
            )))
        })?;
        file.sync_all().map_err(|source| {
            PublishFailure::not_published(CommandError::io(format!(
                "could not sync temporary document: {source}"
            )))
        })?;
        drop(file);
        let published = replace(&temporary, path);
        match published {
            Ok(PublishState::Published) => match platform::sync_parent(parent) {
                Ok(()) => Ok(PublishState::Published),
                Err(error) => Err(PublishFailure::published_but_sync_failed(error)),
            },
            Ok(other) => Ok(other),
            Err(failure) => Err(failure),
        }
    })();

    if matches!(&result, Err(failure) if failure.state == PublishState::NotPublished && failure.cleanup_source)
        && owned_identity.is_some_and(|identity| same_file_identity(&temporary, identity))
    {
        // This exact name was created by this operation. Never sweep siblings.
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    first: u64,
    second: u64,
}

impl FileIdentity {
    #[cfg(unix)]
    fn from_file(file: &fs::File) -> Result<Self, CommandError> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|source| {
            CommandError::io(format!("could not inspect temporary document: {source}"))
        })?;
        Ok(Self {
            first: metadata.dev(),
            second: metadata.ino(),
        })
    }

    #[cfg(windows)]
    fn from_file(file: &fs::File) -> Result<Self, CommandError> {
        use std::os::windows::io::AsRawHandle;
        let mut info = ByHandleFileInformation::default();
        let succeeded =
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) };
        if succeeded == 0 {
            return Err(CommandError::io(format!(
                "could not inspect temporary document identity: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self {
            first: u64::from(info.volume_serial_number),
            second: (u64::from(info.file_index_high) << 32) | u64::from(info.file_index_low),
        })
    }
}

fn same_file_identity(path: &Path, expected: FileIdentity) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return false;
    }
    fs::File::open(path)
        .ok()
        .and_then(|file| FileIdentity::from_file(&file).ok())
        .is_some_and(|identity| identity == expected)
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct ByHandleFileInformation {
    file_attributes: u32,
    creation_time_low: u32,
    creation_time_high: u32,
    last_access_time_low: u32,
    last_access_time_high: u32,
    last_write_time_low: u32,
    last_write_time_high: u32,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetFileInformationByHandle(
        file: *mut core::ffi::c_void,
        information: *mut ByHandleFileInformation,
    ) -> i32;
}
