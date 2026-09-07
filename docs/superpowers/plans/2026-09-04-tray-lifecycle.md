# Tray and Safe Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide optional native tray restoration and safe multi-window hide, quit and authorized restart.

**Architecture:** Extend the existing generation-based close coordinator into one application lifecycle protocol. Rust owns native menus and platform events; typed renderer participants acquire save barriers and confirm durable saves. Keep window visibility separate from process exit authorization.

**Tech Stack:** Tauri 2, Rust, React, TypeScript strict mode, CodeMirror 6, Vitest and Cargo tests.

**Spec:** `docs/superpowers/specs/2026-09-04-tray-lifecycle-design.md`

## Execution checkpoint — 2026-09-04

- User explicitly chose sequential implementation in the current checkout; no worktree was created. Existing v1.0.2 editor changes remain untouched.
- Implemented the pure coordinator, window-registration registry, cancellable renderer participant hook and optional sticky-editor participant. These are not yet wired into the production main-window/native close protocol; tray functionality is not complete.
- Fresh focused evidence: 12 coordinator + 5 registry + 6 existing main-window Rust tests passed; 7 participant-hook + 13 sticky-editor TypeScript tests passed. Typecheck, targeted ESLint, cargo check and library Clippy passed. No desktop bundle or Windows/macOS native acceptance was run.
- Review corrections: competing exit/restart requests still validate changed snapshots; cancellation restores visible state; late acknowledgments check the actual deadline; uncertain acknowledgment transport retains the save barrier.
- Cancellation uses `SaveParticipant.prepare(signal: AbortSignal)`. The signal releases UI barriers immediately even while paste/save promises remain pending; it must never abort atomic content writes.
- **Design clarification approved 2026-09-06:** storage relocation receives a pre-relocation, all-live-window save phase with explicit barrier ownership transfer through relocation and restart. Any failed or timed-out participant cancels relocation before the existing storage service acquires its lock or copies data. Do not bypass the lock or acknowledge unsaved windows.
- Native commands, main-window wiring, close preferences, tray, single instance, authorized restart routing and platform acceptance remain pending. No new release, version bump, commit or installer was produced during this implementation checkpoint.

## Execution checkpoint — 2026-09-07

- Wired the application-level lifecycle into main and temporary editors with authenticated generations, a 10-second cancellation deadline, two-phase native hiding, failure recovery, and creation permits that prevent a post-snapshot editor race.
- Added the native tray and fixed menu order, typed inbox/settings actions, first-close disclosure, platform-specific preferences, visible failure feedback, off-screen main-window recovery, and the official Tauri single-instance plugin as the first registered plugin.
- Routed update restart through the all-window restart intent. Storage relocation now requires a separate all-window `relocate` save generation, holds those barriers through the move, and transfers them to the authorized restart; failure cancels and releases the exact generation.
- Focused lifecycle, tray, settings, renderer, capability and editor tests plus TypeScript typecheck, cargo check and production-library Clippy pass. Full-suite/build and real Windows/macOS acceptance are tracked separately and must not be inferred from source-level tests.

## Global Constraints

- “确认等待上限为 10 秒，超时只是取消退出，不中止底层原子写入；后续旧确认不得触发退出。”
- “开机启动维持用户现有选择；启用托盘不自动启用开机启动。手动退出不偷偷重启进程。”
- “React 只通过有类型的生命周期/导航服务执行保存及视图切换，不直接获得任意退出或文件权限。”
- “未执行的平台验证必须明确记录为未验证，不宣称跨平台完成。”
- Preserve note IDs, Markdown format, data roots and fail-closed updater configuration. No daemon, polling, cloud dependency, automatic notification-permission request or silent installation.
- Preserve the existing uncommitted v1.0.2 editor fixes. Do not reset/stash/discard them or include them in unrelated commits. At execution start inspect git status and use using-git-worktrees to choose isolation without losing those changes.
- Do not bump versions, push, tag or publish installers without separate user authorization.
- Every code task follows RED → minimal implementation → GREEN → review. Commands here are planned, not evidence of execution.
- Tasks are sequential because lifecycle contracts and files overlap.

## File ownership map

