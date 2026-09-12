# Cay（微屿）

一个本地优先、轻量的笔记应用。Cay（微屿）不要求登录，也不依赖网络，笔记内容保存在自己的设备上。支持 Markdown 与富文档笔记，并可在资料库中管理多种格式的文件。

![Cay（微屿）v1.1.0 界面示意图](docs/screenshots/weiyu-editor.png)

## 核心特点

- 本地优先：离线即可使用，Markdown 文件是可长期保存的内容。
- 富文档笔记：支持标题、行内格式、列表、任务、链接、图片、表格和单元格合并。
- 多格式兼容：可导入纯文本、PDF、图片和 DOCX；PDF 与图片可直接预览，DOCX 可转换为可编辑文档。
- 资料库管理：通过文件夹组织笔记，支持搜索、标签和笔记间链接。
- 三种编辑视图：源码、分栏和预览，适合快速记录与整理。
- 临时便笺：先快速捕捉想法，再整理为正式笔记。
- 安全恢复：删除内容进入回收站，可在需要时恢复。
- 轻量界面：温暖、圆润、低干扰，适合长时间阅读和写作。

## 最新版本

当前稳定版本为 [Cay v1.1.0](https://github.com/Tiome-tt/weiyu-cay/releases/latest)。

v1.1.0 提供 Windows x64 和 macOS（Intel / Apple Silicon）安装包，并包含 Tauri updater 所需的签名更新元数据。

## Windows 安装

前往 [Cay v1.1.0 Release](https://github.com/Tiome-tt/weiyu-cay/releases/latest) 下载 Windows x64 安装包。

- [`_1.1.0_x64-setup.exe`](https://github.com/Tiome-tt/weiyu-cay/releases/latest/download/_1.1.0_x64-setup.exe)：普通用户推荐，双击即可安装。
- [`_1.1.0_x64_en-US.msi`](https://github.com/Tiome-tt/weiyu-cay/releases/latest/download/_1.1.0_x64_en-US.msi)：需要 MSI 安装包时使用。

## macOS 安装

在 [Cay v1.1.0 Release](https://github.com/Tiome-tt/weiyu-cay/releases/latest) 中选择对应芯片的安装包：

- [`_1.1.0_x64.dmg`](https://github.com/Tiome-tt/weiyu-cay/releases/latest/download/_1.1.0_x64.dmg)：Intel 芯片 Mac。
- [`_1.1.0_aarch64.dmg`](https://github.com/Tiome-tt/weiyu-cay/releases/latest/download/_1.1.0_aarch64.dmg)：Apple 芯片 Mac。

首次打开如果出现系统安全提示，请在系统设置中允许打开微屿。

## 自动更新

v1.1.0 已发布签名的更新清单和安装包。应用内的“检查更新”操作会查询 GitHub 最新稳定版本；发现新版本后，由用户确认下载、安装并重启，不会在后台静默安装。

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

当前公开稳定版本为 v1.1.0。项目仍在持续完善中，欢迎通过 [Issues](https://github.com/Tiome-tt/weiyu-cay/issues) 反馈问题或建议。
