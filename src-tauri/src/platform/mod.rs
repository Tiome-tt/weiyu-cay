#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{recover_file, replace_file, replace_file_with_backup, sync_parent, SafeDirectory};
#[cfg(windows)]
pub use windows::{
    recover_file, replace_file, replace_file_with_backup, sync_parent, SafeDirectory,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NewFilePublishState {
    Published,
    DestinationExists,
}
