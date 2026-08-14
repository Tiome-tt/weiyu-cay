# 微屿品牌改名实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有用户可见的 “Simple Notes” 品牌统一为“微屿”，在英文材料中使用 “Cay”，同时保证现有数据目录、内部协议和笔记完全兼容。

**Architecture:** TypeScript 通过一个只读品牌常量模块统一主界面文案；Rust 通过一个品牌常量模块统一原生窗口和导出目录；Tauri 配置仍是安装器与主窗口显示名的权威来源。内部标识、包名、恢复文件前缀和数据库格式不改，并由合同测试锁定。

**Tech Stack:** React、TypeScript、Vitest、Tauri 2、Rust、Cargo integration tests、Vite。

## Global Constraints

- 主窗口、设置页、便签窗口、浏览器标题、安装器产品名和系统菜单显示“微屿”。
- 英文介绍和必须使用英文的材料使用 “Cay”；普通中文界面不并列显示英文名。
- 品牌短句固定为“每个念头，都是一座小岛。”，仅在未选中笔记的欢迎状态出现一次。
- `app.simplenotes.desktop`、crate/package 名 `simple-notes`、`.simple-notes-*` 文件前缀、E2E 存储键和已有协议保持不变。
- 不新增依赖、网络字体、第三方商标素材、数据迁移或功能。
- 每个行为变更先获得失败测试，再写最小实现。

---

### Task 1: TypeScript 品牌合同与主界面文案

**Files:**
- Create: `src/shared/brand.ts`
- Create: `src/shared/brand.test.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/features/library/FolderTree.tsx`
- Modify: `src/features/library/LibraryLayout.tsx`
- Modify: `src/features/library/LibraryLayout.test.tsx`
- Modify: `src/features/settings/SettingsView.tsx`
- Modify: `src/features/settings/SettingsView.test.tsx`
- Modify: `index.html`

**Interfaces:**
- Produces: `APP_NAME: '微屿'`, `APP_ENGLISH_NAME: 'Cay'`, `APP_TAGLINE: '每个念头，都是一座小岛。'`.
- Consumes: existing React components and accessible-role tests; no persistence or service interface changes.

- [ ] **Step 1: Write failing brand contract and UI tests**

```ts
// src/shared/brand.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_ENGLISH_NAME, APP_NAME, APP_TAGLINE } from './brand'

describe('brand contract', () => {
  it('uses the approved Chinese-first identity', () => {
    expect(APP_NAME).toBe('微屿')
    expect(APP_ENGLISH_NAME).toBe('Cay')
    expect(APP_TAGLINE).toBe('每个念头，都是一座小岛。')
  })

  it('uses the Chinese name in the HTML title', () => {
    expect(readFileSync('index.html', 'utf8')).toContain('<title>微屿</title>')
  })
})
```

Update `App.test.tsx` to query `getByRole('application', { name: '微屿' })`, update restart copy to contain `重新启动微屿`, and add this assertion to the existing empty-library test in `LibraryLayout.test.tsx`:

```ts
expect(screen.getByText('每个念头，都是一座小岛。')).toBeVisible()
```

Add a settings assertion:

```ts
expect(screen.getByRole('dialog', { name: '设置' })).toHaveTextContent('微屿')
expect(screen.queryByText('Simple Notes')).not.toBeInTheDocument()
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/shared/brand.test.ts src/app/App.test.tsx src/features/library/LibraryLayout.test.tsx src/features/settings/SettingsView.test.tsx
```

Expected: FAIL because `src/shared/brand.ts` does not exist and current UI/HTML still contain “Simple Notes”.

- [ ] **Step 3: Add the brand constants and use them in React**

```ts
// src/shared/brand.ts
export const APP_NAME = '微屿' as const
export const APP_ENGLISH_NAME = 'Cay' as const
export const APP_TAGLINE = '每个念头，都是一座小岛。' as const
```

Import `APP_NAME` in `App.tsx`, `FolderTree.tsx`, and `SettingsView.tsx`. Replace the application ARIA label, visible headings, restart/update copy, and storage-move warnings with the constant. In `LibraryLayout.tsx`, render the approved tagline only in the existing `document === null` placeholder:

```tsx
<div className="content-placeholder">
  <span aria-hidden="true" className="content-placeholder__leaf">⌁</span>
  <p>{APP_TAGLINE}</p>
  <p>选择一篇笔记开始阅读。</p>
</div>
```

