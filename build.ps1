[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$LegacyArguments,
    [Alias('New')]
    [switch]$NewVersion,
    [switch]$SkipInstall,
    [string]$FunctionalModuleManifestUrl,
    [switch]$SkipCosUpload,
    [string]$InstallerFileName,
    [string]$InstallerObjectKey,
    [string]$CosPublicBaseUrl,
    [string]$CosBucketUrl,
    [Alias('Help', 'h')]
    [switch]$ShowHelp
)

$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$appDir = Join-Path $rootDir 'apps\electron'
$outDir = Join-Path $appDir 'out'

function Show-BuildHelp {
    @'
Copis Windows 构建脚本

用法：
  powershell -ExecutionPolicy Bypass -File .\build.ps1 [选项]

选项：
  -NewVersion, -New, --new
      当前版本已满足 win32-x64 最低版本时，递增 patch 版本；低于该门槛时自动对齐。
  -SkipInstall
      跳过 bun install --frozen-lockfile。
  -FunctionalModuleManifestUrl <url>
      指定功能模块 manifest 地址，覆盖 COPIS_FUNCTIONAL_MODULE_MANIFEST_URL。
  -SkipCosUpload, --skip-cos-upload
      只构建 EXE，不上传固定安装包或更新客户端 manifest。
  -InstallerFileName <name>
      指定固定 EXE 文件名，默认 Copis-Setup.exe。
  -InstallerObjectKey <key>
      指定固定安装包的 COS 对象 key。
  -CosPublicBaseUrl <url>
      覆盖 COS_PUBLIC_BASE_URL。
  -CosBucketUrl <url>
      覆盖 COS_BUCKET_URL。
  -ShowHelp, -Help, -h, --help
      显示本帮助并退出。
'@ | Write-Output
}

foreach ($argument in $LegacyArguments) {
    switch ($argument) {
        '--new' { $NewVersion = $true }
        '--skip-cos-upload' { $SkipCosUpload = $true }
        '-h' { $ShowHelp = $true }
        '--help' { $ShowHelp = $true }
        default { throw "未知参数：$argument；请使用 --help 查看可用参数。" }
    }
}

if ($ShowHelp) {
    Show-BuildHelp
    exit 0
}

function Import-DotEnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $processEnvironment = [System.Environment]::GetEnvironmentVariables('Process')
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $entry = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($entry) -or $entry.StartsWith('#')) { continue }
        $entry = $entry -replace '^export\s+', ''
        if ($entry -notmatch '^(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$') { continue }

        $key = $Matches['name']
        if ($processEnvironment.ContainsKey($key)) { continue }
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

function Set-FromEnvironment {
    param([string]$Current, [string]$Name)

    if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current.Trim() }
    $environmentValue = [System.Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) { return $environmentValue.Trim() }
    return ''
}

Import-DotEnvFile -Path (Join-Path $rootDir '.env')
if ($env:COPIS_SKIP_COS_UPLOAD -eq '1') { $SkipCosUpload = $true }
$CosPublicBaseUrl = Set-FromEnvironment $CosPublicBaseUrl 'COS_PUBLIC_BASE_URL'
$CosBucketUrl = Set-FromEnvironment $CosBucketUrl 'COS_BUCKET_URL'
$InstallerObjectKey = Set-FromEnvironment $InstallerObjectKey 'COPIS_WINDOWS_INSTALLER_OBJECT_KEY'

if (-not (Test-Path -LiteralPath (Join-Path $rootDir 'package.json') -PathType Leaf)) {
    throw "未找到项目根目录 package.json：$rootDir"
}

$electronPackagePath = Join-Path $appDir 'package.json'
if (-not (Test-Path -LiteralPath $electronPackagePath -PathType Leaf)) {
    throw "未找到 Electron 包 package.json：$electronPackagePath"
}

