---
name: alipay-authenticate-wallet
displayName: 支付宝钱包开通
description: >-
  支付宝官方支付服务开通和授权技能的 Copis 适配版本。用于检查钱包状态、申请开通、展示授权二维码和绑定授权码。
  当支付流程的 wallet.check 返回待授权或未开通时，必须使用此技能接管流程。
group: 系统内置
category: Copis 功能
icon: wallet-cards
version: 0.0.1
metadata:
  source: https://github.com/alipay/payment-skills/tree/main/alipay-authenticate-wallet
  author: alipay
  openclaw:
    category: wallet
    requires:
      anyBins: ["alipay-bot"]
      tags: ["wallet","alipay","支付能力","开通","授权"]
---

# 支付宝支付服务开通和授权

本技能基于支付宝官方 `alipay-authenticate-wallet` 流程，使用 Copis 受控的 `alipay_bot` 工具执行钱包操作。禁止使用 Bash、环境变量或直接调用 CLI。

## 触发条件

- `alipay-payment-skill` 的 `wallet.check` 返回 `code=200` 且 `accessUrl` 非空。
- `alipay-payment-skill` 的 `wallet.check` 返回 `code=500`。
- 用户明确要求开通、授权、绑定、查询或关闭支付宝支付钱包。
- 用户提供授权码，或反馈已经在支付宝中完成开通/授权。

## 钱包状态和开通流程

1. 进入本技能后，先调用 `alipay_bot`：`{ "action": "wallet.check" }`。只根据返回的 `code`、`message` 和 `accessUrl` 判断状态。
2. `code=200` 且 `accessUrl` 缺失或为空：钱包已开通并授权，告知用户支付功能已开启并结束；不得继续 `wallet.apply` 或 `wallet.bind`。
3. `code=200` 且 `accessUrl` 非空：钱包待授权。
   - 用户本轮提供授权码时，直接调用 `alipay_bot`：`{ "action": "wallet.bind", "bindCode": "<用户提供的授权码>" }`，原样传达结果并结束。
   - 否则调用 `alipay_bot`：`{ "action": "wallet.apply", "agentName": "Copis" }`，展示本次返回的文字、链接和二维码，并等待用户完成支付宝侧授权。
4. `code=500`：调用 `alipay_bot`：`{ "action": "wallet.apply", "agentName": "Copis" }`，展示本次返回的文字、链接和二维码，并等待用户完成支付宝侧授权。
5. 用户反馈“开通好了”“授权好了”“绑定好了”“扫完了”时，只调用一次 `wallet.check` 确认结果。仍待授权时原样传达结果，禁止自动重复申请。
6. `wallet.bind` 成功或失败后都立即结束；禁止自动再次 `wallet.apply`、`wallet.bind` 或 `wallet.check`。

## 二维码和输出规则

- `alipay_bot` 返回的 `qrCodeImage` 由 Copis 对话区直接展示；不得复制、打印或改写 data URL。
- 只展示本次工具调用返回的文字、链接和二维码，不复用历史二维码。
- 开通或授权完成后，回到购买场景时重新执行 `alipay-payment-skill` 的套餐复核和 `wallet.check`，不得复用旧订单。

## 禁止项

- 禁止使用 Bash 或 shell 直接执行 `alipay-bot`。
- 禁止猜测钱包状态、授权码、支付链接或订单号。
- 禁止在钱包待授权、未开通或检查失败时创建 Copis 钻石订单。
