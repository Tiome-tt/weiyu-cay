# Document Mode Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a default direct document-editing mode to Cay while keeping Markdown and local assets as the durable note format.

**Architecture:** A typed document model parses Markdown into recognised editable blocks and raw-preservation blocks, then serializes only through deterministic Markdown. React renders that model through a focused DocumentEditor; EditorPane continues to own autosave, persistence barriers, title, links, Source, and Preview. Existing CodeMirror remains the advanced source editor and no new editor or state-management framework is added.

**Tech Stack:** React 19, TypeScript strict mode, Unified/remark-parse/remark-gfm, CodeMirror 6, Vitest, Testing Library, existing Tauri asset ports.

**Spec:** docs/superpowers/specs/2026-08-21-document-mode-design.md

## Global Constraints

- Use 微屿 for Chinese UI copy; preserve technical compatibility identifiers.
- Markdown and local assets remain the only durable note content; SQLite remains rebuildable metadata/index state.
- Do not add a second editor framework, a second state framework, cloud features, collaboration, plugins, comments, or database-style notes.
- Unsupported Markdown must be preserved exactly; document editing must never silently discard source.
- React dispatches domain actions but does not access filesystem, SQLite, or unrestricted Tauri APIs directly.
- Preserve atomic saves, autosave barriers, UUIDv7 links, safe image handling, trash/recovery, export, and index rebuild invariants.
- Use test-first development, focused tests first, and one focused commit per task.

---

## File structure

- Create: src/features/editor/documentModel.ts — typed block model, Markdown parse/serialize, raw-source preservation, source ranges.
- Create: src/features/editor/documentModel.test.ts — round-trip and preservation contract tests.
- Create: src/features/editor/documentCommands.ts — pure commands for slash insertion, inline formatting, and block movement.
- Create: src/features/editor/documentCommands.test.ts — command transformation tests.
- Create: src/features/editor/DocumentBlock.tsx — focused renderer/editor for one typed block.
- Create: src/features/editor/DocumentEditor.tsx — document-mode state projection and editing event boundary.
- Create: src/features/editor/DocumentEditor.test.tsx — interaction, keyboard, menu, formatting, and accessibility tests.
- Create: src/features/editor/TableGrid.tsx — reusable spreadsheet-like editable table grid.
- Create: src/features/editor/TableGrid.test.tsx — range selection, paste, keyboard, scrolling, and row/column tests.
- Modify: src/domain/model.ts — replace split editor mode with document.
- Modify: src/features/editor/EditorPane.tsx and EditorPane.test.tsx — host DocumentEditor and preserve source/preview/autosave behaviour.
- Modify: src/features/editor/markdownPipeline.ts and markdownPipeline.test.ts — export safe AST helper without changing preview sanitization.
- Modify: src/features/editor/imagePaste.ts, imagePaste.test.ts, and MarkdownSource.tsx — share safe pasted-image handling.
- Modify: src/features/editor/TableEditorDialog.tsx and TableEditorDialog.test.tsx — compose TableGrid instead of maintaining a second grid.
- Modify: src/features/settings/SettingsView.tsx, SettingsView.test.tsx, theme.test.ts, and app settings fixtures — default to 文档 and migrate old split values.
- Modify: src/styles/app.css and tokens.css — canvas, hover controls, menus, table selection, focus, and reduced-motion styles.

## Shared interfaces

~~~ts
export type DocumentBlock =
  | { id: string; type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; source: MarkdownRange }
  | { id: string; type: 'paragraph'; text: string; source: MarkdownRange }
  | { id: string; type: 'list'; ordered: boolean; task: boolean; items: DocumentListItem[]; source: MarkdownRange }
  | { id: string; type: 'quote'; text: string; source: MarkdownRange }
  | { id: string; type: 'code'; language: string | null; value: string; source: MarkdownRange }
  | { id: string; type: 'image'; alt: string; url: string; source: MarkdownRange }
  | { id: string; type: 'table'; cells: string[][]; source: MarkdownRange }
  | { id: string; type: 'divider'; source: MarkdownRange }
  | { id: string; type: 'raw'; markdown: string; reason: 'unsupported' | 'unsafe' | 'malformed'; source: MarkdownRange }

export interface MarkdownRange { from: number; to: number }
export interface DocumentListItem { text: string; checked: boolean | null }
export interface DocumentModel { blocks: DocumentBlock[] }

export function parseDocumentMarkdown(markdown: string): DocumentModel
export function serializeDocumentMarkdown(model: DocumentModel): string
~~~

