# 超过 600 行的代码文件清单

> 扫描日期：2026-09-10；HEAD：`03679b6b`，包含扫描时工作区未提交修改。
> **104 个文件：85 个生产文件、19 个测试/E2E 文件。**
> 拆分目标、批次与验收见 [over-600-lines-fix-plan.md](over-600-lines-fix-plan.md)。这是一份当前快照，不能据此推断旧日期是否漏扫。

## 统计口径

枚举 `rg --files --hidden` 返回的非忽略文件，包括未提交内容；仅 ts/tsx/rs/js/jsx/vue。排除目录见文末命令，包含 resources、default-skills、第三方和构建产物。以 LF 数计行，与 wc -l 一致，严格 >600。

测试识别为 test/spec 文件、Rust 单复数测试文件、tests 目录、test_backend，以及已核实的 browser-workflow-e2e-main.ts。测试单列表示实施优先级不同，不代表仓库规则豁免。此范围不声称覆盖被 Git/rg 忽略的手写文件。

## 分层汇总

| 分层（互斥） | 生产 | 测试/E2E |
|---|---:|---:|
| Electron 主进程（含 IPC） | 35 | 10 |
| Rust HTTP API | 15 | 6 |
| Electron 渲染进程（含 hooks/atoms/入口） | 29 | 2 |
| Preload | 2 | 0 |
| 共享包 | 2 | 0 |
| 根脚本 | 2 | 0 |
| 应用测试脚本 | 0 | 1 |
| **合计** | **85** | **19** |

## Electron 主进程（含 IPC）

| 行数 | 文件（仓库相对路径） |
|---:|---|
| 5459 | `apps/electron/src/main/ipc.ts` |
| 2862 | `apps/electron/src/main/lib/agent-orchestrator.ts` |
| 2593 | `apps/electron/src/main/lib/feishu-bridge.ts` |
| 2160 | `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` |
| 2111 | `apps/electron/src/main/lib/agent-workspace-manager.ts` |
| 1985 | `apps/electron/src/main/lib/channel-manager.ts` |
| 1658 | `apps/electron/src/main/lib/agent-session-manager.ts` |
| 1542 | `apps/electron/src/main/lib/web-tab-manager.ts` |
| 1530 | `apps/electron/src/main/lib/browser-workflow-service.ts` |
| 1410 | `apps/electron/src/main/lib/http-api-handler.ts` |
| 1266 | `apps/electron/src/main/lib/migration-service.ts` |
| 1157 | `apps/electron/src/main/lib/browser-workflow-page-executor.ts` |
| 1086 | `apps/electron/src/main/lib/agent-collaboration-tools.ts` |
| 1066 | `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts` |
| 973 | `apps/electron/src/main/lib/browser-workflow-runner.ts` |
| 973 | `apps/electron/src/main/lib/wechat-bridge.ts` |
| 959 | `apps/electron/src/main/lib/agent-rpc-service.ts` |
| 921 | `apps/electron/src/main/lib/dsh-cordis-service.ts` |
| 920 | `apps/electron/src/main/lib/working-api-client.ts` |
| 916 | `apps/electron/src/main/lib/bridge-command-handler.ts` |
| 915 | `apps/electron/src/main/lib/config-paths.ts` |
| 903 | `apps/electron/src/main/lib/http-api-server.ts` |
| 841 | `apps/electron/src/main/lib/browser-page-control-service.ts` |
| 820 | `apps/electron/src/main/lib/file-preview-service.ts` |
| 817 | `apps/electron/src/main/lib/web-password-autofill-script.ts` |
| 771 | `apps/electron/src/main/index.ts` |
| 760 | `apps/electron/src/main/lib/adapters/pi-model-registry.ts` |
| 741 | `apps/electron/src/main/lib/git-diff-service.ts` |
| 694 | `apps/electron/src/main/lib/dsh-model-config.ts` |
| 693 | `apps/electron/src/main/lib/cdp-session-router.ts` |
| 637 | `apps/electron/src/main/lib/storage-service.ts` |
| 630 | `apps/electron/src/main/lib/browser-agent-tool-service.ts` |
| 629 | `apps/electron/src/main/lib/agent-prompt-builder.ts` |
| 624 | `apps/electron/src/main/lib/planning-manager.ts` |
| 610 | `apps/electron/src/main/lib/browser-workflow-playwright-script.ts` |

