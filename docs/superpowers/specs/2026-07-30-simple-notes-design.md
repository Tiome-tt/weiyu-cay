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
- Markdown, typed document/text/file entries, managed payloads, and image assets for durable content.
- `pnpm` for JavaScript package management.

Tauri is preferred over Electron because this application values a small install and runtime footprint. It is preferred over Flutter because the web editor ecosystem is better suited to a developer-focused Markdown source editor. Rust is limited to privileged and performance-sensitive infrastructure; ordinary UI and product logic remain in TypeScript.

### 3.2 Editor model

Markdown notes provide three representations of the same source, while v1.1.0 also adds a separate rich document entry type. Rich documents are block-based and save their structured content as a typed durable entry; they do not rewrite the original Markdown source.

1. Markdown source.
2. Markdown source and rendered preview in a resizable split.
3. Rendered preview.

Rich document entries use an editor with headings, inline marks including `==highlight==` semantics, lists, tasks, links, images, and spreadsheet-like tables with row/column operations and cell merging. Plain text entries use a focused text editor. Imported PDFs and images have safe viewers; Office files remain managed attachments with explicit external-copy actions.

Switching views preserves the current note, selection where applicable, and scroll position. The split view synchronizes scrolling where a stable source-to-preview mapping exists and degrades gracefully when an exact mapping is unavailable.

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
- Create rich document, plain text, and managed file entries alongside legacy Markdown notes. Markdown conversion creates a new document copy, preserving the original note and UUID links.

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

1. Logical folder tree with inline notes and the temporary inbox. New-note and move destinations list real folders only; no unfiled destination is offered. Moving a note refreshes both source and destination inline lists without another navigation action. Existing root-level content remains compatible with storage and recovery.
2. Heading outline of the current note.
3. Editor and preview area.

Notes expand naturally within their folders; only the complete folder tree scrolls. The outline uses the preview Markdown grammar, excludes code-block contents, and retains source positions for navigation. Its collapsed rail displays only the directory label, without note or heading counts. These corrections are confirmed for 1.0.1 on 2026-08-31.

The 1.1.3 UI refinement approved on 2026-09-28 uses General, System, Keys, Storage, and AI categories with aligned right edges for compact number controls, grouping updates in System and portable export in Storage, preserving input drafts across categories. Rich-document formatting uses an H menu with themed hover highlighting; the collapsed toolbar takes no full row and keeps a small edge icon. Temporary inbox rows and their content buttons have no hover fill. Main-window column boundaries occupy one pixel with a transparent pointer hit area, retaining keyboard resizing and double-click reset.

The boundaries between columns are directly draggable. There is no visible “drag to resize” instruction in the application. On hover, the cursor changes and the boundary highlights subtly. Each column has a minimum width. Double-clicking a boundary restores the default proportion. The application persists proportions and collapsed states.

Branding and settings share the native titlebar with window controls. Search lives below the library heading; its results overlay the workspace without being clipped by the narrow column. The collapsed library keeps its expansion button at the top and one separator. Only formal notes offer stars, persisted by immutable note IDs as navigation preferences; old folder stars remain compatible on disk but are not shown or automatically assigned to notes. Temporary inbox clicks show a selected border without hover fill. Rich-document font size has no spinner and applies on Enter to selected text or the insertion position; moving the caret refreshes the displayed size.

The editor has a slim title toolbar. It contains the note title on the left and source, split, preview, and more-actions controls on the right. View controls do not live in the global application bar because they affect only the current note.

Note rows expose deletion through the context menu (including keyboard operation), without a hover delete icon. Recoverable delete feedback floats at the bottom of the workspace with undo and dismissal actions, without moving tree rows. Generated table column names avoid all existing headers; inserting a column never renames existing headers or moves their content to another column.

The Chinese feature name for temporary captures is “临时便笺”, shortened to “便笺” in action labels.


The compact note heading shows tags with an always-visible add-tag action; last-edited metadata lives in the bottom status bar. The editor block “+” and context menus expose the same insertion actions, including a searchable internal-link picker that excludes the current note. Icon-only inline formatting controls show concise hover labels and retain accessible names.