~~~ts
export interface DocumentEditorHandle {
  beginEditBarrier(): Promise<void>
  endEditBarrier(): void
  focusBlock(blockId: string): void
}

export interface DocumentEditorProps {
  markdown: string
  noteId: NoteId
  assets?: AssetPort
  links?: LinkPort
  linkCache?: ReadonlyMap<NoteId, NoteSummary>
  readOnly?: boolean
  onChange(markdown: string): void
  onImageError?(message: string): void
  onNavigateLink?(noteId: NoteId): void
}
~~~

### Task 1: Build a lossless document model

**Files:**
- Create: src/features/editor/documentModel.ts
- Create: src/features/editor/documentModel.test.ts
- Modify: src/features/editor/markdownPipeline.ts
- Modify: src/features/editor/markdownPipeline.test.ts

**Consumes:** Unified parser and GFM support in markdownPipeline.ts.

**Produces:** DocumentModel, parseDocumentMarkdown, and serializeDocumentMarkdown.

- [ ] **Step 1: Write a failing parser/serializer test.**

~~~ts
it('round-trips supported blocks to deterministic Markdown', () => {
  const model = parseDocumentMarkdown('# Goal\n\n- [x] Done\n\n> Quote')
  expect(model.blocks.map((block) => block.type)).toEqual(['heading', 'list', 'quote'])
  expect(serializeDocumentMarkdown(model)).toBe('# Goal\n\n- [x] Done\n\n> Quote')
})
~~~

- [ ] **Step 2: Run the test and verify it fails.**

Run: pnpm test -- src/features/editor/documentModel.test.ts
Expected: FAIL with module-not-found.

- [ ] **Step 3: Expose an AST helper without changing preview sanitization.**

~~~ts
export interface MarkdownAstNode {
  type?: unknown
  value?: unknown
  children?: unknown
  position?: { start?: { offset?: unknown }; end?: { offset?: unknown } }
}

export function parseMarkdownAst(markdown: string): MarkdownAstNode {
  return parser.parse(markdown) as MarkdownAstNode
}
~~~

- [ ] **Step 4: Implement recognised block parsing and raw preservation.**

Use AST source offsets. Emit a raw block containing the exact source slice for HTML, definitions, malformed positions, nested unsupported content, and unrecognised nodes. Block IDs are derived only from range and ordinal; never persist them.

~~~ts
const rawBlock = (markdown: string, source: MarkdownRange, reason: DocumentRawBlock['reason'], ordinal: number): DocumentRawBlock => ({
  id: 'raw:' + source.from + ':' + source.to + ':' + ordinal,
  type: 'raw',
  markdown: markdown.slice(source.from, source.to),
  reason,
  source,
})
~~~

- [ ] **Step 5: Add losslessness fixtures.**

~~~ts
it('preserves unsupported source after an unrelated paragraph edit', () => {
  const source = 'Before\n\n<div onclick="bad()">custom</div>\n\nAfter'
  const model = parseDocumentMarkdown(source)
  model.blocks[0] = { ...model.blocks[0]!, text: 'Changed' }
  expect(serializeDocumentMarkdown(model)).toContain('<div onclick="bad()">custom</div>')
})
~~~

Include raw HTML, definitions, malformed GFM table rows, and internal-link labels with escaped punctuation.

- [ ] **Step 6: Run focused parser tests.**

Run: pnpm test -- src/features/editor/documentModel.test.ts src/features/editor/markdownPipeline.test.ts src/features/editor/internalLinks.test.ts
Expected: PASS.

- [ ] **Step 7: Commit.**

~~~bash
git add src/features/editor/documentModel.ts src/features/editor/documentModel.test.ts src/features/editor/markdownPipeline.ts src/features/editor/markdownPipeline.test.ts
git commit -m "feat: add lossless document model"
~~~

### Task 2: Add pure document editing commands

**Files:**
- Create: src/features/editor/documentCommands.ts
- Create: src/features/editor/documentCommands.test.ts

**Consumes:** DocumentBlock and DocumentModel from Task 1.

**Produces:** insertBlockAfter, moveBlock, replaceBlockText, formatInlineSelection, and insertSlashBlock.

- [ ] **Step 1: Write failing command tests.**

~~~ts
it('moves an editable block without moving raw-source content', () => {
  const result = moveBlock(model, 'paragraph:0:4:0', 'after', 'heading:6:12:1')
  expect(result.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'raw'])
})

it('wraps a selected range with strong syntax only once', () => {
  expect(formatInlineSelection('hello', { from: 1, to: 4 }, 'strong')).toBe('h**ell**o')
})
~~~

