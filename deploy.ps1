<#
.SYNOPSIS
    Build and publish Copis functional modules.

.DESCRIPTION
    Builds Rust HTTP API, OfficeCLI, Node.js runtime, and Alipay Bot CLI modules for the target
    platform, then generates and publishes their manifest. Use -BuildApp to
    additionally build the Electron application.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$LegacyArguments,
    [switch]$SkipInstall,
    [switch]$BuildApp,
    [switch]$SkipRustBuild,
    [switch]$SkipPublish,
    [Alias('rust')]
    [switch]$RustOnly,
    [Alias('officecli')]
    [switch]$OfficeCliOnly,
    [Alias('node-runtime')]
    [switch]$NodeRuntimeOnly,
    [Alias('alipay-bot')]
    [switch]$AlipayBotOnly,
    [Alias('playwright-core')]
    [switch]$PlaywrightCoreOnly,
    [Alias('python-runtime')]
    [switch]$PythonRuntimeOnly,
    [ValidateSet('win32', 'darwin', 'linux')]
    [string]$Platform,
    [ValidateSet('x64', 'arm64')]
    [string]$Arch,
    [string]$Channel,
    [string]$Version,
    [string]$ClientMinVersion,
    [string]$PublicBaseUrl,
    [string]$ObjectPrefixPath,
    [string]$RustBinary,
    [string]$OfficeCliBinary,
    [string]$OfficeCliVersion,
    [string]$NodeRuntimeArchive,
    [string]$NodeRuntimeVersion,
    [string]$AlipayBotArchive,
    [string]$AlipayBotVersion,
    [string]$PlaywrightCoreArchive,
    [string]$PlaywrightCoreVersion,
    [string]$PythonRuntimeArchive,
    [string]$PythonRuntimeVersion
)

$ErrorActionPreference = 'Stop'
$rootDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$appDir = Join-Path $rootDir 'apps\electron'

function Import-DotEnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $processEnvironment = [System.Environment]::GetEnvironmentVariables('Process')
    foreach ($line in Get-Content -LiteralPath $Path) {
        $entry = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($entry) -or $entry.StartsWith('#')) { continue }
        if ($entry.StartsWith('export ')) { $entry = $entry.Substring(7).TrimStart() }
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
    param([string]$Current, [string]$Name, [string]$Fallback = '')

    if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current.Trim() }
    $environmentValue = [System.Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) { return $environmentValue.Trim() }
    return $Fallback
}

function Get-LegacyValue {
    param([string[]]$Arguments, [int]$Index, [string]$Option)

    if ($Index + 1 -ge $Arguments.Count -or [string]::IsNullOrWhiteSpace($Arguments[$Index + 1])) {
        throw "$Option requires a value."
    }
    return $Arguments[$Index + 1]
}

Import-DotEnvFile -Path (Join-Path $rootDir '.env')

if ($env:COPIS_RUST_ONLY -eq '1') { $RustOnly = $true }
if ($env:COPIS_OFFICECLI_ONLY -eq '1') { $OfficeCliOnly = $true }
if ($env:COPIS_NODE_RUNTIME_ONLY -eq '1') { $NodeRuntimeOnly = $true }
if ($env:COPIS_ALIPAY_BOT_ONLY -eq '1') { $AlipayBotOnly = $true }
if ($env:COPIS_PLAYWRIGHT_CORE_ONLY -eq '1') { $PlaywrightCoreOnly = $true }
if ($env:COPIS_PYTHON_RUNTIME_ONLY -eq '1') { $PythonRuntimeOnly = $true }

