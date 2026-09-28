use crate::{
    commands::{
        assets::read_image_assets_from,
        storage::{StorageCommandState, StorageConsumer},
    },
    domain::NoteId,
    error::CommandError,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager, State, WebviewWindow};

#[cfg(any(target_os = "windows", target_os = "macos"))]
const SERVICE_NAME: &str = "com.cay.simplenotes";
#[cfg(target_os = "macos")]
const CREDENTIAL_USER: &str = "ai-summary-key";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const API_KEY_CREDENTIAL_USER: &str = "ai-summary-api-key";
const CREDENTIAL_FILE: &str = "ai-credentials.json.enc";
#[cfg(target_os = "windows")]
const MASTER_KEY_FILE: &str = "ai-master.key.dpapi";
const MAX_SUMMARY_INPUT_TOKENS: usize = 80_000;
const COMPRESSION_CHUNK_TOKENS: usize = 24_000;
const MAX_COMPRESSION_PASSES: usize = 6;
const SUMMARY_CACHE_FILE: &str = "ai-summary-cache.json";
const SUMMARY_CACHE_VERSION: u32 = 7;
const ANNOTATION_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCredentials {
    version: u32,
    provider: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCredentialStatus {
    pub configured: bool,
    pub storage: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepSeekSummaryRequest {
    pub note_id: String,
    pub title: String,
    pub markdown: String,
    pub model: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSummaryResult {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub key_points: Vec<String>,
    #[serde(default)]
    pub outline: Vec<SummaryOutlineItem>,
    #[serde(default)]
    pub todos: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub emphasis: Vec<SummaryEmphasis>,
    #[serde(default)]
    pub annotation_status: Option<String>,
    #[serde(default)]
    pub annotation_version: Option<u32>,
    #[serde(default)]
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryEmphasis {
    pub kind: String,
    pub quote: String,
    #[serde(default)]
    pub block_id: Option<String>,
    #[serde(default)]
    pub occurrence: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryOutlineItem {
    pub heading: String,
    pub points: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AnnotationResponse {
    #[serde(default)]
    emphasis: Vec<SummaryEmphasis>,
}
#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: Option<String>,
}

#[tauri::command]
pub fn get_ai_credential_status(window: WebviewWindow) -> Result<AiCredentialStatus, CommandError> {
    authorize(&window)?;
    let path = credential_path(window.app_handle())?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let keyring_configured = read_keyring_api_key().is_some();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let keyring_configured = false;
    let encrypted_configured = path.exists();
    Ok(AiCredentialStatus {
        configured: encrypted_configured || keyring_configured,
        storage: if encrypted_configured {
            "encrypted-file"
        } else if keyring_configured {
            "system-keyring"
        } else {
            "encrypted-file"
        },
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn save_deepseek_api_key(
    window: WebviewWindow,
    api_key: String,
) -> Result<AiCredentialStatus, CommandError> {
    authorize(&window)?;
    let api_key = api_key.trim();
    if api_key.is_empty() || api_key.len() > 500 {
        return Err(CommandError::validation(
            "DeepSeek API key has an invalid length",
        ));
    }
    let app = window.app_handle();
    let root = app.path().app_data_dir().map_err(|error| {
        CommandError::io(format!(
            "could not resolve AI credential directory: {error}"
        ))
    })?;
    let path = save_encrypted_api_key(&root, api_key).map_err(|error| {
        eprintln!("[ai] encrypted-file save failed: {error:?}");
        error
    })?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    remove_keyring_api_key();
    if decrypt_secret(&path, app)? != api_key {
        return Err(CommandError::io("AI credential write verification failed"));
    }
    Ok(AiCredentialStatus {
        configured: true,
        storage: "encrypted-file",
    })
}

#[tauri::command]
pub fn clear_deepseek_api_key(window: WebviewWindow) -> Result<AiCredentialStatus, CommandError> {
    authorize(&window)?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    remove_keyring_api_key();
    let path = credential_path(window.app_handle())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            CommandError::io(format!("could not remove AI credentials: {error}"))
        })?;
    }
    Ok(AiCredentialStatus {
        configured: false,
        storage: "encrypted-file",
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_cached_ai_summary(
    window: WebviewWindow,
    note_id: String,
) -> Result<Option<AiSummaryResult>, CommandError> {
    authorize(&window)?;
    if note_id.trim().is_empty() || note_id.len() > 128 {
        return Err(CommandError::validation("invalid note ID"));
    }
    read_cached_summary(window.app_handle(), note_id.as_str())
}

#[tauri::command]
pub async fn summarize_with_deepseek(
    window: WebviewWindow,
    state: State<'_, StorageCommandState>,
    request: DeepSeekSummaryRequest,
) -> Result<AiSummaryResult, CommandError> {
    authorize(&window)?;
    let app = window.app_handle();
    let note_id = request.note_id;
    emit_progress(
        app,
        note_id.as_str(),
        "cache",
        0,
        1,
        "正在读取已保存的 AI 总结…",
    );
    if !request.force {
        if let Some(cached) = read_cached_summary(app, note_id.as_str())? {
            emit_progress(
                app,
                note_id.as_str(),
                "complete",
                1,
                1,
                "已读取已保存的 AI 总结",
            );
            return Ok(cached);
        }
    }

    let markdown = request.markdown.trim();
    if markdown.is_empty() {
        return Err(CommandError::validation("note content is empty"));
    }

    let api_key = decrypt_secret(&credential_path(app)?, app)?;
    let model = match request.model.as_deref() {
        Some("deepseek-v4-pro") => "deepseek-v4-pro",
        _ => "deepseek-flash",
    };
    let client = reqwest::Client::new();
    let mut prepared =
        prepare_markdown_for_summary(&client, &api_key, &state, app, note_id.as_str(), markdown)
            .await?;

    prepared = compress_summary_input(&client, &api_key, app, note_id.as_str(), &prepared).await?;

    emit_progress(app, note_id.as_str(), "summary", 0, 1, "正在生成 AI 总结…");
    let body = json!({
        "model": model,
        "stream": false,
        "thinking": { "type": "disabled" },
        "max_tokens": 8192,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": "你是微屿的笔记整理助手。只根据用户提供的笔记内容总结，不补充笔记中没有的事实；无法确认的内容不要猜测。图表描述已经插入原文对应位置，必须把图表中的有效信息与相邻正文一起综合到 summary、keyPoints、outline 中，不要单独输出图片说明。若图片无法读取，只能依据图表占位文字和相邻正文说明，不能臆测图中数据。为避免输出被截断：summary 用一两句话表达核心论点，不要罗列主题名；keyPoints 从原始笔记中选全篇真正值得记住的判断、关键机制、可靠依据或必要限制，按重要性排序，写成可独立理解的完整要点，避免术语清单、泛泛事实和与 outline 重复；keyPoints 最多 6 条，outline 必须保留原文中的全部章节标题，outline 下的要点数量和详略由模型根据内容自行规划；内容较多时压缩表述，但不要遗漏章节，keywords 最多 8 个；每条要点尽量不超过 60 个中文字符。输出严格 JSON，字段为 summary、keyPoints、outline（对象数组，每项含 heading 和 points）、keywords。不要生成 emphasis，稍后会单独对已生成的总结进行标签分析。" },
            { "role": "user", "content": format!("笔记标题：{}\n\n笔记内容：\n{}", request.title.trim(), prepared) }
        ]
    });
    let response = client
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(api_key.as_str())
        .json(&body)
        .send()
        .await
        .map_err(|error| CommandError::io(format!("DeepSeek request failed: {error}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(CommandError::io(format!(
            "DeepSeek request returned status {status}: {detail}"
        )));
    }
    let payload = response.json::<ChatResponse>().await.map_err(|error| {
        CommandError::io(format!("DeepSeek response could not be decoded: {error}"))
    })?;
    let choice = payload
        .choices
        .first()
        .ok_or_else(|| CommandError::io("DeepSeek returned no summary choices"))?;
    if choice.finish_reason.as_deref() == Some("length") {
        return Err(CommandError::io(
            "DeepSeek summary was truncated by the output limit; please regenerate",
        ));
    }
    let content = choice
        .message
        .content
        .as_deref()
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .ok_or_else(|| CommandError::io("DeepSeek returned an empty summary"))?;
    let mut summary = parse_summary_response(content)?;
    summary.emphasis.clear();
    summary.source_hash = Some(format!("{:x}", Sha256::digest(markdown.as_bytes())));
    summary.annotation_version = Some(ANNOTATION_VERSION);
    summary.annotation_status = Some("failed".to_owned());
    save_cached_summary(app, note_id.as_str(), &summary)?;
    emit_progress(app, note_id.as_str(), "labels", 0, 1, "正在给总结标注重点…");
    if let Ok(labels) = label_summary(&client, &api_key, model, &summary).await {
        summary.emphasis = labels;
        summary.annotation_status = Some("ready".to_owned());
        save_cached_summary(app, note_id.as_str(), &summary)?;
    }
    emit_progress(
        app,
        note_id.as_str(),
        "complete",
        1,
        1,
        "AI 总结已完成并保存",
    );
    Ok(summary)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn relabel_ai_summary(
    window: WebviewWindow,
    note_id: String,
    model: Option<String>,
) -> Result<AiSummaryResult, CommandError> {
    authorize(&window)?;
    if note_id.trim().is_empty() || note_id.len() > 128 {
        return Err(CommandError::validation("invalid note ID"));
    }
    let app = window.app_handle();
    let mut summary = read_cached_summary(app, note_id.as_str())?
        .ok_or_else(|| CommandError::validation("no saved AI summary to relabel"))?;
    let api_key = decrypt_secret(&credential_path(app)?, app)?;
    let model = match model.as_deref() {
        Some("deepseek-v4-pro") => "deepseek-v4-pro",
        _ => "deepseek-flash",
    };
    emit_progress(
        app,
        note_id.as_str(),
        "labels",
        0,
        1,
        "正在重新标注已保存的总结…",
    );
    let labels = label_summary(&reqwest::Client::new(), &api_key, model, &summary).await?;
    summary.emphasis = labels;
    summary.annotation_status = Some("ready".to_owned());
    summary.annotation_version = Some(ANNOTATION_VERSION);
    save_cached_summary(app, note_id.as_str(), &summary)?;
    emit_progress(app, note_id.as_str(), "complete", 1, 1, "重点标注已更新");
    Ok(summary)
}
async fn label_summary(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    summary: &AiSummaryResult,
) -> Result<Vec<SummaryEmphasis>, CommandError> {
    let material = json!({
        "summary": summary.summary,
        "keyPoints": summary.key_points,
        "outline": summary.outline,
        "keywords": summary.keywords,
    });
    let body = json!({
        "model": model,
        "stream": false,
        "thinking": { "type": "disabled" },
        "max_tokens": 4096,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": "你是微屿总结的语义标注器。只分析输入的已生成总结，不改写、不补充事实。只输出 JSON 对象，字段 emphasis 为数组，每项包含 kind、blockId、quote、occurrence（从 0 开始）。kind 仅允许 concept（定义是什么）、mechanism（如何工作、因果、流程或关键差异）、evidence（明确支撑说法的数据、公式、实验或实例）、conclusion（综合判断或答案，非普通事实）、action（笔记明确决定执行的事，不能自行提出建议）、caveat（明示的前提、例外、风险或代价）。blockId 仅允许 summary、keyPoints/序号、outline/序号/heading、outline/序号/points/序号，序号从 0 开始。quote 必须逐字出现在所指块中；同块重复时 occurrence 指定第几次。先比较整份总结的所有内容，按全篇价值排序，只挑选真正帮助读者记住或运用笔记的少数重点，通常约三到五处，内容简单可以更少，长文有独立重点时可以更多；不要按章节或类别凑数。数组顺序即重要性顺序。quote 要含足够上下文，能作为完整短句或关键分句独立理解；不要只标术语、孤立数字、章节标题或泛泛事实。summary 仅在包含其他区块没有的核心判断时可选。同一信息在多个区块重复时只留内容最完整的一处。量化成效属于 evidence，不属于 caveat；caveat 只用于明确前提、例外、风险或代价，action 只用于笔记明确提出的待做行动。不要跨块或重叠。允许 emphasis 为空数组。关键词只留在 keywords，不做正文语义标注。不要返回颜色、HTML 或 CSS。" },
            { "role": "user", "content": material.to_string() }
        ]
    });
    let response = client
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            CommandError::io(format!("DeepSeek annotation request failed: {error}"))
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(CommandError::io(format!(
            "DeepSeek annotation request returned status {status}: {detail}"
        )));
    }
    let payload = response.json::<ChatResponse>().await.map_err(|error| {
        CommandError::io(format!(
            "DeepSeek annotation response could not be decoded: {error}"
        ))
    })?;
    let choice = payload
        .choices
        .first()
        .ok_or_else(|| CommandError::io("DeepSeek returned no annotation choices"))?;
    if choice.finish_reason.as_deref() == Some("length") {
        return Err(CommandError::io(
            "DeepSeek annotation was truncated by the output limit; please regenerate",
        ));
    }
    let content = choice
        .message
        .content
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| CommandError::io("DeepSeek returned empty annotations"))?;
    parse_annotation_response(content, summary)
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AiSummaryCache {
    version: u32,
    entries: HashMap<String, AiSummaryResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSummaryProgress {
    note_id: String,
    phase: String,
    current: usize,
    total: usize,
    message: String,
}

fn emit_progress(
    app: &tauri::AppHandle,
    note_id: &str,
    phase: &str,
    current: usize,
    total: usize,
    message: &str,
) {
    let _ = app.emit_to(
        "main",
        "ai-summary-progress",
        AiSummaryProgress {
            note_id: note_id.to_owned(),
            phase: phase.to_owned(),
            current,
            total,
            message: message.to_owned(),
        },
    );
}

fn summary_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|root| root.join(SUMMARY_CACHE_FILE))
        .map_err(|error| {
            CommandError::io(format!("could not resolve AI summary cache path: {error}"))
        })
}

fn read_cached_summary(
    app: &tauri::AppHandle,
    note_id: &str,
) -> Result<Option<AiSummaryResult>, CommandError> {
    read_cached_summary_at(&summary_cache_path(app)?, note_id)
}

fn read_cached_summary_at(
    path: &Path,
    note_id: &str,
) -> Result<Option<AiSummaryResult>, CommandError> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path)
        .map_err(|error| CommandError::io(format!("could not read AI summary cache: {error}")))?;
    let cache = serde_json::from_slice::<AiSummaryCache>(&bytes).unwrap_or_default();
    if cache.version > SUMMARY_CACHE_VERSION {
        return Ok(None);
    }
    Ok(cache.entries.get(note_id).cloned())
}

fn save_cached_summary(
    app: &tauri::AppHandle,
    note_id: &str,
    summary: &AiSummaryResult,
) -> Result<(), CommandError> {
    save_cached_summary_at(&summary_cache_path(app)?, note_id, summary)
}

fn save_cached_summary_at(
    path: &Path,
    note_id: &str,
    summary: &AiSummaryResult,
) -> Result<(), CommandError> {
    let mut cache = if path.exists() {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<AiSummaryCache>(&bytes).ok())
            .unwrap_or_default()
    } else {
        AiSummaryCache::default()
    };
    if cache.version > SUMMARY_CACHE_VERSION {
        cache.entries.clear();
    }
    cache.version = SUMMARY_CACHE_VERSION;
    cache.entries.insert(note_id.to_owned(), summary.clone());
    let bytes = serde_json::to_vec_pretty(&cache)
        .map_err(|error| CommandError::io(format!("could not encode AI summary cache: {error}")))?;
    atomic_write(path, &bytes)
}
#[derive(Debug, Clone)]
struct MarkdownImageReference {
    start: usize,
    end: usize,
    alt: String,
    path: String,
}

fn extract_markdown_images(markdown: &str) -> Vec<MarkdownImageReference> {
    let mut references = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = markdown[cursor..].find("![") {
        let start = cursor + relative;
        let label_start = start + 2;
        let Some(label_offset) = markdown[label_start..].find(']') else {
            break;
        };
        let label_end = label_start + label_offset;
        let open = label_end + 1;
        if markdown.as_bytes().get(open) != Some(&b'(') {
            cursor = label_end + 1;
            continue;
        }
        let content_start = open + 1;
        let Some(close_offset) = markdown[content_start..].find(')') else {
            break;
        };
        let end = content_start + close_offset + 1;
        let inside = markdown[content_start..content_start + close_offset].trim();
        let path = inside
            .strip_prefix('<')
            .and_then(|value| value.strip_suffix('>'))
            .unwrap_or_else(|| inside.split_whitespace().next().unwrap_or(""));
        if !path.is_empty()
            && !path.starts_with("http://")
            && !path.starts_with("https://")
            && !path.starts_with("data:")
            && !path.starts_with('#')
        {
            references.push(MarkdownImageReference {
                start,
                end,
                alt: markdown[label_start..label_end].trim().to_owned(),
                path: path.to_owned(),
            });
        }
        cursor = end;
    }
    references
}

fn unique_image_paths(references: &[MarkdownImageReference]) -> Vec<String> {
    let mut seen = HashSet::new();
    references
        .iter()
        .filter(|reference| seen.insert(reference.path.as_str()))
        .map(|reference| reference.path.clone())
        .collect()
}

async fn prepare_markdown_for_summary(
    client: &reqwest::Client,
    api_key: &str,
    state: &StorageCommandState,
    app: &tauri::AppHandle,
    note_id: &str,
    markdown: &str,
) -> Result<String, CommandError> {
    let references = extract_markdown_images(markdown);
    if references.is_empty() {
        emit_progress(app, note_id, "images", 1, 1, "未发现需要提取的图表");
        return Ok(markdown.to_owned());
    }
    let unique_paths = unique_image_paths(&references);
    let total = unique_paths.len();
    let paths = state.paths_for(StorageConsumer::Assets)?;
    let mut descriptions = HashMap::new();
    let asset_note_id = NoteId::parse_str(note_id).map_err(|_| {
        CommandError::validation("当前笔记的旧格式 ID 无法读取图表：未生成不完整总结")
    })?;
    for (index, path) in unique_paths.iter().enumerate() {
        emit_progress(
            app,
            note_id,
            "images",
            index,
            total,
            &format!("正在提取第 {} / {} 张图表的信息…", index + 1, total),
        );
        let storage_paths = paths.clone();
        let image_path = path.clone();
        let mut assets = tauri::async_runtime::spawn_blocking(move || {
            read_image_assets_from(&storage_paths, asset_note_id, &[image_path])
        })
        .await
        .map_err(|error| CommandError::io(format!("第 {} 张图表读取任务失败：{error}", index + 1)))?
        .map_err(|error| CommandError::io(format!("第 {} 张图表读取失败：{error}", index + 1)))?;
        let asset = assets
            .pop()
            .ok_or_else(|| CommandError::io(format!("第 {} 张图表没有返回图片数据", index + 1)))?;
        let description = describe_image(client, api_key, &asset.media_type, &asset.bytes)
            .await
            .map_err(|error| {
                CommandError::io(format!("第 {} 张图表描述失败：{error}", index + 1))
            })?;
        descriptions.insert(path.clone(), description);
    }
    emit_progress(app, note_id, "images", total, total, "图表信息提取完成");
    replace_image_references(markdown, references, &descriptions)
}

fn replace_image_references(
    markdown: &str,
    references: Vec<MarkdownImageReference>,
    descriptions: &HashMap<String, String>,
) -> Result<String, CommandError> {
    let mut prepared = markdown.to_owned();
    for reference in references.into_iter().rev() {
        let description = descriptions
            .get(&reference.path)
            .ok_or_else(|| CommandError::io("有图表尚未完成描述，未保存不完整总结"))?;
        let label = reference.alt.trim();
        let replacement = if label.is_empty() {
            format!("【图表描述】{description}")
        } else {
            format!("【图表描述】{label}：{description}")
        };
        prepared.replace_range(reference.start..reference.end, &replacement);
    }
    Ok(prepared)
}

async fn describe_image(
    client: &reqwest::Client,
    api_key: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<String, CommandError> {
    let data_url = format!("data:{};base64,{}", media_type, BASE64.encode(bytes));
    let body = json!({
        "model": "deepseek-flash",
        "stream": false,
        "thinking": { "type": "disabled" },
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": "你是图表信息提取器。只输出一小段中文描述，保留图表中的标题、标签、数值、趋势、关系和结论，去掉装饰、重复和无关噪声；看不清的内容不要猜。" },
            { "role": "user", "content": [
                { "type": "text", "text": "请提取这张图片或图表中对笔记总结有用的关键信息。" },
                { "type": "image_url", "image_url": { "url": data_url, "detail": "high" } }
            ] }
        ]
    });
    let response = client
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| CommandError::io(format!("DeepSeek image request failed: {error}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(CommandError::io(format!(
            "DeepSeek image request returned status {status}: {detail}"
        )));
    }
    let payload = response.json::<ChatResponse>().await.map_err(|error| {
        CommandError::io(format!(
            "DeepSeek image response could not be decoded: {error}"
        ))
    })?;
    payload
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone())
        .map(|content| content.trim().to_owned())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| CommandError::io("DeepSeek returned an empty image description"))
}

