# AGENTS.md

## Project overview

Cay (微屿) is a local-first Markdown note application for Windows and macOS. The product favors a small, reliable feature set over an all-in-one workspace. Users can work fully offline without an account. A future account will be optional and used only for synchronization.

Read `docs/superpowers/specs/2026-07-30-simple-notes-design.md` before changing product behavior or architecture. Keep that specification and this file aligned when an approved design decision changes.

## Brand naming

- Use `微屿` as the primary user-visible name in the application UI, native window titles, installers, system menus, and Chinese product copy.
- Use `临时便笺` for the Chinese temporary sticky-note feature name; use `便笺` in short action labels.
- Use `Cay` in English prose and English release titles. When a bilingual first mention is useful, write `Cay (微屿)`.
- Keep technical compatibility identifiers such as `app.simplenotes.desktop`, the `simple-notes` package/crate name, `.simple-notes-*` file prefixes, command names, and persisted keys stable unless an approved migration explicitly changes them.

## Planned technology

- Tauri 2 for desktop windows, operating-system integration, packaging, and privileged commands.
- React, TypeScript, and Vite for the UI.
- CodeMirror 6 for Markdown source editing.
- SQLite for metadata, tags, links, window state, and rebuildable search indexes.
- Markdown files and image assets are the durable note content.
- `pnpm` is the JavaScript package manager.

Do not replace the stack or add a second state, editor, database, styling, or component framework without an approved design change.

## Product invariants

- Core note features must work without an account or network connection.
- Markdown and assets are durable content. SQLite is an index and metadata store that can be rebuilt from the files.
- Every note and temporary capture has an immutable UUIDv7. A title, folder, or file-path change must never break an internal link.
- The persisted internal-link form is `[[Visible title|UUID]]`; the editor displays only `[[Visible title]]` as an atomic decoration.
- Inside a persisted link label, `\`, `|`, `[`, and `]` are escaped as `\\`, `\|`, `\[`, and `\]`; TypeScript and Rust must parse and serialize this grammar identically.
- Closing a sticky-note window hides it; it does not delete the temporary capture.
- Temporary captures are converted or deleted only from the main application's temporary inbox.
- Sticky notes use one shared theme color, not per-note colors.
- Destructive actions must be recoverable through the application trash or an immediate undo path.
- Never make SQLite the only copy of note text or image content.
- Never silently discard an unsupported Markdown construct during parse/serialize operations.

## Architecture boundaries

- React components render state and dispatch domain actions. They must not access the filesystem, SQLite, or unrestricted Tauri APIs directly.
- TypeScript domain services own note, folder, link, search, temporary-capture, and settings behavior.
- Tauri commands form the narrow privileged boundary for filesystem, SQLite, window, shortcut, autostart, export, and update operations.
- Keep platform-specific Windows and macOS behavior behind adapters.
- Prefer small modules with one responsibility and explicit typed interfaces.
- Validate all paths and identifiers again in Rust. Renderer-side validation alone is insufficient.

## Data-safety rules

- Save Markdown by writing a sibling temporary file, flushing it, and atomically replacing the previous file only after a successful write.
- Update SQLite indexes only after durable content succeeds. A failed content write must not publish new index state.
- Use transactions for multi-row metadata changes and for each item in a batch temporary-note conversion.
- Keep all resolved paths inside the configured application data or export root. Reject traversal and symlink escapes.
- Sanitize pasted-image names, verify image types, and generate collision-resistant filenames.
- Preserve the previous valid content when disk-full, permission, parsing, migration, or index failures occur.
- Treat index rebuilds as normal recovery operations and test them.
- Never log note bodies, authentication tokens, or local absolute paths in production telemetry.

## UI rules

- The main window uses resizable folder-with-inline-notes, current-note outline, and editor columns. Folder notes expand naturally and scroll with the complete tree; the collapsed outline shows only its label, without counts. Outline entries follow the preview Markdown grammar and exclude code-block contents. Dividers are visually quiet; hovering changes the cursor and highlights the boundary. Double-click restores the default proportion.
- The editor supports exactly three primary views in the MVP: source, split source/preview, and preview.
- Note rows do not expose hover delete buttons. Keep recoverable deletion in the pointer/keyboard context menu, with undo feedback outside the folder tree flow. New default table headers must avoid existing names without renaming user content.
- View controls live in the editor title toolbar, not the global application bar.
- The editor block “+” menu and editor context menu expose the same insertion actions, including a searchable internal-link picker that excludes the current note.
- Show non-empty note tags beside the last-edited metadata. Icon-only inline formatting controls expose visible hover labels and accessible names.
- New-note and move destinations offer actual folders only. Moving a note updates both source and destination inline lists immediately; preserve compatibility with existing root-level content.
- Keep the visual language warm, rounded, and nature-inspired, while preserving high contrast and dense-content readability.
- Do not copy Nintendo assets or directly use `animal-island-ui`; its CC BY-NC license prohibits commercial use. Build an original design system.
- Keyboard operation, visible focus, reduced motion, and adequate color contrast are required.

## Code style

- Enable TypeScript strict mode. Do not introduce `any` to bypass a design or typing problem.
- Prefer named domain types and pure functions for parsing, normalization, and mapping.
- Keep React components focused; move persistence and domain behavior into services or hooks with explicit contracts.
- In Rust, return structured, user-safe errors across the Tauri boundary and retain source errors for local diagnostics.
- Use stable, documented dependencies and the smallest dependency set that solves the task.
- Add comments for invariants and non-obvious safety decisions, not for restating code.

## Expected development commands

After the application is scaffolded, keep these root scripts working and update this section if a command changes:

- Install dependencies: `pnpm install`
- Run the desktop app: `pnpm tauri dev`
- Run the web UI alone: `pnpm dev`
- Lint: `pnpm lint`
- Type-check: `pnpm typecheck`
- Run TypeScript tests: `pnpm test`
- Generate the deterministic search fixture: `pnpm fixture:search --count 10000 --seed 20260730`
- Run Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`
- Build the UI: `pnpm build`
- Build the desktop app: `pnpm tauri build`

