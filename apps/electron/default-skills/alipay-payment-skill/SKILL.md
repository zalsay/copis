---
name: alipay-payment-skill
displayName: Copis 支付
description: Copis 钻石购买与 VIP 升级支付流程。
group: 系统内置
icon: credit-card
version: 0.0.11
---

# Copis 支付

本 Skill 只用于 Copis Working 钻石购买与 VIP 升级。不得通过 shell、环境变量、日志或对话要求用户提供令牌、支付凭据或外部订单标识。

设置页带来的 `<copis_diamond_purchase>` 表示用户已确认一个套餐，但仍必须以最新套餐结果为准。
设置页带来的 `<copis_vip_upgrade>` 表示用户已确认升级或续费 VIP；价格、权益和赠送钻石均以服务端配置为准。

## 固定流程

### 第一步：待支付订单

钻石购买时，先调用 `copis_working_payment` 的 `orders.pending` 查询是否有待支付订单。VIP 升级跳过此步骤，继续钱包检查。

若返回状态为 `pending_user_pay` 且包含支付二维码，优先继续该订单：展示二维码并只回复：`请使用支付宝扫码完成支付，完成后我会自动为你确认到账。` 不得创建新订单、重新检查钱包或重新选择套餐。

没有待支付订单，或订单状态异常、支付二维码不可用时，才继续以下流程创建订单。

### 第二步：钱包检查

调用 `alipay_bot` 的 `wallet.check` 确认钱包可用且已授权。只有 `code=200` 且 `accessUrl` 缺失或为空时才可继续。

钱包待授权、未开通或不可用时，告知用户需要完成授权或开通，加载 `alipay-authenticate-wallet`，并停止本次购买流程。不得在本 Skill 内执行钱包开通或绑定动作。

### 第三步：套餐复核

钻石购买时，调用 `copis_working_payment` 的 `packages.list`，读取当前启用套餐的 `id`、`goodsName`、`amount`、`currency` 与 `diamonds`。

用户尚未明确选择套餐时，展示最新套餐并请用户选择。用户已选择套餐或上下文包含 `<copis_diamond_purchase>` 时，核对套餐 ID、价格和钻石数量；套餐不存在、未启用或信息变化时，说明最新结果并停止创建订单。

VIP 升级时，确认上下文包含 `<copis_vip_upgrade>`，并说明价格、权益和赠送钻石以服务端当前配置为准；不得将钻石套餐作为 VIP 套餐使用。

### 第四步：创建订单并显示二维码

钻石购买在钱包和套餐均通过后，调用 `copis_working_payment` 的 `order.create` 并传入已复核的 `packageId`。VIP 升级在钱包检查通过后，调用 `copis_working_payment` 的 `vip.create`。二维码将直接显示在对话中。

只向后续步骤保留 `payment.paymentId`。不得展示、猜测或要求用户提供支付凭据、交易号或其他外部订单标识。

订单创建成功且已显示二维码时，只回复：`请使用支付宝扫码完成支付，完成后我会自动为你确认到账。`

不得向用户说明内部实现或额外操作。

### 第五步：等待支付确认

订单创建成功后，保留 `payment.paymentId`，等待用户完成支付宝扫码。

用户表示“我付好了”“已支付”或询问支付进度时，必须调用 `copis_working_payment` 的 `order.check`，并传入当前订单的 `paymentId`。只允许确认当前已创建订单，不得创建新订单、重新调用钱包检查、要求用户提供交易号，也不得用其他支付接口替代。

`order.check` 返回后，本轮必须以明确的结果结束回复，不得只回复“正在确认到账”后结束：

- `resource_ready`：钻石购买回复“支付已完成，钻石已到账。”；VIP 升级回复“支付已完成，VIP 已开通。”
- `resource_pending`：回复“支付已确认，权益正在到账，请稍后再次查看。”
- `pending_user_pay` 或 `created`：回复“暂时还未确认到账，请确认已完成扫码支付。”
- `cancelled`、`expired` 或 `failed`：回复“订单未完成，请关闭当前支付流程后重试。”
- 其他状态或确认调用失败：回复“暂时无法确认支付状态，请稍后重试。”

确认结果已经明确时，不要继续重复调用 `order.check`；只有用户再次明确询问或确认，才可再次检查同一个 `paymentId`。

## 失败处理

- 钱包未就绪：转入 `alipay-authenticate-wallet`，本次购买停止。
- 套餐复核失败：展示最新套餐，等待用户重新选择。
- 创建订单失败：说明创建失败，保留已选择套餐，等待用户决定是否重试。
