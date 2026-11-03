use crate::{
    commands::storage::{StorageCommandState, StorageConsumer},
    domain::{NoteContent, NoteId},
    error::CommandError,
    platform::{IndexMutationLock, SafeDirectory},
    storage::{entry, repository::NoteRepository},
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

pub const POLICY: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; sandbox allow-scripts";
const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Default)]
pub struct HtmlPreviews(Mutex<VecDeque<(String, Arc<Vec<u8>>)>>);
impl HtmlPreviews {
    pub fn insert(&self, bytes: Vec<u8>) -> Result<String, CommandError> {
        if bytes.len() as u64 > MAX_BYTES {
            return Err(CommandError::validation("HTML exceeds 8 MiB"));
        }
        let token = NoteId::now_v7().to_string();
        let mut entries = self
            .0
            .lock()
            .map_err(|_| CommandError::io("preview cache unavailable"))?;
        while entries.len() >= 4 {
            entries.pop_front();
        }
        entries.push_back((token.clone(), Arc::new(bytes)));
        Ok(token)
    }
    pub fn get(&self, token: &str) -> Option<Arc<Vec<u8>>> {
        self.0
            .lock()
            .ok()?
            .iter()
            .find(|(key, _)| key == token)
            .map(|(_, bytes)| bytes.clone())
    }
}

#[tauri::command]
pub async fn create_html_preview(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    previews: State<'_, HtmlPreviews>,
    note_id: NoteId,
) -> Result<String, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "HTML preview requires the main window",
        ));
    }
    let paths = state.paths_for(StorageConsumer::Notes)?.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let guard = IndexMutationLock::acquire(paths.root())?;
        let note = NoteRepository::new(paths.clone()).load_locked(note_id, &guard)?;
        let Some(NoteContent::File { file }) = note.content else {
            return Err(CommandError::validation("not an HTML attachment"));
        };
        let extension = std::path::Path::new(&file.original_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "html" | "htm") || file.size > MAX_BYTES {
            return Err(CommandError::validation("unsupported or oversized HTML"));
        }
        let directory = SafeDirectory::open(paths.root(), &["notes", &note_id.to_string()], false)?;
        entry::read_payload(&directory, &file)
    })
    .await
    .map_err(|_| CommandError::io("HTML preview read failed"))??;
    previews.insert(bytes)
}

pub fn respond(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let token = request.uri().path().trim_start_matches('/');
    let bytes = if context.webview_label() == "main" && request.method() == tauri::http::Method::GET
    {
        context.app_handle().state::<HtmlPreviews>().get(token)
    } else {
        None
    };
    let response = tauri::http::Response::builder()
        .status(if bytes.is_some() { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", POLICY)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(
            bytes
                .map(|value| value.as_ref().clone())
                .unwrap_or_default(),
        )
        .expect("static HTML response headers");
    responder.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_tokens_are_bounded_and_do_not_resolve_note_ids_or_paths() {
        let previews = HtmlPreviews::default();
        let first = previews
            .insert(b"<script>quiz()</script>".to_vec())
            .unwrap();
        assert!(previews.get(&first).is_some());
        assert!(previews.get("../notes/private").is_none());
        for _ in 0..4 {
            previews.insert(Vec::new()).unwrap();
        }
        assert!(previews.get(&first).is_none());
        assert!(previews.insert(vec![0; MAX_BYTES as usize + 1]).is_err());
        assert!(POLICY.contains("sandbox allow-scripts"));
        assert!(!POLICY.contains("allow-same-origin"));
    }
}
