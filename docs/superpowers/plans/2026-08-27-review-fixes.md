# Review Findings Fixes Implementation Plan

> **For agentic workers:** Inline execution in the current session; each task follows a test-first cycle.

**Goal:** Repair the reviewed safety, navigation, layout, outline, accessibility, and test-contract regressions without discarding unrelated working-tree changes.

**Architecture:** Keep filesystem and SQLite recovery in Rust, expose folder trash through the existing typed boundary, and keep React navigation state in domain hooks/components. Preserve Markdown as the source of truth and retain the existing three-column main-window contract.

**Tech Stack:** Rust/Tauri 2, SQLite, React, TypeScript, Vitest, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-07-30-simple-notes-design.md` and `docs/superpowers/specs/2026-08-24-document-editor-redesign-design.md`

## Global Constraints

- Core note features work offline and Markdown/assets remain durable content.
- Destructive actions remain recoverable through application trash or immediate undo.
- The main window keeps resizable folder, note-list, and editor columns.
- TypeScript stays strict and Rust commands return structured errors across Tauri.
- Every behavior change gets a failing test before implementation.

### Task 1: Harden folder deletion and folder-trash lifecycle

**Files:**
- Modify: `src-tauri/src/commands/folders.rs`
- Modify: `src-tauri/src/storage/trash.rs`
- Test: `src-tauri/tests/folders.rs`, `src-tauri/tests/trash.rs`

- [ ] Add tests for nonexistent folder deletion, partial note-trash failure, folder-only listing, and folder expiry.
- [ ] Run the focused Rust tests and confirm each new test fails for the reported reason.
- [ ] Add explicit not-found validation, preserve operation IDs on partial failure, and include folder manifests in list/purge maintenance.
- [ ] Run focused Rust tests and `cargo check --tests --benches`.

### Task 2: Restore navigation and the three-column contract

**Files:**
- Modify: `src/features/library/LibraryLayout.tsx`
- Modify: `src/features/library/LibraryRail.tsx`
- Modify: `src/features/library/FolderTree.tsx`
- Modify: `src/features/library/useLibrary.ts`
- Test: `src/features/library/FolderTree.test.tsx`, `src/features/library/rails.test.tsx`, `src/features/library/LibraryLayout.test.tsx`

- [ ] Add failing tests proving unfiled navigation, visible tree focus fallback, and an independent note-list pane.
- [ ] Restore the unfiled entry and focus fallback to a visible key.
- [ ] Keep `NoteList` in the middle column and render `NoteOutline` as a scoped editor-side aid without removing note-list behavior.
- [ ] Run focused library tests and type-check.

### Task 3: Fix outline parsing and save-state accessibility

**Files:**
- Modify: `src/features/library/NoteOutline.tsx`
- Modify: `src/features/editor/EditorPane.tsx`
- Test: `src/features/library/NoteOutline.test.tsx`, `src/app/App.test.tsx`

- [ ] Add a fenced-code heading test and a distinct save-status label test.
- [ ] Track fenced code blocks while parsing headings and give editor/global statuses unique accessible names.
- [ ] Run focused editor/app tests and type-check.

### Task 4: Synchronize localized test contracts and run verification

**Files:**
- Modify: affected tests under `src/app`, `src/features/editor`, `src/features/library`, and `src/features/settings`

- [ ] Update selectors/assertions to the current Chinese UI contract or stable roles.
- [ ] Run affected Vitest files, then the full frontend suite if resources permit.
- [ ] Run `git diff --check` and report any environmental lint/build blockers separately.
