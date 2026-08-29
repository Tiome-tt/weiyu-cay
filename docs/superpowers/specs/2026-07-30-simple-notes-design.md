# Cay (微屿) product and architecture design

Date: 2026-07-30
Status: Approved design, awaiting written-spec review

## 1. Product intent

Cay (微屿) is a small, approachable desktop note application for computer developers. It prioritizes fast Markdown capture, clear organization, durable local storage, and links between notes. It is not intended to become an all-in-one workspace.

The first supported platforms are Windows and macOS. Linux is not an MVP target, although platform-specific code must remain isolated so Linux support is not unnecessarily blocked.

The application is local-first:

- Users can create, edit, organize, search, export, and recover notes without registering or connecting to the internet.
- An account is not part of the MVP. A future account is optional and exists only to enable synchronization.
- Application failure or service shutdown must not make local notes inaccessible.

## 2. Design principles

1. **Fast capture:** a global shortcut creates a new temporary sticky note immediately.
2. **Clear organization:** a real-folder-style hierarchy is the primary navigation model; tags supplement rather than replace folders.
3. **Readable Markdown:** source, split, and preview views are first-class and share one document state.
4. **Stable connections:** note links survive title, folder, and storage-path changes.
5. **Data ownership:** Markdown and images are durable local artifacts and can be exported as a complete portable library.
6. **Small scope:** features that do not strengthen capture, organization, reading, or recovery stay outside the MVP.
7. **Original visual identity:** use a warm, rounded, nature-inspired visual language without copying Nintendo assets or relying on non-commercial UI components.

## 3. Confirmed technology

### 3.1 Application stack

- Tauri 2 desktop shell.
- React and TypeScript UI built with Vite.
- CodeMirror 6 Markdown source editor.
- A single Markdown parser and renderer shared by preview, indexing, and export validation.
- Rust-backed Tauri commands for privileged filesystem, SQLite, window, shortcut, autostart, export, and updater operations.
- SQLite for metadata and rebuildable indexes.
- Markdown files and image assets for durable content.
- `pnpm` for JavaScript package management.

Tauri is preferred over Electron because this application values a small install and runtime footprint. It is preferred over Flutter because the web editor ecosystem is better suited to a developer-focused Markdown source editor. Rust is limited to privileged and performance-sensitive infrastructure; ordinary UI and product logic remain in TypeScript.

### 3.2 Editor model

The MVP provides a live Markdown document editor, not a separate rich-text document model. CodeMirror 6 remains the only editor and Markdown remains the only durable note body. Supported syntax is rendered in place when inactive and reveals the smallest necessary source range when the selection enters it.

The three representations of the same Markdown source are:

1. Live Markdown document editing, persisted as `source`.
2. Complete Markdown source and rendered preview in a resizable split, persisted as `split`.
3. Rendered preview, persisted as `preview`.

Incomplete, malformed, unsupported, raw-HTML, or unsafe constructs remain visible source and are never silently rewritten. Switching views preserves the current note, selection where applicable, and scroll position. The split view synchronizes scrolling where a stable source-to-preview mapping exists and degrades gracefully when an exact mapping is unavailable. Detailed document-editor behavior is defined in `docs/superpowers/specs/2026-08-24-document-editor-redesign-design.md`.

## 4. MVP scope

### 4.1 Formal notes

- Create, rename, move, edit, and delete notes.
- Organize notes in a nested, real-folder-style tree managed by the application.
- Use source, split, and preview views.
- Automatically save content and recover from interrupted writes.
- Paste screenshots directly into a note; the application saves the image and inserts a Markdown reference.
- Assign multiple custom tags to one note.
- Search a `#query` against tag names. Search a query without `#` against title and body.
- Insert and follow internal links displayed as `[[Note title]]`.
- Show backlinks for the open note.
- Visually identify links whose target has been deleted or cannot be resolved.
- Export the complete note library with its logical folder structure, Markdown, and images.

### 4.2 Temporary sticky notes

- Each invocation of the global shortcut creates a new temporary note window.
- Multiple temporary note windows can be open at the same time.
- A window can move, resize, and remain always on top.
- Closing a window hides it and retains the temporary note.
- Content is saved automatically into the temporary inbox.
- The sticky window contains capture controls only. It does not expose search, delete, or convert-to-note actions.
- All sticky notes share one color determined by the application theme. Per-note color selection is excluded.

