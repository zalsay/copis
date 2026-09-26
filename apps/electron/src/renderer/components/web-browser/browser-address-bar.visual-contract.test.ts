import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const surfaceSource = readFileSync(join(import.meta.dir, 'WebBrowserSurface.tsx'), 'utf8')

describe('浏览器地址栏视觉契约', () => {
  test('Given 地址栏包含无痕按钮 When 渲染按钮容器 Then 右侧内边距为 0', () => {
    expect(surfaceSource).toContain('pl-3 pr-0')
    expect(surfaceSource).not.toContain('px-3 shadow-xs focus-within:border-primary/50')
  })

  test('Given 无痕页签已激活 When 渲染地址栏按钮 Then 仅使用 ui-primary 图标颜色且不显示背景', () => {
    expect(surfaceSource).toContain("'size-7 shrink-0 rounded-sm hover:bg-transparent'")
    expect(surfaceSource).toContain("'text-[var(--ui-primary)] hover:text-[var(--ui-primary)]'")
    expect(surfaceSource).not.toContain('bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground')
  })

  test('Given 地址栏所在页签 When 渲染容器 Then 仅无痕模式使用 ui-primary-background', () => {
    expect(surfaceSource).toContain("activeTab.isIncognito ? 'bg-[var(--ui-primary-background)]' : 'bg-input-surface'")
    expect(surfaceSource).toContain('bg-[var(--ui-primary-background)]')
    expect(surfaceSource).toContain('bg-input-surface')
    expect(surfaceSource).not.toContain('focus-within:border-primary/50')
    expect(surfaceSource).not.toContain('focus-within:ring-2')
  })

  test('Given 用户点击地址栏 When 触发聚焦或点击 Then 默认全选地址文本', () => {
    expect(surfaceSource).toContain('onFocus={handleAddressFocus}')
    expect(surfaceSource).toContain('onMouseUp={handleAddressMouseUp}')
    expect(surfaceSource).toContain('onBlur={handleAddressBlur}')
    expect(surfaceSource).toContain('onClick={handleAddressContainerClick}')
    expect(surfaceSource).toContain('event.currentTarget.select()')
    expect(surfaceSource).toContain('addressInputRef.current?.select()')
  })

  test('Given 密码提示与地址栏快捷气泡 When 渲染保存按钮与钥匙图标 Then 顶部的钥匙为默认次要色且弹层与横幅使用 ui-primary 配色', () => {
    const popoverSource = readFileSync(join(import.meta.dir, 'WebPasswordKeyPopover.tsx'), 'utf8')
    const bannerSource = readFileSync(join(import.meta.dir, 'WebPasswordPromptBanner.tsx'), 'utf8')

    // 顶部地址栏钥匙图标按钮必须采用默认次要色（text-muted-foreground），悬浮时高亮
    expect(popoverSource).toContain('className="size-7 shrink-0 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"')
    expect(popoverSource).toContain('<KeyRound className="size-3.5 text-muted-foreground hover:text-foreground" />')

    // 展开后的 Popover 内部保存按钮使用 ui-primary 配色
    expect(popoverSource).toContain("backgroundColor: 'var(--ui-primary)'")

    // 保存密码横幅提示中的钥匙图标与保存按钮必须采用 ui-primary 配色
    expect(bannerSource).toContain("<KeyRound className=\"size-4 shrink-0 text-[var(--ui-primary)]\" style={{ color: 'var(--ui-primary)' }} />")
    expect(bannerSource).toContain("backgroundColor: 'var(--ui-primary)'")
    expect(bannerSource).toContain("color: 'var(--ui-primary-foreground, #ffffff)'")
  })

  test('Given 网页工具栏刷新按钮 When 处于加载态 Then 显示停止（X）图标而非 loading 旋转态，点击触发 handleStop', () => {
    expect(surfaceSource).not.toContain("RotateCw className={cn('size-3 text-foreground', activeTab.isLoading && 'animate-spin')}")
    expect(surfaceSource).toContain("activeTab.isLoading ? '停止' : '刷新'")
    expect(surfaceSource).toContain("activeTab.isLoading ? handleStop() : handleReload()")
    expect(surfaceSource).toContain('<X className="size-3 text-foreground" strokeWidth={2} />')
    expect(surfaceSource).toContain('<RotateCw className="size-3 text-foreground" strokeWidth={2} />')
    expect(surfaceSource).toContain('window.electronAPI.webTabs.stop(activeTabId)')
  })

  test('Given 原生网页视图位于工具栏下方 When 悬停地址栏右侧按钮 Then 提示固定向上展开且不会碰撞翻转到网页区域', () => {
    expect(surfaceSource).toContain('<TooltipContent side="top" sideOffset={8} avoidCollisions={false}>')
    expect(surfaceSource).toContain('<TooltipContent side="top" sideOffset={8} avoidCollisions={false}>{label}</TooltipContent>')
    expect(surfaceSource).not.toContain('<TooltipContent side="bottom">{label}</TooltipContent>')
  })

  test('Given 网页工具栏 When 渲染同步按钮 Then 位于表单外且在 Copis logo 之后、实时同传之前独立显示', () => {
    const syncButtonSource = readFileSync(join(import.meta.dir, 'WebSyncStatusButton.tsx'), 'utf8')
    const addressFormStartIndex = surfaceSource.indexOf('<form className="ml-1 flex min-w-0 flex-1 items-center"')
    const addressFormEndIndex = surfaceSource.indexOf('</form>', addressFormStartIndex)
    const copisLogoIndex = surfaceSource.indexOf('src={CopisAgentLogo}')
    const copisToolbarEndIndex = surfaceSource.indexOf(') : null}', copisLogoIndex)
    const syncButtonIndex = surfaceSource.indexOf('<WebSyncStatusButton />')
    const liveTranslateIndex = surfaceSource.indexOf('label={liveTranslateActive')
    const syncInstances = surfaceSource.match(/<WebSyncStatusButton\s*\/>/g) ?? []

    expect(syncInstances).toHaveLength(1)
    expect(addressFormEndIndex).toBeGreaterThan(addressFormStartIndex)
    expect(syncButtonIndex).toBeGreaterThan(addressFormEndIndex)
    expect(copisToolbarEndIndex).toBeGreaterThan(copisLogoIndex)
    expect(syncButtonIndex).toBeGreaterThan(copisToolbarEndIndex)
    expect(liveTranslateIndex).toBeGreaterThan(syncButtonIndex)
    expect(syncButtonSource).toContain('<TooltipContent side="top" sideOffset={8} avoidCollisions={false}')
    expect(syncButtonSource).toContain('aria-label={presentation.label}')
    expect(syncButtonSource).toContain('if (compact) return button')
  })
})