## Rust HTTP API

| 行数 | 文件（仓库相对路径） |
|---:|---|
| 3847 | `native/http-api-server/src/main.rs` |
| 2220 | `native/http-api-server/src/memory.rs` |
| 1462 | `native/http-api-server/src/expert_teams.rs` |
| 1456 | `native/http-api-server/src/skill_market.rs` |
| 1339 | `native/http-api-server/src/agent_files.rs` |
| 1144 | `native/http-api-server/src/working_payment.rs` |
| 1013 | `native/http-api-server/src/automation.rs` |
| 1001 | `native/http-api-server/src/pi_rpc.rs` |
| 991 | `native/http-api-server/src/auth_session.rs` |
| 929 | `native/http-api-server/src/working_gateway.rs` |
| 901 | `native/http-api-server/src/alipay_bot.rs` |
| 862 | `native/http-api-server/src/payment_workspace.rs` |
| 845 | `native/http-api-server/src/workspace_dev.rs` |
| 657 | `native/http-api-server/src/runtime.rs` |
| 604 | `native/http-api-server/src/agent_mail.rs` |

## Electron 渲染进程（含 hooks/atoms/入口）

| 行数 | 文件（仓库相对路径） |
|---:|---|
| 3212 | `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx` |
| 1723 | `apps/electron/src/renderer/components/trading/FundStockTerminalView.tsx` |
| 1493 | `apps/electron/src/renderer/components/agent/SDKMessageRenderer.tsx` |
| 1474 | `apps/electron/src/renderer/components/diff/DiffTabContent.tsx` |
| 1433 | `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts` |
| 1363 | `apps/electron/src/renderer/components/agent/SidePanel.tsx` |
| 1316 | `apps/electron/src/renderer/atoms/agent-atoms.ts` |
| 1261 | `apps/electron/src/renderer/main.tsx` |
| 1254 | `apps/electron/src/renderer/components/ai-elements/rich-text-input.tsx` |
| 1231 | `apps/electron/src/renderer/components/app-shell/CopisWorkingMessageSettingsPanel.tsx` |
| 1189 | `apps/electron/src/renderer/components/diff/markdown-preview-extensions.tsx` |
| 1184 | `apps/electron/src/renderer/components/app-shell/CopisWorkingSidebar.tsx` |
| 1122 | `apps/electron/src/renderer/components/automation/AutomationFormView.tsx` |
| 1014 | `apps/electron/src/renderer/components/file-browser/FileBrowser.tsx` |
| 1005 | `apps/electron/src/renderer/components/web-browser/WebBrowserSurface.tsx` |
| 975 | `apps/electron/src/renderer/components/web-browser/LiveTranslatePanel.tsx` |
| 829 | `apps/electron/src/renderer/components/ai-elements/message.tsx` |
| 811 | `apps/electron/src/renderer/components/agent/AgentMessages.tsx` |
| 745 | `apps/electron/src/renderer/components/memory/MemoryImportView.tsx` |
| 717 | `apps/electron/src/renderer/components/app-shell/CopisWorkingSettingsPanel.tsx` |
| 716 | `apps/electron/src/renderer/components/ui/image-editor.tsx` |
| 711 | `apps/electron/src/renderer/components/web-browser/WebBookmarksPopover.tsx` |
| 701 | `apps/electron/src/renderer/components/agent-skills/AgentSkillsView.tsx` |
| 701 | `apps/electron/src/renderer/components/app-shell/CopisWorkingPaymentModal.tsx` |
| 693 | `apps/electron/src/renderer/components/agent/ContentBlock.tsx` |
| 676 | `apps/electron/src/renderer/components/voice-dictation/VoiceDictationApp.tsx` |
| 672 | `apps/electron/src/renderer/components/expert-team/ExpertTeamView.tsx` |
| 639 | `apps/electron/src/renderer/components/agent/AskUserBanner.tsx` |
| 603 | `apps/electron/src/renderer/components/app-shell/SearchDialog.tsx` |

