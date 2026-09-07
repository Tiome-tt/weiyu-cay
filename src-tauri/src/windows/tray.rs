use super::{
    lifecycle::Intent,
    main::{self, MainWindowCloseCoordinator},
    sticky::{TemporaryRepository, TemporaryWindowService},
};
use crate::{brand::APP_NAME, commands::temporary::TemporaryCommandState};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[cfg(target_os = "windows")]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

const TRAY_ID: &str = "main-tray";
const NAVIGATION_EVENT: &str = "app-navigation-requested";
const FAILURE_EVENT: &str = "tray-action-failed";

pub fn desired_visibility(is_macos: bool, show_menu_bar_icon: bool) -> bool {
    !is_macos || show_menu_bar_icon
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Open,
    NewTemporary,
    TemporaryInbox,
    Settings,
    Exit,
}

pub const TRAY_MENU_ORDER: [Option<TrayAction>; 7] = [
    Some(TrayAction::Open),
    Some(TrayAction::NewTemporary),
    Some(TrayAction::TemporaryInbox),
    None,
    Some(TrayAction::Settings),
    None,
    Some(TrayAction::Exit),
];

pub fn parse_tray_action(id: &str) -> Option<TrayAction> {
    match id {
        "open" => Some(TrayAction::Open),
        "new-temporary" => Some(TrayAction::NewTemporary),
        "temporary-inbox" => Some(TrayAction::TemporaryInbox),
        "settings" => Some(TrayAction::Settings),
        "exit" => Some(TrayAction::Exit),
        _ => None,
    }
}

#[derive(Default)]
pub struct TrayState {
    available: AtomicBool,
    navigation: Mutex<NavigationQueue>,
}

impl TrayState {
    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NavigationAction {
    TemporaryInbox,
    Settings,
}

#[derive(Debug, Default)]
pub struct NavigationQueue {
    ready: bool,
    pending: Option<NavigationAction>,
}

impl NavigationQueue {
    pub fn submit(&mut self, action: NavigationAction) -> Option<NavigationAction> {
        if self.ready {
            self.pending = None;
            Some(action)
        } else {
            self.pending = Some(action);
            None
        }
    }

    pub fn set_ready(&mut self, ready: bool) -> Option<NavigationAction> {
        self.ready = ready;
        if ready {
            self.pending.take()
        } else {
            None
        }
    }

    fn restore(&mut self, action: NavigationAction) {
        self.pending = Some(action);
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayFailure {
    action: &'static str,
}

pub fn setup(app: &mut tauri::App) {
    if try_setup(app).is_ok() {
        app.state::<TrayState>()
            .available
            .store(true, Ordering::Release);
    } else {
        app.state::<TrayState>()
            .available
            .store(false, Ordering::Release);
        report_failure(app.handle(), "setup");
        main::activate_main(app.handle());
    }
}

pub fn report_failure(app: &tauri::AppHandle, action: &'static str) {
    let _ = app.emit_to(
        main::MAIN_WINDOW_LABEL,
        FAILURE_EVENT,
        TrayFailure { action },
    );
}

fn try_setup(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开微屿", true, None::<&str>)?;
    let new_temporary =
        MenuItem::with_id(app, "new-temporary", "新建临时便笺", true, None::<&str>)?;
    let inbox = MenuItem::with_id(
        app,
        "temporary-inbox",
        "打开临时便笺收件箱",
        true,
        None::<&str>,
    )?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "exit", "退出微屿", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &new_temporary,
            &inbox,
            &first_separator,
            &settings,
            &second_separator,
            &exit,
        ],
    )?;
    let Some(icon) = app.default_window_icon().cloned() else {
        return Err(tauri::Error::AssetNotFound("default window icon".into()));
    };

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| {
            if let Some(action) = parse_tray_action(event.id().as_ref()) {
                dispatch(app, action);
            }
        })
        .on_tray_icon_event(|_tray, _event| {
            #[cfg(target_os = "windows")]
            if matches!(
                _event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                main::activate_main(_tray.app_handle());
            }
        })
        .build(app)?;
    let show_menu_bar_icon = app
        .state::<crate::commands::settings::SettingsCommandState>()
        .stored_settings()
        .map(|settings| settings.show_menu_bar_icon)
        .unwrap_or(true);
    tray.set_visible(desired_visibility(
        cfg!(target_os = "macos"),
        show_menu_bar_icon,
    ))?;
    Ok(())
}

pub fn update_visibility(app: &tauri::AppHandle, show_menu_bar_icon: bool) -> tauri::Result<()> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| tauri::Error::AssetNotFound("main tray icon".into()))?;
    tray.set_visible(desired_visibility(
        cfg!(target_os = "macos"),
        show_menu_bar_icon,
    ))
}

fn dispatch(app: &tauri::AppHandle, action: TrayAction) {
    match action {
        TrayAction::Open => main::activate_main(app),
        TrayAction::NewTemporary => create_temporary(app),
        TrayAction::TemporaryInbox => navigate(app, NavigationAction::TemporaryInbox),
        TrayAction::Settings => navigate(app, NavigationAction::Settings),
        TrayAction::Exit => {
            let coordinator = app.state::<MainWindowCloseCoordinator>();
            let _ = main::request_lifecycle(app, &coordinator, Intent::Exit);
        }
    }
}

fn navigate(app: &tauri::AppHandle, action: NavigationAction) {
    main::activate_main(app);
    let state = app.state::<TrayState>();
    let deliver = state
        .navigation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .submit(action);
    if let Some(action) = deliver {
        deliver_navigation(app, &state, action);
    }
}

fn deliver_navigation(app: &tauri::AppHandle, state: &TrayState, action: NavigationAction) {
    if app
        .emit_to(main::MAIN_WINDOW_LABEL, NAVIGATION_EVENT, action)
        .is_err()
    {
        state
            .navigation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .restore(action);
    }
}

#[tauri::command]
pub fn set_tray_navigation_ready(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, TrayState>,
    ready: bool,
) -> Result<(), crate::error::CommandError> {
    if window.label() != main::MAIN_WINDOW_LABEL {
        return Err(crate::error::CommandError::validation(
            "tray navigation readiness is main-window only",
        ));
    }
    let deliver = state
        .navigation
        .lock()
        .map_err(|_| crate::error::CommandError::io("tray navigation state is unavailable"))?
        .set_ready(ready);
    if let Some(action) = deliver {
        deliver_navigation(&app, &state, action);
    }
    Ok(())
}

fn create_temporary(app: &tauri::AppHandle) {
    let temporary = app.state::<TemporaryCommandState>();
    let paths = temporary.paths().clone();
    let backend = temporary.backend().clone();
    let readiness = temporary.readiness();
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            readiness.with_ready(|| {
                let document = TemporaryRepository::new(paths.clone()).create()?;
                TemporaryWindowService::new(paths, backend).show(document.id)?;
                Ok(())
            })
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            report_failure(&event_app, "new-temporary");
            main::activate_main(&event_app);
        }
    });
}
