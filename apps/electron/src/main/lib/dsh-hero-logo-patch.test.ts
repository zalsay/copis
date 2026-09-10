import { describe, expect, test } from 'bun:test'
import { patchDshHeroLogoSource } from './dsh-hero-logo-patch'

const legacyPandaHeroFishSource = `
		function HeroFish({ hovering }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				className: HeroShell_module_css_default.fish,
				width: 34,
				height: 34,
				viewBox: "347 347 560 560",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				style: {
					display: "block",
					overflow: "visible",
					animation: "none",
					transform: hovering ? "scale(1.08)" : "scale(1)",
					transition: "transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)"
				},
				"aria-hidden": "true",
				children: [
					(0, react_jsx_runtime.jsx)("path", {
						d: "M 433 532 L 417 555 L 413 564 Z",
						fill: "url(#copisHeroSilverGrad)"
					})
				]
			});
		}
		/**
		* Render the hero chrome (headline only; no composer, no workspace row).
		* @param props - see {@link HeroShellProps}.
		* @returns the centered hero element tree.
		*/
		function HeroShell({ t, renderSlot, children }) {
			return null;
		}
`

const officialWhaleHeroFishSource = `
		function HeroFish({ hovering }) {
			return (0, react_jsx_runtime.jsx)("svg", {
				className: HeroShell_module_css_default.fish,
				width: 34,
				height: 34 * _deepseek_ai_dsh_client_ui_primitives.FISH_LOGO_VIEWBOX.height / _deepseek_ai_dsh_client_ui_primitives.FISH_LOGO_VIEWBOX.width,
				viewBox: \`0 0 \${_deepseek_ai_dsh_client_ui_primitives.FISH_LOGO_VIEWBOX.width} \${_deepseek_ai_dsh_client_ui_primitives.FISH_LOGO_VIEWBOX.height}\`,
				fill: "none",
				"aria-hidden": "true",
				children: (0, react_jsx_runtime.jsx)("path", {
					d: _deepseek_ai_dsh_client_ui_primitives.FISH_LOGO_PATH,
					fill: "currentColor"
				})
			});
		}
		function HeroShell({ t, renderSlot, children }) {
			return null;
		}
`

describe('dsh-hero-logo-patch', () => {
  test('Given DSH 包含旧版熊猫图标的 HeroFish 源码 When 执行 patchDshHeroLogoSource Then 替换为全新双环银色 Logo', () => {
    const patched = patchDshHeroLogoSource(legacyPandaHeroFishSource)
    expect(patched).toContain('M 725.5 791.5 L 738.5 790.1')
    expect(patched).toContain('M 563.5 803.5 L 579.5 801.3')
    expect(patched).toContain('id: "copisHeroSilverGrad"')
    expect(patched).toContain('x1: "379"')
    expect(patched).toContain('y1: "449"')
    expect(patched).toContain('transform: hovering ? "scale(1.08)" : "scale(1)"')
    expect(patched).not.toContain('M 433 532')
  })

  test('Given 官方 DSH 鲸鱼图标的 HeroFish 源码 When 执行 patchDshHeroLogoSource Then 替换为全新双环银色 Logo', () => {
    const patched = patchDshHeroLogoSource(officialWhaleHeroFishSource)
    expect(patched).toContain('M 725.5 791.5 L 738.5 790.1')
    expect(patched).toContain('M 563.5 803.5 L 579.5 801.3')
    expect(patched).not.toContain('FISH_LOGO_PATH')
  })

  test('Given 已修补的源码 When 重复执行 patchDshHeroLogoSource Then 保持幂等不产生变化', () => {
    const patched = patchDshHeroLogoSource(legacyPandaHeroFishSource)
    const doublePatched = patchDshHeroLogoSource(patched)
    expect(doublePatched).toBe(patched)
  })

  test('Given 结构不匹配的未知源码 When 执行 patchDshHeroLogoSource Then 抛出明确异常', () => {
    expect(() => patchDshHeroLogoSource('const unknown = 123')).toThrow('DSH 创造模式 HeroFish 组件未找到匹配结构')
  })
})