## Preload

| 行数 | 文件（仓库相对路径） |
|---:|---|
| 2922 | `apps/electron/src/preload/index.ts` |
| 628 | `apps/electron/src/preload/dsh-bridge-preload.ts` |

## 共享包

| 行数 | 文件（仓库相对路径） |
|---:|---|
| 1862 | `packages/shared/src/types/agent.ts` |
| 770 | `packages/shared/src/types/working.ts` |

## 根脚本

| 行数 | 文件（仓库相对路径） |
|---:|---|
| 1165 | `scripts/prepare-dsh-module.ts` |
| 820 | `scripts/publish-functional-modules.ts` |

## 测试与 E2E（19 个）

| 行数 | 文件（仓库相对路径） |
|---:|---|
| 2130 | `apps/electron/src/main/lib/browser-workflow-page-executor.test.ts` |
| 2038 | `apps/electron/src/main/lib/browser-workflow-runner.test.ts` |
| 1212 | `native/http-api-server/src/working_payment_tests.rs` |
| 1139 | `apps/electron/src/main/lib/cdp-session-router.test.ts` |
| 1093 | `apps/electron/src/renderer/components/trading/FundStockWatchlistMarquee.test.ts` |
| 1088 | `apps/electron/src/main/lib/browser-workflow-service.test.ts` |
| 1076 | `native/http-api-server/src/agent_files_tests.rs` |
| 1027 | `apps/electron/src/main/lib/http-api-server-runtime.test.ts` |
| 953 | `apps/electron/scripts/browser-workflow-e2e-main.ts` |
| 868 | `apps/electron/src/main/lib/web-tab-javascript-dialog.test.ts` |
| 793 | `apps/electron/src/main/lib/agent-rpc-service.test.ts` |
| 734 | `apps/electron/src/main/lib/web-tab-manager.test.ts` |
| 727 | `apps/electron/src/main/lib/browser-agent-tool-service.test.ts` |
| 722 | `native/http-api-server/src/working_gateway_tests.rs` |
| 719 | `apps/electron/src/main/lib/agent-workspace-manager.test.ts` |
| 704 | `native/http-api-server/src/main_tests.rs` |
| 674 | `apps/electron/src/renderer/components/app-shell/CopisWorkingSidebar.visual-contract.test.ts` |
| 629 | `native/http-api-server/src/memory_tests.rs` |
| 603 | `native/http-api-server/src/expert_teams_tests.rs` |

## 复现扫描

在仓库根目录运行，需要现有 Node.js 和 rg，不安装依赖。命令只输出结果，不写文件。若候选目录出现新的生成源码，应核实后显式登记排除规则。

```bash
node - <<'JS'
const fs = require('node:fs');
const cp = require('node:child_process');
const excluded = ['.git', 'node_modules', 'dist', 'out', 'third_party',
  'default-skills', 'target', 'resources', 'vendor', 'coverage', 'build'];
const args = ['--files', '--hidden', ...excluded.flatMap(x => ['-g', '!' + x])];
const rows = [];
for (const path of cp.execFileSync('rg', args, { encoding: 'utf8' }).trim().split('\n')) {
  if (!/\.(ts|tsx|rs|js|jsx|vue)$/.test(path)) continue;
  const lines = (fs.readFileSync(path, 'utf8').match(/\n/g) || []).length;
  if (lines <= 600) continue;
  const test = /\.(test|spec)\.[^.]+$|_tests?\.rs$|\/tests\/|(?:^|\/)browser-workflow-e2e-main\.ts$|_test_backend\.rs$/.test(path);
  rows.push({ path, lines, kind: test ? 'test' : 'production' });
}
rows.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
console.log(JSON.stringify(rows, null, 2));
console.log('production:', rows.filter(x => x.kind === 'production').length);
console.log('test:', rows.filter(x => x.kind === 'test').length);
JS
```