fn estimate_tokens(text: &str) -> usize {
    let (ascii, other) = text.chars().fold((0usize, 0usize), |(ascii, other), ch| {
        if ch.is_ascii() {
            (ascii + 1, other)
        } else {
            (ascii, other + 1)
        }
    });
    ascii.div_ceil(4) + other.saturating_mul(2)
}

// Chunking preserves every character and its original order. Only the model may condense content.
fn split_for_compression(text: &str, max_tokens: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut chunk = String::new();
    let (mut ascii, mut other) = (0usize, 0usize);
    for ch in text.chars() {
        let next_ascii = ascii + usize::from(ch.is_ascii());
        let next_other = other + usize::from(!ch.is_ascii());
        if !chunk.is_empty() && next_ascii.div_ceil(4) + next_other * 2 > max_tokens {
            chunks.push(std::mem::take(&mut chunk));
            ascii = 0;
            other = 0;
        }
        chunk.push(ch);
        ascii += usize::from(ch.is_ascii());
        other += usize::from(!ch.is_ascii());
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

fn compact_blank_lines(text: &str) -> String {
    let mut compact = String::with_capacity(text.len());
    let mut previous_blank = false;
    for line in text.split_inclusive('\n') {
        let blank = line.trim().is_empty();
        if !blank || !previous_blank {
            compact.push_str(line);
        }
        previous_blank = blank;
    }
    compact
}

async fn compress_summary_input(
    client: &reqwest::Client,
    api_key: &str,
    app: &tauri::AppHandle,
    note_id: &str,
    markdown: &str,
) -> Result<String, CommandError> {
    let mut prepared = compact_blank_lines(markdown);
    for pass in 0..MAX_COMPRESSION_PASSES {
        if estimate_tokens(&prepared) <= MAX_SUMMARY_INPUT_TOKENS {
            return Ok(prepared);
        }
        let chunks = split_for_compression(&prepared, COMPRESSION_CHUNK_TOKENS);
        let total = chunks.len();
        let mut compressed = Vec::with_capacity(total);
        for (index, chunk) in chunks.iter().enumerate() {
            emit_progress(
                app,
                note_id,
                "compress",
                index,
                total,
                &format!(
                    "正在压缩第 {} 轮、第 {} / {} 段…",
                    pass + 1,
                    index + 1,
                    total
                ),
            );
            compressed.push(compress_chunk(client, api_key, chunk).await?);
            emit_progress(
                app,
                note_id,
                "compress",
                index + 1,
                total,
                &format!("已压缩第 {} 轮、第 {} / {} 段", pass + 1, index + 1, total),
            );
        }
        let next = compressed.join("\n\n");
        if estimate_tokens(&next) >= estimate_tokens(&prepared) {
            return Err(CommandError::io(
                "DeepSeek did not reduce the summary input; no partial summary was saved",
            ));
        }
        prepared = next;
    }
    if estimate_tokens(&prepared) > MAX_SUMMARY_INPUT_TOKENS {
        return Err(CommandError::io("summary input remains above the model context after compression; no partial summary was saved"));
    }
    Ok(prepared)
}

async fn compress_chunk(
    client: &reqwest::Client,
    api_key: &str,
    chunk: &str,
) -> Result<String, CommandError> {
    let body = json!({
        "model": "deepseek-flash",
        "stream": false,
        "thinking": { "type": "disabled" },
        "max_tokens": 8192,
        "messages": [
            { "role": "system", "content": "你正在压缩一篇笔记的连续片段，以便后续全文总结。保持原文顺序，保留所有章节标题、图表描述中的关键数值/关系/结论、定义、论据和重要例外；只删除重复或无关噪声。不要补充事实，不要把图表一概写成无法读取。输出压缩后的正文，不要前言或 JSON。" },
            { "role": "user", "content": chunk }
        ]
    });
    let response = client
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            CommandError::io(format!("DeepSeek compression request failed: {error}"))
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(CommandError::io(format!(
            "DeepSeek compression returned status {status}: {detail}"
        )));
    }
    let payload = response.json::<ChatResponse>().await.map_err(|error| {
        CommandError::io(format!(
            "DeepSeek compression response could not be decoded: {error}"
        ))
    })?;
    let choice = payload
        .choices
        .first()
        .ok_or_else(|| CommandError::io("DeepSeek returned no compression choices"))?;
    if choice.finish_reason.as_deref() == Some("length") {
        return Err(CommandError::io(
            "DeepSeek compression output was truncated; no partial summary was saved",
        ));
    }
    choice
        .message
        .content
        .as_deref()
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| CommandError::io("DeepSeek returned an empty compressed segment"))
}
fn parse_summary_response(content: &str) -> Result<AiSummaryResult, CommandError> {
    let trimmed = content.trim();
    let without_fence = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    let candidate = if without_fence.starts_with('{') {
        without_fence
    } else if let (Some(start), Some(end)) = (without_fence.find('{'), without_fence.rfind('}')) {
        &without_fence[start..=end]
    } else {
        without_fence
    };
    serde_json::from_str::<AiSummaryResult>(candidate)
        .map(normalize_summary)
        .map_err(|error| {
            CommandError::io(format!("DeepSeek returned invalid summary JSON: {error}"))
        })
}
fn parse_annotation_response(
    content: &str,
    summary: &AiSummaryResult,
) -> Result<Vec<SummaryEmphasis>, CommandError> {
    let trimmed = content.trim();
    let without_fence = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    let candidate = if without_fence.starts_with('{') {
        without_fence
    } else if let (Some(start), Some(end)) = (without_fence.find('{'), without_fence.rfind('}')) {
        &without_fence[start..=end]
    } else {
        without_fence
    };
    let response = serde_json::from_str::<AnnotationResponse>(candidate).map_err(|error| {
        CommandError::io(format!(
            "DeepSeek returned invalid annotation JSON: {error}"
        ))
    })?;
    let mut validated = summary.clone();
    validated.emphasis = response.emphasis;
    Ok(normalize_summary(validated).emphasis)
}
fn authorize(window: &WebviewWindow) -> Result<(), CommandError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(CommandError::validation(
            "AI summary requires the main window",
        ))
    }
}

