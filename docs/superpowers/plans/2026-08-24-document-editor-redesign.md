# Cay (微屿) Document Editor Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Markdown editor into the approved warm, direct, document-style experience without changing the durable Markdown model.

**Architecture:** Keep CodeMirror 6 as the sole editing engine and derive visual line classes from editor state. Keep formatting transformations pure in `markdownActions.ts`; React renders controls and dispatches CodeMirror transactions. Align title, source editor, and sanitized preview through one shared CSS reading measure.

**Tech Stack:** React 19, TypeScript strict mode, CodeMirror 6, Vitest/Testing Library, existing unified Markdown preview pipeline, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-08-24-document-editor-redesign-design.md`

## Global Constraints

- Markdown and assets remain the only durable note content; SQLite remains rebuildable metadata/index state.
- Preserve `EditorMode` values (`source`, `split`, `preview`) and persisted settings compatibility.
- Do not add another editor, state, styling, or component framework.
- Unsupported Markdown remains source text and is never discarded or silently normalized.
- Preserve autosave, editing barriers, internal links, image paste, and navigation behavior.
- Keep keyboard operation, visible focus, reduced motion, and adequate contrast.
- Preserve unrelated uncommitted user changes; modify relevant files incrementally.

---

### Task 1: Pure document-formatting contracts

**Files:**
- Create: `src/features/editor/documentMarkdown.ts`
- Create: `src/features/editor/documentMarkdown.test.ts`
- Modify: `src/features/editor/markdownActions.ts`
- Modify: `src/features/editor/markdownActions.test.ts`

**Interfaces:**
- Produces `classifyDocumentLine(text, inFence)` with a line kind, next fence state, and hidden prefix length.
- Produces `formatMarkdownSelection(markdown, from, to, style)` with changed Markdown and selection positions.

- [ ] Write failing classifier tests for headings, quotes, tasks, lists, fenced code, divider, paragraph, and hidden heading prefixes.
- [ ] Run `pnpm test -- src/features/editor/documentMarkdown.test.ts` and observe the missing-module failure.
- [ ] Implement the anchored, stateful classifier without rewriting content.
- [ ] Run the classifier test and verify it passes.
- [ ] Write failing formatter tests with literal expectations for bold, italic, link, code, strikethrough, and collapsed selection.
- [ ] Run `pnpm test -- src/features/editor/markdownActions.test.ts` and observe the missing formatter failure.
- [ ] Implement minimal selection formatting and intentional selection restoration.
- [ ] Run both pure-function tests.

### Task 2: CodeMirror document surface and direct controls

**Files:**
- Modify: `src/features/editor/documentMarkdown.ts`
- Modify: `src/features/editor/MarkdownSource.tsx`
- Modify: `src/features/editor/MarkdownSource.test.tsx`

**Interfaces:**
- Consumes Task 1 helpers.
- Produces `documentMarkdownExtension`, `.markdown-block-handle`, `.markdown-inline-toolbar`, and opens the existing insertion menu from the handle.

- [ ] Write and run a failing component test for heading/task/quote decorations and unchanged Markdown value.
- [ ] Implement line decorations plus inactive-heading prefix replacement, keeping the active marker visible.
- [ ] Run the decoration test.
- [ ] Write and run a failing test that opens the insertion menu through “添加内容块”.
- [ ] Implement the active-line block handle with a non-layout fallback position.
- [ ] Write and run a failing test that selects text and applies “加粗”.
- [ ] Implement the accessible inline toolbar for bold, italic, link, inline code, and strikethrough.
- [ ] Run `pnpm test -- src/features/editor/MarkdownSource.test.tsx`.

### Task 3: Document title, toolbar language, and preview structure

**Files:**
- Modify: `src/features/editor/EditorPane.tsx`
- Modify: `src/features/editor/EditorPane.test.tsx`
- Modify: `src/features/editor/MarkdownPreview.tsx`
- Modify: `src/features/settings/SettingsView.tsx`
- Modify: `src/features/settings/SettingsView.test.tsx`

**Interfaces:**
- Produces `.editor-document-heading`, `.editor-breadcrumbs`, and `.markdown-preview__page` while retaining mode values and callbacks.

- [ ] Write and run a failing EditorPane test for “文档编辑”, folder/title breadcrumb, and document title placement.
- [ ] Move title presentation into the document grid, derive the breadcrumb from existing folders, expose update metadata, and rename view labels.
- [ ] Wrap preview content in `.markdown-preview__page` while retaining the article scroll boundary.
- [ ] Write/update a focused settings test, then rename view options.
- [ ] Run the focused EditorPane and SettingsView tests.

### Task 4: Approved visual system and verification

**Files:**
- Modify: `src/styles/tokens.css`
- Modify: `src/styles/main-window.css`
- Modify: `scripts/main-window-css.test.ts`

**Interfaces:**
- Produces shared `--document-measure: 780px` alignment across title, editor, and preview.

- [ ] Add and run a failing CSS contract test for the shared measure, 44px toolbar, aligned title/body, and non-card reading surface.
- [ ] Implement ivory-and-sage document CSS for toolbar, title, CodeMirror lines, floating controls, preview content, split mode, focus, narrow widths, and reduced motion.
- [ ] Run all focused editor and CSS tests.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm build` for the editor/CSS integration boundary.
- [ ] Capture and inspect a representative main-window screenshot against the approved concept.
- [ ] Run `git diff --check` and review only the relevant diff.

