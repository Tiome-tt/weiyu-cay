use crate::{
    commands::storage::{StorageCommandState, StorageConsumer},
    domain::{
        FolderId, LinkRepairResult, NoteDocument, NoteId, NoteSummary, PurgeTrashResult,
        RenameNoteResult, RestoreTrashResult, StartupGuideTarget, TrashBatchResult, TrashEntry,
        TrashFolderEntry,
    },
    error::CommandError,
    storage::{
        database::Database,
        paths::StoragePaths,
        repository::{normalized_note_title, LinkRepairOutcome, LinkRepository, NoteRepository},
        trash::TrashService,
    },
    windows::sticky::{authorize_temporary_caller, TemporaryCommandOperation},
};
use serde::Deserialize;
use tauri::{Manager, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteInput {
    document: NoteDocument,
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateNoteInput {
    pub folder_id: Option<FolderId>,
    pub title: String,
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    prepare_startup_repository(&app.state::<StorageCommandState>())?;
    Ok(())
}

#[doc(hidden)]
pub fn prepare_startup_repository(state: &StorageCommandState) -> Result<(), CommandError> {
    if state.readiness().ensure_ready().is_err() {
        return Ok(());
    }
    prepare_startup_repository_after_recovery(state)
}

#[doc(hidden)]
pub fn prepare_startup_repository_after_recovery(
    state: &StorageCommandState,
) -> Result<(), CommandError> {
    let paths = state.configured_paths().clone();
    let pending_startup_guide = state.take_pending_startup_guide()?;
    let prepared = (|| {
        let guard = crate::platform::IndexMutationLock::acquire(paths.root())?;
        let database = Database::open(paths.database())?;
        database.migrate()?;
        database.close()?;
        if let Some(target) = pending_startup_guide {
            let target = create_getting_started_guide(&paths, target, &guard)?;
            state.publish_startup_guide_target(target)?;
        }
        Ok(())
    })();
    if prepared.is_err() {
        if let Some(target) = pending_startup_guide {
            state.restore_pending_startup_guide(target)?;
        }
    }
    prepared?;
    upgrade_getting_started_guide(&paths)
}

const LEGACY_GETTING_STARTED_MARKDOWN: &str = r#"# 欢迎来到微屿 🌿

微屿是一款安静、轻巧的本地 Markdown 笔记应用。无需登录，也不依赖网络，你的笔记会保存在自己的设备上。

## 从这里开始

你可以试着：

- 新建一篇笔记，随手写下此刻的想法
- 创建文件夹，整理不同主题的内容
- 在源码、分屏和预览三种视图间切换
- 为笔记添加标签
- 使用 `[[笔记标题]]` 连接两篇笔记

## 关于 Markdown

微屿使用 Markdown 保存笔记。即使以后不再使用微屿，你仍然可以用其他文本编辑器打开这些文件。

```markdown
# 一级标题
## 二级标题

- 无序列表
- 另一项内容

**粗体**、*斜体* 和 `行内代码`
```

## 临时便笺

灵感突然出现时，可以使用临时便笺快速记录。关闭便笺窗口不会删除内容，你可以稍后在主应用的临时收件箱中整理它。

## 你的内容属于你

笔记正文和图片会作为普通文件保存在本地。删除操作可以通过回收站或撤销恢复，不必担心一次误操作让内容永久消失。

---

现在，新建你的第一篇笔记吧。

这篇引导笔记也可以随时删除。
"#;

const GETTING_STARTED_MARKDOWN: &str = r#"# 欢迎来到微屿 🌿

微屿是一款安静、轻巧的本地 Markdown 笔记应用。无需登录，也不依赖网络，你的笔记会保存在自己的设备上。

## 从这里开始

你可以试着：

- 新建一篇笔记，随手写下此刻的想法
- 创建文件夹，整理不同主题的内容
- 在源码、分屏和预览三种视图间切换
- 为笔记添加标签
- 使用 `[[笔记标题]]` 连接两篇笔记

## 关于 Markdown

Markdown 用简单符号表达文章结构，笔记仍是可以用普通文本编辑器打开的文件。下面这些写法已足够应对大多数记录：

````markdown
# 一级标题
## 二级标题

**粗体**、*斜体*、~~删除线~~ 和 `行内代码`

- 无序列表
1. 有序列表
- [ ] 任务项

> 引用一段重要内容

[显示文字](https://example.com)
![图片说明](图片路径)

分隔线使用三个短横线：

---

```text
一段代码
```
````

编辑器的“＋”菜单和右键菜单可以快速插入表格、代码块、图片和内部链接；也可以直接粘贴图片。

## 临时便笺

按 `Ctrl+Shift+D`（macOS 为 `Command+Shift+D`）可以从任何位置快速调出便笺。便笺可以钉在桌面最上层；关闭窗口只会隐藏内容，不会删除记录。你也可以在设置中修改全局快捷键。

之后回到主应用的“临时便笺”，可以继续整理内容，并将便笺转为正式笔记。

---

现在，新建你的第一篇笔记吧。
"#;

#[doc(hidden)]
pub fn legacy_getting_started_markdown() -> &'static str {
    LEGACY_GETTING_STARTED_MARKDOWN
}

#[doc(hidden)]
pub fn getting_started_markdown() -> &'static str {
    GETTING_STARTED_MARKDOWN
}

fn upgrade_getting_started_guide(paths: &StoragePaths) -> Result<(), CommandError> {
    let Some(folder) = super::folders::FolderRepository::new(paths.clone())
        .list()?
        .into_iter()
        .find(|folder| folder.parent_id.is_none() && folder.name == "开始使用")
    else {
        return Ok(());
    };
    let notes = NoteRepository::new(paths.clone());
    let Some(summary) = notes
        .list_in_folder(Some(folder.id))?
        .into_iter()
        .find(|note| note.title == "欢迎来到微屿")
    else {
        return Ok(());
    };
    let mut document = notes.load(summary.id)?;
    let previous_guide = GETTING_STARTED_MARKDOWN
        .replace("分隔线使用三个短横线：\n\n---", "---")
        .replace(
            "现在，新建你的第一篇笔记吧。\n",
            "现在，新建你的第一篇笔记吧。\n\n这篇引导笔记也可以随时删除。\n",
        );
    let previous_shortcut_guide = previous_guide
        .replace("Ctrl+Shift+D", "Ctrl+Shift+Space")
        .replace("Command+Shift+D", "Command+Shift+Space");
    if document.markdown != LEGACY_GETTING_STARTED_MARKDOWN
        && document.markdown != previous_guide
        && document.markdown != previous_shortcut_guide
    {
        return Ok(());
    }
    document.markdown = GETTING_STARTED_MARKDOWN.to_owned();
    document.updated_at = chrono::Utc::now().to_rfc3339();
    let expected_revision = document.revision;
    notes.save(document, expected_revision)?;
    Ok(())
}
fn create_getting_started_guide(
    paths: &StoragePaths,
    target: StartupGuideTarget,
    guard: &crate::platform::IndexMutationLock,
) -> Result<StartupGuideTarget, CommandError> {
    let folder = super::folders::FolderRepository::new(paths.clone()).ensure_system_root_locked(
        target.folder_id,
        "开始使用",
        guard,
    )?;
    let notes = NoteRepository::new(paths.clone());
    match notes.load_locked(target.note_id, guard) {
        Ok(note) => {
            if note.kind != crate::domain::NoteKind::Formal || note.folder_id != Some(folder.id) {
                return Err(CommandError::conflict(
                    "startup guide identity belongs to another note",
                ));
            }
            return Ok(target);
        }
        Err(error) if error.code() == crate::error::CommandErrorCode::NotFound => {}
        Err(error) => return Err(error),
    }
    let now = chrono::Utc::now().to_rfc3339();
    notes.create_locked(
        NoteDocument {
            id: target.note_id,
            kind: crate::domain::NoteKind::Formal,
            title: "欢迎来到微屿".to_owned(),
            folder_id: Some(folder.id),
            tags: Vec::new(),
            markdown: GETTING_STARTED_MARKDOWN.to_owned(),
            revision: 0,
            created_at: now.clone(),
            updated_at: now,
        },
        guard,
    )?;
    Ok(target)
}

#[tauri::command]
pub fn startup_guide_target(
    window: tauri::Window,
    state: State<'_, StorageCommandState>,
) -> Result<Option<StartupGuideTarget>, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "startup guide target requires the main window",
        ));
    }
    state.startup_guide_target()
}

