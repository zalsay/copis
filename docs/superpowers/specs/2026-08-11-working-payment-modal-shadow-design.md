# 支付弹窗外层视觉收敛设计

## 目标

降低“获取钻石”和“升级 VIP”共用支付弹窗的外层阴影范围与亮度，并移除弹窗最外层边框。

## 范围

- 仅调整 `CopisWorkingPaymentModal.css` 的 `.copis-working-payment-modal`。
- 外阴影从 `0 24px 68px hsl(var(--foreground) / 0.18)` 收敛为 `0 12px 32px hsl(var(--foreground) / 0.12)`。
- 移除该选择器的外层 `border`。
- 保留页头、页脚、套餐、权益表和控件的内部边线；不改变支付流程、状态或交互。

## 验收

- 钻石与 VIP 支付弹窗均使用更小、更弱的外层阴影。
- 弹窗外轮廓不再有独立边框。
- 视觉契约测试锁定上述样式值。
- Electron 实际窗口中的视觉效果由用户确认。