$manifestUrl = Set-FromEnvironment $FunctionalModuleManifestUrl 'COPIS_FUNCTIONAL_MODULE_MANIFEST_URL'
if (-not [string]::IsNullOrWhiteSpace($manifestUrl)) {
    $env:COPIS_FUNCTIONAL_MODULE_MANIFEST_URL = $manifestUrl
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

$electronPackage = Get-Content -LiteralPath $electronPackagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$appVersion = [string]$electronPackage.version
if ([string]::IsNullOrWhiteSpace($appVersion)) {
    throw "无法从 Electron 包 package.json 读取版本号：$electronPackagePath"
}

function Compare-ClientVersions {
    param([Parameter(Mandatory = $true)][string]$Left, [Parameter(Mandatory = $true)][string]$Right)

    $leftParts = (($Left.Trim() -split '-', 2)[0] -split '\.') | ForEach-Object { [int64]$_ }
    $rightParts = (($Right.Trim() -split '-', 2)[0] -split '\.') | ForEach-Object { [int64]$_ }
    $partCount = [Math]::Max($leftParts.Count, $rightParts.Count)
    for ($index = 0; $index -lt $partCount; $index++) {
        $leftValue = if ($index -lt $leftParts.Count) { $leftParts[$index] } else { 0 }
        $rightValue = if ($index -lt $rightParts.Count) { $rightParts[$index] } else { 0 }
        if ($leftValue -lt $rightValue) { return -1 }
        if ($leftValue -gt $rightValue) { return 1 }
    }
    return 0
}

$targetPlatform = 'win32'
$targetArch = 'x64'
$platformMinVersion = ''
if (-not [string]::IsNullOrWhiteSpace($manifestUrl)) {
    $minVersionScriptPath = Join-Path $rootDir 'scripts\query-functional-module-min-version.ts'
    $platformMinVersion = (& $bunPath $minVersionScriptPath '--url' $manifestUrl '--platform' $targetPlatform '--arch' $targetArch | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "无法查询 $targetPlatform-$targetArch 的功能模块最低客户端版本，退出码：$LASTEXITCODE"
    }
    if ([string]::IsNullOrWhiteSpace($platformMinVersion)) {
        Write-Host "${targetPlatform}-${targetArch} manifest 未声明最低客户端版本。"
    } else {
        Write-Host "${targetPlatform}-${targetArch} 功能模块最低客户端版本：$platformMinVersion"
    }
} else {
    Write-Host '未配置功能模块 manifest 地址，跳过最低客户端版本检查。'
}

$versionAlignedToMin = $false
if (-not [string]::IsNullOrWhiteSpace($platformMinVersion) -and (Compare-ClientVersions $appVersion $platformMinVersion) -lt 0) {
    $versionScriptPath = Join-Path $rootDir 'scripts\bump-electron-version.ts'
    $appVersion = (& $bunPath $versionScriptPath '--set' $platformMinVersion | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($appVersion)) {
        throw "Electron 应用版本对齐失败，退出码：$LASTEXITCODE"
    }
    $versionAlignedToMin = $true
    Write-Host "Electron 应用版本已对齐 ${targetPlatform}-${targetArch} 最低版本：$appVersion"
}

if ($NewVersion -and -not $versionAlignedToMin) {
    $versionScriptPath = Join-Path $rootDir 'scripts\bump-electron-version.ts'
    $appVersion = (& $bunPath $versionScriptPath '--new' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($appVersion)) {
        throw "Electron 应用版本更新失败，退出码：$LASTEXITCODE"
    }
    Write-Host "Electron 应用版本已更新为：$appVersion"
}

Write-Host "使用 Bun：$bunPath"
if ([string]::IsNullOrWhiteSpace($manifestUrl)) {
    Write-Host '未指定功能模块 manifest 地址，将使用应用内默认地址。'
} else {
    Write-Host '已配置功能模块 manifest 地址。'
}

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

Write-Host '正在构建 Windows EXE（不编译 Rust HTTP API；安装程序 COS 上传可通过 -SkipCosUpload 跳过）...'
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
    'copis/downloads/stable/win32-x64/Copis-Setup.exe'
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

        $clientUpdateArguments = @(
            'run',
            'publish:client-update',
            '--',
            '--file',
            $fixedInstallerPath,
            '--object-key',
            $installerObjectKeyValue,
            '--platform',
            'win32',
            '--arch',
            'x64',
            '--version',
            $appVersion
        )
        if (-not [string]::IsNullOrWhiteSpace($CosPublicBaseUrl)) {
            $clientUpdateArguments += @('--public-base-url', $CosPublicBaseUrl.Trim())
        }
        if (-not [string]::IsNullOrWhiteSpace($CosBucketUrl)) {
            $clientUpdateArguments += @('--bucket-url', $CosBucketUrl.Trim())
        }
        Write-Host '正在更新客户端自动更新 manifest...'
        & $bunPath @clientUpdateArguments
        if ($LASTEXITCODE -ne 0) {
            throw "客户端自动更新 manifest 发布失败，退出码：$LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}
