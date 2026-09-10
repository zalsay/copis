import { beforeEach, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'

const { extOf } = await import('../lib/system-app-command')
const runCmd = mock(async (_bin: string, _args: string[], _opts?: { stdin?: string; timeoutMs?: number }) => ({ status: 0, stdout: '' }))
const saveCache = mock(() => undefined)
const getFileIcon = mock(async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,test' }))
mock.module('../lib/system-app-command', () => ({ runCmd, extOf }))
mock.module('electron', () => ({ app: { getFileIcon } }))
mock.module('../lib/default-app-cache', () => ({
  getCachedDefaultAppInfo: () => undefined,
  saveCachedDefaultAppInfo: saveCache,
}))
const { getWindowsDefaultAppInfo } = await import('../lib/windows-default-app')
const { getDefaultAppInfoForFile } = await import('../lib/system-app-info')

beforeEach(() => {
  runCmd.mockReset()
  runCmd.mockImplementation(async () => ({ status: 0, stdout: '' }))
  getFileIcon.mockClear()
  saveCache.mockClear()
})

test('Given Windows 文件扩展含命令字符 When 查询默认应用 Then 不调用任何系统命令', async () => {
  for (const path of ['file.txt&calc', 'file.txt|calc', 'file.txt>out', 'file.txt<in', 'file']) {
    expect(await getWindowsDefaultAppInfo(path)).toBeNull()
  }
  expect(runCmd).not.toHaveBeenCalled()
})

test('Given 注册表返回非法 ProgId When 查询默认应用 Then 不将该值传给后续命令', async () => {
  runCmd.mockResolvedValue({ status: 0, stdout: '    ProgId    REG_SZ    unsafe&calc' })
  expect(await getWindowsDefaultAppInfo('file.txt')).toBeNull()
  expect(runCmd).toHaveBeenCalledTimes(1)
  expect(runCmd.mock.calls[0]).toEqual(['reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt\\UserChoice',
    '/v', 'ProgId',
  ]])
})

test('Given 合法注册表关联与带空格的 exe 路径 When 查询默认应用 Then 保留完整路径并使用参数数组', async () => {
  runCmd.mockResolvedValueOnce({ status: 0, stdout: '    ProgId    REG_SZ    Editor.Document-1' })
  runCmd.mockResolvedValueOnce({ status: 0, stdout: '    (Default)    REG_SZ    "C:\\Program Files\\My Editor\\editor.exe" "%1"' })
  expect(await getWindowsDefaultAppInfo('file.txt')).toEqual({
    appPath: 'C:\\Program Files\\My Editor\\editor.exe', appName: 'editor',
  })
  expect(runCmd).toHaveBeenCalledTimes(2)
  expect(runCmd.mock.calls[1]).toEqual(['reg', ['query', 'HKCR\\Editor.Document-1\\shell\\open\\command', '/ve']])
})

test('Given macOS 文件路径包含引号及命令字符 When 查询默认应用 Then 仅通过 Swift argv 传递路径', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  try {
    const filePath = '/tmp/quote";$(touch SHOULD_NOT_RUN).ipcplatformtest'
    runCmd.mockResolvedValueOnce({ status: 0, stdout: '/nonexistent/Copis Test Editor.app/\n' })
    expect(await getDefaultAppInfoForFile(filePath)).toEqual({
      name: 'Copis Test Editor', appPath: '/nonexistent/Copis Test Editor.app', iconDataUrl: 'data:image/png;base64,test',
    })
    expect(runCmd).toHaveBeenCalledTimes(1)
    const [bin, args, options] = runCmd.mock.calls[0]!
    expect(bin).toBe('swift')
    expect(args).toEqual(['-', resolve(filePath)])
    expect(options?.stdin).toContain('CommandLine.arguments.dropFirst()')
    expect(options?.stdin).not.toContain(filePath)
    expect(options?.timeoutMs).toBe(6000)
    expect(getFileIcon).toHaveBeenCalledWith('/nonexistent/Copis Test Editor.app', { size: 'large' })
    expect(saveCache).toHaveBeenCalledTimes(1)
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})
