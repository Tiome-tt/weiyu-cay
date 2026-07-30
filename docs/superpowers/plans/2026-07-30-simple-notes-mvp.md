# Simple Notes MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a releasable local-first Markdown note application for Windows and macOS with stable internal links, tags/search, multiple desktop captures, recovery, and portable export.

**Architecture:** React and TypeScript own presentation and domain orchestration. A narrow typed Tauri boundary calls Rust services for filesystem, SQLite, windows, shortcuts, autostart, export, and update behavior. Markdown and assets are durable content; SQLite is rebuildable metadata and search infrastructure.

**Tech Stack:** Tauri 2, Rust, React, TypeScript, Vite, CodeMirror 6, unified/remark/rehype, SQLite FTS5 via `rusqlite`, Vitest, React Testing Library, Playwright, Cargo tests, pnpm.

## Global Constraints

- Support Windows and macOS in the MVP; isolate platform-specific behavior behind adapters.
- All core note features work without an account or network connection.
- Use Tauri 2, React, TypeScript, Vite, CodeMirror 6, SQLite, Markdown files, and image assets.
- Every formal note and temporary capture has one immutable UUIDv7.
- Persist internal links as `[[Visible title|UUID]]`; display `[[Visible title]]` as an atomic editor decoration.
- Markdown and assets are durable content; SQLite must be rebuildable from files and `folders.json`.
- Save Markdown through a flushed sibling temporary file followed by atomic replacement.
- Closing a sticky-note window hides it and never deletes the temporary capture.
- Sticky notes share one theme-derived color; per-note colors are outside scope.
- The main window uses resizable folder, note-list, and editor columns.
- The editor exposes source, split source/preview, and preview modes in its title toolbar.
- Do not use `animal-island-ui` code or assets; create an original commercial-safe design system.
- Preserve unsupported Markdown source, sanitize rendered HTML, and reject path traversal and symlink escapes.
- Use test-driven development, focused commits, and the verification commands defined in `AGENTS.md`.

## Delivery Sequence

1. Tasks 1-7 produce a usable offline note core.
2. Tasks 8-10 add tags, search, stable links, and backlinks.
3. Tasks 11-13 add multiple desktop captures and the temporary inbox.
4. Tasks 14-18 add trash, settings, export, recovery, accessibility, performance, and signed release pipelines.

Do not start the next delivery segment until the previous segment's full verification task passes.

## Planned File Map

```text
src/
├── app/
│   ├── App.tsx                         # main composition root
│   ├── App.test.tsx                    # application smoke behavior
│   └── services.ts                     # dependency construction
├── test/
│   └── fakes.ts                        # typed TypeScript test ports and fixtures
├── domain/
│   ├── model.ts                        # branded IDs and domain records
│   ├── errors.ts                       # typed domain failures
│   ├── noteFormat.ts                   # frontmatter and internal-link format
│   └── ports.ts                        # privileged-service interfaces
├── infrastructure/tauri/
│   ├── client.ts                       # typed invoke wrapper
│   └── client.test.ts                  # command/shape tests
├── features/library/
│   ├── LibraryLayout.tsx               # three-column shell
│   ├── FolderTree.tsx                  # logical folder navigation
│   ├── NoteList.tsx                    # notes for active folder
│   ├── useLibrary.ts                   # library state orchestration
│   └── *.test.tsx
├── features/editor/
│   ├── EditorPane.tsx                  # title toolbar and mode switching
│   ├── MarkdownSource.tsx               # CodeMirror host
│   ├── MarkdownPreview.tsx              # sanitized preview
│   ├── internalLinks.ts                 # atomic link decorations
│   ├── imagePaste.ts                    # validated screenshot flow
│   ├── useAutosave.ts                   # debounced durable save
│   └── *.test.tsx
├── features/search/
│   ├── SearchBox.tsx
│   ├── SearchResults.tsx
│   ├── TagsEditor.tsx
│   └── *.test.tsx
├── features/temporary/
│   ├── StickyWindow.tsx
│   ├── TemporaryInbox.tsx
│   ├── ConvertDialog.tsx
│   └── *.test.tsx
├── features/settings/
│   ├── SettingsView.tsx
│   ├── theme.ts
│   └── *.test.tsx
├── shared/
│   ├── SplitPane.tsx                   # accessible resize behavior
│   ├── StatusNotice.tsx
│   └── *.test.tsx
└── styles/
    ├── tokens.css                      # original visual tokens
    └── app.css

src-tauri/
├── migrations/
│   └── 0001_initial.sql
├── src/
│   ├── lib.rs                          # plugins, state, command registration
│   ├── error.rs                        # structured command errors
│   ├── domain.rs                       # Rust request/response records
│   ├── commands/
│   │   ├── notes.rs
│   │   ├── search.rs
│   │   ├── temporary.rs
│   │   ├── settings.rs
│   │   └── export.rs
│   ├── storage/
│   │   ├── mod.rs
│   │   ├── paths.rs
│   │   ├── atomic_file.rs
│   │   ├── database.rs
│   │   ├── repository.rs
│   │   └── rebuild.rs
│   ├── platform/
│   │   ├── mod.rs
│   │   ├── windows.rs
│   │   └── macos.rs
│   └── windows/
│       ├── mod.rs
│       └── sticky.rs
└── tests/
    ├── support/mod.rs                  # isolated data-root and database test harness
    ├── atomic_save.rs
    ├── repository.rs
    ├── rebuild.rs
    ├── temporary_conversion.rs
    └── security.rs

e2e/
├── note-flow.spec.ts
├── temporary-inbox.spec.ts
└── recovery.spec.ts
```

---

### Task 1: Scaffold the Tauri application and verification baseline

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/App.test.tsx`
- Create: `src/app/services.ts`
- Create: `src/styles/tokens.css`
- Create: `src/styles/app.css`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the approved design specification only.
- Produces: root scripts `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `tauri`; a renderable `App`; a compilable Tauri shell.

- [ ] **Step 1: Scaffold without overwriting project documentation**

Run from a temporary sibling directory, then move only scaffold-owned files into this repository:

```powershell
pnpm create tauri-app@latest simple-notes-scaffold --manager pnpm --template react-ts
```

Keep the existing `.gitignore`, `AGENTS.md`, and `docs/`. Configure package name `simple-notes`, product name `Simple Notes`, identifier `app.simplenotes.desktop`, and Tauri frontend commands `pnpm dev` / `pnpm build`.

- [ ] **Step 2: Install the quality and test dependencies**

```powershell
pnpm add @codemirror/lang-markdown @codemirror/state @codemirror/view unified remark-parse remark-gfm remark-frontmatter remark-rehype rehype-sanitize rehype-stringify
pnpm add -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event eslint typescript-eslint @playwright/test
pnpm tauri add autostart
pnpm tauri add global-shortcut
pnpm tauri add store
pnpm tauri add dialog
pnpm tauri add updater
```

Add Rust dependencies through Cargo so `Cargo.lock` records the compatible current releases:

```powershell
cargo add --manifest-path src-tauri/Cargo.toml rusqlite --features bundled-full
cargo add --manifest-path src-tauri/Cargo.toml serde --features derive
cargo add --manifest-path src-tauri/Cargo.toml serde_json thiserror chrono serde_yml unicode-normalization
cargo add --manifest-path src-tauri/Cargo.toml uuid --features v7,serde
cargo add --manifest-path src-tauri/Cargo.toml image --no-default-features --features png,jpeg,gif,webp
cargo add --manifest-path src-tauri/Cargo.toml --dev tempfile
```

- [ ] **Step 3: Write the application smoke test**

```tsx
// src/app/App.test.tsx
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App', () => {
  it('renders the local library shell without authentication', () => {
    render(<App />)
    expect(screen.getByRole('application', { name: 'Simple Notes' })).toBeVisible()
    expect(screen.queryByText(/sign in|登录/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run the test and verify the scaffold fails for the required shell**

Run: `pnpm test -- src/app/App.test.tsx`

Expected: FAIL because the generated `App` does not expose the required application role and name.

- [ ] **Step 5: Add the minimal shell and original design tokens**

```tsx
// src/app/App.tsx
import '../styles/tokens.css'
import '../styles/app.css'

