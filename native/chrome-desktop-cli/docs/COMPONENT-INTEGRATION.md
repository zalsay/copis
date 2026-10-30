# 内置 Chrome Tool 组件化（2026-10-19）

## 当前实现：MCC 0.3.6（2026-10-30）

- Copis 的 `ChromeDesktopStart`、`ChromeDesktopObserve`、`ChromeDesktopClick`、`ChromeDesktopScroll`、`ChromeDesktopType`、`ChromeDesktopPress`、`ChromeDesktopSelectFile`、`ChromeDesktopStop` 工具名和参数不变；这些工具由受管 **MCC (`mcc`)** 执行，Agent 不需要通过 Bash 再运行 CLI。
- 复用原 `chrome-desktop-cli` 功能模块标识，在“关于/更新”的现有功能模块管理中安装与更新，版本锁为 `0.3.6`，manifest 入口为 `copis-chrome-0.3.6-darwin-{arch}/mcc`。官方归档的 `module.json` 可仍标记兼容默认入口 `copis-chrome`；Copis 只执行同包内 `mcc`，并验证 `macos-chrome-helper`（兼容旧包内 `copis-chrome-helper`）。
- `mcc` 按通用桌面协议工作，使用独占 `COPIS_DESKTOP_RUNTIME_DIR` 和受管 `COPIS_DESKTOP_HELPER`，不继承外部 `COPIS_DESKTOP_*` / `COPIS_CHROME_*` 覆盖。列窗显式传 `windows --app com.google.Chrome`，连接回执再次核实 bundleId、PID、窗口 ID；不把通用应用控制能力暴露给 Chrome 工具。
- 截图原像素交付，不缩放或改变分辨率；接受 MCC 的最大 `1600×8192` 像素边界和 1 MiB JPEG 上限。权限、会话 capability、暂停、截图隔离、连接版本固定和私有 daemon 清理继续使用现有链路。
- 老 `copis-chrome` active 入口只会触发现有安装器尝试升级，升级不可用时明确失败，不静默回退旧 CLI 或 PATH 中的 `mcc`。已建立连接继续固定原版本，下次新连接解析更新后的组件。

发布准备继续使用 `--chrome-cli`，但必须提供 MCC 归档；需要从独立仓库构建时，显式设置 `COPIS_MCC_SOURCE_DIR`，不再编译本目录的历史 CLI 源码：

```bash
./deploy.sh --chrome-cli --platform darwin --arch arm64 \
  --chrome-cli-archive /绝对路径/copis-chrome-0.3.6-darwin-arm64.tar.gz
```

以上是当前集成契约；下文保留最初组件化实现的历史记录。



## 组件状态检测

- `installed` 对 MCC 表示受管入口、元数据、协议、目标架构及 helper 静态检查通过；仅有 active 指针或旧 `copis-chrome` 入口不算就绪。缺失、符号链接、不可执行文件或不兼容元数据会返回本地异常；旧入口单独提示升级。
- 刷新列表复用执行前的路径/元数据校验，但不执行 `mcc`、不安装、不修改文件权限、不创建 daemon、不申请系统权限。静态就绪不代表当前宿主已获得屏幕录制或辅助功能权限，实际调用仍保留原生门禁。
- `error` / `localIssue` 表示本地异常；`updateError` 独立表示更新检查失败或当前平台未发布。本地 MCC 有效时，远端检查失败只给更新警告，不撤销本地就绪状态。
- 未发布且本地未安装时明确提示“当前平台组件尚未发布，暂时无法安装”，提供重新检查入口而不诱导重复安装。网络错误、未发布与本地异常不再统称为 MCC 启动失败；界面不直接回显原始 URL、路径或错误正文。
- 检查结束后重新读取本地状态，避免远端请求期间的安装变化被旧快照覆盖。安装同版本的快捷路径也必须通过本地校验，不能把损坏的 helper 当作已是最新且就绪。


## 目标与行为

内置 ChromeDesktopStart/Observe/Click/Scroll/Type/Press/Stop 的工具名、会话 capability 与用户选择窗口保持兼容，实际截图和输入改为调用独立 chrome-desktop-cli 功能模块。模块仅支持 macOS 14+、可从功能模块设置按独立版本安装与更新；不要求更新 Electron。沿用 manifest 的版本、SHA256、下载、受管版本目录和 active.json，不创建另一套更新系统。

