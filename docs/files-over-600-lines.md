# 超过 600 行的代码文件清单

> 统计范围：项目源码（`.ts` / `.tsx` / `.rs` / `.js` / `.jsx` / `.vue`）
> 已排除：`node_modules/`、`dist/`、`out/`、`third_party/`、`default-skills/`（内嵌技能模板）、`target/` 等第三方与构建产物目录。
> 统计日期：2026-08-25，共 **80** 个文件。

## 📊 概览

| 层级 | 文件数 | 说明 |
|------|--------|------|
| Electron 主进程 (`apps/electron/src/main`) | 38 | 超大文件重灾区 |
| 渲染进程 (`apps/electron/src/renderer`) | 26 | 组件普遍偏大 |
| Preload | 1 | |
| Rust HTTP API (`native/http-api-server/src`) | 15 | 含测试文件 |
| 共享包 (`packages/shared`) | 2 | |
| 根脚本 (`scripts`) | 1 | |

## ⚠️ Top 10（重点关注）

| 行数 | 文件 | 说明 |
|-----:|------|------|
| 5253 | `apps/electron/src/main/ipc.ts` | 所有 IPC 处理器集中在一个文件 |
| 3697 | `native/http-api-server/src/main.rs` | Rust API 入口 + 路由注册 |
| 3115 | `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx` | Agent 对话主面板 |
| 2788 | `apps/electron/src/main/lib/agent-orchestrator.ts` | Agent 编排核心 |
| 2714 | `apps/electron/src/preload/index.ts` | 全部 IPC 桥接集中在单文件 |
| 2593 | `apps/electron/src/main/lib/feishu-bridge.ts` | 飞书集成 |
| 2217 | `native/http-api-server/src/memory.rs` | 记忆系统存储底座 |
| 2128 | `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` | Pi Agent 适配器 |
| 1990 | `apps/electron/src/main/lib/agent-workspace-manager.ts` | 工作区管理 |
| 1983 | `apps/electron/src/main/lib/channel-manager.ts` | 渠道管理 |

## 完整清单

### Electron 主进程（main）

| 行数 | 文件 |
|-----:|------|
| 5253 | `src/main/ipc.ts` |
| 2788 | `src/main/lib/agent-orchestrator.ts` |
| 2593 | `src/main/lib/feishu-bridge.ts` |
| 2128 | `src/main/lib/adapters/pi-agent-adapter.ts` |
| 1990 | `src/main/lib/agent-workspace-manager.ts` |
| 1983 | `src/main/lib/channel-manager.ts` |
| 1644 | `src/main/lib/agent-session-manager.ts` |
| 1433 | `src/main/lib/http-api-handler.ts` |
| 1342 | `src/main/lib/browser-workflow-service.ts` |
| 1266 | `src/main/lib/migration-service.ts` |
| 1150 | `src/main/lib/adapters/pi-builtin-tools.ts` |
| 1086 | `src/main/lib/agent-collaboration-tools.ts` |
| 1076 | `src/main/lib/web-tab-manager.ts` |
| 973 | `src/main/lib/wechat-bridge.ts` |
| 921 | `src/main/lib/agent-rpc-service.ts` |
| 920 | `src/main/lib/working-api-client.ts` |
| 916 | `src/main/lib/bridge-command-handler.ts` |
| 901 | `src/main/lib/config-paths.ts` |
| 849 | `src/main/lib/http-api-server.ts` |
| 760 | `src/main/lib/adapters/pi-model-registry.ts` |
| 750 | `src/main/index.ts` |
| 741 | `src/main/lib/git-diff-service.ts` |
| 727 | `src/main/lib/browser-agent-tool-service.test.ts`（测试） |
| 711 | `src/main/lib/file-preview-service.ts` |
| 695 | `src/main/lib/http-api-server-runtime.test.ts`（测试） |
| 669 | `src/main/lib/agent-rpc-service.test.ts`（测试） |
| 660 | `src/main/lib/browser-page-control-service.ts` |
| 637 | `src/main/lib/storage-service.ts` |
| 630 | `src/main/lib/browser-agent-tool-service.ts` |
| 624 | `src/main/lib/planning-manager.ts` |
| 610 | `src/main/lib/browser-workflow-playwright-script.ts` |
| 603 | `src/main/lib/browser-workflow-service.test.ts`（测试） |

### Electron 渲染进程（renderer）