- New `src-tauri/src/windows/lifecycle.rs`: pure state machine and effects.
- Existing `windows/main.rs`: IPC identity, readiness and effect execution; no second parallel exit protocol.
- New `src/features/lifecycle/useLifecycleParticipant.ts`: renderer registration, barriers and cancellation.
- Existing settings modules plus new `CloseBehaviorDialog.tsx`: backward-compatible preferences and disclosure.
- New Rust `windows/tray.rs`, `activation.rs`, `platform_lifecycle.rs`: native tray, window restoration and platform event mapping.
- Existing update/settings commands: preserve authorization, route restarts through save confirmation.
- New integration tests and `docs/testing/tray-lifecycle-acceptance.md`: durable-content assertions and actual platform evidence.

## Task 1: Pure lifecycle coordinator

**Files:** Create `src-tauri/src/windows/lifecycle.rs`, `src-tauri/tests/app_lifecycle.rs`; modify `src-tauri/src/windows/mod.rs`, `src-tauri/src/windows/main.rs`, `src-tauri/tests/main_window_lifecycle.rs`.

**Interfaces:** Introduce these public types; derive Debug/Clone/PartialEq/Eq as appropriate:
```rust
pub enum Intent { Hide, Exit, Restart }
pub enum Phase { Visible, PreparingHide, Hidden, PreparingExit, Exiting }
pub struct Participant { pub label: String, pub registration: u64 }
pub enum Effect {
    Flush { generation: u64, intent: Intent, participant: Participant },
    Release { generation: u64, participant: Participant },
    HideMain, ShowMain, Exit, Restart,
    ReportFailure { label: Option<String> },
}
pub struct LifecycleCoordinator {
    // Private fields: phase, next generation, current intent,
    // expected participants, acknowledgment state, deadline.
}
impl LifecycleCoordinator {
    pub fn new() -> Self;
    pub fn request(&mut self, intent: Intent, participants: Vec<Participant>,
                   now_ms: u64) -> Vec<Effect>;
    pub fn acknowledge(&mut self, generation: u64, participant: &Participant,
                       saved: bool) -> Vec<Effect>;
    pub fn cancel(&mut self, generation: u64) -> Vec<Effect>;
    pub fn activate(&mut self) -> Vec<Effect>;
    pub fn expire(&mut self, now_ms: u64) -> Vec<Effect>;
    pub fn phase(&self) -> Phase;
}
```