#[tauri::command]
pub fn complete_startup_guide(
    window: tauri::Window,
    state: State<'_, StorageCommandState>,
    target: StartupGuideTarget,
) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "startup guide completion requires the main window",
        ));
    }
    state.complete_startup_guide(target)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_note(
    state: State<'_, StorageCommandState>,
    input: CreateNoteInput,
) -> Result<NoteDocument, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Notes)?.root(),
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    repository(&state)?.create_locked(
        NoteDocument {
            id: NoteId::now_v7(),
            kind: crate::domain::NoteKind::Formal,
            title: normalized_note_title(&input.title)?,
            folder_id: input.folder_id,
            tags: Vec::new(),
            markdown: String::new(),
            revision: 0,
            created_at: now.clone(),
            updated_at: now,
        },
        &guard,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_note(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
    title: String,
) -> Result<RenameNoteResult, CommandError> {
    rename_note_in_storage(state.paths_for(StorageConsumer::Notes)?, note_id, &title)
}

#[doc(hidden)]
pub fn rename_note_in_storage(
    paths: &StoragePaths,
    note_id: NoteId,
    title: &str,
) -> Result<RenameNoteResult, CommandError> {
    rename_note_in_storage_with_repair(paths, note_id, title, |links, target_id, title, guard| {
        links.rename_target_labels_with_target_locked(target_id, title, guard)
    })
}

#[doc(hidden)]
pub fn rename_note_in_storage_with_repair<Repair>(
    paths: &StoragePaths,
    note_id: NoteId,
    title: &str,
    repair: Repair,
) -> Result<RenameNoteResult, CommandError>
where
    Repair: FnOnce(
        &LinkRepository,
        NoteId,
        &str,
        &crate::platform::IndexMutationLock,
    ) -> Result<LinkRepairOutcome, CommandError>,
{
    let guard = crate::platform::IndexMutationLock::acquire(paths.root())?;
    let notes = NoteRepository::new(paths.clone());
    let document = notes.rename_note_locked(note_id, title, &guard)?;
    let repair_outcome = repair(
        &LinkRepository::new(paths.clone()),
        note_id,
        &document.title,
        &guard,
    )
    .unwrap_or_else(|error| LinkRepairOutcome {
        result: LinkRepairResult {
            updated: 0,
            failed_source_ids: Vec::new(),
            failure: Some(error.into()),
        },
        target_document: None,
    });
    // Self-link repair returns the exact revision it durably published, avoiding
    // a second fallible load after the rename has already committed.
    let document = repair_outcome.target_document.unwrap_or(document);
    Ok(RenameNoteResult {
        document,
        link_repair: repair_outcome.result,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_note(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<NoteDocument, CommandError> {
    repository(&state)?.load(note_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_note(
    state: State<'_, StorageCommandState>,
    input: SaveNoteInput,
) -> Result<NoteDocument, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Notes)?.root(),
    )?;
    repository(&state)?.save_locked(input.document, input.expected_revision, &guard)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_notes(
    state: State<'_, StorageCommandState>,
    folder_id: Option<FolderId>,
) -> Result<Vec<NoteSummary>, CommandError> {
    repository(&state)?.list_in_folder(folder_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn move_note(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
    folder_id: Option<FolderId>,
) -> Result<NoteDocument, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Notes)?.root(),
    )?;
    repository(&state)?.move_note_locked(note_id, folder_id, &guard)
}

#[tauri::command(rename_all = "camelCase")]
pub fn reorder_notes(
    state: State<'_, StorageCommandState>,
    folder_id: Option<FolderId>,
    ordered_ids: Vec<NoteId>,
) -> Result<(), CommandError> {
    repository(&state)?.reorder_notes(folder_id, ordered_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn trash_notes(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    note_ids: Vec<NoteId>,
) -> Result<TrashBatchResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Delete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone())
        .trash(note_ids, &chrono::Utc::now().to_rfc3339())
}

#[tauri::command]
pub fn list_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
) -> Result<Vec<TrashEntry>, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::List, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone()).list()
}

#[tauri::command]
pub fn list_trash_folders(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
) -> Result<Vec<TrashFolderEntry>, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::List, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone()).list_folder_trash()
}
#[tauri::command(rename_all = "camelCase")]
pub fn restore_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    note_ids: Vec<NoteId>,
) -> Result<RestoreTrashResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::UndoDelete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone()).restore(note_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn undo_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    operation_id: String,
) -> Result<RestoreTrashResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::UndoDelete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone()).undo(&operation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn purge_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    note_ids: Vec<NoteId>,
) -> Result<PurgeTrashResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Delete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone()).purge(note_ids)
}