export function App() {
  return <main role="application" aria-label="Simple Notes" className="app-shell" />
}
```

```css
/* src/styles/tokens.css */
:root {
  --color-canvas: #f7f1e5;
  --color-surface: #fffdf8;
  --color-accent: #8dc9ac;
  --color-warm: #e4a86c;
  --color-text: #403b34;
  --color-border: #d8cbb6;
  --radius-panel: 18px;
  --motion-fast: 120ms;
}
```

- [ ] **Step 6: Establish baseline verification**

Run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `cargo test --manifest-path src-tauri/Cargo.toml`.

Expected: all commands exit 0. Update `AGENTS.md` only if scaffolded script names differ, so its commands remain executable.

- [ ] **Step 7: Commit**

```powershell
git add package.json pnpm-lock.yaml vite.config.ts vitest.config.ts tsconfig.json eslint.config.js index.html src src-tauri AGENTS.md
git commit -m "build: scaffold Tauri application"
```

---

### Task 2: Define domain contracts and the Markdown note format

**Files:**
- Create: `src/domain/model.ts`
- Create: `src/domain/errors.ts`
- Create: `src/domain/ports.ts`
- Create: `src/domain/noteFormat.ts`
- Create: `src/domain/noteFormat.test.ts`
- Create: `src/infrastructure/tauri/client.ts`
- Create: `src/infrastructure/tauri/client.test.ts`
- Create: `src/test/fakes.ts`
- Create: `src-tauri/src/domain.rs`
- Create: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Tauri `invoke`.
- Produces: `NoteId`, `FolderId`, `NoteDocument`, `NoteSummary`, `Folder`, `NotePort`, `FolderPort`, `AssetPort`, `SystemPort`, `TemporaryPort`, `parseStoredLink`, `formatStoredLink`, and `TauriClient` used by all later tasks.

- [ ] **Step 1: Write failing format tests**

```ts
// src/domain/noteFormat.test.ts
import { describe, expect, it } from 'vitest'
import { formatStoredLink, parseStoredLink } from './noteFormat'

