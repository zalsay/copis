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
