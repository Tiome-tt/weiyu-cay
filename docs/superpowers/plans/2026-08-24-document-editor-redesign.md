# Cay (微屿) Live Markdown Document Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current source-like document view with a live Markdown document surface that renders supported formatting, images, and tables in place while preserving the exact Markdown string in CodeMirror 6.

**Architecture:** Use CodeMirror's Markdown syntax tree to derive typed source ranges. In document presentation, mark decorations style content, replace decorations hide inactive delimiters, and atomic widgets render tasks, dividers, owned images, and GFM tables. Split mode explicitly requests complete source presentation. Every edit remains a CodeMirror transaction and unsupported syntax remains visible source.

**Tech Stack:** React 19, TypeScript strict mode, CodeMirror 6, `@codemirror/language`, Lezer Markdown syntax trees, Vitest/Testing Library, existing typed image/link ports, existing unified preview pipeline, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-08-24-document-editor-redesign-design.md`

## Global Constraints

- Preserve all pre-existing uncommitted work and modify relevant files incrementally.
- Do not commit, push, create a branch, or create a PR.
- Markdown and owned assets remain the only durable note content.
- CodeMirror 6 remains the only editing engine and transaction source.
- Preserve persisted `EditorMode` values: `source`, `split`, and `preview`.
- Document presentation uses local reveal; split presentation exposes complete Markdown source.
- Unsupported, malformed, incomplete, raw-HTML, and unsafe constructs remain visible source.
- Preserve autosave, edit barriers, image-paste ordering, internal-link atomics, navigation, undo, selection, and scroll behavior.
- New behavior is implemented test-first; each focused test must be observed failing for the intended reason before production changes.

---

### Task 1: Syntax-derived live document model

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Replace: `src/features/editor/documentMarkdown.ts`
- Modify: `src/features/editor/documentMarkdown.test.ts`

**Interfaces:**
- Produces `LiveMarkdownKind` for `heading | strong | emphasis | strikethrough | inline-code | link | list-marker | task-marker | quote-marker | divider | fenced-code | image | table`.
- Produces `LiveMarkdownNode { kind, from, to, contentFrom, contentTo, blockFrom, blockTo, metadata }`.
- Produces `analyzeLiveMarkdown(state: EditorState, ranges: readonly { from: number; to: number }[]): readonly LiveMarkdownNode[]`.
- Produces `isLiveNodeActive(node: LiveMarkdownNode, selection: EditorSelectionRange): boolean`.

- [ ] **Step 1: Write failing syntax-model tests**

  Add literal fixtures covering nested emphasis, escaped punctuation, standard links, images, tasks, fenced code, dividers, complete GFM tables, malformed tables, raw HTML, and a visible-range boundary. Assert exact source ranges and kinds, not parser implementation details.

- [ ] **Step 2: Run the syntax-model test and confirm RED**

  Run: `pnpm test -- src/features/editor/documentMarkdown.test.ts`

  Expected: FAIL because `analyzeLiveMarkdown` and the new typed nodes do not exist.

- [ ] **Step 3: Add the direct syntax-tree dependency**

  Add `"@codemirror/language": "^6.12.4"` beside the existing CodeMirror packages and update the lockfile with `pnpm install --offline` when the local store permits it.

- [ ] **Step 4: Implement the minimal syntax model**

  Traverse `syntaxTree(state)` only across requested ranges, promote table and fenced-code nodes to complete block ranges, and emit independently hand-verifiable offsets. Keep regex use limited to parsing already-bounded image destinations, task markers, and GFM table rows.

- [ ] **Step 5: Run the syntax-model test and confirm GREEN**

  Run: `pnpm test -- src/features/editor/documentMarkdown.test.ts`

---

### Task 2: Inline formatting and source/document presentation

**Files:**
- Modify: `src/features/editor/documentMarkdown.ts`
- Modify: `src/features/editor/MarkdownSource.tsx`
- Modify: `src/features/editor/MarkdownSource.test.tsx`
- Modify: `src/features/editor/EditorPane.tsx`
- Modify: `src/features/editor/EditorPane.test.tsx`

**Interfaces:**
- Produces `MarkdownPresentation = 'document' | 'source'`.
- `MarkdownSource` consumes `presentation?: MarkdownPresentation`, defaulting to `document`.
- Produces `createDocumentMarkdownExtension(options): Extension` and `refreshDocumentMarkdownContext: StateEffect<void>`.

- [ ] **Step 1: Write a failing inactive-inline rendering test**

  Render `Start **bold** *italic* ~~gone~~ \`code\` [site](https://example.com)`. Assert formatted DOM classes and visible text, assert the inactive delimiter text is absent, and assert `contentDOM.value` is the exact original Markdown.