- [ ] **Step 2: Run the tests and verify they fail.**

Run: pnpm test -- src/features/editor/documentCommands.test.ts
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement immutable transforms.**

~~~ts
export function moveBlock(model: DocumentModel, movingId: string, placement: 'before' | 'after', targetId: string): DocumentModel {
  const moving = model.blocks.find((block) => block.id === movingId)
  if (moving === undefined || moving.type === 'raw' || movingId === targetId) return model
  const remaining = model.blocks.filter((block) => block.id !== movingId)
  const target = remaining.findIndex((block) => block.id === targetId)
  if (target < 0) return model
  const index = placement === 'before' ? target : target + 1
  return { blocks: [...remaining.slice(0, index), moving, ...remaining.slice(index)] }
}
~~~

- [ ] **Step 4: Add slash insertion and inline formatting commands.**

Support paragraph, heading, bullet list, ordered list, task list, quote, code, image placeholder, table, and divider. Keep transforms pure and preserve raw blocks.

- [ ] **Step 5: Run focused tests.**

Run: pnpm test -- src/features/editor/documentCommands.test.ts src/features/editor/documentModel.test.ts
Expected: PASS.

- [ ] **Step 6: Commit.**

~~~bash
git add src/features/editor/documentCommands.ts src/features/editor/documentCommands.test.ts
git commit -m "feat: add document editing commands"
~~~

### Task 3: Render the document canvas and make it the default

**Files:**
- Create: src/features/editor/DocumentBlock.tsx
- Create: src/features/editor/DocumentEditor.tsx
- Create: src/features/editor/DocumentEditor.test.tsx
- Modify: src/domain/model.ts
- Modify: src/features/editor/EditorPane.tsx
- Modify: src/features/editor/EditorPane.test.tsx
- Modify: src/features/settings/SettingsView.tsx
- Modify: src/features/settings/SettingsView.test.tsx
- Modify: src/features/settings/theme.test.ts
- Modify: src/app/App.test.tsx

**Consumes:** Tasks 1–2 plus existing useAutosave, MarkdownSource, MarkdownPreview, and settings port.

**Produces:** default Document mode; Source and Preview remain working.

- [ ] **Step 1: Write failing mode tests.**

~~~tsx
it('starts in document mode and retains Source and Preview as secondary modes', () => {
  render(<EditorPane document={note('# Goal')} notes={fakeNotePort()} />)
  expect(screen.getByRole('textbox', { name: '文档内容' })).toBeVisible()
  expect(screen.getByRole('button', { name: '源码视图' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '分栏视图' })).not.toBeInTheDocument()
})
~~~

- [ ] **Step 2: Run the editor test and verify it fails.**

Run: pnpm test -- src/features/editor/EditorPane.test.tsx
Expected: FAIL because document is not an EditorMode.

- [ ] **Step 3: Migrate mode and settings contracts.**

~~~ts
export type EditorMode = 'document' | 'source' | 'preview'
~~~

Map persisted split to document at settings load. Offer 文档、Markdown 源码、预览 in SettingsView. Do not overwrite an explicit Source or Preview choice.

- [ ] **Step 4: Implement DocumentEditor and DocumentBlock.**

DocumentEditor parses markdown, applies pure commands, serializes changes, and calls onChange. It provides a semantic region labelled 文档内容. DocumentBlock uses accessible editable controls for recognised blocks and a labelled source textarea for raw blocks. It exposes quiet focus/hover block actions without reserved layout space.

- [ ] **Step 5: Replace persistent split rendering in EditorPane.**

Render DocumentEditor for document, MarkdownSource for source, and MarkdownPreview for preview. Remove split divider, split percent, and scroll-sync state. Preserve EditorPaneHandle flush, barriers, title rename, tags, links, move-note, save status, backlinks, image errors, and document adoption. Send barriers to both source and document handles.

- [ ] **Step 6: Add regressions for Source and Preview.**

Test Document → Source → Preview → Document with unsaved edits, read-only barrier behaviour, preview navigation, and settings migration.

- [ ] **Step 7: Run focused UI tests and type-check.**

Run: pnpm test -- src/features/editor/DocumentEditor.test.tsx src/features/editor/EditorPane.test.tsx src/features/settings/SettingsView.test.tsx src/app/App.test.tsx
Expected: PASS.

Run: pnpm typecheck
Expected: PASS.

- [ ] **Step 8: Commit.**

