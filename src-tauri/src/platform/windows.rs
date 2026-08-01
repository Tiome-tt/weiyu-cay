use super::NewFilePublishState;
use crate::{
    error::CommandError,
    storage::atomic_file::{PublishFailure, PublishResult, PublishState},
};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    ptr, thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
const ERROR_UNABLE_TO_REMOVE_REPLACED: i32 = 1175;
const ERROR_UNABLE_TO_MOVE_REPLACEMENT: i32 = 1176;
const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: i32 = 1177;
const ERROR_FILE_EXISTS: i32 = 80;
const ERROR_ALREADY_EXISTS: i32 = 183;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_SHARE_DELETE: u32 = 0x0000_0004;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;
const INDEX_LOCK: &str = ".index-mutation.lock";
const INDEX_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const INDEX_LOCK_MAX_BACKOFF: Duration = Duration::from_millis(25);

#[derive(Debug)]
pub struct IndexMutationLock {
    // Fields drop in declaration order: release the exclusive file before
    // releasing the directory pin that prevents root replacement.
    _file: File,
    _root: SafeDirectory,
}

impl IndexMutationLock {
    pub fn acquire(root: &Path) -> Result<Self, CommandError> {
        Self::acquire_with_timeout(root, INDEX_LOCK_TIMEOUT)
    }

    #[doc(hidden)]
    pub fn acquire_with_timeout(root: &Path, timeout: Duration) -> Result<Self, CommandError> {
        Self::acquire_with_timeout_using(root, timeout, || {})
    }

    #[cfg(test)]
    fn acquire_with_timeout_and_hook<F>(
        root: &Path,
        timeout: Duration,
        after_pin: F,
    ) -> Result<Self, CommandError>
    where
        F: FnOnce(),
    {
        Self::acquire_with_timeout_using(root, timeout, after_pin)
    }

    fn acquire_with_timeout_using<F>(
        root: &Path,
        timeout: Duration,
        after_pin: F,
    ) -> Result<Self, CommandError>
    where
        F: FnOnce(),
    {
        let safe_root = SafeDirectory::open(root, &[], false)?;
        after_pin();
        let started = Instant::now();
        let mut backoff = Duration::from_millis(1);
        loop {
            let opened = safe_root.open_exclusive_lock(INDEX_LOCK);
            match opened {
                Ok(file) => {
                    let attributes = file
                        .metadata()
                        .map_err(|source| {
                            CommandError::io(format!(
                                "could not inspect index mutation lock: {source}"
                            ))
                        })?
                        .file_attributes();
                    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                        return Err(CommandError::validation(
                            "index mutation lock must not be a reparse point",
                        ));
                    }
                    return Ok(Self {
                        _file: file,
                        _root: safe_root,
                    });
                }
                Err(source) if is_lock_contention(&source) && started.elapsed() < timeout => {
                    let remaining = timeout.saturating_sub(started.elapsed());
                    thread::sleep(backoff.min(remaining));
                    backoff = backoff.saturating_mul(2).min(INDEX_LOCK_MAX_BACKOFF);
                }
                Err(source) if is_lock_contention(&source) => {
                    return Err(CommandError::conflict(format!(
                        "index mutation lock is busy: {source}"
                    )))
                }
                Err(source) => {
                    return Err(CommandError::io(format!(
                        "could not open index mutation lock: {source}"
                    )))
                }
            }
        }
    }
}

fn is_lock_contention(source: &std::io::Error) -> bool {
    matches!(
        source.raw_os_error(),
        Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
    )
}

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
    fn GetFileInformationByHandle(
        file: *mut core::ffi::c_void,
        information: *mut ByHandleFileInformation,
    ) -> i32;
}

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

trait ReplaceOperations {
    fn replace(&mut self, source: &Path, destination: &Path, backup: &Path) -> Result<(), i32>;
    fn move_replace(&mut self, source: &Path, destination: &Path) -> Result<(), i32>;
    fn move_new(&mut self, source: &Path, destination: &Path) -> Result<(), i32>;
}

struct SystemReplaceOperations;

