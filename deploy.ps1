<#
.SYNOPSIS
    构建并发布 Copis 功能模块。

.DESCRIPTION
    默认构建并发布 Node.js runtime、Rust HTTP API 与 OfficeCLI。使用单模块
    参数可以只发布对应的功能模块；多个单模块模式不能同时启用。

.PARAMETER RustOnly
    只发布 Rust HTTP API，并保留 COS 中已有的 OfficeCLI。

.PARAMETER OfficeCliOnly
    只发布 OfficeCLI，并保留 COS 中已有的 Rust HTTP API。
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$LegacyArguments,
    [switch]$SkipInstall,
    [switch]$BuildApp,
    [switch]$SkipRustBuild,
    [switch]$SkipPublish,
    [switch]$RustOnly,
    [switch]$OfficeCliOnly,
    [switch]$NodeRuntimeOnly,
    [ValidateSet('win32', 'darwin', 'linux')]
    [string]$Platform = 'win32',
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64',
    [string]$Channel = 'stable',
    [string]$Version,
    [string]$ClientMinVersion,
    [string]$PublicBaseUrl,
    [string]$ObjectPrefixPath,
    [string]$RustBinary,
    [string]$OfficeCliBinary,
    [string]$OfficeCliVersion,
    [string]$NodeRuntimeArchive,
    [string]$NodeRuntimeVersion
)

$ErrorActionPreference = 'Stop'

foreach ($argument in $LegacyArguments) {
    switch ($argument) {
        '--rust' { $RustOnly = $true }
        '--officecli' { $OfficeCliOnly = $true }
        '--node-runtime' { $NodeRuntimeOnly = $true }
        '--build-app' { $BuildApp = $true }
        '--skip-install' { $SkipInstall = $true }
        '--skip-rust-build' { $SkipRustBuild = $true }
        '--skip-publish' { $SkipPublish = $true }
        default {
            throw "不支持的参数：$argument。PowerShell 参数请使用单横线形式，例如 -RustOnly。"
        }
    }
}

$rootDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$appDir = Join-Path $rootDir 'apps\electron'
$electronPackagePath = Join-Path $appDir 'package.json'
$buildScriptPath = Join-Path $rootDir 'build.ps1'

function Import-DotEnvFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }

    $processEnvironment = [System.Environment]::GetEnvironmentVariables('Process')
    foreach ($line in Get-Content -LiteralPath $Path) {
        $entry = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($entry) -or $entry.StartsWith('#')) {
            continue
        }
        if ($entry.StartsWith('export ')) {
            $entry = $entry.Substring(7).TrimStart()
        }
        if ($entry -notmatch '^(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$') {
            continue
        }

        $key = $Matches['name']
        if ($processEnvironment.ContainsKey($key)) {
            continue
        }

        $value = $Matches['value'].Trim()
        if ($value.Length -ge 2) {
            $quote = $value[0]
            if (($quote -eq '"' -or $quote -eq "'") -and $value[$value.Length - 1] -eq $quote) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }

        [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
        $processEnvironment[$key] = $value
    }
}

Import-DotEnvFile -Path (Join-Path $rootDir '.env')

if ((@($RustOnly, $OfficeCliOnly, $NodeRuntimeOnly) | Where-Object { $_ }).Count -gt 1) {
    throw '-RustOnly、-OfficeCliOnly 与 -NodeRuntimeOnly 不能同时使用。'
}

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


$rustBinaryPath = $null
if (-not $OfficeCliOnly -and -not $NodeRuntimeOnly) {
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
}

$officeCliBinaryPath = $null
$officeCliVersionValue = $null
if (-not $RustOnly -and -not $NodeRuntimeOnly) {
    $defaultOfficeCliBinary = Join-Path $appDir 'resources\bin\officecli'
    if ($Platform -eq 'win32') {
        $defaultOfficeCliBinary = "$defaultOfficeCliBinary.exe"
    }

    $officeCliBinaryInput = if ([string]::IsNullOrWhiteSpace($OfficeCliBinary)) {
        $env:COPIS_OFFICECLI_BINARY
    } else {
        $OfficeCliBinary.Trim()
    }
    $officeCliBinaryPath = if ([string]::IsNullOrWhiteSpace($officeCliBinaryInput)) {
        $defaultOfficeCliBinary
    } elseif ([System.IO.Path]::IsPathRooted($officeCliBinaryInput)) {
        $officeCliBinaryInput
    } else {
        Join-Path $rootDir $officeCliBinaryInput
    }

    if (-not (Test-Path -LiteralPath $officeCliBinaryPath -PathType Leaf)) {
        throw "未找到 OfficeCLI 二进制：$officeCliBinaryPath"
    }
    $officeCliBinaryPath = (Resolve-Path -LiteralPath $officeCliBinaryPath).Path
    $officeCliVersionValue = if ([string]::IsNullOrWhiteSpace($OfficeCliVersion)) {
        if ([string]::IsNullOrWhiteSpace($env:COPIS_OFFICECLI_VERSION)) {
            $releaseVersion
        } else {
            $env:COPIS_OFFICECLI_VERSION.Trim()
        }
    } else {
        $OfficeCliVersion.Trim()
    }
}

