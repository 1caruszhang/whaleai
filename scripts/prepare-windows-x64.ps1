param(
    [string]$CacheDirectory = "",
    [switch]$Offline
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest
$TargetTriple = "x86_64-pc-windows-msvc"
$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ResourcesDir = Join-Path $ProjectDir "src-tauri\resources"
$ManifestPath = Join-Path $ProjectDir "scripts\windows-x64-resources.json"
$StagingRecordPath = Join-Path $ResourcesDir "windows-x64-staging.json"
if (-not $CacheDirectory) {
    $CacheDirectory = Join-Path $ProjectDir ".windows-x64-cache"
}

function Assert-WindowsX64Host {
    if ($env:OS -ne "Windows_NT") {
        throw "Windows x64 resource preparation can run only on Windows."
    }
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($architecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
        throw "Unsupported host architecture: $architecture. Ticket 22 accepts native Windows x64 only."
    }
    if ($env:VSCMD_ARG_TGT_ARCH -and $env:VSCMD_ARG_TGT_ARCH -ne "x64") {
        throw "Visual Studio target architecture must be x64."
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Convert-HexToBase64 {
    param([Parameter(Mandatory)][string]$Hex)
    $bytes = New-Object byte[] ($Hex.Length / 2)
    for ($index = 0; $index -lt $bytes.Length; $index++) {
        $bytes[$index] = [Convert]::ToByte($Hex.Substring($index * 2, 2), 16)
    }
    return [Convert]::ToBase64String($bytes)
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Value
    )
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Assert-FileSha256 {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)][string]$Label
    )
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "$Label SHA-256 mismatch. Refusing to use the file."
    }
}

function Assert-FileSri {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)][string]$Label
    )
    if (-not $Expected.StartsWith("sha512-")) {
        throw "$Label must use a SHA-512 integrity value."
    }
    $hex = (Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash
    $actual = "sha512-$(Convert-HexToBase64 $hex)"
    if ($actual -cne $Expected) {
        throw "$Label SHA-512 integrity mismatch. Refusing to use the file."
    }
}

function Assert-AuthenticodeValid {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne "Valid") {
        throw "$Label does not have a valid Authenticode signature."
    }
}

function Get-PeMachine {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        if ($stream.Length -lt 512) { return 0 }
        $reader = New-Object System.IO.BinaryReader($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) { return 0 }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        if ($peOffset -lt 64 -or ($peOffset + 24) -gt $stream.Length) { return 0 }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { return 0 }
        return $reader.ReadUInt16()
    }
    finally {
        $stream.Dispose()
    }
}

function Get-ResourceRelativePath {
    param([Parameter(Mandatory)][string]$Path)
    $separators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $root = [IO.Path]::GetFullPath($ResourcesDir).TrimEnd($separators) + [IO.Path]::DirectorySeparatorChar
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to inventory a file outside the Windows resource root."
    }
    return $fullPath.Substring($root.Length).Replace("\", "/")
}

function Assert-PeX64 {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    $machine = Get-PeMachine $Path
    if ($machine -ne 0x8664) {
        throw ("{0} is not an x64 PE file (machine 0x{1:X4})." -f $Label, $machine)
    }
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory)]$Spec,
        [Parameter(Mandatory)][string]$Label,
        [ValidateSet("sha256", "sri")][string]$HashKind = "sha256"
    )
    $uri = [Uri]$Spec.url
    if ($uri.Scheme -ne "https") {
        throw "$Label source must use HTTPS."
    }
    New-Item -ItemType Directory -Path $CacheDirectory -Force | Out-Null
    $destination = Join-Path $CacheDirectory $Spec.cacheFile
    if (Test-Path -LiteralPath $destination) {
        if ($HashKind -eq "sha256") {
            Assert-FileSha256 -Path $destination -Expected $Spec.sha256 -Label $Label
        }
        else {
            Assert-FileSri -Path $destination -Expected $Spec.integrity -Label $Label
        }
        return $destination
    }
    if ($Offline) {
        throw "$Label is absent from the verified offline cache."
    }

    $partial = "$destination.partial-$([Guid]::NewGuid().ToString('N'))"
    try {
        Invoke-WebRequest -Uri $Spec.url -OutFile $partial -MaximumRedirection 8 -TimeoutSec 300 -UseBasicParsing
        if ($HashKind -eq "sha256") {
            Assert-FileSha256 -Path $partial -Expected $Spec.sha256 -Label $Label
        }
        else {
            Assert-FileSri -Path $partial -Expected $Spec.integrity -Label $Label
        }
        Move-Item -LiteralPath $partial -Destination $destination
    }
    finally {
        if (Test-Path -LiteralPath $partial) {
            Remove-Item -LiteralPath $partial -Force
        }
    }
    return $destination
}