| 行数 | 文件 |
|-----:|------|
| 3115 | `components/agent/AgentConversationSurface.tsx` |
| 1474 | `components/agent/SDKMessageRenderer.tsx` |
| 1438 | `components/diff/DiffTabContent.tsx` |
| 1361 | `components/agent/SidePanel.tsx` |
| 1316 | `atoms/agent-atoms.ts` |
| 1189 | `components/diff/markdown-preview-extensions.tsx` |
| 1161 | `main.tsx` |
| 1122 | `components/automation/AutomationFormView.tsx` |
| 1095 | `components/ai-elements/rich-text-input.tsx` |
| 1021 | `components/file-browser/FileBrowser.tsx` |
| 914 | `components/web-browser/WebBrowserSurface.tsx` |
| 821 | `components/agent/AgentMessages.tsx` |
| 819 | `components/ai-elements/message.tsx` |
| 809 | `components/app-shell/CopisWorkingMessageSettingsPanel.tsx` |
| 772 | `components/app-shell/CopisWorkingSidebar.tsx` |
| 716 | `components/ui/image-editor.tsx` |
| 701 | `components/app-shell/CopisWorkingPaymentModal.tsx` |
| 693 | `components/web-browser/WebBookmarksPopover.tsx` |
| 690 | `components/agent/ContentBlock.tsx` |
| 676 | `components/voice-dictation/VoiceDictationApp.tsx` |
| 668 | `components/memory/MemoryImportView.tsx` |
| 627 | `components/expert-team/ExpertTeamView.tsx` |
| 618 | `components/app-shell/CopisWorkingSettingsPanel.tsx` |
| 618 | `components/agent/AskUserBanner.tsx` |
| 603 | `components/app-shell/SearchDialog.tsx` |

### Electron Preload

| 行数 | 文件 |
|-----:|------|
| 2714 | `src/preload/index.ts` |

### Rust HTTP API（native/http-api-server）

| 行数 | 文件 |
|-----:|------|
| 3697 | `src/main.rs` |
| 2217 | `src/memory.rs` |
| 1333 | `src/expert_teams.rs` |
| 1206 | `src/skill_market.rs` |
| 1183 | `src/agent_files.rs` |
| 1126 | `src/working_payment.rs` |
| 1096 | `src/working_payment_tests.rs`（测试） |
| 958 | `src/auth_session.rs` |
| 954 | `src/pi_rpc.rs` |
| 901 | `src/alipay_bot.rs` |
| 863 | `src/payment_workspace.rs` |
| 855 | `src/working_gateway.rs` |
| 845 | `src/workspace_dev.rs` |
| 795 | `src/agent_files_tests.rs`（测试） |
| 691 | `src/main_tests.rs`（测试） |
| 657 | `src/runtime.rs` |
| 629 | `src/memory_tests.rs`（测试） |
| 614 | `src/automation.rs` |
| 609 | `src/agent_mail.rs` |

### 共享包（packages/shared）

| 行数 | 文件 |
|-----:|------|
| 1787 | `src/types/agent.ts` |
| 664 | `src/types/working.ts` |

### 根脚本（scripts）

| 行数 | 文件 |
|-----:|------|
| 658 | `publish-functional-modules.ts` |

## 💡 重构建议

1. **`ipc.ts`（5253 行）+ `preload/index.ts`（2714 行）**：IPC 四段式模式要求同步修改四个位置，单文件过大加剧了维护成本，建议按通道组（Chat / Agent / Feishu / WebBrowser 等）拆分为多个 handler 模块。
2. **`AgentConversationSurface.tsx`（3115 行）**：单个 React 组件承载过多职责，建议按消息列表、工具活动、权限交互等拆分子组件并下沉 hooks。
3. **`agent-orchestrator.ts`（2788 行）**：编排层混合了并发守卫、环境构建、持久化、事件流处理等多个关注点，可参考现有服务层边界继续拆分。
4. **`main.rs`（3697 行）**：Rust 侧路由注册集中，可按模块拆分 router。
5. 类型定义文件 `packages/shared/src/types/agent.ts`（1787 行）偏大，可考虑按域拆分。

> 备注：如需重新生成此报告，可运行：
>
> ```bash
> find . \( -name node_modules -o -name dist -o -name .git -o -name target -o -name build \
>   -o -name resources -o -name vendor -o -name coverage -o -name out \
>   -o -name third_party -o -name default-skills \) -prune -o -type f \
>   \( -name '*.ts' -o -name '*.tsx' -o -name '*.rs' -o -name '*.js' -o -name '*.jsx' \) -print0 \
>   | xargs -0 wc -l | awk '$1 > 600 && $2 != "total" {print $1, $2}' | sort -rn
> ```
