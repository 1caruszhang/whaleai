param(
    [ValidateSet("internal-unsigned", "production-signed")]
    [string]$Mode = "internal-unsigned",
    [switch]$OfflineResources
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest
$TargetTriple = "x86_64-pc-windows-msvc"
$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TargetRoot = Join-Path $ProjectDir "src-tauri\target\$TargetTriple"
$BundleRoot = Join-Path $TargetRoot "release\bundle\nsis"
$MainExecutable = Join-Path $TargetRoot "release\xiaojing.exe"
$ArtifactRoot = Join-Path $ProjectDir "artifacts\windows-x64\$Mode"
$Manifest = Get-Content -LiteralPath (Join-Path $ProjectDir "scripts\windows-x64-resources.json") -Raw | ConvertFrom-Json

function Assert-WindowsX64Host {
    if ($env:OS -ne "Windows_NT") {
        throw "Windows x64 packaging can run only on Windows."
    }
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($architecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
        throw "Ticket 22 packaging accepts native Windows x64 only."
    }
    if ($env:VSCMD_ARG_TGT_ARCH -and $env:VSCMD_ARG_TGT_ARCH -ne "x64") {
        throw "Visual Studio target architecture must be x64."
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Label
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

function Find-Dumpbin {
    if ($env:VCToolsInstallDir) {
        $candidate = Join-Path $env:VCToolsInstallDir "bin\Hostx64\x64\dumpbin.exe"
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $command = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "Visual Studio x64 dumpbin.exe is required for PE import validation."
}

function Get-ProjectRelativePath {
    param([Parameter(Mandatory)][string]$Path)
    $separators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $root = [IO.Path]::GetFullPath($ProjectDir).TrimEnd($separators) + [IO.Path]::DirectorySeparatorChar
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to report a PE path outside the project root."
    }
    return $fullPath.Substring($root.Length)
}

function Assert-NoUnexpectedVcImports {
    param([Parameter(Mandatory)][string]$Dumpbin)
    $paths = @($MainExecutable)
    foreach ($directory in @("nodejs", "claude-agent-sdk", "sharp-runtime", "portable-git", "windows-prerequisites")) {
        $resourceRoot = Join-Path $ProjectDir "src-tauri\resources\$directory"
        $paths += Get-ChildItem -LiteralPath $resourceRoot -Recurse -Force -File |
            Where-Object { $_.Extension -match '^\.(exe|dll|node)$' } |
            ForEach-Object { $_.FullName }
    }
    foreach ($path in $paths) {
        $output = & $Dumpbin /nologo /dependents $path 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "PE import inspection failed for a packaged x64 file."
        }
        if (($output -join "`n") -match '(?im)^\s*(?:VCRUNTIME[^\s]*|MSVCP[^\s]*|CONCRT[^\s]*)\.dll\s*$') {
            $relative = Get-ProjectRelativePath $path
            throw "Unexpected Visual C++ dynamic import in $relative. Update the audited app-local runtime contract before packaging."
        }
    }
}

function Assert-ArtifactSignature {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][bool]$MustBeSigned
    )
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($MustBeSigned) {
        if ($signature.Status -ne "Valid") {
            throw "Production artifact signature is not valid."
        }
        $certSha1 = $env:XIAOJING_WINDOWS_SIGN_CERT_SHA1
        if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ine $certSha1) {
            throw "Production artifact signer identity mismatch."
        }
        if (-not $signature.TimeStamperCertificate) {
            throw "Production artifact has no trusted timestamp."
        }
    }
    elseif ($signature.Status -ne "NotSigned") {
        throw "Internal candidate must remain explicitly unsigned."
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Value
    )
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

Assert-WindowsX64Host
Set-Location $ProjectDir

if ($Manifest.targetTriple -ne $TargetTriple -or $Manifest.architecture -ne "x64") {
    throw "Windows resource manifest does not match the packaging target."
}
foreach ($commandName in @("node", "npm", "cargo", "rustc", "rustup")) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "Required build command is missing: $commandName"
    }
}
$installedTargets = (& rustup target list --installed 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0 -or $installedTargets -notmatch "(?m)^$([regex]::Escape($TargetTriple))$") {
    throw "Rust target $TargetTriple is not installed. Install the pinned repository toolchain target before packaging."
}

