---
name: alipay-payment-skill
displayName: Copis 支付
description: Copis Working 钻石购买流程。
group: 系统内置
icon: credit-card
version: 0.0.8
---

# Copis 钻石支付

本 Skill 只用于 Copis Working 钻石购买。不得通过 shell、环境变量、日志或对话要求用户提供令牌、支付凭据或外部订单标识。

设置页带来的 `<copis_diamond_purchase>` 表示用户已确认一个套餐，但仍必须以最新套餐结果为准。

## 固定流程

### 第一步：钱包检查

调用 `alipay_bot` 的 `wallet.check` 确认钱包可用且已授权。只有 `code=200` 且 `accessUrl` 缺失或为空时才可继续。

钱包待授权、未开通或不可用时，告知用户需要完成授权或开通，加载 `alipay-authenticate-wallet`，并停止本次购买流程。不得在本 Skill 内执行钱包开通或绑定动作。

### 第二步：套餐复核

调用 `copis_working_payment` 的 `packages.list`，读取当前启用套餐的 `id`、`goodsName`、`amount`、`currency` 与 `diamonds`。

用户尚未明确选择套餐时，展示最新套餐并请用户选择。用户已选择套餐或上下文包含 `<copis_diamond_purchase>` 时，核对套餐 ID、价格和钻石数量；套餐不存在、未启用或信息变化时，说明最新结果并停止创建订单。

### 第三步：创建订单并显示二维码

钱包和套餐均通过后，调用 `copis_working_payment` 的 `order.create` 并传入已复核的 `packageId`。二维码将直接显示在对话中。

只向后续步骤保留 `payment.paymentId`。不得展示、猜测或要求用户提供支付凭据、交易号或其他外部订单标识。

订单创建成功且已显示二维码时，只回复：`请使用支付宝扫码完成支付，完成后我会自动为你确认到账。`

不得向用户说明内部实现或额外操作。

### 第四步：等待支付确认

订单创建成功后，等待支付结果自动确认并完成到账。用户表示已支付或询问进度时，说明正在确认到账；不得自行调用其他支付或订单查询动作。

## 失败处理

- 钱包未就绪：转入 `alipay-authenticate-wallet`，本次购买停止。
- 套餐复核失败：展示最新套餐，等待用户重新选择。
- 创建订单失败：说明创建失败，保留已选择套餐，等待用户决定是否重试。
