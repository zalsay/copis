import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { ChromeDesktopHelperClient } from './chrome-desktop-helper-client'

function appleScript(script: string): string {
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 5000 }).trim()
}

const frontPid = () => Number(appleScript('tell application "System Events" to get unix id of first application process whose frontmost is true'))
const bringForward = (pid: number) => appleScript(`tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`)

async function waitForFront(pid: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (frontPid() !== pid) {
    if (Date.now() >= deadline) throw new Error('系统前台应用未切换到测试目标')
    await Bun.sleep(50)
  }
}

// 仅显式执行时切换真实应用前台；常规测试不碰用户桌面，不采集画面或投递输入事件。
test.skipIf(process.platform !== 'darwin' || process.env.COPIS_CHROME_FOCUS_SMOKE !== '1')(
  'Given 常驻 helper 在 Copis 前台已核对焦点 When 激活授权 Chrome Then 状态更新且再次切走会拒绝',
  async () => {
    const helper = new ChromeDesktopHelperClient()
    const originalPid = frontPid()
    const copisPid = Number(appleScript('tell application "System Events" to get unix id of process "Copis"'))
    try {
      const target = (await helper.listWindows()).find((window) => window.title === 'Example Domain')
      if (!target) throw new Error('请先打开用于本次测试的 Example Domain Chrome 窗口')
      bringForward(copisPid)
      await waitForFront(copisPid)
      expect((await helper.checkTarget(target.windowId, target.pid)).ok).toBe(false)

      // 使用同一 helper 进程，不能通过换进程掩盖前台状态缓存问题。
      const activated = await helper.activateWindow(target.windowId, target.pid)
      expect(activated).toMatchObject({ ok: true })
      await waitForFront(target.pid)
      expect(await helper.checkTarget(target.windowId, target.pid)).toMatchObject({ ok: true })

      bringForward(copisPid)
      await waitForFront(copisPid)
      expect(await helper.checkTarget(target.windowId, target.pid)).toMatchObject({ ok: false })
    } finally {
      helper.stop()
      bringForward(originalPid)
    }
  },
  15000,
)
