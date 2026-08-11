use crate::error::CommandError;
use tauri_plugin_opener::OpenerExt;

pub fn validate_external_url(value: &str) -> Result<String, CommandError> {
    if value.chars().any(char::is_control) {
        return Err(CommandError::validation(
            "external URL contains a control character",
        ));
    }
    let parsed =
        url::Url::parse(value).map_err(|_| CommandError::validation("external URL is invalid"))?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => {}
        "mailto" if !parsed.path().is_empty() => {}
        _ => {
            return Err(CommandError::validation(
                "external URL protocol is not allowed",
            ))
        }
    }
    Ok(parsed.into())
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_external_link(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    url: String,
) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "external links can be opened only from the main window",
        ));
    }
    let url = validate_external_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|source| CommandError::io(format!("could not open external URL: {source}")))
}