### 4.3 Temporary inbox

- View and edit all temporary captures in the main application.
- Select one or multiple captures.
- Delete selected captures with an immediate undo opportunity and recoverable trash.
- Convert selected captures into formal notes.
- Batch conversion asks for one target logical folder and creates one formal note per selected capture.
- The default generated title is the first non-empty line, normalized and length-limited. If no non-empty line exists, use a localized “Untitled note” plus a timestamp.
- On successful conversion, move Markdown and its assets into formal-note storage and remove the item from the temporary inbox.

### 4.4 Settings

- Application theme and sticky-note color following that theme.
- Body font, code font, font size, and line height.
- Customizable global shortcut with conflict feedback.
- Launch at system startup.
- Default editor view.
- Autosave timing within supported safe limits.
- Application data location and storage use.
- Export complete library.
- Reset settings to defaults.

### 4.5 Explicit non-goals

The MVP does not include required login, cloud synchronization, mobile applications, collaboration, public sharing, AI writing, a plugin system, Git integration, OCR, web clipping, drawing, or database-style notes.

## 5. Information architecture and UI

### 5.1 Main window

The main window uses three columns:

1. Logical folder tree and the temporary inbox.
2. Notes in the selected folder.
3. Editor and preview area.

The boundaries between columns are directly draggable. There is no visible “drag to resize” instruction in the application. On hover, the cursor changes and the boundary highlights subtly. Each column has a minimum width. Double-clicking a boundary restores the default proportion. The application persists proportions and collapsed states.

The global application bar is reserved for application-level actions such as search, new note, future synchronization status, and settings.

The editor has a slim title toolbar. It contains the note title on the left and source, split, preview, and more-actions controls on the right. View controls do not live in the global application bar because they affect only the current note.

### 5.2 Visual direction

The interface uses warm neutrals, muted greens, gentle rounded corners, restrained shadows, and subtle motion. Decorative styling must not reduce code-block clarity, text contrast, focus visibility, or information density.

The `animal-island-ui` project may be used only as visual inspiration. Its CC BY-NC 4.0 license prohibits commercial use, so the application must not directly reuse its package, artwork, or protected assets. The project will define original color, spacing, radius, shadow, typography, and motion tokens.

Accessibility requirements include keyboard navigation, visible focus, reduced-motion support, sufficient contrast, semantic controls, and screen-reader labels for icon-only buttons.

### 5.3 Sticky windows

Sticky windows are intentionally minimal:

- A small title bar supports drag, pin/always-on-top state, a compact more menu, and close.
- The more menu may contain theme-derived appearance status and always-on-top behavior, but no conversion or deletion.
- The body is a Markdown capture surface with an unobtrusive saved/error status.
- Each window persists its own position and dimensions.
- All windows use the same active theme color.

## 6. Note identity and internal links

Each formal or temporary note receives a UUIDv7 at creation. It never changes. UUIDv7 is stored as a 16-byte value in SQLite with a unique index and rendered as a canonical string in Markdown metadata.

SQLite may use its integer `rowid` for efficient local joins, but `rowid` is not a durable or synchronized identity. All external and future cross-device references use UUIDv7.

The persisted internal-link syntax is:

```md
[[Visible note title|019c0000-0000-7000-8000-000000000000]]
```

Within the persisted visible label, the reserved characters `\`, `|`, `[`, and `]` are escaped as `\\`, `\|`, `\[`, and `\]`. Parsing decodes these escapes for display, serialization and rename repair add them, unknown or incomplete escapes are malformed, and links using the original syntax without reserved characters remain compatible.

CodeMirror renders the entire syntax as an atomic decorated node displaying only:

```md
[[Visible note title]]
```

The first Backspace/Delete action selects the entire link. A second action deletes it. Partial editing inside the decorated link is not allowed. A dedicated link command changes the target or label.

On note rename, the target UUID remains unchanged. The application updates visible labels in referring notes through `LinkService`. If an update is interrupted, UUID resolution remains valid and a background repair can refresh stale labels.

Link lookup order is:

1. Process-local `noteId -> title and storage location` cache.
2. Indexed SQLite lookup.
3. Unresolved-link state if neither contains the ID.

Content hashes are not note identities because content changes on every edit. Hashes may be used for image deduplication, change detection, or future synchronization checks.

## 7. Tags and search

Tags are many-to-many metadata. A note can have zero or more custom tags. Tag names are trimmed and normalized for comparison while preserving a display form. Duplicate normalized tags on one note are rejected.

Search interpretation is explicit:

- A query beginning with `#` searches tag names by the remaining keyword or characters.
- A query without `#` searches note titles and plain-text note content.
- Results display title, folder breadcrumb, matching tags, and a short highlighted excerpt.

