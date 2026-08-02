# Copis 客户端方案

## 1. 方案状态

本文档记录 Copis Working 专用客户端的实施方案，当前仅完成方案设计，暂不包含代码实现、Git remote 操作、提交或推送。

目标仓库：

    git@github.com:zalsay/copis.git

基础项目：

    /Users/sisu/Documents/dev/Proma

后端项目：

    /Users/sisu/Documents/dev/ai-education

## 2. 总体结论

Copis 直接以 Proma 项目作为 Electron 客户端基础，在 Proma 的应用、渲染器、主进程、Pi SDK 和构建系统之上改造成 Working 专用产品。

不在 ai-education/frontend 中新增 Electron 页面，也不在 Proma 中维护第二套独立 Electron 构建链路。

Copis 的界面组成如下：

- Proma 负责整体应用壳层。
- 左侧菜单保留当前 Working 的简单版本。
- 中间对话区域直接复用 Proma 的 Conversation UI。
- 右侧文件区域直接复用 Proma 的 File Panel/UI。
- Working 只补充业务数据、运行状态、工作区和技能等领域逻辑。

ai-education 继续负责后端服务和现有 Web/Tauri 客户端。Copis 是独立的 Electron 产品，使用同一套后端业务接口，但不改变现有 Tauri 本地文件行为。

## 3. 总体架构

~~~~mermaid
flowchart LR
  A["Copis Electron Renderer"] --> B["Proma AppShell"]
  B --> C["Working 简单左侧菜单"]
  B --> D["Proma 对话区域"]
  B --> E["Proma 右侧文件区域"]
  D --> F["Proma Preload IPC"]
  E --> F
  F --> G["Electron Main Process"]
  G --> H["Proma Pi 本地 SDK"]
  G --> I["本地工作区文件服务"]
  G --> J["ai-education 本机后端"]
~~~~

运行边界：

| 模块 | Copis 中的职责 |
| --- | --- |
| Proma AppShell | 应用布局、主题、窗口级交互和基础导航 |
| Working 左侧菜单 | Working 当前的简单菜单内容和入口 |
| Proma 对话区域 | 消息展示、Composer、滚动、对话交互和基础操作 |
| Proma 右侧文件区域 | 文件列表、文件预览、文件选择和面板状态 |
| Proma Pi SDK | 本地 Agent 执行、工具调用和模型流式事件 |
| Electron main/preload | IPC、文件访问、Agent 生命周期和后端请求 |
| ai-education 后端 | 账号、工作区、会话历史、技能和业务数据 |
| 本地文件系统 | Copis 默认的工作区和文件数据来源 |

## 4. UI 复用方案

### 4.1 应用壳层

直接沿用 Proma 的：

- AppShell
- 顶部应用栏
- 主内容布局
- Panel、PanelHeader 和 ScrollArea
- Dialog、Popover、Settings 等基础组件
- classic theme 的颜色、间距、字体和交互状态

不再把当前 Working 的整体 Working.css 作为全局样式迁移到 Copis，避免覆盖 Proma 的组件系统。

### 4.2 左侧菜单

左侧菜单保持当前 Working 的简单版本：

- 菜单项目、层级和业务入口以当前 Working 为准。
- 菜单容器、折叠行为、宽度、选中态和主题能力复用 Proma 的侧栏代码。
- 只替换菜单内容和 Working 相关状态，不引入 Proma 当前不需要的复杂菜单。
- 菜单点击后仍由 Copis 的 Working 路由或状态切换控制主内容区域。

目标是保留 Working 的简单操作路径，同时让菜单在 Proma 壳层中拥有一致的尺寸、主题和交互行为。

### 4.3 中间对话区域

中间区域直接复用 Proma 的对话区域，不重新实现 Working 专属聊天布局。

Working 需要提供适配层，将以下数据接入 Proma 对话组件：

- Working 会话和消息历史
- Pi 本地 Agent 的流式文本
- 工具调用和工具结果
- Patch、Todo、文件变更和运行状态
- 停止、失败、完成和重试状态