- [ ] **Step 2: Run the focused component test and confirm RED**

  Run: `pnpm test -- src/features/editor/MarkdownSource.test.tsx -t "renders inactive inline Markdown"`

  Expected: FAIL because the punctuation is still visible.

- [ ] **Step 3: Implement inline mark and delimiter decorations**

  Apply mark decorations to content ranges and replace only delimiter/destination ranges while inactive. Reveal the complete syntax node when its range intersects the main selection. Do not decorate literal content inside code nodes.

- [ ] **Step 4: Write and run a failing local-reveal test**

  Move the CodeMirror selection into each supported node and assert its complete source becomes visible while an unrelated formatted node remains rendered.

- [ ] **Step 5: Implement active-node invalidation**

  Rebuild decorations on document, selection, viewport, geometry, or explicit context refresh changes. Include the active block even when it lies just outside the viewport.

- [ ] **Step 6: Write and run a failing split-source presentation test**

  Assert EditorPane's split editor visibly contains complete Markdown punctuation while document mode hides inactive punctuation.

- [ ] **Step 7: Pass presentation explicitly**

  Pass `presentation="document"` for document mode and `presentation="source"` for split mode. Source presentation installs language support and existing link behavior but no live-document hiding or widgets.

- [ ] **Step 8: Run focused tests**

  Run: `pnpm test -- src/features/editor/MarkdownSource.test.tsx src/features/editor/EditorPane.test.tsx`

---

### Task 3: Lists, tasks, quotes, dividers, and fenced code

**Files:**
- Modify: `src/features/editor/documentMarkdown.ts`
- Modify: `src/features/editor/MarkdownSource.tsx`
- Modify: `src/features/editor/MarkdownSource.test.tsx`
- Modify: `src/styles/main-window.css`

**Interfaces:**
- Document extension consumes typed intents `toggleTask(from: number, to: number, checked: boolean)` and rejects them while read-only or behind an edit barrier.
- Produces accessible `.cm-live-task-checkbox` and `.cm-live-divider` widgets.

- [ ] **Step 1: Write failing block-display tests**

  Assert inactive list/quote punctuation and code fences are hidden, list indentation remains legible, divider source is replaced by a rule, and code content stays literal.

- [ ] **Step 2: Run the block tests and confirm RED**

  Run: `pnpm test -- src/features/editor/MarkdownSource.test.tsx -t "renders document blocks"`

- [ ] **Step 3: Implement block decorations and widgets**

  Use line decorations for hierarchy, replace bounded markers only, render the divider widget, and reveal an entire fenced-code block when the selection enters any line within it.

- [ ] **Step 4: Write a failing task-toggle transaction test**

  Activate the rendered checkbox and assert `- [ ] task` becomes the literal `- [x] task`, emits one document change, supports undo, and does nothing in read-only/barrier state.

- [ ] **Step 5: Implement task toggling through the editor adapter**

  Dispatch only the marker character replacement. Preserve selection and use existing transaction filtering.

- [ ] **Step 6: Run the block and regression tests**

  Run: `pnpm test -- src/features/editor/MarkdownSource.test.tsx src/features/editor/internalLinks.test.ts`

---