The checked-in Tauri configuration is intentionally fail-closed for updater artifacts: it contains no updater endpoint or public key and does not create updater artifacts. The signed tag release workflow validates release-owner secrets, writes updater-only JSON beneath the runner temporary directory, and supplies it with Tauri's `--config` build argument without rewriting the checked-out configuration. Never replace this with a placeholder key or endpoint.

Release candidates and stable releases remain drafts after automated gates. RC-only builds use the owner-controlled, non-secret, version-independent `RELEASE_STAGING_ENDPOINT/latest.json`, so a lower installed RC can discover a higher staged RC; the workflow requires an existing baseline manifest and mirrors exact signed draft assets through the owner-controlled upload API using only `RELEASE_STAGING_UPLOAD_TOKEN`. Stable builds use GitHub `releases/latest` only. If no channel-configured RC exists, the owner must first publish a lower signed baseline built for that channel. Never expose tokens, GitHub draft URLs, or signing material through staging. Updater checks, download/install, and restart are explicit main-window actions through typed services; do not add background or silent update installation.

Do not claim a command passes unless it was run in the current worktree. If scaffolding has not created a command yet, state that clearly instead of inventing output.

## Testing requirements

- Verification must be proportional to the risk and scope of the change. Default to the smallest focused command that proves the changed behavior.
- Do not automatically run the complete frontend suite, complete Rust suite, E2E suite, production build, desktop bundle, or 10,000-note fixture after every task.
- For documentation or copy-only changes, use `git diff --check` plus a directly related contract test when one exists. Do not compile the application merely because text changed.
- For React or TypeScript changes, run the affected Vitest file or test name first. Add `pnpm typecheck` when types or production TypeScript changed; run lint or a production build only when the touched code or integration boundary makes them relevant.
- For Rust changes, run the affected unit or integration test and `cargo check` for the touched crate. Run Clippy when production Rust changed. Reserve the complete Rust suite for cross-cutting storage, recovery, migration, security, concurrency, or release-critical changes.
- Run the 10,000-note fixture only when search, indexing, index rebuild, parsing that feeds the index, or relevant performance behavior changes.
- Run Windows/macOS platform smoke tests when platform integration code changes or for a release candidate, not for unrelated UI text, documentation, or domain-only work.
- Do not repeat a command that already passed on the same code unless a later change can affect its result. Reuse fresh focused evidence and state which broader checks were intentionally skipped.
- If the user explicitly requests reduced verification, honor that scope unless skipping a check would leave a concrete data-loss, security, or release-blocking risk; explain that specific risk before expanding the checks.
- Write or update tests before implementation for every behavior change and bug fix.
- Unit-test frontmatter, tag normalization, UUID handling, link parsing/rendering, title derivation, and safe filename generation.
- Integration-test atomic saves, crash leftovers, image moves, trash recovery, batch conversion, migrations, and full index rebuilds.
- Editor tests must cover all three views, atomic two-step link deletion, link-title refresh, scroll preservation, and split-view synchronization.
- UI tests must cover resize boundaries, minimum widths, multi-selection, undo deletion, and window-state restoration.
- Before releasing, cover global shortcuts, multiple sticky windows, always-on-top behavior, autostart, installers, signing, and updates on both Windows and macOS.

## Scope discipline

The MVP excludes cloud sync, required login, mobile apps, collaboration, AI writing, plugins, OCR, web clipping, databases-as-notes, and Git integration. Do not add adjacent features while implementing an approved task. Design future sync through stable IDs and explicit service boundaries, but do not build it early.

## Git and review

- Preserve unrelated user changes.
- Keep commits focused and use imperative commit subjects.
- Run the relevant lint, type-check, unit, integration, and build checks before declaring work complete.
- Describe data migrations, compatibility impact, and Windows/macOS verification in reviews.
- Never commit secrets, local application data, generated note libraries, signing material, or `.superpowers/` brainstorming files.