Proma 对话区域保留视觉和交互实现，Working 只负责数据源和业务动作。

### 4.4 右侧文件区域

右侧区域直接复用 Proma 的文件区域代码，但文件数据源改为 Copis 本地文件服务。

文件区域需要支持：

- 当前本地工作区目录
- 文件树和目录展开
- 文件选择和预览
- Agent 产生的文件变更
- Patch 或文件差异展示
- 与当前会话关联的本地文件状态

不将右侧文件区域连接到 COS。Proma 的文件 UI 与文件存储实现必须通过 provider/service 接口隔离，Copis 使用 LocalFileProvider。

## 5. Agent 方案

### 5.1 执行位置

Agent 只在 Copis Electron main process 中运行：

    Renderer -> Preload IPC -> Main Process -> Proma Pi Local SDK

renderer 不直接引入 Pi SDK，也不直接使用 Node 文件系统。

优先复用 Proma 已有的 Agent service、Pi 初始化、模型配置和事件处理逻辑，只为 Working 增加运行上下文和事件适配，不重复实现另一套 Pi 生命周期。

### 5.2 运行上下文

每次运行需要绑定：

- Copis 本地工作区根目录
- Working 会话 ID
- 本地 run ID
- 后端会话或历史记录 ID
- 当前 Pi model/profile
- 当前 Working fast/expert 模式

本地 Agent 运行不经过远程 working-agent-service，避免同一个任务同时由本地 Pi 和云端 Agent 执行。现有 Web/Tauri 客户端的远程运行链路保持不变。

### 5.3 事件适配

Pi SDK 事件转换为 Copis renderer 可消费的 Working 事件：

- run_started
- message_delta
- tool_call
- tool_result
- file_change
- patch
- todo
- run_completed
- run_failed
- run_stopped

需要继续保留当前 Working 的失败恢复行为：

- 失败后恢复用户尚未完成的输入。
- 清理失效的 active run。
- 解除 Composer 忙碌状态。
- 显示可理解的错误。
- 允许用户直接重试。

## 6. 后端接入方案

Copis 通过 Electron main process 中的 WorkingApiClient 接入 ai-education 后端。

后端负责：

- 登录和账号信息
- 工作区和项目数据
- Working 会话及历史记录
- 技能和专家配置
- 必要的业务设置

Copis 不把后端 Agent 执行作为本地运行的默认路径。

本地 Agent 运行完成后，如后端已有对应的会话或历史接口，则通过 API 同步运行状态和消息；如果现有接口要求 COS 文件 key，Copis 需要增加本地文件适配协议或跳过该云端文件字段，不能偷偷把本地文件上传到 COS。

后端地址必须是运行环境配置，不应硬编码到 renderer：

| 环境 | 后端地址 |
| --- | --- |
| 本机开发 | 当前 ai-education 本机开发服务地址 |
| 测试环境 | 后续配置的测试后端地址 |
| 生产环境 | 后续部署后的生产后端地址 |

开发阶段 Copis 与本机后端同时运行。后续部署后只切换 Copis 的后端配置，不把后端代码打包进 Electron。

## 7. 本地文件和附件边界

Copis 默认不需要 COS：

- 本地工作区文件只保存在用户本机。
- Agent 直接读取和修改本地文件。
- 右侧文件面板读取本地文件服务。
- 本地文件不自动上传到后端。
- 附件默认使用本地文件引用或本地内容。
- 不创建 COS 上传、下载和附件元数据依赖。

需要特别区分：

- Copis 的本地文件边界只适用于新的 Electron 客户端。
- ai-education Web/Tauri 客户端的现有 COS 和本地文件逻辑不修改。
- 后续如果增加云端同步，应作为独立功能和明确的用户操作，不作为 Copis 默认行为。

Electron 文件访问应通过 main/preload 受控 API 实现，并执行：

- 工作区根目录校验
- 路径规范化
- 符号链接和越界路径限制
- 文件大小限制
- 扫描深度和文件数量限制

