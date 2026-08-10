# Copis Working 设置页支付接入 Spec

## 状态

本文是 Copis Electron 的支付接入规范和验收契约。当前状态分为两层：

- Copis 的设置页 UI、IPC、Preload、Jotai 状态、支付展示和本地 Rust 支付路由基础能力已落地。
- A1 支付执行链路尚未落地：`edu-api` 仍会在公开创建接口内调用 `pi-runtime /api/alipay/execute`。后续应改为 `edu-api` 负责订单/权益，本地 Pi SDK + `alipay-bot` 负责支付宝执行。

本文中的“当前基础接入”或“legacy”指工作区现有、已完成的 Rust loopback -> `edu-api` 转发路径；“A1 目标”指后续要实现的本地 Pi 支付协调路径。两者不能混用，当前基础接入通过不等于 A1 已完成。

无论当前实现还是 A1 目标，Electron 与浏览器模式都只访问本地 Rust HTTP API，渲染进程不直接请求 `edu-api`，也不持有 JWT。

## 目标

将 Copis Working 设置页中的“获取钻石”和“升级 VIP”接入 ai-education 已有的支付宝支付接口，并让“我的订单”中的“继续支付”复用同一支付流程。

接入后应满足：

- 套餐、价格、赠送钻石、VIP 天数均以服务端响应为准。
- 支付二维码由主进程通过已认证的 Working API 获取，渲染进程不接触 JWT。
- 支付成功以支付会话 `status === "resource_ready"` 为唯一成功条件。
- 支付成功后刷新 Working 设置快照和订单列表，显示最新钻石余额、VIP 状态和有效期。
- 已存在的待支付订单可以恢复；VIP 升级不能重复创建待支付订单。
- Electron 主进程支付请求调用 `http://127.0.0.1:<rust-port>/api/working/*`，由 Rust 使用同步后的 Working token 转发 edu-api。
- 浏览器模式通过 Vite `/api` 代理访问同一组 Rust 路由；支付路由不再进入 Electron `http-api-handler` 业务桥。

## 范围

### 本次范围

1. `CopisWorkingSettingsPanel` 的“获取钻石”按钮和支付弹窗。
2. `CopisWorkingSettingsPanel` 的 VIP 权益对比、升级确认和支付弹窗。
3. `CopisWorkingOrdersPanel` 的待支付订单恢复。
4. 共享类型、Working API client、IPC、preload、HTTP API bridge 的支付方法。
5. 支付状态、错误、刷新和子账号限制的自动化测试。

### 不在范围内

- 本轮 Copis 不修改 `edu-api` / `pi-runtime`；A1 所需的 prepare-only、VIP 支付和 finalize 契约作为外部依赖记录。
- 不改变 ai-education 的套餐、订单、钻石到账和 VIP 权益业务规则。
- 不新增 npm 依赖；Copis 已有 `qrcode` 依赖，先复用现有依赖清单。
- 不在渲染进程直接请求 `${backendUrl}/api`，不把 JWT 放入 `window`、localStorage 或组件状态。
- 不改变订单列表的分页、删除和服务端隐藏模型；仅增加待支付订单的恢复入口。
- 不在本地 JSON 配置中持久化二维码、支付会话或订单凭证。关闭弹窗后需要重新从服务端读取。

## 当前实现

Copis 已在既有 Working 链路上完成支付接入：

- `native/http-api-server/src/working_payment.rs` 负责本地支付路由、Working token 校验和 edu-api 转发。
- `WorkingApiClient` 的支付方法通过 Rust loopback 请求，不向 edu-api 直接发送 Authorization；Rust 401 会复用一次 token 刷新并重试。
- `http-api-handler` 不处理支付业务路由，避免浏览器模式绕过 Rust；renderer bridge 只调用本地 `/api/working/*` 并复用共享归一化。
- `packages/shared/src/types/working.ts` 和 `working-payment.ts` 提供 renderer-safe 支付模型、状态和响应校验。
- 设置页、订单页和 Jotai 支付状态共用 `CopisWorkingPaymentModal`，待支付订单支持恢复。
- `native/http-api-server/src/alipay_bot.rs` 和 `pi-alipay-bot-tool.ts` 已提供 Agent 侧的钱包/支付 capability，但目前只由 Pi Agent 工具调用，尚未接入设置页的确定性支付协调流程。
- 当前 `working_payment.rs` 仍将创建和检查请求转发到公开 `edu-api` 接口；这条路径是基础接入现状，不是 A1 的最终执行路径。

## A1 目标架构

A1 保留 `edu-api` 作为业务账本和权益服务，但把支付宝执行从 `edu-api -> pi-runtime` 移到 Copis 本地 Pi SDK + `alipay-bot`：

```text
设置页 Renderer
  -> Copis Rust Working Payment Coordinator
  -> edu-api：套餐、订单、Payment-Needed、订单状态
  -> 本地 Pi SDK / alipay_bot：wallet.check、payment.start、payment.check
  -> Copis Rust：受控保存执行结果
  -> edu-api：payment-started、finalize/到账
  -> resource_ready
```

### 分层职责

| 层 | A1 职责 | 不负责的内容 |
| --- | --- | --- |
| Renderer | 选择套餐、明确确认支付、展示二维码和状态 | 不接收 JWT、Payment-Needed 或 payment proof，不计算金额和权益 |
| Copis Rust | 持有 Working JWT、调用 edu-api、创建受限支付会话、调用本地 alipay-bot、转发受控结果 | 不维护钻石余额、VIP 到期时间或服务端套餐真相 |
| 本地 Pi SDK / alipay-bot | 钱包检查、支付宝支付启动、支付状态查询 | 不决定套餐金额，不直接给用户账户入账 |
| edu-api | 账户权限、套餐、订单、Payment-Needed、支付幂等、钻石/VIP 入账和最终状态 | A1 下不再承担本地支付宝 CLI 执行 |