SQLite FTS5 provides the primary body index. Chinese and arbitrary substring behavior must be validated with the chosen tokenizer. The planned implementation uses a trigram-capable index for queries of three or more characters and an escaped indexed/fallback search for shorter queries. A performance fixture of at least 10,000 notes guards changes to this strategy.

## 8. Local storage

The application manages its own data root. Users are not expected to edit files through VS Code, Obsidian, or a file manager, and external filesystem watching is outside the MVP.

Physical storage favors stable UUID locations, while the UI exposes a logical folder hierarchy. Export reconstructs that logical hierarchy into human-readable directories.

```text
app-data/
├── notes/
│   └── <note-uuid>/
│       ├── note.md
│       └── assets/
├── temporary/
│   └── <temporary-uuid>/
│       ├── note.md
│       └── assets/
├── trash/
├── folders.json
├── index.sqlite
└── settings.json
```

A formal note contains frontmatter sufficient to rebuild identity and important metadata:

```md
---
id: 019c0000-0000-7000-8000-000000000000
title: Login flow
folderId: 019c0000-0000-7000-8000-000000000001
tags:
  - backend
  - important
createdAt: 2026-07-30T15:30:00+08:00
updatedAt: 2026-07-30T16:10:00+08:00
---

## Goal

This references [[Authentication|019c0000-0000-7000-8000-000000000002]].
```

Folder IDs and folder records are persisted in SQLite and in a small rebuild manifest under the data root so a database rebuild retains logical organization. A complete export materializes ordinary nested directories and removes application-only folder IDs where safe.

Pasted screenshots use validated image formats and collision-resistant filenames. Assets are stored beside the owning note. Temporary-note assets move with the note during conversion.

## 9. SQLite model

The initial logical schema includes:

- `notes`: UUID, local row ID, type, title, folder ID, physical location, timestamps, deletion state, and content revision.
- `folders`: UUID, parent folder UUID, name, sort order, and timestamps.
- `tags`: UUID, display name, normalized name, and uniqueness constraint.
- `note_tags`: note UUID and tag UUID.
- `note_links`: source note UUID, target note UUID, visible label, and source location metadata needed for repair.
- `temporary_windows`: temporary-note UUID, visibility, position, dimensions, and always-on-top state.
- `search_documents`: rebuildable title and plain-text content for FTS/fallback search.
- `schema_migrations`: applied storage migrations.

Referential rules must not cascade-delete durable content unexpectedly. File movement and database updates are coordinated by domain services with explicit recovery states rather than hidden database cascades.

## 10. Save and conversion flows

### 10.1 Durable save

1. User input immediately updates the in-memory editor state.
2. A short debounce schedules persistence; focus loss and orderly shutdown request an immediate flush.
3. Rust writes a sibling temporary file in the same directory.
4. The file is flushed and, where supported, the parent directory is synchronized.
5. The previous file is atomically replaced only after the new content is complete.
6. After durable content succeeds, a SQLite transaction updates metadata, tags, links, and search content.
7. The UI reports saved, saving, or a persistent actionable error state.

If step 6 fails, the Markdown remains the source of truth and the item is marked for reindexing. If content writing fails, SQLite must not claim the new revision was saved.

### 10.2 Batch temporary-note conversion

1. The user selects temporary notes in the main application's temporary inbox.
2. The user chooses one target logical folder.
3. The service derives and validates one title per capture.
4. Each capture is converted independently into one formal note while retaining its immutable UUID.
5. Markdown and assets move to formal storage.
6. SQLite updates note type, folder, location, links, tags, and search index in one transaction per converted item.
7. Successfully converted items disappear from the inbox. Failed items remain temporary and show a per-item error.

A batch is allowed to report partial success; it must never silently lose failed items. The result explicitly lists successes and failures.

## 11. Deletion, recovery, and failures