## 8. Copis 仓库和构建方案

### 8.1 仓库关系

Copis 目录作为独立产品仓库，目标 remote 为：

    origin = git@github.com:zalsay/copis.git

Proma 原仓库作为后续同步用的 upstream。正式实施前需要确认 Proma 的官方 remote 和许可证，确保派生、修改和分发方式符合许可要求。

推荐保留 Proma 历史，不使用 Git submodule。这样 Copis 可以直接使用和修改 Proma 的 Electron 源码，同时仍能定期同步 Proma 上游更新。

推荐分支职责：

- main：Copis 可发布代码
- codex/*：功能开发和迁移
- proma-sync/*：同步 Proma 上游时的临时分支

### 8.2 Electron 构建

继续使用 Proma 现有：

- Bun workspace
- Vite renderer 构建
- esbuild main/preload 构建
- electron-builder
- runtime dependency 同步
- Windows/macOS 构建和分发脚本

Copis 需要独立配置：

- 产品名：Copis
- appId
- 应用图标
- userData 目录
- 日志目录
- 安装包名称
- 自动更新配置
- 后端环境配置

不新增第二套 Electron 构建系统，也不把 Tauri、working-agent-service 或云端 Go sidecar 打入 Copis 本地客户端。

## 9. 实施阶段

### 阶段一：Copis 基线

- 以 Proma 稳定版本建立 Copis 仓库基线。
- 设置 Copis GitHub remote。
- 确认 Proma upstream 和许可证。
- 确认 Copis 产品配置和本机后端地址。

### 阶段二：Proma 壳层产品化

- 将应用身份切换为 Copis。
- 保留 Proma Electron 启动、开发和打包流程。
- 建立 Copis 独立 userData、日志和配置边界。

### 阶段三：Working 菜单迁移

- 使用 Proma 侧栏代码承载当前 Working 简单菜单。
- 迁移菜单状态、入口和工作区切换行为。
- 不迁移 Working 的整体页面壳层。

### 阶段四：对话和文件区域接入

- 复用 Proma Conversation UI。
- 复用 Proma 右侧 File Panel。
- 将 Working 会话、消息、运行事件和本地文件 provider 接入 Proma 组件。

### 阶段五：本地 Agent 和后端

- 复用 Proma Pi Agent service。
- 接入本地工作区和文件 IPC。
- 接入 ai-education 本机后端的账号、工作区、会话和历史接口。
- 完成本地运行、停止、失败恢复和重试。

### 阶段六：构建和验证

- Electron 开发运行验证。
- IPC contract 和文件边界验证。
- Pi 本地 Agent smoke。
- 本机后端集成验证。
- Windows/macOS 安装包验证。
- 后续后端部署后，再进行生产地址和生产构建验收。

## 10. 验收标准

- Copis 使用 Proma 的 Electron 壳层和构建系统。
- 产品名称、窗口标题和安装包身份均为 Copis。
- 左侧菜单是当前 Working 的简单版本。
- 中间对话区域复用 Proma。
- 右侧文件区域复用 Proma。
- Agent 使用 Proma Pi 本地 SDK。
- 本地工作区文件不自动上传 COS。
- Copis 可以连接本机运行的 ai-education 后端。
- 后端地址可以在后续部署时切换。
- Proma 对话区域能够显示 Working 消息、工具调用、Patch、Todo 和运行错误。
- 失败后 Composer 可以继续使用并直接重试。
- 原 ai-education Web/Tauri 客户端不受影响。
- Copis 可以复用 Proma 原有 Electron 构建和打包流程。

## 11. 当前不做的事项

- 不修改 ai-education/frontend。
- 不修改现有 Tauri 本地文件实现。
- 不把 Copis 的本地 Agent 改成远程 working-agent-service。
- 不默认接入 COS。
- 不自动同步整个本地工作区到后端。
- 不重写 Proma 对话区域。
- 不重写 Proma 右侧文件区域。
- 不创建第二套 Electron 构建链路。