### A1 流程

1. Copis 从 `edu-api` 读取可购买套餐；服务端过滤 VIP 套餐，客户端只做防御性过滤。
2. 用户选择套餐并明确确认后，Rust 先在当前 Working 用户隔离的 PiHome 中执行 `wallet.check`。钱包未开通或未绑定时，进入用户授权/绑定流程，不创建新的业务订单；`wallet.apply`、`wallet.bind` 只能由明确的用户动作触发。
3. 钱包可用后，Copis 请求 `edu-api` 创建或恢复业务订单。该阶段只准备订单和卖家生成的 `Payment-Needed`，不能调用 `pi-runtime /api/alipay/execute`。
4. Copis 获取支付上下文，包括 `resource_url`、HTTP 方法、请求体、受控 headers 和 `session_id`；这些字段只留在 Rust/本地支付协调器内。
5. Copis 为当前 Working 用户创建短生命周期的本地 Pi 支付会话，调用 `alipay_bot payment.start`。支付金额、订单号和 `Payment-Needed` 必须来自服务端，不能由模型或 Renderer 编造。
6. Rust 将二维码、收银台 URL、交易号和状态回写 `edu-api` 的 payment-started 接口；Renderer 只收到可以展示的支付会话。
7. 用户点击“我已支付”后，Copis 本地调用 `alipay_bot payment.check`，再把受控的支付结果提交给 `edu-api` finalize/check 接口。
8. `edu-api` 以 `payment_id` / `out_trade_no` 做幂等入账。只有返回 `resource_ready`，Copis 才刷新设置快照并关闭支付视图。

### 与 ai-education 参考实现的对应关系

ai-education 已有钻石 Working Agent 参考接口：

- `GET /api/internal/working-agent/alipay/diamond-packages`
- `POST /api/internal/working-agent/alipay/diamond-purchase`
- `POST /api/internal/working-agent/alipay/payment-context`
- `POST /api/internal/working-agent/alipay/payment-started`
- `POST /api/internal/working-agent/alipay/payment-check`

Copis 应对齐这组“创建订单 -> 获取上下文 -> 本地 alipay-bot -> 回写 -> 检查”的语义，但不能直接假设这些内部路径可以使用 Copis 当前的 JWT。当前参考接口使用 Working Agent capability 认证，Copis 需要由 `edu-api` 提供受限的桌面端等价认证方式，或由 Rust 持有短期 capability token。

VIP 需要 `edu-api` 提供同语义的 prepare-only 和 finalize/check 接口。当前 `POST /api/users/vip/upgrade` 会直接触发服务端支付宝执行，不能作为 A1 的最终接口。

## A1 与当前实现的差异

以下事项是 A1 的未完成项，不代表本轮已经修改：

1. **创建接口仍是执行接口**：当前 `working_payment.rs` 调用公开钻石/VIP创建接口，`edu-api` 会继续触发 `pi-runtime`；需要切换到 prepare-only 协议。
2. **缺少设置页支付协调器**：当前 `CopisWorkingPaymentModal` 直接通过 `window.electronAPI` 创建和检查支付，没有调用本地 Pi SDK 的固定 action 序列。
3. **缺少支付上下文模型**：Rust 需要内部保存 `Payment-Needed`、资源 URL、方法、请求体、headers 和 session ID；这些内容不能进入共享 renderer 类型。
4. **缺少 payment-started 回写**：当前本地 alipay-bot 结果没有回写 `edu-api` 的支付会话，二维码和交易号无法按参考实现持久化。
5. **缺少本地检查后的 finalize**：当前 `checkPayment()` 仍请求公开 `edu-api` 检查接口，可能再次进入 `pi-runtime`；需要本地 `payment.check` 后的服务端 finalize/check 协议。
6. **VIP prepare/finalize 契约缺失**：钻石参考接口已有 prepare-only 语义，VIP 还需要由 `edu-api` 提供同等能力，并保留 `pending_existing` 的幂等行为。
7. **支付 proof 没有内部回传通道**：当前 `alipay_bot.rs` 会隐藏 `payment_proof`、原始输出和二维码本地路径；A1 需要仅供 Rust 到 `edu-api` 的受控结果通道，不能把 proof 暴露给模型或 Renderer。
8. **二维码输出未对齐**：当前 capability 的公开结果主要提供 `cashierUrl`，设置页需要对齐参考实现的 `qrcode_image` / MIME 类型，但只能把可展示二维码返回 UI。
9. **支付宝钱包未完成按账号隔离**：当前没有完整的 Working 用户到独立 `PiHome` / `COPIS_ALIPAY_BOT_HOME` 的绑定路径；必须避免多个 Copis 账号共享一个本地支付宝钱包状态。
10. **Agent capability 会话边界缺失**：当前 worker token 绑定普通 Agent 文件策略。A1 需要为设置页支付创建短生命周期、单支付、可清理的 capability 会话，不能复用任意 Agent session。
11. **订单恢复上下文不完整**：恢复订单时需要重新获得 `Payment-Needed` 和支付上下文；只有二维码字段的旧 session 不能直接作为 A1 的可支付会话。
12. **Rust 功能模块尚未更新到运行实例**：当前安装实例仍可能激活旧 `rust-http-api`，必须在实现后更新模块并验证实际服务路由。

## 业务契约

### 账号和权限

- 所有接口都使用当前 Working 登录账号的认证上下文。
- 子账号不能发起支付；后端返回 HTTP 403 和错误消息：`孩子账号不能发起支付，请由家长账号操作`。
- Copis 不根据本地 `accountType` 自行判定支付成功或绕过后端限制；后端响应是最终权限结果。
- HTTP 401 应复用现有 Working 登录失效处理；不得把 401 当成支付失败吞掉。