if ($Mode -eq "production-signed") {
    foreach ($name in @("XIAOJING_WINDOWS_SIGN_CERT_SHA1", "XIAOJING_WINDOWS_SIGN_TIMESTAMP_URL")) {
        if (-not [Environment]::GetEnvironmentVariable($name)) {
            throw "Production signing admission is incomplete."
        }
    }
    if (-not $env:XIAOJING_WINDOWS_SIGN_PFX_PATH -or -not $env:XIAOJING_WINDOWS_SIGN_PFX_PASSWORD) {
        throw "Production CI must provide the protected certificate file and password for a separate CurrentUser certificate-import step."
    }
    if (-not (Test-Path -LiteralPath $env:XIAOJING_WINDOWS_SIGN_PFX_PATH)) {
        throw "Production CI certificate file is unavailable."
    }
    $admittedSha1 = $env:XIAOJING_WINDOWS_SIGN_CERT_SHA1.Replace(" ", "")
    $installedCertificate = Get-ChildItem -Path Cert:\CurrentUser\My |
        Where-Object { $_.Thumbprint.Replace(" ", "") -ieq $admittedSha1 } |
        Select-Object -First 1
    if (-not $installedCertificate) {
        throw "Production certificate has not been imported into the CurrentUser store."
    }
    # The PFX import belongs to the protected CI admission step. Do not expose
    # its path or password to tests, npm lifecycle hooks, Cargo, or Tauri.
    $env:XIAOJING_WINDOWS_SIGN_PFX_PATH = $null
    $env:XIAOJING_WINDOWS_SIGN_PFX_PASSWORD = $null
}
else {
    foreach ($name in @(
        "XIAOJING_WINDOWS_SIGN_CERT_SHA1",
        "XIAOJING_WINDOWS_SIGN_TIMESTAMP_URL",
        "XIAOJING_WINDOWS_SIGN_PFX_PATH",
        "XIAOJING_WINDOWS_SIGN_PFX_PASSWORD"
    )) {
        if ([Environment]::GetEnvironmentVariable($name)) {
            throw "Signing material is present during an internal unsigned build. Refusing ambiguous output."
        }
    }
}

$prepareArguments = @()
if ($OfflineResources) { $prepareArguments += "-Offline" }
& (Join-Path $ProjectDir "scripts\prepare-windows-x64.ps1") @prepareArguments
if ($LASTEXITCODE -ne 0) {
    throw "Windows x64 resource preparation failed."
}

Invoke-Checked -Command "node" -Arguments @("scripts/validate-windows-x64.mjs", "--staging") -Label "Windows static validation"
Invoke-Checked -Command "npm" -Arguments @("run", "test:windows-x64") -Label "Windows contract tests"
Invoke-Checked -Command "npm" -Arguments @("run", "typecheck") -Label "TypeScript typecheck"
Invoke-Checked -Command "npm" -Arguments @("run", "lint") -Label "Repository lint"

$buildStarted = [DateTime]::UtcNow
$tauriArguments = @(
    "run", "tauri:build", "--",
    "--ci",
    "--target", $TargetTriple,
    "--bundles", "nsis"
)
if ($Mode -eq "production-signed") {
    $tauriArguments += @("--config", "src-tauri/tauri.windows.signing.conf.json")
}
else {
    $tauriArguments += "--no-sign"
}
Invoke-Checked -Command "npm" -Arguments $tauriArguments -Label "Tauri NSIS x64 build"

if (-not (Test-Path -LiteralPath $MainExecutable)) {
    throw "Tauri did not produce xiaojing.exe for the x64 target."
}
$installers = @(Get-ChildItem -LiteralPath $BundleRoot -Filter "*.exe" -File |
    Where-Object { $_.LastWriteTimeUtc -ge $buildStarted.AddSeconds(-2) })
if ($installers.Count -ne 1) {
    throw "Expected exactly one newly produced NSIS x64 installer, found $($installers.Count)."
}
$installer = $installers[0].FullName

Assert-NoUnexpectedVcImports -Dumpbin (Find-Dumpbin)
Assert-ArtifactSignature -Path $MainExecutable -MustBeSigned ($Mode -eq "production-signed")
Assert-ArtifactSignature -Path $installer -MustBeSigned ($Mode -eq "production-signed")

New-Item -ItemType Directory -Path $ArtifactRoot -Force | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $ProjectDir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$label = if ($Mode -eq "production-signed") { "PRODUCTION-SIGNED" } else { "INTERNAL-UNSIGNED" }
$candidateName = "Xiaojing_${version}_x64_${label}-setup.exe"
$candidatePath = Join-Path $ArtifactRoot $candidateName
Copy-Item -LiteralPath $installer -Destination $candidatePath -Force

$candidate = [ordered]@{
    schemaVersion = 1
    productName = "小鲸同学"
    identifier = "com.xiaojing.geo"
    targetTriple = $TargetTriple
    mode = $Mode
    file = $candidateName
    sha256 = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
    windowsInstallValidation = "pending-on-windows-10-and-11-x64"
    uploaded = $false
    published = $false
}
Write-Utf8NoBom -Path (Join-Path $ArtifactRoot "candidate.json") -Value ($candidate | ConvertTo-Json -Depth 20)

Write-Host "Windows x64 candidate created: $candidatePath"
Write-Host "Windows 10/11 installation, upgrade, uninstall and SmartScreen observation remain pending."
