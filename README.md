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

## Windows 安装

前往 [Windows v1.0.1 Release](https://github.com/Tiome-tt/weiyu-cay/releases/tag/v1.0.1) 下载安装包。

- `weiyu-cay_1.0.1_x64-setup.exe`：普通用户推荐，双击即可安装。
- `weiyu-cay_1.0.1_x64_en-US.msi`：适合 Windows Installer、企业部署或静默安装。


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

当前公开版本为 Windows 1.0.1 预发布版。项目仍在持续完善中，欢迎通过 [Issues](https://github.com/Tiome-tt/weiyu-cay/issues) 反馈问题或建议。