fn credential_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CREDENTIAL_FILE))
        .map_err(|error| CommandError::io(format!("could not resolve AI credential path: {error}")))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn read_keyring_api_key() -> Option<String> {
    let entry = keyring::Entry::new(SERVICE_NAME, API_KEY_CREDENTIAL_USER).ok()?;
    entry.get_password().ok()
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn remove_keyring_api_key() {
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, API_KEY_CREDENTIAL_USER) {
        let _ = entry.delete_credential();
    }
}
fn save_encrypted_api_key(root: &Path, api_key: &str) -> Result<PathBuf, CommandError> {
    let key = software_master_key_at(root)?;
    let encrypted = encrypt_secret_with_key(api_key, &key)?;
    let encoded = serde_json::to_vec(&encrypted)
        .map_err(|error| CommandError::io(format!("could not encode AI credentials: {error}")))?;
    let path = root.join(CREDENTIAL_FILE);
    atomic_write(&path, &encoded)?;
    Ok(path)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            CommandError::io(format!("could not create AI credential directory: {error}"))
        })?;
    }
    let temp = path.with_extension("json.enc.tmp");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|error| {
            CommandError::io(format!(
                "could not open AI credentials staging file: {error}"
            ))
        })?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| CommandError::io(format!("could not flush AI credentials: {error}")))?;
    drop(file);
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(_error) if path.exists() => {
            fs::remove_file(path).map_err(|remove_error| {
                CommandError::io(format!("could not replace AI credentials: {remove_error}"))
            })?;
            fs::rename(&temp, path).map_err(|rename_error| {
                CommandError::io(format!("could not publish AI credentials: {rename_error}"))
            })
        }
        Err(error) => Err(CommandError::io(format!(
            "could not publish AI credentials: {error}"
        ))),
    }
}

