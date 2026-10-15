# AGENTS.md

## Project overview

Cay (微屿) is a local-first Markdown note application with typed document entries for Windows and macOS. The product favors a small, reliable feature set over an all-in-one workspace. Users can work fully offline without an account. A future account will be optional and used only for synchronization.

Read `docs/superpowers/specs/2026-07-30-simple-notes-design.md` before changing product behavior or architecture. Keep that specification and this file aligned when an approved design decision changes.

## Brand naming

- Use `微屿` as the primary user-visible name in the application UI, native window titles, installers, system menus, and Chinese product copy.
- Use `临时便笺` for the Chinese temporary sticky-note feature name; use `便笺` in short action labels.
- Use `Cay` in English prose and English release titles. When a bilingual first mention is useful, write `Cay (微屿)`.
- Keep technical compatibility identifiers such as `app.simplenotes.desktop`, the `simple-notes` package/crate name, `.simple-notes-*` file prefixes, command names, and persisted keys stable unless an approved migration explicitly changes them.
- 默认持久资料库使用平台应用数据目录下的 `app.cay`；启动配置与应用标识继续使用兼容路径。升级仅迁移 `dataRoot=default` 的旧资料库，已设置的任何自定义目录均不改名。复制校验并重新打开验证成功前保留旧内容，内部 UUID 存储结构保持稳定。
- 默认目录自动迁移在配置发布前失败时继续打开原资料库，在存储设置保留提示并下次启动重试；配置已指向新目录后不得恢复编辑旧副本。

## Planned technology

- Tauri 2 for desktop windows, operating-system integration, packaging, and privileged commands.
- React, TypeScript, and Vite for the UI.
- CodeMirror 6 for Markdown source editing.
- Tiptap for rich document editing, with PDF.js and DOCX generation kept local for viewing and export.
- SQLite for metadata, tags, links, window state, and rebuildable search indexes.
- Markdown, typed document/text/file entries, managed payloads, and image assets are durable content; SQLite remains a rebuildable index.
- `pnpm` is the JavaScript package manager.

Do not replace the stack or add a second state, editor, database, styling, or component framework without an approved design change.

## Product invariants

- Core note features must work without an account or network connection.
- Markdown and typed entry payloads/assets are durable content. SQLite is an index and metadata store that can be rebuilt from those entries.
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

- Save Markdown and typed entry metadata/payloads by writing sibling temporary files, flushing them, and atomically publishing the previous entry only after a successful write.
- Update SQLite indexes only after durable content succeeds. A failed content write must not publish new index state.
- Use transactions for multi-row metadata changes and for each item in a batch temporary-note conversion.
- Keep all resolved paths inside the configured application data or export root. Reject traversal and symlink escapes.
- Sanitize pasted-image names, verify image types, and generate collision-resistant filenames. New static PNG and JPEG assets use the selected image quality setting: high-quality WebP Q95 by default, smaller WebP Q85, or original format. Convert only when the result is smaller; preserve animation, unsupported images, and unsuccessful conversions. The original-format option may recompress PNG IDAT losslessly when smaller. Bound conversion memory and retain existing atomic asset publication; do not rewrite existing libraries automatically.
- Preserve the previous valid content when disk-full, permission, parsing, migration, or index failures occur.
- Treat index rebuilds as normal recovery operations and test them.
- Never log note bodies, authentication tokens, or local absolute paths in production telemetry.

## UI rules

- Approved tray lifecycle design: `docs/superpowers/specs/2026-09-04-tray-lifecycle-design.md`. Windows close-to-tray is optional with first-close disclosure; macOS preserves native close/quit semantics. Explicit quit and authorized restart must await all live editors, including hidden sticky windows. Never hide the main window without an available recovery entry. A source candidate is implemented; do not describe it as shipped until native platform acceptance is recorded.

