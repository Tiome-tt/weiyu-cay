# Search Performance Optimization Design

## Status

Approved in conversation on 2026-08-27 for first-phase implementation.

## Goal

Reduce the latency and database work of note search while preserving the existing search API, result ordering, result contents, validation rules, and durable-storage behavior.

## Scope

This phase includes only two bounded optimizations:

1. Replace per-result folder breadcrumb and tag queries with bounded batch queries followed by in-memory assembly.
2. Avoid allocating a complete Unicode character vector when an excerpt already fits within its maximum length.

This phase does not change note identity, Markdown parsing, the SQLite schema, IPC payloads, search ranking, search debounce behavior, list loading, React component structure, or storage recovery behavior.

## Current bottleneck

Both text search and tag search first fetch a bounded set of result rows. For every result, the current implementation then performs one query per folder level to build the breadcrumb and one query to load tags. A result set of 100 notes therefore performs result enrichment work proportional to the number of results and folder depth, in addition to the main search query.

The excerpt helper also converts the complete plain-text body to a `Vec<char>` before checking whether clipping is needed. This allocates and scans more data than necessary for short results.

## Design

### Search context batching

Keep the existing result-row SQL and its ordering intact. After rows are collected:

- Collect unique result note IDs and folder IDs.
- Load all folder records needed by the result set with one parameterized query.
- Load all tags for the result note IDs with one parameterized query, retaining the current order of `normalized_name, id`.
- Build a read-only in-memory context keyed by the existing SQLite blob IDs.
- Assemble each `SearchResult` from the context in the original result order.
- Build folder breadcrumbs in Rust from the loaded folder map. Preserve cycle detection, invalid UUID validation, and missing-parent errors from the current implementation.

The implementation must use parameterized SQL placeholders. It must handle an empty result set without issuing an invalid `IN ()` query and must stay within SQLite's parameter limit for the current maximum result count of 100.

The public `SearchRepository::search_text` and `SearchRepository::search_tag` signatures remain unchanged. Search limits remain clamped to 1–100, and no result fields are removed or renamed.

### Efficient excerpt clipping

First determine whether the plain text contains more than the requested maximum number of Unicode scalar values. Return the original string immediately when it fits. Only allocate the character vector for text that actually needs clipping. Preserve the existing ellipsis placement, Unicode boundary behavior, case-insensitive ASCII fallback, and maximum-length contract.

## Correctness and failure behavior

- Search result ordering, scores, titles, tags, breadcrumbs, and excerpts must remain unchanged for existing fixtures.
- Tag display order remains normalized-name order followed by tag ID order.
- Folder cycles remain database errors rather than being silently truncated.
- Missing or malformed folder IDs remain database errors.
- SQL failures remain mapped to user-safe `CommandError::database` errors.
- No content files or metadata are written by search.
- No migration is required.

## Files

- Modify `src-tauri/src/commands/search.rs` for batched enrichment and the excerpt allocation guard.
- Modify `src-tauri/tests/search.rs` with regression coverage for complete result context and excerpt behavior.
- Optionally modify `src-tauri/benches/search.rs` only if a benchmark assertion or scenario is needed to make the improvement measurable; do not alter the existing benchmark contract.

## Verification

Run the focused Rust search tests first, then `cargo check --manifest-path src-tauri/Cargo.toml`. Re-run the existing 10,000-note search benchmark after compilation is available. The frontend baseline already passed with 459 tests and TypeScript type-checking before this design was approved; frontend suites are not required for this Rust-only change unless touched files expand beyond the stated scope.

## Compatibility

There is no schema, migration, IPC, persisted-data, or user-visible behavior change. The optimization is an implementation detail inside the search repository.
