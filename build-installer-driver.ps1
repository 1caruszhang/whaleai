param(
    # VS BuildTools 环境（link.exe/dumpbin.exe/LIB/INCLUDE）。
    [string]$VcvarsPath = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat',
    # Rust 工具链 bin 目录（rustup/cargo），前置到 PATH。
    [string]$CargoBin = "$env:USERPROFILE\.cargo\bin"
)
$ErrorActionPreference = "Continue"
# 某些非交互 shell 没有 OS 环境变量；打包脚本需要它。
if (-not $env:OS) { $env:OS = "Windows_NT" }
if (-not (Test-Path $VcvarsPath)) {
    throw "vcvars64.bat not found at '$VcvarsPath'; pass -VcvarsPath <path>"
}
& cmd /c "`"$VcvarsPath`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
        Set-Item -Path "Env:$($matches[1])" -Value $matches[2]
    }
}
$env:PATH = "$CargoBin;$env:PATH"
# Resolve the project root from this script's own location.
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot
Write-Host "=== driver: OS=$env:OS TGTARCH=$env:VSCMD_ARG_TGT_ARCH ==="
$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
Write-Host "=== driver: dumpbin=$($dumpbin.Source) ==="
& '.\scripts\build-windows-x64.ps1' -Mode internal-unsigned
$code = $LASTEXITCODE
Write-Host "=== driver: build script exited with code $code ==="
exit $code
