#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{replace_file, replace_file_with_backup, sync_parent, SafeDirectory};
#[cfg(windows)]
pub use windows::{replace_file, replace_file_with_backup, sync_parent, SafeDirectory};
