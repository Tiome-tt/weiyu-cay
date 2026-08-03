use super::{NewFilePublishState, SafeEntryKind};
use crate::{
    error::CommandError,
    storage::atomic_file::{PublishFailure, PublishResult, PublishState},
};
use rustix::{
    fd::{AsFd, BorrowedFd, OwnedFd},
    fs::{
        flock, fstat, fsync, linkat, mkdirat, openat, renameat, statat, unlinkat, AtFlags, Dir,
        FileType, FlockOperation, Mode, OFlags, CWD,
    },
};
#[cfg(target_os = "macos")]
use std::{ffi::CString, os::fd::AsRawFd};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const INDEX_LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct IndexMutationLock {
    _file: OwnedFd,
    _directory: OwnedFd,
}

impl IndexMutationLock {
    pub fn acquire(root: &Path) -> Result<Self, CommandError> {
        Self::acquire_with_timeout(root, INDEX_LOCK_TIMEOUT)
    }

    #[doc(hidden)]
    pub fn acquire_with_timeout(root: &Path, timeout: Duration) -> Result<Self, CommandError> {
        let directory = rustix::fs::open(
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|source| CommandError::io(format!("could not open index lock root: {source}")))?;
        let file = openat(
            &directory,
            ".index-mutation.lock",
            OFlags::CREATE | OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|source| {
            CommandError::io(format!("could not open index mutation lock: {source}"))
        })?;
        if FileType::from_raw_mode(
            fstat(&file)
                .map_err(|source| {
                    CommandError::io(format!("could not inspect index mutation lock: {source}"))
                })?
                .st_mode,
        ) != FileType::RegularFile
        {
            return Err(CommandError::validation(
                "index mutation lock must be a regular file",
            ));
        }
        let started = Instant::now();
        let mut backoff = Duration::from_millis(1);
        loop {
            match flock(&file, FlockOperation::NonBlockingLockExclusive) {
                Ok(()) => {
                    return Ok(Self {
                        _file: file,
                        _directory: directory,
                    })
                }
                Err(source)
                    if source == rustix::io::Errno::WOULDBLOCK && started.elapsed() < timeout =>
                {
                    let remaining = timeout.saturating_sub(started.elapsed());
                    thread::sleep(backoff.min(remaining));
                    backoff = backoff.saturating_mul(2).min(Duration::from_millis(25));
                }
                Err(source) if source == rustix::io::Errno::WOULDBLOCK => {
                    return Err(CommandError::conflict(format!(
                        "index mutation lock is busy: {source}"
                    )))
                }
                Err(source) => {
                    return Err(CommandError::io(format!(
                        "could not acquire index mutation lock: {source}"
                    )))
                }
            }
        }
    }
}

pub fn replace_file(source: &Path, destination: &Path) -> PublishResult {
    let backup = destination.with_file_name(format!(
        ".{}.{}.replace-backup",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        Uuid::now_v7()
    ));
    let result = replace_file_with_backup(source, destination, &backup);
    if matches!(result, Ok(PublishState::Published)) {
        let _ = fs::remove_file(backup);
    }
    result
}

pub fn replace_file_with_backup(source: &Path, destination: &Path, backup: &Path) -> PublishResult {
    let linked_backup = if destination.exists() {
        fs::hard_link(destination, backup).map_err(|error| {
            PublishFailure::not_published(CommandError::io(format!(
                "could not preserve replaced file: {error}"
            )))
        })?;
        true
    } else {
        false
    };
    match fs::rename(source, destination) {
        Ok(()) => Ok(PublishState::Published),
        Err(error) => {
            if linked_backup {
                let _ = fs::remove_file(backup);
            }
            Err(PublishFailure::not_published(CommandError::io(format!(
                "could not atomically replace document: {error}"
            ))))
        }
    }
}

pub fn sync_parent(parent: &Path) -> Result<(), CommandError> {
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| CommandError::io(format!("could not sync document directory: {error}")))
}

pub fn recover_file(_destination: &Path) -> Result<(), CommandError> {
    Ok(())
}

