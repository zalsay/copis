[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$BuildApp,
    [switch]$SkipRustBuild,
    [switch]$SkipPublish,
    [ValidateSet('win32', 'darwin', 'linux')]
    [string]$Platform = 'win32',
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64',
    [string]$Channel = 'stable',
    [string]$Version,
    [string]$ClientMinVersion,
    [string]$PublicBaseUrl,
    [string]$ObjectPrefixPath,
    [string]$RustBinary
)

$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$appDir = Join-Path $rootDir 'apps\electron'
$electronPackagePath = Join-Path $appDir 'package.json'
$buildScriptPath = Join-Path $rootDir 'build.ps1'

if (-not (Test-Path -LiteralPath (Join-Path $rootDir 'package.json') -PathType Leaf)) {
    throw "未找到项目根目录 package.json：$rootDir"
}
if (-not (Test-Path -LiteralPath $electronPackagePath -PathType Leaf)) {
    throw "未找到 Electron 包 package.json：$electronPackagePath"
}

$electronPackage = Get-Content -LiteralPath $electronPackagePath -Raw | ConvertFrom-Json
$appVersion = [string]$electronPackage.version
if ([string]::IsNullOrWhiteSpace($appVersion)) {
    throw "无法从 Electron 包 package.json 读取版本号：$electronPackagePath"
}

$releaseVersion = if ([string]::IsNullOrWhiteSpace($Version)) { $appVersion } else { $Version.Trim() }
$minimumClientVersion = if ([string]::IsNullOrWhiteSpace($ClientMinVersion)) {
    $releaseVersion
} else {
    $ClientMinVersion.Trim()
}

if ([string]::IsNullOrWhiteSpace($Channel)) {
    throw '发布 channel 不能为空。'
}

function Resolve-BunPath {
    $command = Get-Command bun -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Path
    }

    $candidates = @()
    if ($env:BUN_INSTALL) {
        $candidates += Join-Path $env:BUN_INSTALL 'bin\bun.exe'
    }
    if ($env:USERPROFILE) {
        $candidates += Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    }

    $resolvedPath = $candidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    return $resolvedPath
}

function Invoke-BunCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    Push-Location $WorkingDirectory
    try {
        & $bunPath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FailureMessage，退出码：$LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

$bunPath = Resolve-BunPath
if (-not $bunPath) {
    throw '未找到 Bun。请先安装 Bun，并确保 bun.exe 位于 PATH、BUN_INSTALL\bin 或用户目录下的 .bun\bin。'
}

$bunBinDir = Split-Path -Parent $bunPath
$pathSeparator = [System.IO.Path]::PathSeparator
$env:PATH = "$bunBinDir$pathSeparator$env:PATH"
Write-Host "使用 Bun：$bunPath"
Write-Host "部署版本：$releaseVersion，模块目标：$Platform/$Arch，channel：$Channel"

if (-not $SkipInstall) {
    Write-Host '正在按 bun.lock 安装依赖...'
    Invoke-BunCommand `
        -WorkingDirectory $rootDir `
        -Arguments @('install', '--frozen-lockfile') `
        -FailureMessage 'Bun 依赖安装失败'
}

$defaultRustBinary = if ($Platform -eq 'win32') {
    Join-Path $rootDir 'native\http-api-server\target\release\copis-http-api-server.exe'
} else {
    Join-Path $rootDir 'native\http-api-server\target\release\copis-http-api-server'
}

if (-not $SkipRustBuild) {
    if ($Platform -ne 'win32' -or $Arch -ne 'x64') {
        throw 'deploy.ps1 默认通过当前 Windows x64 环境编译 Rust API；跨平台产物请使用对应平台 runner，并传入 -SkipRustBuild 与 -RustBinary。'
    }

    Write-Host '正在显式构建 Rust HTTP API 二进制...'
    Invoke-BunCommand `
        -WorkingDirectory $appDir `
        -Arguments @('run', 'build:http-api-server') `
        -FailureMessage 'Rust HTTP API 构建失败'
}

$rustBinaryPath = if ([string]::IsNullOrWhiteSpace($RustBinary)) {
    $defaultRustBinary
} elseif ([System.IO.Path]::IsPathRooted($RustBinary)) {
    $RustBinary
} else {
    Join-Path $rootDir $RustBinary
}

if (-not (Test-Path -LiteralPath $rustBinaryPath -PathType Leaf)) {
    throw "未找到 Rust HTTP API 二进制：$rustBinaryPath"
}
$rustBinaryPath = (Resolve-Path -LiteralPath $rustBinaryPath).Path

if ($BuildApp) {
    Write-Host '正在构建 Electron Windows 应用（默认构建不包含 Rust API 与 COS 发布）...'
    if (-not (Test-Path -LiteralPath $buildScriptPath -PathType Leaf)) {
        throw "未找到应用构建脚本：$buildScriptPath"
    }

    & $buildScriptPath -SkipInstall
    if ($LASTEXITCODE -ne 0) {
        throw "Electron 应用构建失败，退出码：$LASTEXITCODE"
    }
}

if (-not $SkipPublish) {
    $resolvedPublicBaseUrl = if ([string]::IsNullOrWhiteSpace($PublicBaseUrl)) {
        $env:COS_PUBLIC_BASE_URL
    } else {
        $PublicBaseUrl.Trim()
    }
    if ([string]::IsNullOrWhiteSpace($resolvedPublicBaseUrl)) {
        throw '发布功能模块需要 COS_PUBLIC_BASE_URL 或 -PublicBaseUrl。'
    }

    $releaseArguments = @(
        '--platform', $Platform,
        '--arch', $Arch,
        '--channel', $Channel,
        '--version', $releaseVersion,
        '--client-min-version', $minimumClientVersion,
        '--public-base-url', $resolvedPublicBaseUrl,
        '--rust-binary', $rustBinaryPath
    )
    if (-not [string]::IsNullOrWhiteSpace($ObjectPrefixPath)) {
        $releaseArguments += @('--prefix', $ObjectPrefixPath.Trim())
    }

    Write-Host '正在生成功能模块 manifest...'
    Invoke-BunCommand `
        -WorkingDirectory $rootDir `
        -Arguments (@('run', 'build:functional-module-manifest', '--') + $releaseArguments) `
        -FailureMessage '功能模块 manifest 构建失败'

    Write-Host '正在发布功能模块二进制与 manifest 到 COS...'
    Invoke-BunCommand `
        -WorkingDirectory $rootDir `
        -Arguments (@('run', 'publish:functional-modules', '--') + $releaseArguments) `
        -FailureMessage '功能模块 COS 发布失败'

    $manifestPath = Join-Path $appDir 'dist\functional-modules\manifest.json'
    Write-Host '功能模块发布完成：'
    Write-Host "  Rust 二进制：$rustBinaryPath"
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        Write-Host "  Manifest：$manifestPath"
    }
} else {
    Write-Host '已跳过 COS 发布（-SkipPublish）。'
}

Write-Host '部署流程完成。'
