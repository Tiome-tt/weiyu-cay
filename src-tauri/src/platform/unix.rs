use crate::{
    error::CommandError,
    storage::atomic_file::{PublishFailure, PublishResult, PublishState},
};
use rustix::{
    fd::OwnedFd,
    fs::{fsync, linkat, mkdirat, openat, renameat, statat, unlinkat, AtFlags, Mode, OFlags, CWD},
};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use uuid::Uuid;

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

pub struct SafeDirectory {
    fd: OwnedFd,
    path: PathBuf,
}

impl SafeDirectory {
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

fn validate_child_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err(CommandError::validation("invalid contained path segment"));
    }
    Ok(())
}
