# 微屿主窗口视觉重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将微屿主窗口重构为“潮汐纸页”视觉系统，提供自绘窗口外壳、居中搜索、紧凑三栏、两级折叠、深浅主题和圆丘岛应用图标，同时保留现有数据安全与编辑行为。

**Architecture:** 保留现有 React 业务组件和 typed port 边界，在表现层新增 `AppChrome`、`GlobalToolbar`、折叠竖栏、创建浮层与 SVG 图标组件。窗口操作通过 `WindowChromePort` 封装 Tauri window API；主题只扩展现有设置枚举，不改变笔记存储、搜索索引或 Markdown 数据格式。

**Tech Stack:** Tauri 2、React 19、TypeScript 5.8、Vite 7、普通 CSS、Vitest、Testing Library、Rust 设置合同测试。

## Global Constraints

- 主窗口使用“潮汐纸页”与专业紧凑密度；正文拥有最高空间优先级。
- 第一排标题栏不显示图标或名称；第二排左侧只显示一次圆丘岛图标和“微屿”。
- 搜索框最长约 `560px`，以窗口中心线为基准居中。
- 资料库折叠为功能图标竖栏；笔记列表折叠为显示“目录 · 数量”的窄竖条。
- 核心色值固定为岸纸白 `#F8FAF7`、雾叶绿 `#EAF0EB`、海湾绿 `#2F7866`、潮线绿 `#58A38E`、暖星色 `#D59A5E`、海墨色 `#172621`。
- 不引入组件框架、样式框架、状态管理框架或 Web 字体。
- React 不直接访问不受限制的 Tauri API；窗口操作必须经过 typed port。
- 不修改笔记存储、SQLite、Markdown 格式、搜索算法、恢复协议或同步边界。
- 圆丘岛图标必须原创，并在 `16px` 时仍能区分绿色岛丘、暖色沙岸和海面。
- 所有新图标按钮必须有可访问名称；折叠、菜单和浮层必须支持键盘及 `Escape`。
- 只运行每项列出的聚焦验证；默认不运行全量 Rust、10,000 笔记夹具、安装器或无关 E2E。

## File Structure

### 新建文件

- `src/shared/Icon.tsx`：统一线性 SVG 界面图标。
- `src/shared/Icon.test.tsx`：图标尺寸、装饰属性和可访问使用合同。
- `src/shared/AppIcon.tsx`：圆丘岛 React SVG。
- `src/shared/AppIcon.test.tsx`：圆丘岛层级与小尺寸合同。
- `src/assets/weiyu-app-icon.svg`：Tauri 图标生成源文件。
- `src/shared/AppChrome.tsx`：自绘标题栏、拖动区域和窗口按钮。
- `src/shared/AppChrome.test.tsx`：平台布局和窗口操作测试。
- `src/features/library/GlobalToolbar.tsx`：品牌、搜索、保存状态、设置和新建入口。
- `src/features/library/GlobalToolbar.test.tsx`：三轨布局语义与键盘测试。
- `src/features/library/LibraryRail.tsx`：折叠资料库图标竖栏。
- `src/features/library/DirectoryRail.tsx`：折叠目录竖条。
- `src/features/library/rails.test.tsx`：折叠栏导航、数量和展开测试。
- `src/features/library/CreateNotePopover.tsx`：新建笔记浮层。
- `src/features/library/CreateNotePopover.test.tsx`：焦点、错误保留和目录选择测试。
- `src/features/library/FolderActionMenu.tsx`：文件夹重命名、移动和删除菜单。
- `src/features/library/FolderActionMenu.test.tsx`：菜单键盘和操作分发测试。
- `src/features/library/MainWindowEmptyState.tsx`：圆丘岛空状态与新建入口。
- `src/features/library/useResponsiveColumns.ts`：窄窗口自动收纳计算。
- `src/features/library/useResponsiveColumns.test.ts`：手动偏好与自动收纳边界。
- `src/features/settings/UpdateSettings.tsx`：设置页更新检查、安装和重启界面。
- `src/features/settings/UpdateSettings.test.tsx`：更新状态和显式确认测试。
- `src/styles/main-window.css`：只包含主窗口外壳、工具栏、三栏、折叠栏和主窗口浮层样式。

### 修改文件