- The main window uses resizable folder-with-inline-notes, current-note outline, and editor columns. Folder notes expand naturally and scroll with the complete tree; the collapsed outline shows only its label, without counts. Outline entries follow the preview Markdown grammar and exclude code-block contents. Dividers are visually quiet; hovering changes the cursor and highlights the boundary. Double-click restores the default proportion.
- The editor supports exactly three primary views in the MVP: source, split source/preview, and preview.
- 正式笔记与附件的右键菜单统一显示“另存为”，再选择实际支持的格式；Markdown、富文档和纯文本支持 Markdown（连同附件的目录）、TXT、独立 HTML、DOCX 与 PDF，附件提供原格式；PNG/JPG/WebP 可转 PDF，DOCX/XLSX/PPTX 正文、单元格与幻灯片文字可转 TXT/HTML/PDF，明确复杂版式、图表和图片不随投影转换，超限预览不冒充完整转换；禁止仅改扩展名冒充转换。导出先保存当前输入，投影与格式转换只作用于导出副本，不改内部 UUID 存储；TXT 保留段落、代码缩进和表格列，HTML 内嵌本地图片并阻止活动脚本与外部资源。Markdown 无法承载的富文档字体、字号、颜色与对齐样式不作为该格式的无损承诺。
- 主题提供潮汐绿、沙岸黄、晴湾蓝、夜礁黑、云屿白及跟随系统；跟随系统监听 Windows/macOS 浅色与深色外观，不读取系统强调色。滚动条轨道保持透明，滑块与悬停色在当前主题内解析。保留旧主题持久化键。
- 文件条目副标题仅显示一个格式标签；另存为与移动弹窗使用紧凑参数行，另存为提供文件名和目录选择；改名仅作用于导出副本，原生保存窗口保留覆盖确认。PDF 图标使用圆角文件页与原创曲线符号，格式标签承担文字识别。多选仅保留条目选中反馈，不显示额外计数条；多选可一次添加/取消星标，点击编辑区等外部位置取消多选，操作菜单固定显示“删除笔记”；右键先显示操作菜单，移动操作再打开文件夹选择器。
- 导入文件移除重复的大型类型信息条和说明段，空文件显示空白；DOCX 正文/表格、XLSX 缓存单元格及 PPTX 幻灯片文字及本地嵌入 PNG/JPEG/WebP 图片提供本地只读预览，标题旁提供紧凑的外部编辑与另存为入口。预览限制压缩文件 32MiB、XML 单项 4MiB/总计 8MiB/100 项及表格 500 行/100 列；按工作簿与演示关系排序，拒绝实体和活动资源。空工作表与空幻灯片不显示孤立标题；PPT 图片按所属幻灯片关系读取，拒绝外部资源、活动格式和超限图片。复杂版式、图表与旧 DOC/XLS/PPT 保留原文件并使用系统应用查看。
- 界面图标使用原创圆角线条与轻微双色层次，资料库文件夹及系统入口为 22px、笔记类型为 20px，工具栏保持紧凑尺寸与明确的可访问标签。文件夹列表通过索引查询轻量元数据及有界摘要，仅附件读取小型清单，禁止将格式标记当作正文保存；打开笔记保持完整内容与校验。笔记读取按 UUID 合并并发请求，缓存较新版本不被旧后台结果覆盖；未变化快照复用引用，富文档结构、摘要与统计投影按内容引用缓存。笔记、列表及图片读取在原生后台执行，图片目录校验并固定后释放元数据锁；多图请求按读取端最多三组并行、每组两张，富文档图片按可见区预读并保留导出全图读取。编辑器可见区分析只读取必要文本与语法节点；图片字节缓存采用最近使用淘汰，每个读取端限制为 32MiB、128 项，不将过大的图片长期缓存。
- Markdown 与富文档代码块提供共享本地语言注册表、语法高亮与无边框语言输入，支持手写和主题语言列表选择，列表不提供空白项，清空输入即不指定语言；SVG 箭头垂直居中且仅悬停或键盘聚焦时显示；富文档语言切换保留正文并支持撤销；正文输入代码围栏后按 Enter 优先聚焦语言，语言确认后进入代码正文；正文 Tab 缩进而不跳往前面的控件，表格保留原生导航。纯文本语言不显示文字，移除代码与围栏语言补全，三种视图使用一致的本地语法高亮；切换语言仅修改围栏信息，保留正文、围栏样式及附加信息，支持撤销并遵守保存屏障。未知语言按原文保留，未闭合围栏不得隐藏正文末行。
- Note rows do not expose hover delete buttons. Keep recoverable deletion in the pointer/keyboard context menu, with undo feedback outside the folder tree flow. New default table headers must avoid existing names without renaming user content.
- View controls live in the editor title toolbar, not the global application bar.
- 设置采用常规、系统、按键、存储、AI 五类、圆角分类图标、紧凑分组卡片与对齐参数行，更新归系统、导出归存储，切换分类保留输入，短数字控件右对齐并隐藏系统上下箭头；标题菜单固定显示 H，选项使用主题悬停高亮；临时便笺内容不使用悬停填色。文档工具栏折叠后不占整行，仅保留边缘格式图标；主窗口分栏使用 1px 线与透明拖动命中区。
- 品牌、设置和窗口控件共享顶部标题栏；搜索在资料库标题下。资料库展开入口位于折叠栏顶部，内部只使用单条分隔线。仅正式笔记提供星标，按不可变笔记 ID 保存导航偏好，旧文件夹星标不自动迁移到笔记。
- Ctrl/Cmd+F 打开紧凑的资料库搜索，水平居中并固定在标题栏下工作区高度的约 1/4 处，显示文件夹、笔记和最多三句实际命中摘要与黄色关键词高亮；搜索与便笺快捷键均可点击输入框录入并持久化，侧栏搜索使用主题图标与快捷键提示，结果直接显示于左侧文件列表并高亮命中，不打开快捷键搜索弹窗；跳转须等待当前编辑保存成功。笔记底部使用薄状态栏，左侧显示行数、总字数/选中字数与关联笔记入口，右侧显示最后编辑时间和保存状态；关联面板默认关闭并支持滚动、拖动边界和键盘调高。
- 文档格式工具栏及折叠图标保持在 AI 总结面板下方。Markdown 表格支持从文字区按鼠标左键跨单元格拖选并粘贴制表符/换行分隔的内容，超出边界时扩展行列；矩阵粘贴覆盖合并区域时拆分受影响单元格以保留所有粘贴值。Tab/Shift+Tab 跳过合并覆盖的单元格，Enter/Shift+Enter 按列移动，切换后聚焦并自动显示编辑内容。
- 表格单元格输入实时进入 Markdown 草稿，保存屏障提交活动格并锁定控件。矩形选区支持 TSV 复制、剪切、清空和所选行列删除，保留至少表头、一个正文行和一列；批量操作可一次撤销。剪贴板遵循 Excel 引号字段语法，Markdown 格内换行使用 `<br>`，未修改格保留原始转义。富文档使用原生表格逻辑坐标与鼠标选区；转换副本暂不能完整映射的表格逐字保留为带提示的原文块。大表格一次提交内容并分帧创建控件，撤销或切换编辑器时取消未完成渲染。
- 快捷键按当前系统显示 Ctrl/Command，按键设置使用搜索/便笺简短标签，点击搜索或便笺输入框或按 Enter 录入；录入时暂停系统便笺快捷键，取消、完成或关闭设置时恢复。存储迁移仅接受新目录或现有空目录，先检查空间、复制并校验，重启验证成功后清理旧笔记；保留系统启动配置和未知文件，清理失败不阻止新位置打开并允许下次启动重试。
- 设置布尔项使用可访问滑动开关，仅点击控件本身切换；下拉框按当前选项文字自适应宽度，需要解释的参数在名称下显示浅色说明，数字单位置于输入框内。设置操作按钮统一尺寸与主题样式，包含恢复默认设置在内的文字跟随正文字体；AI Key 保存嵌入输入框右端，不显示清除按钮；存储位置通过系统目录选择器选择。
- 存储设置用细横线区分图片保存质量与“存储位置与迁移”。图片质量选项使用易懂的“高清压缩（推荐）”“省空间压缩”“保留原图”，选中后用一条简短说明交代画质和处理范围，保留实际 WebP Q95/Q85 的持久化值。迁移区区分当前位置与迁移目标文件夹。
- 顶部诗词按本地日历日期每日刷新，字号和窗口宽度仅影响显示，不参与选诗；加载扩展诗库后再显示当天诗句。临时便笺（独立窗口与主窗口条目）不显示悬停行号。Markdown 三种视图支持 Ctrl+滚轮 50%–200% 正文缩放，跨视图保留比例，不改全局字号，切换笔记恢复默认；浮动控件使用缩放后的坐标换算。
- 正文默认使用楷体（KaiTi、STKaiti），保留已选字体；设置及操作弹窗随正文字体，参数行与复选项垂直居中，说明字号统一。字体选项使用规范字体名称，保留已有 CSS 字体栈值，不下载或捆绑未经授权的字体；未安装时按字体栈回退。Windows EXE/MSI 可选择首次使用的数据目录，Rust 只对无设置、无历史资料库的空目录初始化，禁止覆盖现有内容与链接逃逸；升级、重装和卸载不迁移或删除资料库，已有用户通过设置迁移。macOS DMG 保持原生拖拽安装流程。
- 标题、字体和字号采用一致的应用菜单，鼠标打开不自动聚焦选项，选项悬停和键盘焦点使用主题高亮，Escape 可关闭；笔记标题区紧凑排版并常显添加标签入口，空标签不提交，关闭或重新输入时清除校验提示。
- 文档标题使用连续的原生编辑区域，# 前缀为可选择、复制和删除的真实编辑文本，行首输入即转换标题，增删 # 同步 1–6 级样式；保存时移除编辑前缀，保持原有标题内容模型。非当前编辑标题隐藏 #，点击或选中标题恢复前缀。文档格式刷单次复制文字格式、标题等级和段落对齐，不复制链接地址。文档按内容块（包括空段落）统计与编号，图片、表格各占一块；文档与 Markdown 悬停行号在内容块 + 左侧淡入淡出并遵守减少动画偏好，Markdown 保留源文件行数。文档 +、工具栏插入与右键共享列表、图片、链接、表格、代码、引用、公式和分隔线操作，正文和标题样式保留在格式工具栏。设置普通参数名称统一字号与字重，仅分类和分组标题强调。文档与 Markdown 内容块加号平时透明、悬停或键盘焦点才填色，行号和加号垂直居中，鼠标跨过正文到加号的空隙时保持可点击；顶部诗词增大字号但标题栏保持 30px 高度。
- 文档字号输入不显示上下按钮，按回车应用到选区或光标位置，光标移动刷新当前字号。临时便笺使用选中边框反馈点击，不使用悬停填色。
- AI 总结入口使用原创圆角机器人与星光图形，主入口图标 24px；AI 总结入口仅显示在正式笔记中；临时便笺再次点击当前条目时，先等待保存成功再关闭右侧预览，保存失败保留编辑内容。
- Office 外部编辑使用按笔记 UUID 固定的工作副本，保存后后台校验并原子回写托管附件，刷新预览与索引；重复打开不得覆盖工作副本，失败保留旧附件和编辑副本。空 DOCX/XLSX/PPTX 初始化为有效包，旧格式空文件不伪造。迁移资料库前应保存并关闭外部 Office 编辑，避免外部应用继续写入原目录。Markdown 引用候选仅在打开选择器时查询，正文右键菜单按可用空间调整并允许滚动，界面动作统一称为“引用笔记”；Markdown 顶部移除无实际动作的更多入口。欢迎笔记说明格式导入、笔记类型与现有 AI 总结，仅更新未被用户修改的内置内容。
- The editor block “+” menu and editor context menu expose the same insertion actions, including a searchable internal-link picker that excludes the current note.
- Show non-empty note tags below the note title; last-edited time and save state belong in the bottom status bar. Icon-only inline formatting controls expose visible hover labels and accessible names.
- New-note and move destinations offer actual folders only. Moving a note updates both source and destination inline lists immediately; preserve compatibility with existing root-level content.
- 右键新建文件夹在目录树内显示带文件夹图标的临时名称行，自动展开目标父文件夹并聚焦输入；空白处新建放在顶层列表末尾，Enter 确认、Escape 取消，不在资料库顶部单独显示输入框。
- Keep the visual language warm, rounded, and nature-inspired, while preserving high contrast and dense-content readability.
- Do not copy Nintendo assets or directly use `animal-island-ui`; its CC BY-NC license prohibits commercial use. Build an original design system.
- Keyboard operation, visible focus, reduced motion, and adequate color contrast are required.
- Transient operation errors appear in a dismissible bottom-right notification and expire after ten seconds. Preserve persistent recovery controls for blocked startup, unsaved work, and unavailable platform actions.