### Task 4: Owned-image widgets and failure fallback

**Files:**
- Create: `src/features/editor/documentWidgets.ts`
- Create: `src/features/editor/documentWidgets.test.ts`
- Modify: `src/features/editor/documentMarkdown.ts`
- Modify: `src/features/editor/MarkdownSource.tsx`
- Modify: `src/features/editor/MarkdownSource.test.tsx`
- Modify: `src/features/editor/EditorPane.tsx`
- Modify: `src/styles/main-window.css`

**Interfaces:**
- `MarkdownSource` additionally consumes `assetReader?: ImageReadPort` and the existing `noteId`.
- Produces `DocumentImageWidget` with owned `relativePath`, `alt`, source range, generation identity, and typed select/edit intents.

- [ ] **Step 1: Write failing image-widget tests**

  With a real CodeMirror instance and a typed fake image reader, assert an owned image renders an `img` with the Markdown alt text, the source Markdown remains unchanged, and the raw path is not visible.

- [ ] **Step 2: Run the image test and confirm RED**

  Run: `pnpm test -- src/features/editor/MarkdownSource.test.tsx -t "renders an owned image"`

- [ ] **Step 3: Implement safe asynchronous image widgets**

  Read bytes only through `ImageReadPort.readImage({ noteId, relativePath })`, create a Blob URL, ignore stale/disconnected completions, revoke URLs on widget destruction, and never turn an arbitrary URL or path into an image.

- [ ] **Step 4: Write failing error and lifecycle tests**

  Assert a failed read shows “找不到图片” plus alt text, note switching ignores stale completion, and destroying/replacing a widget revokes its object URL.

- [ ] **Step 5: Implement fallback and lifecycle cleanup**

  Keep the fallback keyboard-selectable and preserve the original Markdown. Use the editor generation and DOM connection to reject stale work.

- [ ] **Step 6: Write and satisfy atomic selection/deletion tests**

  First Delete/Backspace selects the complete image range; the next deletes it through a normal transaction; undo restores it. Enter exposes an accessible source-edit action rather than directly mutating persistence.

- [ ] **Step 7: Run image and paste regressions**

  Run: `pnpm test -- src/features/editor/documentWidgets.test.ts src/features/editor/MarkdownSource.test.tsx src/features/editor/imagePaste.test.ts src/features/editor/internalLinks.test.ts`

---

### Task 5: Render and edit existing GFM tables

**Files:**
- Modify: `src/features/editor/markdownActions.ts`
- Modify: `src/features/editor/markdownActions.test.ts`
- Modify: `src/features/editor/documentWidgets.ts`
- Modify: `src/features/editor/documentWidgets.test.ts`
- Modify: `src/features/editor/MarkdownSource.tsx`
- Modify: `src/features/editor/MarkdownSource.test.tsx`
- Modify: `src/features/editor/TableEditorDialog.tsx`
- Modify: `src/features/editor/TableEditorDialog.test.tsx`
- Modify: `src/styles/main-window.css`

**Interfaces:**
- Produces `MarkdownTable { cells: string[][]; alignments: Array<'left' | 'center' | 'right' | null> }`.
- Produces `parseMarkdownTable(source: string): MarkdownTable | null`.
- Extends `tableMarkdownFromCells(cells, alignments?)` without breaking existing callers.
- `TableEditorDialog` consumes `initialCells?` and `initialAlignments?`.

- [ ] **Step 1: Write failing table parse/serialize tests**

  Use literal tables with escaped pipes, alignment markers, empty cells, and malformed separators. Assert exact cell and alignment values plus round-trip preservation.

- [ ] **Step 2: Run formatter tests and confirm RED**

  Run: `pnpm test -- src/features/editor/markdownActions.test.ts`

- [ ] **Step 3: Implement the bounded GFM table parser**

  Parse only a syntax-tree-confirmed table block. Preserve alignment metadata and escape cell pipes/backslashes when serializing.