- Closing a sticky window changes only window visibility.
- User deletion moves formal or temporary content into application trash instead of erasing it immediately.
- Trash retains items for 30 days by default before eligible cleanup.
- Trash metadata retains the previous logical folder and physical location needed for restoration.
- A recent deletion exposes an immediate undo action.
- Restore returns an item to its previous logical folder when possible, otherwise to a safe recovered folder.
- Disk-full, permission, path-validation, parsing, database, migration, and shortcut-conflict errors receive user-readable messages and retain technical causes in local diagnostics.
- If SQLite is unreadable, the application protects files, offers index rebuild, and does not overwrite content as a side effect of recovery.
- Startup detects abandoned temporary save files and resolves them using revision and validity checks rather than blindly choosing the newest timestamp.
- Unsupported Markdown is preserved as source text even if preview rendering is incomplete.

## 12. Security and privacy

- Tauri permissions expose only commands and paths required by the application.
- Rust validates note IDs, folder IDs, filenames, export roots, image formats, and resolved paths.
- Resolved paths must remain within an approved application-data or user-selected export root; traversal and symlink escapes are rejected.
- The preview sanitizes unsafe HTML and does not execute scripts from notes.
- External links require explicit safe opening behavior.
- Production logs and future telemetry exclude note bodies, credentials, and sensitive absolute paths.
- Future sync credentials use operating-system secure storage and are not placed in settings JSON or SQLite plaintext.

## 13. Testing and acceptance

### 13.1 Automated tests

- Unit tests for frontmatter, UUIDs, tag normalization, internal-link parsing and serialization, title derivation, filename safety, and search-query interpretation.
- Integration tests for atomic replacement, interrupted saves, disk failures, image movement, trash restoration, batch conversion, schema migrations, and full index rebuild.
- Editor tests for the three views, atomic two-step link deletion, rename refresh, selection/scroll preservation, and split scrolling.
- UI tests for resizable columns, minimum widths, double-click reset, multi-selection, deletion undo, and restored window state.
- Security tests for path traversal, unsafe HTML, malformed frontmatter, invalid image payloads, and unauthorized Tauri command access.

### 13.2 Platform verification

Windows and macOS release candidates must both verify:

- Global-shortcut registration and conflict feedback.
- Creation of multiple sticky windows.
- Move, resize, hide, restore, and always-on-top behavior.
- Autostart enable/disable behavior.
- Application data, export, installer, signing, update, and uninstall behavior.
- Keyboard navigation and platform-appropriate shortcuts.

### 13.3 Performance fixture

Use at least 10,000 generated notes with realistic Markdown, tags, links, and images. Track startup indexing, ordinary search, tag search, note opening, link navigation, and index rebuild. Exact budgets will be set from an early release build on representative Windows and macOS hardware; no unmeasured millisecond promise is part of the initial design.

## 14. Delivery phases

### Phase 1: note core

- Project scaffold and original design tokens.
- Storage root, migrations, UUID identity, folder model, and atomic save.
- Main three-column layout and resizable boundaries.
- Markdown source, split, and preview views.
- Image paste and assets.

### Phase 2: connections and retrieval

- Tags and tag search.
- Full-text title/body search.
- Internal-link editor decoration and navigation.
- Backlinks and unresolved-link state.
- Index rebuild and search performance fixture.

### Phase 3: desktop capture

- Global shortcut.
- Multiple temporary sticky windows.
- Temporary inbox, selection, deletion, undo, and trash.
- Batch conversion with folder selection.
- Autostart and window-state restoration.

### Phase 4: release readiness

- Settings and complete export.
- Crash recovery and failure-state polish.
- Accessibility and reduced motion.
- Windows and macOS installers, signing, updater, and release checks.

### Phase 5: future work

- Optional accounts.
- A synchronization protocol based on immutable IDs, explicit revisions, asset hashes, and conflict handling.
- Mobile applications designed for mobile workflows rather than a direct desktop layout port.

Phase 5 requires a separate design and implementation plan.

## 15. Success criteria

The MVP succeeds when a user can install the application on Windows or macOS, create and organize Markdown notes without an account, paste screenshots, find content by text or `#tag`, navigate stable internal links, capture multiple desktop sticky notes, batch-convert them from the temporary inbox, recover from ordinary deletion and interrupted writes, and export a readable complete library.

The experience should remain calm and understandable without documentation for the primary flows. Optional future synchronization must be addable without changing local note identity or making local operation dependent on a server.