- `src/domain/ports.ts`：新增 `WindowChromePort` 和显式 `night` 主题值。
- `src/app/services.ts`、`src/app/e2eServices.ts`、`src/test/fakes.ts`：注入窗口外壳端口与测试 fake。
- `src/infrastructure/tauri/ports.ts`：实现 `TauriWindowChromePort`。
- `src/infrastructure/tauri/client.test.ts`：验证窗口端口生产接线。
- `src/app/App.tsx`、`src/app/App.test.tsx`：组合窗口外壳、设置更新面板和主窗口。
- `src/features/settings/theme.ts`、`src/features/settings/theme.test.ts`：潮汐纸页浅色、夜海深色和跟随系统 palette。
- `src/features/settings/SettingsView.tsx`、`src/features/settings/SettingsView.test.tsx`：主题选项和更新设置入口。
- `src/shared/settings-defaults.json`：保持默认森林主题，不改变现有用户默认值。
- `src-tauri/src/commands/settings.rs`、`src-tauri/tests/settings.rs`：允许 `night` 序列化与补丁更新。
- `src-tauri/tauri.conf.json`：主窗口关闭原生装饰并更新默认/最小尺寸。
- `src/features/search/SearchBox.tsx`、`src/features/search/SearchBox.test.tsx`、`src/features/search/SearchResults.tsx`：输入即搜、结果浮层和键盘关闭。
- `src/shared/SplitPane.tsx`、`src/shared/SplitPane.test.tsx`：保留零宽折叠 pane，并与外部 rail/自动收纳状态协作。
- `src/features/library/LibraryLayout.tsx`、`src/features/library/LibraryLayout.test.tsx`：新工具栏、折叠栏、创建流程和空状态组合。
- `src/features/library/useLibrary.ts`：允许在明确目标目录中新建笔记。
- `src/features/library/FolderTree.tsx`、`src/features/library/FolderTree.test.tsx`：收纳文件夹操作。
- `src/features/library/NoteList.tsx`：移除常驻创建表单并保持列表职责。
- `src/features/editor/EditorPane.tsx`、`src/features/editor/EditorPane.test.tsx`：统一 SVG 视图控制并上报保存状态。
- `src/features/settings/theme.ts`、`src/styles/tokens.css`、`src/styles/app.css`：迁移主窗口旧样式并避免重复选择器。
- `src-tauri/icons/*`：由批准的 SVG 源生成完整平台图标。

---

### Task 1: 潮汐纸页主题与显式夜海主题

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/shared/settings-defaults.json`
- Modify: `src/features/settings/theme.ts`
- Modify: `src/features/settings/theme.test.ts`
- Modify: `src/features/settings/SettingsView.tsx`
- Modify: `src/features/settings/SettingsView.test.tsx`
- Modify: `src/styles/tokens.css`
- Modify: `src-tauri/src/commands/settings.rs`
- Modify: `src-tauri/tests/settings.rs`

**Interfaces:**
- Produces: `AppSettings['theme'] = 'forest' | 'sand' | 'night' | 'system'`。
- Produces: `themeVariables(settings, systemScheme)` 返回完整主窗口 token，包括 `--color-warm`、`--color-focus`、`--color-muted-light` 和 `--color-border`。
- Keeps: 默认主题仍为 `forest`；旧 `forest`、`sand`、`system` 设置继续反序列化。

- [ ] **Step 1: 写失败的 TypeScript 主题合同**

在 `theme.test.ts` 增加：

```ts
it('maps forest, night, and system-dark to the approved tidal paper palette', () => {
  expect(themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme: 'forest' }))
    .toMatchObject({
      '--color-surface': '#F8FAF7',
      '--color-panel-warm': '#EAF0EB',
      '--color-accent-strong': '#2F7866',
      '--color-warm': '#D59A5E',
    })
  expect(themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme: 'night' }))
    .toMatchObject({
      '--color-canvas': '#101B18',
      '--color-surface': '#172621',
      '--color-heading': '#F1F6F3',
    })
  expect(themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme: 'system' }, 'dark'))
    .toMatchObject({ '--color-surface': '#172621' })
})
```

- [ ] **Step 2: 运行 TypeScript RED**

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/features/settings/theme.test.ts
```

Expected: FAIL，因为 `night` 不在类型中，现有色值也不匹配。

- [ ] **Step 3: 写失败的 Rust 设置合同**

在 `src-tauri/tests/settings.rs` 增加：

```rust
#[test]
fn night_theme_round_trips_without_changing_existing_defaults() {
    let night: AppTheme = serde_json::from_str("\"night\"").unwrap();
    assert_eq!(night.as_str(), "night");
    assert_eq!(serde_json::to_string(&night).unwrap(), "\"night\"");
    assert_eq!(AppSettings::default().theme.as_str(), "forest");
}
```