The tray and application lifecycle extension was approved on 2026-09-04 and is specified in `2026-09-04-tray-lifecycle-design.md` (implementation pending). Windows optionally saves and hides the main window to the tray after an explicit first-close choice. macOS retains native window-close/application-quit behavior. Tray/menu-bar actions restore the application, create a temporary capture, open the inbox or settings, and request safe quit. Quit and authorized restart require durable-save confirmation from every live editor, including hidden sticky windows. Storage relocation must save every live editor before acquiring the relocation lock or copying data; failure leaves the configured root unchanged, while success transfers only that attempt's barriers to the authorized restart. Tray failure must not strand a hidden main window; startup single-instance activation reuses the existing process. Existing note formats and autostart choices remain unchanged.

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

## Approved post-MVP editor and AI summary behavior

Rich-document formatting uses a compact original icon toolbar, except the font family remains visible as text; every icon-only action retains an accessible name and visible hover label. The font-size field and its hover/focus arrow share one control, and insertion uses a distinct document-plus icon. A heading's Markdown prefix is selectable ordinary text within its single native editing region; editing the prefix updates the heading level. The prefix is removed when mapping editor state to the durable heading schema. Typing a Markdown heading prefix in a paragraph converts it to a heading, and the title remains editable from its first character.

AI summary is available only for formal notes, never temporary captures. In the temporary inbox, clicking the active capture again closes its editor only after all pending edits and image writes save successfully; a failed save keeps the editor and draft open. Active previews do not add a persistent card highlight.

AI summary is an optional, explicit network action. Opening its panel reads an existing per-note result locally without contacting the model. The first generation and regeneration both require a separate user click. Successful summaries are durably cached by stable note ID and remain readable after restart; opening a saved result does not consume API tokens. Existing local results are not discarded merely because prompt details change.

AI summary result text is selectable for copying while disclosure headings remain interactive controls. AI summary omits a separate to-do section. The first model pass orders source-grounded key points by whole-note importance, writes a thesis rather than a list of topics, and retains the complete chapter outline separately. After the user explicitly requests generation, every distinct local note image is described through the selected model and its description is spliced back into each corresponding source position. No fixed image-count cap silently omits later images. Repeated references to one local image reuse its description. If an image cannot be read or described, generation stops without caching an incomplete result. Image content is sent to DeepSeek, so more images increase network disclosure and token cost. When the prepared note exceeds the model input budget, preserve source order and process it in bounded consecutive chunks through model-assisted compression; repeat until the full condensed note fits, or report failure instead of truncating or caching a partial summary.

After a user-initiated summary is generated, the result is saved before the optional semantic-label pass. A second model request receives only the saved summary, key points, outline, and keywords; labeling failure leaves the saved summary readable and offers an explicit “重新标注” retry that does not revisit the note or its images. Opening a cached result, changing label visibility or filters, and editing the note do not call the model. A SHA-256 of the source note identifies results that may be stale; an older cache with no hash stays readable without an automatic refresh.

The universal semantic-label vocabulary is exactly six mutually exclusive roles: concept (what something is), mechanism (how or why it works, including processes and causal links), evidence (specific supporting data, formula, example, or observation), conclusion (a synthesized judgment or answer, not a mere fact), action (an explicitly stated decision to do something, never an invented recommendation), and caveat (an explicit condition, exception, risk, cost, or limit). Keywords remain separate chips and are not a seventh inline role; broad “key sentence” is not a role. The model first compares the entire saved result and ranks a small set of genuinely memorable, usable takeaways across all chapters, then assigns each selected excerpt exactly one semantic role. Labels retain that global importance order. It prefers self-contained clauses with context over isolated terms or numbers, removes repeated ideas, and may return none; it must not fill category or chapter quotas, infer unstated actions, or generate colors or markup. Quantified improvements are evidence, not caveats unless the text explicitly states a condition or cost. The semantic labels are reading aids, not verification of factual truth.