### 价格和权益

- `amount` / `amount_cents` 是实际应支付金额。
- `diamonds` 是支付完成后到账的钻石数量，不是价格，也不应从金额推算。
- VIP 套餐由服务端数据库中 `service_id = "pi-vip"` 或 `goods_name = "pi-vip"` 的启用配置提供。
- 普通钻石套餐接口不应展示 VIP 套餐。客户端仍应对 `pi-vip` 做一次防御性过滤，避免后端版本漂移导致用户误选。
- VIP 购买返回的 `bonus_diamonds` 是支付成功后随 VIP 一起到账的钻石。
- VIP 购买天数由服务端配置决定，客户端不得固定成 30 天；30 天只作为响应缺失时的展示兜底。
- 已开通且仍有效的 VIP 再次购买时，后端负责从当前到期时间继续顺延，而不是由客户端计算新到期时间。

### 支付状态

支付会话状态可能包含：

| 状态 | 客户端语义 |
| --- | --- |
| `created` | 会话已创建，尚未拿到可支付展示内容；保持加载或提示重试 |
| `pending_user_pay` | 等待用户使用支付宝支付；展示二维码和“我已支付” |
| `paid` | 支付已确认，资源到账仍需检查；不能直接关闭为成功 |
| `checking` | 服务端正在确认到账/解锁；禁止重复点击检查 |
| `resource_pending` | 支付已确认但资源仍在处理；允许稍后重新检查 |
| `resource_ready` | 唯一成功状态；刷新余额、VIP 和订单 |
| `cancelled` | 订单已取消；清理当前支付视图 |
| `failed` | 支付或资源处理失败；保留服务端错误并允许关闭后重试 |

### 待支付订单

- 打开钻石购买弹窗时，先请求待支付钻石订单，再请求套餐列表。
- 有待支付钻石订单时，先显示“继续支付 / 取消订单”，不得直接创建新订单。
- VIP 升级接口会在服务端复用当前账号未过期的待支付 VIP 订单，并返回 `pending_existing: true`；客户端不得再次创建订单。
- VIP 待支付订单按 ai-education 现有 Working 页面处理：允许继续支付，不提供普通钻石订单的取消入口。
- 关闭弹窗不会取消订单。取消只能由用户在钻石待支付状态下明确点击“取消订单”触发。
- 订单恢复接口返回 409 时，表示订单已支付、取消、过期或支付会话不可继续；客户端应关闭支付视图、刷新订单列表并提示订单状态已变化。

## API 矩阵

### 当前基础接入矩阵（legacy）

以下只描述当前已落地的 Copis 本地 Rust 路由与 edu-api 上游路径映射，作为迁移和回归对照，不是 A1 的最终协议。Renderer/主进程只请求左侧本地路径；Rust 负责向右侧路径转发并在边界解包响应。上游响应中的业务数据通常位于 `data` 字段，支付检查接口的外层 `skill/ok/message/data` 必须保留到归一化边界。

| 方法 | Copis Rust 本地路径 | Rust 转发的 edu-api 路径 | 请求 | 用途 |
| --- | --- | --- | --- | --- |
| GET | `/api/working/diamond-packages` | `/api/pay/alipay/diamond-packages` | 无 | 获取可购买的普通钻石套餐 |
| GET | `/api/working/diamond-purchases/pending` | `/api/pay/alipay/diamond-purchases/pending` | 无 | 打开钻石弹窗时恢复待支付订单 |
| POST | `/api/working/diamond-purchases` | `/api/pay/alipay/diamond-purchases` | `{ packageId }`，Rust 转为 `{ package_id }` | 创建普通钻石支付宝订单 |
| POST | `/api/working/vip/upgrade` | `/api/users/vip/upgrade` | `{}` | 创建或复用 VIP 支付订单 |
| GET | `/api/working/orders/:id/payment` | `/api/users/orders/:id/payment` | 无 | 从订单列表恢复指定待支付订单 |
| POST | `/api/working/diamond-purchases/:payment_id/check` | `/api/pay/alipay/diamond-purchases/:payment_id/check` | `{}` | 检查支付宝支付和资源到账状态 |
| POST | `/api/working/diamond-purchases/:payment_id/cancel` | `/api/pay/alipay/diamond-purchases/:payment_id/cancel` | `{}` | 取消仍处于待支付的普通钻石订单 |
| GET | `/api/working/orders` | `/api/users/orders` | `page`, `page_size` | 支付完成、恢复失败后的订单刷新 |

以上矩阵描述的是当前 Copis 基础接入路径。A1 的下游执行路径改用以下语义：

### A1 下游协议矩阵（目标）

| 阶段 | edu-api 参考/目标接口 | 执行方 | 结果边界 |
| --- | --- | --- | --- |
| 套餐读取 | `GET /api/internal/working-agent/alipay/diamond-packages` | edu-api | 只返回服务端启用套餐 |
| 钱包检查 | 本地 `alipay_bot wallet.check` | Copis 本地 Pi SDK / Rust capability | 按 Working 用户隔离 PiHome；未就绪时不得创建新订单 |
| 钻石准备 | `POST /api/internal/working-agent/alipay/diamond-purchase` | edu-api | 创建订单并返回 `Payment-Needed`，不得执行 alipay-bot |
| 支付上下文 | `POST /api/internal/working-agent/alipay/payment-context` | edu-api | 返回 `resource_url`、方法、请求体、headers、session ID，仅供 Rust 使用 |
| VIP 准备 | edu-api 提供同语义的 VIP prepare-only 接口（路径待外部契约确定） | edu-api | 创建/复用 `pi-vip` 订单并返回 `Payment-Needed`，不得直接调用 `pi-runtime` |
| 支付启动 | 本地 `alipay_bot payment.start` | Copis 本地 Pi SDK / Rust capability | 生成二维码、收银台 URL、交易号；proof 不进入 Renderer |
| 启动回写 | `POST /api/internal/working-agent/alipay/payment-started` 或桌面端等价接口 | Rust -> edu-api | 持久化支付会话和可展示二维码 |
| 支付检查 | 本地 `alipay_bot payment.check` | Copis 本地 Pi SDK / Rust capability | 使用服务端订单号查询真实状态 |
| 入账确认 | `payment-check` 的桌面端等价 finalize/check 接口 | Rust -> edu-api | 幂等完成钻石到账或 VIP 延期，最终返回 `resource_ready` |