pub struct SafeDirectory {
    fd: OwnedFd,
    path: PathBuf,
}

#[cfg(target_os = "macos")]
const RENAME_EXCL: u32 = 0x0000_0004;

#[cfg(target_os = "macos")]
extern "C" {
    fn renameatx_np(
        from_fd: i32,
        from: *const core::ffi::c_char,
        to_fd: i32,
        to: *const core::ffi::c_char,
        flags: u32,
    ) -> i32;
}

impl SafeDirectory {
    pub(crate) fn ensure_path_identity(&self) -> Result<(), CommandError> {
        let expected = directory_identity(self.fd.as_fd())?;
        let current = statat(CWD, &self.path, AtFlags::SYMLINK_NOFOLLOW).map_err(|source| {
            CommandError::io(format!(
                "could not revalidate safe directory path: {source}"
            ))
        })?;
        if directory_identity_from_stat(&current)? != expected {
            return Err(CommandError::conflict(
                "safe directory path identity changed",
            ));
        }
        Ok(())
    }

    pub(crate) fn open_child(&self, name: &str, create: bool) -> Result<Self, CommandError> {
        validate_child_name(name)?;
        let fd = match openat(
            &self.fd,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(source) if create && source == rustix::io::Errno::NOENT => {
                mkdirat(&self.fd, name, Mode::from_bits_truncate(0o700)).map_err(|error| {
                    CommandError::io(format!("could not create contained directory: {error}"))
                })?;
                fsync(&self.fd).map_err(|error| {
                    CommandError::io(format!(
                        "could not sync contained directory parent: {error}"
                    ))
                })?;
                openat(
                    &self.fd,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|error| {
                    CommandError::io(format!("could not pin contained directory: {error}"))
                })?
            }
            Err(source) => {
                return Err(CommandError::io(format!(
                    "could not pin contained directory: {source}"
                )))
            }
        };
        Ok(Self {
            fd,
            path: self.path.join(name),
        })
    }

    pub(crate) fn create_child_no_replace(&self, name: &str) -> Result<Self, CommandError> {
        validate_child_name(name)?;
        mkdirat(&self.fd, name, Mode::from_bits_truncate(0o700)).map_err(|source| {
            if source == rustix::io::Errno::EXIST {
                CommandError::conflict("contained directory already exists")
            } else {
                CommandError::io(format!("could not create contained directory: {source}"))
            }
        })?;
        fsync(&self.fd).map_err(|source| {
            CommandError::io(format!(
                "could not sync contained directory parent: {source}"
            ))
        })?;
        self.open_child(name, false)
    }

