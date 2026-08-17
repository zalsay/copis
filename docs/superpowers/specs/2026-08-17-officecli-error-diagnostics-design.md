# OfficeCLI 下载错误诊断设计

## 目标

当 OfficeCLI 功能模块准备脚本访问 GitHub release、校验文件或二进制失败时，错误信息应能直接帮助定位 HTTP 状态、服务端返回内容、GitHub 限流状态或底层网络异常。

## 范围

修改 `scripts/prepare-officecli-module.ts` 的请求错误处理，覆盖：

- GitHub release API 请求
- `SHA256SUMS` 下载
- OfficeCLI 二进制下载

为请求失败信息增加请求 URL、HTTP 状态、响应 `content-type`、受限长度的响应体摘要，并提取 `x-ratelimit-*` 与 `retry-after` 等诊断头。网络异常增加异常类型、消息和可用的底层原因。

## 非目标

- 不改变 Bun 对 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 等环境变量的处理。
- 不增加自动重试、认证 token 或备用下载源。
- 不把代理 URL、认证信息或其他敏感请求头写入错误。
- 不改变成功下载、缓存复用和 SHA256 校验行为。

## 设计

在脚本内增加共享的响应错误格式化逻辑，三个请求入口统一调用。非 2xx 响应先读取响应体，再抛出保留现有中文错误前缀的 `Error`。输出字段按稳定顺序组织：请求用途、URL、HTTP 状态、响应类型、GitHub 限流/重试头、响应体摘要。

响应体只保留固定最大长度，并标记已截断，避免异常 HTML 或 JSON 造成日志失控。响应头只允许输出有限的诊断字段，不输出完整 headers。

`fetch()` 抛出异常时捕获并包装为包含请求用途和 URL 的错误；若异常存在 `cause`，只输出其类型和消息。

## 测试

在 `scripts/prepare-officecli-module.test.ts` 增加 BDD 场景：

- release API 返回 403、JSON 错误体和 GitHub rate-limit 头时，子进程日志包含状态、URL、限流字段和响应体。
- release API 无法连接时，子进程日志包含 URL、异常类型和底层错误消息。

现有成功下载、缓存复用和 SHA256 失败场景必须继续通过。