参考实现中的 `payment-check` 如果仍由 edu-api 再调用 `pi-runtime`，不能直接视为 A1 的最终接口；A1 需要让 edu-api 接受本地执行结果，或提供不再重复执行支付宝的 finalize 语义。

### A1 外部契约待确认项

以下契约由 `edu-api` 提供，Copis 只按契约调用，不在本地补造业务字段。路径、认证方式和字段命名在跨仓库联调前必须冻结；其中 VIP 路径目前仍未确定。

| 契约 | 最低要求 | 约束 |
| --- | --- | --- |
| 钻石 prepare | 根据 `package_id` 创建或恢复订单，返回 `payment_id`、`out_trade_no`、服务端金额/钻石信息和 `Payment-Needed` | 只准备业务订单，不调用 `pi-runtime /api/alipay/execute` |
| VIP prepare | 根据 `pi-vip` 配置创建或复用 VIP 订单，返回 `pending_existing`、VIP 天数、金额、赠送钻石和 `Payment-Needed` | 已有待支付订单必须幂等复用，不得重复下单 |
| payment context | 根据 `payment_id` 返回 `resource_url`、HTTP 方法、请求体、受控 headers 和 `session_id` | 仅 Rust 支付协调器可见；不得进入 Renderer、模型上下文或普通 Agent transcript |
| payment-started | 接收 `payment_id`、交易标识、二维码/收银台展示字段和受控支付结果 | 重复回写必须幂等；`payment_proof` 不返回 Renderer |
| finalize/check | 接收本地 `payment.check` 的受控结果，完成支付确认和钻石/VIP 入账 | 重复检查不得重复到账或延长 VIP；只有 `resource_ready` 才表示成功 |
| 桌面端认证 | 提供 Working 用户绑定的短期、最小权限 capability | 不复用任意 Agent worker token，不把 Working JWT 交给 Pi 模型或 `alipay-bot` CLI |

A1 实现前必须用真实或契约测试确认：钻石和 VIP prepare 都能返回可用的 `Payment-Needed`；payment-started/finalize 不会再次触发 `pi-runtime` 支付执行；失败 session 有明确的可恢复、已取消或已过期状态。

### API 错误处理

- 401：认证失效，交给现有 Working 认证状态处理。
- 403：展示后端返回的子账号支付限制，不显示“支付失败”这类误导文案。
- 404：VIP 配置未启用、订单不存在或支付会话不存在；根据调用场景提示“VIP 暂未开放”或“订单已失效”。
- 409：订单或支付会话状态已变化；重新读取订单，不重复提交支付请求。
- 5xx/502/504：保留 `WorkingApiError` 的服务端消息，提供关闭和重试路径。
- HTTP 200 但 `data` 缺少合法 `payment_id`，应视为协议错误，不展示空二维码。

## 响应模型

模型位于 `packages/shared/src/types/working.ts`，字段名使用 Copis camelCase；`working-api-client.ts` 负责 snake_case 归一化和格式校验。以下模型是 Renderer-safe 的展示和状态模型，描述当前基础接入与 A1 共用的 UI 边界，不代表 A1 的内部支付上下文。

```ts
interface WorkingDiamondPackage {
  id: number
  serviceId?: string
  goodsName?: string
  amount: string
  amountCents: number
  currency: string
  diamonds: number
  enabled?: boolean
  sortOrder?: number
}

interface WorkingPaymentSession {
  paymentId: string
  resourceId?: string
  outTradeNo?: string
  tradeNo?: string
  outShakeNo?: string
  status: string
  goodsName?: string
  amount?: string
  currency?: string
  cashierUrl?: string
  qrCodeImage?: string
  qrCodeMimeType?: string
  expiresAt?: string | null
}

interface WorkingVipPaymentSummary {
  serviceId: string
  days: number
  amount?: string
  amountCents?: number
  bonusDiamonds?: number
  paymentPackage?: WorkingDiamondPackage
}

interface WorkingPendingDiamondPurchase {
  payment: WorkingPaymentSession
  package: WorkingDiamondPackage
}

interface WorkingOrderPayment {
  order: WorkingOrder
  payment: WorkingPaymentSession
  package: WorkingDiamondPackage
  vip?: WorkingVipPaymentSummary
}
```

### A1 Rust 内部支付模型

以下是概念模型，只允许存在于 Rust/主进程支付协调器，不加入 `packages/shared`，也不通过 IPC 返回完整内容：

```text
WorkingPaymentPreparation
  paymentId
  outTradeNo
  paymentNeeded       // 仅 Rust 内存，禁止 Renderer/模型/日志
  resourceUrl
  method
  data
  headers
  sessionId

WorkingAlipayExecutionResult
  status
  tradeNo
  outShakeNo
  cashierUrl
  qrCodeImage         // 可在脱敏后返回 Renderer
  qrCodeMimeType
  paymentProof        // 仅 Rust -> edu-api，禁止 Renderer/模型/日志
```

