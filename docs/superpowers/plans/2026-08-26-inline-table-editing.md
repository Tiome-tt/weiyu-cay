# Inline Table Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. No commit, push, or PR is created for this worktree.

**Goal:** Replace the existing table-editing dialog for document-mode tables with an inline spreadsheet-like grid while keeping Markdown as the only durable note body.

**Architecture:** Extend the existing `MarkdownTable` model with optional Cay table metadata for rectangular merged cells. Keep ordinary tables as unchanged GFM Markdown; serialize merge metadata as a sanitized, adjacent HTML comment that is ignored by other Markdown readers. Render and edit tables through the existing CodeMirror document widget, dispatching source-range replacements through `MarkdownSource` so autosave, undo, scrolling, and source view remain intact.

**Tech Stack:** React, TypeScript, CodeMirror 6 widgets, unified/remark GFM, Vitest, existing CSS tokens.

**Spec:** `docs/superpowers/specs/2026-08-24-document-editor-redesign-design.md`

## Global Constraints

- Markdown and assets remain durable content; SQLite remains an index and metadata store.
- CodeMirror 6 remains the only source editor; no second editor or spreadsheet dependency is introduced.
- Unsupported Markdown is never silently discarded; malformed Cay metadata falls back to the ordinary GFM table.
- All edits go through the existing `MarkdownSource`/autosave path and preserve source offsets and scroll behavior.
- Keep keyboard focus, visible focus, reduced motion, and high-contrast behavior intact.
- Preserve all existing table insertion, source mode, split mode, preview mode, and Markdown compatibility tests.

### Task 1: Table metadata and transformations

**Files:**
- Modify: `src/features/editor/markdownActions.ts`
- Test: `src/features/editor/markdownActions.test.ts`

**Interfaces:**
- Add `MarkdownTableMerge { row: number; column: number; rowSpan: number; columnSpan: number }`.
- Extend `MarkdownTable` with optional `merges?: MarkdownTableMerge[]`.
- Add pure helpers `tableWithCell`, `tableWithInsertedRow`, `tableWithInsertedColumn`, `tableWithDeletedRow`, `tableWithDeletedColumn`, `mergeTableCells`, `splitTableCell`, and `tableMarkdownFromModel`.

- [ ] Write failing tests for parsing/serializing valid metadata, malformed metadata fallback, cell edits, row/column insertion and deletion, rectangular merge, and split.
- [ ] Run the focused Vitest file and confirm the new assertions fail for missing helpers.
- [ ] Implement the smallest pure model and transformation functions; preserve current `tableMarkdownFromCells` output for tables without merges.
- [ ] Run the focused Vitest file and confirm all table model tests pass.

### Task 2: Inline table widget editing

**Files:**
- Modify: `src/features/editor/documentWidgets.ts`
- Modify: `src/features/editor/documentMarkdown.ts`
- Test: `src/features/editor/documentMarkdown.test.ts`

**Interfaces:**
- `DocumentTableWidget` receives a source range, `MarkdownTable`, read-only state, and `onChange({ from, to, table })` callback.
- The widget renders inputs/contenteditable cells directly in the document and exposes `aria-label="Markdown 表格"` plus keyboard-reachable controls.

- [ ] Write failing tests asserting an existing table renders inline cell controls, does not require the edit dialog, and emits a source replacement after a cell change.
- [ ] Run the focused widget tests and confirm they fail against the current click-to-dialog behavior.
- [ ] Implement inline cell editing and an unobtrusive active toolbar with row/column add/delete, merge/split, and alignment actions; use the pure transformations from Task 1.
- [ ] Ensure read-only preview/source states render cells without editable controls and that malformed metadata renders as a normal table.
- [ ] Run the focused widget tests and confirm they pass.

### Task 3: MarkdownSource integration and insertion compatibility

**Files:**
- Modify: `src/features/editor/MarkdownSource.tsx`
- Modify: `src/features/editor/TableEditorDialog.tsx`
- Modify: `src/styles/app.css`
- Test: `src/features/editor/MarkdownSource.test.tsx`
- Test: `src/features/editor/TableEditorDialog.test.tsx`

**Interfaces:**
- Replace the existing `onEditTable` dialog callback for existing tables with a `replaceTable` callback that dispatches one CodeMirror transaction over the table plus adjacent metadata comment.
- Keep `TableEditorDialog` only for inserting a new table from the existing context menu, or simplify it to a dimension picker; existing tables must never open it.

- [ ] Add failing integration tests for direct cell typing, adding/removing rows and columns, merge/split persistence, source-mode round trip, and preserving the editor scroll position.
- [ ] Run the focused MarkdownSource tests and confirm the new behavior fails because the dialog is still opened.
- [ ] Implement the transaction bridge, metadata range tracking, focus retention, and toolbar styling using existing warm-white/sage tokens.
- [ ] Run MarkdownSource and table dialog tests; update only assertions that intentionally describe the new inline behavior.

### Task 4: Preview parity and safety

**Files:**
- Modify: `src/features/editor/MarkdownPreview.tsx`
- Modify: `src/features/editor/markdownPipeline.ts`
- Test: `src/features/editor/markdownPipeline.test.ts`
- Test: `src/features/editor/MarkdownPreview.test.tsx` (create if absent)

**Interfaces:**
- Preview rendering consumes the same parsed `MarkdownTable` metadata and emits `rowspan`/`colspan` only for validated merge rectangles.

- [ ] Write failing tests for merged preview cells and malformed metadata fallback.
- [ ] Run the focused preview tests and confirm they fail because the pipeline currently ignores Cay metadata.
- [ ] Implement a narrow table-only metadata pass without enabling unsafe raw HTML or changing link/image sanitization.
- [ ] Run preview/pipeline tests and confirm ordinary GFM output remains unchanged.

### Task 5: Full verification and visual QA

**Files:**
- No additional production files unless verification exposes a regression.

- [ ] Run focused editor tests covering model, widget, MarkdownSource, preview, and existing table dialog behavior.
- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check`.
- [ ] If the desktop UI can start safely, open a representative note and visually verify direct cell editing, merge/split, and source/preview parity.
- [ ] Report any unrelated dirty-worktree failures separately; do not revert user changes or commit.
