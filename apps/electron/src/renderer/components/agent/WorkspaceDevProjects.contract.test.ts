import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sidePanelSource = readFileSync(join(import.meta.dir, 'SidePanel.tsx'), 'utf8')
const projectListSource = readFileSync(join(import.meta.dir, 'WorkspaceDevProjects.tsx'), 'utf8')

describe('项目开发列表契约', () => {
  test('Given 右侧文件区 When 用户查看第一个标签 Then 展示项目列表与启动控制', () => {
    expect(sidePanelSource).toContain('>\n                  项目列表\n                </button>')
    expect(sidePanelSource).toContain('<WorkspaceDevProjects workspaceSlug={workspaceSlug} />')
    expect(sidePanelSource).toContain('工作区')
    expect(projectListSource).toContain('startWorkspaceDevProject')
    expect(projectListSource).toContain('stopWorkspaceDevProject')
    expect(projectListSource).toContain('window.electronAPI.webTabs.create({ url: updated.url, activate: true })')
    expect(projectListSource).toContain('重新打开项目页面')
    expect(projectListSource).toContain('aria-label={`重新打开 ${project.name}`}')
    expect(projectListSource).toContain('启动开发服务')
    expect(projectListSource).toContain('停止开发服务')
  })

  test('Given 项目列表 When 查看项目行 Then 启动按钮右侧提供图钉按钮可直接固定到我的项目', () => {
    expect(projectListSource).not.toContain('ContextMenu')
    expect(projectListSource).toContain('固定到我的项目')
    expect(projectListSource).toContain('取消固定')
    expect(projectListSource).toContain('aria-pressed={pinned}')
    expect(projectListSource).toContain(`固定 \${project.name} 到我的项目`)
    expect(projectListSource).toContain('fill-current')
    expect(projectListSource).toContain('pinnedDevProjects')
    expect(projectListSource).toContain('togglePinnedDevProject')
    expect(projectListSource).toContain('pinnedDevProjectsAtom')
    expect(projectListSource).toContain("title: '我的项目'")
    expect(projectListSource).toContain("title: '工作区'")
    expect(projectListSource).toContain('aria-expanded={!collapsed}')
  })
})