支付协调器必须区分“内部执行结果”和“Renderer-safe 支付会话”。不能为了复用 `WorkingPaymentSession` 而把 `payment_needed` 或 `payment_proof` 放进共享状态。

归一化要求：

- `amount` 保持字符串，用于金额展示；不能用浮点 `amountCents / 100` 替代服务端金额文本。
- `id`、订单 ID 和支付 ID 必须接受服务端当前格式；URL 参数统一 `encodeURIComponent`。
- `qrCodeImage` 若已是 `data:` URL 则原样使用，否则按 `qrCodeMimeType || "image/png"` 补齐 `data:<mime>;base64,` 前缀。
- `resource`、`alipay.payment_needed`、`resource_response` 等后端诊断数据不进入持久化状态；只有二维码、订单号、金额和支付状态进入 UI 状态。
- 支付状态按原字符串保留，未知状态按非成功状态处理，不默认映射为 `paid`。

## Copis 分层接入

新增支付能力必须同步经过以下层级：

1. `packages/shared/src/types/working.ts`
   - 新增支付套餐、支付会话、VIP 支付摘要、待支付订单恢复和支付检查结果接口。
   - 在 `WORKING_IPC_CHANNELS` 增加支付相关通道，例如 `LIST_DIAMOND_PACKAGES`、`GET_PENDING_DIAMOND_PURCHASE`、`CREATE_DIAMOND_PURCHASE`、`CREATE_VIP_UPGRADE`、`GET_ORDER_PAYMENT`、`CHECK_PAYMENT`、`CANCEL_DIAMOND_PAYMENT`。
   - 不在共享类型中放置 token、Authorization header 或后端内部 `payment_needed`。

2. `apps/electron/src/main/lib/working-api-client.ts`
   - 新增与 API 矩阵一一对应的类型安全方法：
     - `listDiamondPackages()`
     - `getPendingDiamondPurchase()`
     - `createDiamondPurchase(packageId)`
     - `createVipUpgrade()`
     - `getOrderPayment(orderId)`
     - `checkPayment(paymentId)`
     - `cancelDiamondPayment(paymentId)`
   - 复用现有认证、safeStorage token store、`WorkingApiError` 和请求错误归一化。
   - 服务端错误消息应原样保留；不记录 token、二维码内容或完整支付响应。

3. `native/http-api-server/src/working_payment.rs`
   - 只接受明确的 `/api/working/*` 支付路由，复用 `SkillMarketState` 保存的 Working token。
   - 普通支付响应使用 `remote_json` 解开 `data`；支付检查响应使用 `remote_json_raw` 保留 `ok/data` 业务包络。
   - 订单 ID 和支付 ID 统一 URL 解码后再重新编码转发，不能把完整上游响应写入日志。

4. `apps/electron/src/main/ipc.ts`
   - 为每个共享通道注册 `ipcMain.handle`，只做参数类型和非空校验，再调用 `WorkingApiClient`。
   - `packageId` 必须为正整数；`paymentId`、`orderId` 必须是非空字符串或数字。
   - IPC 返回规范化模型，不返回 Authorization、后端 token 或未过滤的 raw response。

5. `apps/electron/src/preload/index.ts`
   - 在 `ElectronAPI` 接口和 `electronAPI` 暴露对象中同时增加支付方法。
   - 保持与现有 `listWorkingOrders` / `deleteWorkingOrder` 相同的类型安全调用方式。

6. `apps/electron/src/main/lib/http-api-handler.ts` 与 `apps/electron/src/renderer/lib/http-api-bridge.ts`
   - `http-api-handler` 不注册支付业务方法；Rust 进程直接处理支付路由，防止 Electron 业务桥绕过 Rust。
   - renderer 的 browser/bridge 模式只使用 `/api/working/*` 本地路由，并在接收后复用共享归一化。
   - bridge 的路径参数和请求体与 IPC 方法保持同一套共享模型；Rust 负责将 `packageId` 转成上游 `package_id`。

7. `apps/electron/src/renderer`
   - 使用 Jotai 保存跨“账户设置”和“我的订单”共享的支付弹窗、支付阶段和当前支付会话。
   - 设置页只负责打开 `diamonds` 或 `vip` 模式；订单页只负责传入 `resumeOrderId`。
   - 可以拆分 `CopisWorkingPaymentModal`、`CopisWorkingVipBenefitsModal` 和支付状态展示组件，避免把 API、状态机和 JSX 全部堆进现有设置面板。
   - 支付完成后调用现有设置快照加载逻辑，更新 `settings.vip`、`settings.user.tokens` 和订单列表。

## Jotai 状态模型

建议新增 `apps/electron/src/renderer/atoms/working-payment-atoms.ts`：

```ts
type WorkingPaymentMode = 'diamonds' | 'vip'

type WorkingPaymentPhase =
  | 'idle'
  | 'loading'
  | 'pending'
  | 'selecting'
  | 'creating'
  | 'cancelling'
  | 'waiting_user_pay'
  | 'checking'
  | 'resource_pending'
  | 'success'
  | 'error'

interface WorkingPaymentState {
  open: boolean
  mode: WorkingPaymentMode
  phase: WorkingPaymentPhase
  resumeOrderId?: number | string
  packages: WorkingDiamondPackage[]
  selectedPackageId?: number
  pendingPurchase?: WorkingPendingDiamondPurchase
  payment?: WorkingPaymentSession
  vip?: WorkingVipPaymentSummary
  error?: string
}
```

状态约束：

