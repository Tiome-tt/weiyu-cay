use crate::error::CommandError;
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path, ptr};

const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

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

pub fn replace_file(source: &Path, destination: &Path) -> Result<(), CommandError> {
    let destination_exists = destination.exists();
    let source = wide(source.as_os_str());
    let destination = wide(destination.as_os_str());
    let succeeded = unsafe {
        if destination_exists {
            ReplaceFileW(
                destination.as_ptr(),
                source.as_ptr(),
                ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
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
        return Err(CommandError::io(format!(
            "could not atomically replace document: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

pub fn sync_parent(_parent: &Path) -> Result<(), CommandError> {
    // ReplaceFileW/MoveFileExW use write-through. Windows does not provide a
    // portable directory fsync equivalent for ordinary application handles.
    Ok(())
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