fn encrypt_secret_with_key(
    secret: &str,
    key: &[u8; 32],
) -> Result<EncryptedCredentials, CommandError> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce_bytes: [u8; 12] = rand::random();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), secret.as_bytes())
        .map_err(|_| CommandError::io("could not encrypt AI credentials"))?;
    Ok(EncryptedCredentials {
        version: 3,
        provider: "deepseek".to_owned(),
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
}

fn software_master_key(app: &tauri::AppHandle) -> Result<[u8; 32], CommandError> {
    let root = app.path().app_data_dir().map_err(|error| {
        CommandError::io(format!(
            "could not resolve AI software key directory: {error}"
        ))
    })?;
    software_master_key_at(&root)
}

fn software_master_key_at(root: &Path) -> Result<[u8; 32], CommandError> {
    let path = root.join("ai-software.key");
    match fs::read(&path) {
        Ok(bytes) if bytes.len() == 32 => {
            let mut key = [0_u8; 32];
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        Ok(_) => Err(CommandError::io("AI software key has invalid length")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|create_error| {
                    CommandError::io(format!(
                        "could not create AI software key directory: {create_error}"
                    ))
                })?;
            }
            let key: [u8; 32] = rand::random();
            atomic_write(&path, &key)?;
            Ok(key)
        }
        Err(error) => Err(CommandError::io(format!(
            "could not read AI software key: {error}"
        ))),
    }
}

