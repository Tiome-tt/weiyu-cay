#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{replace_file, sync_parent};
#[cfg(windows)]
pub use windows::{replace_file, sync_parent};