- [ ] **Step 4: 运行 Rust RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test settings night_theme_round_trips_without_changing_existing_defaults -- --exact
```

Expected: FAIL，因为 `AppTheme::Night` 不存在。

- [ ] **Step 5: 实现最小主题扩展**

在 TypeScript 类型和 Rust 枚举中加入 `night`，更新设置下拉框：

```tsx
<option value="forest">潮汐浅色</option>
<option value="sand">沙岸暖色</option>
<option value="night">夜海深色</option>
<option value="system">跟随系统</option>
```

将 `forest` 和 `systemDarkPalette` 更新为规格色板，`night` 直接使用夜海 palette。补齐所有 token，不依赖 `tokens.css` 中的偶然默认值。

- [ ] **Step 6: 运行聚焦 GREEN**

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/features/settings/theme.test.ts src/features/settings/SettingsView.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --test settings night_theme_round_trips_without_changing_existing_defaults -- --exact
```

Expected: 两组 PASS。

- [ ] **Step 7: 提交**

```powershell
git add src/domain/ports.ts src/shared/settings-defaults.json src/features/settings/theme.ts src/features/settings/theme.test.ts src/features/settings/SettingsView.tsx src/features/settings/SettingsView.test.tsx src/styles/tokens.css src-tauri/src/commands/settings.rs src-tauri/tests/settings.rs
git commit -m "feat: add Weiyu tidal themes"
```

### Task 2: 圆丘岛 App 图标与统一 SVG 图标

**Files:**
- Create: `src/shared/Icon.tsx`
- Create: `src/shared/Icon.test.tsx`
- Create: `src/shared/AppIcon.tsx`
- Create: `src/shared/AppIcon.test.tsx`
- Create: `src/assets/weiyu-app-icon.svg`
- Modify: `src/shared/brand.test.ts`
- Modify: `src-tauri/icons/*`

**Interfaces:**
- Produces: `Icon({ name, size?, decorative? })`，`name` 是封闭 union，不接收任意 SVG 字符串。
- Produces: `AppIcon({ size?, decorative? })`，React 与生成源使用相同几何层级和色值。
- Required icon names: `search | settings | plus | folder | inbox | trash | more | source | split | preview | collapse | expand | minimize | maximize | restore | close`。

- [ ] **Step 1: 写失败的组件合同**

```tsx
it('renders the approved front-facing island layers at small size', () => {
  render(<AppIcon size={16} />)
  const icon = screen.getByTestId('weiyu-app-icon')
  expect(icon).toHaveAttribute('width', '16')
  expect(icon.querySelector('[data-layer="island"]')).not.toBeNull()
  expect(icon.querySelector('[data-layer="sand"]')).not.toBeNull()
  expect(icon.querySelector('[data-layer="waves"]')).not.toBeNull()
  expect(icon).toHaveAttribute('aria-hidden', 'true')
})

it('keeps interface icons decorative inside labelled controls', () => {
  render(<button aria-label="打开设置"><Icon name="settings" /></button>)
  expect(screen.getByRole('button', { name: '打开设置' }))
    .toContainElement(screen.getByTestId('icon-settings'))
  expect(screen.getByTestId('icon-settings')).toHaveAttribute('aria-hidden', 'true')
})
```

- [ ] **Step 2: 运行 RED**

```powershell
node node_modules/vitest/vitest.mjs run src/shared/Icon.test.tsx src/shared/AppIcon.test.tsx
```

Expected: FAIL，两个模块不存在。

- [ ] **Step 3: 实现 SVG 组件和生成源**

`AppIcon` 使用正视圆丘岛：蓝绿色背景、略平的绿色岛丘、加宽暖沙岸、两层海浪和一颗星。`16px` 变体允许隐藏星星细节，但不得隐藏沙岸。

`Icon` 使用统一 `1.75` stroke、`round` linecap/linejoin；不得使用 Emoji 或字符代替图标。

- [ ] **Step 4: 生成 Tauri 平台图标**

Run:

```powershell
node node_modules/@tauri-apps/cli/tauri.js icon src/assets/weiyu-app-icon.svg
```

Expected: 更新 `src-tauri/icons` 中 PNG、ICO、ICNS 和 Windows Store 尺寸，命令 exit `0`。

- [ ] **Step 5: 补品牌文件合同并运行 GREEN**