impl ReplaceOperations for SystemReplaceOperations {
    fn replace(&mut self, source: &Path, destination: &Path, backup: &Path) -> Result<(), i32> {
        let source = wide(source.as_os_str());
        let destination = wide(destination.as_os_str());
        let backup = wide(backup.as_os_str());
        let succeeded = unsafe {
            ReplaceFileW(
                destination.as_ptr(),
                source.as_ptr(),
                backup.as_ptr(),
                0,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if succeeded == 0 {
            Err(std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default())
        } else {
            Ok(())
        }
    }

    fn move_replace(&mut self, source: &Path, destination: &Path) -> Result<(), i32> {
        let source = wide(source.as_os_str());
        let destination = wide(destination.as_os_str());
        let succeeded = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if succeeded == 0 {
            Err(std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default())
        } else {
            Ok(())
        }
    }

    fn move_new(&mut self, source: &Path, destination: &Path) -> Result<(), i32> {
        let source = wide(source.as_os_str());
        let destination = wide(destination.as_os_str());
        let succeeded = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        };
        if succeeded == 0 {
            Err(std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default())
        } else {
            Ok(())
        }
    }
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
    validate_regular_or_missing(destination).map_err(PublishFailure::not_published)?;
    let mut operations = SystemReplaceOperations;
    recover_file_using(destination, &mut operations).map_err(PublishFailure::recovery_required)?;
    let destination_exists = fs::symlink_metadata(destination).is_ok();
    replace_file_with_backup_using(
        source,
        destination,
        backup_storage,
        destination_exists,
        &mut operations,
    )
}

fn replace_file_with_backup_using<O: ReplaceOperations>(
    source: &Path,
    destination: &Path,
    backup_storage: &Path,
    destination_exists: bool,
    operations: &mut O,
) -> PublishResult {
    let operation = if destination_exists {
        operations.replace(source, destination, backup_storage)
    } else {
        operations.move_replace(source, destination)
    };
    let raw = match operation {
        Ok(()) => return Ok(PublishState::Published),
        Err(raw) => raw,
    };
    let error = CommandError::io(format!(
        "could not atomically replace document: Windows error {raw}"
    ));
    if classify_replace_error(raw) == ReplaceFailureAction::RestoreBackup && destination_exists {
        return match operations.move_replace(backup_storage, destination) {
            Ok(()) => Err(PublishFailure::not_published(error)),
            Err(restore_error) => {
                let descriptor_result = persist_recovery_descriptor_using(
                    source,
                    destination,
                    backup_storage,
                    operations,
                );
                let diagnostic = match descriptor_result {
                    Ok(()) => format!("{error}; restoring backup failed with Windows error {restore_error}; recovery descriptor persisted"),
                    Err(marker) => format!("{error}; restoring backup failed with Windows error {restore_error}; recovery descriptor failed: {marker}"),
                };
                Err(PublishFailure::recovery_required(CommandError::io(
                    diagnostic,
                )))
            }
        };
    }
    Err(PublishFailure::not_published(error))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FileIdentity {
    volume: u64,
    index: u64,
}

impl FileIdentity {
    fn from_file(file: &File) -> Result<Self, CommandError> {
        let metadata = file.metadata().map_err(|source| {
            CommandError::io(format!("could not inspect recovery file: {source}"))
        })?;
        validate_regular_file_metadata(metadata.file_attributes(), metadata.is_file())?;
        let mut info = ByHandleFileInformation::default();
        let succeeded =
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) };
        if succeeded == 0 {
            return Err(CommandError::io(format!(
                "could not identify recovery file: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self {
            volume: u64::from(info.volume_serial_number),
            index: (u64::from(info.file_index_high) << 32) | u64::from(info.file_index_low),
        })
    }

    fn from_path(path: &Path) -> Result<Self, CommandError> {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|source| {
                CommandError::io(format!("could not open recovery file: {source}"))
            })?;
        Self::from_file(&file)
    }
}

#[derive(Serialize, Deserialize)]
struct RecoveryDescriptor {
    version: u8,
    destination: String,
    source: String,
    backup: String,
    source_identity: FileIdentity,
    backup_identity: FileIdentity,
}

fn recovery_descriptor_path(destination: &Path) -> PathBuf {
    destination.with_file_name(format!(
        ".{}.replace-recovery.json",
        destination
            .file_name()
            .unwrap_or_else(|| OsStr::new("file"))
            .to_string_lossy()
    ))
}

fn persist_recovery_descriptor_using<O: ReplaceOperations>(
    source: &Path,
    destination: &Path,
    backup: &Path,
    operations: &mut O,
) -> Result<(), CommandError> {
    let parent = destination
        .parent()
        .ok_or_else(|| CommandError::validation("replacement destination has no parent"))?;
    if source.parent() != Some(parent) || backup.parent() != Some(parent) {
        return Err(CommandError::validation(
            "recovery files must share one parent",
        ));
    }
    let descriptor = RecoveryDescriptor {
        version: 1,
        destination: child_file_name(destination)?,
        source: child_file_name(source)?,
        backup: child_file_name(backup)?,
        source_identity: FileIdentity::from_path(source)?,
        backup_identity: FileIdentity::from_path(backup)?,
    };
    let marker = recovery_descriptor_path(destination);
    match fs::symlink_metadata(&marker) {
        Ok(_) => {
            return Err(CommandError::conflict(
                "an unresolved recovery descriptor already exists",
            ))
        }
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CommandError::io(format!(
                "could not inspect recovery descriptor: {source}"
            )))
        }
    }
    let temporary = marker.with_file_name(format!(".replace-recovery.{}.tmp", Uuid::now_v7()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&temporary)
        .map_err(|source| {
            CommandError::io(format!("could not create recovery descriptor: {source}"))
        })?;
    serde_json::to_writer(&mut file, &descriptor).map_err(|source| {
        CommandError::io(format!("could not serialize recovery descriptor: {source}"))
    })?;
    file.write_all(b"\n")
        .and_then(|()| file.sync_all())
        .map_err(|source| {
            CommandError::io(format!("could not sync recovery descriptor: {source}"))
        })?;
    drop(file);
    operations.move_new(&temporary, &marker).map_err(|code| {
        CommandError::io(format!(
            "could not publish recovery descriptor with write-through: Windows error {code}"
        ))
    })
}

