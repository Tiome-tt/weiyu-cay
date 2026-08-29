# Release Readiness Fixes Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with focused verification after each task.

**Goal:** Make the current Cay (微屿) workspace internally consistent and able to produce a verifiable Windows installer candidate for version 1.0.0.

**Architecture:** Keep the existing Tauri 2, React/Vite, Rust, and GitHub Actions architecture. Restrict changes to release metadata, repository hygiene, formatting, deterministic lint scope, and the diagnosed installer failure; do not add a second packaging or update mechanism.

**Tech Stack:** Tauri 2, React/TypeScript, Vite, Rust/Cargo, WiX, pnpm, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-30-simple-notes-design.md` and `docs/release-checklist.md`.

## Global Constraints

- Keep Markdown and assets as durable content; SQLite remains rebuildable metadata/index state.
- Keep `微屿` as the primary Chinese UI name and `Cay` in English release prose.
- Keep the checked-in updater configuration fail-closed; release-only signing configuration remains workflow-generated.
- Do not commit generated build outputs, local worktrees, secrets, signing material, or local application data.
- Do not push, create a GitHub Release, or create a signing tag without explicit follow-up authorization.

---

### Task 1: Release metadata and repository hygiene

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
- Modify: `.gitignore`
- Test: version consistency checks in `.github/workflows/release.yml` and `git status`

- [ ] Set all three application versions to `1.0.0`.
- [ ] Ignore generated `target-*` directories without hiding source files.
- [ ] Verify no secret material is present and that the checked-in updater config remains empty/fail-closed.

### Task 2: Deterministic local lint and Rust formatting

**Files:**
- Modify: `eslint.config.js` if needed to ignore `.worktrees/**` and generated roots.
- Modify: Rust files only through `cargo fmt`.

- [ ] Add a regression-safe ignore rule for nested worktrees so `pnpm lint` behaves like CI on a clean checkout.
- [ ] Run `cargo fmt --all` and verify `cargo fmt -- --check`.
- [ ] Run root `pnpm lint` and `pnpm typecheck`.

### Task 3: Rust test environment diagnosis

**Files:**
- No production-code change unless a reproducible project defect is found.

- [ ] Re-run `cargo test --manifest-path src-tauri/Cargo.toml` after formatting.
- [ ] If the failure remains the MSVC `msvcrt.lib` linker error, record it as an environment prerequisite rather than weakening tests or changing linker behavior.
- [ ] Run the workflow configuration contract tests if available.

### Task 4: Windows installer root-cause and rebuild

**Files:**
- Modify only the Tauri/WiX configuration or resource causing the reproducible failure.

- [ ] Reproduce MSI failure with verbose output and inspect the generated WiX inputs.
- [ ] Test the alternate NSIS bundle path to distinguish project configuration from WiX-only failure.
- [ ] Apply the smallest root-cause fix and rebuild the unsigned installer.
- [ ] Confirm the bundle directory contains a usable installer and record its filename and size.

### Task 5: Release-gate verification

**Files:**
- No additional product changes unless verification exposes a direct release blocker.

- [ ] Run UI tests, UI build, Rust check, Clippy, Rust format check, and targeted release metadata tests.
- [ ] Confirm `git diff --check`, version agreement, clean release asset scope, and absence of configured remotes/tags requiring user action.
- [ ] Report remaining external prerequisites (GitHub remote, signing secrets, signed tag, cross-platform smoke tests) without performing them.