- [ ] **Step 4: Write failing existing-table dialog tests**

  Assert current cells populate the dialog, editing a cell returns a complete replacement table, cancellation leaves Markdown untouched, and wide tables retain horizontal overflow.

- [ ] **Step 5: Extend the table dialog and pass its tests**

  Keep the existing insert-new-table behavior as the default. Existing-table mode receives parsed cells and returns one serialized Markdown string.

- [ ] **Step 6: Write a failing rendered-table integration test**

  Assert inactive GFM source becomes an accessible real table, raw pipe rows are not visible, activation opens the populated dialog, and save replaces only the table source range in one undoable transaction.

- [ ] **Step 7: Implement the atomic table widget and replacement flow**

  Provide cursor parking positions before and after the widget and preserve malformed tables as source.

- [ ] **Step 8: Run table and editor tests**

  Run: `pnpm test -- src/features/editor/markdownActions.test.ts src/features/editor/documentWidgets.test.ts src/features/editor/TableEditorDialog.test.tsx src/features/editor/MarkdownSource.test.tsx`

---

### Task 6: Keyboard commands, visual integration, performance, and acceptance

**Files:**
- Modify: `src/features/editor/markdownActions.ts`
- Modify: `src/features/editor/markdownActions.test.ts`
- Modify: `src/features/editor/MarkdownSource.tsx`
- Modify: `src/features/editor/MarkdownSource.test.tsx`
- Modify: `src/styles/main-window.css`
- Modify: `scripts/main-window-css.test.ts`
- Create: `src/features/editor/liveMarkdownShowcase.ts`

**Interfaces:**
- Produces one deterministic showcase Markdown string for visual QA and behavior fixtures.
- Preserves existing selection-toolbar commands while adding CodeMirror key bindings for bold, italic, and link.

- [ ] **Step 1: Write failing keyboard-command tests**

  Assert `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, and `Ctrl/Cmd+K` produce the same literal Markdown and selection positions as toolbar actions and respect read-only/barrier state.

- [ ] **Step 2: Implement the minimal keymap**

  Route key bindings through the same selection formatter and editor dispatch path; do not duplicate transformation logic.

- [ ] **Step 3: Write failing CSS and viewport contracts**

  Assert shared 780px alignment, formatted inline classes, image/error blocks, task controls, code blocks, horizontally scrolling tables, visible focus, narrow-window insets, dark-theme token use, and reduced-motion behavior. Add a long-document component test that observes decoration output only within viewports plus the active block.

- [ ] **Step 4: Implement the approved visual system and scoped decoration updates**

  Keep the existing palette and configured fonts. Use no copied assets, network fonts, gradients, glass effects, or large document cards.

- [ ] **Step 5: Run the complete focused editor verification**

  Run:

  ```powershell
  pnpm test -- src/features/editor/documentMarkdown.test.ts src/features/editor/documentWidgets.test.ts src/features/editor/markdownActions.test.ts src/features/editor/MarkdownSource.test.tsx src/features/editor/EditorPane.test.tsx src/features/editor/internalLinks.test.ts src/features/editor/imagePaste.test.ts src/features/editor/markdownPipeline.test.ts src/features/editor/TableEditorDialog.test.tsx scripts/main-window-css.test.ts
  ```

- [ ] **Step 6: Run static and build verification**

  Run:

  ```powershell
  pnpm typecheck
  pnpm build
  git diff --check
  ```

- [ ] **Step 7: Perform visual and interaction QA**

  Start the repository's supported E2E-mode Vite surface, open the deterministic showcase note, and capture wide, narrow, and dark-theme screenshots. Verify no supported punctuation leaks while inactive, local reveal works, owned and missing images are understandable, tables are real and usable, focus is visible, and console error count is zero.

- [ ] **Step 8: Review the final relevant diff**

  Confirm no storage migration, persisted setting change, second editor, unrelated refactor, generated local data, token, or absolute production path was introduced. Leave all work uncommitted as requested.