- `open === false` 时清理二维码和当前支付会话，但不自动取消服务端订单。
- `pending` 必须有 `pendingPurchase`；`waiting_user_pay`、`checking`、`resource_pending` 必须有 `payment`。
- `creating`、`checking`、`cancelling` 期间禁用重复操作；请求结束后无论成功失败都恢复可操作状态。
- `success` 只由 `resource_ready` 进入，随后执行设置和订单刷新，再关闭弹窗。
- 错误只保存在内存，退出弹窗后清理；不得写入 `settings.json` 或 localStorage。

## 当前基础接入状态机（legacy 对照）

以下两个状态机只描述当前已落地的设置页调用方式，用于保留 UI、权限和恢复行为的回归基线。它们仍会经过公开 `edu-api` 创建/检查接口，不能作为 A1 的实现协议。

### 钻石购买状态机（legacy）

```text
idle
  -> loading: 打开“获取钻石”
  -> pending: 找到待支付钻石订单
  -> selecting: 没有待支付订单且套餐加载完成
  -> creating: 点击“确认支付”
  -> waiting_user_pay: 创建订单并拿到 payment.qrcode_image 或 cashier_url
  -> checking: 点击“我已支付”
  -> waiting_user_pay: status 仍为 pending_user_pay / paid / checking
  -> resource_pending: status 为 resource_pending
  -> success: status 为 resource_ready
  -> error: 请求错误、协议错误或 failed/cancelled

pending
  -> waiting_user_pay: 点击“继续支付”
  -> selecting: 普通钻石订单点击取消且服务端返回 cancelled=true
  -> waiting_user_pay: 取消结果为 cancelled=false，说明状态已变化
```

流程要求：

1. 打开弹窗先调用 `getPendingDiamondPurchase()`。
2. 无待支付订单时调用 `listDiamondPackages()`，过滤 `pi-vip`，展示服务端金额和钻石数。
3. Renderer 到 Rust 只发送 `{ packageId: selectedPackage.id }`；Rust 转发给 edu-api 时只发送 `{ package_id }`，不发送客户端计算的金额或钻石数。
4. 支付视图展示二维码、金额、订单号和“我已支付”；二维码可点击放大，无法显示二维码时才使用安全校验后的 `cashierUrl` 外部打开兜底。
5. 点击“我已支付”只调用 `checkPayment(payment.paymentId)`；不把订单号、trade_no 或前端按钮点击视为支付凭证。
6. `resource_ready` 后刷新设置快照，使余额立即显示到账；订单列表同时重新读取。

### VIP 升级状态机（legacy）

```text
idle
  -> benefits: 点击“升级 VIP”
  -> loading: 在权益弹窗点击确认升级
  -> pending: POST /users/vip/upgrade 返回 pending_existing=true
  -> waiting_user_pay: 返回新支付会话
  -> checking: 点击“我已支付”
  -> resource_pending: 支付已确认但资源仍处理中
  -> success: status === resource_ready
  -> error: 配置未启用、权限失败、二维码生成失败或其他请求错误

pending
  -> waiting_user_pay: 点击“继续支付”
```

流程要求：

1. 权益弹窗展示当前快照中的 `upgradeAmount`、`upgradeDays`、`upgradeBonusDiamonds`，权益对比只包含专家团队和定时任务。
2. `upgradeAvailable === false` 时禁用升级入口，并提示 VIP 配置未开放；不能用默认价格创建请求。
3. 确认升级时调用 `createVipUpgrade()`，请求体为空对象 `{}`。
4. 若响应包含 `pending_existing: true`，展示待支付提示和同一支付二维码，不再次请求创建接口。
5. 已开通 VIP 仍可走同一接口完成续期；客户端只在成功后重新读取服务端 `vipExpiresAt`。
6. VIP 支付不提供普通钻石订单的取消按钮；用户关闭弹窗后订单保持待支付，可从订单列表恢复。

## A1 目标支付协调状态机

A1 的设置页仍由用户和 Renderer 驱动，但支付执行由 Rust 中的确定性协调器完成。`preparing`、`starting`、`finalizing` 是 Rust 内部阶段，不能暴露为模型工具调用或让 Renderer 自行拼接请求。

```text
idle
  -> preparing: 用户明确确认钻石套餐或 VIP 方案
  -> starting: edu-api prepare 和 payment-context 成功
  -> waiting_user_pay: 本地 payment.start 成功且 payment-started 回写成功
  -> checking: 用户点击“我已支付”
  -> finalizing: 本地 payment.check 得到受控结果
  -> resource_pending: finalize 返回资源仍在处理
  -> success: finalize 返回 resource_ready
  -> error: prepare、context、payment.start、payment-started、payment.check 或 finalize 失败

waiting_user_pay
  -> checking: 同一 payment_id 上执行一次检查
  -> waiting_user_pay: 支付仍为 pending_user_pay/paid/checking

resource_pending
  -> checking: 用户稍后再次检查
  -> success: finalize 返回 resource_ready
```

A1 状态约束：

- `preparing` 只能由设置页的明确确认触发；不能由模型、Skill 自动触发，也不能由客户端金额推导触发。
- `starting` 必须在 Rust 内取得服务端 `Payment-Needed` 和 payment context 后才可进入；失败时不得调用本地 `payment.start`。
- `waiting_user_pay` 只有在 `payment-started` 幂等回写成功后才可返回 Renderer；不能只因本地 CLI 返回二维码就认为服务端已有可恢复会话。
- `checking` 先调用本地 `alipay_bot payment.check`，再调用 edu-api finalize/check；不能用前端按钮、订单号或二维码作为支付凭证。
- `success` 只由服务端 `resource_ready` 进入，随后刷新设置快照和订单列表；本地 `tradeNo` 或 `paid` 不能直接触发成功。
- 订单恢复必须重新取得或校验 Payment-Needed、payment context 和会话状态；仅有旧二维码的记录不能直接作为 A1 可支付会话。

