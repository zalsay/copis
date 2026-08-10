# Copis Working 支付接入问题记录

> 记录时间：2026-08-10
>
> 本文只记录 Copis Working 支付链路当前的问题、证据和边界。`edu-api` / `pi-runtime` 不在本次修改范围内，不在 Copis 仓库中修复。

## 结论

当前“生成 VIP 支付二维码失败”不是 Renderer 自行生成二维码失败，而是两个层级的问题叠加：

1. 当前运行中的 Copis Rust HTTP API 功能模块仍是旧版本，尚未加载 Working 支付路由。
2. 使用包含新路由的 Copis 源码链路继续联调后，VIP 创建请求能够到达 `edu-api`，但 `edu-api` 调用 `pi-runtime` 的支付宝执行接口返回 502，最终被包装成“生成 VIP 支付二维码失败”。

第二项属于 `edu-api` / `pi-runtime` 侧问题，本仓库只保留诊断记录，不修复。

## 用户症状

Electron 侧错误为：

```text
Error invoking remote method 'working:create-vip-upgrade':
WorkingApiError: 生成 VIP 支付二维码失败
```

这个错误不能证明二维码组件、二维码编码或设置页状态机本身有问题。当前响应在二维码返回前已经失败。

## 已确认问题

### 1. 当前激活的 Rust 模块版本过旧

本机模块状态：

| 检查项 | 结果 |
| --- | --- |
| `~/.copis/modules/active.json` 中激活版本 | `rust-http-api 0.0.15` |
| 本地缓存的另一个 Rust 模块 | `0.1.2` 存在，但没有被 `active.json` 激活 |
| 当前服务地址 | `http://127.0.0.1:51730` |
| `GET /api/working/diamond-packages` | HTTP 404，响应为 `Working API 路径不存在` |

源码中已经存在对应路由：

- `native/http-api-server/src/working_payment.rs:18-50` 解析 Working 支付路由。
- `native/http-api-server/src/working_payment.rs:67-112` 将支付请求转发到 `edu-api`。
- `native/http-api-server/src/main.rs:1443-1455` 将 `/api/working/*` 支付路径交给 Rust 支付处理器。

因此这里是“已构建/缓存的新实现没有成为当前激活运行时”的版本激活或安装问题，不是源码中完全没有实现。

### 2. VIP 支付二维码生成在上游返回 502

既有跨仓库联调记录显示，使用新 Rust 路由后，调用链为：

```text
Copis Renderer
  -> WorkingApiClient
  -> Rust /api/working/vip/upgrade
  -> edu-api POST /api/users/vip/upgrade
  -> startAlipayDiamondPaymentSession
  -> pi-runtime POST /api/alipay/execute
  -> HTTP 502
```

Copis 源码中的转发关系也与此一致：

- `apps/electron/src/main/lib/working-api-client.ts:736-746` 只请求本地 Rust `/api/working/vip/upgrade`。
- `native/http-api-server/src/working_payment.rs:86-88` 将该请求转发到 `/api/users/vip/upgrade`。

当前 `edu-api` 返回的最终错误信息是“生成 VIP 支付二维码失败”，因此错误发生在二维码生成上游，不是 Copis Renderer 直接请求支付宝接口。

### 3. 上游真实错误体目前没有透传

现有联调中，`edu-api` 对 `pi-runtime /api/alipay/execute` 的失败只保留了类似下面的摘要：

```text
pi-runtime alipay execute failed: status=502
```

没有将 `pi-runtime` 或 `alipay-bot` 的真实错误码、stderr、卖家签名信息或 PayGuard 失败原因返回给调用方。因此目前不能确认 502 的具体根因是：

- 支付账单或签名材料；
- 支付参数或卖家主体配置；
- PayGuard 调用；
- 钱包状态；
- 支付执行网关或其它上游依赖。

继续猜测其中任一项都不具备充分证据，应由 `edu-api` / `pi-runtime` 侧补充可诊断错误后再判断。

### 4. 支付会话会留下待支付状态，但二维码为空

失败请求之后，现有支付会话可能保留：

- `status = pending_user_pay`；
- `qrCodeImage` / 二维码字段为空。

这类会话不能被客户端当成可支付订单，也不能因为二维码为空就循环创建新订单。需要先由服务端确认该会话是否可恢复、已过期、已取消或实际已经完成支付。

## 运行状态补充

此前联调中已确认：

