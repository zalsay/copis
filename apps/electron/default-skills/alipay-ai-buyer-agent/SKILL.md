---
name: alipay-ai-buyer-agent
displayName: 支付宝买家支付
description: 当 Agent 需要通过 alipay-bot 购买付费资源、开通支付宝支付能力、等待用户完成支付或确认支付状态时使用。设置页的 VIP/钻石购买不使用本 Skill。
group: 系统内置
icon: credit-card
version: "1.0.1"
---

# Alipay Bot Buyer Skill

本 Skill 只服务 Pi Agent 的付费资源流程。设置页的 VIP 升级和钻石购买继续使用 `Rust API -> edu-api` 的 `/api/working/*` 接口，不能改用本 Skill，也不能把两种订单互相转换。

## 能力边界

- 真实钱包和支付只能调用内置 `alipay_bot` 工具。
- 禁止使用 Bash、命令行、Node 脚本或其他工具直接执行 `alipay-bot`。
- 只处理工具返回的结构化结果，不把 CLI 原文、本地二维码路径、支付凭证或诊断日志当作用户内容。
- 支付状态、交易号和资源是否解锁以后端/工具的真实结果为准，不能猜测或提前宣布成功。

## 钱包前置

当用户询问支付能力，或支付返回钱包未开通、未授权、未绑定时，按以下顺序调用 `alipay_bot`：

1. 调用 `wallet.check`。
2. 返回未开通时调用 `wallet.apply`，`agentName` 使用 `Copis`，然后等待用户在支付宝侧完成授权。
3. 用户说“开通好了”“授权好了”“扫好了”后再次调用 `wallet.check`，不要重复申请。
4. 用户提供支付宝授权码时调用 `wallet.bind`，把授权码作为 `bindCode`；绑定成功只表示支付能力可用，不表示订单已经支付。
5. 只有用户明确要求换绑账号，或确认买卖家账号相同且用户要求更换买家账号时，才调用 `wallet.close`，之后重新走 `wallet.apply`。

不要手动修改钱包状态文件，也不要在钱包已开启或等待授权时重复调用 `wallet.apply`。

## 付费资源流程

1. 先向卖家资源接口发起请求；只有拿到真实的 `402 Payment Required` 和 `Payment-Needed` 后，才调用 `payment.start`。
2. `payment.start` 必须传入真实的 `paymentNeeded`、`resourceUrl`，以及资源请求使用的 `method`、`data`、`headers`；不得编造账单、金额、订单号或支付凭证。
3. 工具返回待支付状态后，面向用户只说“等待您的支付宝支付”，不要展示收银台链接、二维码、交易号或 `Payment-Proof`。
4. 用户明确说已经支付后，若后端没有自动确认，调用 `payment.check`，传入真实的 `tradeNo` 或 `outShakeNo`；必要时补充同一个资源请求的 URL、方法、数据和请求头。
5. 如果支付检查返回真实交易号且明确要求履约确认，调用 `payment.ack`；履约确认本身不代表资源已经交付。
6. 只有返回资源已解锁/请求成功的真实结果，才展示资源内容；`paid`、`pending` 或 `resource_pending` 都不能当作资源已交付。

当前推荐路径是：

```text
资源请求 -> 402 Payment-Needed -> payment.start -> 用户支付 -> payment.check -> 资源请求
```

## 用户文案

- 发起支付后固定回复：`等待您的支付宝支付`。
- 钱包未开通时说明需要先完成支付宝支付能力开通，但不自行补写授权码或支付结果。
- 支付已确认但资源仍处理中时说明“支付已完成，资源解锁处理中”。
- 失败或过期时简短说明真实错误，并允许用户重新发起流程。

不要在正文中输出 `Payment-Needed`、`Payment-Proof`、`tradeNo`、`outShakeNo`、本地文件路径或 CLI 诊断信息。
