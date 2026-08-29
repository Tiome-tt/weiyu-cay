# Weiyu Worktree Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `codex/weiyu-latest` 中已完成的编辑器、文件夹树、布局和样式改动安全迁移到 `master`，保留当前主线的存储安全、恢复、安装器和欢迎引导行为，并发布经过验证的 Windows 版本。

**Architecture:** 以当前 `master` 为唯一发布基线，逐组迁移 React/TypeScript UI 与其明确依赖；不直接采用 worktree 中重写的 Rust 存储、回收站、恢复和 WiX 安装器文件。每组改动先用现有测试或新增回归测试验证，再合并到集成提交。

**Tech Stack:** React, TypeScript, Vite, CodeMirror 6, Tauri 2, Rust, SQLite, Vitest, Cargo.

**Spec:** `docs/superpowers/specs/2026-07-30-simple-notes-design.md`

## Global Constraints

- Core note features must work without an account or network connection.
- Markdown and assets are durable content. SQLite is an index and metadata store that can be rebuilt from the files.
- Save Markdown by writing a sibling temporary file, flushing it, and atomically replacing the previous file only after a successful write.
- React components render state and dispatch domain actions; they must not access the filesystem, SQLite, or unrestricted Tauri APIs directly.
- Use `微屿` as the primary user-visible name and keep technical compatibility identifiers stable.
- Never commit secrets, local application data, generated note libraries, signing material, or `.superpowers/` brainstorming files.

### Task 1: Create integration checkpoint and inventory

**Files:**
- Modify: none
- Test: none

- [ ] **Step 1: Create a rollback branch from current `master`.**

Run:

```powershell
git switch -c codex/weiyu-integration
```

Expected: branch starts at the current published commit and preserves the clean working tree.

- [ ] **Step 2: Record the worktree delta by subsystem.**

Run:

```powershell
git diff --stat master..codex/weiyu-latest -- src src-tauri package.json pnpm-lock.yaml
```

Expected: React/TypeScript changes are considered for migration; Rust storage/recovery/trash and installer changes remain excluded until separately reviewed.

- [ ] **Step 3: Commit the empty checkpoint.**

Run:

```powershell
git commit --allow-empty -m "chore: checkpoint Weiyu worktree integration"
```

Expected: a named checkpoint exists before any file migration.