describe('stored internal links', () => {
  it('round-trips a title and immutable id', () => {
    const id = '019c0000-0000-7000-8000-000000000002'
    expect(parseStoredLink(formatStoredLink('用户认证', id))).toEqual({ title: '用户认证', noteId: id })
  })

  it('rejects a label containing a closing delimiter', () => {
    expect(() => formatStoredLink('bad]]label', '019c0000-0000-7000-8000-000000000002')).toThrow('Invalid link title')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/domain/noteFormat.test.ts`

Expected: FAIL because `noteFormat.ts` does not exist.

- [ ] **Step 3: Add exact domain types and link functions**

```ts
// src/domain/model.ts
export type Brand<T, Name extends string> = T & { readonly __brand: Name }
export type NoteId = Brand<string, 'NoteId'>
export type FolderId = Brand<string, 'FolderId'>
export type NoteKind = 'formal' | 'temporary'
export type EditorMode = 'source' | 'split' | 'preview'

export interface NoteDocument {
  id: NoteId
  kind: NoteKind
  title: string
  folderId: FolderId | null
  tags: string[]
  markdown: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface NoteSummary extends Omit<NoteDocument, 'markdown'> {
  excerpt: string
}

export interface Folder {
  id: FolderId
  parentId: FolderId | null
  name: string
  sortOrder: number
}
```

```ts
// src/domain/noteFormat.ts
const storedLink = /^\[\[([^\]|]+)\|([0-9a-f-]{36})\]\]$/i

export function formatStoredLink(title: string, noteId: string): string {
  if (!title.trim() || title.includes(']]') || title.includes('|')) throw new Error('Invalid link title')
  if (!/^[0-9a-f-]{36}$/i.test(noteId)) throw new Error('Invalid note id')
  return `[[${title.trim()}|${noteId}]]`
}

export function parseStoredLink(value: string) {
  const match = storedLink.exec(value)
  if (!match) throw new Error('Invalid stored link')
  return { title: match[1], noteId: match[2] }
}
```

Define `NotePort`, `FolderPort`, `AssetPort`, `SystemPort`, and `TemporaryPort` exactly as below. Define a structured `CommandError` union with `validation`, `not_found`, `conflict`, `io`, `database`, and `unsupported` codes. Mirror request and response field names in Rust with `#[serde(rename_all = "camelCase")]`.

Use these exact privileged-port shapes and extend them in later tasks rather than invoking Tauri from components:

```ts
// src/domain/ports.ts
export interface NotePort {
  createNote(folderId: FolderId | null): Promise<NoteDocument>
  loadNote(id: NoteId): Promise<NoteDocument>
  saveNote(document: NoteDocument): Promise<NoteDocument>
  listNotes(folderId: FolderId | null): Promise<NoteSummary[]>
  moveNote(id: NoteId, folderId: FolderId | null): Promise<void>
}
export interface FolderPort {
  listFolders(): Promise<Folder[]>
  createFolder(input: { parentId: FolderId | null; name: string }): Promise<Folder>
  renameFolder(id: FolderId, name: string): Promise<Folder>
  moveFolder(id: FolderId, parentId: FolderId | null): Promise<Folder>
  deleteEmptyFolder(id: FolderId): Promise<void>
}
export interface AssetPort {
  saveImage(input: { noteId: NoteId; mediaType: string; bytes: Uint8Array }): Promise<{ relativePath: string; width: number; height: number }>
}
export interface SystemPort {
  setWindowPreference(key: string, value: unknown): Promise<void>
  hideTemporaryWindow(noteId: NoteId): Promise<void>
}
export interface TemporaryPort {
  list(): Promise<NoteDocument[]>
  convert(input: { ids: NoteId[]; folderId: FolderId }): Promise<BatchConversionResult>
  trash(ids: NoteId[]): Promise<{ operationId: string }>
  undoTrash(operationId: string): Promise<void>
}
export interface BatchConversionResult {
  converted: Array<{ temporaryId: NoteId; noteId: NoteId }>
  failed: Array<{ temporaryId: NoteId; message: string }>
}
```

Add reusable typed test values and port fakes so later test snippets do not invent incompatible interfaces:

```ts
// src/test/fakes.ts
import { vi } from 'vitest'
import type { Folder, FolderId, NoteDocument, NoteId } from '../domain/model'
import type { AssetPort, FolderPort, NotePort, SystemPort, TemporaryPort } from '../domain/ports'

export const noteId = '019c0000-0000-7000-8000-000000000002' as NoteId
export const projectB = '019c0000-0000-7000-8000-000000000001' as FolderId
export const note = (markdown = ''): NoteDocument => ({
  id: noteId, kind: 'formal', title: '登录流程', folderId: projectB, tags: [], markdown,
  revision: 1, createdAt: '2026-07-30T15:30:00+08:00', updatedAt: '2026-07-30T15:30:00+08:00',
})
export const folders = (): Folder[] => [{ id: projectB, parentId: null, name: '项目 B', sortOrder: 0 }]
export const fakeNotePort = (overrides: Partial<NotePort> = {}): NotePort => ({
  createNote: vi.fn(), loadNote: vi.fn(), saveNote: vi.fn(), listNotes: vi.fn(), moveNote: vi.fn(), ...overrides,
})
export const fakeFolderPort = (): FolderPort => ({
  listFolders: vi.fn().mockResolvedValue(folders()), createFolder: vi.fn(), renameFolder: vi.fn(),
  moveFolder: vi.fn(), deleteEmptyFolder: vi.fn(),
})
export const fakeAssetPort = (saved: Awaited<ReturnType<AssetPort['saveImage']>>): AssetPort => ({ saveImage: vi.fn().mockResolvedValue(saved) })
export const fakeSystemPort = (): SystemPort => ({ setWindowPreference: vi.fn(), hideTemporaryWindow: vi.fn() })
export const fakeTemporaryPort = (items: NoteDocument[]): TemporaryPort => ({
  list: vi.fn().mockResolvedValue(items), convert: vi.fn(), trash: vi.fn(), undoTrash: vi.fn(),
})
export const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
export const pasteEvent = (bytes: Uint8Array) => ({ bytes, mediaType: 'image/png' })
export const twoCaptures = () => [
  { ...note('发布前检查'), id: '019c0000-0000-7000-8000-000000000010' as NoteId, kind: 'temporary' as const },
  { ...note('接口异常处理'), id: '019c0000-0000-7000-8000-000000000011' as NoteId, kind: 'temporary' as const },
]
```

- [ ] **Step 4: Test serialization and typed command errors**

Run: `pnpm test -- src/domain src/infrastructure/tauri` and `cargo test --manifest-path src-tauri/Cargo.toml domain`.

Expected: PASS, including JSON round trips for Rust and TypeScript command records.

- [ ] **Step 5: Commit**

```powershell
git add src/domain src/infrastructure/tauri src/test src-tauri/src/domain.rs src-tauri/src/error.rs src-tauri/src/lib.rs
git commit -m "feat: define note domain contracts"
```

---

### Task 3: Create safe storage paths and the initial SQLite schema

**Files:**
- Create: `src-tauri/migrations/0001_initial.sql`
- Create: `src-tauri/src/storage/mod.rs`
- Create: `src-tauri/src/storage/paths.rs`
- Create: `src-tauri/src/storage/database.rs`
- Create: `src-tauri/tests/support/mod.rs`
- Create: `src-tauri/tests/repository.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: UUID records from Task 2 and Tauri application-data directory.
- Produces: `StoragePaths::open(root)`, `StoragePaths::note_dir(id, kind)`, `Database::open(path)`, and `Database::migrate()`.

- [ ] **Step 1: Write failing path-containment and schema tests**

```rust
// src-tauri/tests/repository.rs
#[test]
fn note_paths_remain_under_the_data_root() {
    let temp = tempfile::tempdir().unwrap();
    let paths = simple_notes_lib::storage::paths::StoragePaths::open(temp.path()).unwrap();
    let id = uuid::Uuid::now_v7();
    let note = paths.note_dir(id, simple_notes_lib::domain::NoteKind::Formal).unwrap();
    assert!(note.starts_with(temp.path()));
}

#[test]
fn migration_creates_link_and_search_tables() {
    let db = simple_notes_lib::storage::database::Database::memory().unwrap();
    db.migrate().unwrap();
    assert!(db.table_exists("note_links").unwrap());
    assert!(db.table_exists("search_documents").unwrap());
}
```

Add `tempfile = "3"` to `[dev-dependencies]`.

The shared Rust test harness owns an isolated root and migrated database:

```rust
// src-tauri/tests/support/mod.rs
pub struct TestStore {
    pub root: tempfile::TempDir,
    pub paths: StoragePaths,
    pub db: Database,
}

impl TestStore {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let paths = StoragePaths::open(root.path()).unwrap();
        let db = Database::open(paths.database()).unwrap();
        db.migrate().unwrap();
        Self { root, paths, db }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test repository`

Expected: FAIL because the storage modules and migration do not exist.

- [ ] **Step 3: Add the schema and path validation**

The migration creates `notes`, `folders`, `tags`, `note_tags`, `note_links`, `temporary_windows`, `search_documents`, and `schema_migrations`. Use `BLOB NOT NULL UNIQUE` for UUIDs and explicit foreign-key behavior. Enable `PRAGMA foreign_keys = ON`, WAL mode for the persistent database, and `busy_timeout`.

```rust
// src-tauri/src/storage/paths.rs
pub fn child_under(root: &Path, segments: &[&str]) -> Result<PathBuf, AppError> {
    let mut path = root.to_path_buf();
    for segment in segments {
        if segment.is_empty() || segment.contains(['/', '\\']) || *segment == "." || *segment == ".." {
            return Err(AppError::validation("invalid path segment"));
        }
        path.push(segment);
    }
    if !path.starts_with(root) { return Err(AppError::validation("path escapes data root")); }
    Ok(path)
}
```

- [ ] **Step 4: Verify migration idempotency and containment**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test repository`.

Expected: PASS when migration runs twice and when paths are generated for formal, temporary, trash, assets, `folders.json`, and `index.sqlite`.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/migrations src-tauri/src/storage src-tauri/src/lib.rs src-tauri/tests/repository.rs
git commit -m "feat: add local storage schema"
```

---

### Task 4: Add atomic Markdown persistence and index rebuild

**Files:**
- Create: `src-tauri/src/storage/atomic_file.rs`
- Create: `src-tauri/src/storage/repository.rs`
- Create: `src-tauri/src/storage/rebuild.rs`
- Create: `src-tauri/src/commands/notes.rs`
- Create: `src-tauri/tests/atomic_save.rs`
- Create: `src-tauri/tests/rebuild.rs`
- Modify: `src-tauri/tests/support/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `StoragePaths`, `Database`, `NoteDocument`.
- Produces: `atomic_replace(path, bytes)`, `NoteRepository::{create,load,save,list,move_note}`, `RebuildReport`, Tauri commands `create_note`, `load_note`, `save_note`, `list_notes`, `move_note`, and the test-only `AtomicSaveFixture` / `RebuildFixture` backed by `TestStore`.

- [ ] **Step 1: Write failing atomic-save and rebuild tests**

```rust
#[test]
fn failed_replace_preserves_the_previous_document() {
    let fixture = AtomicSaveFixture::with_document(b"old");
    fixture.fail_before_replace();
    assert!(fixture.save(b"new").is_err());
    assert_eq!(std::fs::read(fixture.document()).unwrap(), b"old");
}

#[test]
fn rebuild_recovers_note_metadata_from_markdown_and_folders_manifest() {
    let fixture = RebuildFixture::one_note("# Hello", &["backend"]);
    fixture.delete_database();
    let report = fixture.rebuild().unwrap();
    assert_eq!(report.notes_recovered, 1);
    assert_eq!(fixture.tags(), vec!["backend"]);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test atomic_save --test rebuild`.

Expected: FAIL because atomic replacement, repository, and rebuild are absent.

- [ ] **Step 3: Implement durable save order**

```rust
pub fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path.parent().ok_or_else(|| AppError::validation("document has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".{}.{}.tmp", path.file_name().unwrap().to_string_lossy(), Uuid::now_v7()));
    let result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        replace_file(&temp, path)?;
        sync_parent(parent)?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result
}
```

`NoteRepository::save` first validates the revision, atomically writes Markdown, then updates SQLite in a transaction. If SQLite fails after the file succeeds, record a rebuild marker without reverting the valid Markdown. `rebuild()` scans only validated UUID directories, parses frontmatter, reads `folders.json`, and reconstructs metadata and indexes.

Define these platform helpers in `atomic_file.rs`; the Windows implementation uses replace semantics that do not expose a partially written destination, while macOS uses same-filesystem rename and directory sync:

```rust
fn replace_file(source: &Path, destination: &Path) -> Result<(), AppError> {
    crate::platform::replace_file(source, destination)
}

fn sync_parent(parent: &Path) -> Result<(), AppError> {
    crate::platform::sync_parent(parent)
}
```

- [ ] **Step 4: Verify failure injection and rebuild**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test atomic_save --test rebuild`.

Expected: PASS for failure before replace, abandoned temporary files, stale revisions, malformed frontmatter isolation, database deletion, and a second idempotent rebuild.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/storage src-tauri/src/commands/notes.rs src-tauri/src/lib.rs src-tauri/tests
git commit -m "feat: persist Markdown atomically"
```

---

### Task 5: Build the resizable library shell and note navigation

**Files:**
- Create: `src/shared/SplitPane.tsx`
- Create: `src/shared/SplitPane.test.tsx`
- Create: `src/features/library/LibraryLayout.tsx`
- Create: `src/features/library/FolderTree.tsx`
- Create: `src/features/library/NoteList.tsx`
- Create: `src/features/library/useLibrary.ts`
- Create: `src/features/library/LibraryLayout.test.tsx`
- Create: `src-tauri/src/commands/folders.rs`
- Create: `src-tauri/tests/folders.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/app/App.tsx`
- Modify: `src/styles/app.css`

**Interfaces:**
- Consumes: `FolderPort.listFolders`, `NotePort.listNotes`, and `NotePort.loadNote`.
- Produces: `SplitPane`, active `FolderId`, active `NoteId`, persisted column proportions, the main three-column shell, and folder commands `create_folder`, `rename_folder`, `move_folder`, `delete_empty_folder`.

- [ ] **Step 1: Write failing resize interaction tests**

```tsx
it('resizes columns by dragging an unlabeled visual divider and resets on double click', async () => {
  render(<LibraryLayout notes={fakeNotePort()} folders={fakeFolderPort()} />)
  const divider = screen.getByRole('separator', { name: '调整文件夹栏宽度' })
  fireEvent.pointerDown(divider, { clientX: 220, pointerId: 1 })
  fireEvent.pointerMove(divider, { clientX: 300, pointerId: 1 })
  fireEvent.pointerUp(divider, { pointerId: 1 })
  expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '300px' })
  fireEvent.doubleClick(divider)
  expect(screen.getByTestId('folder-pane')).toHaveStyle({ width: '240px' })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/shared/SplitPane.test.tsx src/features/library/LibraryLayout.test.tsx`.

Expected: FAIL because the library components do not exist.

- [ ] **Step 3: Add the three-column shell**

Implement pointer capture, keyboard resizing with arrow keys, minimum widths `180px / 220px / 420px`, and double-click reset. The separator has an accessible role and label but no instructional text in the visible UI. Save proportions through `SystemPort.setWindowPreference('library-columns', value)` after pointer release.

Add folder create, inline rename, drag/move, and empty-folder deletion through `FolderPort`. Reject a folder moved under itself or one of its descendants. Reject deletion when the folder still contains child folders or notes; never cascade-delete note content.

```tsx
export function LibraryLayout({ notes, folders }: { notes: NotePort; folders: FolderPort }) {
  const library = useLibrary(notes, folders)
  return (
    <SplitPane defaults={[240, 300]} minimums={[180, 220, 420]}>
      <FolderTree folders={library.folders} activeId={library.folderId} onSelect={library.selectFolder} />
      <NoteList notes={library.notes} activeId={library.noteId} onSelect={library.selectNote} />
      <section aria-label="编辑区">{library.document ? <p>{library.document.title}</p> : null}</section>
    </SplitPane>
  )
}
```

- [ ] **Step 4: Verify navigation and resize behavior**

Run: `pnpm test -- src/shared src/features/library src/app/App.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml --test folders`.

Expected: PASS for mouse drag, keyboard resize, minimum widths, double-click reset, folder/note selection, folder create/rename/move, cycle rejection, non-empty deletion rejection, and no visible resize instruction.

- [ ] **Step 5: Commit**

```powershell
git add src/shared src/features/library src/app/App.tsx src/styles/app.css src-tauri/src/commands/folders.rs src-tauri/src/lib.rs src-tauri/tests/folders.rs
git commit -m "feat: add resizable note library"
```

---

### Task 6: Add source, split, preview, and durable autosave

**Files:**
- Create: `src/features/editor/EditorPane.tsx`
- Create: `src/features/editor/MarkdownSource.tsx`
- Create: `src/features/editor/MarkdownPreview.tsx`
- Create: `src/features/editor/markdownPipeline.ts`
- Create: `src/features/editor/useAutosave.ts`
- Create: `src/features/editor/EditorPane.test.tsx`
- Create: `src/features/editor/useAutosave.test.tsx`
- Modify: `src/features/library/LibraryLayout.tsx`

**Interfaces:**
- Consumes: `NoteDocument`, `NotePort.saveNote`, `EditorMode`.
- Produces: `EditorPane`, `renderMarkdown(markdown)`, `plainTextFromMarkdown(markdown)`, and `useAutosave` returning `{ state, markdown, updateMarkdown, flush, retry }`.

- [ ] **Step 1: Write failing view and autosave tests**

```tsx
it('keeps one document while switching source, split, and preview modes', async () => {
  const user = userEvent.setup()
  render(<EditorPane document={note('# Goal')} notes={fakeNotePort()} />)
  await user.click(screen.getByRole('button', { name: '分栏视图' }))
  expect(screen.getByRole('textbox')).toHaveValue('# Goal')
  expect(screen.getByRole('article')).toHaveTextContent('Goal')
  await user.click(screen.getByRole('button', { name: '预览视图' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByRole('article')).toHaveTextContent('Goal')
})

it('flushes a dirty note when the editor loses focus', async () => {
  const notes = fakeNotePort()
  const autosave = renderHook(() => useAutosave(note('old'), notes, { delayMs: 400 }))
  act(() => autosave.result.current.updateMarkdown('new'))
  act(() => window.dispatchEvent(new Event('blur')))
  await waitFor(() => expect(notes.saveNote).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'new' })))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/features/editor/EditorPane.test.tsx src/features/editor/useAutosave.test.tsx`.

Expected: FAIL because the editor components and hook do not exist.

- [ ] **Step 3: Add one editor state and sanitized preview**

Use CodeMirror as a controlled adapter whose transactions update one React document state. Build the preview with `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-sanitize`, and `rehype-stringify`. Raw scripts and event attributes must never survive rendering. Put the three mode buttons in the editor title toolbar.

```ts
export type SaveState =
  | { status: 'idle' | 'dirty' | 'saving' | 'saved' }
  | { status: 'error'; message: string; retry: () => void }
```

Debounce ordinary edits, flush on blur and orderly close, ignore stale save responses using revision numbers, and leave a persistent retry action after failure.

- [ ] **Step 4: Verify editor behavior and HTML safety**

Run: `pnpm test -- src/features/editor`.

Expected: PASS for all three modes, toolbar placement, source preservation, sanitized scripts, save debounce, blur flush, stale response rejection, and retry after error.

- [ ] **Step 5: Commit**

```powershell
git add src/features/editor src/features/library/LibraryLayout.tsx
git commit -m "feat: add Markdown editing modes"
```

---

### Task 7: Add validated screenshot paste and asset references

**Files:**
- Create: `src/features/editor/imagePaste.ts`
- Create: `src/features/editor/imagePaste.test.ts`
- Create: `src-tauri/src/commands/assets.rs`
- Create: `src-tauri/tests/security.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/domain/ports.ts`
- Modify: `src/infrastructure/tauri/client.ts`

**Interfaces:**
- Consumes: clipboard `File`, current `NoteId`, cursor position.
- Produces: `AssetPort.saveImage({ noteId, mediaType, bytes }) -> { relativePath, width, height }`, `handleImagePaste(event, context)`, and Rust `validate_image(media_type, bytes)`.

- [ ] **Step 1: Write failing image validation tests**

```ts
it('stores a pasted PNG and inserts a relative Markdown image', async () => {
  const assets = fakeAssetPort({ relativePath: 'assets/screenshot-019c.png', width: 800, height: 500 })
  const result = await handleImagePaste(pasteEvent(pngBytes), { noteId, assets })
  expect(result.markdown).toBe('![截图](assets/screenshot-019c.png)')
})
```

```rust
#[test]
fn rejects_a_payload_whose_magic_bytes_do_not_match_the_declared_image_type() {
    let result = validate_image("image/png", b"not a png");
    assert!(matches!(result, Err(AppError::Validation { .. })));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/features/editor/imagePaste.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml --test security`.

Expected: FAIL because asset handling is absent.

- [ ] **Step 3: Add constrained asset persistence**

Accept PNG, JPEG, GIF, and WebP only after checking signature bytes. Enforce a 20 MiB input limit and decoded dimensions no greater than 16,384 by 16,384. Generate `screenshot-<uuidv7>.<ext>` in the owning note's `assets` directory through `StoragePaths`; never trust a renderer-provided filename or absolute path.

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAsset { pub relative_path: String, pub width: u32, pub height: u32 }
```

- [ ] **Step 4: Verify valid and hostile payloads**

Run: `pnpm test -- src/features/editor/imagePaste.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml --test security`.

Expected: PASS for each allowed type, size/dimension rejection, spoofed media type rejection, collision-free names, relative Markdown insertion, and temporary-note asset directories.

- [ ] **Step 5: Verify the note-core delivery gate and commit**

Run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `cargo test --manifest-path src-tauri/Cargo.toml`.

Expected: all exit 0. Manually create, edit, reopen, move, and paste a screenshot into one note on the current OS before committing.

```powershell
git add src/features/editor src/domain/ports.ts src/infrastructure/tauri src-tauri
git commit -m "feat: save pasted note images"
```

---

### Task 8: Add normalized tags and `#` tag search

**Files:**
- Create: `src/features/search/TagsEditor.tsx`
- Create: `src/features/search/TagsEditor.test.tsx`
- Create: `src/features/search/query.ts`
- Create: `src/features/search/query.test.ts`
- Create: `src-tauri/src/commands/search.rs`
- Create: `src-tauri/tests/search.rs`
- Modify: `src/domain/ports.ts`
- Modify: `src/infrastructure/tauri/client.ts`

**Interfaces:**
- Consumes: note tags and search text.
- Produces: `normalizeTag`, `parseSearchQuery`, `SearchPort.search`, and tag create/remove UI.

- [ ] **Step 1: Write failing normalization and query tests**

```ts
it.each([
  [' #后端 ', { kind: 'tag', value: '后端' }],
  ['登录 flow', { kind: 'text', value: '登录 flow' }],
])('parses %s', (input, expected) => expect(parseSearchQuery(input)).toEqual(expected))

it('normalizes duplicate tags without changing the first display spelling', () => {
  expect(mergeTags(['TypeScript'], [' typescript '])).toEqual(['TypeScript'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/features/search`.

Expected: FAIL because tag and query modules do not exist.

- [ ] **Step 3: Add tag persistence and search**

Normalize with Unicode NFKC, trim, collapse internal whitespace, and case-fold for comparison. Preserve the first display form. A bare `#` returns an empty result plus validation guidance. Escape `%`, `_`, and the SQL escape character before substring matching normalized tag names.

```ts
export type SearchQuery =
  | { kind: 'tag'; value: string }
  | { kind: 'text'; value: string }

export interface SearchResult {
  noteId: NoteId
  title: string
  folderBreadcrumb: string[]
  tags: string[]
  excerpt: string
  score: number
}

export interface SearchPort {
  search(query: SearchQuery, limit?: number): Promise<SearchResult[]>
  updateTags(noteId: NoteId, tags: string[]): Promise<string[]>
}
```

- [ ] **Step 4: Verify multilingual tags and SQL safety**

Run: `pnpm test -- src/features/search` and `cargo test --manifest-path src-tauri/Cargo.toml --test search tags`.

Expected: PASS for Chinese characters, case-folded Latin tags, duplicate rejection, escaped wildcard input, add/remove, and `#keyword` result ordering.

- [ ] **Step 5: Commit**

```powershell
git add src/features/search src/domain/ports.ts src/infrastructure/tauri src-tauri/src/commands/search.rs src-tauri/tests/search.rs
git commit -m "feat: add note tags"
```

---

### Task 9: Add full-text title and body search

**Files:**
- Create: `src/features/search/SearchBox.tsx`
- Create: `src/features/search/SearchResults.tsx`
- Create: `src/features/search/SearchBox.test.tsx`
- Create: `src-tauri/benches/search.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tests/support/mod.rs`
- Modify: `src-tauri/migrations/0001_initial.sql`
- Modify: `src-tauri/src/commands/search.rs`
- Modify: `src-tauri/tests/search.rs`

**Interfaces:**
- Consumes: `SearchQuery` and indexed `plainTextFromMarkdown` output.
- Produces: `SearchResult { noteId, title, folderBreadcrumb, tags, excerpt, score }[]` and test-only `SearchFixture` backed by `TestStore`.

- [ ] **Step 1: Write failing search behavior tests**

```rust
#[test]
fn text_search_matches_chinese_title_body_and_short_queries() {
    let fixture = SearchFixture::new();
    fixture.insert("登录流程", "刷新令牌失败后的处理", &["后端"]);
    assert_eq!(fixture.search_text("登录").len(), 1);
    assert_eq!(fixture.search_text("令牌失败").len(), 1);
    assert_eq!(fixture.search_text("令").len(), 1);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test search text_search`.

Expected: FAIL because the body index and fallback are incomplete.

- [ ] **Step 3: Add FTS5 trigram search with a short-query fallback**

Run `cargo add --manifest-path src-tauri/Cargo.toml --dev criterion`, add a `[[bench]]` entry named `search` with `harness = false`, then create the deterministic benchmark.

Create a trigram FTS5 virtual table for title and body. Use parameterized `MATCH` for three-or-more-character queries. For one- or two-character queries, use escaped `LIKE` against the normalized `search_documents` cache. Rank title matches above body matches, cap initial results at 100, and generate excerpts without returning the entire note body.

```rust
pub struct SearchResult {
    pub note_id: Uuid,
    pub title: String,
    pub folder_breadcrumb: Vec<String>,
    pub tags: Vec<String>,
    pub excerpt: String,
    pub score: f64,
}
```

- [ ] **Step 4: Test semantics and the 10,000-note fixture**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test search` and `cargo bench --manifest-path src-tauri/Cargo.toml --bench search`.

Expected: tests PASS; the benchmark records startup/index, ordinary search, tag search, and short-query timings in its output without enforcing an unmeasured fixed threshold.

- [ ] **Step 5: Commit**

```powershell
git add src/features/search src-tauri/migrations src-tauri/src/commands/search.rs src-tauri/tests/search.rs src-tauri/benches/search.rs
git commit -m "feat: add full text note search"
```

---

### Task 10: Add atomic internal links, navigation, rename repair, and backlinks

**Files:**
- Create: `src/features/editor/internalLinks.ts`
- Create: `src/features/editor/internalLinks.test.ts`
- Create: `src/features/editor/Backlinks.tsx`
- Create: `src/features/editor/Backlinks.test.tsx`
- Create: `src-tauri/tests/links.rs`
- Modify: `src-tauri/tests/support/mod.rs`
- Modify: `src-tauri/src/commands/notes.rs`
- Modify: `src-tauri/src/storage/repository.rs`
- Modify: `src/domain/ports.ts`

**Interfaces:**
- Consumes: persisted link syntax and note ID lookup.
- Produces: `internalLinkExtension`, `LinkPort.resolve`, `LinkPort.backlinks`, `LinkPort.renameTargetLabels`, unresolved-link decorations, and test-only `LinkFixture` backed by `TestStore`.

- [ ] **Step 1: Write failing two-step deletion and rename tests**

```ts
it('selects an internal link on first Backspace and deletes it on the second', () => {
  const editor = linkEditor('See [[用户认证|019c0000-0000-7000-8000-000000000002]]')
  editor.placeCursorAfterLink()
  editor.press('Backspace')
  expect(editor.selectedText()).toContain('[[用户认证|')
  editor.press('Backspace')
  expect(editor.doc()).toBe('See ')
})
```

```rust
#[test]
fn rename_updates_labels_but_not_target_ids() {
    let fixture = LinkFixture::linked_notes("Old title");
    fixture.rename_target("New title").unwrap();
    assert!(fixture.source_markdown().contains("[[New title|"));
    assert!(fixture.source_markdown().contains(&fixture.target_id().to_string()));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/features/editor/internalLinks.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml --test links`.

Expected: FAIL because link decorations and repository repair are absent.

- [ ] **Step 3: Add CodeMirror atomic ranges and link indexing**

Parse persisted links into `Decoration.replace` widgets whose `inclusive` boundaries prevent partial edits. A first deletion command creates a `EditorSelection.range` over the stored link; a second deletion uses the normal transaction. Clicking resolves through the TypeScript note cache and falls back to `LinkPort.resolve`. Render an unresolved style when the UUID cannot be found.

On save, Rust extracts source/target/label rows into `note_links`. Rename writes referring Markdown atomically one file at a time, preserves IDs, and records any failed label refresh for retry. Backlinks query by target UUID.

```ts
export interface LinkPort {
  resolve(noteId: NoteId): Promise<NoteSummary | null>
  backlinks(noteId: NoteId): Promise<NoteSummary[]>
  renameTargetLabels(noteId: NoteId, title: string): Promise<{ updated: number; failedSourceIds: NoteId[] }>
}
```

- [ ] **Step 4: Verify link behavior**

Run: `pnpm test -- src/features/editor` and `cargo test --manifest-path src-tauri/Cargo.toml --test links`.

Expected: PASS for insertion, atomic selection/delete, click navigation, cache fallback, unresolved display, backlinks, rename, interrupted label repair, and Markdown reload.

- [ ] **Step 5: Verify the retrieval delivery gate and commit**

Run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `cargo test --manifest-path src-tauri/Cargo.toml`.

Expected: all exit 0.

```powershell
git add src/features/editor src/domain/ports.ts src-tauri
git commit -m "feat: connect notes with stable links"
```

---

### Task 11: Add persistent temporary captures and sticky-window state

**Files:**
- Create: `src/features/temporary/StickyWindow.tsx`
- Create: `src/features/temporary/StickyWindow.test.tsx`
- Create: `src-tauri/src/windows/mod.rs`
- Create: `src-tauri/src/windows/sticky.rs`
- Create: `src-tauri/src/commands/temporary.rs`
- Create: `src-tauri/tests/temporary_conversion.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: formal note repository primitives and `temporary_windows` schema.
- Produces: `create_temporary`, `save_temporary`, `show_temporary_window`, `hide_temporary_window`, `set_temporary_window_state`, and `list_temporary`.

- [ ] **Step 1: Write failing close-is-not-delete tests**

```tsx
it('closes the sticky window without offering delete, search, or conversion', async () => {
  const system = fakeSystemPort()
  render(<StickyWindow note={{ ...note('capture'), kind: 'temporary' }} system={system} />)
  expect(screen.queryByRole('button', { name: /删除|搜索|转为笔记/ })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '关闭便签' }))
  expect(system.hideTemporaryWindow).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/features/temporary/StickyWindow.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml --test temporary_conversion close`.

Expected: FAIL because temporary capture commands and UI are absent.

- [ ] **Step 3: Add temporary storage and window state**

Create temporary captures with UUIDv7 under `temporary/<uuid>/note.md`. Use the same atomic save path as formal notes. Persist visibility, position, dimensions, and always-on-top state separately. The sticky UI exposes drag, pin, compact more, close, editor body, and save status only. Theme color comes from global settings.

```rust
pub struct TemporaryWindowState {
    pub note_id: Uuid,
    pub visible: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub always_on_top: bool,
}
```

- [ ] **Step 4: Verify lifecycle behavior**

Run: `pnpm test -- src/features/temporary/StickyWindow.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml --test temporary_conversion close`.

Expected: PASS for create, autosave, hide/reopen, position/size restore, shared theme color, pin state, and absence of destructive/convert/search controls.

- [ ] **Step 5: Commit**

```powershell
git add src/features/temporary src-tauri/src/windows src-tauri/src/commands/temporary.rs src-tauri/src/lib.rs src-tauri/tests/temporary_conversion.rs
git commit -m "feat: persist temporary sticky notes"
```

---

### Task 12: Register the global shortcut and create multiple sticky windows

**Files:**
- Create: `src-tauri/src/platform/mod.rs`
- Create: `src-tauri/src/platform/windows.rs`
- Create: `src-tauri/src/platform/macos.rs`
- Create: `src-tauri/tests/shortcut.rs`
- Modify: `src-tauri/tests/support/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/domain/ports.ts`
- Modify: `src/infrastructure/tauri/client.ts`

**Interfaces:**
- Consumes: `create_temporary` and `show_temporary_window` from Task 11.
- Produces: `ShortcutService::{register,rebind,unregister}`, `ShortcutConflict`, one new capture/window per shortcut invocation, and test-only `ShortcutFixture` with an in-memory `ShortcutBackend`.

- [ ] **Step 1: Write failing shortcut lifecycle tests**

```rust
#[test]
fn every_trigger_creates_a_distinct_temporary_note_and_window_label() {
    let fixture = ShortcutFixture::new();
    fixture.trigger().unwrap();
    fixture.trigger().unwrap();
    let notes = fixture.temporary_notes();
    assert_eq!(notes.len(), 2);
    assert_ne!(notes[0].id, notes[1].id);
    assert_eq!(fixture.window_labels().len(), 2);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test shortcut`.

Expected: FAIL because the shortcut service does not exist.

- [ ] **Step 3: Add platform adapters and conflict reporting**

Register `CommandOrControl+Shift+Space` as the initial default. On every press, create a fresh temporary UUID and window label `temporary-<uuid>`. Rebinding first validates and registers the new accelerator; unregister the old binding only after the new one succeeds. Return a structured conflict error when the OS refuses registration.

```rust
pub trait ShortcutBackend: Send + Sync {
    fn register(&self, accelerator: &str) -> Result<(), ShortcutError>;
    fn unregister(&self, accelerator: &str) -> Result<(), ShortcutError>;
}
```

- [ ] **Step 4: Verify independent captures and rollback**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test shortcut`.

Expected: PASS for multiple invocations, unique labels, registration conflict, rebind rollback, app shutdown unregister, Windows adapter mapping, and macOS adapter mapping.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/platform src-tauri/src/lib.rs src-tauri/tests/shortcut.rs src/domain/ports.ts src/infrastructure/tauri
git commit -m "feat: add global capture shortcut"
```

---

### Task 13: Build the temporary inbox, multi-select, delete, and batch conversion

**Files:**
- Create: `src/features/temporary/TemporaryInbox.tsx`
- Create: `src/features/temporary/ConvertDialog.tsx`
- Create: `src/features/temporary/TemporaryInbox.test.tsx`
- Modify: `src/features/library/FolderTree.tsx`
- Modify: `src-tauri/src/commands/temporary.rs`
- Modify: `src-tauri/tests/temporary_conversion.rs`

**Interfaces:**
- Consumes: `list_temporary`, `listFolders`, and temporary note IDs.
- Produces: `delete_temporary(ids)`, `undo_delete(operationId)`, `convert_temporary({ ids, folderId }) -> BatchConversionResult`.

- [ ] **Step 1: Write failing multi-select and conversion tests**

```tsx
it('converts each selected capture into a separate note in one chosen folder', async () => {
  const temporary = fakeTemporaryPort(twoCaptures())
  render(<TemporaryInbox temporary={temporary} folders={folders()} />)
  await userEvent.click(screen.getByRole('checkbox', { name: '选择 发布前检查' }))
  await userEvent.click(screen.getByRole('checkbox', { name: '选择 接口异常处理' }))
  await userEvent.click(screen.getByRole('button', { name: '转为笔记' }))
  await userEvent.click(screen.getByRole('option', { name: '工作 / 项目 B' }))
  await userEvent.click(screen.getByRole('button', { name: '确认转换' }))
  expect(temporary.convert).toHaveBeenCalledWith({ ids: expect.any(Array), folderId: projectB })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/features/temporary/TemporaryInbox.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml --test temporary_conversion`.

Expected: FAIL because inbox and batch operations are absent.

- [ ] **Step 3: Add recoverable batch operations**

Derive each title from its first non-empty line, trim Markdown heading markers, normalize whitespace, and cap at 80 Unicode scalar values. Empty captures use localized `未命名笔记 YYYY-MM-DD HH-mm`. Convert each item in its own transaction while retaining UUID and moving assets. Return every success and failure explicitly.

Use the `BatchConversionResult` contract created in Task 2 without changing its field names.

Deletion moves selected directories to trash and returns an operation ID. An undo action restores all still-available items.

- [ ] **Step 4: Verify partial success and no-loss behavior**

Run: `pnpm test -- src/features/temporary` and `cargo test --manifest-path src-tauri/Cargo.toml --test temporary_conversion`.

Expected: PASS for single/multiple selection, common folder selection, title derivation, UUID retention, asset movement, partial failure reporting, delete, undo, and inbox refresh.

- [ ] **Step 5: Verify the desktop-capture delivery gate and commit**

Run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `cargo test --manifest-path src-tauri/Cargo.toml`.

Expected: all exit 0. On the current platform, manually open three shortcut windows, move/resize/pin them, restart the application, and confirm state restoration.

```powershell
git add src/features/temporary src/features/library/FolderTree.tsx src-tauri
git commit -m "feat: manage temporary note inbox"
```

---

### Task 14: Add application trash and 30-day recovery

**Files:**
- Create: `src/features/library/TrashView.tsx`
- Create: `src/features/library/TrashView.test.tsx`
- Create: `src-tauri/src/storage/trash.rs`
- Create: `src-tauri/tests/trash.rs`
- Modify: `src-tauri/tests/support/mod.rs`
- Modify: `src-tauri/src/commands/notes.rs`
- Modify: `src/features/library/FolderTree.tsx`

**Interfaces:**
- Consumes: formal and temporary note paths.
- Produces: `TrashPort`, commands `trash_notes`, `list_trash`, `restore_trash`, `purge_expired_trash`, `TrashEntry` retaining prior logical/physical locations, and test-only `TrashFixture` backed by `TestStore`.

- [ ] **Step 1: Write failing restoration tests**

```rust
#[test]
fn restore_returns_a_note_to_its_previous_folder_or_recovered_folder() {
    let fixture = TrashFixture::formal_note();
    let entry = fixture.trash().unwrap();
    assert_eq!(fixture.restore(entry.id).unwrap().folder_id, fixture.original_folder());
    fixture.trash_again_and_remove_original_folder();
    assert_eq!(fixture.restore_latest().unwrap().folder_name, "已恢复");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test trash`.

Expected: FAIL because trash metadata and recovery do not exist.

- [ ] **Step 3: Add trash manifests and cleanup policy**

Write one manifest per trashed item containing note UUID, kind, prior folder UUID, prior physical path, deletion time, and asset inventory. Move content before committing the deleted state. Purge only entries older than 30 days, never purge while a restore is active, and report failed purges without blocking startup.

```ts
export interface TrashEntry {
  noteId: NoteId
  kind: NoteKind
  title: string
  previousFolderId: FolderId | null
  deletedAt: string
}
export interface TrashPort {
  trash(ids: NoteId[]): Promise<{ operationId: string }>
  list(): Promise<TrashEntry[]>
  restore(ids: NoteId[]): Promise<void>
  undo(operationId: string): Promise<void>
}
```

```rust
#[derive(Serialize, Deserialize)]
pub struct TrashManifest {
    pub note_id: Uuid,
    pub kind: NoteKind,
    pub previous_folder_id: Option<Uuid>,
    pub previous_relative_path: String,
    pub deleted_at: DateTime<Utc>,
}
```

- [ ] **Step 4: Verify recovery and cleanup boundaries**

Run: `pnpm test -- src/features/library/TrashView.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml --test trash`.

Expected: PASS for formal/temporary restore, missing-folder fallback, asset restoration, immediate undo, 29-day retention, 31-day purge, and failed purge reporting.

- [ ] **Step 5: Commit**

```powershell
git add src/features/library src-tauri/src/storage/trash.rs src-tauri/src/commands/notes.rs src-tauri/tests/trash.rs
git commit -m "feat: recover deleted notes"
```

---

### Task 15: Add settings, unified theming, autostart, and window preferences

**Files:**
- Create: `src/features/settings/SettingsView.tsx`
- Create: `src/features/settings/SettingsView.test.tsx`
- Create: `src/features/settings/theme.ts`
- Create: `src/features/settings/theme.test.ts`
- Create: `src-tauri/src/commands/settings.rs`
- Create: `src-tauri/tests/settings.rs`
- Modify: `src/app/services.ts`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Tauri Store, autostart plugin, window preference service.
- Produces: `AppSettings`, `SettingsPort.load`, `SettingsPort.update`, `SettingsPort.reset`, theme CSS variables, and shortcut/autostart validation states.

- [ ] **Step 1: Write failing theme and settings tests**

```ts
it('uses one sticky-note color derived from the active application theme', () => {
  const vars = themeVariables({ theme: 'forest', stickyColorMode: 'follow-theme' })
  expect(vars['--sticky-color']).toBe(vars['--theme-note-accent'])
  expect(Object.keys(vars).some(key => key.includes('per-note'))).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/features/settings` and `cargo test --manifest-path src-tauri/Cargo.toml --test settings`.

Expected: FAIL because settings services and theme mapping do not exist.

- [ ] **Step 3: Add validated settings**

```ts
export interface AppSettings {
  theme: 'forest' | 'sand' | 'system'
  stickyColorMode: 'follow-theme'
  bodyFont: string
  codeFont: string
  fontSize: number
  lineHeight: number
  shortcut: string
  launchAtStartup: boolean
  defaultEditorMode: EditorMode
  autosaveDelayMs: number
  dataRoot: { mode: 'default' } | { mode: 'custom'; path: string }
}
```

Clamp font size to 12-28, line height to 1.2-2.2, and autosave delay to 150-2,000 ms. Apply shortcut and autostart changes transactionally: validate the system operation first, persist only on success, and leave prior behavior intact on failure. Reset uses explicit defaults and never deletes note data.

```ts
export interface SettingsPort {
  load(): Promise<AppSettings>
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  reset(): Promise<AppSettings>
  getStorageInfo(): Promise<{ root: string; noteBytes: number; assetBytes: number; trashBytes: number }>
  moveStorageRoot(destination: string): Promise<void>
}
```

Expose `get_storage_info() -> { root, noteBytes, assetBytes, trashBytes }` and `move_storage_root(destination)`. A root move pauses saves, copies into a fresh destination, verifies every relative path and byte count, opens/migrates the copied database, atomically switches the configured root, then offers cleanup of the old root only after the app successfully reopens the new one. Failure leaves the old root active and removes only the incomplete destination created by this operation.

- [ ] **Step 4: Verify settings and rollback**

Run: `pnpm test -- src/features/settings` and `cargo test --manifest-path src-tauri/Cargo.toml --test settings`.

Expected: PASS for load/defaults, bounds, theme propagation to every sticky window, shortcut conflict rollback, autostart failure rollback, column/window preference persistence, storage-size reporting, same-volume and cross-volume data-root moves, failed-copy rollback, and safe reset.

- [ ] **Step 5: Commit**

```powershell
git add src/features/settings src/app/services.ts src-tauri/src/commands/settings.rs src-tauri/src/lib.rs src-tauri/tests/settings.rs
git commit -m "feat: add application settings"
```

---

### Task 16: Add complete portable export

**Files:**
- Create: `src-tauri/src/commands/export.rs`
- Create: `src-tauri/src/storage/export.rs`
- Create: `src-tauri/tests/export.rs`
- Modify: `src-tauri/tests/support/mod.rs`
- Create: `src/features/settings/ExportLibrary.tsx`
- Create: `src/features/settings/ExportLibrary.test.tsx`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: logical folders, formal Markdown, assets, and a user-selected export root.
- Produces: `ExportPort.exportLibrary(destination) -> ExportReport`, Tauri command `export_library`, counts and explicit skipped/failed items, plus test-only `ExportFixture` backed by `TestStore`.

- [ ] **Step 1: Write failing export tests**

```rust
#[test]
fn export_materializes_readable_folders_markdown_and_assets() {
    let fixture = ExportFixture::linked_notes_with_image();
    let report = fixture.export().unwrap();
    assert_eq!(report.notes_exported, 2);
    assert!(fixture.output("工作/项目 B/登录流程.md").exists());
    assert!(fixture.output("工作/项目 B/登录流程-assets/screenshot.png").exists());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test export`.

Expected: FAIL because portable export is absent.

- [ ] **Step 3: Add safe deterministic export**

Validate the chosen destination and reject application-data descendants. Sanitize Windows/macOS reserved names, resolve duplicate titles with `Title (2).md`, rewrite asset references, keep internal IDs in links so exported notes remain recoverable, and write an `export-manifest.json` containing app version and ID-to-relative-path mappings.

```rust
pub struct ExportReport {
    pub notes_exported: usize,
    pub assets_exported: usize,
    pub renamed_paths: Vec<RenamedExportPath>,
    pub failed: Vec<ExportFailure>,
}
```

Mirror the report in TypeScript and expose it only through the domain port:

```ts
export interface ExportReport {
  notesExported: number
  assetsExported: number
  renamedPaths: Array<{ source: string; destination: string }>
  failed: Array<{ noteId: NoteId; message: string }>
}
export interface ExportPort {
  exportLibrary(destination: string): Promise<ExportReport>
}
```

- [ ] **Step 4: Verify cross-platform names and no-overwrite behavior**

Run: `pnpm test -- src/features/settings/ExportLibrary.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml --test export`.

Expected: PASS for nested folders, images, duplicate titles, Windows reserved names, macOS normalization, link retention, destination traversal rejection, cancellation, and explicit partial failures.

- [ ] **Step 5: Commit**

```powershell
git add src/features/settings/ExportLibrary.tsx src/features/settings/ExportLibrary.test.tsx src-tauri/src/commands/export.rs src-tauri/src/storage/export.rs src-tauri/src/lib.rs src-tauri/tests/export.rs
git commit -m "feat: export portable note libraries"
```

---

### Task 17: Add startup recovery, security tests, accessibility, and end-to-end flows

**Files:**
- Create: `src/shared/StatusNotice.tsx`
- Create: `src/shared/StatusNotice.test.tsx`
- Create: `src-tauri/src/storage/recovery.rs`
- Create: `src-tauri/tests/recovery.rs`
- Modify: `src-tauri/tests/support/mod.rs`
- Modify: `src-tauri/tests/security.rs`
- Create: `playwright.config.ts`
- Create: `e2e/note-flow.spec.ts`
- Create: `e2e/temporary-inbox.spec.ts`
- Create: `e2e/recovery.spec.ts`
- Modify: `src/styles/app.css`

**Interfaces:**
- Consumes: save markers, abandoned sibling temporary files, rebuild markers, all primary UI flows.
- Produces: `StartupRecoveryReport`, accessible status notices, keyboard-complete flows, regression E2E coverage, and test-only `RecoveryFixture` backed by `TestStore`.

- [ ] **Step 1: Write failing recovery and accessibility tests**

```rust
#[test]
fn startup_keeps_the_valid_highest_revision_and_quarantines_ambiguous_files() {
    let fixture = RecoveryFixture::document_and_two_temp_candidates();
    let report = fixture.recover().unwrap();
    assert_eq!(fixture.loaded_markdown(), "valid highest revision");
    assert_eq!(report.quarantined.len(), 1);
}
```

```tsx
it('announces a persistent save error and exposes retry to keyboard users', async () => {
  const retry = vi.fn()
  render(<StatusNotice state={{ status: 'error', message: '磁盘空间不足', retry }} />)
  expect(screen.getByRole('alert')).toHaveTextContent('磁盘空间不足')
  await userEvent.click(screen.getByRole('button', { name: '重试保存' }))
  expect(retry).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/shared/StatusNotice.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml --test recovery --test security`.

Expected: FAIL because startup recovery and shared status UI are absent.

- [ ] **Step 3: Add deterministic recovery and hardened boundaries**

Parse and validate each abandoned candidate, compare embedded UUID and revision, choose only a single unambiguous highest valid revision, and move all ambiguous candidates into a quarantine directory with a recovery report. On an unreadable SQLite database, rename it to a timestamped quarantine file and rebuild from Markdown plus `folders.json`; never rewrite Markdown during rebuild.

Add tests for traversal, symlink escape, unsafe HTML, malformed frontmatter, invalid image payloads, oversized command payloads, and renderer attempts to invoke commands outside configured Tauri capabilities. Add visible focus, reduced-motion CSS, icon labels, keyboard resize, and live save/error announcements.

- [ ] **Step 4: Add end-to-end acceptance flows**

```ts
test('creates, links, searches, reopens, and exports a note', async ({ page }) => {
  await page.getByRole('button', { name: '新建笔记' }).click()
  await page.getByRole('textbox').fill('# 登录流程\n\n[[用户认证]]')
  await expect(page.getByText('已保存')).toBeVisible()
  await page.getByRole('searchbox').fill('登录')
  await expect(page.getByRole('option', { name: /登录流程/ })).toBeVisible()
})
```

Cover temporary multi-select/convert/delete/undo and a simulated interrupted-save recovery in the other two E2E files.

- [ ] **Step 5: Run the full reliability suite and commit**

Run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`, and `cargo test --manifest-path src-tauri/Cargo.toml`.

Expected: all exit 0; keyboard-only smoke completes create, search, link navigation, temporary conversion, settings, trash restore, and export.

```powershell
git add src/shared src/styles/app.css src-tauri/src/storage/recovery.rs src-tauri/tests playwright.config.ts e2e
git commit -m "test: cover recovery and primary flows"
```

---

### Task 18: Package, sign, update, and verify Windows and macOS releases

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `scripts/generate-search-fixture.ts`
- Create: `scripts/workflow-config.test.ts`
- Create: `docs/release-checklist.md`
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the complete application and repository secrets configured by the release owner.
- Produces: CI checks, signed Windows/macOS artifacts, updater metadata, reproducible fixture generation, and a manual release checklist.

- [ ] **Step 1: Add a CI configuration test before the workflows**

```ts
// scripts/workflow-config.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('release workflows', () => {
  it('builds and tests on Windows and macOS', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    expect(workflow).toContain('windows-latest')
    expect(workflow).toContain('macos-latest')
    expect(workflow).toContain('cargo test')
    expect(workflow).toContain('pnpm test')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- scripts/workflow-config.test.ts`.

Expected: FAIL because CI workflows do not exist.

- [ ] **Step 3: Add CI and release workflows**

CI runs formatting, ESLint, TypeScript, Vitest, Cargo formatting/clippy/tests, UI build, and Tauri build on both `windows-latest` and `macos-latest`. Release runs only for signed version tags, reads signing/notarization secrets from repository secrets, produces Windows and macOS installers, generates updater signatures/metadata, and uploads checksums.

Configure updater public keys in the checked-in Tauri configuration; never store private keys, certificates, tokens, Apple credentials, or Windows signing credentials in the repository.

- [ ] **Step 4: Add the release checklist and fixture command**

`docs/release-checklist.md` contains exact checkboxes for:

```text
Windows: install, launch, shortcut conflict, three sticky windows, autostart, update, uninstall with data retained
macOS: signed/notarized install, launch, shortcut permission, three sticky windows, autostart, update, move to Applications
Both: 10,000-note fixture, search, backlinks, interrupted save, index rebuild, trash restore, portable export, keyboard navigation
```

Add `pnpm fixture:search --count 10000 --seed 20260730` and make the generator deterministic.

- [ ] **Step 5: Verify configurations locally**

Run: `pnpm test -- scripts/workflow-config.test.ts`, `pnpm fixture:search --count 10000 --seed 20260730`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, and `cargo test --manifest-path src-tauri/Cargo.toml`.

Expected: all commands exit 0 and the fixture generator reports exactly 10,000 notes.

- [ ] **Step 6: Run platform release candidates**

Run the release workflow for a prerelease tag. Complete every checkbox in `docs/release-checklist.md` on real Windows and macOS machines. Record installer filenames, checksums, OS versions, and failures in the release notes. A release is blocked if either platform is unsigned, not installable, or fails a primary flow.

- [ ] **Step 7: Commit**

```powershell
git add .github scripts package.json src-tauri/tauri.conf.json docs/release-checklist.md AGENTS.md
git commit -m "build: add cross platform release pipeline"
```

---

## Final Acceptance Gate

- [ ] Run `pnpm lint` and confirm exit 0.
- [ ] Run `pnpm typecheck` and confirm exit 0.
- [ ] Run `pnpm test` and confirm exit 0.
- [ ] Run `pnpm build` and confirm exit 0.
- [ ] Run `pnpm test:e2e` and confirm exit 0.
- [ ] Run `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and confirm exit 0.
- [ ] Run `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` and confirm exit 0.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml` and confirm exit 0.
- [ ] Complete `docs/release-checklist.md` on real Windows and macOS release candidates.
- [ ] Confirm a full export opens as readable nested Markdown and images outside the application.
- [ ] Confirm deleting `index.sqlite` and rebuilding does not change any Markdown or asset bytes.
- [ ] Confirm the application remains fully usable while signed out and offline.