- `pi-runtime /healthz` 和 `/readyz` 返回 200；
- PayGuard 可执行文件和 RPC socket 可用；
- 当前生产 `pi-runtime` 镜像已包含 PayGuard socket 绑定修复；
- 但生产日志中仍有 `/api/alipay/execute` 502，以及由此引起的 edu-api VIP/钻石接口 502。

健康检查正常只能说明进程和基础依赖存活，不能证明一次真实支付宝执行成功。

生产数据库中此前也查到启用的 VIP 配置：

```text
service_id = API_3D421D0662F747BA
goods_name = pi-vip
amount_cents = 4990
enabled = true
```

因此当前证据不支持“VIP 配置未启用”作为主要原因。以上线上配置和支付会话均为时间敏感数据，后续复核时仍需重新查询。

## 两条支付宝链路的边界

设置页支付与 Agent 支付不是同一套协议：

```text
设置页：Renderer -> WorkingApiClient -> Rust /api/working/* -> edu-api
Agent：  Skill -> Pi alipay_bot -> Rust capability -> alipay-bot
```

依据：

- `docs/superpowers/specs/2026-08-10-working-payment-integration-design.md` 规定设置页支付只经过 Rust `/api/working/*`。
- `apps/electron/default-skills/alipay-ai-buyer-agent/SKILL.md:4,12` 明确设置页 VIP/钻石购买不使用该 Skill。
- `native/http-api-server/src/alipay_bot.rs` 和 `apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.ts` 只承载 Agent 的 `alipay-bot` capability。

因此不能用 Agent 的 `alipay-bot` 请求协议替换设置页的 VIP/钻石接口，也不能把设置页订单转换成 Agent 付费资源订单。本次 `edu-api` 侧 502 仍应沿设置页既有的 `Rust API -> edu-api -> pi-runtime` 链路排查。

## 影响范围

| 功能 | 当前状态 | 影响 |
| --- | --- | --- |
| 设置页获取钻石 | 被旧 Rust 模块的 404 阻塞；升级模块后还需验证上游 | 无法可靠加载套餐或创建支付 |
| 设置页升级 VIP | 新路由可转发，但上游 QR 生成 502 | 无法生成 VIP 支付二维码 |
| 我的订单继续支付 | 依赖同一 Rust 支付路由和服务端支付会话 | 旧模块或空二维码会导致恢复失败 |
| Agent `alipay-bot` | 独立 capability 已接入 | 不应作为设置页故障的替代修复路径 |

## 处理边界

### Copis 侧待处理

1. 构建并激活包含 Working 支付路由的新 `rust-http-api` 模块；不能只在仓库中存在二进制或缓存版本。
2. 激活后先验证本地 `/api/working/diamond-packages` 不再返回旧模块的 404，再进行需要真实订单的支付验证。
3. 保持设置页和 Agent 两条支付协议隔离。
4. 另行处理 `CopisWorkingPaymentModal` 中残留的“以服务端配置为准”和“服务端价格”文案；这不是本次 502 的根因。

### `edu-api` / `pi-runtime` 侧待处理（本次不修复）

1. 追查 `/api/alipay/execute` 返回 502 的真实错误码和 stderr，不再只返回 `status=502`。
2. 核对 `alipay-bot`、PayGuard、卖家签名、账单和支付主体配置。
3. 明确失败时支付 session 的最终状态，避免留下“待支付但无二维码”的不可恢复会话。
4. 分别验证 VIP 和普通钻石支付接口，确认它们在同一支付宝执行链路上的行为。

## 后续验证顺序

在 `edu-api` 问题有明确结果前，不创建新的真实订单。建议按以下顺序复核：

1. 更新并激活 Copis Rust 模块。
2. 只读验证套餐列表和订单列表路由。
3. 使用已有待支付会话确认恢复接口的状态，不重复提交创建请求。
4. `edu-api` / `pi-runtime` 侧修复并提供明确错误信息后，再由用户在实际 Electron 窗口确认二维码、支付检查、订单恢复和余额/VIP 刷新。

## 当前不应下的结论

- 不能把问题归因于二维码 UI 或二维码库。
- 不能把 `WorkingApiError` 的中文摘要当成支付宝真实错误码。
- 不能因为 `pi-runtime` 健康检查为 200，就认为支付宝执行链路正常。
- 不能把设置页支付改成 `alipay-bot Skill` 来绕过 `edu-api`。
- 不能通过重复点击 VIP 升级来规避待支付会话或上游 502。