    pub(crate) fn move_self_no_replace(
        self,
        destination_parent: &SafeDirectory,
        destination: &str,
    ) -> Result<PublishState, PublishFailure> {
        validate_child_name(destination).map_err(PublishFailure::not_published_preserve_source)?;
        let source = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                PublishFailure::not_published_preserve_source(CommandError::validation(
                    "movable directory source name is invalid",
                ))
            })?;
        let expected = directory_identity(self.fd.as_fd())
            .map_err(PublishFailure::not_published_preserve_source)?;
        validate_safe_directory_tree_fd(self.fd.as_fd())
            .map_err(PublishFailure::not_published_preserve_source)?;
        if statat(
            &destination_parent.fd,
            destination,
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .is_ok()
        {
            return Err(PublishFailure::not_published_preserve_source(
                CommandError::conflict("contained directory destination already exists"),
            ));
        }
        renameat(
            &destination_parent.fd,
            source,
            &destination_parent.fd,
            destination,
        )
        .map_err(|error| {
            PublishFailure::not_published_preserve_source(CommandError::io(format!(
                "could not publish verified staging directory: {error}"
            )))
        })?;
        let moved = statat(
            &destination_parent.fd,
            destination,
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|source| {
            PublishFailure::recovery_required(CommandError::io(format!(
                "could not identify published directory: {source}"
            )))
        })?;
        if directory_identity_from_stat(&moved).map_err(PublishFailure::recovery_required)?
            != expected
        {
            return Err(PublishFailure::recovery_required(CommandError::io(
                "published directory identity does not match verified staging",
            )));
        }
        validate_safe_directory_tree_at(destination_parent.fd.as_fd(), destination)
            .map_err(PublishFailure::recovery_required)?;
        destination_parent
            .sync()
            .map(|()| PublishState::Published)
            .map_err(PublishFailure::published_but_sync_failed)
    }

    pub(crate) fn entry_kind(&self, name: &str) -> Result<SafeEntryKind, CommandError> {
        validate_child_name(name)?;
        let stat = statat(&self.fd, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|source| {
            CommandError::io(format!("could not inspect contained entry: {source}"))
        })?;
        match FileType::from_raw_mode(stat.st_mode) {
            FileType::Directory => Ok(SafeEntryKind::Directory),
            FileType::RegularFile => Ok(SafeEntryKind::RegularFile),
            _ => Err(CommandError::validation(
                "contained entry is not a regular file or directory",
            )),
        }
    }

    pub(crate) fn copy_regular_file_to(
        &self,
        name: &str,
        destination: &SafeDirectory,
    ) -> Result<u64, CommandError> {
        validate_child_name(name)?;
        let source = openat(
            &self.fd,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| CommandError::io(format!("could not open contained file: {error}")))?;
        if FileType::from_raw_mode(
            fstat(&source)
                .map_err(|error| {
                    CommandError::io(format!("could not inspect source file: {error}"))
                })?
                .st_mode,
        ) != FileType::RegularFile
        {
            return Err(CommandError::validation(
                "contained source is not a regular file",
            ));
        }
        let before = fstat(&source)
            .map_err(|error| CommandError::io(format!("could not inspect source file: {error}")))?
            .st_size;
        let mut source: fs::File = source.into();
        let mut target = destination.create_new(name)?;
        let copied = std::io::copy(&mut source, &mut target)
            .map_err(|error| CommandError::io(format!("could not copy contained file: {error}")))?;
        target.sync_all().map_err(|error| {
            CommandError::io(format!("could not sync copied contained file: {error}"))
        })?;
        let after = fstat(&source)
            .map_err(|error| {
                CommandError::io(format!("could not re-inspect source file: {error}"))
            })?
            .st_size;
        if before < 0 || after < 0 || before as u64 != copied || after as u64 != copied {
            return Err(CommandError::conflict(
                "contained source file size changed while it was copied",
            ));
        }
        Ok(copied)
    }

    pub(crate) fn regular_file_len(&self, name: &str) -> Result<u64, CommandError> {
        validate_child_name(name)?;
        let file = openat(
            &self.fd,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|source| CommandError::io(format!("could not open contained file: {source}")))?;
        let stat = fstat(&file).map_err(|source| {
            CommandError::io(format!("could not inspect contained file: {source}"))
        })?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile || stat.st_size < 0 {
            return Err(CommandError::validation(
                "contained entry is not a regular file",
            ));
        }
        Ok(stat.st_size as u64)
    }

    pub fn open(root: &Path, segments: &[&str], create: bool) -> Result<Self, CommandError> {
        let mut fd = openat(
            CWD,
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|source| {
            CommandError::io(format!("could not pin safe directory root: {source}"))
        })?;
        let mut path = root.to_path_buf();
        for segment in segments {
            validate_child_name(segment)?;
            let next = match openat(
                &fd,
                segment,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(next) => next,
                Err(source) if create && source == rustix::io::Errno::NOENT => {
                    mkdirat(&fd, segment, Mode::from_bits_truncate(0o700)).map_err(|error| {
                        CommandError::io(format!("could not create contained directory: {error}"))
                    })?;
                    fsync(&fd).map_err(|error| {
                        CommandError::io(format!("could not sync new directory parent: {error}"))
                    })?;
                    openat(
                        &fd,
                        segment,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(|error| {
                        CommandError::io(format!("could not pin new contained directory: {error}"))
                    })?
                }
                Err(source) => {
                    return Err(CommandError::io(format!(
                        "could not pin contained directory: {source}"
                    )))
                }
            };
            fd = next;
            path.push(segment);
        }
        Ok(Self { fd, path })
    }

    pub fn child_path(&self, name: &str) -> Result<PathBuf, CommandError> {
        validate_child_name(name)?;
        Ok(self.path.join(name))
    }

    pub fn validate_directory_tree(&self, name: &str) -> Result<(), CommandError> {
        validate_safe_directory_tree_at(self.fd.as_fd(), name)
    }

    pub fn entry_names(&self) -> Result<Vec<String>, CommandError> {
        let mut names = Vec::new();
        let mut directory = Dir::read_from(&self.fd).map_err(|source| {
            CommandError::io(format!("could not enumerate safe directory: {source}"))
        })?;
        while let Some(entry) = directory.read() {
            let entry = entry.map_err(|source| {
                CommandError::io(format!("could not enumerate safe directory: {source}"))
            })?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| CommandError::validation("contained entry name is not Unicode"))?
                .to_owned();
            if matches!(name.as_str(), "." | "..") {
                continue;
            }
            validate_child_name(&name)?;
            names.push(name);
        }
        names.sort();
        Ok(names)
    }

    /// Moves one validated directory between two pinned parents without replacing a destination.
    pub fn move_directory_no_replace(
        &self,
        source: &str,
        destination_parent: &SafeDirectory,
        destination: &str,
    ) -> Result<PublishState, PublishFailure> {
        self.move_directory_no_replace_using(source, destination_parent, destination, || {})
    }

    #[cfg(test)]
    fn move_directory_no_replace_with_hook<F: FnOnce()>(
        &self,
        source: &str,
        destination_parent: &SafeDirectory,
        destination: &str,
        hook: F,
    ) -> Result<PublishState, PublishFailure> {
        self.move_directory_no_replace_using(source, destination_parent, destination, hook)
    }

    fn move_directory_no_replace_using<F: FnOnce()>(
        &self,
        source: &str,
        destination_parent: &SafeDirectory,
        destination: &str,
        hook: F,
    ) -> Result<PublishState, PublishFailure> {
        validate_child_name(source).map_err(PublishFailure::not_published_preserve_source)?;
        validate_child_name(destination).map_err(PublishFailure::not_published_preserve_source)?;
        let source_fd = openat(
            &self.fd,
            source,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|source| {
            PublishFailure::not_published_preserve_source(CommandError::validation(format!(
                "contained directory source is unsafe: {source}"
            )))
        })?;
        let expected = directory_identity(source_fd.as_fd())
            .map_err(PublishFailure::not_published_preserve_source)?;
        validate_safe_directory_tree_fd(source_fd.as_fd())
            .map_err(PublishFailure::not_published_preserve_source)?;
        hook();
        let current = statat(&self.fd, source, AtFlags::SYMLINK_NOFOLLOW).map_err(|source| {
            PublishFailure::not_published_preserve_source(CommandError::io(format!(
                "could not revalidate contained directory source: {source}"
            )))
        })?;
        if directory_identity_from_stat(&current)
            .map_err(PublishFailure::not_published_preserve_source)?
            != expected
        {
            return Err(PublishFailure::not_published_preserve_source(
                CommandError::conflict("contained directory source identity changed before move"),
            ));
        }
        #[cfg(target_os = "macos")]
        {
            let source = CString::new(source).map_err(|_| {
                PublishFailure::not_published_preserve_source(CommandError::validation(
                    "invalid contained source name",
                ))
            })?;
            let destination = CString::new(destination).map_err(|_| {
                PublishFailure::not_published_preserve_source(CommandError::validation(
                    "invalid contained destination name",
                ))
            })?;
            let result = unsafe {
                renameatx_np(
                    self.fd.as_raw_fd(),
                    source.as_ptr(),
                    destination_parent.fd.as_raw_fd(),
                    destination.as_ptr(),
                    RENAME_EXCL,
                )
            };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                return if error.kind() == std::io::ErrorKind::AlreadyExists {
                    Err(PublishFailure::not_published_preserve_source(
                        CommandError::conflict("contained directory destination already exists"),
                    ))
                } else {
                    Err(PublishFailure::not_published_preserve_source(
                        CommandError::io(format!("could not move contained directory: {error}")),
                    ))
                };
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            if statat(
                &destination_parent.fd,
                destination,
                AtFlags::SYMLINK_NOFOLLOW,
            )
            .is_ok()
            {
                return Err(PublishFailure::not_published_preserve_source(
                    CommandError::conflict("contained directory destination already exists"),
                ));
            }
            renameat(&self.fd, source, &destination_parent.fd, destination).map_err(|error| {
                PublishFailure::not_published_preserve_source(CommandError::io(format!(
                    "could not move contained directory: {error}"
                )))
            })?;
        }
        let moved = statat(
            &destination_parent.fd,
            destination,
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|source| {
            PublishFailure::recovery_required(CommandError::io(format!(
                "could not identify moved contained directory: {source}"
            )))
        })?;
        if directory_identity_from_stat(&moved).map_err(PublishFailure::recovery_required)?
            != expected
        {
            return Err(PublishFailure::recovery_required(CommandError::io(
                "moved contained directory identity does not match its pinned source",
            )));
        }
        validate_safe_directory_tree_at(destination_parent.fd.as_fd(), destination)
            .map_err(PublishFailure::recovery_required)?;
        self.sync()
            .and_then(|()| destination_parent.sync())
            .map(|()| PublishState::Published)
            .map_err(PublishFailure::published_but_sync_failed)
    }

    pub fn recover(&self, name: &str) -> Result<(), CommandError> {
        validate_child_name(name)?;
        Ok(())
    }

    pub fn create_new(&self, name: &str) -> Result<fs::File, CommandError> {
        validate_child_name(name)?;
        let fd = openat(
            &self.fd,
            name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|source| CommandError::io(format!("could not create contained file: {source}")))?;
        Ok(fd.into())
    }

    pub(crate) fn create_new_publishable(&self, name: &str) -> Result<fs::File, CommandError> {
        self.create_new(name)
    }

    pub fn prepare_regular_file(&self, name: &str) -> Result<PathBuf, CommandError> {
        validate_child_name(name)?;
        if self.regular_file_exists(name)? {
            return Err(CommandError::validation("contained file already exists"));
        }
        let file = self.create_new(name)?;
        file.sync_all().map_err(|source| {
            CommandError::io(format!("could not sync new contained file: {source}"))
        })?;
        self.child_path(name)
    }

    pub fn sync_file(&self, name: &str) -> Result<(), CommandError> {
        validate_child_name(name)?;
        let fd = openat(
            &self.fd,
            name,
            OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|source| {
            CommandError::io(format!("could not open contained file for sync: {source}"))
        })?;
        fsync(fd)
            .map_err(|source| CommandError::io(format!("could not sync contained file: {source}")))
    }

    pub fn regular_file_exists(&self, name: &str) -> Result<bool, CommandError> {
        validate_child_name(name)?;
        match statat(&self.fd, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) if FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile => Ok(true),
            Ok(_) => Err(CommandError::validation(
                "contained entry is not a regular file",
            )),
            Err(source) if source == rustix::io::Errno::NOENT => Ok(false),
            Err(source) => Err(CommandError::io(format!(
                "could not inspect contained file: {source}"
            ))),
        }
    }

    pub fn entry_is_regular_file(&self, name: &str) -> Result<bool, CommandError> {
        validate_child_name(name)?;
        match statat(&self.fd, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => Ok(FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile),
            Err(source) if source == rustix::io::Errno::NOENT => Ok(false),
            Err(source) => Err(CommandError::io(format!(
                "could not inspect contained entry: {source}"
            ))),
        }
    }

    pub fn move_file(&self, source: &str, destination: &str) -> Result<(), CommandError> {
        let expected = self.regular_identity(source)?;
        if self.regular_file_exists(destination)? {
            return Err(CommandError::validation(
                "contained move destination already exists",
            ));
        }
        renameat(&self.fd, source, &self.fd, destination)
            .map_err(|error| CommandError::io(format!("could not move contained file: {error}")))?;
        if self.regular_identity(destination)? != expected {
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
        if let Err(error) = validate_child_name(source)
            .and_then(|()| validate_child_name(destination))
            .and_then(|()| validate_child_name(backup))
        {
            return Err(PublishFailure::not_published(error));
        }
        let expected = self
            .regular_identity(source)
            .map_err(PublishFailure::not_published)?;
        let has_destination = self
            .regular_file_exists(destination)
            .map_err(PublishFailure::not_published)?;
        if self
            .regular_file_exists(backup)
            .map_err(PublishFailure::not_published)?
        {
            return Err(PublishFailure::not_published(CommandError::validation(
                "replacement backup already exists",
            )));
        }
        if has_destination {
            linkat(&self.fd, destination, &self.fd, backup, AtFlags::empty()).map_err(
                |source| {
                    PublishFailure::not_published(CommandError::io(format!(
                        "could not preserve replaced file: {source}"
                    )))
                },
            )?;
        }
        match renameat(&self.fd, source, &self.fd, destination) {
            Ok(()) if self.regular_identity(destination).ok() == Some(expected) => {
                Ok(PublishState::Published)
            }
            Ok(()) => Err(PublishFailure::recovery_required(CommandError::io(
                "published file identity does not match replacement",
            ))),
            Err(source) => {
                if has_destination {
                    let _ = unlinkat(&self.fd, backup, AtFlags::empty());
                }
                Err(PublishFailure::not_published(CommandError::io(format!(
                    "could not atomically replace contained file: {source}"
                ))))
            }
        }
    }

    pub fn remove_checked(&self, name: &str) -> Result<bool, CommandError> {
        if !self.regular_file_exists(name)? {
            return Ok(false);
        }
        unlinkat(&self.fd, name, AtFlags::empty()).map_err(|source| {
            CommandError::io(format!("could not remove contained file: {source}"))
        })?;
        Ok(true)
    }

    pub(crate) fn publish_new(
        &self,
        source: &str,
        destination: &str,
        original: &fs::File,
    ) -> Result<NewFilePublishState, CommandError> {
        validate_child_name(source)?;
        validate_child_name(destination)?;
        let result = self.publish_new_platform(source, destination)?;
        if result == NewFilePublishState::Published {
            self.verify_published(destination, original)?;
        }
        Ok(result)
    }

    pub(crate) fn verify_published(
        &self,
        destination: &str,
        original: &fs::File,
    ) -> Result<(), CommandError> {
        if self.regular_identity(destination)? != regular_identity_from_file(original)? {
            return Err(CommandError::validation(
                "published contained file identity does not match its validated source",
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn publish_new_platform(
        &self,
        source: &str,
        destination: &str,
    ) -> Result<NewFilePublishState, CommandError> {
        let source = CString::new(source)
            .map_err(|_| CommandError::validation("invalid contained source name"))?;
        let destination = CString::new(destination)
            .map_err(|_| CommandError::validation("invalid contained destination name"))?;
        let result = unsafe {
            renameatx_np(
                self.fd.as_raw_fd(),
                source.as_ptr(),
                self.fd.as_raw_fd(),
                destination.as_ptr(),
                RENAME_EXCL,
            )
        };
        if result == 0 {
            return Ok(NewFilePublishState::Published);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Ok(NewFilePublishState::DestinationExists)
        } else {
            Err(CommandError::io(format!(
                "could not publish new contained file: {error}"
            )))
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn publish_new_platform(
        &self,
        source: &str,
        destination: &str,
    ) -> Result<NewFilePublishState, CommandError> {
        match linkat(&self.fd, source, &self.fd, destination, AtFlags::empty()) {
            Ok(()) => Ok(NewFilePublishState::Published),
            Err(source) if source == rustix::io::Errno::EXIST => {
                Ok(NewFilePublishState::DestinationExists)
            }
            Err(source) => Err(CommandError::io(format!(
                "could not publish new contained file: {source}"
            ))),
        }
    }

    fn regular_identity(&self, name: &str) -> Result<(u64, u64), CommandError> {
        validate_child_name(name)?;
        let stat = statat(&self.fd, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|source| {
            CommandError::io(format!("could not identify contained file: {source}"))
        })?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
            return Err(CommandError::validation(
                "contained entry is not a regular file",
            ));
        }
        Ok((stat.st_dev, stat.st_ino))
    }

    pub fn read(&self, name: &str, max_bytes: u64) -> Result<Vec<u8>, CommandError> {
        validate_child_name(name)?;
        let fd = openat(
            &self.fd,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|source| CommandError::io(format!("could not open contained file: {source}")))?;
        let mut file: fs::File = fd.into();
        let metadata = file.metadata().map_err(|source| {
            CommandError::io(format!("could not inspect contained file: {source}"))
        })?;
        if !metadata.is_file() || metadata.len() > max_bytes {
            return Err(CommandError::validation(
                "contained file is unsafe or too large",
            ));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes).map_err(|source| {
            CommandError::io(format!("could not read contained file: {source}"))
        })?;
        Ok(bytes)
    }

    pub fn publish(&self, source: &str, destination: &str) -> PublishResult {
        if let Err(error) =
            validate_child_name(source).and_then(|()| validate_child_name(destination))
        {
            return Err(PublishFailure::not_published(error));
        }
        let backup = format!(".{destination}.{}.replace-backup", Uuid::now_v7());
        let has_destination = statat(&self.fd, destination, AtFlags::SYMLINK_NOFOLLOW).is_ok();
        if has_destination {
            if let Err(source) = linkat(
                &self.fd,
                destination,
                &self.fd,
                backup.as_str(),
                AtFlags::empty(),
            ) {
                return Err(PublishFailure::not_published(CommandError::io(format!(
                    "could not preserve replaced file: {source}"
                ))));
            }
        }
        match renameat(&self.fd, source, &self.fd, destination) {
            Ok(()) => {
                if has_destination {
                    let _ = unlinkat(&self.fd, backup.as_str(), AtFlags::empty());
                }
                Ok(PublishState::Published)
            }
            Err(source) => {
                if has_destination {
                    let _ = unlinkat(&self.fd, backup.as_str(), AtFlags::empty());
                }
                Err(PublishFailure::not_published(CommandError::io(format!(
                    "could not atomically replace contained file: {source}"
                ))))
            }
        }
    }

    pub fn remove(&self, name: &str) {
        if validate_child_name(name).is_ok() {
            let _ = unlinkat(&self.fd, name, AtFlags::empty());
        }
    }

    pub fn sync(&self) -> Result<(), CommandError> {
        fsync(&self.fd).map_err(|source| {
            CommandError::io(format!("could not sync contained directory: {source}"))
        })
    }
}

fn validate_safe_directory_tree_at(parent: BorrowedFd<'_>, name: &str) -> Result<(), CommandError> {
    validate_child_name(name)?;
    let directory_fd = openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|source| {
        CommandError::validation(format!("contained directory tree is unsafe: {source}"))
    })?;
    validate_safe_directory_tree_fd(directory_fd.as_fd())
}

fn validate_safe_directory_tree_fd(directory_fd: BorrowedFd<'_>) -> Result<(), CommandError> {
    let mut directory = Dir::read_from(directory_fd).map_err(|source| {
        CommandError::io(format!("could not enumerate contained directory: {source}"))
    })?;
    while let Some(entry) = directory.read() {
        let entry = entry.map_err(|source| {
            CommandError::io(format!("could not enumerate contained directory: {source}"))
        })?;
        let child = entry
            .file_name()
            .to_str()
            .map_err(|_| CommandError::validation("contained entry name is not Unicode"))?;
        if matches!(child, "." | "..") {
            continue;
        }
        validate_child_name(child)?;
        let stat = statat(directory_fd, child, AtFlags::SYMLINK_NOFOLLOW).map_err(|source| {
            CommandError::io(format!(
                "could not inspect contained directory entry: {source}"
            ))
        })?;
        match FileType::from_raw_mode(stat.st_mode) {
            FileType::Directory => validate_safe_directory_tree_at(directory_fd, child)?,
            FileType::RegularFile => {}
            _ => {
                return Err(CommandError::validation(
                    "contained directory tree includes an unsafe entry",
                ))
            }
        }
    }
    Ok(())
}

fn directory_identity(fd: BorrowedFd<'_>) -> Result<(u64, u64), CommandError> {
    let stat = fstat(fd).map_err(|source| {
        CommandError::io(format!("could not identify contained directory: {source}"))
    })?;
    directory_identity_from_stat(&stat)
}

fn directory_identity_from_stat(stat: &rustix::fs::Stat) -> Result<(u64, u64), CommandError> {
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
        return Err(CommandError::validation(
            "contained directory source is not a directory",
        ));
    }
    Ok((stat.st_dev, stat.st_ino))
}

fn validate_child_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err(CommandError::validation("invalid contained path segment"));
    }
    Ok(())
}

fn regular_identity_from_file(file: &fs::File) -> Result<(u64, u64), CommandError> {
    let stat = fstat(file).map_err(|source| {
        CommandError::io(format!(
            "could not identify validated contained file: {source}"
        ))
    })?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(CommandError::validation(
            "validated contained entry is not a regular file",
        ));
    }
    Ok((stat.st_dev, stat.st_ino))
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[test]
    fn directory_move_remains_anchored_when_parent_paths_are_replaced() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("source")).unwrap();
        fs::create_dir(root.path().join("destination")).unwrap();
        fs::create_dir(root.path().join("source/capture")).unwrap();
        fs::write(root.path().join("source/capture/note.md"), b"durable").unwrap();
        let source = super::SafeDirectory::open(root.path(), &["source"], false).unwrap();
        let destination = super::SafeDirectory::open(root.path(), &["destination"], false).unwrap();
        fs::rename(
            root.path().join("source"),
            root.path().join("source-original"),
        )
        .unwrap();
        fs::rename(
            root.path().join("destination"),
            root.path().join("destination-original"),
        )
        .unwrap();
        fs::create_dir(root.path().join("source")).unwrap();
        fs::create_dir(root.path().join("destination")).unwrap();

        source
            .move_directory_no_replace("capture", &destination, "capture")
            .unwrap();

        assert!(!root.path().join("source/capture").exists());
        assert!(!root.path().join("destination/capture").exists());
        assert_eq!(
            fs::read(root.path().join("destination-original/capture/note.md")).unwrap(),
            b"durable"
        );
    }

    #[test]
    fn directory_move_detects_a_source_inode_replaced_after_validation() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("source")).unwrap();
        fs::create_dir(root.path().join("destination")).unwrap();
        fs::create_dir(root.path().join("source/capture")).unwrap();
        fs::write(root.path().join("source/capture/note.md"), b"original").unwrap();
        let source = super::SafeDirectory::open(root.path(), &["source"], false).unwrap();
        let destination = super::SafeDirectory::open(root.path(), &["destination"], false).unwrap();

        let result =
            source.move_directory_no_replace_with_hook("capture", &destination, "capture", || {
                fs::rename(
                    root.path().join("source/capture"),
                    root.path().join("source/original"),
                )
                .unwrap();
                fs::create_dir(root.path().join("source/capture")).unwrap();
                fs::write(root.path().join("source/capture/note.md"), b"swapped").unwrap();
            });

        assert!(result.is_err());
        assert!(!root.path().join("destination/capture").exists());
        assert_eq!(
            fs::read(root.path().join("source/original/note.md")).unwrap(),
            b"original"
        );
    }
}