A1 复用的是本地 Pi SDK 和 `alipay_bot` 的底层 action 能力，不复用 `alipay-ai-buyer-agent` Skill 的对话式资源购买流程，也不把设置页订单转换为 Agent 付费资源订单。设置页必须由 Rust 协调器固定编排 `wallet.check`、`payment.start`、`payment.check`，不让模型自由选择支付 action。

## 订单恢复

`CopisWorkingOrdersPanel` 现有“继续支付”按钮应改为打开统一支付弹窗：

- 普通钻石订单：`mode = "diamonds"`，调用 `getOrderPayment(order.id)`。
- VIP 订单：`mode = "vip"`，调用 `getOrderPayment(order.id)`。
- `getOrderPayment` 返回的 `payment`、`package`、`vip` 直接进入支付状态，不重新调用创建接口。
- `payment.qrcode_image` 缺失时显示恢复失败，不渲染空白二维码；有合法 `cashier_url` 时允许安全外部打开。
- 订单恢复成功后，“继续支付”与设置页新建支付使用完全相同的 `checkPayment` 和成功刷新逻辑。
- A1 下订单恢复不能只依赖 `getOrderPayment` 返回的展示字段；Rust 必须为该订单重建或校验内部支付准备信息。
- 删除订单仍使用现有 `deleteWorkingOrder`，不允许在支付弹窗中通过删除订单替代取消支付。

## UI 和交互契约

- “获取钻石”弹窗至少包含：套餐选择、金额、到账钻石、待支付提示、二维码、订单号、继续支付、取消订单、我已支付、关闭和错误/加载状态。
- VIP 流程至少包含：Free/VIP 权益对比、开通天数、实际支付金额、赠送钻石、确认升级、二维码和支付状态；权益对比只展示“专家团队”和“定时任务”，不展示云盘容量、会话等待或高峰期排队。
- VIP 弹窗不展示“价格和到账数量以服务端为准”或“本次开通 30 天，服务端价格 ¥ 49.90”两句说明性文案；金额、天数和赠送钻石仍必须使用服务端返回值。
- 支付按钮在请求期间显示进行中状态并禁用；关闭按钮不能导致异步请求的未处理异常。
- 支付成功提示区分“钻石已到账”和“VIP 已开通”，随后关闭弹窗并刷新设置数据。
- 待支付、支付中、资源处理中不能显示“支付成功”。
- 视觉实现沿用 Copis 设置页现有组件和 CSS 变量；不把原始后端错误、支付凭证或内部状态名直接作为用户文案。
- Electron 实际窗口中的二维码可读性、弹窗层级、关闭行为和视觉布局必须由用户最终确认，自动化测试不能替代该确认。

## 安全约束

- JWT 只由 `WorkingApiClient` 和其 token store 持有，renderer 只调用 typed `window.electronAPI` 或既有本地 HTTP bridge。
- 不在 console、错误 toast、测试快照或埋点中输出 JWT、二维码 base64、`payment_needed`、支付 proof 或完整后端响应。
- 所有 URL 路径参数必须编码；`cashierUrl` 只允许现有 `openExternal` 的 `http` / `https` 协议校验。
- 金额、套餐归属、支付状态、资源到账和 VIP 有效期都以服务端为准，客户端不能通过修改响应或本地状态获得权益。
- 账号登出时清理 Jotai 中的支付会话；正在进行的请求返回后不得重新写入已登出的账户界面。
- A1 的 `Payment-Needed`、支付上下文和 payment proof 只允许在 Rust 支付协调器与受控服务端接口之间传递；不能进入 Renderer、Pi 模型上下文、普通 Agent transcript、日志或持久化的用户配置。
- 设置页支付必须在用户明确确认后才调用本地 `payment.start`；套餐金额、订单号和支付意图不能由模型推断或拼接。
- `alipay-bot` 钱包状态必须按 Working 用户隔离，并与普通 Agent session 隔离；支付 session 结束、取消、登出或超时后清理临时文件和 capability。
- A1 不允许通过重复调用创建接口规避上游失败；`payment_id` / `out_trade_no` 是恢复和 finalize 的幂等键。

## BDD 验收场景

### 获取钻石（当前基础接入回归）

```text
Given 用户已登录且不是子账号
When 打开“获取钻石”
Then 先读取待支付钻石订单
And 没有待支付订单时展示服务端返回的普通钻石套餐
And 列表不展示 service_id 或 goods_name 为 pi-vip 的套餐
```

```text
Given 用户选择一个服务端返回的钻石套餐
When 点击“确认支付”
Then 只提交 package_id
And 页面展示支付宝二维码、服务端金额、钻石数量和订单号
And 不把支付请求中的 token 或内部 payment_needed 暴露给渲染层
```

```text
Given 支付二维码已展示但用户尚未完成支付
When 点击“我已支付”且服务端返回 pending_user_pay
Then 页面保持支付状态
And 不提示支付成功
And 用户可以稍后再次检查
```

```text
Given 服务端返回 resource_ready
When 支付检查请求完成
Then 提示钻石已到账
And 刷新 Working 设置快照与订单列表
And 个人钻石余额显示最新值
```

### VIP 升级（当前基础接入回归）

```text
Given VIP 配置可用
When 点击“升级 VIP”
Then 打开权益对比
And 金额、天数和赠送钻石来自 settings.vip
```

```text
Given 用户在权益对比中确认升级
When 调用 VIP 升级接口
Then 请求体为空对象
And 页面展示服务端返回的 VIP 支付金额、二维码和天数
```

```text
Given 用户已有未过期的待支付 VIP 订单
When 再次点击升级 VIP
Then 后端返回 pending_existing=true
And 页面复用该订单继续支付
And 不重复创建新的 VIP 支付订单
```