pub fn recover_file(destination: &Path) -> Result<(), CommandError> {
    let mut operations = SystemReplaceOperations;
    recover_file_using(destination, &mut operations)
}

fn recover_file_using<O: ReplaceOperations>(
    destination: &Path,
    operations: &mut O,
) -> Result<(), CommandError> {
    let marker = recovery_descriptor_path(destination);
    validate_regular_or_missing(&marker)?;
    let bytes = match fs::read(&marker) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(CommandError::io(format!(
                "could not read recovery descriptor: {source}"
            )))
        }
    };
    let descriptor: RecoveryDescriptor = serde_json::from_slice(&bytes).map_err(|source| {
        CommandError::validation(format!("invalid recovery descriptor: {source}"))
    })?;
    if descriptor.version != 1 || descriptor.destination != child_file_name(destination)? {
        return Err(CommandError::validation(
            "recovery descriptor destination mismatch",
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| CommandError::validation("replacement destination has no parent"))?;
    validate_child_name(&descriptor.source)?;
    validate_child_name(&descriptor.backup)?;
    let source = parent.join(&descriptor.source);
    let backup = parent.join(&descriptor.backup);
    if FileIdentity::from_path(&source)? != descriptor.source_identity {
        return Err(CommandError::validation(
            "recovery source identity mismatch",
        ));
    }
    validate_regular_or_missing(destination)?;
    if fs::symlink_metadata(destination).is_ok() {
        if FileIdentity::from_path(destination)? != descriptor.backup_identity {
            return Err(CommandError::validation(
                "canonical destination identity does not match pending recovery",
            ));
        }
    } else {
        if FileIdentity::from_path(&backup)? != descriptor.backup_identity {
            return Err(CommandError::validation(
                "recovery backup identity mismatch",
            ));
        }
        operations
            .move_replace(&backup, destination)
            .map_err(|code| {
                CommandError::io(format!(
                    "could not restore canonical destination: Windows error {code}"
                ))
            })?;
        if FileIdentity::from_path(destination)? != descriptor.backup_identity {
            return Err(CommandError::io(
                "restored canonical destination identity mismatch",
            ));
        }
    }
    for suffix in ["-wal", "-shm"] {
        let backup_sidecar = parent.join(format!("{}{suffix}", descriptor.backup));
        let destination_sidecar = parent.join(format!("{}{suffix}", descriptor.destination));
        validate_regular_or_missing(&backup_sidecar)?;
        validate_regular_or_missing(&destination_sidecar)?;
        if fs::symlink_metadata(&backup_sidecar).is_ok() {
            if fs::symlink_metadata(&destination_sidecar).is_ok() {
                return Err(CommandError::validation(
                    "canonical recovery sidecar already exists",
                ));
            }
            let identity = FileIdentity::from_path(&backup_sidecar)?;
            operations
                .move_replace(&backup_sidecar, &destination_sidecar)
                .map_err(|code| {
                    CommandError::io(format!(
                        "could not restore canonical sidecar: Windows error {code}"
                    ))
                })?;
            if FileIdentity::from_path(&destination_sidecar)? != identity {
                return Err(CommandError::io(
                    "restored canonical sidecar identity mismatch",
                ));
            }
        }
    }
    fs::remove_file(&marker).map_err(|source| {
        CommandError::io(format!("could not remove recovery descriptor: {source}"))
    })?;
    if FileIdentity::from_path(&source).ok() == Some(descriptor.source_identity) {
        let _ = fs::remove_file(source);
    }
    Ok(())
}

fn child_file_name(path: &Path) -> Result<String, CommandError> {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(str::to_owned)
        .ok_or_else(|| CommandError::validation("recovery path has no UTF-8 file name"))
}

fn validate_regular_or_missing(path: &Path) -> Result<(), CommandError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_regular_file_metadata(metadata.file_attributes(), metadata.is_file())
        }
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(CommandError::io(format!(
            "could not inspect replacement destination: {source}"
        ))),
    }
}