- [ ] Add this RED test using the real pure coordinator:
```rust
#[test]
fn hidden_sticky_must_acknowledge_before_exit() {
    let mut c = LifecycleCoordinator::new();
    let main = Participant { label: "main".into(), registration: 1 };
    let sticky = Participant { label: "sticky-test".into(), registration: 2 };
    c.request(Intent::Exit, vec![main.clone(), sticky.clone()], 0);
    assert!(!c.acknowledge(1, &main, true).contains(&Effect::Exit));
    assert!(c.acknowledge(1, &sticky, true).contains(&Effect::Exit));
}
```
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --test app_lifecycle`; verify RED.
- [ ] Implement transitions with a participant map and deadline. Hide requests main only; Exit/Restart require every live window. No terminal effect until every expected current token acknowledges. Failure/timeout releases the whole set and returns to usable state.
- [ ] Add separate RED/GREEN cases for forged tokens, stale generations, duplicate ack, startup unready windows, hide versus exit, activation cancelling hide and expiry at 10,000 ms. A registration replacement or new window during a pending snapshot cancels it; do not silently omit unready windows.
- [ ] Extend rather than duplicate existing readiness/generation protections. Keep old tests or migrate their equivalent assertions; do not remove the startup-close safety gate.
- [ ] Run both lifecycle test targets and cargo check. Commit scoped files: `feat: model hide and safe multi-window exit`.

## Task 2: Renderer participants and authenticated save protocol

**Files:** Create `src/features/lifecycle/useLifecycleParticipant.ts` and `.test.tsx`; modify `src/domain/ports.ts`, `src/infrastructure/tauri/ports.ts`, `src/app/App.tsx`, `App.test.tsx`, `src/features/temporary/StickyWindow.tsx`, its test, `src/features/library/LibraryLayout.tsx`, `src-tauri/src/windows/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/desktop.json`, `temporary.json` and `src/infrastructure/tauri/capabilities.test.ts`.

**Interfaces:** Migrate the current AppLifecyclePort and all consumers together:
```ts
export type LifecycleIntent = 'hide' | 'exit' | 'restart'
export interface LifecycleRequest { generation: number; intent: LifecycleIntent }
export interface LifecycleParticipantPort {
  beginRegistration(): Promise<number>
  setReady(ready: boolean, registrationToken: number): Promise<void>
  onPrepare(handler: (request: LifecycleRequest) => void): Promise<() => void>
  onRelease(handler: (request: { generation: number }) => void): Promise<() => void>
  acknowledge(generation: number, registrationToken: number, saved: boolean): Promise<void>
}
export interface SaveParticipant { prepare(signal: AbortSignal): Promise<(() => void) | null> }
```
Hook: `useLifecycleParticipant(port: LifecycleParticipantPort | undefined, participant: SaveParticipant): void`.
Rust infers the caller label from the actual webview and validates label, token and generation; no renderer-supplied target label is trusted.

- [ ] Build a test-local fake port with stored callbacks and a captured acknowledgment array. Add a cancellation test:
```ts
let finish!: (release: (() => void) | null) => void
const release = vi.fn()
const prepare = () => new Promise<(() => void) | null>(resolve => { finish = resolve })
// Harness renders the real hook; fake port delivers events.
await act(async () => harness.emitPrepare({ generation: 1, intent: 'exit' }))
await act(async () => harness.emitRelease({ generation: 1 }))
await act(async () => finish(release))
expect(release).toHaveBeenCalledOnce()
expect(harness.acknowledgments).toEqual([])
```
The harness defines emitPrepare/emitRelease by invoking registered callbacks; beginRegistration returns 1, setReady resolves, acknowledge appends the payload. Keep these helpers entirely in tests.
- [ ] Run `pnpm test -- src/features/lifecycle/useLifecycleParticipant.test.tsx`; verify RED.
- [ ] Implement cancellation tombstones and idempotent barrier release:
```ts
const release = await participant.prepare()
if (cancelled.has(request.generation)) {
  release?.()
  return
}
held.set(request.generation, release)
await port.acknowledge(request.generation, token, release !== null)
```
Catch failures as negative acknowledgments; late completion/unmount must release rather than leak a barrier. Ignore duplicate prepare events already held or in flight.
- [ ] Main uses `LibraryLayoutHandle.prepareExit()`. Sticky uses beginEditBarrier → autosave.flush → retained release callback. Failed sticky save must reject application exit even though ordinary sticky hide preserves a mounted draft.
- [ ] Wire Rust effect execution outside locks and a generation-specific one-shot 10-second timer. Disallow capture/window creation while preparing exit. Release messages must also cover participants still waiting on asynchronous paste.
- [ ] Add App/StickyWindow regressions for hidden dirty drafts, failed saves, pending image pastes, cancel/retry and successful hide releasing barriers. Run affected tests, capabilities tests, lifecycle Cargo targets and typecheck.
- [ ] Commit: `feat: coordinate durable saves across editor windows`.

## Task 3: Close preference and first-close dialog

**Files:** Modify `src/shared/settings-defaults.json`, `src/domain/ports.ts`, `src-tauri/src/commands/settings.rs`, `src-tauri/tests/settings.rs`, `src/features/settings/SettingsView.tsx`, its test, `src/test/fakes.ts`, `src/app/App.tsx`; create `src/features/lifecycle/CloseBehaviorDialog.tsx` and test.

**Interfaces:**
```ts
// AppSettings additions, with matching Rust serde defaults:
closeToTray: boolean              // true
closeBehaviorConfirmed: boolean   // false
showMenuBarIcon: boolean          // true
interface CloseBehaviorDialogProps {
  onChoose(choice: 'hide' | 'exit', remember: boolean): void
  onCancel(): void
}
```

- [ ] Add RED old-settings fixtures without the new fields. Assert true/false/true defaults and unchanged autostart/data-root values. Run `cargo test --manifest-path src-tauri/Cargo.toml --test settings`.
- [ ] Implement serde defaults, validated patches and shared JSON defaults. New fields cannot be required from old files.
- [ ] Write dialog behavior tests:
```tsx
const onChoose = vi.fn()
render(<CloseBehaviorDialog onChoose={onChoose} onCancel={vi.fn()} />)
fireEvent.click(screen.getByRole('button', { name: '隐藏到托盘' }))
expect(onChoose).toHaveBeenCalledWith('hide', true)
```
Add Escape cancellation, remember=false one-time choice, explicit quit and persistence-error cases.
- [ ] Run the new dialog test to observe RED; implement a labelled native-style application dialog using existing focus management. Default remember=true; user can uncheck. Save remembered choice before acting; on save failure keep the window visible and show retry.
- [ ] Windows settings expose closeToTray. Changing it explicitly sets closeBehaviorConfirmed. macOS exposes showMenuBarIcon while keeping Dock restoration and Cmd+Q; never force Windows close-to-quit semantics onto macOS. No notifications permission request.
- [ ] Run dialog/SettingsView tests, settings Cargo target and typecheck. Commit: `feat: expose explicit close-to-tray preferences`.

## Task 4: Native tray and activation

**Files:** Create `src-tauri/src/windows/tray.rs`, `activation.rs`, `src-tauri/tests/tray_actions.rs`; modify `windows/mod.rs`, `src-tauri/src/lib.rs`, Cargo.toml/lock, `src/domain/ports.ts`, `src/infrastructure/tauri/ports.ts`, `src/app/App.tsx`, `src/features/library/LibraryLayout.tsx` and their tests.

**Interfaces:**
```rust
pub enum TrayAction { OpenMain, NewCapture, OpenInbox, OpenSettings, Exit }
pub fn parse_tray_action(id: &str) -> Option<TrayAction>;
```
```ts
export type MainWindowAction = 'open-inbox' | 'open-settings'
export interface MainWindowActionPort {
  onAction(handler: (request: { id: number; action: MainWindowAction }) => void): Promise<() => void>
  setReady(ready: boolean): Promise<void>
  complete(id: number, applied: boolean): Promise<void>
}
```
Native buffering keeps the latest navigation action until readiness; same request ID cannot navigate twice. React executes existing save/navigation guards.

- [ ] RED action routing assertions:
```rust
assert_eq!(parse_tray_action("open-inbox"), Some(TrayAction::OpenInbox));
assert_eq!(parse_tray_action("unknown"), None);
```
Also capture adapter effects: NewCapture uses existing capture service without opening main; Exit requests Intent::Exit and never directly calls app.exit().
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --test tray_actions`; implement routing.
- [ ] Enable Tauri's tray-icon feature and create the exact native menu from the spec. Stable IDs: open-main, new-capture, open-inbox, open-settings, exit. Use the existing original icon on Windows and a template-compatible original mark on macOS.
- [ ] Windows left-button release opens main and right-click opens menu; disable menu-on-left-click there. macOS click opens its native menu. Retain exactly one tray owner.
- [ ] Implement activation operations in this order: cancel pending hide, ensure window exists, unminimize if required, restore/clamp geometry to available work area, show if hidden, focus. Do not recreate an existing editor.
- [ ] Add RED tests for queued action delivery, save failure preventing inbox/settings navigation, repeated activation and offscreen geometry; then implement those adapter paths.
- [ ] If tray creation fails, set session-only availability false, show a persistent recoverable warning, keep main accessible and refuse Hide; do not overwrite settings.
- [ ] Run tray/lifecycle Cargo tests, App/LibraryLayout tests, typecheck and cargo check. Commit: `feat: add native tray actions and window restoration`.

