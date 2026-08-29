use crate::{
    domain::{NoteDocument, NoteId, NoteKind, TemporaryWindowState},
    error::CommandError,
    platform::IndexMutationLock,
    storage::{
        database::Database,
        paths::StoragePaths,
        repository::{note_id_blob, note_id_from_blob, NoteRepository},
    },
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

pub const MIN_WINDOW_WIDTH: f64 = 240.0;
pub const MIN_WINDOW_HEIGHT: f64 = 180.0;
pub const MAX_WINDOW_WIDTH: f64 = 2400.0;
pub const MAX_WINDOW_HEIGHT: f64 = 1600.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemporaryCommandOperation {
    Create,
    List,
    Show,
    Load,
    Save,
    Hide,
    SetPin,
    Delete,
    UndoDelete,
    Convert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppLifecycleEvent {
    MainWindowCloseRequested,
    ExitRequested,
    Exit,
}

pub fn reduce_shutdown_lifecycle(current: bool, event: AppLifecycleEvent) -> bool {
    current
        || matches!(
            event,
            AppLifecycleEvent::ExitRequested | AppLifecycleEvent::Exit
        )
}

pub fn authorize_temporary_caller(
    caller_label: &str,
    operation: TemporaryCommandOperation,
    note_id: Option<NoteId>,
) -> Result<(), CommandError> {
    if matches!(
        operation,
        TemporaryCommandOperation::Create
            | TemporaryCommandOperation::List
            | TemporaryCommandOperation::Show
            | TemporaryCommandOperation::Delete
            | TemporaryCommandOperation::UndoDelete
            | TemporaryCommandOperation::Convert
    ) {
        return if caller_label == "main" {
            Ok(())
        } else {
            Err(CommandError::validation(
                "this temporary operation requires the main window",
            ))
        };
    }
    if caller_label == "main"
        && matches!(
            operation,
            TemporaryCommandOperation::Load | TemporaryCommandOperation::Save
        )
    {
        return Ok(());
    }
    let caller_note_id = parse_temporary_window_label(caller_label)?;
    if note_id != Some(caller_note_id) {
        return Err(CommandError::validation(
            "temporary window may access only its matching capture",
        ));
    }
    Ok(())
}

pub fn authorize_asset_caller(caller_label: &str, note_id: NoteId) -> Result<(), CommandError> {
    if caller_label == "main" {
        return Ok(());
    }
    if parse_temporary_window_label(caller_label)? == note_id {
        Ok(())
    } else {
        Err(CommandError::validation(
            "temporary window may save assets only for its matching capture",
        ))
    }
}

pub fn close_event_target(note_id: NoteId, label: &str) -> Result<String, CommandError> {
    if parse_temporary_window_label(label)? != note_id {
        return Err(CommandError::validation(
            "temporary close target does not match its capture",
        ));
    }
    Ok(label.to_owned())
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhysicalWindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PhysicalWindowBounds {
    pub fn to_physical(self, scale_factor: f64) -> Self {
        Self {
            x: self.x * scale_factor,
            y: self.y * scale_factor,
            width: self.width * scale_factor,
            height: self.height * scale_factor,
        }
    }

    pub fn to_logical(self, scale_factor: f64) -> Self {
        Self {
            x: self.x / scale_factor,
            y: self.y / scale_factor,
            width: self.width / scale_factor,
            height: self.height / scale_factor,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

pub fn clamp_to_available_monitors(
    bounds: PhysicalWindowBounds,
    monitors: &[MonitorGeometry],
) -> PhysicalWindowBounds {
    if monitors.is_empty() || monitors.iter().any(|monitor| intersects(bounds, *monitor)) {
        return bounds;
    }
    let center_x = bounds.x + bounds.width / 2.0;
    let center_y = bounds.y + bounds.height / 2.0;
    let target = monitors
        .iter()
        .min_by(|left, right| {
            distance_squared(center_x, center_y, **left)
                .total_cmp(&distance_squared(center_x, center_y, **right))
        })
        .expect("non-empty monitor collection");
    let width = bounds.width.min(target.width);
    let height = bounds.height.min(target.height);
    PhysicalWindowBounds {
        x: bounds.x.clamp(target.x, target.x + target.width - width),
        y: bounds.y.clamp(target.y, target.y + target.height - height),
        width,
        height,
    }
}

pub fn physical_bounds_for_restore(
    stored: PhysicalWindowBounds,
    monitors: &[MonitorGeometry],
    fallback_scale: f64,
) -> PhysicalWindowBounds {
    let scale = monitor_scale_for_position(stored.x, stored.y, monitors).unwrap_or(fallback_scale);
    clamp_to_available_monitors(
        PhysicalWindowBounds {
            x: stored.x,
            y: stored.y,
            width: stored.width * scale,
            height: stored.height * scale,
        },
        monitors,
    )
}

fn monitor_scale_for_position(x: f64, y: f64, monitors: &[MonitorGeometry]) -> Option<f64> {
    monitors
        .iter()
        .find(|monitor| {
            x >= monitor.x
                && x < monitor.x + monitor.width
                && y >= monitor.y
                && y < monitor.y + monitor.height
        })
        .or_else(|| {
            monitors.iter().min_by(|left, right| {
                distance_squared(x, y, **left).total_cmp(&distance_squared(x, y, **right))
            })
        })
        .map(|monitor| monitor.scale_factor)
}

fn intersects(bounds: PhysicalWindowBounds, monitor: MonitorGeometry) -> bool {
    bounds.x < monitor.x + monitor.width
        && bounds.x + bounds.width > monitor.x
        && bounds.y < monitor.y + monitor.height
        && bounds.y + bounds.height > monitor.y
}

fn distance_squared(x: f64, y: f64, monitor: MonitorGeometry) -> f64 {
    let nearest_x = x.clamp(monitor.x, monitor.x + monitor.width);
    let nearest_y = y.clamp(monitor.y, monitor.y + monitor.height);
    (x - nearest_x).powi(2) + (y - nearest_y).powi(2)
}

#[derive(Debug, Clone, Copy)]
pub struct DefaultWindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub always_on_top: bool,
}

impl DefaultWindowState {
    pub fn with_note_id(self, note_id: NoteId) -> TemporaryWindowState {
        TemporaryWindowState {
            note_id,
            visible: false,
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
            always_on_top: self.always_on_top,
        }
    }
}

pub const DEFAULT_WINDOW_STATE: DefaultWindowState = DefaultWindowState {
    x: 48.0,
    y: 48.0,
    width: 360.0,
    height: 420.0,
    always_on_top: true,
};

pub struct TemporaryRepository {
    paths: StoragePaths,
}

impl TemporaryRepository {
    pub fn new(paths: StoragePaths) -> Self {
        Self { paths }
    }

    pub fn create(&self) -> Result<NoteDocument, CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let now = Utc::now().to_rfc3339();
        NoteRepository::new(self.paths.clone()).create_locked(
            NoteDocument {
                id: NoteId::now_v7(),
                kind: NoteKind::Temporary,
                title: "临时便签".to_owned(),
                folder_id: None,
                tags: Vec::new(),
                markdown: String::new(),
                revision: 0,
                created_at: now.clone(),
                updated_at: now,
            },
            &guard,
        )
    }

    pub fn save(
        &self,
        document: NoteDocument,
        expected_revision: u64,
    ) -> Result<NoteDocument, CommandError> {
        if document.kind != NoteKind::Temporary || document.folder_id.is_some() {
            return Err(CommandError::validation(
                "temporary save requires a temporary document without a folder",
            ));
        }
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let current = NoteRepository::new(self.paths.clone()).load_locked(document.id, &guard)?;
        if current.kind != NoteKind::Temporary {
            return Err(CommandError::validation(
                "the durable note is not temporary",
            ));
        }
        NoteRepository::new(self.paths.clone()).save_locked(document, expected_revision, &guard)
    }

    pub fn load(&self, note_id: NoteId) -> Result<NoteDocument, CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let document = NoteRepository::new(self.paths.clone()).load_locked(note_id, &guard)?;
        if document.kind != NoteKind::Temporary {
            return Err(CommandError::validation(
                "the requested document is not temporary",
            ));
        }
        Ok(document)
    }

    pub fn list(&self) -> Result<Vec<NoteDocument>, CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let database = open_database(&self.paths)?;
        let mut statement = database
            .connection()
            .prepare(
                "SELECT id FROM notes WHERE kind = 'temporary' AND deleted_at IS NULL \
                 ORDER BY updated_at DESC, id DESC",
            )
            .map_err(database_error("could not prepare temporary note list"))?;
        let ids = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(database_error("could not query temporary note list"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read temporary note list"))?;
        let repository = NoteRepository::new(self.paths.clone());
        ids.into_iter()
            .map(|bytes| note_id_from_blob(&bytes))
            .map(|result| result.and_then(|id| repository.load_locked(id, &guard)))
            .collect()
    }
}

pub trait TemporaryWindowBackend: Clone + Send + Sync + 'static {
    fn ensure_window(
        &self,
        label: &str,
        note_id: NoteId,
        state: TemporaryWindowState,
    ) -> Result<(), CommandError>;
    fn show_and_focus(&self, label: &str) -> Result<(), CommandError>;
    fn notify_shown(&self, label: &str, note_id: NoteId) -> Result<(), CommandError>;
    fn hide(&self, label: &str) -> Result<(), CommandError>;
    fn set_always_on_top(&self, label: &str, always_on_top: bool) -> Result<(), CommandError>;
    fn apply_state(
        &self,
        label: &str,
        state: TemporaryWindowState,
    ) -> Result<TemporaryWindowState, CommandError>;
    fn retire(&self, label: &str) -> Result<(), CommandError>;
}

#[derive(Clone)]
pub struct TemporaryWindowService<B> {
    paths: StoragePaths,
    backend: B,
}

impl<B: TemporaryWindowBackend> TemporaryWindowService<B> {
    pub fn new(paths: StoragePaths, backend: B) -> Self {
        Self { paths, backend }
    }

    pub fn show(&self, note_id: NoteId) -> Result<TemporaryWindowState, CommandError> {
        let label = temporary_window_label(note_id);
        // Do not hold the index lock while invoking native window APIs. On
        // Windows, creating or positioning a WebView can synchronously emit
        // moved/resized events, and those handlers persist bounds through the
        // same lock.
        let previous = {
            let guard = IndexMutationLock::acquire(self.paths.root())?;
            ensure_temporary(&self.paths, note_id, &guard)?;
            self.load_state_locked(note_id, &guard)?
        };
        self.backend.ensure_window(&label, note_id, previous)?;
        let applied = match self.backend.apply_state(&label, previous) {
            Ok(applied) => applied,
            Err(error) => {
                let _ = self.backend.hide(&label);
                return Err(error);
            }
        };
        if let Err(error) = self.backend.show_and_focus(&label) {
            let _ = self.backend.hide(&label);
            return Err(error);
        }
        // A newly created webview can still be initializing when the native
        // window becomes visible. The initial sticky load covers that case;
        // this notification only refreshes an already-mounted hidden window.
        let _ = self.backend.notify_shown(&label, note_id);
        let next = TemporaryWindowState {
            visible: true,
            ..applied
        };
        let publication = (|| {
            let guard = IndexMutationLock::acquire(self.paths.root())?;
            ensure_temporary(&self.paths, note_id, &guard)?;
            self.persist_state_locked(next, &guard)
        })();
        if let Err(error) = publication {
            let _ = self.backend.hide(&label);
            return Err(error);
        }
        Ok(next)
    }

    pub fn hide(&self, note_id: NoteId) -> Result<TemporaryWindowState, CommandError> {
        {
            let guard = IndexMutationLock::acquire(self.paths.root())?;
            ensure_temporary(&self.paths, note_id, &guard)?;
        }
        let label = temporary_window_label(note_id);
        let previous = self.load_state(note_id)?;
        self.backend.hide(&label)?;
        let next = TemporaryWindowState {
            visible: false,
            ..previous
        };
        let publication = (|| {
            let guard = IndexMutationLock::acquire(self.paths.root())?;
            ensure_temporary(&self.paths, note_id, &guard)?;
            self.persist_state_locked(next, &guard)
        })();
        if let Err(error) = publication {
            if previous.visible {
                let _ = self.backend.show_and_focus(&label);
            }
            return Err(error);
        }
        Ok(next)
    }

    pub fn set_state(
        &self,
        requested: TemporaryWindowState,
    ) -> Result<TemporaryWindowState, CommandError> {
        let state = validate_and_clamp_state(requested)?;
        {
            let guard = IndexMutationLock::acquire(self.paths.root())?;
            ensure_temporary(&self.paths, state.note_id, &guard)?;
        }
        let label = temporary_window_label(state.note_id);
        let previous = self.load_state(state.note_id)?;
        let requested = TemporaryWindowState {
            visible: previous.visible,
            ..state
        };
        let applied = match self.backend.apply_state(&label, requested) {
            Ok(applied) => TemporaryWindowState {
                visible: previous.visible,
                ..applied
            },
            Err(error) => {
                let _ = self.backend.apply_state(&label, previous);
                return Err(error);
            }
        };
        let publication = (|| {
            let guard = IndexMutationLock::acquire(self.paths.root())?;
            ensure_temporary(&self.paths, state.note_id, &guard)?;
            self.persist_state_locked(applied, &guard)
        })();
        if let Err(error) = publication {
            let _ = self.backend.apply_state(&label, previous);
            return Err(error);
        }
        Ok(applied)
    }

    pub fn set_always_on_top(
        &self,
        note_id: NoteId,
        always_on_top: bool,
    ) -> Result<TemporaryWindowState, CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        ensure_temporary(&self.paths, note_id, &guard)?;
        let previous = self.load_state_locked(note_id, &guard)?;
        let label = temporary_window_label(note_id);
        self.backend.set_always_on_top(&label, always_on_top)?;
        let authoritative = TemporaryWindowState {
            always_on_top,
            ..previous
        };
        if let Err(error) = self.persist_state_locked(authoritative, &guard) {
            let _ = self
                .backend
                .set_always_on_top(&label, previous.always_on_top);
            return Err(error);
        }
        Ok(authoritative)
    }

    pub fn load_state(&self, note_id: NoteId) -> Result<TemporaryWindowState, CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        self.load_state_locked(note_id, &guard)
    }

    /// Returns true when the native close must be prevented because it was converted to hide.
    pub fn handle_close(&self, note_id: NoteId, shutting_down: bool) -> Result<bool, CommandError> {
        if shutting_down {
            return Ok(false);
        }
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        ensure_temporary(&self.paths, note_id, &guard)?;
        Ok(true)
    }

    pub fn persist_observed_bounds(
        &self,
        note_id: NoteId,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        ensure_temporary(&self.paths, note_id, &guard)?;
        let current = self.load_state_locked(note_id, &guard)?;
        self.persist_state_locked(
            validate_and_clamp_state(TemporaryWindowState {
                x,
                y,
                width,
                height,
                ..current
            })?,
            &guard,
        )
    }

    fn load_state_locked(
        &self,
        note_id: NoteId,
        _guard: &IndexMutationLock,
    ) -> Result<TemporaryWindowState, CommandError> {
        let database = open_database(&self.paths)?;
        database
            .connection()
            .query_row(
                "SELECT visible, x, y, width, height, always_on_top FROM temporary_windows WHERE note_id = ?1",
                [note_id_blob(note_id)],
                |row| {
                    Ok(TemporaryWindowState {
                        note_id,
                        visible: row.get::<_, i64>(0)? != 0,
                        x: row.get(1)?,
                        y: row.get(2)?,
                        width: row.get(3)?,
                        height: row.get(4)?,
                        always_on_top: row.get::<_, i64>(5)? != 0,
                    })
                },
            )
            .optional()
            .map_err(database_error("could not load temporary window state"))?
            .map(validate_and_clamp_state)
            .transpose()
            .map(|state| state.unwrap_or_else(|| DEFAULT_WINDOW_STATE.with_note_id(note_id)))
    }

    fn persist_state_locked(
        &self,
        state: TemporaryWindowState,
        _guard: &IndexMutationLock,
    ) -> Result<(), CommandError> {
        let database = open_database(&self.paths)?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start window state update"))?;
        transaction
            .execute(
                "INSERT INTO temporary_windows (note_id, visible, x, y, width, height, always_on_top) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(note_id) DO UPDATE SET \
                 visible=excluded.visible, x=excluded.x, y=excluded.y, width=excluded.width, \
                 height=excluded.height, always_on_top=excluded.always_on_top",
                params![
                    note_id_blob(state.note_id),
                    state.visible,
                    state.x,
                    state.y,
                    state.width,
                    state.height,
                    state.always_on_top,
                ],
            )
            .map_err(database_error("could not persist temporary window state"))?;
        transaction
            .commit()
            .map_err(database_error("could not commit temporary window state"))
    }
}

pub fn temporary_window_label(note_id: NoteId) -> String {
    format!("temporary-{note_id}")
}

pub fn parse_temporary_window_label(label: &str) -> Result<NoteId, CommandError> {
    let value = label
        .strip_prefix("temporary-")
        .ok_or_else(|| CommandError::validation("temporary window label has the wrong prefix"))?;
    NoteId::parse_str(value)
        .map_err(|_| CommandError::validation("temporary window label has an invalid note ID"))
}

fn ensure_temporary(
    paths: &StoragePaths,
    note_id: NoteId,
    guard: &IndexMutationLock,
) -> Result<(), CommandError> {
    let document = NoteRepository::new(paths.clone()).load_locked(note_id, guard)?;
    if document.kind != NoteKind::Temporary {
        return Err(CommandError::validation(
            "window target is not a temporary capture",
        ));
    }
    Ok(())
}

pub(crate) fn validate_and_clamp_state(
    mut state: TemporaryWindowState,
) -> Result<TemporaryWindowState, CommandError> {
    if !state.x.is_finite()
        || !state.y.is_finite()
        || !state.width.is_finite()
        || !state.height.is_finite()
        || state.width <= 0.0
        || state.height <= 0.0
    {
        return Err(CommandError::validation(
            "temporary window bounds are invalid",
        ));
    }
    state.width = state.width.clamp(MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH);
    state.height = state.height.clamp(MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT);
    Ok(state)
}

fn open_database(paths: &StoragePaths) -> Result<Database, CommandError> {
    let database = Database::open(paths.database())?;
    database.migrate()?;
    Ok(database)
}

fn database_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> CommandError {
    move |source| CommandError::database(format!("{context}: {source}"))
}

#[derive(Default, Clone)]
pub struct InMemoryTemporaryWindowBackend {
    inner: Arc<Mutex<InMemoryBackendState>>,
}

#[derive(Default)]
struct InMemoryBackendState {
    created: Vec<String>,
    show_count: usize,
    shown_notification_count: usize,
    operations: usize,
    fail_on_operation: Option<usize>,
    state_apply_count: usize,
    pin_update_count: usize,
    retired: Vec<String>,
}

impl InMemoryTemporaryWindowBackend {
    pub fn created_labels(&self) -> Vec<String> {
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .created
            .clone()
    }

    pub fn show_count(&self) -> usize {
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .show_count
    }

    pub fn shown_notification_count(&self) -> usize {
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .shown_notification_count
    }

    pub fn fail_next(&self) {
        let mut inner = self.inner.lock().expect("backend mutex poisoned");
        inner.fail_on_operation = Some(inner.operations + 1);
    }

    pub fn fail_on_operation(&self, operation: usize) {
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .fail_on_operation = Some(operation);
    }

    pub fn state_apply_count(&self) -> usize {
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .state_apply_count
    }

    pub fn pin_update_count(&self) -> usize {
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .pin_update_count
    }

    pub fn retired_labels(&self) -> Vec<String> {
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .retired
            .clone()
    }

    fn operation(&self) -> Result<(), CommandError> {
        let mut inner = self.inner.lock().expect("backend mutex poisoned");
        inner.operations += 1;
        if inner.fail_on_operation == Some(inner.operations) {
            inner.fail_on_operation = None;
            return Err(CommandError::io("injected native window failure"));
        }
        Ok(())
    }
}

impl TemporaryWindowBackend for InMemoryTemporaryWindowBackend {
    fn ensure_window(
        &self,
        label: &str,
        _note_id: NoteId,
        _state: TemporaryWindowState,
    ) -> Result<(), CommandError> {
        self.operation()?;
        let mut inner = self.inner.lock().expect("backend mutex poisoned");
        if !inner.created.iter().any(|candidate| candidate == label) {
            inner.created.push(label.to_owned());
        }
        Ok(())
    }

    fn show_and_focus(&self, _label: &str) -> Result<(), CommandError> {
        self.operation()?;
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .show_count += 1;
        Ok(())
    }

    fn notify_shown(&self, _label: &str, _note_id: NoteId) -> Result<(), CommandError> {
        self.operation()?;
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .shown_notification_count += 1;
        Ok(())
    }

    fn hide(&self, _label: &str) -> Result<(), CommandError> {
        self.operation()
    }

    fn set_always_on_top(&self, _label: &str, _always_on_top: bool) -> Result<(), CommandError> {
        self.operation()?;
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .pin_update_count += 1;
        Ok(())
    }

    fn apply_state(
        &self,
        _label: &str,
        state: TemporaryWindowState,
    ) -> Result<TemporaryWindowState, CommandError> {
        self.operation()?;
        self.inner
            .lock()
            .expect("backend mutex poisoned")
            .state_apply_count += 1;
        Ok(state)
    }

    fn retire(&self, label: &str) -> Result<(), CommandError> {
        self.operation()?;
        let mut inner = self.inner.lock().expect("backend mutex poisoned");
        inner.created.retain(|candidate| candidate != label);
        inner.retired.push(label.to_owned());
        Ok(())
    }
}

#[derive(Clone)]
pub struct TauriTemporaryWindowBackend {
    app: tauri::AppHandle,
    paths: StoragePaths,
    shutting_down: Arc<AtomicBool>,
}

impl TauriTemporaryWindowBackend {
    pub fn new(app: tauri::AppHandle, paths: StoragePaths, shutting_down: Arc<AtomicBool>) -> Self {
        Self {
            app,
            paths,
            shutting_down,
        }
    }

    pub fn mark_shutting_down(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
    }

    fn window(&self, label: &str) -> Result<tauri::WebviewWindow, CommandError> {
        self.app
            .get_webview_window(label)
            .ok_or_else(|| CommandError::not_found("temporary window does not exist"))
    }
}

fn sticky_route_query(note_id: NoteId, state: TemporaryWindowState) -> String {
    format!(
        "sticky={note_id}&x={}&y={}&width={}&height={}&pin={}",
        state.x,
        state.y,
        state.width,
        state.height,
        if state.always_on_top { 1 } else { 0 },
    )
}

fn sticky_route_bootstrap_script(note_id: NoteId, state: TemporaryWindowState) -> String {
    let location = format!("?{}", sticky_route_query(note_id, state));
    let encoded = serde_json::to_string(&location).expect("sticky route is always a string");
    format!("window.history.replaceState(null, '', {encoded});")
}

impl TemporaryWindowBackend for TauriTemporaryWindowBackend {
    fn ensure_window(
        &self,
        label: &str,
        note_id: NoteId,
        state: TemporaryWindowState,
    ) -> Result<(), CommandError> {
        if parse_temporary_window_label(label)? != note_id {
            return Err(CommandError::validation(
                "temporary window label does not match its note",
            ));
        }
        if let Some(window) = self.app.get_webview_window(label) {
            // Older builds created this window without a stable route bootstrap.
            // Repair that URL in-place and reload only when the route is wrong;
            // a normal show must not discard an unsaved sticky draft.
            let route_matches = window
                .url()
                .ok()
                .and_then(|url| {
                    url.query_pairs()
                        .find(|(key, _)| key == "sticky")
                        .map(|(_, value)| value.into_owned())
                })
                .is_some_and(|value| value == note_id.to_string());
            if !route_matches {
                let _ = window.eval(format!(
                    "{} window.location.reload();",
                    sticky_route_bootstrap_script(note_id, state),
                ));
            }
            return Ok(());
        }
        let window = WebviewWindowBuilder::new(
            &self.app,
            label,
            // Keep the app URL path plain. The route is installed before the
            // Vite entry script runs, avoiding WebView URL/query handling
            // differences between the dev proxy and packaged protocol.
            WebviewUrl::App("index.html".into()),
        )
        .initialization_script(sticky_route_bootstrap_script(note_id, state))
        .title(crate::brand::APP_NAME)
        .decorations(false)
        .resizable(true)
        // Let WebView2 finish its first document load before exposing the
        // child window. Calling show immediately after build is reliable once
        // the native window has a completed handle, while exposing a partially
        // initialized WebView can make Windows mark the window unresponsive.
        .visible(false)
        .inner_size(state.width, state.height)
        .position(state.x, state.y)
        .always_on_top(state.always_on_top)
        .build()
        .map_err(|source| {
            CommandError::io(format!("could not create temporary window: {source}"))
        })?;

        let service = TemporaryWindowService::new(self.paths.clone(), self.clone());
        let event_window = window.clone();
        let shutdown = self.shutting_down.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if service
                    .handle_close(note_id, shutdown.load(Ordering::SeqCst))
                    .unwrap_or(true)
                {
                    api.prevent_close();
                    if let Ok(target) = close_event_target(note_id, event_window.label()) {
                        let _ = event_window.app_handle().emit_to(
                            target,
                            "temporary-close-requested",
                            note_id.to_string(),
                        );
                    }
                }
            }
            WindowEvent::Moved(position) => {
                if let Ok(scale) = event_window.scale_factor() {
                    if let Ok(size) = event_window.outer_size() {
                        let size = size.to_logical::<f64>(scale);
                        let _ = service.persist_observed_bounds(
                            note_id,
                            f64::from(position.x),
                            f64::from(position.y),
                            size.width,
                            size.height,
                        );
                    }
                }
            }
            WindowEvent::Resized(size) => {
                if let (Ok(scale), Ok(position)) =
                    (event_window.scale_factor(), event_window.outer_position())
                {
                    let logical_size = size.to_logical::<f64>(scale);
                    let _ = service.persist_observed_bounds(
                        note_id,
                        f64::from(position.x),
                        f64::from(position.y),
                        logical_size.width,
                        logical_size.height,
                    );
                }
            }
            _ => {}
        });
        Ok(())
    }

    fn show_and_focus(&self, label: &str) -> Result<(), CommandError> {
        let window = self.window(label)?;
        // A sticky can have been minimized independently of the hide/show
        // lifecycle. Restore it before showing so the native window is not
        // left minimized behind the main window.
        let _ = window.unminimize();
        window.show().map_err(|source| {
            CommandError::io(format!("could not show temporary window: {source}"))
        })?;
        // Windows may reject focus while the webview is still initializing or
        // when the main window owns the foreground activation. Visibility is
        // the durable operation; focus is a best-effort convenience.
        let _ = window.set_focus();
        Ok(())
    }

    fn notify_shown(&self, label: &str, note_id: NoteId) -> Result<(), CommandError> {
        let window = self.window(label)?;
        window
            .emit("temporary-window-shown", note_id.to_string())
            .map_err(|source| {
                CommandError::io(format!(
                    "could not notify temporary window that it was shown: {source}"
                ))
            })
    }

    fn hide(&self, label: &str) -> Result<(), CommandError> {
        self.window(label)?.hide().map_err(|source| {
            CommandError::io(format!("could not hide temporary window: {source}"))
        })
    }

    fn set_always_on_top(&self, label: &str, always_on_top: bool) -> Result<(), CommandError> {
        self.window(label)?
            .set_always_on_top(always_on_top)
            .map_err(|source| {
                CommandError::io(format!("could not update temporary pin state: {source}"))
            })
    }

    fn apply_state(
        &self,
        label: &str,
        state: TemporaryWindowState,
    ) -> Result<TemporaryWindowState, CommandError> {
        let window = self.window(label)?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let stored = PhysicalWindowBounds {
            x: state.x,
            y: state.y,
            width: state.width,
            height: state.height,
        };
        let monitors = window
            .available_monitors()
            .unwrap_or_default()
            .into_iter()
            .map(|monitor| MonitorGeometry {
                x: f64::from(monitor.position().x),
                y: f64::from(monitor.position().y),
                width: f64::from(monitor.size().width),
                height: f64::from(monitor.size().height),
                scale_factor: monitor.scale_factor(),
            })
            .collect::<Vec<_>>();
        let applied = physical_bounds_for_restore(stored, &monitors, scale);
        window
            .set_position(PhysicalPosition::new(applied.x as i32, applied.y as i32))
            .and_then(|_| {
                window.set_size(PhysicalSize::new(
                    applied.width as u32,
                    applied.height as u32,
                ))
            })
            .and_then(|_| window.set_always_on_top(state.always_on_top))
            .map_err(|source| {
                CommandError::io(format!("could not apply temporary window state: {source}"))
            })?;
        let actual_position = window
            .outer_position()
            .unwrap_or(PhysicalPosition::new(applied.x as i32, applied.y as i32));
        let actual_size = window.outer_size().unwrap_or(PhysicalSize::new(
            applied.width as u32,
            applied.height as u32,
        ));
        let actual_scale = window.scale_factor().unwrap_or(scale);
        let actual_width_height = PhysicalWindowBounds {
            x: 0.0,
            y: 0.0,
            width: f64::from(actual_size.width),
            height: f64::from(actual_size.height),
        }
        .to_logical(actual_scale);
        let actual = PhysicalWindowBounds {
            x: f64::from(actual_position.x),
            y: f64::from(actual_position.y),
            width: actual_width_height.width,
            height: actual_width_height.height,
        };
        Ok(TemporaryWindowState {
            x: actual.x,
            y: actual.y,
            width: actual.width,
            height: actual.height,
            ..state
        })
    }

    fn retire(&self, label: &str) -> Result<(), CommandError> {
        let Some(window) = self.app.get_webview_window(label) else {
            return Ok(());
        };
        window.destroy().map_err(|source| {
            CommandError::io(format!("could not retire temporary window: {source}"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{sticky_route_bootstrap_script, sticky_route_query};
    use crate::domain::{NoteId, TemporaryWindowState};

    fn state() -> TemporaryWindowState {
        TemporaryWindowState {
            note_id: NoteId::parse_str("019c0000-0000-7000-8000-000000000031")
                .expect("valid note id"),
            visible: true,
            x: 12.0,
            y: 24.0,
            width: 360.0,
            height: 420.0,
            always_on_top: true,
        }
    }

    #[test]
    fn sticky_route_bootstrap_is_plain_index_url_safe() {
        let state = state();
        let query = sticky_route_query(state.note_id, state);
        let script = sticky_route_bootstrap_script(state.note_id, state);

        assert_eq!(
            query,
            "sticky=019c0000-0000-7000-8000-000000000031&x=12&y=24&width=360&height=420&pin=1"
        );
        assert!(script.contains("history.replaceState"));
        assert!(script.contains("?sticky=019c0000-0000-7000-8000-000000000031"));
    }
}