Change `index.html` to `<title>微屿</title>`.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/shared/brand.test.ts src/app/App.test.tsx src/features/library/LibraryLayout.test.tsx src/features/settings/SettingsView.test.tsx
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src index.html
```

Expected: all selected tests pass; TypeScript and ESLint exit 0.

- [ ] **Step 5: Commit**

```powershell
git add index.html src/shared/brand.ts src/shared/brand.test.ts src/app/App.tsx src/app/App.test.tsx src/features/library/FolderTree.tsx src/features/library/LibraryLayout.tsx src/features/library/LibraryLayout.test.tsx src/features/settings/SettingsView.tsx src/features/settings/SettingsView.test.tsx
git commit -m "feat: apply Weiyu interface branding"
```

---

### Task 2: Tauri 产品名、原生窗口和兼容标识

**Files:**
- Create: `src-tauri/src/brand.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/windows/sticky.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/tests/security.rs`

**Interfaces:**
- Produces: `crate::brand::APP_NAME` for native user-visible titles.
- Preserves: `identifier = "app.simplenotes.desktop"`, updater fail-closed object, artifact generation disabled.

- [ ] **Step 1: Extend the fail-closed configuration test before changing config**

Add these assertions to `checked_in_updater_configuration_is_a_valid_fail_closed_plugin_object` or a neighboring named test:

```rust
assert_eq!(config["productName"], "微屿");
assert_eq!(config["app"]["windows"][0]["title"], "微屿");
assert_eq!(config["identifier"], "app.simplenotes.desktop");
assert_eq!(config["bundle"]["createUpdaterArtifacts"], false);
```

Add a unit test in the new brand module:

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn native_brand_uses_the_approved_primary_name() {
        assert_eq!(super::APP_NAME, "微屿");
    }
}
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test security checked_in_updater_configuration_is_a_valid_fail_closed_plugin_object -- --exact
```

Expected: FAIL because `productName` and the main window title are still “Simple Notes”.

- [ ] **Step 3: Implement native brand constants and configuration**

```rust
// src-tauri/src/brand.rs
pub const APP_NAME: &str = "微屿";
```

Declare `mod brand;` in `src-tauri/src/lib.rs`, replace `.title("Simple Notes")` with `.title(crate::brand::APP_NAME)` in `sticky.rs`, and update only these Tauri JSON values:

```json
{
  "productName": "微屿",
  "identifier": "app.simplenotes.desktop",
  "app": { "windows": [{ "title": "微屿" }] }
}
```

Do not change updater keys, bundle flags, package/crate names, capability names, or the identifier.

- [ ] **Step 4: Run native focused verification**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib brand::tests::native_brand_uses_the_approved_primary_name -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --test security checked_in_updater_configuration_is_a_valid_fail_closed_plugin_object -- --exact
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all commands exit 0 and the updater configuration remains fail-closed.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/brand.rs src-tauri/src/lib.rs src-tauri/src/windows/sticky.rs src-tauri/tauri.conf.json src-tauri/tests/security.rs
git commit -m "feat: brand native windows as Weiyu"
```

---

### Task 3: 用户导出目录与发布资产合同

**Files:**
- Modify: `src-tauri/src/brand.rs`
- Modify: `src-tauri/src/storage/export.rs`
- Modify: `src-tauri/tests/export.rs`
- Modify: `src/features/settings/ExportLibrary.test.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/app/e2eServices.ts`
- Modify: `src/infrastructure/tauri/client.test.ts`
- Modify: `scripts/validate-release-metadata.test.ts`
- Modify: `scripts/stage-rc-release.test.ts`

**Interfaces:**
- Produces: `crate::brand::EXPORT_ROOT_NAME = "微屿导出"`.
- Preserves: manifest schema, `.simple-notes-export-*` staging prefix, repository slug examples, platform/architecture/signature identity checks.

- [ ] **Step 1: Change test expectations first**

Update export tests to expect `微屿导出` and collision name `微屿导出 (2)`. Update UI/Tauri fake reports from `Simple Notes Export` to `微屿导出`. Update release fixture asset display names to the names emitted by `productName: 微屿`, for example:

```ts
{ name: '微屿_0.1.1_x64_en-US.msi.zip', ... }
{ name: '微屿_aarch64.app.tar.gz', ... }
{ name: '微屿_x64.app.tar.gz', ... }
```

Keep `repository = 'acme/simple-notes'` unchanged because it is a technical repository identifier.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/features/settings/ExportLibrary.test.tsx src/app/App.test.tsx src/infrastructure/tauri/client.test.ts scripts/validate-release-metadata.test.ts scripts/stage-rc-release.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --test export export_uses_a_collision_free_root_without_overwriting -- --exact
```

Expected: export assertions fail because production still emits `Simple Notes Export`.

- [ ] **Step 3: Move the export display root into the Rust brand module**

```rust
// src-tauri/src/brand.rs
pub const APP_NAME: &str = "微屿";
pub const EXPORT_ROOT_NAME: &str = "微屿导出";
```

In `storage/export.rs`, remove the local `EXPORT_ROOT_NAME` and import `crate::brand::EXPORT_ROOT_NAME`. Do not rename `STAGING_PREFIX`, manifest keys, or incomplete-export recovery paths.