## Task 5: Single instance and platform lifecycle

**Files:** Create `src-tauri/src/windows/platform_lifecycle.rs`, `src-tauri/tests/platform_lifecycle.rs`; modify `src-tauri/src/lib.rs`, `windows/mod.rs`, Cargo.toml/lock and activation adapter.

**Interfaces:**
```rust
pub enum Platform { Windows, MacOS }
pub enum NativeEvent { MainClose, AppQuit, Activate, SessionEnd }
pub enum NativeAction { Hide, Exit, Activate, SaveForSessionEnd }
pub fn map_native_event(platform: Platform, event: NativeEvent,
                        close_to_tray: bool) -> NativeAction;
```

- [ ] Add RED mapping cases:
```rust
assert_eq!(map_native_event(Platform::Windows, NativeEvent::MainClose, true),
           NativeAction::Hide);
assert_eq!(map_native_event(Platform::Windows, NativeEvent::SessionEnd, true),
           NativeAction::SaveForSessionEnd);
assert_eq!(map_native_event(Platform::MacOS, NativeEvent::AppQuit, true),
           NativeAction::Exit);
```
Also cover Windows preference=false, macOS MainClose and Activate.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --test platform_lifecycle`; implement mapping and native routing.
- [ ] Verify the compatible official Tauri single-instance plugin version before adding it. Register it before settings/storage setup. A second launch activates the existing instance and ignores unspecified argv; no new deep-link capability.
- [ ] Preserve Windows minimize and macOS Dock activation/Cmd+W/Cmd+Q. Disable new mutation actions during exit preparation and re-enable on cancellation.
- [ ] Inspect actual Tauri/winit session-end support; use event-based platform adapters if required. Session end receives a bounded flush opportunity, never Hide and never an infinite ordinary-exit cancellation loop. Do not claim forced termination can guarantee every last keystroke.
- [ ] Test Explorer restart using the real tray. Confirm re-registration; if its failure is not observable in the library, implement an event-based recovery hook. Failure restores main. Unverified recovery blocks release rather than being marked supported.
- [ ] Run platform tests, cargo check and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`; perform Windows second-launch, Explorer and display-change smoke with disposable test data.
- [ ] Commit: `feat: preserve native activation and session lifecycle`.