for ($index = 0; $index -lt $LegacyArguments.Count; $index++) {
    $argument = $LegacyArguments[$index]
    switch ($argument) {
        '--rust' { $RustOnly = $true }
        '--officecli' { $OfficeCliOnly = $true }
        '--node-runtime' { $NodeRuntimeOnly = $true }
        '--alipay-bot' { $AlipayBotOnly = $true }
        '--playwright-core' { $PlaywrightCoreOnly = $true }
        '--python-runtime' { $PythonRuntimeOnly = $true }
        '--build-app' { $BuildApp = $true }
        '--skip-install' { $SkipInstall = $true }
        '--skip-rust-build' { $SkipRustBuild = $true }
        '--skip-publish' { $SkipPublish = $true }
        '--platform' { $Platform = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--arch' { $Arch = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--channel' { $Channel = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--version' { $Version = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--client-min-version' { $ClientMinVersion = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--public-base-url' { $PublicBaseUrl = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--prefix' { $ObjectPrefixPath = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--rust-binary' { $RustBinary = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--officecli-binary' { $OfficeCliBinary = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--officecli-version' { $OfficeCliVersion = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--node-runtime-archive' { $NodeRuntimeArchive = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--node-runtime-version' { $NodeRuntimeVersion = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--alipay-bot-archive' { $AlipayBotArchive = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--alipay-bot-version' { $AlipayBotVersion = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--playwright-core-archive' { $PlaywrightCoreArchive = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--playwright-core-version' { $PlaywrightCoreVersion = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--python-runtime-archive' { $PythonRuntimeArchive = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        '--python-runtime-version' { $PythonRuntimeVersion = Get-LegacyValue $LegacyArguments $index $argument; $index++ }
        default { throw "Unsupported argument: $argument. Use PowerShell parameters such as -RustOnly." }
    }
}

if ((@($RustOnly, $OfficeCliOnly, $NodeRuntimeOnly, $AlipayBotOnly, $PlaywrightCoreOnly, $PythonRuntimeOnly) | Where-Object { $_ }).Count -gt 1) {
    throw '-RustOnly, -OfficeCliOnly, -NodeRuntimeOnly, -AlipayBotOnly, -PlaywrightCoreOnly, and -PythonRuntimeOnly cannot be used together.'
}
if (-not (Test-Path -LiteralPath (Join-Path $rootDir 'package.json') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $appDir 'package.json') -PathType Leaf)) {
    throw "Incomplete project package metadata: $rootDir"
}

$currentPlatform = 'win32'
$nativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$currentArch = if ($nativeArchitecture -eq 'ARM64') { 'arm64' } else { 'x64' }
$Platform = Set-FromEnvironment $Platform 'COPIS_MODULE_PLATFORM' $currentPlatform
$Arch = Set-FromEnvironment $Arch 'COPIS_MODULE_ARCH' $currentArch
$Channel = Set-FromEnvironment $Channel 'COPIS_MODULE_CHANNEL' 'stable'
$Version = Set-FromEnvironment $Version 'COPIS_MODULE_VERSION'
$ClientMinVersion = Set-FromEnvironment $ClientMinVersion 'COPIS_MODULE_CLIENT_MIN_VERSION'
$publicBaseUrlFromEnvironment = $env:COS_PUBLIC_BASE_URL
$PublicBaseUrl = Set-FromEnvironment $PublicBaseUrl 'COS_PUBLIC_BASE_URL' $publicBaseUrlFromEnvironment
$ObjectPrefixPath = Set-FromEnvironment $ObjectPrefixPath 'OBJECT_PREFIX_PATH'
$RustBinary = Set-FromEnvironment $RustBinary 'COPIS_RUST_HTTP_API_BINARY'
$OfficeCliBinary = Set-FromEnvironment $OfficeCliBinary 'COPIS_OFFICECLI_BINARY'
$OfficeCliVersion = Set-FromEnvironment $OfficeCliVersion 'COPIS_OFFICECLI_VERSION'
$NodeRuntimeArchive = Set-FromEnvironment $NodeRuntimeArchive 'COPIS_NODE_RUNTIME_ARCHIVE'
$NodeRuntimeVersion = Set-FromEnvironment $NodeRuntimeVersion 'COPIS_NODE_RUNTIME_VERSION'
$AlipayBotArchive = Set-FromEnvironment $AlipayBotArchive 'COPIS_ALIPAY_BOT_ARCHIVE'
$AlipayBotVersion = Set-FromEnvironment $AlipayBotVersion 'COPIS_ALIPAY_BOT_VERSION'
$PlaywrightCoreArchive = Set-FromEnvironment $PlaywrightCoreArchive 'COPIS_PLAYWRIGHT_CORE_ARCHIVE'
$PlaywrightCoreVersion = Set-FromEnvironment $PlaywrightCoreVersion 'COPIS_PLAYWRIGHT_CORE_VERSION'
$PythonRuntimeArchive = Set-FromEnvironment $PythonRuntimeArchive 'COPIS_PYTHON_RUNTIME_ARCHIVE'
$PythonRuntimeVersion = Set-FromEnvironment $PythonRuntimeVersion 'COPIS_PYTHON_RUNTIME_VERSION'
$nodeRuntimeSource = [System.Environment]::GetEnvironmentVariable('COPIS_NODE_RUNTIME_SOURCE', 'Process')

if ($Platform -notin @('win32', 'darwin', 'linux')) { throw "Unsupported functional module platform: $Platform" }
if ($Arch -notin @('x64', 'arm64')) { throw "Unsupported functional module architecture: $Arch" }
if ([string]::IsNullOrWhiteSpace($Channel)) { throw 'Release channel cannot be empty.' }

$electronPackagePath = Join-Path $appDir 'package.json'
$electronPackage = Get-Content -LiteralPath $electronPackagePath -Raw | ConvertFrom-Json
$appVersion = [string]$electronPackage.version
if ([string]::IsNullOrWhiteSpace($appVersion)) { throw "Cannot read Electron version: $electronPackagePath" }
$releaseVersion = if ([string]::IsNullOrWhiteSpace($Version)) { $appVersion } else { $Version.Trim() }
$minimumClientVersion = if ([string]::IsNullOrWhiteSpace($ClientMinVersion)) { $releaseVersion } else { $ClientMinVersion.Trim() }

function Resolve-BunPath {
    $command = Get-Command bun -ErrorAction SilentlyContinue
    if ($command) { return $command.Path }

    $candidates = @()
    if ($env:BUN_INSTALL) { $candidates += Join-Path $env:BUN_INSTALL 'bin\bun.exe' }
    if ($env:USERPROFILE) { $candidates += Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
    return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Invoke-BunCommand {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    Push-Location $WorkingDirectory
    try {
        & $bunPath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit code: $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

function Resolve-PathFromRoot {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return Join-Path $rootDir $Path
}

function Resolve-FunctionalModuleManifestUrl {
    param(
        [string]$BaseUrl,
        [string]$Prefix,
        [Parameter(Mandatory = $true)][string]$Channel
    )

    if ([string]::IsNullOrWhiteSpace($BaseUrl)) { return $null }
    $normalizedPrefix = if ([string]::IsNullOrWhiteSpace($Prefix)) { 'copis/modules' } else { $Prefix.Trim('/') }
    return "$($BaseUrl.TrimEnd('/'))/$normalizedPrefix/$Channel/manifest.json"
}

function Get-NodePathFromRoot {
    param([Parameter(Mandatory = $true)][string]$Root)

    foreach ($candidate in @((Join-Path $Root 'bin\node.exe'), (Join-Path $Root 'node.exe'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "Node.js runtime source has no node.exe: $Root"
}

function Test-Node24 {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $nodeVersion = (& $Path '--version' 2>$null).Trim()
    } catch {
        return $false
    }
    return $nodeVersion -match '^v?24\.'
}

function Resolve-NodeRuntimeSource {
    if (-not [string]::IsNullOrWhiteSpace($nodeRuntimeSource)) {
        $configuredRoot = Resolve-PathFromRoot $nodeRuntimeSource.Trim()
        $configuredNode = Get-NodePathFromRoot $configuredRoot
        if (-not (Test-Node24 $configuredNode)) { throw "Node.js runtime must use Node.js 24: $configuredRoot" }
        return $configuredRoot
    }

    $systemNode = try { (& node '-p' 'process.execPath' 2>$null).Trim() } catch { '' }
    if ($systemNode -and (Test-Node24 $systemNode)) { return Split-Path -Parent $systemNode }

    $candidates = @()
    if ($env:NVM_HOME) {
        $candidates += Get-ChildItem -LiteralPath $env:NVM_HOME -Directory -ErrorAction SilentlyContinue |
            Where-Object Name -like 'v24.*' | ForEach-Object FullName
    }
    if ($env:NVM_SYMLINK) { $candidates += $env:NVM_SYMLINK }
    $candidates += 'C:\Program Files\nodejs'
    foreach ($candidate in $candidates) {
        if (Test-Node24 (Join-Path $candidate 'node.exe')) { return $candidate }
    }
    throw 'Node.js 24 runtime was not found. Install Node.js 24 or set COPIS_NODE_RUNTIME_SOURCE.'
}

function Read-NodeRuntimeVersion {
    param([Parameter(Mandatory = $true)][string]$Source)

    $nodePath = Get-NodePathFromRoot $Source
    if (-not (Test-Node24 $nodePath)) { throw "Node.js runtime source is not Node.js 24: $Source" }
    return ((& $nodePath '--version').Trim() -replace '^v', '')
}

function Read-OfficeCliVersion {
    param([Parameter(Mandatory = $true)][string]$Binary)

    $output = try { (& $Binary '--version' 2>$null | Out-String).Trim() } catch { '' }
    $match = [regex]::Match($output, '\b\d+\.\d+\.\d+\b')
    if (-not $match.Success) { throw "Cannot read OfficeCLI version: $Binary" }
    return $match.Value
}

$bunPath = Resolve-BunPath
if (-not $bunPath) { throw 'Bun was not found in PATH, BUN_INSTALL, or the current user profile.' }
$env:PATH = "$(Split-Path -Parent $bunPath)$([System.IO.Path]::PathSeparator)$env:PATH"
Write-Host "Using Bun: $bunPath"
Write-Host "Release version: $releaseVersion; target: $Platform/$Arch; channel: $Channel"

if (-not $SkipInstall) {
    Write-Host 'Installing dependencies from bun.lock...'
    Invoke-BunCommand $rootDir @('install', '--frozen-lockfile') 'Bun dependency installation failed'
}

$rustBinaryPath = $null
if (-not $OfficeCliOnly -and -not $NodeRuntimeOnly -and -not $AlipayBotOnly -and -not $PlaywrightCoreOnly -and -not $PythonRuntimeOnly) {
    $rustFileName = if ($Platform -eq 'win32') { 'copis-http-api-server.exe' } else { 'copis-http-api-server' }
    $defaultRustBinary = Join-Path $rootDir "native\http-api-server\target\release\$rustFileName"
    if (-not $SkipRustBuild) {
        if ($Platform -ne $currentPlatform -or $Arch -ne $currentArch) {
            throw 'Rust API can only be built for the current platform and architecture. Use -SkipRustBuild with -RustBinary for cross-platform artifacts.'
        }
        Write-Host 'Building Rust HTTP API binary...'
        Invoke-BunCommand $appDir @('run', 'build:http-api-server') 'Rust HTTP API build failed'
    }

    $rustInput = if ([string]::IsNullOrWhiteSpace($RustBinary)) { $defaultRustBinary } else { $RustBinary }
    $rustBinaryPath = Resolve-PathFromRoot $rustInput
    if (-not (Test-Path -LiteralPath $rustBinaryPath -PathType Leaf)) { throw "Rust HTTP API binary was not found: $rustBinaryPath" }
    $rustBinaryPath = (Resolve-Path -LiteralPath $rustBinaryPath).Path
}

$officeCliBinaryPath = $null
$officeCliVersionValue = $null
if (-not $RustOnly -and -not $NodeRuntimeOnly -and -not $AlipayBotOnly -and -not $PlaywrightCoreOnly -and -not $PythonRuntimeOnly) {
    $officeCliBinaryPath = Resolve-PathFromRoot $OfficeCliBinary
    $officeCliFileName = if ($Platform -eq 'win32') { 'officecli.exe' } else { 'officecli' }
    if (-not $officeCliBinaryPath) { $officeCliBinaryPath = Join-Path $appDir "resources\bin\$officeCliFileName" }
    if (-not (Test-Path -LiteralPath $officeCliBinaryPath -PathType Leaf)) {
        Write-Host 'Checking the OfficeCLI functional module version from COS...'
        $prepareArguments = @('run', 'prepare:officecli-module', '--', '--platform', $Platform, '--arch', $Arch, '--output', $officeCliBinaryPath)
        $publicManifestUrl = Resolve-FunctionalModuleManifestUrl -BaseUrl $PublicBaseUrl -Prefix $ObjectPrefixPath -Channel $Channel
        if (-not [string]::IsNullOrWhiteSpace($publicManifestUrl)) {
            $prepareArguments += @('--public-manifest-url', $publicManifestUrl)
        }
        Invoke-BunCommand $rootDir $prepareArguments 'OfficeCLI module preparation failed'
    }
    if (-not (Test-Path -LiteralPath $officeCliBinaryPath -PathType Leaf)) { throw "OfficeCLI binary was not found: $officeCliBinaryPath" }
    $officeCliBinaryPath = (Resolve-Path -LiteralPath $officeCliBinaryPath).Path
    $officeCliVersionValue = if ([string]::IsNullOrWhiteSpace($OfficeCliVersion)) { Read-OfficeCliVersion $officeCliBinaryPath } else { $OfficeCliVersion.Trim() }
}

$nodeRuntimeArchivePath = $null
$nodeRuntimeVersionValue = $null
if (-not $RustOnly -and -not $OfficeCliOnly -and -not $AlipayBotOnly -and -not $PlaywrightCoreOnly -and -not $PythonRuntimeOnly) {
    $nodeRuntimeArchivePath = Resolve-PathFromRoot $NodeRuntimeArchive
    if (-not $nodeRuntimeArchivePath) { $nodeRuntimeArchivePath = Join-Path $appDir "resources\node-runtime\$Platform-$Arch.tar.gz" }
    if (-not (Test-Path -LiteralPath $nodeRuntimeArchivePath -PathType Leaf)) {
        if ($Platform -ne $currentPlatform -or $Arch -ne $currentArch) {
            throw 'Node.js runtime must be built on the target platform and architecture. Provide -NodeRuntimeArchive for cross-platform artifacts.'
        }
        $nodeSource = Resolve-NodeRuntimeSource
        Write-Host 'Packaging Node.js runtime module...'
        Invoke-BunCommand $rootDir @('run', 'build:node-runtime-module', '--', '--source', $nodeSource, '--output', $nodeRuntimeArchivePath) 'Node.js runtime module build failed'
        if ([string]::IsNullOrWhiteSpace($NodeRuntimeVersion)) { $NodeRuntimeVersion = Read-NodeRuntimeVersion $nodeSource }
    }
    if (-not (Test-Path -LiteralPath $nodeRuntimeArchivePath -PathType Leaf)) { throw "Node.js runtime archive was not found: $nodeRuntimeArchivePath" }
    $nodeRuntimeArchivePath = (Resolve-Path -LiteralPath $nodeRuntimeArchivePath).Path
    $nodeRuntimeVersionValue = if ([string]::IsNullOrWhiteSpace($NodeRuntimeVersion)) { $releaseVersion } else { $NodeRuntimeVersion.Trim() }
}

$alipayBotArchivePath = $null
$alipayBotVersionValue = $null
if (-not $RustOnly -and -not $OfficeCliOnly -and -not $NodeRuntimeOnly -and -not $PlaywrightCoreOnly -and -not $PythonRuntimeOnly) {
    $alipayBotArchivePath = Resolve-PathFromRoot $AlipayBotArchive
    if (-not $alipayBotArchivePath) { $alipayBotArchivePath = Join-Path $appDir "resources\alipay-bot\$Platform-$Arch.tar.gz" }
    if (-not (Test-Path -LiteralPath $alipayBotArchivePath -PathType Leaf) -or $env:COPIS_REFRESH_ALIPAY_BOT_CLI -eq '1') {
        if ($Platform -ne $currentPlatform -or $Arch -ne $currentArch) {
            throw 'Alipay Bot CLI must be prepared on the target platform and architecture. Provide -AlipayBotArchive for cross-platform artifacts.'
        }
        $metadataPath = Join-Path ([System.IO.Path]::GetTempPath()) "copis-alipay-bot-$([Guid]::NewGuid().ToString('N')).json"
        try {
            Write-Host 'Preparing Alipay Bot CLI module from the official installer...'
            Invoke-BunCommand $rootDir @('run', 'prepare:alipay-bot-module', '--', '--platform', $Platform, '--arch', $Arch, '--output', $alipayBotArchivePath, '--metadata', $metadataPath) 'Alipay Bot CLI module preparation failed'
            if ([string]::IsNullOrWhiteSpace($AlipayBotVersion)) {
                $AlipayBotVersion = [string](Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json).version
            }
        } finally {
            if (Test-Path -LiteralPath $metadataPath -PathType Leaf) { Remove-Item -LiteralPath $metadataPath -Force }
        }
    }
    if (-not (Test-Path -LiteralPath $alipayBotArchivePath -PathType Leaf)) { throw "Alipay Bot CLI archive was not found: $alipayBotArchivePath" }
    $alipayBotArchivePath = (Resolve-Path -LiteralPath $alipayBotArchivePath).Path
    $alipayBotVersionValue = if ([string]::IsNullOrWhiteSpace($AlipayBotVersion)) { $releaseVersion } else { $AlipayBotVersion.Trim() }
}

$playwrightCoreArchivePath = $null
$playwrightCoreVersionValue = $null
if (-not $RustOnly -and -not $OfficeCliOnly -and -not $NodeRuntimeOnly -and -not $AlipayBotOnly -and -not $PythonRuntimeOnly) {
    $playwrightCoreArchivePath = Resolve-PathFromRoot $PlaywrightCoreArchive
    if (-not $playwrightCoreArchivePath) { $playwrightCoreArchivePath = Join-Path $appDir 'resources\playwright-core\playwright-core.tar.gz' }
    if (-not (Test-Path -LiteralPath $playwrightCoreArchivePath -PathType Leaf)) {
        Write-Host 'Packaging Playwright Core module (without downloading browsers)...'
        Invoke-BunCommand $rootDir @('run', 'build:playwright-core-module', '--', '--output', $playwrightCoreArchivePath) 'Playwright Core module build failed'
    }
    if (-not (Test-Path -LiteralPath $playwrightCoreArchivePath -PathType Leaf)) { throw "Playwright Core archive was not found: $playwrightCoreArchivePath" }
    $playwrightCoreArchivePath = (Resolve-Path -LiteralPath $playwrightCoreArchivePath).Path
    $playwrightCoreVersionValue = if ([string]::IsNullOrWhiteSpace($PlaywrightCoreVersion)) { '1.62.1' } else { $PlaywrightCoreVersion.Trim() }
}

$pythonRuntimeArchivePath = $null
$pythonRuntimeVersionValue = $null
if (-not $RustOnly -and -not $OfficeCliOnly -and -not $NodeRuntimeOnly -and -not $AlipayBotOnly -and -not $PlaywrightCoreOnly) {
    $pythonRuntimeArchivePath = Resolve-PathFromRoot $PythonRuntimeArchive
    if (-not $pythonRuntimeArchivePath) { $pythonRuntimeArchivePath = Join-Path $appDir "resources\python-runtime\$Platform-$Arch.tar.gz" }
    if (-not (Test-Path -LiteralPath $pythonRuntimeArchivePath -PathType Leaf)) {
        Write-Host 'Packaging Python 3.12 runtime module...'
        Invoke-BunCommand $rootDir @('run', 'prepare:python-runtime-module', '--', '--platform', $Platform, '--arch', $Arch, '--output', $pythonRuntimeArchivePath) 'Python 3.12 runtime module preparation failed'
    }
    if (-not (Test-Path -LiteralPath $pythonRuntimeArchivePath -PathType Leaf)) { throw "Python 3.12 runtime archive was not found: $pythonRuntimeArchivePath" }
    $pythonRuntimeArchivePath = (Resolve-Path -LiteralPath $pythonRuntimeArchivePath).Path
    $pythonRuntimeVersionValue = if ([string]::IsNullOrWhiteSpace($PythonRuntimeVersion)) { '3.12.14' } else { $PythonRuntimeVersion.Trim() }
}

if ($BuildApp) {
    if ($Platform -ne $currentPlatform) { throw '-BuildApp can only build the current platform Electron application.' }
    Write-Host 'Building Electron application...'
    Invoke-BunCommand $appDir @('run', 'build') 'Electron application build failed'
    Invoke-BunCommand $appDir @('run', 'sync:runtime-deps') 'Runtime dependency sync failed'
    Invoke-BunCommand $appDir @('x', 'electron-builder', '--win') 'Windows Electron packaging failed'
}

if (-not $SkipPublish) {
    if ([string]::IsNullOrWhiteSpace($PublicBaseUrl)) { throw 'COS_PUBLIC_BASE_URL or -PublicBaseUrl is required to publish functional modules.' }
    $releaseArguments = @('--platform', $Platform, '--arch', $Arch, '--channel', $Channel, '--version', $releaseVersion, '--client-min-version', $minimumClientVersion, '--public-base-url', $PublicBaseUrl)
    if (-not $OfficeCliOnly -and -not $NodeRuntimeOnly -and -not $AlipayBotOnly -and -not $PlaywrightCoreOnly -and -not $PythonRuntimeOnly) { $releaseArguments += @('--rust-binary', $rustBinaryPath) }
    if (-not $RustOnly -and -not $NodeRuntimeOnly -and -not $AlipayBotOnly -and -not $PlaywrightCoreOnly -and -not $PythonRuntimeOnly) { $releaseArguments += @('--officecli-binary', $officeCliBinaryPath, '--officecli-version', $officeCliVersionValue) }
    if (-not $RustOnly -and -not $OfficeCliOnly -and -not $AlipayBotOnly -and -not $PlaywrightCoreOnly -and -not $PythonRuntimeOnly) { $releaseArguments += @('--node-runtime-archive', $nodeRuntimeArchivePath, '--node-runtime-version', $nodeRuntimeVersionValue) }
    if (-not $RustOnly -and -not $OfficeCliOnly -and -not $NodeRuntimeOnly -and -not $PlaywrightCoreOnly -and -not $PythonRuntimeOnly) { $releaseArguments += @('--alipay-bot-archive', $alipayBotArchivePath, '--alipay-bot-version', $alipayBotVersionValue) }
    if (-not $RustOnly -and -not $OfficeCliOnly -and -not $NodeRuntimeOnly -and -not $AlipayBotOnly -and -not $PythonRuntimeOnly) { $releaseArguments += @('--playwright-core-archive', $playwrightCoreArchivePath, '--playwright-core-version', $playwrightCoreVersionValue) }
    if (-not $RustOnly -and -not $OfficeCliOnly -and -not $NodeRuntimeOnly -and -not $AlipayBotOnly -and -not $PlaywrightCoreOnly) { $releaseArguments += @('--python-runtime-archive', $pythonRuntimeArchivePath, '--python-runtime-version', $pythonRuntimeVersionValue) }
    if (-not [string]::IsNullOrWhiteSpace($ObjectPrefixPath)) { $releaseArguments += @('--prefix', $ObjectPrefixPath.Trim()) }
    if ($RustOnly) { $releaseArguments += '--rust' }
    if ($OfficeCliOnly) { $releaseArguments += '--officecli' }
    if ($NodeRuntimeOnly) { $releaseArguments += '--node-runtime' }
    if ($AlipayBotOnly) { $releaseArguments += '--alipay-bot' }
    if ($PlaywrightCoreOnly) { $releaseArguments += '--playwright-core' }
    if ($PythonRuntimeOnly) { $releaseArguments += '--python-runtime' }

    $manifestPath = Join-Path $appDir 'dist\functional-modules\manifest.json'
    Write-Host 'Generating functional module manifest...'
    Invoke-BunCommand $rootDir (@('run', 'build:functional-module-manifest', '--') + $releaseArguments + @('--output', $manifestPath)) 'Functional module manifest build failed'
    Write-Host 'Publishing functional modules and manifest to COS...'
    Invoke-BunCommand $rootDir (@('run', 'publish:functional-modules', '--') + $releaseArguments + @('--manifest-output', $manifestPath)) 'Functional module COS publish failed'

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $platformProperty = $manifest.platforms.PSObject.Properties["$Platform-$Arch"]
    if ($null -eq $platformProperty -or $null -eq $platformProperty.Value.modules) { throw "Published manifest lacks platform: $Platform-$Arch" }
    $versions = @($platformProperty.Value.modules.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value.version)" } | Sort-Object)
    if ($versions.Count -eq 0) { throw "Published manifest lacks modules: $Platform-$Arch" }
    Write-Host "Functional modules published: $Platform/$Arch $($versions -join ', ')"
    Write-Host "实际模块版本：$($versions -join ', ')"
} else {
    Write-Host 'Skipping COS publication (-SkipPublish).'
}

Write-Host 'Deployment completed.'