fn validate_regular_file_metadata(attributes: u32, is_file: bool) -> Result<(), CommandError> {
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !is_file {
        Err(CommandError::validation(
            "contained file is a reparse point or not a regular file",
        ))
    } else {
        Ok(())
    }
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

#[derive(Debug)]
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

    fn open_exclusive_lock(&self, name: &str) -> std::io::Result<File> {
        let path = self
            .child_path(name)
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    pub fn recover(&self, name: &str) -> Result<(), CommandError> {
        let path = self.child_path(name)?;
        recover_file(&path)
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

    pub(crate) fn create_new_publishable(&self, name: &str) -> Result<File, CommandError> {
        let path = self.child_path(name)?;
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)
            .map_err(|source| {
                CommandError::io(format!(
                    "could not create publishable contained file: {source}"
                ))
            })
    }

    pub fn prepare_regular_file(&self, name: &str) -> Result<PathBuf, CommandError> {
        let path = self.child_path(name)?;
        validate_regular_or_missing(&path)?;
        let file = self.create_new(name)?;
        file.sync_all().map_err(|source| {
            CommandError::io(format!("could not sync new contained file: {source}"))
        })?;
        Ok(path)
    }

    pub fn sync_file(&self, name: &str) -> Result<(), CommandError> {
        let path = self.child_path(name)?;
        validate_regular_or_missing(&path)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|source| {
                CommandError::io(format!("could not open contained file for sync: {source}"))
            })?;
        file.sync_all()
            .map_err(|source| CommandError::io(format!("could not sync contained file: {source}")))
    }

    pub fn regular_file_exists(&self, name: &str) -> Result<bool, CommandError> {
        let path = self.child_path(name)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                validate_regular_file_metadata(metadata.file_attributes(), metadata.is_file())?;
                Ok(true)
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(source) => Err(CommandError::io(format!(
                "could not inspect contained file: {source}"
            ))),
        }
    }

    pub fn move_file(&self, source: &str, destination: &str) -> Result<(), CommandError> {
        let source_path = self.child_path(source)?;
        let destination_path = self.child_path(destination)?;
        validate_regular_or_missing(&source_path)?;
        validate_regular_or_missing(&destination_path)?;
        if fs::symlink_metadata(&destination_path).is_ok() {
            return Err(CommandError::validation(
                "contained move destination already exists",
            ));
        }
        let expected = FileIdentity::from_path(&source_path)?;
        SystemReplaceOperations
            .move_replace(&source_path, &destination_path)
            .map_err(|code| {
                CommandError::io(format!(
                    "could not move contained file: Windows error {code}"
                ))
            })?;
        if FileIdentity::from_path(&destination_path)? != expected {
            return Err(CommandError::io(
                "contained file identity changed during move",
            ));
        }
        Ok(())
    }

    pub fn publish_with_backup(
        &self,
        source: &str,
        destination: &str,
        backup: &str,
    ) -> PublishResult {
        let source_path = self
            .child_path(source)
            .map_err(PublishFailure::not_published)?;
        let destination_path = self
            .child_path(destination)
            .map_err(PublishFailure::not_published)?;
        let backup_path = self
            .child_path(backup)
            .map_err(PublishFailure::not_published)?;
        validate_regular_or_missing(&source_path).map_err(PublishFailure::not_published)?;
        validate_regular_or_missing(&destination_path).map_err(PublishFailure::not_published)?;
        validate_regular_or_missing(&backup_path).map_err(PublishFailure::not_published)?;
        if fs::symlink_metadata(&backup_path).is_ok() {
            return Err(PublishFailure::not_published(CommandError::validation(
                "replacement backup already exists",
            )));
        }
        let expected =
            FileIdentity::from_path(&source_path).map_err(PublishFailure::not_published)?;
        let result = replace_file_with_backup(&source_path, &destination_path, &backup_path);
        if matches!(result, Ok(PublishState::Published)) {
            let actual = FileIdentity::from_path(&destination_path)
                .map_err(PublishFailure::recovery_required)?;
            if actual != expected {
                return Err(PublishFailure::recovery_required(CommandError::io(
                    "published file identity does not match replacement",
                )));
            }
        }
        result
    }

    pub fn remove_checked(&self, name: &str) -> Result<bool, CommandError> {
        let path = self.child_path(name)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                validate_regular_file_metadata(metadata.file_attributes(), metadata.is_file())?;
                fs::remove_file(path).map_err(|source| {
                    CommandError::io(format!("could not remove contained file: {source}"))
                })?;
                Ok(true)
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(source) => Err(CommandError::io(format!(
                "could not inspect contained file for removal: {source}"
            ))),
        }
    }

    pub(crate) fn publish_new(
        &self,
        source: &str,
        destination: &str,
        original: &File,
    ) -> Result<NewFilePublishState, CommandError> {
        let source_path = self.child_path(source)?;
        let destination_path = self.child_path(destination)?;
        validate_regular_or_missing(&source_path)?;
        validate_regular_or_missing(&destination_path)?;
        match SystemReplaceOperations.move_new(&source_path, &destination_path) {
            Ok(()) => {
                self.verify_published(destination, original)?;
                Ok(NewFilePublishState::Published)
            }
            Err(ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS) => {
                Ok(NewFilePublishState::DestinationExists)
            }
            Err(code) => Err(CommandError::io(format!(
                "could not publish new contained file: Windows error {code}"
            ))),
        }
    }

    pub(crate) fn verify_published(
        &self,
        destination: &str,
        original: &File,
    ) -> Result<(), CommandError> {
        let destination = self.child_path(destination)?;
        if FileIdentity::from_path(&destination)? != FileIdentity::from_file(original)? {
            return Err(CommandError::validation(
                "published contained file identity does not match its validated source",
            ));
        }
        Ok(())
    }

    pub fn read(&self, name: &str, max_bytes: u64) -> Result<Vec<u8>, CommandError> {
        let path = self.child_path(name)?;
        recover_file(&path)?;
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
        validate_regular_file_metadata(metadata.file_attributes(), metadata.is_file())?;
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
    use super::{
        classify_replace_error, persist_recovery_descriptor_using, replace_file_with_backup_using,
        FileIdentity, ReplaceFailureAction, ReplaceOperations,
    };
    use crate::storage::atomic_file::PublishState;
    use std::{collections::VecDeque, fs, path::Path};

    #[test]
    fn index_mutation_lock_keeps_the_validated_root_pinned_while_opening_the_lock_file() {
        let root = tempfile::tempdir().unwrap();
        let moved = root.path().with_extension("moved");

        let guard = super::IndexMutationLock::acquire_with_timeout_and_hook(
            root.path(),
            std::time::Duration::ZERO,
            || {
                assert!(fs::rename(root.path(), &moved).is_err());
                assert!(root.path().is_dir());
            },
        )
        .unwrap();

        assert!(root.path().join(super::INDEX_LOCK).is_file());
        drop(guard);
    }

    struct FakeReplaceOperations {
        replace_results: VecDeque<Result<(), i32>>,
        move_results: VecDeque<Result<(), i32>>,
        moves: Vec<(std::path::PathBuf, std::path::PathBuf)>,
        descriptor_arrival: Option<Vec<u8>>,
    }

    impl ReplaceOperations for FakeReplaceOperations {
        fn replace(
            &mut self,
            _source: &Path,
            _destination: &Path,
            _backup: &Path,
        ) -> Result<(), i32> {
            self.replace_results.pop_front().expect("replace result")
        }

        fn move_replace(&mut self, source: &Path, destination: &Path) -> Result<(), i32> {
            self.moves
                .push((source.to_path_buf(), destination.to_path_buf()));
            if let Some(bytes) = self.descriptor_arrival.take() {
                fs::write(destination, bytes).expect("inject descriptor arrival");
            }
            match self.move_results.pop_front().expect("move result") {
                Ok(()) => {
                    if destination.exists() {
                        fs::remove_file(destination)
                            .map_err(|error| error.raw_os_error().unwrap_or(1))?;
                    }
                    fs::rename(source, destination)
                        .map_err(|error| error.raw_os_error().unwrap_or(1))
                }
                Err(code) => Err(code),
            }
        }

        fn move_new(&mut self, source: &Path, destination: &Path) -> Result<(), i32> {
            self.moves
                .push((source.to_path_buf(), destination.to_path_buf()));
            if let Some(bytes) = self.descriptor_arrival.take() {
                fs::write(destination, bytes).expect("inject descriptor arrival");
            }
            match self.move_results.pop_front().expect("move result") {
                Ok(()) if destination.exists() => Err(183),
                Ok(()) => fs::rename(source, destination)
                    .map_err(|error| error.raw_os_error().unwrap_or(1)),
                Err(code) => Err(code),
            }
        }
    }

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

    #[test]
    fn error_1177_with_successful_restore_is_not_published() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("index.sqlite");
        let backup = root.path().join("backup");
        fs::write(&source, b"new").unwrap();
        fs::write(&backup, b"old").unwrap();
        let mut operations = FakeReplaceOperations {
            replace_results: VecDeque::from([Err(1177)]),
            move_results: VecDeque::from([Ok(())]),
            moves: Vec::new(),
            descriptor_arrival: None,
        };

        let failure =
            replace_file_with_backup_using(&source, &destination, &backup, true, &mut operations)
                .unwrap_err();

        assert_eq!(failure.state(), PublishState::NotPublished);
        assert_eq!(fs::read(destination).unwrap(), b"old");
    }

    #[test]
    fn error_1177_with_failed_restore_requires_persisted_recovery() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("index.sqlite");
        let backup = root.path().join("backup");
        fs::write(&source, b"new").unwrap();
        fs::write(&backup, b"old").unwrap();
        let source_identity = FileIdentity::from_path(&source).unwrap();
        let backup_identity = FileIdentity::from_path(&backup).unwrap();
        let mut operations = FakeReplaceOperations {
            replace_results: VecDeque::from([Err(1177)]),
            move_results: VecDeque::from([Err(32), Ok(())]),
            moves: Vec::new(),
            descriptor_arrival: None,
        };

        let failure =
            replace_file_with_backup_using(&source, &destination, &backup, true, &mut operations)
                .unwrap_err();

        assert_eq!(failure.state(), PublishState::RecoveryRequired);
        assert_eq!(FileIdentity::from_path(&source).unwrap(), source_identity);
        assert_eq!(FileIdentity::from_path(&backup).unwrap(), backup_identity);
        assert!(super::recovery_descriptor_path(&destination).is_file());
    }

    #[test]
    fn storage_startup_consumes_recovery_descriptor_and_restores_canonical_file() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("index.sqlite");
        let backup = root.path().join("backup");
        fs::write(&source, b"new").unwrap();
        fs::write(&backup, b"old").unwrap();
        fs::write(root.path().join("backup-wal"), b"old wal").unwrap();
        let mut failed = FakeReplaceOperations {
            replace_results: VecDeque::from([Err(1177)]),
            move_results: VecDeque::from([Err(32), Ok(())]),
            moves: Vec::new(),
            descriptor_arrival: None,
        };
        let failure =
            replace_file_with_backup_using(&source, &destination, &backup, true, &mut failed)
                .unwrap_err();
        assert_eq!(failure.state(), PublishState::RecoveryRequired);

        crate::storage::paths::StoragePaths::open(root.path()).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert_eq!(
            fs::read(root.path().join("index.sqlite-wal")).unwrap(),
            b"old wal"
        );
        assert!(!super::recovery_descriptor_path(&destination).exists());
        assert!(!source.exists());
    }

    #[test]
    fn rebuild_consumes_a_note_recovery_descriptor_before_scanning() {
        use crate::{
            domain::{NoteDocument, NoteId, NoteKind},
            storage::{paths::StoragePaths, rebuild::rebuild_index, repository::NoteRepository},
        };
        let root = tempfile::tempdir().unwrap();
        let paths = StoragePaths::open(root.path()).unwrap();
        let id = NoteId::parse_str("019c0000-0000-7000-8000-000000000401").unwrap();
        let repository = NoteRepository::new(paths.clone());
        repository
            .create(NoteDocument {
                id,
                kind: NoteKind::Formal,
                title: "Recovery".to_owned(),
                folder_id: None,
                tags: Vec::new(),
                markdown: "# Recovery".to_owned(),
                revision: 0,
                created_at: "2026-07-31T00:00:00Z".to_owned(),
                updated_at: "2026-07-31T00:00:00Z".to_owned(),
            })
            .unwrap();
        drop(repository);
        let note_dir = paths.note_dir(id, NoteKind::Formal).unwrap();
        let destination = note_dir.join("note.md");
        let source = note_dir.join("source.tmp");
        let backup = note_dir.join("backup.tmp");
        fs::copy(&destination, &source).unwrap();
        fs::rename(&destination, &backup).unwrap();
        let mut failed = FakeReplaceOperations {
            replace_results: VecDeque::from([Err(1177)]),
            move_results: VecDeque::from([Err(32), Ok(())]),
            moves: Vec::new(),
            descriptor_arrival: None,
        };
        assert_eq!(
            replace_file_with_backup_using(&source, &destination, &backup, true, &mut failed)
                .unwrap_err()
                .state(),
            PublishState::RecoveryRequired
        );

        let report = rebuild_index(&paths).unwrap();

        assert_eq!(report.notes_recovered, 1);
        assert!(destination.is_file());
    }

    #[test]
    fn safe_directory_metadata_rejects_reparse_points_without_os_symlink_privilege() {
        let error =
            super::validate_regular_file_metadata(super::FILE_ATTRIBUTE_REPARSE_POINT, true)
                .unwrap_err();
        assert_eq!(error.code(), crate::error::CommandErrorCode::Validation);
        assert!(super::validate_regular_file_metadata(0, true).is_ok());
    }

    #[test]
    fn recovery_descriptor_publication_uses_write_through_adapter_and_preserves_temp_on_failure() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("index.sqlite");
        let backup = root.path().join("backup");
        fs::write(&source, b"new").unwrap();
        fs::write(&backup, b"old").unwrap();
        let mut operations = FakeReplaceOperations {
            replace_results: VecDeque::new(),
            move_results: VecDeque::from([Err(5)]),
            moves: Vec::new(),
            descriptor_arrival: None,
        };

        assert!(
            persist_recovery_descriptor_using(&source, &destination, &backup, &mut operations,)
                .is_err()
        );

        assert_eq!(operations.moves.len(), 1);
        assert_eq!(
            operations.moves[0].1,
            super::recovery_descriptor_path(&destination)
        );
        assert!(operations.moves[0].0.is_file());
        assert_eq!(fs::read(source).unwrap(), b"new");
        assert_eq!(fs::read(backup).unwrap(), b"old");
    }

    #[test]
    fn unresolved_recovery_descriptor_is_never_deleted_or_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("index.sqlite");
        let backup = root.path().join("backup");
        let marker = super::recovery_descriptor_path(&destination);
        fs::write(&source, b"new").unwrap();
        fs::write(&backup, b"old").unwrap();
        fs::write(&marker, b"unresolved descriptor").unwrap();
        let mut operations = FakeReplaceOperations {
            replace_results: VecDeque::new(),
            move_results: VecDeque::new(),
            moves: Vec::new(),
            descriptor_arrival: None,
        };

        assert!(
            persist_recovery_descriptor_using(&source, &destination, &backup, &mut operations,)
                .is_err()
        );

        assert!(operations.moves.is_empty());
        assert_eq!(fs::read(marker).unwrap(), b"unresolved descriptor");
        assert_eq!(fs::read(source).unwrap(), b"new");
        assert_eq!(fs::read(backup).unwrap(), b"old");
    }

    #[test]
    fn descriptor_publication_does_not_replace_marker_arriving_at_move_time() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("index.sqlite");
        let backup = root.path().join("backup");
        let marker = super::recovery_descriptor_path(&destination);
        let unresolved = b"descriptor published by another recovery";
        fs::write(&source, b"new").unwrap();
        fs::write(&backup, b"old").unwrap();
        let mut operations = FakeReplaceOperations {
            replace_results: VecDeque::new(),
            move_results: VecDeque::from([Ok(())]),
            moves: Vec::new(),
            descriptor_arrival: Some(unresolved.to_vec()),
        };

        // Mutation caught: descriptor publication routed through the replacing move adapter.
        let result =
            persist_recovery_descriptor_using(&source, &destination, &backup, &mut operations);

        assert!(result.is_err());
        assert_eq!(fs::read(&marker).unwrap(), unresolved);
        assert_eq!(operations.moves.len(), 1);
        assert!(operations.moves[0].0.is_file());
        assert_eq!(fs::read(source).unwrap(), b"new");
        assert_eq!(fs::read(backup).unwrap(), b"old");
    }

    fn recovery_required_note_writer(
        paths: &crate::storage::paths::StoragePaths,
        id: crate::domain::NoteId,
        kind: crate::domain::NoteKind,
        bytes: &[u8],
    ) -> crate::storage::atomic_file::PublishResult {
        let directory = paths.note_dir(id, kind).unwrap();
        let destination = directory.join("note.md");
        let source = directory.join("injected-source.tmp");
        let backup = directory.join("injected-backup.tmp");
        fs::write(&source, bytes).unwrap();
        fs::rename(&destination, &backup).unwrap();
        let mut failed = FakeReplaceOperations {
            replace_results: VecDeque::from([Err(1177)]),
            move_results: VecDeque::from([Err(32), Ok(())]),
            moves: Vec::new(),
            descriptor_arrival: None,
        };
        replace_file_with_backup_using(&source, &destination, &backup, true, &mut failed)
    }

    #[test]
    fn repository_load_recovers_note_and_consumes_application_recovery_signal() {
        use crate::{
            domain::{NoteDocument, NoteId, NoteKind},
            storage::{paths::StoragePaths, repository::NoteRepository},
        };
        let root = tempfile::tempdir().unwrap();
        let paths = StoragePaths::open(root.path()).unwrap();
        let id = NoteId::parse_str("019c0000-0000-7000-8000-000000000402").unwrap();
        let original = NoteDocument {
            id,
            kind: NoteKind::Formal,
            title: "Recovery load".to_owned(),
            folder_id: None,
            tags: Vec::new(),
            markdown: "old canonical body".to_owned(),
            revision: 0,
            created_at: "2026-07-31T00:00:00Z".to_owned(),
            updated_at: "2026-07-31T00:00:00Z".to_owned(),
        };
        let repository = NoteRepository::new(paths.clone());
        repository.create(original.clone()).unwrap();
        let repository =
            NoteRepository::new_with_writer(paths.clone(), recovery_required_note_writer);
        let mut updated = original.clone();
        updated.markdown = "new interrupted body".to_owned();
        assert!(repository.save(updated, 0).is_err());
        let note_dir = paths.note_dir(id, NoteKind::Formal).unwrap();
        let descriptor = note_dir.join(".note.md.replace-recovery.json");
        let signal = paths.root().join("recovery-needed.json");
        assert!(descriptor.is_file());
        assert!(signal.is_file());

        let loaded = repository.load(id).unwrap();

        assert_eq!(loaded.markdown, original.markdown);
        assert!(!descriptor.exists());
        assert!(!signal.exists());
    }
}
