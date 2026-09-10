import { expect, test } from 'bun:test'
import { patchDshSidebarSource } from './dsh-sidebar-patch'

const sampleSource = `
const CopisMenuItem = (props) => {
  const isActive = activeCopisNav === props.view;
  return (0, react_jsx_runtime.jsxs)("button", {
    type: "button",
    style: {
      border: isActive ? "0.5px solid rgba(245, 158, 11, 0.35)" : "none",
      background: isActive ? "var(--dsw-alias-button-elevated-fill, rgba(245, 158, 11, 0.14))" : "transparent",
      color: isActive ? "#f59e0b" : "var(--dsw-alias-label-secondary)",
    }
  });
};
`

test('Given DSH 侧边栏源码 When 执行 patchDshSidebarSource Then 激活菜单背景与颜色使用 creation-ui-primary 体系且移除边框', () => {
  const patched = patchDshSidebarSource(sampleSource)
  expect(patched).toContain('border: "none"')
  expect(patched).toContain('background: isActive ? "var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15))" : "transparent"')
  expect(patched).toContain('color: isActive ? "var(--creation-ui-primary, #6C00CC)" : "var(--dsw-alias-label-secondary)"')
  expect(patched).not.toContain('rgba(245, 158, 11')
  expect(patched).not.toContain('#f59e0b')

  // 从旧版 ui-primary 补丁平滑升级
  const legacyUiPrimarySource = `
    border: "none",
    background: isActive ? "var(--ui-primary-background, rgba(240, 161, 90, 0.2))" : "transparent",
    color: isActive ? "var(--ui-primary, #f09a43)" : "var(--dsw-alias-label-secondary)"
  `
  const upgraded = patchDshSidebarSource(legacyUiPrimarySource)
  expect(upgraded).toContain('background: isActive ? "var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15))" : "transparent"')
  expect(upgraded).toContain('color: isActive ? "var(--creation-ui-primary, #6C00CC)" : "var(--dsw-alias-label-secondary)"')

  // 幂等性测试
  expect(patchDshSidebarSource(patched)).toBe(patched)
})

test('Given DSH 侧边栏源码中的新建会话按钮与工作区容器 When 执行 patchDshSidebarSource Then 自动注入 triggerCopisNavigate("conversations")', () => {
  const sourceWithNewSession = `
    onClick: () => {
      startSession();
    },
    (0, react_jsx_runtime.jsx)("div", {
      className: SidebarRoot_module_css_default.regionArea,
      children: renderSlot("sidebar.workspaces", { wide })
    })
  `
  const patched = patchDshSidebarSource(sourceWithNewSession)
  expect(patched).toContain('triggerCopisNavigate("conversations");')
  expect(patched).toContain('onClickCapture: () => { triggerCopisNavigate("conversations"); }')

  // 幂等性测试：重复执行不重复注入
  expect(patchDshSidebarSource(patched)).toBe(patched)
})

test('Given DSH 侧边栏源码中包含旧版 CopisLogo When 执行 patchDshSidebarSource Then 升级为全新双环银色 Logo 且保持幂等', () => {
  const sourceWithLogo = `
			const CopisLogo = (props) => (0, react_jsx_runtime.jsxs)("svg", {
				width: props.size || 22,
				children: [
					(0, react_jsx_runtime.jsx)("path", {
						d: "M 433 532 L 417 555 Z",
						fill: "url(#copisSilverGrad)"
					})
				]
			});
			const iconSparkles = (0, react_jsx_runtime.jsxs)("svg", {});
  `
  const patched = patchDshSidebarSource(sourceWithLogo)
  expect(patched).toContain('M 725.5 791.5 L 738.5 790.1')
  expect(patched).toContain('M 563.5 803.5 L 579.5 801.3')
  expect(patched).not.toContain('M 433 532')

  // 幂等性
  expect(patchDshSidebarSource(patched)).toBe(patched)
})

