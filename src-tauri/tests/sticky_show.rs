mod support;

use simple_notes_lib::{
    domain::{NoteId, TemporaryWindowState},
    error::CommandError,
    platform::IndexMutationLock,
    storage::paths::StoragePaths,
    windows::sticky::{
        InMemoryTemporaryWindowBackend, TemporaryRepository, TemporaryWindowBackend,
        TemporaryWindowService,
    },
};
use std::time::Duration;
use support::TestStore;

#[derive(Clone)]
struct ReentrantBackend {
    paths: StoragePaths,
    inner: InMemoryTemporaryWindowBackend,
    delete_on_show: bool,
}

impl TemporaryWindowBackend for ReentrantBackend {
    fn ensure_window(
        &self,
        label: &str,
        id: NoteId,
        state: TemporaryWindowState,
    ) -> Result<(), CommandError> {
        self.inner.ensure_window(label, id, state)
    }
    fn apply_state(
        &self,
        label: &str,
        state: TemporaryWindowState,
    ) -> Result<TemporaryWindowState, CommandError> {
        // Native move/resize callbacks must be able to persist bounds during show.
        let guard =
            IndexMutationLock::acquire_with_timeout(self.paths.root(), Duration::from_millis(100))?;
        drop(guard);
        TemporaryWindowService::new(self.paths.clone(), self.inner.clone())
            .persist_observed_bounds(state.note_id, state.x, state.y, state.width, state.height)?;
        self.inner.apply_state(label, state)
    }
    fn show_and_focus(&self, label: &str) -> Result<(), CommandError> {
        self.inner.show_and_focus(label)?;
        if self.delete_on_show {
            let id = simple_notes_lib::windows::sticky::parse_temporary_window_label(label)?;
            let result = simple_notes_lib::storage::temporary_ops::TemporaryInboxService::new(
                self.paths.clone(),
                self.inner.clone(),
            )
            .delete(vec![id]);
            assert_eq!(result.deleted, vec![id]);
        }
        Ok(())
    }
    fn hide(&self, label: &str) -> Result<(), CommandError> {
        self.inner.hide(label)
    }
    fn set_always_on_top(&self, label: &str, pin: bool) -> Result<(), CommandError> {
        self.inner.set_always_on_top(label, pin)
    }
    fn retire(&self, label: &str) -> Result<(), CommandError> {
        self.inner.retire(label)
    }
}

#[test]
fn show_allows_native_bounds_callbacks_without_waiting_for_the_storage_lock() {
    let store = TestStore::new();
    let capture = TemporaryRepository::new(store.paths.clone())
        .create()
        .unwrap();
    let inner = InMemoryTemporaryWindowBackend::default();
    let service = TemporaryWindowService::new(
        store.paths.clone(),
        ReentrantBackend {
            paths: store.paths.clone(),
            inner: inner.clone(),
            delete_on_show: false,
        },
    );
    assert!(service.show(capture.id).unwrap().visible);
    assert!(service.load_state(capture.id).unwrap().visible);
    assert_eq!(inner.show_count(), 1);
}

#[test]
fn show_does_not_publish_window_state_if_capture_was_deleted_during_native_calls() {
    let store = TestStore::new();
    let capture = TemporaryRepository::new(store.paths.clone())
        .create()
        .unwrap();
    let inner = InMemoryTemporaryWindowBackend::default();
    let service = TemporaryWindowService::new(
        store.paths.clone(),
        ReentrantBackend {
            paths: store.paths.clone(),
            inner: inner.clone(),
            delete_on_show: true,
        },
    );
    assert!(service.show(capture.id).is_err());
    assert_eq!(inner.show_count(), 1);
    assert!(inner.created_labels().is_empty());
    let database = rusqlite::Connection::open(store.paths.database()).unwrap();
    let count: i64 = database
        .query_row("SELECT count(*) FROM temporary_windows", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}
