import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sidePanelSource = readFileSync(join(import.meta.dir, 'SidePanel.tsx'), 'utf8')
const projectListSource = readFileSync(join(import.meta.dir, 'WorkspaceDevProjects.tsx'), 'utf8')

describe('项目开发列表契约', () => {
  test('Given 右侧文件区 When 用户查看第一个标签 Then 展示项目列表与启动控制', () => {
    expect(sidePanelSource).toContain('>\n                  项目列表\n                </button>')
    expect(sidePanelSource).toContain('<WorkspaceDevProjects workspaceSlug={workspaceSlug} />')
    expect(sidePanelSource).toContain('项目文件')
    expect(projectListSource).toContain('startWorkspaceDevProject')
    expect(projectListSource).toContain('stopWorkspaceDevProject')
    expect(projectListSource).toContain('启动开发服务')
    expect(projectListSource).toContain('停止开发服务')
  })
})