```text
Given 用户已经是有效 VIP
When 完成一次新的 VIP 支付并返回 resource_ready
Then 客户端重新读取服务端 VIP 到期时间
And 不在客户端自行累加 VIP 天数
```

### 订单恢复和权限

```text
Given 我的订单中存在 pending 的钻石订单或 VIP 订单
When 点击“继续支付”
Then 通过订单 ID 获取支付会话
And 打开统一支付弹窗
And 不调用创建订单接口
```

```text
Given 当前登录账号是孩子账号
When 点击获取钻石或确认升级 VIP
Then 后端返回 HTTP 403 和孩子账号限制文案
And 页面不展示可继续支付的二维码
And 不产生前端成功状态
```

```text
Given 待支付订单已经在其他设备完成或取消
When 当前客户端尝试恢复订单或取消订单
Then 接收 409 或 cancelled=false
And 刷新订单列表
And 提示订单状态已变化，不重复创建订单
```

### A1 本地 Pi 支付执行（设置页）

```text
Given 用户已选择服务端返回的钻石或 VIP 支付方案并明确确认
When Copis 创建支付准备信息
Then edu-api 只创建/恢复业务订单并返回服务端生成的 Payment-Needed
And 不调用 pi-runtime /api/alipay/execute
And Payment-Needed 只存在于 Rust 支付协调器
And 不调用 alipay-ai-buyer-agent Skill 的对话式资源购买流程
And 不把设置页订单转换为 Agent 付费资源订单
```

```text
Given Rust 已取得有效 Payment-Needed 和支付上下文
When 本地 Pi SDK 调用 alipay_bot payment.start
Then alipay-bot 使用真实的 Payment-Needed、resource_url、请求方法、请求体和 headers
And 不根据金额自行拼接账单
And payment proof、CLI 原文和临时文件路径不进入 Renderer 或模型上下文
```

```text
Given 本地 alipay-bot 已返回交易号和二维码
When Rust 回写 payment-started
Then edu-api 持久化支付会话、二维码和交易标识
And 设置页可以展示二维码
And 重复回写不会创建第二笔订单
```

```text
Given 用户点击“我已支付”
When 本地 Pi SDK 调用 alipay_bot payment.check
Then Rust 将受控支付结果提交给 edu-api finalize/check 接口
And edu-api 幂等完成钻石到账或 VIP 延期
And 只有 resource_ready 才进入前端成功状态
```

```text
Given 两个不同 Working 用户分别发起支付宝支付
When 本地 alipay-bot 读取钱包状态
Then 两个用户使用隔离的 PiHome/钱包目录
And 一个用户不能读取、复用或覆盖另一个用户的支付会话
```

## 实现验证

支付功能实现完成后，至少执行：

```bash
bun test packages/shared/src/types/working.test.ts
bun test apps/electron/src/main/lib/working-api-client.test.ts
bun test apps/electron/src/main/lib/http-api-server.test.ts
bun test apps/electron/src/renderer/lib/http-api-bridge.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
git diff --check
```

BDD 测试至少覆盖：

- 套餐字段归一化、VIP 套餐过滤和金额字符串保留。
- 支付会话二维码 data URL 归一化及缺少 payment ID 的协议错误。
- 待支付查询、VIP `pending_existing`、订单恢复和取消结果。
- `resource_ready` 才进入成功，其他状态不得误报成功。
- 401、403、404、409 和后端 5xx 错误消息传递。
- IPC/preload/HTTP bridge 四层方法名称和参数一致。

A1 额外验证至少覆盖：

- 创建钻石/VIP 准备请求不会调用公开支付创建接口中的 pi-runtime 执行路径。
- `Payment-Needed`、支付上下文和 payment proof 不会进入共享类型、Renderer 状态、Pi transcript、日志或用户配置。
- 本地 `payment.start` 的 action、临时文件清理、二维码读取和 `payment-started` 回写。
- 本地 `payment.check` 与 edu-api finalize/check 的幂等关系，重复检查不会重复到账或延长 VIP。
- VIP prepare、`pending_existing`、已开通 VIP 续期和失败 session 恢复。
- 每个 Working 用户的支付宝钱包目录、PiHome 和支付 capability session 隔离。
- 当前激活的 Rust 功能模块确实包含 A1 路由；不能只验证仓库源码或未激活缓存二进制。

自动化检查通过后，由用户在真实 Electron 窗口中完成一次普通钻石购买流程和一次 VIP 升级流程的 UI 确认，重点检查二维码可读、弹窗可关闭、支付状态刷新和余额/VIP 有效期显示。

## 参考实现

接口和业务语义以 ai-education 当前实现为准，重点参考：

- `frontend/src/pages/WorkingSettings.tsx`
- `frontend/src/components/DiamondPurchaseModal.tsx`
- `frontend/src/components/DiamondPaymentContent.tsx`
- `frontend/src/components/diamondPayment.ts`
- `frontend/src/components/WorkingVIPBenefitsModal.tsx`
- `frontend/src/components/MyOrdersPanel.tsx`
- `backend/modules/edu-api/routes.go`
- `backend/modules/edu-api/handlers/vip.go`
- `backend/modules/edu-api/handlers/alipay_diamonds.go`
- `backend/modules/edu-api/handlers/orders.go`
- `backend/modules/edu-api/handlers/payment_access.go`
- `backend/modules/working-agent-service/workingagent/alipay.go`
- `backend/modules/working-agent-service/cmd/file-bridge-mcp/main.go`
- `backend/modules/pi-runtime/alipay_wallet.go`
- `docs/pi-runtime-alipay-bot-persistence-plan.md`
