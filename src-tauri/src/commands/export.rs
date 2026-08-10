use crate::{
    commands::storage::{StorageCommandState, StorageConsumer},
    error::CommandError,
    storage::export::{export_library as export_library_to, ExportReport},
};
use std::path::Path;
use tauri::State;

#[tauri::command(rename_all = "camelCase")]
pub fn export_library(
    state: State<'_, StorageCommandState>,
    destination: String,
) -> Result<ExportReport, CommandError> {
    export_library_to(
        state.paths_for(StorageConsumer::Export),
        Path::new(&destination),
        env!("CARGO_PKG_VERSION"),
    )
}