~~~bash
git add src/domain/model.ts src/features/editor/DocumentBlock.tsx src/features/editor/DocumentEditor.tsx src/features/editor/DocumentEditor.test.tsx src/features/editor/EditorPane.tsx src/features/editor/EditorPane.test.tsx src/features/settings/SettingsView.tsx src/features/settings/SettingsView.test.tsx src/features/settings/theme.test.ts src/app/App.test.tsx
git commit -m "feat: add document editor mode"
~~~

### Task 4: Add insertion, formatting, links, images, and code blocks

**Files:**
- Modify: src/features/editor/DocumentEditor.tsx
- Modify: src/features/editor/DocumentBlock.tsx
- Modify: src/features/editor/DocumentEditor.test.tsx
- Modify: src/features/editor/imagePaste.ts
- Modify: src/features/editor/imagePaste.test.ts
- Modify: src/features/editor/MarkdownSource.tsx
- Modify: src/styles/app.css

**Consumes:** Task 3 mode, AssetPort, ImageReadPort, LinkPort, and document commands.

**Produces:** slash insertion, selection formatting, safe image insertion, code-language controls, and stable-link navigation in Document mode.

- [ ] **Step 1: Write failing user tests.**

~~~tsx
it('inserts a task list from slash menu and saves Markdown', async () => {
  render(<DocumentEditor markdown="" noteId={noteId} onChange={onChange} />)
  await userEvent.type(screen.getByRole('textbox', { name: '文档内容' }), '/待办{Enter}')
  expect(onChange).toHaveBeenLastCalledWith('- [ ] 待办事项')
})
~~~

- [ ] **Step 2: Run the tests and verify they fail.**

Run: pnpm test -- src/features/editor/DocumentEditor.test.tsx src/features/editor/imagePaste.test.ts
Expected: FAIL because document insertion/paste is absent.

- [ ] **Step 3: Extract shared safe image paste.**

~~~ts
export async function savePastedImage(
  clipboard: DataTransfer,
  noteId: NoteId,
  assets: AssetPort,
): Promise<{ markdown: string } | null>
~~~

Move existing validation and asset save work into this helper. MarkdownSource and DocumentEditor both call it; retain name sanitization, file-type validation, collision-resistant naming, and user-safe errors.

- [ ] **Step 4: Implement accessible slash and selection menus.**

Open slash menu only for an empty paragraph. Close it on Escape, selection, or command choice. Use labelled buttons with Arrow/Enter operation. Do not let inline formatting modify raw blocks.

- [ ] **Step 5: Implement code, links, and images.**

Code blocks expose a language select and preserve code content. Internal links use existing LinkPort grammar; never manually construct UUID text. Image paste inserts an owned asset reference, previews through ImageReadPort, centres/constrains the image, and opens the original only through the existing safe external port.

- [ ] **Step 6: Run focused regressions.**

Run: pnpm test -- src/features/editor/DocumentEditor.test.tsx src/features/editor/imagePaste.test.ts src/features/editor/MarkdownSource.test.tsx src/features/editor/internalLinks.test.ts
Expected: PASS.

- [ ] **Step 7: Commit.**

~~~bash
git add src/features/editor/DocumentEditor.tsx src/features/editor/DocumentBlock.tsx src/features/editor/DocumentEditor.test.tsx src/features/editor/imagePaste.ts src/features/editor/imagePaste.test.ts src/features/editor/MarkdownSource.tsx src/styles/app.css
git commit -m "feat: add document insertion actions"
~~~

### Task 5: Integrate the spreadsheet-like table block

**Files:**
- Create: src/features/editor/TableGrid.tsx
- Create: src/features/editor/TableGrid.test.tsx
- Modify: src/features/editor/TableEditorDialog.tsx
- Modify: src/features/editor/TableEditorDialog.test.tsx
- Modify: src/features/editor/DocumentBlock.tsx
- Modify: src/features/editor/DocumentEditor.test.tsx
- Modify: src/styles/app.css

**Consumes:** existing TableEditorDialog selection/history behaviour, model table blocks, and tableMarkdownFromCells.

**Produces:** one shared editable grid for inline document tables and the existing insertion dialog.

- [ ] **Step 1: Write failing TableGrid tests.**

~~~tsx
it('selects a rectangular cell range and exposes its full selection outline', async () => {
  render(<TableGrid cells={[['A', 'B'], ['C', 'D']]} onChange={onChange} />)
  await userEvent.pointer([{ target: cell(0, 0), keys: '[MouseLeft>]' }, { target: cell(1, 1) }, { keys: '[/MouseLeft]' }])
  expect(screen.getByTestId('table-selection-outline')).toHaveAttribute('data-range', '0:0-1:1')
})
~~~