Each label contains kind, blockId, exact quote, and zero-based occurrence. Allowed block IDs are summary, keyPoints/i, outline/i/heading, and outline/i/points/j. The privileged boundary validates category, block existence, exact quote, occurrence, and non-overlap within that block; invalid labels are discarded. One occurrence never spreads to repeated phrases or another section. The renderer displays only validated text spans, including outline headings and points, with no inserted badge text, so selection and copying preserve the original summary. The six roles use centrally defined theme-aware text colors with distinct underline treatments and accessible names; color alone is not the only cue. The default panel presents a restrained, ranked “重点速览” using the complete containing sentence for each validated version-2 label, without inserted label words in copyable text. The one-line summary remains visible; additional key points and the full chapter outline stay available in collapsed sections. The outline is not colored by default; an explicit display option enables its inline marks. The panel header offers a view toggle and six-category filter. These controls change presentation only and use a restrained transition, with reduced-motion support; the summary card background never changes when highlights are toggled.

Legacy caches remain readable. Version-1 or pre-versioned labels are not treated as ranked focus highlights and are not silently migrated; the saved summary remains readable with a notice that explicit relabeling is needed. The user may relabel the saved summary without revisiting images or regenerate the whole result. Regeneration replaces the summary only on successful generation, while relabeling changes only labels on a successful pass. A failed label pass never destroys the summary. Quality review before release should sample different note types (technical, study, meeting, research, personal), long outlines, repeated phrases, absent categories, and incorrect model claims; check that labels are sparse, category distinctions are clear, all themes have readable contrast, and no model call occurs from a read-only UI action.

### UI refinement approved on 2026-09-29

- Settings keep the five approved categories, remove native number spinners and developer-only update instructions, and group API Key and model under their AI provider without internal separator lines.
- Shortcut labels map to Ctrl on Windows and Command on macOS. Recording temporarily unregisters the capture shortcut; completion, cancellation and settings teardown restore the current binding. Clicking the shortcut field or pressing Enter starts recording; no separate recording button is shown.
- Ctrl/Cmd+F opens a centered, rounded library search dialog with folder and note destinations. Navigation uses the existing save barrier; failure preserves the current editor and dialog. The sidebar search retains a visible border and a short placeholder.
- Every note editor has a thin bottom status bar showing line count, non-whitespace Unicode character count, selection count, last edit time and save state. Managed files show unavailable text statistics rather than counting filenames. The related-note panel starts closed and supports scrolling, pointer resizing and keyboard resizing above the status bar.
- Storage relocation accepts a fresh or empty directory and checks user-available space before copying. The existing atomic copy, index snapshot and restart verification remain mandatory. After successful reopening, the app verifies remaining old managed content against the new copy before cleanup. A partial cleanup is retryable; changed content is preserved and the new verified library remains usable. Only an empty old root is removed; bootstrap configuration and unknown files remain. This changes cleanup timing without changing durable formats or note IDs.

### Additional UI refinement approved on 2026-09-29

- General settings omit redundant helper descriptions and place the autosave unit `ms` beside its numeric input. Checkbox rows do not toggle from the descriptive text; only the checkbox itself changes state, with consistent themed appearance and keyboard focus.
- AI Key has a Save action embedded at the right edge of the input; the separate Clear action is omitted. The Keys category also lists the platform search shortcut.
- Library search is compact and vertically centered, and displays the existing search port's matching body excerpt below each note's title and folder path. Sidebar search uses a small icon, themed boundary and platform shortcut cue; indexing behavior remains unchanged.
- Heading, font family and font size choices use consistent application menus with surface backgrounds and themed option hover/keyboard highlighting. Pointer opening preserves editor focus without selecting a focused item; Escape dismisses the menu.
- Markdown and typed notes use compact title/tag spacing with an always-visible Add tag control. Empty additions do not submit; editing or dismissing the input clears validation feedback, which remains inline rather than floating over the editor.

### Heading and settings interaction refinement approved on 2026-09-29