fn decrypt_secret(path: &Path, app: &tauri::AppHandle) -> Result<String, CommandError> {
    if path.exists() {
        return decrypt_encrypted_file(path, app);
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    if let Some(api_key) = read_keyring_api_key() {
        return Ok(api_key);
    }
    decrypt_encrypted_file(path, app)
}

fn decrypt_encrypted_file(path: &Path, app: &tauri::AppHandle) -> Result<String, CommandError> {
    let bytes = fs::read(path)
        .map_err(|error| CommandError::io(format!("could not read AI credentials: {error}")))?;
    let stored = serde_json::from_slice::<EncryptedCredentials>(&bytes)
        .map_err(|error| CommandError::io(format!("AI credentials are damaged: {error}")))?;
    if stored.provider != "deepseek" {
        return Err(CommandError::validation(
            "AI credential format is unsupported",
        ));
    }

    if stored.version == 3 {
        let nonce = BASE64
            .decode(stored.nonce)
            .map_err(|_| CommandError::io("AI credential nonce is invalid"))?;
        let ciphertext = BASE64
            .decode(stored.ciphertext)
            .map_err(|_| CommandError::io("AI credential payload is invalid"))?;
        let key = software_master_key(app)?;
        return ChaCha20Poly1305::new(Key::from_slice(&key))
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| CommandError::io("AI credentials could not be decrypted"))
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|_| CommandError::io("AI credential text is invalid"))
            });
    }

    if stored.version == 2 {
        #[cfg(target_os = "windows")]
        {
            let protected = BASE64
                .decode(stored.ciphertext)
                .map_err(|_| CommandError::io("AI credential payload is invalid"))?;
            let bytes = dpapi_unprotect(&protected)?;
            return String::from_utf8(bytes)
                .map_err(|_| CommandError::io("AI credential text is invalid"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err(CommandError::unsupported(
                "Windows AI credentials cannot be read on this platform",
            ));
        }
    }

    if stored.version != 1 {
        return Err(CommandError::validation(
            "AI credential format is unsupported",
        ));
    }
    let nonce = BASE64
        .decode(stored.nonce)
        .map_err(|_| CommandError::io("AI credential nonce is invalid"))?;
    let ciphertext = BASE64
        .decode(stored.ciphertext)
        .map_err(|_| CommandError::io("AI credential payload is invalid"))?;
    let key = master_key(app)?;
    ChaCha20Poly1305::new(Key::from_slice(&key))
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| CommandError::io("AI credentials could not be decrypted"))
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| CommandError::io("AI credential text is invalid"))
        })
}
#[cfg(target_os = "windows")]
fn master_key(app: &tauri::AppHandle) -> Result<[u8; 32], CommandError> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| {
            CommandError::io(format!("could not resolve AI master key path: {error}"))
        })?
        .join(MASTER_KEY_FILE);
    let protected = fs::read(&path).map_err(|error| {
        CommandError::io(format!(
            "could not read Windows protected AI master key: {error}"
        ))
    })?;
    let key = dpapi_unprotect(&protected)?;
    key.try_into()
        .map_err(|_| CommandError::io("Windows protected AI master key has invalid length"))
}
#[cfg(all(target_os = "windows", test))]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, CommandError> {
    use std::{ptr::null_mut, slice};
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len())
            .map_err(|_| CommandError::validation("AI master key is too large"))?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let result = unsafe {
        CryptProtectData(
            &mut input,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 {
        return Err(CommandError::io(format!(
            "Windows DPAPI could not protect the AI master key: {}",
            unsafe { GetLastError() }
        )));
    }
    if output.pbData.is_null() {
        return Err(CommandError::io(
            "Windows DPAPI returned an empty protected AI master key",
        ));
    }
    let protected =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(protected)
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, CommandError> {
    use std::{ptr::null_mut, slice};
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len())
            .map_err(|_| CommandError::validation("protected AI master key is too large"))?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let result = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 {
        return Err(CommandError::io(format!(
            "Windows DPAPI could not unprotect the AI master key: {}",
            unsafe { GetLastError() }
        )));
    }
    if output.pbData.is_null() {
        return Err(CommandError::io(
            "Windows DPAPI returned an empty AI master key",
        ));
    }
    let key = unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(key)
}

#[cfg(target_os = "macos")]
fn master_key(_app: &tauri::AppHandle) -> Result<[u8; 32], CommandError> {
    let entry = keyring::Entry::new(SERVICE_NAME, CREDENTIAL_USER).map_err(|error| {
        CommandError::io(format!(
            "could not open the system credential store: {error}"
        ))
    })?;
    let encoded = entry.get_password().map_err(|error| {
        CommandError::io(format!(
            "could not read the AI credential key from the system credential store: {error}"
        ))
    })?;
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| CommandError::io("stored AI credential key is invalid"))?;
    bytes
        .try_into()
        .map_err(|_| CommandError::io("stored AI credential key has invalid length"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn master_key(_app: &tauri::AppHandle) -> Result<[u8; 32], CommandError> {
    Err(CommandError::unsupported(
        "secure AI credentials are currently supported on Windows and macOS only",
    ))
}
fn normalize_summary(mut summary: AiSummaryResult) -> AiSummaryResult {
    summary.summary = if summary.summary.trim().is_empty() {
        "暂无一句话总结。".to_owned()
    } else {
        summary.summary.trim().to_owned()
    };
    summary.key_points = normalize_list(summary.key_points, 6);
    summary.todos.clear();
    summary.keywords = normalize_list(summary.keywords, 8);
    summary.outline = summary
        .outline
        .into_iter()
        .filter_map(|item| {
            let heading = item.heading.trim().to_owned();
            if heading.is_empty() {
                None
            } else {
                Some(SummaryOutlineItem {
                    heading,
                    points: normalize_all_list(item.points),
                })
            }
        })
        .collect();
    let candidates = std::mem::take(&mut summary.emphasis);
    let mut occupied: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    summary.emphasis = candidates
        .into_iter()
        .filter_map(|item| {
            if !matches!(
                item.kind.as_str(),
                "concept" | "mechanism" | "evidence" | "conclusion" | "action" | "caveat"
            ) {
                return None;
            }
            let block_id = item.block_id.as_deref()?;
            let occurrence = item.occurrence?;
            let quote = item.quote.trim();
            if quote.is_empty() || quote.len() > 500 {
                return None;
            }
            let block = summary_block(&summary, block_id)?;
            let (start, matched) = block.match_indices(quote).nth(occurrence)?;
            let end = start + matched.len();
            let spans = occupied.entry(block_id.to_owned()).or_default();
            if spans
                .iter()
                .any(|(left, right)| start < *right && end > *left)
            {
                return None;
            }
            spans.push((start, end));
            Some(SummaryEmphasis {
                kind: item.kind,
                quote: quote.to_owned(),
                block_id: Some(block_id.to_owned()),
                occurrence: Some(occurrence),
            })
        })
        .collect();
    summary
}

fn summary_block<'a>(summary: &'a AiSummaryResult, block_id: &str) -> Option<&'a str> {
    let parts: Vec<&str> = block_id.split('/').collect();
    match parts.as_slice() {
        ["summary"] => Some(summary.summary.as_str()),
        ["keyPoints", index] => summary
            .key_points
            .get(index.parse::<usize>().ok()?)
            .map(String::as_str),
        ["outline", index, "heading"] => summary
            .outline
            .get(index.parse::<usize>().ok()?)
            .map(|item| item.heading.as_str()),
        ["outline", index, "points", point] => summary
            .outline
            .get(index.parse::<usize>().ok()?)?
            .points
            .get(point.parse::<usize>().ok()?)
            .map(String::as_str),
        _ => None,
    }
}
fn normalize_all_list(items: Vec<String>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}
fn normalize_list(items: Vec<String>, limit: usize) -> Vec<String> {
    items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .take(limit)
        .collect()
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{
        dpapi_protect, dpapi_unprotect, save_encrypted_api_key, software_master_key_at,
        EncryptedCredentials, SERVICE_NAME,
    };
    use base64::Engine;

    #[test]
    fn dpapi_round_trip_preserves_an_api_key_payload() {
        let secret = b"sk-test-api-key-payload";
        let protected = dpapi_protect(secret).expect("DPAPI should protect an API key payload");
        assert_ne!(protected, secret);
        assert_eq!(
            dpapi_unprotect(&protected).expect("DPAPI should unprotect an API key payload"),
            secret
        );
    }

    #[test]
    fn windows_keyring_round_trip_preserves_a_test_api_key() {
        let user = "ai-summary-api-key-test";
        let entry = keyring::Entry::new(SERVICE_NAME, user)
            .expect("Windows keyring entry should be created");
        entry
            .set_password("sk-test-keyring-payload")
            .expect("Windows keyring should accept a test credential");
        assert_eq!(
            entry
                .get_password()
                .expect("Windows keyring should return a test credential"),
            "sk-test-keyring-payload"
        );
        entry
            .delete_credential()
            .expect("Windows keyring test credential should be removable");
    }

    #[test]
    fn software_encrypted_file_round_trip_preserves_an_api_key_payload() {
        use chacha20poly1305::{
            aead::{Aead, KeyInit},
            ChaCha20Poly1305, Key, Nonce,
        };
        use std::fs;
        use tempfile::tempdir;

        let directory = tempdir().expect("temporary credential directory should be created");
        let path = save_encrypted_api_key(directory.path(), "sk-software-test-key")
            .expect("software encrypted credentials should be saved");
        let stored =
            fs::read_to_string(&path).expect("encrypted credential file should be readable");
        assert!(!stored.contains("sk-software-test-key"));
        let key =
            software_master_key_at(directory.path()).expect("software key should be readable");
        let parsed: EncryptedCredentials =
            serde_json::from_str(&stored).expect("credential JSON should be valid");
        let nonce = super::BASE64
            .decode(parsed.nonce)
            .expect("nonce should be base64");
        let ciphertext = super::BASE64
            .decode(parsed.ciphertext)
            .expect("ciphertext should be base64");
        let plaintext = ChaCha20Poly1305::new(Key::from_slice(&key))
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .expect("software encrypted credentials should decrypt");
        assert_eq!(plaintext, b"sk-software-test-key");
    }
}

#[cfg(test)]
mod summary_behavior_tests {
    use super::{
        estimate_tokens, extract_markdown_images, parse_summary_response, DeepSeekSummaryRequest,
    };

    #[test]
    fn extracts_local_markdown_images_but_ignores_remote_images() {
        let references =
            extract_markdown_images("![图表](assets/chart.png) ![远程](https://example.com/a.png)");
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].path, "assets/chart.png");
        assert_eq!(references[0].alt, "图表");
    }

    #[test]
    fn collects_every_unique_image_in_document_order() {
        let markdown = (0..25)
            .map(|index| format!("![图表{index}](assets/screenshot-{index}.png)"))
            .chain(std::iter::once(
                "![重复](assets/screenshot-0.png)".to_owned(),
            ))
            .collect::<Vec<_>>()
            .join("\n");
        let references = extract_markdown_images(&markdown);
        let paths = super::unique_image_paths(&references);
        assert_eq!(paths.len(), 25);
        assert_eq!(
            paths.first().map(String::as_str),
            Some("assets/screenshot-0.png")
        );
        assert_eq!(
            paths.last().map(String::as_str),
            Some("assets/screenshot-24.png")
        );
    }

    #[test]
    fn chart_descriptions_replace_images_at_their_original_positions() {
        let markdown = "甲![一](assets/one.png)乙![二](assets/two.png)丙![重复](assets/one.png)丁";
        let references = extract_markdown_images(markdown);
        let descriptions = std::collections::HashMap::from([
            ("assets/one.png".to_owned(), "向上".to_owned()),
            ("assets/two.png".to_owned(), "向下".to_owned()),
        ]);
        let prepared = super::replace_image_references(markdown, references, &descriptions)
            .expect("every local image is described");
        assert_eq!(
            prepared,
            "甲【图表描述】一：向上乙【图表描述】二：向下丙【图表描述】重复：向上丁"
        );
    }
    #[test]
    fn long_input_chunks_keep_every_chart_and_original_order() {
        let source = "# 开始\n【图表描述】第一张：增长\n普通文字很多\n## 中间\n【图表描述】第二张：下降\n# 结束";
        let chunks = super::split_for_compression(source, 24);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.concat(), source);
        assert!(chunks.iter().all(|chunk| estimate_tokens(chunk) <= 24));
    }

    #[test]
    fn chinese_token_estimate_is_not_divided_by_four() {
        assert!(estimate_tokens(&"中文".repeat(100)) >= 200);
    }

    #[test]
    fn parses_fenced_summary_json() {
        let summary = parse_summary_response("模型输出：\n```json\n{\"summary\":\"摘要\"}\n```")
            .expect("fenced JSON should be accepted");
        assert_eq!(summary.summary, "摘要");
    }

    #[test]
    fn legacy_unlocated_labels_are_not_applied_to_new_summaries() {
        let raw = r#"{"summary":"注意力降低重复计算。","emphasis":[{"kind":"conclusion","quote":"降低重复计算"}]}"#;
        let summary = parse_summary_response(raw).expect("summary should parse");
        assert!(summary.emphasis.is_empty());
    }
    #[test]
    fn annotation_pass_keeps_only_exact_location_bound_quotes_and_cannot_rewrite_summary() {
        let summary = parse_summary_response(
            r#"{"summary":"注意力关注不同关系。","keyPoints":["但长序列成本较高。"]}"#,
        )
        .expect("summary");
        let labels = super::parse_annotation_response(
            r#"{"summary":"篡改内容","emphasis":[
                {"kind":"conclusion","blockId":"summary","quote":"关注不同关系","occurrence":0},
                {"kind":"caveat","blockId":"keyPoints/0","quote":"长序列成本较高","occurrence":0},
                {"kind":"evidence","blockId":"summary","quote":"虚构数字","occurrence":0},
                {"kind":"keyword","blockId":"summary","quote":"注意力","occurrence":0}
            ]}"#,
            &summary,
        )
        .expect("labels");
        assert_eq!(summary.summary, "注意力关注不同关系。");
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].kind, "conclusion");
        assert_eq!(labels[1].kind, "caveat");
        assert!(super::parse_annotation_response(
            r#"{"emphasis":[{"kind":"evidence","blockId":"summary","quote":"虚构数字","occurrence":0}]}"#,
            &summary,
        ).expect("empty valid subset").is_empty());
    }
    #[test]
    fn accepts_annotation_quote_from_outline_heading() {
        let summary = parse_summary_response(
            r#"{"summary":"全文摘要。","outline":[{"heading":"参数高效微调","points":["方法概述。"]}]}"#,
        ).expect("summary");
        let labels = super::parse_annotation_response(
            r#"{"emphasis":[{"kind":"concept","blockId":"outline/0/heading","quote":"参数高效微调","occurrence":0}]}"#,
            &summary,
        ).expect("heading label");
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].quote, "参数高效微调");
    }
    #[test]
    fn annotation_accepts_six_roles_only_at_the_named_block() {
        let summary = parse_summary_response(
            r#"{"summary":"问题已解决。","keyPoints":["原因是缓存失效。","周五前修复。"],"outline":[{"heading":"排查","points":["仅在离线模式发生。"]}]}"#,
        ).expect("summary");
        let labels = super::parse_annotation_response(
            r#"{"emphasis":[
                {"kind":"conclusion","blockId":"summary","quote":"问题已解决","occurrence":0},
                {"kind":"mechanism","blockId":"keyPoints/0","quote":"缓存失效","occurrence":0},
                {"kind":"action","blockId":"keyPoints/1","quote":"周五前修复","occurrence":0},
                {"kind":"caveat","blockId":"outline/0/points/0","quote":"仅在离线模式","occurrence":0},
                {"kind":"concept","blockId":"outline/0/heading","quote":"排查","occurrence":0},
                {"kind":"evidence","blockId":"keyPoints/0","quote":"不存在","occurrence":0},
                {"kind":"keySentence","blockId":"keyPoints/0","quote":"原因","occurrence":0}
            ]}"#,
            &summary,
        ).expect("valid labels");
        assert_eq!(super::ANNOTATION_VERSION, 2);
        assert_eq!(labels.len(), 5);
        let saved = serde_json::to_value(&labels).expect("encode");
        assert_eq!(saved[1]["blockId"], "keyPoints/0");
        assert_eq!(saved[2]["kind"], "action");
    }

    #[test]
    fn annotation_rejects_overlapping_and_wrong_occurrences_but_allows_empty() {
        let summary = parse_summary_response(r#"{"summary":"甲乙甲乙。"}"#).expect("summary");
        let labels = super::parse_annotation_response(
            r#"{"emphasis":[
                {"kind":"concept","blockId":"summary","quote":"甲乙","occurrence":1},
                {"kind":"conclusion","blockId":"summary","quote":"乙甲","occurrence":0},
                {"kind":"action","blockId":"summary","quote":"甲乙","occurrence":3}
            ]}"#,
            &summary,
        )
        .expect("valid subset");
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].kind, "concept");
        assert!(super::parse_annotation_response(r#"{"emphasis":[]}"#, &summary).is_ok());
    }
    #[test]
    fn saves_and_reloads_summary_without_a_model_request() {
        let directory = tempfile::tempdir().expect("temporary cache directory");
        let path = directory.path().join("ai-summary-cache.json");
        let summary = super::AiSummaryResult {
            summary: "已保存的结论".to_owned(),
            key_points: vec!["关键点".to_owned()],
            ..Default::default()
        };
        super::save_cached_summary_at(&path, "legacy-note-id", &summary)
            .expect("summary should be written");
        let restored = super::read_cached_summary_at(&path, "legacy-note-id")
            .expect("cache should be readable")
            .expect("summary should survive reopening");
        assert_eq!(restored.summary, summary.summary);
        assert_eq!(restored.key_points, summary.key_points);
    }
    #[test]
    fn preserves_older_cache_entries_when_saving_another_note() {
        let directory = tempfile::tempdir().expect("temporary cache directory");
        let path = directory.path().join("ai-summary-cache.json");
        std::fs::write(
            &path,
            r#"{"version":5,"entries":{"first":{"summary":"旧总结","keyPoints":[],"outline":[],"todos":[],"keywords":[]}}}"#,
        )
        .expect("older cache should be written");
        let next = super::AiSummaryResult {
            summary: "新总结".to_owned(),
            ..Default::default()
        };
        super::save_cached_summary_at(&path, "second", &next).expect("new summary should be saved");
        let older = super::read_cached_summary_at(&path, "first")
            .expect("cache should be readable")
            .expect("older summary should remain");
        assert_eq!(older.summary, "旧总结");
    }
    #[test]
    fn accepts_legacy_note_ids_at_ai_boundary() {
        let request: DeepSeekSummaryRequest =
            serde_json::from_str(r#"{"noteId":"legacy-note-id","title":"标题","markdown":"正文"}"#)
                .expect("AI command should accept legacy note IDs");
        assert_eq!(request.note_id, "legacy-note-id");
    }
}