Chrome 模块为可选组件，不能成为 Windows/Linux 或整个应用启动的必选项。首次用户发起 Chrome 工具时允许按需准备模块；缺少可用发布 artifact 时明确提示到功能模块设置安装/重试，不能回退到旧的内置 Swift helper。模块列表呈现版本与更新状态，使用现有 Jotai 状态。

## 调用与更新边界

Electron 主进程中的轻量 component client 将工具动作映射为 copis-chrome CLI，保持 connectionId 仅在主进程内存；截图文件只从该组件私有运行目录读取，转为单次模型图片输入。模型仍只收到当前 Observe 图片，不积累 base64 历史。Observe 直接使用原生截图，不依赖 renderer 截帧。Electron 实时视频流仅用于现有预览，预览失败不能导致原生连接失败。

每个 Copis 主进程使用独立运行目录，与用户终端 CLI 连接隔离。一次已建立控制固定 component version/path，更新只改变 active 指针；当前动作与连接继续用旧目录，下次新连接解析新版本。取消/停止走独立命令，不等待正在执行的输入；模块超时或 EOF 不能被解释为成功。不可通过 PATH 或任意环境变量绕过受管模块路径。

同一 native frameId 可多次使用，没有时间硬过期；保留最近32帧，检查本控制归属和几何。Rust 负责原生坐标、焦点检查和自动恢复前台，Electron 不维护第二套输入控制逻辑。读取不切前台。原有紧急停止快捷键、跨 turn 复用控制和鉴权仍由 ChromeDesktopService 保留。

## 实施任务

- [x] 组件契约与版本管理：模块名 chrome-desktop-cli、macOS optional 定义、设置列表、独立版本锁、manifest/发布参数和受控构建入口；移除 Electron 默认构建中的旧 helper。
- [x] component client：受管版本解析、按需准备、CLI JSON 协议、连接/图像/输入/取消、版本固定和下次连接升级，先写BDD回归。
- [x] ChromeDesktopService：保留会话和工具契约，原生帧与输入委派组件，替换旧 helper 调用与 renderer 截帧依赖，保留32帧和幂等回执。
- [x] 预览与 IPC：窗口选择与授权流程兼容，视频预览改为尽力启动；预览轨道丢失不能撤销原生连接，停止/退出清理。
- [x] 验证：分别运行有 module mock 的 Bun 测试进程、Rust 测试、typecheck、main/preload/renderer/worker 构建、真实已激活组件只读 smoke。
- [x] 独立代码审查和简化，交付具体测试结果；Electron UI 与真实输入留给用户在实际窗口确认。

## 权限与范围

不安装新依赖，不上传 COS、不发布、不操作真实 Chrome 输入、不修改根 README/AGENTS（更新需用户允许）。发布脚本只增加能力并用本地 manifest 验证，远端发布由用户后续明确发起。继续使用 codex/chrome-desktop-cli 隔离 worktree，保留主工作区未提交聊天室修改。

## 验证与本机状态

验证明细见 COMPONENT-VERIFICATION.md。内置工具已完整委派组件，旧 helper 与 renderer 帧 IPC 已移除。本机正式配置目录中的 chrome-desktop-cli v0.1.4 已按受管流程安装激活；权限、列窗、恢复前台与原生提示生命周期验证通过，验证后台进程已停止。焦点修复与实测见 FOCUS-VERIFICATION.md。未发布线上归档或 manifest；默认开发/应用构建不捆绑该组件。

v0.1.2 在原生 CLI 恢复 Chrome 前台后展示屏幕顶部操作提示，默认 3 秒；连续输入不重复弹出，读取不提示。AppKit 状态与受管 CLI 验证见 TOAST-VERIFICATION.md，视觉效果由用户在实际屏幕确认。

v0.1.3 针对系统截图服务断连/超时加入受限的系统单窗口采集回退，不切换前台；错误保留白名单原生码和固定原因。排查与验证见 CAPTURE-VERIFICATION.md。既有连接需显式停止后重新开始，才使用当前 active 组件。

v0.1.4 指针输入联合检查 WindowServer 的实际事件接收窗口和 AX 命中，避免误拒鼠标可穿透的绘制层；真实输入遮挡和未知归属仍拒绝，没有应用白名单或裸 CGEventPost 兜底。只读回归与兼容边界见 POINTER-VERIFICATION.md。