#[tauri::command]
pub fn purge_expired_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
) -> Result<PurgeTrashResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Delete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone())
        .purge_expired(&chrono::Utc::now().to_rfc3339())
}

#[tauri::command(rename_all = "camelCase")]
pub fn resolve_link(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<Option<NoteSummary>, CommandError> {
    LinkRepository::new(state.paths_for(StorageConsumer::Links)?.clone()).resolve(note_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn backlinks(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<Vec<NoteSummary>, CommandError> {
    LinkRepository::new(state.paths_for(StorageConsumer::Links)?.clone()).backlinks(note_id)
}

#[tauri::command]
pub fn list_link_targets(
    state: State<'_, StorageCommandState>,
) -> Result<Vec<NoteSummary>, CommandError> {
    Ok(repository(&state)?
        .list()?
        .into_iter()
        .filter(|note| note.kind == crate::domain::NoteKind::Formal)
        .collect())
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_target_labels(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
    title: String,
) -> Result<LinkRepairResult, CommandError> {
    LinkRepository::new(state.paths_for(StorageConsumer::Links)?.clone())
        .rename_target_labels(note_id, &title)
}

fn repository(state: &StorageCommandState) -> Result<NoteRepository, CommandError> {
    Ok(NoteRepository::new(
        state.paths_for(StorageConsumer::Notes)?.clone(),
    ))
}