$nodeRuntimeArchivePath = $null
$nodeRuntimeVersionValue = $null
if (-not $RustOnly -and -not $OfficeCliOnly) {
    $nodeRuntimeArchiveInput = if ([string]::IsNullOrWhiteSpace($NodeRuntimeArchive)) {
        $env:COPIS_NODE_RUNTIME_ARCHIVE
    } else {
        $NodeRuntimeArchive.Trim()
    }
    $nodeRuntimeArchivePath = if ([string]::IsNullOrWhiteSpace($nodeRuntimeArchiveInput)) {
        Join-Path $appDir "resources\node-runtime\$Platform-$Arch.tar.gz"
    } elseif ([System.IO.Path]::IsPathRooted($nodeRuntimeArchiveInput)) {
        $nodeRuntimeArchiveInput
    } else {
        Join-Path $rootDir $nodeRuntimeArchiveInput
    }
    if (-not (Test-Path -LiteralPath $nodeRuntimeArchivePath -PathType Leaf)) {
        if ($Platform -ne 'win32' -or $Arch -ne 'x64') {
            throw 'Node.js runtime 必须在目标平台和架构构建，跨平台请提供 -NodeRuntimeArchive。'
        }
        Write-Host '正在打包 Node.js runtime 功能模块...'
        Invoke-BunCommand `
            -WorkingDirectory $rootDir `
            -Arguments @('run', 'build:node-runtime-module', '--', '--output', $nodeRuntimeArchivePath) `
            -FailureMessage 'Node.js runtime 模块构建失败'
    }
    $nodeRuntimeArchivePath = (Resolve-Path -LiteralPath $nodeRuntimeArchivePath).Path
    $nodeRuntimeVersionValue = if ([string]::IsNullOrWhiteSpace($NodeRuntimeVersion)) {
        if ([string]::IsNullOrWhiteSpace($env:COPIS_NODE_RUNTIME_VERSION)) {
            $releaseVersion
        } else {
            $env:COPIS_NODE_RUNTIME_VERSION.Trim()
        }
    } else {
        $NodeRuntimeVersion.Trim()
    }
}

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
        '--public-base-url', $resolvedPublicBaseUrl
    )
    if (-not $OfficeCliOnly -and -not $NodeRuntimeOnly) {
        $releaseArguments += @('--rust-binary', $rustBinaryPath)
    }
    if (-not $RustOnly -and -not $NodeRuntimeOnly) {
        $releaseArguments += @(
            '--officecli-binary', $officeCliBinaryPath,
            '--officecli-version', $officeCliVersionValue
        )
    }
    if (-not $RustOnly -and -not $OfficeCliOnly) {
        $releaseArguments += @('--node-runtime-archive', $nodeRuntimeArchivePath, '--node-runtime-version', $nodeRuntimeVersionValue)
    }
    if (-not [string]::IsNullOrWhiteSpace($ObjectPrefixPath)) {
        $releaseArguments += @('--prefix', $ObjectPrefixPath.Trim())
    }
    if ($RustOnly) {
        $releaseArguments += '--rust'
    }
    if ($OfficeCliOnly) {
        $releaseArguments += '--officecli'
    }
    if ($NodeRuntimeOnly) {
        $releaseArguments += '--node-runtime'
    }

    $manifestPath = Join-Path $appDir 'dist\functional-modules\manifest.json'

    Write-Host '正在生成功能模块 manifest...'
    Invoke-BunCommand `
        -WorkingDirectory $rootDir `
        -Arguments (@('run', 'build:functional-module-manifest', '--') + $releaseArguments + @('--output', $manifestPath)) `
        -FailureMessage '功能模块 manifest 构建失败'

    Write-Host '正在发布功能模块二进制与 manifest 到 COS...'
    Invoke-BunCommand `
        -WorkingDirectory $rootDir `
        -Arguments (@('run', 'publish:functional-modules', '--') + $releaseArguments + @('--manifest-output', $manifestPath)) `
        -FailureMessage '功能模块 COS 发布失败'

    Write-Host '功能模块发布完成：'
    if ($rustBinaryPath) {
        Write-Host "  Rust 二进制：$rustBinaryPath"
    }
    if ($officeCliBinaryPath) {
        Write-Host "  OfficeCLI 二进制：$officeCliBinaryPath（版本：$officeCliVersionValue）"
    }
    if ($nodeRuntimeArchivePath) {
        Write-Host "  Node.js runtime：$nodeRuntimeArchivePath（版本：$nodeRuntimeVersionValue）"
    }
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        Write-Host "  Manifest：$manifestPath"
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $platformKey = "$Platform-$Arch"
        $platformProperty = $manifest.platforms.PSObject.Properties[$platformKey]
        if ($null -ne $platformProperty) {
            $versions = @(
                $platformProperty.Value.modules.PSObject.Properties |
                    ForEach-Object { "$($_.Name)=$($_.Value.version)" } |
                    Sort-Object
            )
            if ($versions.Count -gt 0) {
                Write-Host "  实际模块版本：$($versions -join ', ')"
            }
        }
    }
} else {
    Write-Host '已跳过 COS 发布（-SkipPublish）。'
}

Write-Host '部署流程完成。'
