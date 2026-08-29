# Search Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce search latency by eliminating per-result metadata queries and unnecessary excerpt allocations without changing search behavior.

**Architecture:** Keep `SearchRepository::search_text` and `search_tag` public contracts and result-row SQL unchanged. Batch-load tags and folder records for the bounded result set, assemble breadcrumbs and result fields in memory, and keep all validation/error behavior in the repository layer.

**Tech Stack:** Rust 2021, rusqlite, SQLite FTS5, Criterion, cargo test.

**Spec:** `docs/superpowers/specs/2026-08-27-search-performance-optimization-design.md`

## Global Constraints

- Core note features must work without an account or network connection.
- Markdown and assets are durable content. SQLite is an index and metadata store that can be rebuilt from the files.
- Search limits remain clamped to 1–100 and the public search signatures do not change.
- Search result ordering, scores, titles, tags, breadcrumbs, and excerpts remain unchanged.
- SQL statements use parameters; no user input is interpolated into executable SQL.
- No schema, migration, IPC, persisted-data, or user-visible behavior change.
- A failed content or index operation must retain the previous valid content.

### Task 1: Batch search context and efficient excerpts

**Files:**
- Modify: `src-tauri/src/commands/search.rs`
- Modify: `src-tauri/tests/search.rs`

**Interfaces:**
- Consumes: existing `TextSearchRow`, `SearchResult`, `search_text`, and `search_tag` behavior.
- Produces: private `SearchContext` helpers used by both search methods; no public API changes.

- [ ] **Step 1: Add a regression test for complete multi-result context**

Extend `src-tauri/tests/search.rs` with a test that creates multiple matching notes across the seeded folder hierarchy, gives each note distinct tags, and asserts every returned result has its original tags and full folder breadcrumb in the same result order. Keep the assertions on returned `SearchResult` fields rather than implementation details.

- [ ] **Step 2: Run the focused test to establish the current behavior**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test search text_search_is_literal_ranked_filtered_and_returns_bounded_context -- --exact
```

Expected: PASS on the existing implementation. This records the behavior that the batch implementation must preserve.

- [ ] **Step 3: Add the excerpt allocation guard test**

Add a direct unit test in `src-tauri/src/commands/search.rs` under a test module for `excerpt` that asserts a short Unicode string is returned unchanged and a string at the clipping boundary remains within the existing maximum contract. Reuse the current `EXCERPT_LENGTH` behavior and do not expose a new public function.

- [ ] **Step 4: Run the new excerpt test before implementation**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::search::tests::excerpt -- --nocapture
```

Expected: PASS because the current excerpt behavior is already correct; the test protects behavior while the allocation strategy changes.

- [ ] **Step 5: Implement batched tags and folders**

In `src-tauri/src/commands/search.rs`:

1. Add private `FolderRecord { name: String, parent_id: Option<Vec<u8>> }` and `SearchContext { folders: HashMap<Vec<u8>, FolderRecord>, tags: HashMap<Vec<u8>, Vec<String>> }` types.
2. Add `load_search_context(connection, rows)` that returns an empty context for no rows, loads all folders with one query, and loads all result-note tags with one parameterized `IN` query. Use the existing tag ordering `t.normalized_name, t.id`.
3. Add `SearchContext::breadcrumb(folder_id)` that walks the in-memory folder map, preserves cycle detection with a `HashSet`, validates stored folder UUID blobs through `valid_folder_blob`, returns the same missing-folder database error, and reverses the collected names.
4. Replace the per-result calls to `folder_breadcrumb` and `note_tags` in both `search_text` and `search_tag` with one context load and in-memory lookups. Preserve the original row order and all score/excerpt calculations.
5. Keep every SQL value parameterized. Generate placeholders only from the bounded, internally collected row count; never insert user query text into SQL.

- [ ] **Step 6: Implement the excerpt fast path**

Change `excerpt` so it first checks whether `plain_text.chars().nth(maximum)` is absent. If the text fits, return `plain_text.to_owned()` without allocating a character vector. Only collect characters after confirming clipping is needed, preserving the existing ellipsis and Unicode slicing logic exactly.

- [ ] **Step 7: Run focused Rust tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test search
cargo test --manifest-path src-tauri/Cargo.toml commands::search::tests::excerpt -- --nocapture
```

Expected: all search integration tests and excerpt unit tests pass with zero failures.

- [ ] **Step 8: Run Rust type/build verification**

Run:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: exit code 0 with no compilation errors.

- [ ] **Step 9: Inspect the final diff**

Run:

```powershell
git diff --check
git diff -- src-tauri/src/commands/search.rs src-tauri/tests/search.rs
```

Confirm only the planned Rust implementation and test files changed; do not stage or alter unrelated existing user changes.

- [ ] **Step 10: Commit the focused implementation**

```powershell
git add src-tauri/src/commands/search.rs src-tauri/tests/search.rs
git commit -m "perf: batch search result metadata"
```
