# Cay（微屿）

一个本地优先、轻量的 Markdown 笔记应用。Cay（微屿）不要求登录，也不依赖网络，笔记内容保存在自己的设备上。

![Cay（微屿）界面示意图](docs/screenshots/weiyu-editor.png)

## 核心特点

- 本地优先：离线即可使用，Markdown 文件是可长期保存的内容。
- 资料库管理：通过文件夹组织笔记，支持搜索、标签和笔记间链接。
- 三种编辑视图：源码、分栏和预览，适合快速记录与整理。
- 临时便笺：先快速捕捉想法，再整理为正式笔记。
- 安全恢复：删除内容进入回收站，可在需要时恢复。
- 轻量界面：温暖、圆润、低干扰，适合长时间阅读和写作。

## 最新版本

当前稳定版本为 [Cay v1.0.2](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.0.2)。

v1.0.2 提供 Windows x64 和 macOS（Intel / Apple Silicon）安装包，并包含 Tauri updater 所需的签名更新元数据。

## Windows 安装

前往 [Cay v1.0.2 Release](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.0.2) 下载 Windows x64 安装包。

- `微屿_1.0.2_x64-setup.exe`：普通用户推荐，双击即可安装。

## macOS 安装

在 [Cay v1.0.2 Release](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.0.2) 中选择对应芯片的安装包：

- `微屿_1.0.2_x64.dmg`：Intel 芯片 Mac。
- `微屿_1.0.2_aarch64.dmg`：Apple 芯片 Mac。

首次打开如果出现系统安全提示，请在系统设置中允许打开微屿。

## 自动更新

v1.0.2 已发布签名的更新清单和安装包。应用内的“检查更新”操作会查询 GitHub 最新稳定版本；发现新版本后，由用户确认下载、安装并重启，不会在后台静默安装。

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

当前公开稳定版本为 v1.0.2。项目仍在持续完善中，欢迎通过 [Issues](https://github.com/Tiome-tt/weiyu-cay/issues) 反馈问题或建议。