- [ ] **Step 2: Run TableGrid tests and verify they fail.**

Run: pnpm test -- src/features/editor/TableGrid.test.tsx
Expected: FAIL with module-not-found.

- [ ] **Step 3: Extract TableGrid from the dialog.**

Preserve mouse-drag rectangular selection, full-range selection outline with white active cell, Ctrl/Cmd+Z local undo, Excel tab/newline paste, Arrow navigation, left/right edit-text and edge escape, horizontal/vertical scrolling, dimension inputs, and dynamic grid width. Do not use native HTML drag-and-drop for range selection.

- [ ] **Step 4: Compose TableGrid in both hosts.**

TableEditorDialog keeps dimension/data entry but delegates the grid. DocumentBlock renders the same grid inline and serializes cells with tableMarkdownFromCells. It shows row/column actions only on focus/hover and uses raw fallback for non-rectangular tables.

- [ ] **Step 5: Add inline-table serialization coverage.**

~~~tsx
it('edits an inline table and emits standard GFM Markdown', async () => {
  render(<DocumentEditor markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} noteId={noteId} onChange={onChange} />)
  await userEvent.type(screen.getByRole('textbox', { name: '2 行 2 列' }), '3')
  expect(onChange).toHaveBeenLastCalledWith('| A | B |\n| --- | --- |\n| 1 | 3 |')
})
~~~

- [ ] **Step 6: Run focused table tests.**

Run: pnpm test -- src/features/editor/TableGrid.test.tsx src/features/editor/TableEditorDialog.test.tsx src/features/editor/DocumentEditor.test.tsx src/features/editor/markdownActions.test.ts
Expected: PASS.

- [ ] **Step 7: Commit.**

~~~bash
git add src/features/editor/TableGrid.tsx src/features/editor/TableGrid.test.tsx src/features/editor/TableEditorDialog.tsx src/features/editor/TableEditorDialog.test.tsx src/features/editor/DocumentBlock.tsx src/features/editor/DocumentEditor.test.tsx src/styles/app.css
git commit -m "feat: add inline document tables"
~~~

### Task 6: Polish and verify durable behaviour

**Files:**
- Modify: src/features/editor/EditorPane.test.tsx
- Modify: src/features/editor/DocumentEditor.test.tsx
- Modify: src/app/App.test.tsx
- Modify: src/styles/app.css
- Modify: src/styles/tokens.css

**Consumes:** all previous tasks and current autosave, export, index, trash, temporary-note, and accessibility tests.

**Produces:** release-ready document mode without durable-data regressions.

- [ ] **Step 1: Write high-risk preservation regression tests.**

~~~tsx
it('keeps a raw unsupported block unchanged after document edit, save, reopen, and preview', async () => {
  const source = 'Before\n\n<custom value="x" />\n\nAfter'
  // edit Before, reload the note, and assert the exact custom source remains
})
~~~

Also mirror the existing native-close barrier test with document mode active.

- [ ] **Step 2: Run the regression test and verify it fails until the integration gap is fixed.**

Run: pnpm test -- src/features/editor/EditorPane.test.tsx src/app/App.test.tsx
Expected: FAIL only for the new document-mode expectations.

- [ ] **Step 3: Add visual and accessibility polish.**

Use existing design tokens for reading width, hover controls, visible focus, code contrast, quiet table selection, responsive images, and reduced-motion-safe menus. Verify mode controls and the canvas do not clip at current minimum column widths.

- [ ] **Step 4: Run targeted UI and storage regression tests.**

Run: pnpm test -- src/features/editor/ src/features/library/TrashView.test.tsx src/features/temporary/TemporaryInbox.test.tsx src/app/App.test.tsx
Expected: PASS.

Run: pnpm typecheck
Expected: PASS.

Run: pnpm lint
Expected: PASS.

- [ ] **Step 5: Build and perform platform smoke checks.**

Run: pnpm build
Expected: PASS.

Run: pnpm tauri dev on Windows. Verify document/source/preview switching, image paste, table paste, save barrier, folder navigation, trash restore, and temporary capture.

Before release, repeat that smoke pass on macOS and record any platform-specific focus or clipboard difference in the release checklist.

- [ ] **Step 6: Commit.**

~~~bash
git add src/features/editor/EditorPane.test.tsx src/features/editor/DocumentEditor.test.tsx src/app/App.test.tsx src/styles/app.css src/styles/tokens.css
git commit -m "feat: polish document editor mode"
~~~