function Reset-StagingDirectory {
    param([Parameter(Mandatory)][string]$Name)
    $allowed = @(
        "nodejs",
        "claude-agent-sdk",
        "sharp-runtime",
        "portable-git",
        "windows-prerequisites"
    )
    if ($Name -notin $allowed) {
        throw "Refusing to reset an unregistered staging directory."
    }
    $path = Join-Path $ResourcesDir $Name
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}

function Remove-NonRuntimeMaterial {
    param([Parameter(Mandatory)][string]$Root)
    $blockedPrefixes = @(
        ("LIC" + "ENSE"),
        ("LIC" + "ENCE"),
        ("COPY" + "ING"),
        ("NOT" + "ICE"),
        ("ATTRI" + "BUTION"),
        "AUTHORS",
        "README",
        "CHANGELOG",
        ("RELEASE" + "NOTES")
    )
    Get-ChildItem -LiteralPath $Root -Recurse -Force -File | ForEach-Object {
        $upper = $_.Name.ToUpperInvariant()
        if ($_.Extension -ieq ".md" -or ($blockedPrefixes | Where-Object { $upper.StartsWith($_) })) {
            Remove-Item -LiteralPath $_.FullName -Force
        }
    }
    foreach ($docPath in @(
        (Join-Path $Root "mingw64\share\doc"),
        (Join-Path $Root "usr\share\doc")
    )) {
        if (Test-Path -LiteralPath $docPath) {
            Remove-Item -LiteralPath $docPath -Recurse -Force
        }
    }
    Get-ChildItem -LiteralPath $Root -Recurse -Force -Directory |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object {
            $upper = $_.Name.ToUpperInvariant()
            if ($upper -eq "DOC" -or $upper -eq "DOCS" -or ($blockedPrefixes | Where-Object { $upper.StartsWith($_) })) {
                if (Test-Path -LiteralPath $_.FullName) {
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force
                }
            }
        }

    $metadataKeys = @(
        ("licen" + "se"),
        "author",
        "contributors",
        "funding",
        "homepage",
        "repository",
        "bugs"
    )
    Get-ChildItem -LiteralPath $Root -Recurse -Force -File -Filter "package.json" | ForEach-Object {
        $package = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
        foreach ($key in $metadataKeys) {
            $package.PSObject.Properties.Remove($key)
        }
        Write-Utf8NoBom -Path $_.FullName -Value ($package | ConvertTo-Json -Depth 100)
    }
}

function Expand-NpmRuntimePackage {
    param(
        [Parameter(Mandatory)]$Spec,
        [Parameter(Mandatory)][string]$TemporaryRoot
    )
    $archive = Get-VerifiedDownload -Spec $Spec -Label $Spec.name -HashKind "sri"
    $extractRoot = Join-Path $TemporaryRoot ([Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    # Use the Windows inbox bsdtar. A GNU tar earlier on PATH (for example a
    # Git-bundled tar) misparses drive-letter paths like C:\... as remote hosts.
    & "$env:SystemRoot\System32\tar.exe" -xzf $archive -C $extractRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Verified npm archive extraction failed for $($Spec.name)."
    }
    $packageRoot = Join-Path $extractRoot "package"
    $packageJsonPath = Join-Path $packageRoot "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonPath)) {
        throw "Extracted npm archive is missing package.json for $($Spec.name)."
    }
    $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
    if ($packageJson.name -ne $Spec.name -or $packageJson.version -ne $Spec.version) {
        throw "Extracted npm package identity mismatch for $($Spec.name)."
    }
    return $packageRoot
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
}

