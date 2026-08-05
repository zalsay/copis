[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$appDir = Join-Path $rootDir 'apps\electron'
$outDir = Join-Path $appDir 'out'

if (-not (Test-Path -LiteralPath (Join-Path $rootDir 'package.json') -PathType Leaf)) {
    throw "未找到项目根目录 package.json：$rootDir"
}

$electronPackagePath = Join-Path $appDir 'package.json'
if (-not (Test-Path -LiteralPath $electronPackagePath -PathType Leaf)) {
    throw "未找到 Electron 包 package.json：$electronPackagePath"
}

$electronPackage = Get-Content -LiteralPath $electronPackagePath -Raw | ConvertFrom-Json
$appVersion = [string]$electronPackage.version
if ([string]::IsNullOrWhiteSpace($appVersion)) {
    throw "无法从 Electron 包 package.json 读取版本号：$electronPackagePath"
}

$bunPath = $null
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCommand) {
    $bunPath = $bunCommand.Path
}

if (-not $bunPath) {
    $bunCandidates = @()
    if ($env:BUN_INSTALL) {
        $bunCandidates += Join-Path $env:BUN_INSTALL 'bin\bun.exe'
    }
    if ($env:USERPROFILE) {
        $bunCandidates += Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    }

    $bunPath = $bunCandidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}

if (-not $bunPath) {
    throw '未找到 Bun。请先安装 Bun，并确保 bun.exe 位于 PATH、BUN_INSTALL\bin 或用户目录下的 .bun\bin。'
}

$bunBinDir = Split-Path -Parent $bunPath
$pathSeparator = [System.IO.Path]::PathSeparator
$env:PATH = "$bunBinDir$pathSeparator$env:PATH"

Write-Host "使用 Bun：$bunPath"

if (-not $SkipInstall) {
    Write-Host '正在按 bun.lock 安装依赖...'
    Push-Location $rootDir
    try {
        & $bunPath install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            throw "Bun 依赖安装失败，退出码：$LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host '正在构建 Windows EXE（不编译 Rust HTTP API，不执行 COS 发布）...'
Push-Location $appDir
try {
    & $bunPath run dist:win
    if ($LASTEXITCODE -ne 0) {
        throw "Windows 打包失败，退出码：$LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

$installerPath = Join-Path $outDir ("Copis Setup {0}.exe" -f $appVersion)
$unpackedAppPath = Join-Path $outDir 'win-unpacked\Copis.exe'

if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "打包命令已完成，但未找到当前版本安装程序：$installerPath"
}

$installerInfo = Get-Item -LiteralPath $installerPath
if ($installerInfo.Length -lt 10MB) {
    throw "安装程序体积异常（$($installerInfo.Length) 字节），可能是 NSIS 打包未完成：$installerPath"
}

Write-Host '构建完成，EXE 产物：'
Write-Host "  安装程序：$installerPath"
if (Test-Path -LiteralPath $unpackedAppPath -PathType Leaf) {
    Write-Host "  解压版本（需保留整个 win-unpacked 目录）：$unpackedAppPath"
}
