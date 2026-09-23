import { execFileSync } from 'node:child_process'
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs'
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

const WINDOWS_FLUSH_TREE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CopisSnapshotFlushTree {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
function Flush-One([string]$path) {
  $handle = [CopisSnapshotFlushTree]::CreateFile($path, 0x80000000, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
  if ($handle.ToInt64() -eq -1) { throw 'CreateFile failed' }
  try {
    if (![CopisSnapshotFlushTree]::FlushFileBuffers($handle)) { throw 'FlushFileBuffers failed' }
  } finally {
    [CopisSnapshotFlushTree]::CloseHandle($handle) | Out-Null
  }
}
Flush-One $args[0]
Get-ChildItem -LiteralPath $args[0] -Force -Recurse -Directory | ForEach-Object { Flush-One $_.FullName }
`

const WINDOWS_SID_SCRIPT = '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'

export function buildWindowsAclArguments(path: string, sid: string, writable: boolean): string[] {
  const rights = writable ? '(OI)(CI)M' : '(OI)(CI)RX'
  return [
    path,
    '/inheritance:r',
    '/remove:g', '*S-1-1-0',
    '/remove:g', '*S-1-5-32-545',
    '/grant:r', `${sid}:${rights}`,
    '/T', '/C',
  ]
}

export function buildWindowsFlushArguments(path: string, tree = false): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    tree ? WINDOWS_FLUSH_TREE_SCRIPT : WINDOWS_FLUSH_DIRECTORY_SCRIPT,
    path,
  ]
}

function readWindowsUserSid(): string {
  let value: string
  try {
    value = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SID_SCRIPT,
    ], { encoding: 'utf8', windowsHide: true }).trim()
  } catch (error) {
    throw new Error('Windows 用户 SID 无法验证', { cause: error })
  }
  if (!/^S-1-(?:[0-9]+-){1,14}[0-9]+$/.test(value)) {
    throw new Error('Windows 用户 SID 无法验证')
  }
  return value
}

/** 对已完整校验的快照树一次性设置 ACL，避免每个节点启动 icacls。 */
export function setWindowsSnapshotAcl(path: string, writable: boolean): void {
  const sid = readWindowsUserSid()
  try {
    execFileSync('icacls', buildWindowsAclArguments(path, sid, writable), {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    throw new Error('Skill 快照 Windows ACL 设置失败', { cause: error })
  }
}

/** 一次 PowerShell 进程刷新目录树，供快照事务结束时批量持久化。 */
export function syncDirectoryTreeDurable(path: string): void {
  if (process.platform !== 'win32') {
    syncDirectoryDurable(path)
    return
  }
  try {
    execFileSync('powershell.exe', buildWindowsFlushArguments(path, true), {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    throw new Error('受控目录树 Windows flush 失败', { cause: error })
  }
}

/** 在文件描述符上写完全部字节；任何非正数写入都 fail closed。 */
export function writeAllSync(fd: number, bytes: Uint8Array, label = '文件'): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset)
    if (count <= 0) throw new Error(`${label}写入失败`)
    offset += count
  }
}

/** 对受控目录执行持久化 flush；Windows 使用带参数的 PowerShell P/Invoke。 */
export function syncDirectoryDurable(path: string): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('powershell.exe', buildWindowsFlushArguments(path), { stdio: 'ignore', windowsHide: true })
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
