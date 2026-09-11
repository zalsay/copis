import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_ENTRY = 'node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js'

/**
 * 修改 DSH 侧边栏菜单项样式：
 * 将 CopisMenuItem / CopisRailItem 的激活态背景与文字颜色设置为 creation-ui-primary 体系，并移除边框。
 */
export function patchDshSidebarSource(source: string): string {
  if (source.includes('border: isActive ? "0.5px solid rgba(245, 158, 11, 0.35)" : "none"')) {
    source = source.replaceAll(
      'border: isActive ? "0.5px solid rgba(245, 158, 11, 0.35)" : "none"',
      'border: "none"',
    )
  }
  // 替换原有 amber 激活背景或旧版 ui-primary 激活背景为 creation-ui-primary-background
  if (source.includes('background: isActive ? "var(--dsw-alias-button-elevated-fill, rgba(245, 158, 11, 0.14))" : "transparent"')) {
    source = source.replaceAll(
      'background: isActive ? "var(--dsw-alias-button-elevated-fill, rgba(245, 158, 11, 0.14))" : "transparent"',
      'background: isActive ? "var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15))" : "transparent"',
    )
  }
  if (source.includes('background: isActive ? "var(--ui-primary-background, rgba(240, 161, 90, 0.2))" : "transparent"')) {
    source = source.replaceAll(
      'background: isActive ? "var(--ui-primary-background, rgba(240, 161, 90, 0.2))" : "transparent"',
      'background: isActive ? "var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15))" : "transparent"',
    )
  }

  // 替换原有 amber 激活颜色或旧版 ui-primary 激活颜色为 creation-ui-primary
  if (source.includes('color: isActive ? "#f59e0b" : "var(--dsw-alias-label-secondary)"')) {
    source = source.replaceAll(
      'color: isActive ? "#f59e0b" : "var(--dsw-alias-label-secondary)"',
      'color: isActive ? "var(--creation-ui-primary, #6C00CC)" : "var(--dsw-alias-label-secondary)"',
    )
  }
  if (source.includes('color: isActive ? "var(--ui-primary, #f09a43)" : "var(--dsw-alias-label-secondary)"')) {
    source = source.replaceAll(
      'color: isActive ? "var(--ui-primary, #f09a43)" : "var(--dsw-alias-label-secondary)"',
      'color: isActive ? "var(--creation-ui-primary, #6C00CC)" : "var(--dsw-alias-label-secondary)"',
    )
  }

  // 确保新建会话按钮在触发 startSession 前派发 triggerCopisNavigate("conversations")
  source = source.replace(
    /onClick:\s*\(\)\s*=>\s*\{\s*(?:triggerCopisNavigate\("conversations"\);\s*)?startSession\(\);\s*\}/g,
    'onClick: () => {\n\t\t\t\t\t\t\t\ttriggerCopisNavigate("conversations");\n\t\t\t\t\t\t\t\tstartSession();\n\t\t\t\t\t\t\t}',
  )

  // 确保工作区列表容器带有 onClickCapture 捕获切回会话事件
  source = source.replace(
    /className:\s*SidebarRoot_module_css_default\.regionArea,\s*(?:onClickCapture:\s*\(\)\s*=>\s*\{\s*triggerCopisNavigate\("conversations"\);\s*\},\s*)?children:\s*renderSlot\("sidebar\.workspaces"/g,
    'className: SidebarRoot_module_css_default.regionArea,\n\t\t\t\t\t\tonClickCapture: () => { triggerCopisNavigate("conversations"); },\n\t\t\t\t\t\tchildren: renderSlot("sidebar.workspaces"',
  )

  // 确保侧边栏底部 footArea 移除意见反馈菜单项（已移入设置菜单）
  source = source.replace(
    /(?:wide\s*\?\s*)?\(0,\s*react_jsx_runtime\.jsx\)\(CopisMenuItem,\s*\{\s*label:\s*"意见反馈"[\s\S]*?\}\)\s*:\s*\(0,\s*react_jsx_runtime\.jsx\)\(CopisRailItem,\s*\{\s*label:\s*"意见反馈"[\s\S]*?\}\),?\s*/g,
    '',
  )

  // 确保侧边栏 CopisLogo 升级为全新双环银色 Logo
  const COPIS_SIDEBAR_LOGO_MARKER = 'M 725.5 791.5 L 738.5 790.1'
  if (source.includes('const CopisLogo =') && !source.includes(COPIS_SIDEBAR_LOGO_MARKER)) {
    const COPIS_SIDEBAR_LOGO_REPLACEMENT = `const CopisLogo = (props) => (0, react_jsx_runtime.jsxs)("svg", {
				width: props.size || 22,
				height: props.size || 22,
				viewBox: "347 347 560 560",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				style: { flexShrink: 0 },
				children: [
					(0, react_jsx_runtime.jsx)("defs", {
						children: (0, react_jsx_runtime.jsxs)("linearGradient", {
							id: "copisSilverGrad",
							x1: "379",
							y1: "449",
							x2: "875",
							y2: "805",
							gradientUnits: "userSpaceOnUse",
							children: [
								(0, react_jsx_runtime.jsx)("stop", { offset: "0%", stopColor: "#F7F7F7" }),
								(0, react_jsx_runtime.jsx)("stop", { offset: "42%", stopColor: "#DEDEDE" }),
								(0, react_jsx_runtime.jsx)("stop", { offset: "76%", stopColor: "#FBFBFB" }),
								(0, react_jsx_runtime.jsx)("stop", { offset: "100%", stopColor: "#D0D0D0" })
							]
						})
					}),
					(0, react_jsx_runtime.jsx)("path", {
						d: "M 725.5 791.5 L 738.5 790.1 L 754.5 786.2 L 773.5 779.2 L 785.5 773.2 L 800.5 764.2 L 812.5 755.3 L 825.3 743.5 L 835.2 732.5 L 843.3 721.5 L 852.2 706.5 L 859.2 691.5 L 864.2 677.5 L 871.2 644.5 L 872.3 631.5 L 872.3 608.5 L 870.2 589.5 L 867.1 574.5 L 857.2 545.5 L 850.2 531.5 L 842.0 518.5 L 823.5 496.8 L 800.5 478.9 L 788.5 472.0 L 774.5 465.8 L 758.5 460.8 L 742.5 457.8 L 715.5 456.7 L 697.5 458.8 L 681.5 462.8 L 663.5 469.8 L 648.5 478.0 L 633.5 488.7 L 616.7 504.5 L 605.8 517.5 L 597.8 529.5 L 590.7 542.5 L 583.7 558.5 L 578.9 573.5 L 574.9 592.5 L 572.8 616.5 L 572.7 695.5 L 574.5 697.0 L 589.5 687.1 L 601.3 675.5 L 609.2 665.5 L 622.1 643.5 L 637.5 609.0 L 650.5 583.4 L 660.5 568.4 L 675.5 553.5 L 684.3 547.5 L 694.3 542.5 L 702.8 539.5 L 713.5 537.4 L 732.5 537.4 L 740.2 538.5 L 750.6 541.5 L 763.4 547.5 L 774.6 555.5 L 787.5 569.5 L 795.5 583.4 L 800.5 597.4 L 802.6 607.5 L 802.6 634.5 L 800.5 644.6 L 795.5 658.5 L 789.5 669.5 L 782.5 678.7 L 771.5 689.5 L 759.6 697.5 L 746.8 703.5 L 732.8 707.5 L 724.5 708.6 L 703.5 708.6 L 694.5 731.5 L 686.5 746.5 L 675.5 762.6 L 658.1 783.5 L 671.5 788.1 L 687.5 791.2 L 703.5 792.4 L 725.5 791.5 Z",
						fill: "url(#copisSilverGrad)"
					}),
					(0, react_jsx_runtime.jsx)("path", {
						d: "M 563.5 803.5 L 579.5 801.3 L 597.5 796.2 L 613.5 789.3 L 629.5 780.2 L 640.5 772.2 L 656.2 757.5 L 665.3 746.5 L 675.1 731.5 L 682.3 717.5 L 688.1 702.5 L 695.1 672.5 L 696.3 657.5 L 696.4 573.5 L 695.5 571.7 L 694.5 572.0 L 682.5 582.0 L 665.9 600.5 L 652.8 621.5 L 634.5 660.8 L 625.5 676.5 L 611.9 692.5 L 598.5 703.5 L 587.6 709.5 L 573.7 714.5 L 563.6 716.5 L 549.5 717.0 L 538.2 716.5 L 522.1 712.5 L 509.0 706.5 L 498.5 699.5 L 486.5 687.5 L 479.4 677.5 L 472.5 663.7 L 467.5 646.5 L 466.1 628.5 L 467.5 609.7 L 471.5 595.3 L 478.5 580.5 L 491.6 563.5 L 503.5 553.5 L 517.4 545.5 L 527.3 541.5 L 543.6 537.5 L 555.5 536.4 L 573.5 537.3 L 585.5 516.7 L 599.5 498.5 L 615.5 482.5 L 632.2 469.5 L 631.5 467.8 L 620.5 462.9 L 597.5 455.8 L 572.5 452.0 L 550.5 451.8 L 530.5 453.9 L 515.5 456.9 L 496.5 462.7 L 481.5 468.9 L 466.5 476.8 L 451.5 486.7 L 427.9 507.5 L 415.9 521.5 L 405.7 536.5 L 395.7 555.5 L 389.8 570.5 L 384.9 587.5 L 381.8 604.5 L 380.7 615.5 L 380.7 640.5 L 382.9 658.5 L 386.7 675.5 L 391.7 691.5 L 398.8 708.5 L 406.8 723.5 L 416.8 738.5 L 424.8 748.5 L 441.5 765.3 L 464.5 782.1 L 479.5 790.0 L 497.5 797.0 L 512.5 801.2 L 532.5 804.2 L 563.5 803.5 Z",
						fill: "url(#copisSilverGrad)"
					})
				]
			});`
    source = source.replace(
      /const CopisLogo = \(props\) => \(0, react_jsx_runtime\.jsxs?\)\("svg",[\s\S]*?\);\n(?=\t*const iconSparkles)/,
      `${COPIS_SIDEBAR_LOGO_REPLACEMENT}\n`,
    )
  }

  return source
}

/** 构建期及已安装模块启动前共用；确保 DSH 侧边栏菜单样式与 Agent 模式保持一致。 */
export function patchDshSidebarRuntime(runtimeRoot: string): boolean {
  const entrypoint = join(runtimeRoot, CLIENT_ENTRY)
  if (!existsSync(entrypoint)) return false
  const source = readFileSync(entrypoint, 'utf8')
  const patched = patchDshSidebarSource(source)
  if (source !== patched) writeFileSync(entrypoint, patched, 'utf8')
  return true
}
