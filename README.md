# Cay（微屿）

一个本地优先、轻量的笔记应用。Cay（微屿）不要求登录，也不依赖网络，笔记内容保存在自己的设备上。支持 Markdown 与富文档笔记，并可在资料库中管理多种格式的文件。

![Cay（微屿）v1.1.1 界面示意图](docs/screenshots/weiyu-editor.png)

## 核心特点

- 本地优先：离线即可使用，Markdown 文件是可长期保存的内容。
- 富文档笔记：支持标题、行内格式、列表、任务、链接、图片、表格和单元格合并。
- 文档整理：支持正文对齐、字体与字号、标题层级编辑、目录折叠，以及表格横向滚动和直接选中。
- 多格式兼容：可导入纯文本、PDF、图片和 DOCX；PDF 与图片可直接预览，DOCX 可转换为可编辑文档。
- 资料库管理：通过文件夹组织笔记，支持搜索、标签和笔记间链接。
- 三种编辑视图：源码、分栏和预览，适合快速记录与整理。
- 临时便笺：先快速捕捉想法，再整理为正式笔记。
- 安全恢复：删除内容进入回收站，可在需要时恢复。
- 轻量界面：温暖、圆润、低干扰，适合长时间阅读和写作。

## 最新版本

当前发布候选版本为 [Cay v1.1.1](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.1.1)；当前公开稳定版本为 [Cay v1.1.0](https://github.com/Tiome-tt/weiyu-cay/releases/latest)。

v1.1.1 提供 Windows x64 和 macOS（Intel / Apple Silicon）安装包，并包含 Tauri updater 所需的签名更新元数据；同时改善 PDF 导出、表格编辑、标题层级编辑和笔记打开速度。富文档标题支持在前缀处回车插入空行，目录折叠状态会按笔记保留，图片右键菜单仅保留“复制图片”。

## Windows 安装

发布包完成平台验收后，可前往 [Cay v1.1.1 Release](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.1.1) 下载 Windows x64 安装包。

- [`_1.1.1_x64-setup.exe`](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.1.1)：普通用户推荐，双击即可安装。
- [`_1.1.1_x64_en-US.msi`](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.1.1)：需要 MSI 安装包时使用。

## macOS 安装

发布包完成平台验收后，可在 [Cay v1.1.1 Release](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.1.1) 中选择对应芯片的安装包：

- [`_1.1.1_x64.dmg`](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.1.1)：Intel 芯片 Mac。
- [`_1.1.1_aarch64.dmg`](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.1.1)：Apple 芯片 Mac。

首次打开如果出现系统安全提示，请在系统设置中允许打开微屿。

## 自动更新

v1.1.1 发布包包含签名的更新清单和安装包。应用内的“检查更新”操作会查询 GitHub 最新稳定版本；发现新版本后，由用户确认下载、安装并重启，不会在后台静默安装。

## 从源码运行

```powershell
pnpm install
pnpm tauri dev
```

常用检查命令：

```powershell
pnpm typecheck
pnpm test
pnpm tauri build
```

## 项目状态

当前公开稳定版本为 v1.1.0，v1.1.1 发布候选正在进行平台验收。项目仍在持续完善中，欢迎通过 [Issues](https://github.com/Tiome-tt/weiyu-cay/issues) 反馈问题或建议。
