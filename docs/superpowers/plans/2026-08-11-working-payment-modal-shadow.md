# Working Payment Modal Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛共享支付弹窗的外层阴影并移除外层边框。

**Architecture:** 该变更只修改支付弹窗的根选择器，钻石和 VIP 通过同一 `CopisWorkingPaymentModal` 自动获得一致外观。现有视觉契约测试读取 CSS 源码，因此以一个确定性断言保护阴影与边框值。

**Tech Stack:** React、CSS、Bun test。

## Global Constraints

- 仅修改支付弹窗根容器的外层视觉，不改支付状态、请求或内部控件。
- 不创建 Git commit，除非用户明确要求。
- Electron UI 最终视觉由用户在实际应用窗口确认，不能用截图代替。

---

### Task 1: 收敛支付弹窗外层视觉

**Files:**
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingPaymentModal.visual-contract.test.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingPaymentModal.css`

**Interfaces:**
- Consumes: `.copis-working-payment-modal` 作为钻石与 VIP 共用弹窗根容器。
- Produces: 外阴影为 `0 12px 32px hsl(var(--foreground) / 0.12)`，且根容器没有 `border` 声明。

- [x] **Step 1: 写入失败的视觉契约测试**

```ts
test('Given 钻石或 VIP 支付弹窗 When 读取外层样式 Then 阴影收敛且不保留外边框', () => {
  expect(paymentStyles).toContain('box-shadow: 0 12px 32px hsl(var(--foreground) / 0.12);')
  expect(paymentStyles).not.toMatch(/\.copis-working-payment-modal\s*\{[^}]*\bborder:/s)
})
```

- [x] **Step 2: 运行测试并确认失败**

Run: `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingPaymentModal.visual-contract.test.ts`

Expected: FAIL，因为 CSS 仍使用 `0 24px 68px` 外阴影并声明根容器边框。

- [x] **Step 3: 最小化更新 CSS**

```css
.copis-working-payment-modal {
  /* 保留尺寸、圆角和卡片背景。 */
  box-shadow: 0 12px 32px hsl(var(--foreground) / 0.12);
}
```

删除此选择器的 `border` 声明，保留内部区域和控件的边线。

- [x] **Step 4: 运行视觉契约测试并确认通过**

Run: `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingPaymentModal.visual-contract.test.ts`

Expected: PASS。

- [x] **Step 5: 构建 Renderer 并检查变更**

Run: `bun run --filter='@copis/electron' build:renderer && git diff --check`

Expected: Renderer 构建成功，差异没有空白错误。
