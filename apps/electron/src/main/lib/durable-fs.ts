import { execFileSync } from 'node:child_process'
import { closeSync, constants, fsyncSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

const WINDOWS_FLUSH_DIRECTORY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CopisSnapshotFlush {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$handle = [CopisSnapshotFlush]::CreateFile($args[0], 0x80000000, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($handle.ToInt64() -eq -1) { throw 'CreateFile failed' }
try {
  if (![CopisSnapshotFlush]::FlushFileBuffers($handle)) { throw 'FlushFileBuffers failed' }
} finally {
  [CopisSnapshotFlush]::CloseHandle($handle) | Out-Null
}
`

/** 对受控目录执行持久化 flush；Windows 使用带参数的 PowerShell P/Invoke。 */
export function syncDirectoryDurable(path: string): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_FLUSH_DIRECTORY_SCRIPT,
        path,
      ], { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      throw new Error('受控目录 Windows flush 失败', { cause: error })
    }
    return
  }

  let fd = -1
  try {
    fd = openSync(path, constants.O_RDONLY)
    fsyncSync(fd)
  } catch (error) {
    throw new Error('受控目录持久化失败', { cause: error })
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

export function syncParentDurable(path: string): void {
  syncDirectoryDurable(dirname(path))
}
