[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [string]$FunctionalModuleManifestUrl,
    [switch]$SkipCosUpload,
    [string]$InstallerFileName,
    [string]$InstallerObjectKey,
    [string]$CosPublicBaseUrl,
    [string]$CosBucketUrl
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

$manifestUrl = ([string]$FunctionalModuleManifestUrl).Trim()
if ([string]::IsNullOrWhiteSpace($manifestUrl)) {
    $manifestUrl = $env:COPIS_FUNCTIONAL_MODULE_MANIFEST_URL
}
if ([string]::IsNullOrWhiteSpace($manifestUrl)) {
    $envPath = Join-Path $rootDir '.env'
    if (Test-Path -LiteralPath $envPath -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $envPath) {
            if ($line -match '^\s*(?:export\s+)?COPIS_FUNCTIONAL_MODULE_MANIFEST_URL\s*=\s*(?<value>.*)\s*$') {
                $manifestUrl = $Matches['value'].Trim()
                if ($manifestUrl.Length -ge 2) {
                    $quote = $manifestUrl[0]
                    if (($quote -eq '"' -or $quote -eq "'") -and $manifestUrl[$manifestUrl.Length - 1] -eq $quote) {
                        $manifestUrl = $manifestUrl.Substring(1, $manifestUrl.Length - 2)
                    }
                }
                break
            }
        }
    }
}
if ([string]::IsNullOrWhiteSpace($manifestUrl)) {
    throw '功能模块 manifest 地址未配置。请提供 -FunctionalModuleManifestUrl 或 COPIS_FUNCTIONAL_MODULE_MANIFEST_URL。'
}
$env:COPIS_FUNCTIONAL_MODULE_MANIFEST_URL = $manifestUrl.Trim()

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
Write-Host '已配置功能模块 manifest 地址。'

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

$installerFileNameValue = if ([string]::IsNullOrWhiteSpace($InstallerFileName)) {
    'Copis-Setup.exe'
} else {
    $InstallerFileName.Trim()
}
if ([string]::IsNullOrWhiteSpace($installerFileNameValue) -or $installerFileNameValue -match '[\\/:]' -or -not $installerFileNameValue.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "固定安装程序文件名不合法：$installerFileNameValue"
}

$fixedInstallerPath = Join-Path $outDir $installerFileNameValue
if (-not [string]::Equals(
        [System.IO.Path]::GetFullPath($installerPath),
        [System.IO.Path]::GetFullPath($fixedInstallerPath),
        [System.StringComparison]::OrdinalIgnoreCase)) {
    Move-Item -LiteralPath $installerPath -Destination $fixedInstallerPath -Force
}

$installerObjectKeyValue = if (-not [string]::IsNullOrWhiteSpace($InstallerObjectKey)) {
    $InstallerObjectKey.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($env:COPIS_WINDOWS_INSTALLER_OBJECT_KEY)) {
    $env:COPIS_WINDOWS_INSTALLER_OBJECT_KEY.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($InstallerFileName)) {
    "copis/downloads/stable/win32-x64/$installerFileNameValue"
} else {
    $null
}

Write-Host '构建完成，EXE 产物：'
Write-Host "  安装程序：$fixedInstallerPath"
if (Test-Path -LiteralPath $unpackedAppPath -PathType Leaf) {
    Write-Host "  解压版本（需保留整个 win-unpacked 目录）：$unpackedAppPath"
}

if ($SkipCosUpload) {
    Write-Host '已跳过固定安装程序 COS 上传（-SkipCosUpload）。'
} else {
    Write-Host '正在上传固定文件名安装程序到 COS...'
    $uploadArguments = @(
        'run',
        'publish:windows-installer',
        '--',
        '--file',
        $fixedInstallerPath,
        '--version',
        $appVersion
    )
    if (-not [string]::IsNullOrWhiteSpace($installerObjectKeyValue)) {
        $uploadArguments += @('--object-key', $installerObjectKeyValue)
    }
    if (-not [string]::IsNullOrWhiteSpace($CosPublicBaseUrl)) {
        $uploadArguments += @('--public-base-url', $CosPublicBaseUrl.Trim())
    }
    if (-not [string]::IsNullOrWhiteSpace($CosBucketUrl)) {
        $uploadArguments += @('--bucket-url', $CosBucketUrl.Trim())
    }

    Push-Location $rootDir
    try {
        & $bunPath @uploadArguments
        if ($LASTEXITCODE -ne 0) {
            throw "Windows 安装程序 COS 上传失败，退出码：$LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}
