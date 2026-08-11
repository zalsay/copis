# Composer 高级授权联动 AI 浏览器设计

## 目标

当用户在 Composer 中打开现有的“高级授权”图标时，同一用户主会话绑定的 Copis 内嵌 AI 浏览器默认放行页面操作，包括导航、点击、输入、选择、按键、滚动、新页签以及密码、验证码、支付/转账和文件上传等敏感字段操作。关闭图标后恢复现有的页面授权策略。

## 方案

以会话元数据 `advancedAuthorization` 作为唯一权限来源，不新增第二套浏览器授权状态。

- 浏览器工作流状态计算时读取当前会话的 `advancedAuthorization`；用户主会话开启后呈现 `authorized`。
- 浏览器工具执行前继续校验 Worker capability、会话绑定、内部 HTTP(S) 页签和页面归属。
- 只有 `triggeredBy: user` 且未标记为 automation/delegation 的会话继承 Composer 高级授权；自动化和委派会话始终使用原有页面策略。
- 页面控制服务在高级授权会话中跳过敏感字段保护，但保留元素存在性、可交互性、长度、按键集合、URL 协议和 CDP 运行时校验。
- 高级授权 IPC 更新会刷新浏览器工作流状态，确保浏览器顶部不再显示“询问模式”。

## 组件与数据流

`AgentConversationSurface` 的现有图标继续调用 `updateSessionAdvancedAuthorization`。主进程持久化会话元数据，并通知 `browser-workflow-service` 重新计算状态。`browser-agent-tool-service` 和 `browser-page-control-service` 通过同一会话状态判定是否允许页面变更。

## 错误与安全边界

- 未开启高级授权时，现有 `ask` 页面策略和单次审批行为不变。
- 高级授权不改变 capability token、页面绑定 owner、Origin/URL、HTTP(S) 协议和 `event.isTrusted` 等校验。
- 高级授权不会授予系统浏览器、外部 Chrome、未绑定页签、automation 或 delegation 会话访问权。
- 页面内容仍是不可信数据，不能将网页文本当作 Copis 指令执行。

## BDD 与验证

```text
Given 用户主会话已绑定网页且 Composer 高级授权关闭
When Agent 执行页面变更
Then 询问模式策略继续拒绝变更

Given 用户主会话已绑定网页且 Composer 高级授权开启
When Agent 执行普通或敏感页面变更
Then 直接执行且浏览器状态为 authorized

Given automation 或 delegation 会话的元数据异常带有高级授权
When Agent 执行页面变更
Then 不继承用户主会话的高级授权

Given 用户切换 Composer 高级授权
When 浏览器面板读取状态
Then 面板即时反映 authorized 或原有页面策略
```

自动化验证至少覆盖浏览器工作流、浏览器工具 dispatcher、页面控制服务相关测试，并执行仓库要求的类型检查和 Electron 主/渲染构建。Electron UI 的最终交互仍由用户在实际应用窗口确认。