- Standard settings action buttons share typography, size, fill, border and hover behavior. Keys use concise Search and Capture labels; the capture field itself starts recording, with Escape, blur and teardown restoring the shortcut. Storage uses a native single-directory picker; cancellation retains the previous selection, and migration remains a separate explicit action with the existing validation and save barriers.
- Sidebar search fills more of the library width and uses a quiet themed surface with a small keyboard cue.
- Rich headings use a single native editable content region with a selectable Markdown prefix revealed while the heading is active. Typing `#` at the leading edge formats immediately; native copy, replacement and deletion include the prefix. Adding or deleting hashes synchronizes levels 1–6, and removing the prefix restores a paragraph. Mapping removes only the editor-owned prefix, preserving durable text, marks and existing content compatibility.

### Search, formatting and block refinements approved on 2026-09-29

- Search and capture shortcuts are independently editable through their fields. The local search binding defaults to CommandOrControl+F and older settings retain that default. Capture is paused during either recording and restored on completion or cancellation.
- Sidebar search shows results in place of the folder/file list; Enter opens the first matching note, and clearing the query restores the tree. The keyboard shortcut retains a separate centered dialog. Results highlight literal keywords in yellow and show up to three actual matching sentences, in document order, separated by ellipses; unrelated body excerpts are omitted.
- DeepSeek credential and model controls share the same width.
- The document format painter copies the first selected text's marks, heading level and paragraph alignment to the next selection once, excludes link destinations and content, and supports Escape cancellation and undo.
- Rich-document rows refer to content blocks, including empty paragraphs. Text paragraphs and headings, code blocks, images, tables and other block content each count once; list items and quote contents are traversed, table cells are not counted separately, and empty paragraphs receive numbers. A single left gutter number fades in while hovering a block and fades out on leaving; reduced-motion mode removes the animation. Markdown source and plain text retain source line counts.

### Further editor refinements approved on 2026-09-29

- Ordinary setting names use one font size and normal weight; category and group headings retain emphasis. The minimize stroke is vertically centered.
- Editor-owned heading prefixes remain native editable text but are visually hidden outside the active heading. Focusing or selecting that heading reveals its prefix; durable heading text and compatibility do not change.
- Rich documents expose a hover block insertion button beside the line number. The gutter, toolbar insertion menu and default context menu share lists, images, links, tables, code, quotes, formulas and divider actions; text and heading styles remain in the format toolbar. Asset and internal-link actions continue through existing typed ports.
- Markdown displays source-line numbers on hover immediately left of its block insertion button; rich document numbers refer to content blocks. Both honor reduced motion.

- The rich-document gutter remains reachable across the gap from content to its insertion button. Rich and Markdown buttons share transparent resting and green hover/focus states, with vertically centered numbers. Titlebar poetry uses a larger 12–16px size without changing the 30px titlebar height.

### Image and native-block refinements approved on 2026-09-29

- The image read queue drains requests added during an in-flight batch, preserving each newly inserted path. Concurrent image writes remain part of the editor save barrier.
- Empty paragraphs count as editable rich-document blocks and expose the hover number and insertion button.
- The rich insertion menu omits text and heading styles. It inserts native structured document objects, including lists and tables, rather than Markdown source syntax.
- New static PNG and JPEG assets follow the image-save quality setting: high-quality WebP Q95 by default, smaller WebP Q85, or original format. Convert only when the WebP output is smaller; preserve animation, unsupported files, and original bytes when encoding fails. The original-format option retains the existing bounded, lossless PNG IDAT optimization. Existing libraries are not rewritten automatically. Preserve validation, staging, flush, and atomic publication for every saved asset.
- In Storage settings, a quiet horizontal divider separates image-save quality from “存储位置与迁移”. The selector describes the user-facing tradeoff as “高清压缩（推荐）”, “省空间压缩”, and “保留原图”; one concise contextual sentence explains the selected option and which images are affected while persisted WebP Q95/Q85 values remain stable. The migration area distinguishes the current location from the target folder.
- Transient operation failures, including editor commands, image operations, search, settings, and library actions, appear as bottom-right notifications with a close button and ten-second expiry. Keep retry and recovery controls available in context when a failure blocks startup, saving, or a platform decision.