### Task 2: Migrate UI contracts and dependencies

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/domain/ports.ts`
- Modify: `src/domain/model.ts`
- Modify: `src/infrastructure/tauri/ports.ts`
- Test: `src/infrastructure/tauri/client.test.ts`, `src/infrastructure/tauri/capabilities.test.ts`

- [ ] **Step 1: Copy only dependency and port changes that are compatible with master.**

Use the worktree versions as reference, but retain master signatures for delete operations, startup-guide completion, and storage-safe result types. Add only CodeMirror/Lezer packages required by migrated editor code.

- [ ] **Step 2: Run focused contract tests.**

Run:

```powershell
pnpm vitest run src/infrastructure/tauri/client.test.ts src/infrastructure/tauri/capabilities.test.ts
```

Expected: all focused port and capability tests pass.

- [ ] **Step 3: Commit the contract migration.**

```powershell
git add package.json pnpm-lock.yaml src/domain/model.ts src/domain/ports.ts src/infrastructure/tauri/ports.ts src/infrastructure/tauri/client.test.ts src/infrastructure/tauri/capabilities.test.ts
git commit -m "feat: migrate compatible Weiyu UI contracts"
```

### Task 3: Migrate editor behavior and styling

**Files:**
- Modify: `src/features/editor/EditorPane.tsx`
- Modify: `src/features/editor/MarkdownSource.tsx`
- Modify: `src/features/editor/MarkdownPreview.tsx`
- Modify: `src/features/editor/internalLinks.ts`
- Modify: `src/features/editor/markdownActions.ts`
- Create or modify: `src/features/editor/InternalLinkTree.tsx`, `documentMarkdown.ts`, `documentWidgets.ts`, `markdownPipeline.ts`
- Modify: `src/features/editor/*.test.ts*`
- Modify: `src/styles/app.css`, `src/styles/main-window.css`, `src/styles/tokens.css`

- [ ] **Step 1: Run the current editor tests before migration.**

```powershell
pnpm vitest run src/features/editor
```

Expected: master baseline is green.

- [ ] **Step 2: Migrate editor files without changing Tauri/storage boundaries.**

Preserve `NoteDocument`, autosave, asset, link, and external-link ports from master. Keep source, split, and preview as the three supported editor modes.

- [ ] **Step 3: Run editor tests and type-check.**

```powershell
pnpm vitest run src/features/editor
pnpm typecheck
```

Expected: no editor test failures and TypeScript exits 0.

- [ ] **Step 4: Commit the editor migration.**

```powershell
git add src/features/editor src/styles/app.css src/styles/main-window.css src/styles/tokens.css
git commit -m "feat: migrate Weiyu document editor experience"
```

### Task 4: Migrate library navigation and temporary-note presentation

**Files:**
- Modify: `src/features/library/FolderTree.tsx`
- Modify: `src/features/library/LibraryLayout.tsx`
- Modify: `src/features/library/NoteList.tsx`
- Modify: `src/features/library/NoteOutline.tsx`
- Modify: `src/features/library/TrashView.tsx`
- Modify: `src/features/library/useLibrary.ts`
- Modify: `src/features/temporary/TemporaryInbox.tsx`, `ConvertDialog.tsx`, `StickyWindow.tsx`
- Modify: corresponding `*.test.tsx` files

- [ ] **Step 1: Write or update failing regression tests for folder tree disclosure and guide navigation.**

Tests must assert that folder selection, note selection, deletion/undo, and startup-guide navigation still use master port contracts.

- [ ] **Step 2: Migrate the compatible React components.**

Do not migrate worktree Rust changes that remove recoverable trash operations or alter startup-guide commands.

- [ ] **Step 3: Run focused library and temporary tests.**

```powershell
pnpm vitest run src/features/library src/features/temporary
```

Expected: all focused tests pass.

- [ ] **Step 4: Commit the library migration.**

```powershell
git add src/features/library src/features/temporary
 git commit -m "feat: migrate Weiyu library navigation and capture UI"
```

### Task 5: Repair integration regressions and verify the full application

**Files:**
- Modify: only files identified by failing tests in `src/app`, `src/features/library`, and `src/features/editor`
- Test: affected test files first, then all frontend tests

- [ ] **Step 1: Run the full frontend suite and capture every failure.**

```powershell
pnpm test
```

Expected: any failure is fixed in production code or its stale assertion, never hidden by weakening the contract.

- [ ] **Step 2: Run lint, type-check, and full frontend tests.**

```powershell
pnpm lint
pnpm typecheck
pnpm test
```

Expected: all commands exit 0.

- [ ] **Step 3: Run Rust checks affected by the preserved backend boundary.**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml -j 1
```

Expected: all Rust tests pass; permission-dependent tests may remain ignored by their existing annotations.

### Task 6: Build and release Windows 1.0.0

**Files:**
- Modify: none beyond verified source changes
- Test: production build and release asset verification

- [ ] **Step 1: Build the Windows bundles.**

```powershell
pnpm tauri build
```

Expected: NSIS and MSI bundles are generated from the integration commit.

- [ ] **Step 2: Compute SHA256 hashes and compare them with uploaded assets.**

```powershell
Get-FileHash src-tauri/target/release/bundle/nsis/weiyu-cay_1.0.0_x64-setup.exe -Algorithm SHA256
Get-FileHash src-tauri/target/release/bundle/msi/weiyu-cay_1.0.0_x64_en-US.msi -Algorithm SHA256
```

- [ ] **Step 3: Replace the prerelease only after all checks pass.**

Delete and recreate `windows-v1.0.0` on `Tiome-tt/weiyu-cay`, targeting the full integration commit SHA, with exactly the EXE and MSI assets. Verify tag SHA, release state, asset sizes, and GitHub SHA256 digests.

- [ ] **Step 4: Final cleanliness check.**

```powershell
git status --short
git diff --check
```

Expected: no uncommitted source changes and no whitespace errors.