param(
    [Parameter(Mandatory)][string]$FilePath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
    throw "Production signing can run only on Windows."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw "Production signing accepts native Windows x64 only."
}

$certSha1 = $env:XIAOJING_WINDOWS_SIGN_CERT_SHA1
$timeServer = $env:XIAOJING_WINDOWS_SIGN_TIMESTAMP_URL
if (-not $certSha1 -or $certSha1 -notmatch '^[0-9A-Fa-f]{40}$') {
    throw "Production signing certificate identity is missing or malformed."
}
if (-not $timeServer) {
    throw "Production signing time server is missing."
}
$parsedTimeServer = $null
if (-not [Uri]::TryCreate($timeServer, [UriKind]::Absolute, [ref]$parsedTimeServer) -or $parsedTimeServer.Scheme -ne "https") {
    throw "Production signing time server must be an absolute HTTPS URL."
}

$resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path
$extension = [IO.Path]::GetExtension($resolvedFile)
if ($extension -ine ".exe" -and $extension -ine ".dll") {
    throw "Production signing accepts Windows executable and NSIS support artifacts only."
}

$signTool = $env:XIAOJING_WINDOWS_SIGNTOOL_PATH
if ($signTool) {
    $signTool = (Resolve-Path -LiteralPath $signTool).Path
}
else {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) {
        $signTool = $command.Source
    }
    elseif ($env:ProgramFiles -and ${env:ProgramFiles(x86)}) {
        $kitRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
        $candidate = Get-ChildItem -LiteralPath $kitRoot -Filter "signtool.exe" -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '[\\/]x64[\\/]signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($candidate) { $signTool = $candidate.FullName }
    }
}
if (-not $signTool -or -not (Test-Path -LiteralPath $signTool)) {
    throw "Windows SDK signtool.exe was not found."
}

# Do not stream native-tool output: CI logs must never echo credential material
# or provider-specific command details.
$signOutput = & $signTool sign /sha1 $certSha1 /s My /fd SHA256 /tr $timeServer /td SHA256 $resolvedFile 2>&1
if ($LASTEXITCODE -ne 0) {
    $null = $signOutput
    throw "Windows production signing failed."
}
$null = $signOutput

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedFile
if ($signature.Status -ne "Valid") {
    throw "Windows production signature verification failed."
}
$actualSha1 = $signature.SignerCertificate.Thumbprint.Replace(" ", "")
if ($actualSha1 -ine $certSha1.Replace(" ", "")) {
    throw "Windows production signer identity does not match the admitted certificate."
}
if (-not $signature.TimeStamperCertificate) {
    throw "Windows production signature is missing a trusted timestamp."
}

Write-Output "Windows artifact signature verified."