## Task 6: Safe restart and stale-writer safety

**Files:** Modify `src-tauri/src/commands/updates.rs`, `src-tauri/src/commands/settings.rs`, `src-tauri/src/windows/main.rs`, `src-tauri/tests/settings.rs`, `src-tauri/tests/security.rs`, `src-tauri/tests/app_lifecycle.rs`, `src/features/settings/UpdateSettings.test.tsx`.

**Interfaces:** Existing restart_after_update/restart_application commands keep caller and state authorization. After authorization request Intent::Restart; only Effect::Restart invokes app.restart(). Ordinary explicit quit reaches only Effect::Exit.

- [ ] Add RED tests for unauthorized window labels, missing installed-update state, missing relocation state and pending dirty sticky on restart. Run affected security/settings/lifecycle targets.
- [ ] Replace direct restart after the existing authorization checks:
```rust
// Once the existing command-specific authorization succeeds:
let effects = coordinator.request(Intent::Restart, participants, now_ms);
// Execute Flush effects now. app.restart() is called only on Effect::Restart.
```
Do not remove security checks to make lifecycle routing easier.
- [ ] Test a stale inbox/sticky revision pair with the real repository: stale save must fail, preserve its local draft and cancel exit; never silently replace newer content. Investigate existing revision ownership before changing repository behavior. If resolving this requires a storage redesign, stop and seek approval rather than expand the tray task silently.
- [ ] Compose the existing relocation lock with exit cancellation; release only locks/barriers this attempt owns. Gate new captures and editor-window creation while the snapshot is preparing/committing.
- [ ] Run affected Rust tests and UpdateSettings test, typecheck and cargo check. Commit: `fix: route authorized restarts through safe save coordination`.

## Task 7: Integration and native acceptance

**Files:** Create `src-tauri/tests/tray_lifecycle_integration.rs`, `docs/testing/tray-lifecycle-acceptance.md`; update README.md and CHANGELOG.md only for implemented behavior, preserving current edits.

- [ ] Create real temporary repositories with a controllable native-window adapter. Start main and two sticky save participants, one hidden. Assert persisted contents after all confirmations, not only the number of callbacks.
- [ ] Introduce one failed write; assert no Exit/Restart effect, released barriers, preserved draft and successful retry. Add paste resolution after cancellation and stale shutdown acknowledgment cases.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --test tray_lifecycle_integration` to establish RED; implement only any missing integration connection and rerun GREEN.
- [ ] Run affected lifecycle/App/StickyWindow/Settings/LibraryLayout/capabilities Vitest targets, `pnpm typecheck`, `pnpm lint`, `pnpm build`, cargo check and Clippy.
- [ ] Run the complete Rust suite once on the finished code because multi-window shutdown and restart affect persistence. Do not run the 10,000-note search fixture unless indexing changes.
- [ ] Record Windows and macOS real tests from every spec acceptance row: close/quit/minimize, first-close disclosure, save error, 10-second timeout, single instance, native menu keyboard use, Dock, Explorer restart, DPI 100/150/200%, themes/high contrast, monitor removal, session end and explicit restart.
- [ ] Measure idle CPU/memory visible versus hidden and after 50 hide/restore cycles. Report measurements, single tray ownership and listener cleanup; do not claim “zero overhead”.
- [ ] Record unavailable platforms as not run. Do not publish an installer, signed release or claim complete cross-platform support without real acceptance.
- [ ] Document restore, quit, unchanged autostart and crash limitations. Run `git diff --check`, review and commit only reviewed feature files: `test: verify tray and safe lifecycle integration`.

## Plan self-review and execution gates

- Spec goals/architecture → tasks 1–2 and 4; no daemon or second state framework.
- Spec user interactions → tasks 3–5.
- Spec save/timeout/cancellation → tasks 1–2; restart → task 6.
- Spec single-instance/failure/session events → tasks 4–5.
- Spec compatibility/typed boundaries → tasks 2–3; stale writers → task 6.
- Spec native/platform/performance acceptance → task 7, including explicit not-run outcomes.
- No production code, tests, dependency installation, builds or platform verification were executed while writing this plan.