在 `brand.test.ts` 读取 SVG，断言批准的 `data-layer` 和颜色存在，且 `tauri.conf.json` 仍引用 `icon.ico`、`icon.icns`。

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/shared/Icon.test.tsx src/shared/AppIcon.test.tsx src/shared/brand.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add src/shared/Icon.tsx src/shared/Icon.test.tsx src/shared/AppIcon.tsx src/shared/AppIcon.test.tsx src/shared/brand.test.ts src/assets/weiyu-app-icon.svg src-tauri/icons
git commit -m "feat: add Weiyu island icon system"
```

### Task 3: 自绘窗口外壳与 typed window port

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/app/services.ts`
- Modify: `src/app/e2eServices.ts`
- Modify: `src/test/fakes.ts`
- Modify: `src/infrastructure/tauri/ports.ts`
- Modify: `src/infrastructure/tauri/client.test.ts`
- Create: `src/shared/AppChrome.tsx`
- Create: `src/shared/AppChrome.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces:

```ts
export interface WindowChromePort {
  platform: 'windows' | 'macos'
  startDragging(): Promise<void>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  requestClose(): Promise<void>
}
```

- `requestClose()` 必须调用当前窗口的正常 close，请求仍由现有 `AppLifecyclePort` 安全退出协议拦截。
- `AppChrome` 第一排不得渲染 `APP_NAME` 或 `AppIcon`。

- [ ] **Step 1: 写窗口外壳 RED**

```tsx
it('keeps branding out of the drag row and routes labelled controls through the port', async () => {
  const chrome = fakeWindowChromePort()
  const user = userEvent.setup()
  render(<AppChrome windowChrome={chrome}><p>workspace</p></AppChrome>)
  expect(screen.getByTestId('window-drag-region')).not.toHaveTextContent('微屿')
  fireEvent.pointerDown(screen.getByTestId('window-drag-region'), { button: 0 })
  await user.dblClick(screen.getByTestId('window-drag-region'))
  await user.click(screen.getByRole('button', { name: '最小化窗口' }))
  await user.click(screen.getByRole('button', { name: '关闭窗口' }))
  expect(chrome.startDragging).toHaveBeenCalledTimes(1)
  expect(chrome.toggleMaximize).toHaveBeenCalledTimes(1)
  expect(chrome.minimize).toHaveBeenCalledTimes(1)
  expect(chrome.requestClose).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: 运行 RED**

```powershell
node node_modules/vitest/vitest.mjs run src/shared/AppChrome.test.tsx
```

Expected: FAIL，模块和 fake 不存在。

- [ ] **Step 3: 实现 port 与平台布局**

在基础设施层用 `getCurrentWebviewWindow()` 实现四个方法。平台值在基础设施层根据 Tauri WebView user agent 归一化，只允许 `windows | macos`；React 不读取 user agent。

`AppChrome`：

- 空白 drag row 使用 `data-tauri-drag-region`。
- Windows 控件右置；macOS 控件左置。
- 每个按钮停止 drag pointer 传播。
- 关闭只调用 `requestClose()`，不得直接终止进程。

配置主窗口：

```json
{
  "decorations": false,
  "width": 1180,
  "height": 760,
  "minWidth": 800,
  "minHeight": 560
}
```

- [ ] **Step 4: 验证生产接线和安全关闭不变量**

在 `client.test.ts` mock `getCurrentWebviewWindow()`，验证 `minimize`、`toggleMaximize`、`close`、`startDragging` 精确调用。`App.test.tsx` 验证 App 仍注册现有 lifecycle listener。

Run:

```powershell
node node_modules/vitest/vitest.mjs run src/shared/AppChrome.test.tsx src/infrastructure/tauri/client.test.ts src/app/App.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/domain/ports.ts src/app/services.ts src/app/e2eServices.ts src/test/fakes.ts src/infrastructure/tauri/ports.ts src/infrastructure/tauri/client.test.ts src/shared/AppChrome.tsx src/shared/AppChrome.test.tsx src/app/App.tsx src/app/App.test.tsx src-tauri/tauri.conf.json
git commit -m "feat: add typed main window chrome"
```

### Task 4: 全局应用栏、输入即搜与设置页更新入口

**Files:**
- Create: `src/features/library/GlobalToolbar.tsx`
- Create: `src/features/library/GlobalToolbar.test.tsx`
- Create: `src/features/settings/UpdateSettings.tsx`
- Create: `src/features/settings/UpdateSettings.test.tsx`
- Modify: `src/features/search/SearchBox.tsx`
- Modify: `src/features/search/SearchBox.test.tsx`
- Modify: `src/features/search/SearchResults.tsx`
- Modify: `src/features/settings/SettingsView.tsx`
- Modify: `src/features/settings/SettingsView.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/features/library/LibraryLayout.tsx`

**Interfaces:**
- Produces:

```ts
export type ToolbarSaveState = 'hidden' | 'dirty' | 'saving' | 'saved' | 'error'

export type UpdateViewState =
  | { status: 'idle' | 'checking' | 'none' | 'check-error' }
  | { status: 'available' | 'installing' | 'installed' | 'install-error' | 'restarting' | 'restart-error'; update: AvailableUpdate }

export interface UpdateController {
  state: UpdateViewState
  check(): Promise<void>
  install(): Promise<void>
  restart(): Promise<void>
}

export interface GlobalToolbarProps {
  search: SearchPort
  saveState: ToolbarSaveState
  updateAttention: 'none' | 'available' | 'restart-required'
  onSelectResult(noteId: NoteId): void
  onCreateNote(): void
  onOpenSettings(): void
}
```

- `UpdateSettings` 消费 `UpdateController`；App 内部 controller 继续调用现有 `UpdatePort`，检查、安装、重启仍由用户显式触发。
- Search debounce 固定 `180ms`，结果上限保持 `100`，继续使用 generation 忽略迟到结果。

- [ ] **Step 1: 写工具栏和搜索 RED**

```tsx
it('renders branding once and keeps search between balanced side tracks', () => {
  render(<GlobalToolbar
    search={fakeSearchPort()}
    saveState="saved"
    updateAttention="none"
    onSelectResult={vi.fn()}
    onCreateNote={vi.fn()}
    onOpenSettings={vi.fn()}
  />)
  expect(screen.getAllByText('微屿')).toHaveLength(1)
  expect(screen.getByRole('searchbox', { name: '搜索笔记' }))
    .toHaveAttribute('placeholder', '搜索标题、正文或 #标签')
  expect(screen.getByRole('button', { name: '新建笔记' })).toBeVisible()
})

it('searches after input settles without a submit button and closes on Escape', async () => {
  vi.useFakeTimers()
  render(<SearchBox search={search} onSelect={onSelect} />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '#设计' } })
  await vi.advanceTimersByTimeAsync(180)
  expect(search.search).toHaveBeenCalledWith({ kind: 'tag', value: '设计' }, 100)
  expect(screen.queryByRole('button', { name: '搜索' })).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  expect(screen.queryByRole('list', { name: '搜索结果' })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 写更新入口 RED**

在 `App.test.tsx` 断言主窗口没有“检查更新”按钮；在 `SettingsView.test.tsx` 断言设置打开后存在该按钮。运行三个文件，确认 RED。

- [ ] **Step 3: 实现 GlobalToolbar 和 SearchBox**

工具栏使用语义三轨 DOM：`brand / search / actions`。搜索组件只渲染输入框和浮层；指导文案仅在非法 `#` 或错误时出现在浮层。

更新状态从 App 传入 `SettingsView` 的 `UpdateSettings`。应用栏只在 `available` 或 `installed/restart-error` 时渲染图标化状态按钮，点击打开设置而不是直接安装。

- [ ] **Step 4: 运行聚焦 GREEN**

```powershell
node node_modules/vitest/vitest.mjs run src/features/library/GlobalToolbar.test.tsx src/features/search/SearchBox.test.tsx src/features/settings/UpdateSettings.test.tsx src/features/settings/SettingsView.test.tsx src/app/App.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/features/library/GlobalToolbar.tsx src/features/library/GlobalToolbar.test.tsx src/features/search/SearchBox.tsx src/features/search/SearchBox.test.tsx src/features/search/SearchResults.tsx src/features/settings/UpdateSettings.tsx src/features/settings/UpdateSettings.test.tsx src/features/settings/SettingsView.tsx src/features/settings/SettingsView.test.tsx src/app/App.tsx src/app/App.test.tsx src/features/library/LibraryLayout.tsx
git commit -m "feat: add Weiyu global toolbar"
```

### Task 5: 资料库、目录折叠竖栏与响应式收纳

**Files:**
- Create: `src/features/library/LibraryRail.tsx`
- Create: `src/features/library/DirectoryRail.tsx`
- Create: `src/features/library/rails.test.tsx`
- Create: `src/features/library/useResponsiveColumns.ts`
- Create: `src/features/library/useResponsiveColumns.test.ts`
- Modify: `src/shared/SplitPane.tsx`
- Modify: `src/shared/SplitPane.test.tsx`
- Modify: `src/features/library/LibraryLayout.tsx`
- Modify: `src/features/library/LibraryLayout.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface EffectiveCollapsedColumns {
  folder: boolean
  noteList: boolean
}

export function responsiveCollapse(width: number): EffectiveCollapsedColumns {
  return { folder: width < 1050, noteList: width < 850 }
}
```

- Effective state is `manualCollapsed OR responsiveCollapse(width)`；只把 manual state 写入 `library-collapsed` preference。
- `LibraryRail` 宽 `42px`；`DirectoryRail` 宽 `30px`。

- [ ] **Step 1: 写 rail RED**

```tsx
it('labels the collapsed note list as directory and restores it by keyboard', async () => {
  const onExpand = vi.fn()
  const user = userEvent.setup()
  render(<DirectoryRail count={6} onExpand={onExpand} />)
  const rail = screen.getByRole('button', { name: '展开目录，6 篇笔记' })
  expect(rail).toHaveTextContent('目录 · 6')
  await user.keyboard('{Tab}{Enter}')
  expect(onExpand).toHaveBeenCalledTimes(1)
})
```

为 `LibraryRail` 测试当前入口潮线、临时收集箱和回收站的 immutable navigation callback。

- [ ] **Step 2: 写响应式 RED**

```ts
it.each([
  [1180, { folder: false, noteList: false }],
  [1000, { folder: true, noteList: false }],
  [820, { folder: true, noteList: true }],
])('derives automatic collapse at %ipx', (width, expected) => {
  expect(responsiveCollapse(width)).toEqual(expected)
})
```

- [ ] **Step 3: 运行 RED 并实现**

```powershell
node node_modules/vitest/vitest.mjs run src/features/library/rails.test.tsx src/features/library/useResponsiveColumns.test.ts src/features/library/LibraryLayout.test.tsx src/shared/SplitPane.test.tsx
```

实现 rails 和 `ResizeObserver` hook。删除现有右下角 `.library-collapse-controls`。栏标题内按钮只更新 manual preference；窗口缩放不写 preference。

`SplitPane` 继续让 collapsed pane 为 `0px` 且 inert；外部 rail 在 pane 前渲染。恢复时保留上次 resize 宽度。

- [ ] **Step 4: 运行聚焦 GREEN**

重复 Step 3 命令，Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/features/library/LibraryRail.tsx src/features/library/DirectoryRail.tsx src/features/library/rails.test.tsx src/features/library/useResponsiveColumns.ts src/features/library/useResponsiveColumns.test.ts src/shared/SplitPane.tsx src/shared/SplitPane.test.tsx src/features/library/LibraryLayout.tsx src/features/library/LibraryLayout.test.tsx
git commit -m "feat: add collapsible library rails"
```

### Task 6: 新建笔记浮层与文件夹操作菜单

**Files:**
- Create: `src/features/library/CreateNotePopover.tsx`
- Create: `src/features/library/CreateNotePopover.test.tsx`
- Create: `src/features/library/FolderActionMenu.tsx`
- Create: `src/features/library/FolderActionMenu.test.tsx`
- Modify: `src/features/library/useLibrary.ts`
- Modify: `src/features/library/LibraryLayout.tsx`
- Modify: `src/features/library/LibraryLayout.test.tsx`
- Modify: `src/features/library/FolderTree.tsx`
- Modify: `src/features/library/FolderTree.test.tsx`
- Modify: `src/features/library/NoteList.tsx`

**Interfaces:**
- Change: `useLibrary.createNote(title: string, folderId?: FolderId | null): Promise<void>`；未传 folderId 时使用 active folder。
- Produces:

```ts
interface CreateNotePopoverProps {
  folders: Folder[]
  initialFolderId: FolderId | null
  triggerRef: RefObject<HTMLButtonElement | null>
  onCreate(title: string, folderId: FolderId | null): Promise<void>
  onClose(): void
}
```

- `FolderActionMenu` 只分发 `rename | move | delete`，实际 durable 行为仍使用现有 callbacks。

- [ ] **Step 1: 写创建浮层 RED**

```tsx
it('retains title and folder after failure and restores trigger focus on Escape', async () => {
  const user = userEvent.setup()
  const folderId = '019c0000-0000-7000-8000-000000000111' as FolderId
  const folders = [{ id: folderId, parentId: null, name: '设计', sortOrder: 0 }]
  const onClose = vi.fn()
  const onCreate = vi.fn().mockRejectedValue(new Error('disk full'))
  const triggerRef = createRef<HTMLButtonElement>()
  render(<>
    <button ref={triggerRef}>新建笔记</button>
    <CreateNotePopover
      folders={folders}
      initialFolderId={null}
      triggerRef={triggerRef}
      onCreate={onCreate}
      onClose={onClose}
    />
  </>)
  await user.type(screen.getByRole('textbox', { name: '笔记标题' }), '潮汐设计')
  await user.selectOptions(screen.getByRole('combobox', { name: '保存到目录' }), folderId)
  await user.click(screen.getByRole('button', { name: '创建笔记' }))
  expect(screen.getByRole('alert')).toHaveTextContent('无法新建笔记')
  expect(screen.getByRole('textbox', { name: '笔记标题' })).toHaveValue('潮汐设计')
  await user.keyboard('{Escape}')
  expect(screen.getByRole('button', { name: '新建笔记' })).toHaveFocus()
})
```

- [ ] **Step 2: 写文件夹菜单 RED**

测试 `···` 只有选中文件夹时启用，菜单项键盘可达；删除项有危险语义但仍调用现有 `onDelete`，不得绕过空文件夹验证。

- [ ] **Step 3: 运行 RED**

```powershell
node node_modules/vitest/vitest.mjs run src/features/library/CreateNotePopover.test.tsx src/features/library/FolderActionMenu.test.tsx src/features/library/FolderTree.test.tsx src/features/library/LibraryLayout.test.tsx
```

Expected: FAIL，新组件不存在，旧 `NoteList` 仍有内嵌创建表单。

- [ ] **Step 4: 实现并移除旧常驻操作**

`LibraryLayout` 控制 popover open，创建仍经过现有 `navigateAfterSave` barrier。`CreateNotePopover` 在内部控制 busy/error；成功后调用 `onClose`，失败不清输入。

`FolderTree` 顶部只保留 `+` 和 `···`。选择菜单项后复用现有 rename/move form；删除继续使用现有回调。`NoteList` 删除 `onCreate`、`creating`、`createError` 和 `.note-list__create`。

- [ ] **Step 5: 运行聚焦 GREEN**

重复 Step 3 命令，Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add src/features/library/CreateNotePopover.tsx src/features/library/CreateNotePopover.test.tsx src/features/library/FolderActionMenu.tsx src/features/library/FolderActionMenu.test.tsx src/features/library/useLibrary.ts src/features/library/LibraryLayout.tsx src/features/library/LibraryLayout.test.tsx src/features/library/FolderTree.tsx src/features/library/FolderTree.test.tsx src/features/library/NoteList.tsx
git commit -m "feat: streamline note and folder creation"
```

### Task 7: 主窗口视觉迁移、正文工具栏与空状态

**Files:**
- Create: `src/features/library/MainWindowEmptyState.tsx`
- Create: `src/styles/main-window.css`
- Modify: `src/app/App.tsx`
- Modify: `src/features/library/LibraryLayout.tsx`
- Modify: `src/features/library/LibraryLayout.test.tsx`
- Modify: `src/features/editor/EditorPane.tsx`
- Modify: `src/features/editor/EditorPane.test.tsx`
- Modify: `src/styles/app.css`
- Modify: `src/styles/tokens.css`

**Interfaces:**
- `EditorPane` adds `onSaveStateChange?(status: SaveState['status']): void`。
- `MainWindowEmptyState` receives `onCreateNote()` and never renders once a document is open。
- `main-window.css` 所有入口选择器位于 `.main-window` 或 `.app-chrome` 命名空间；迁移后从 `app.css` 删除同一主窗口规则，避免依赖覆盖顺序。

- [ ] **Step 1: 写保存状态和空状态 RED**

```tsx
it('reports autosave state to the global toolbar while preserving detailed editor errors', async () => {
  const onSaveStateChange = vi.fn()
  const user = userEvent.setup()
  render(<EditorPane
    document={note('')}
    notes={fakeNotePort()}
    onSaveStateChange={onSaveStateChange}
    autosaveDelayMs={10_000}
  />)
  await user.type(screen.getByRole('textbox'), '新的正文')
  expect(onSaveStateChange).toHaveBeenCalledWith('dirty')
})

it('offers one clear new-note action only when no document is selected', () => {
  render(<MainWindowEmptyState onCreateNote={onCreateNote} />)
  expect(screen.getByRole('button', { name: '新建笔记' })).toBeVisible()
  expect(screen.getByTestId('empty-island')).toHaveAttribute('aria-hidden', 'true')
})
```

- [ ] **Step 2: 运行 RED**

```powershell
node node_modules/vitest/vitest.mjs run src/features/editor/EditorPane.test.tsx src/features/library/LibraryLayout.test.tsx
```

Expected: FAIL，新 props 和空状态不存在。

- [ ] **Step 3: 迁移主窗口样式**

实现：

- 两排顶栏总高、三轨搜索、紧凑栏距和 `42px/30px` rails。
- 当前资料库/笔记左侧 `3px` 潮线。
- 常规圆角 `7–12px`；只给浮层和当前笔记阴影。
- 搜索结果、创建浮层、菜单使用同一 overlay token。
- 深色夜海主题中正文为 `#172621`，标题栏为 `#101B18`。
- `@media (prefers-reduced-motion: reduce)` 关闭折叠和浮层动画。
- `:focus-visible` 双层焦点环。

编辑器模式按钮改用 `Icon`，保留源码/分栏/预览现有 aria-label 与 `aria-pressed`。标签、保存错误和 backlinks 行为不改。

- [ ] **Step 4: 运行聚焦 GREEN 和类型检查**

```powershell
node node_modules/vitest/vitest.mjs run src/features/editor/EditorPane.test.tsx src/features/library/LibraryLayout.test.tsx src/features/library/GlobalToolbar.test.tsx src/features/library/rails.test.tsx
node node_modules/typescript/bin/tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 运行相关 lint**

```powershell
node node_modules/eslint/bin/eslint.js src/app/App.tsx src/shared src/features/library src/features/search src/features/editor src/features/settings/theme.ts src/features/settings/SettingsView.tsx
```

Expected: exit `0`。

- [ ] **Step 6: 提交**

```powershell
git add src/features/library/MainWindowEmptyState.tsx src/features/library/LibraryLayout.tsx src/features/library/LibraryLayout.test.tsx src/features/editor/EditorPane.tsx src/features/editor/EditorPane.test.tsx src/styles/main-window.css src/styles/app.css src/styles/tokens.css src/app/App.tsx
git commit -m "feat: apply Weiyu tidal main window"
```

### Task 8: 聚焦集成验证与 Windows 视觉验收

**Files:**
- Modify only if a directly observed defect requires it: files from Tasks 1–7 and their nearest tests
- Review: `docs/superpowers/specs/2026-08-14-weiyu-main-window-redesign-design.md`

**Interfaces:**
- No new interfaces. This task verifies the approved composition and fixes only direct regressions.

- [ ] **Step 1: 运行最终聚焦组件集合**

```powershell
node node_modules/vitest/vitest.mjs run src/shared/AppChrome.test.tsx src/shared/AppIcon.test.tsx src/shared/Icon.test.tsx src/features/library/GlobalToolbar.test.tsx src/features/library/rails.test.tsx src/features/library/CreateNotePopover.test.tsx src/features/library/FolderActionMenu.test.tsx src/features/library/LibraryLayout.test.tsx src/features/search/SearchBox.test.tsx src/features/editor/EditorPane.test.tsx src/features/settings/theme.test.ts src/features/settings/UpdateSettings.test.tsx src/features/settings/SettingsView.test.tsx src/app/App.test.tsx src/infrastructure/tauri/client.test.ts
```

Expected: 所列文件全部 PASS。不要扩展为全量 Vitest，除非聚焦测试暴露跨模块加载错误且无法从直接依赖定位。

- [ ] **Step 2: 运行必要静态和前端构建检查**

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/app src/shared src/features/library src/features/search src/features/editor src/features/settings src/infrastructure/tauri
node node_modules/vite/bin/vite.js build
```

Expected: 三条 exit `0`；Vite 允许记录既有 bundle-size advisory，但不得忽略编译错误。

- [ ] **Step 3: 仅运行实际涉及的 Rust 合同**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test settings night_theme_round_trips_without_changing_existing_defaults -- --exact
```

Expected: PASS。不得运行全量 Rust 或 10,000 笔记 fixture。

- [ ] **Step 4: Windows 手工视觉检查**

使用项目本地 CLI 启动应用；若 checked-in `beforeDevCommand` 在本机缺少全局 pnpm，则先在一个终端运行本地 Vite，再用仅清空 `beforeDevCommand` 的 ignored 临时 Tauri config 启动，不修改 checked-in config。

检查并截图：

1. 浅色、三栏展开、约 `1180×760`。
2. 深色、资料库折叠、目录展开。
3. 深色、两栏同时折叠、约 `800×600`。
4. 新建笔记浮层和搜索结果浮层。

每张图确认：第一排无品牌；第二排品牌只出现一次；搜索居中；“目录”标签正确；正文没有岛屿装饰；焦点清晰。

- [ ] **Step 5: Windows 窗口行为检查**

验证拖动、双击标题栏、最小化、最大化、还原和关闭。关闭时制造一个待保存编辑，确认现有安全退出流程仍先刷新保存再退出。

如果没有 macOS 主机，只记录“macOS native GUI not verified”；不得将静态平台分支写成已验证。

- [ ] **Step 6: 差异自审和最终提交**

```powershell
git diff --check
git status --short
```

只修复本轮直接问题。若 Task 8 发现直接回归，返回产生该回归的原任务，使用该任务列出的精确 `git add` 文件清单、聚焦测试和提交主题完成修复。若没有直接修复，则 Task 8 不创建额外提交。

最终报告明确列出已运行命令、Windows 截图状态、未运行的全量测试和 macOS 风险。
