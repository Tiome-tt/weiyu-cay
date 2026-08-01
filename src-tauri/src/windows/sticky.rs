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
                title: "Temporary capture".to_owned(),
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
    fn hide(&self, label: &str) -> Result<(), CommandError>;
    fn apply_state(&self, label: &str, state: TemporaryWindowState) -> Result<(), CommandError>;
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
        {
            let guard = IndexMutationLock::acquire(self.paths.root())?;
            ensure_temporary(&self.paths, note_id, &guard)?;
        }
        let label = temporary_window_label(note_id);
        let previous = self.load_state(note_id)?;
        self.backend.ensure_window(&label, note_id, previous)?;
        self.backend.apply_state(&label, previous)?;
        if let Err(error) = self.backend.show_and_focus(&label) {
            let _ = self.backend.hide(&label);
            return Err(error);
        }
        let next = TemporaryWindowState {
            visible: true,
            ..previous
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
        if let Err(error) = self.backend.apply_state(&label, state) {
            let _ = self.backend.apply_state(&label, previous);
            return Err(error);
        }
        let publication = (|| {
            let guard = IndexMutationLock::acquire(self.paths.root())?;
            ensure_temporary(&self.paths, state.note_id, &guard)?;
            self.persist_state_locked(state, &guard)
        })();
        if let Err(error) = publication {
            let _ = self.backend.apply_state(&label, previous);
            return Err(error);
        }
        Ok(state)
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
    operations: usize,
    fail_on_operation: Option<usize>,
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

    fn hide(&self, _label: &str) -> Result<(), CommandError> {
        self.operation()
    }

    fn apply_state(&self, _label: &str, _state: TemporaryWindowState) -> Result<(), CommandError> {
        self.operation()
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
        if self.app.get_webview_window(label).is_some() {
            return Ok(());
        }
        let window = WebviewWindowBuilder::new(
            &self.app,
            label,
            WebviewUrl::App(
                format!(
                    "index.html?sticky={note_id}&x={}&y={}&width={}&height={}&pin={}",
                    state.x,
                    state.y,
                    state.width,
                    state.height,
                    if state.always_on_top { 1 } else { 0 }
                )
                .into(),
            ),
        )
        .title("Simple Notes")
        .decorations(false)
        .resizable(true)
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
                    let _ = event_window.emit("temporary-close-requested", note_id.to_string());
                }
            }
            WindowEvent::Moved(position) => {
                if let Ok(scale) = event_window.scale_factor() {
                    let logical = position.to_logical::<f64>(scale);
                    if let Ok(size) = event_window.outer_size() {
                        let size = size.to_logical::<f64>(scale);
                        let _ = service.persist_observed_bounds(
                            note_id,
                            logical.x,
                            logical.y,
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
                    let logical_position = position.to_logical::<f64>(scale);
                    let logical_size = size.to_logical::<f64>(scale);
                    let _ = service.persist_observed_bounds(
                        note_id,
                        logical_position.x,
                        logical_position.y,
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
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|source| {
                CommandError::io(format!("could not show temporary window: {source}"))
            })
    }

    fn hide(&self, label: &str) -> Result<(), CommandError> {
        self.window(label)?.hide().map_err(|source| {
            CommandError::io(format!("could not hide temporary window: {source}"))
        })
    }

    fn apply_state(&self, label: &str, state: TemporaryWindowState) -> Result<(), CommandError> {
        let window = self.window(label)?;
        let (x, y, width, height) = clamp_to_primary_monitor(&window, state)?;
        window
            .set_position(PhysicalPosition::new(x as i32, y as i32))
            .and_then(|_| window.set_size(PhysicalSize::new(width as u32, height as u32)))
            .and_then(|_| window.set_always_on_top(state.always_on_top))
            .map_err(|source| {
                CommandError::io(format!("could not apply temporary window state: {source}"))
            })
    }
}

fn clamp_to_primary_monitor(
    window: &tauri::WebviewWindow,
    state: TemporaryWindowState,
) -> Result<(f64, f64, f64, f64), CommandError> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let mut x = state.x * scale;
    let mut y = state.y * scale;
    let mut width = state.width * scale;
    let mut height = state.height * scale;
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let size = monitor.size();
        let origin = monitor.position();
        width = width.min(f64::from(size.width));
        height = height.min(f64::from(size.height));
        let left = f64::from(origin.x);
        let top = f64::from(origin.y);
        x = x.clamp(left, left + (f64::from(size.width) - width).max(0.0));
        y = y.clamp(top, top + (f64::from(size.height) - height).max(0.0));
    }
    Ok((x, y, width, height))
}