- [ ] **Step 4: Verify export and release contracts**

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/features/settings/ExportLibrary.test.tsx src/app/App.test.tsx src/infrastructure/tauri/client.test.ts scripts/validate-release-metadata.test.ts scripts/stage-rc-release.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --test export -- --test-threads=1
```

Expected: tests pass; existing destinations are still never overwritten; platform assets remain distinct and signed.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/brand.rs src-tauri/src/storage/export.rs src-tauri/tests/export.rs src/features/settings/ExportLibrary.test.tsx src/app/App.test.tsx src/app/e2eServices.ts src/infrastructure/tauri/client.test.ts scripts/validate-release-metadata.test.ts scripts/stage-rc-release.test.ts
git commit -m "feat: apply Weiyu export branding"
```

---

### Task 4: 产品规格、开发说明和缓存维护

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-07-30-simple-notes-design.md`
- Create: `docs/development.md`
- Test: `src/shared/brand.test.ts`
- Test: `src-tauri/tests/security.rs`

**Interfaces:**
- Documents: “微屿” Chinese-first brand, “Cay” English name, unchanged data identifier, and reproducible cache cleanup command.
- Preserves: the approved MVP architecture and release fail-closed rules.

- [ ] **Step 1: Add documentation contract assertions**

Extend `src/shared/brand.test.ts`:

```ts
it('documents the approved names and safe cache cleanup', () => {
  const agents = readFileSync('AGENTS.md', 'utf8')
  const development = readFileSync('docs/development.md', 'utf8')
  expect(agents).toContain('微屿 (Cay)')
  expect(development).toContain('cargo clean --manifest-path src-tauri/Cargo.toml')
  expect(development).toContain('不会删除笔记数据')
})
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/shared/brand.test.ts
```

Expected: FAIL because `docs/development.md` does not exist and AGENTS still names Simple Notes.

- [ ] **Step 3: Align documentation**

Change the AGENTS project overview to begin with `微屿 (Cay) is a local-first...`. Change the approved product specification title and product-intent name without altering feature decisions. Create `docs/development.md` with this exact safety boundary:

```md
## Rust 构建缓存

`src-tauri/target` 只包含可再生成的 Rust 编译与测试产物，不包含笔记数据。
可在仓库根目录运行：

`cargo clean --manifest-path src-tauri/Cargo.toml`

该命令不会删除笔记数据或源代码，但清理后的首次 Rust 编译会更慢。长期执行 debug、测试和 release 构建时，目录仍可能重新增长到数十 GiB。
```

- [ ] **Step 4: Run documentation and identifier tests**

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/shared/brand.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --test security checked_in_updater_configuration_is_a_valid_fail_closed_plugin_object -- --exact
rg -n "app\.simplenotes\.desktop|\.simple-notes-|simple-notes-e2e" src-tauri src e2e
```

Expected: tests pass; the search still finds the intentionally preserved internal identifiers.

- [ ] **Step 5: Commit**

```powershell
git add AGENTS.md docs/development.md docs/superpowers/specs/2026-07-30-simple-notes-design.md src/shared/brand.test.ts
git commit -m "docs: document Weiyu identity and cache cleanup"
```

---

### Task 5: Full verification and preview handoff

**Files:**
- Modify only if a test reveals a branding regression in files already named above.
- Do not commit `node_modules`, `target`, `dist`, `.superpowers`, local application data, or temporary Tauri config.

**Interfaces:**
- Consumes: the completed brand constants and unchanged data identifier.
- Produces: a reviewable Windows preview build on `codex/weiyu-branding`; does not merge to `master`.

- [ ] **Step 1: Scan for stale user-facing names**

Run:

```powershell
rg -n --glob '!node_modules/**' --glob '!src-tauri/target/**' "Simple Notes" index.html src src-tauri/tauri.conf.json src-tauri/src
```

Expected: no user-facing production occurrence. Any remaining occurrence must be a compatibility fixture explicitly justified by the plan; tests may mention the old name only to assert absence.

- [ ] **Step 2: Run the complete frontend gates**

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
node node_modules/vite/bin/vite.js build
node e2e/run.mjs
```

Expected: all tests and checks exit 0; Vite may retain the existing non-blocking large-chunk advisory.

- [ ] **Step 3: Run the complete Rust gates**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -j 1 -- --test-threads=1
```

Expected: all non-privilege-gated tests pass, including the 10,000-note fixture; existing Windows symlink/owner-key ignores remain explicitly reported.

- [ ] **Step 4: Build the desktop preview**

Use a temporary ignored Tauri config only to replace the local `pnpm build` hook when the managed pnpm wrapper attempts network access. Reuse the already verified `dist` output, then run:

```powershell
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle --config <temporary-nohook-config>
```

Expected: `src-tauri/target/release/simple-notes.exe` exists and the app/window product name is “微屿”. Installer bundling remains a separate verification because WiX may require an external download unavailable in the sandbox.

- [ ] **Step 5: Review, commit any verification-only fixes, and leave branch unmerged**

```powershell
git diff --check
git status --short
git log --oneline master..codex/weiyu-branding
```

Expected: tracked worktree clean, focused commits visible, and `master` unchanged. Provide the exact preview executable path and startup command to the user. Do not merge until the user confirms the visual effect.