- 工作区弹窗打开时保留顶部原生标题栏的拖动区域；独立临时便笺同时接入图片保存与读取服务，新粘贴和已有本地图片使用同一所属便笺 UUID 读取；临时窗口拥有受所属 UUID 校验约束的单张及批量图片读取权限。另存为格式名称仅显示 Markdown，附件实际导出能力保持不变。

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

## Version and changelog rules

- `CHANGELOG.md` at the repository root is the only source of version change records; do not create or update a separate release-notes file for version history.
- Add each new version at the top of the version records, use `MAJOR.MINOR.PATCH`, and keep the status limited to `预发布`, `稳定`, or `撤回`.
- Every version entry must include the date, target platforms, status, commit, installer filenames, and SHA256 values. Leave an explicit `待发布` or `待发布构建生成后补录` marker only while the release is still a candidate.
- Classify changes only as `新增`, `修复`, `变更`, or `已知问题`; write each bullet as one action plus its result.
- Record every user-visible behavior change, bug fix, release workflow change, and verification boundary in the current unreleased version entry before declaring the work complete.
- Never rewrite a published version entry. Keep `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and release tags on the same version.
- Every publication task automatically includes synchronizing `README.md`; do not wait for a separate user reminder. Update the public stable-version label, feature summary, release/download links, actual installer filenames, update description, and project status as one release-completion step. `README.md` is an overview, not a second version history; keep detailed records in `CHANGELOG.md` only.
- Before handing off a stable publication, verify that GitHub Latest, the newest stable `CHANGELOG.md` entry, and the README public-version sections agree, and that every README installer link identifies an uploaded release asset. Drafts and RCs must not replace the README public stable version; a withdrawal/rollback must restore the previous public stable references.
- Keep screenshot provenance honest: refresh materially outdated screenshots when possible, or label them as historical examples. Never relabel an old screenshot as the new release without capturing it from that version.
- Run `pnpm test scripts/release-readme.test.ts` and `git diff --check` for release-documentation synchronization. The contract follows the newest stable changelog entry rather than an unreleased package version; documentation-only changes do not require recompiling the application.

## Scope discipline

The MVP excludes cloud sync, required login, mobile apps, collaboration, AI writing, plugins, OCR, web clipping, databases-as-notes, and Git integration. Do not add adjacent features while implementing an approved task. Design future sync through stable IDs and explicit service boundaries, but do not build it early.

## Git and review

- Preserve unrelated user changes.
- Keep commits focused and use imperative commit subjects.
- Run the relevant lint, type-check, unit, integration, and build checks before declaring work complete.
- Describe data migrations, compatibility impact, and Windows/macOS verification in reviews.
- Never commit secrets, local application data, generated note libraries, signing material, or `.superpowers/` brainstorming files.
