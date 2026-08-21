# Cay (微屿) document-mode editor design

Date: 2026-08-21

Status: Proposed approved direction; awaiting written-spec review

## 1. Goal

Make everyday writing feel like editing a modern document instead of editing source code, while retaining Markdown and local assets as the only durable note content. Cay is not becoming an offline clone of Feishu: it remains a small, local-first note application with original warm visual language, real folders, exportable Markdown, and no collaboration or cloud requirements.

The default editor becomes **Document** mode. The existing source view and read-only preview remain available as secondary modes.

## 2. Product decisions

- The editor provides three modes for one Markdown document: Document, Source, and Preview.
- Document is the default for new notes and the recommended setting default.
- Source is an explicit advanced mode for viewing and editing persisted Markdown.
- Preview is read-only and confirms the rendered result without editing affordances.
- The old persistent source/preview split is removed from the primary toolbar. A later comparison view may be offered from more actions, but is not part of the first delivery.
- Document mode supports headings, paragraphs, ordered and unordered lists, task lists, block quotes, fenced code blocks, links, local images, tables, and horizontal rules.
- Existing and new notes continue to persist as standard Markdown with local asset references. No proprietary rich-text format is introduced.
- Unsupported or unsafe-to-round-trip source is preserved exactly. In Document mode it is represented by a clearly labelled raw Markdown block; users can edit it directly or open Source mode. It must never be silently removed or rewritten.
- Existing internal links retain their persisted visible-label-and-UUID form and atomic editing/deletion guarantees.

## 3. User experience

### 3.1 Document canvas

The editing surface is a centered, comfortable reading column rather than a permanent two-pane source/preview layout. It uses Cay's muted green, rounded, nature-inspired design system, not Feishu's branding or visual assets. It remains responsive inside the resizable application columns.

Hovering a document block reveals two quiet controls at its left edge: a plus control to insert a neighbouring block, and a drag handle to reorder blocks. The controls must not reserve space or distract while the user is typing. Keyboard focus exposes equivalent reachable actions.

### 3.2 Writing and insertion

Typing slash on an empty paragraph opens a small insertion menu with the supported first-release block types: paragraph, heading, ordered/bullet/task list, quote, code block with language selector, image, table, and divider.

Selecting text opens a compact inline toolbar for bold, italic, inline code, link insertion, and heading conversion. Markdown shortcuts remain supported where they are unambiguous.

### 3.3 Tables and images

Tables are embedded document blocks, not a separate plugin or a modal-only feature. They retain Cay's spreadsheet-like editor behaviours: cell selection, Excel-area paste, keyboard movement, row/column sizing, and horizontal/vertical scrolling. The document block adds light actions for inserting and removing rows or columns.

Pasted images remain validated local assets. In Document mode they are centered, responsive, and constrained to the text column by default. Users can open an image at its original size without changing the persisted asset.

### 3.4 Mode controls

The editor toolbar provides:
- **文档** for normal editing;
- **源码** for the CodeMirror Markdown source surface;
- **预览** for read-only rendered output.

The title remains at the left and mode controls remain local to the editor. Selection and scroll position are preserved when a meaningful equivalent exists; otherwise the closest document block or source offset is used.

## 4. Architecture and data flow

### 4.1 One durable representation

Markdown remains the source of truth. The app never stores a second rich-text document as the only copy of content. Document mode uses a typed intermediate document model produced from the existing Markdown parser and serialized by one Markdown serializer.

The model distinguishes recognised editable blocks, inline formatting/links, and raw-preservation blocks for content outside the supported round-trip grammar. Recognised blocks serialize deterministically; raw-preservation blocks write their captured source unchanged.

### 4.2 Editing boundary

React components render document blocks and dispatch typed editing intents. A document-mode domain service owns parsing, block updates, serialization, source-offset mapping, and unsupported-content preservation. It uses the existing autosave flow:

1. update the in-memory document state;
2. serialize Markdown;
3. atomically save Markdown and assets;
4. update SQLite indexes only after durable content succeeds.

Source mode continues to use CodeMirror. Switching from Source to Document parses unsaved source in memory and never requires a successful disk write first.

### 4.3 Safe fallbacks and errors

If parsing is incomplete, malformed, or cannot guarantee source preservation, the app creates raw-preservation blocks and surfaces a non-blocking notice. Save failures retain the last durable Markdown and use the existing actionable autosave error state. Unsafe HTML remains sanitized in Preview and must not execute in Document mode.

## 5. Delivery slices

### Slice 1: document foundation

- Introduce the typed document model and round-trip tests.
- Add Document, Source, and Preview mode state; set Document as the default.
- Render headings, paragraphs, basic inline formatting, lists, quotes, dividers, and raw-preservation blocks.
- Keep Source and Preview working.

### Slice 2: high-value structured blocks

- Add editable task lists, code blocks, links, and local images.
- Add slash insertion and the selection toolbar.
- Preserve internal-link decorations and UUID persistence rules.

### Slice 3: integrated tables and block movement

- Move the existing spreadsheet-like table editor into an inline document block.
- Support Excel paste, cell range selection, keyboard navigation, and accessible scrolling.
- Add block insertion, reorder, and focus behaviour.

### Slice 4: polish and migration verification

- Migrate the setting default to Document without changing an explicit user choice.
- Add scroll/selection preservation, keyboard operation, reduced-motion, and screen-reader checks.
- Run representative old Markdown fixtures through parse, edit, save, reopen, export, rebuild-index, and trash/restore flows.

## 6. Acceptance criteria

- A new note opens in Document mode, with no permanent split panel.
- Users can create and edit every supported block without writing Markdown syntax.
- Source mode exposes the exact durable Markdown used for saving and export.
- Existing notes with recognised Markdown open as editable blocks.
- Unsupported content persists byte-for-byte through a Document-mode edit of other blocks.
- Markdown and assets remain accessible when the application is not running.
- Internal links, autosave barriers, image-paste safety, search indexing, export, deletion, trash restore, and temporary-note conversion remain compatible.
- No collaboration, online account, plugins, comments, database-style notes, or new state/editor framework is added.

## 7. Verification

- Unit tests cover parsing and deterministic serialization for every supported block plus raw-preservation behaviour.
- Property-style fixtures prove unsupported source remains unchanged after unrelated edits.
- Editor tests cover mode switching, selections, scroll mapping, slash insertion, inline formatting, link atomicity, images, tables, keyboard navigation, and block reorder.
- Integration tests cover atomic-save failures, reopen, export, index rebuild, trash/restore, and temporary-to-formal conversion after Document-mode edits.
- Windows and macOS smoke tests verify document mode, source mode, preview, paste, focus, and keyboard operation.