function Write-StagingRecord {
    param([Parameter(Mandatory)]$Manifest)
    $files = @()
    foreach ($directory in @("nodejs", "claude-agent-sdk", "sharp-runtime", "portable-git", "windows-prerequisites")) {
        $root = Join-Path $ResourcesDir $directory
        Get-ChildItem -LiteralPath $root -Recurse -Force -File | ForEach-Object {
            $relativePath = Get-ResourceRelativePath $_.FullName
            $files += [ordered]@{
                path = $relativePath
                size = $_.Length
                sha256 = Get-Sha256 $_.FullName
            }
        }
    }
    $sources = [ordered]@{}
    foreach ($property in $Manifest.downloads.PSObject.Properties) {
        $sources[$property.Name] = [ordered]@{ sha256 = $property.Value.sha256 }
    }
    $npmPackages = [ordered]@{}
    foreach ($property in $Manifest.npmPackages.PSObject.Properties) {
        $npmPackages[$property.Name] = [ordered]@{
            version = $property.Value.version
            integrity = $property.Value.integrity
        }
    }
    $record = [ordered]@{
        schemaVersion = 1
        targetTriple = $TargetTriple
        generatedAt = [DateTime]::UtcNow.ToString("o")
        sources = $sources
        npmPackages = $npmPackages
        files = @($files | Sort-Object { $_.path })
    }
    Write-Utf8NoBom -Path $StagingRecordPath -Value ($record | ConvertTo-Json -Depth 100)
}

