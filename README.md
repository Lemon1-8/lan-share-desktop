# LanShare Desktop

![LanShare Desktop 图标](build/icon.png)

LanShare Desktop 是一个 Windows 优先的局域网点对点文件共享桌面软件。每台运行本软件的电脑既是客户端，也是只读文件服务端；同一局域网内的设备可以自动发现彼此、浏览共享清单、预览文件并下载。

## 功能

- 本机文件库：创建文件夹、添加文件或文件夹、取消共享、重新共享和移除文件记录。
- 局域网发现：通过 UDP 广播发现同一网段内正在运行 LanShare Desktop 的设备。
- 只读远程访问：远程用户只能预览和下载文件，不能上传、编辑、删除或取消共享。
- 文件预览：支持图片、PDF、文本、音频和视频等常见格式预览。
- 文件夹下载：直接逐文件下载远端共享文件夹，并在本地保留原目录结构。
- 断点下载：基于 HTTP Range 下载，失败后可重试并复用 `.part` 临时文件。
- 下载任务：展示下载进度、速度、状态、保存路径和失败原因。
- 本机设置：支持设备名称、文件库路径、服务端口、发现端口和开机自启。
- Windows 打包：使用 Electron Builder 生成 portable `.exe`。

## 环境要求

- Windows 10/11
- Node.js 20 或更高版本
- npm

## 本地开发

```bash
npm install
npm run dev
```

开发模式会同时启动 Vite、TypeScript 主进程编译监听和 Electron。

## 类型检查

```bash
npm run typecheck
```

## 构建

```bash
npm run build
```

## 打包 Windows 便携版

```bash
npm run pack:win
```

打包完成后，产物位于：

```text
release/LanShare-Desktop-0.1.0-portable.exe
```

## 使用说明

1. 在同一局域网内的两台或多台 Windows 电脑上运行软件。
2. 首次运行时，如果 Windows 防火墙弹窗，请允许专用网络访问。
3. 在“我的文件”中创建目录，并添加要共享的文件或整个文件夹。
4. 在另一台电脑的“局域网”页面中刷新或等待自动发现设备。
5. 选择远程设备后，可以预览支持的文件类型，也可以下载文件或整个文件夹。

## 局域网与安全说明

- 文件仍保存在上传者电脑上；上传者离线后，其他电脑不能继续预览或下载该设备上的文件。
- 当前版本默认信任同一局域网内运行本软件的用户，不包含账号、密码、设备审批或传输加密。
- 如果设备互相发现失败，请检查两台电脑是否在同一网段，并确认防火墙允许本软件的 UDP 广播和 HTTP 访问。
- 本软件适合家庭、办公室、小组测试等受信任局域网环境，不建议直接暴露到公网。

## GitHub Release

最新 Windows 便携版可以从 GitHub Releases 下载：

<https://github.com/Lemon1-8/lan-share-desktop/releases/latest>

## 技术栈

- Electron
- TypeScript
- Vite
- sql.js
- electron-builder

## 许可证

当前仓库尚未声明开源许可证。未经作者明确授权，请不要将本项目用于再分发场景。