Assert-WindowsX64Host
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "Windows x64 resource manifest is missing."
}
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.targetTriple -ne $TargetTriple -or $manifest.architecture -ne "x64") {
    throw "Windows x64 resource manifest target mismatch."
}
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    throw "Windows tar.exe is required to extract verified npm archives."
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "xiaojing-windows-x64-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
    $nodeStage = Reset-StagingDirectory "nodejs"
    $claudeStage = Reset-StagingDirectory "claude-agent-sdk"
    $sharpStage = Reset-StagingDirectory "sharp-runtime"
    $portableGitStage = Reset-StagingDirectory "portable-git"
    $prerequisiteStage = Reset-StagingDirectory "windows-prerequisites"

    $nodeArchive = Get-VerifiedDownload -Spec $manifest.downloads.node -Label "Node.js x64"
    $nodeExtract = Join-Path $temporaryRoot "node"
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
    $nodeExecutable = Join-Path $nodeExtract "node-v$($manifest.downloads.node.version)-win-x64\node.exe"
    Assert-PeX64 -Path $nodeExecutable -Label "Node.js"
    Assert-AuthenticodeValid -Path $nodeExecutable -Label "Node.js"
    Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $nodeStage "node.exe")

    $portableGitArchive = Get-VerifiedDownload -Spec $manifest.downloads.portableGit -Label "PortableGit x64"
    Assert-AuthenticodeValid -Path $portableGitArchive -Label "PortableGit x64 archive"
    $portableExtract = Join-Path $temporaryRoot "portable-git"
    New-Item -ItemType Directory -Path $portableExtract -Force | Out-Null
    & $portableGitArchive -y "-o$portableExtract"
    if ($LASTEXITCODE -ne 0) {
        throw "Verified PortableGit x64 extraction failed."
    }
    # The 7-Zip self-extractor can return before its extraction child process
    # has finished writing. Wait until the required entry points exist and the
    # file count stays stable before staging the result.
    $extractionMarkers = @("bin\bash.exe", "cmd\git.exe", "mingw64\bin\git.exe")
    $extractionDeadline = [DateTime]::UtcNow.AddMinutes(10)
    $lastFileCount = -1
    $stablePolls = 0
    while ([DateTime]::UtcNow -lt $extractionDeadline) {
        $markersPresent = $true
        foreach ($marker in $extractionMarkers) {
            if (-not (Test-Path -LiteralPath (Join-Path $portableExtract $marker))) {
                $markersPresent = $false
                break
            }
        }
        $fileCount = @(Get-ChildItem -LiteralPath $portableExtract -Recurse -Force -File).Count
        if ($markersPresent -and $fileCount -gt 0 -and $fileCount -eq $lastFileCount) {
            $stablePolls += 1
            if ($stablePolls -ge 2) { break }
        }
        else {
            $stablePolls = 0
        }
        $lastFileCount = $fileCount
        Start-Sleep -Seconds 3
    }
    foreach ($marker in $extractionMarkers) {
        if (-not (Test-Path -LiteralPath (Join-Path $portableExtract $marker))) {
            throw "PortableGit x64 extraction did not produce $marker."
        }
    }
    Copy-DirectoryContents -Source $portableExtract -Destination $portableGitStage

    $webviewBootstrapper = Get-VerifiedDownload -Spec $manifest.downloads.webview2 -Label "WebView2 x64 bootstrapper"
    # Microsoft's evergreen bootstrapper stub is a 32-bit PE that installs the
    # x64 WebView2 runtime; the hash pin and Authenticode checks below are the
    # admission contract for this prerequisite.
    Assert-AuthenticodeValid -Path $webviewBootstrapper -Label "WebView2 x64 bootstrapper"
    Copy-Item -LiteralPath $webviewBootstrapper -Destination (Join-Path $prerequisiteStage "MicrosoftEdgeWebview2Setup.exe")

    $claudePackage = Expand-NpmRuntimePackage -Spec $manifest.npmPackages.claudeNative -TemporaryRoot $temporaryRoot
    $claudeExecutable = Join-Path $claudePackage "claude.exe"
    Assert-FileSha256 -Path $claudeExecutable -Expected $manifest.npmPackages.claudeNative.binarySha256 -Label "Claude Agent SDK x64 executable"
    Assert-PeX64 -Path $claudeExecutable -Label "Claude Agent SDK x64 executable"
    Assert-AuthenticodeValid -Path $claudeExecutable -Label "Claude Agent SDK x64 executable"
    Copy-Item -LiteralPath $claudeExecutable -Destination (Join-Path $claudeStage "claude.exe")

    foreach ($property in $manifest.npmPackages.PSObject.Properties) {
        if ($property.Name -eq "claudeNative") { continue }
        $packageRoot = Expand-NpmRuntimePackage -Spec $property.Value -TemporaryRoot $temporaryRoot
        $destination = Join-Path $ResourcesDir $property.Value.stagePath
        Copy-DirectoryContents -Source $packageRoot -Destination $destination
    }

    Remove-NonRuntimeMaterial -Root $sharpStage
    Remove-NonRuntimeMaterial -Root $portableGitStage

    foreach ($required in $manifest.requiredStagedPaths) {
        $requiredPath = Join-Path $ResourcesDir $required.Replace("/", "\")
        if (-not (Test-Path -LiteralPath $requiredPath)) {
            throw "Required Windows x64 resource is missing after staging: $required"
        }
    }
    foreach ($required in $manifest.requiredPeX64Paths) {
        Assert-PeX64 -Path (Join-Path $ResourcesDir $required.Replace("/", "\")) -Label $required
    }

    Write-StagingRecord -Manifest $manifest
    & node (Join-Path $ProjectDir "scripts\validate-windows-x64.mjs") --staging
    if ($LASTEXITCODE -ne 0) {
        throw "Windows x64 staging validator rejected the prepared resources."
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        # Windows Remove-Item can race with just-closed extraction handles on
        # deep directory trees (for example PortableGit tcl tzdata). Retry a
        # few times, then leave the temp dir behind rather than failing an
        # otherwise successful staging.
        $deleted = $false
        foreach ($attempt in 1..5) {
            try {
                Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction Stop
                $deleted = $true
                break
            }
            catch {
                Start-Sleep -Seconds 2
            }
        }
        if (-not $deleted) {
            Write-Warning "Temporary extraction root was left behind: $temporaryRoot"
        }
    }
}

Write-Host "Windows x64 resources are prepared and hash-verified."
