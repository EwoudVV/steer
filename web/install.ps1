# installs steer (https://github.com/EwoudVV/steer) into ~\.steer\bin and sets it up
#   irm https://steer.duck.hackclub.app/install.ps1 | iex
$ErrorActionPreference = "Stop"

$bin = Join-Path $HOME ".steer\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$exe = Join-Path $bin "steer.exe"

Write-Host "downloading steer..."
Invoke-WebRequest -UseBasicParsing "https://github.com/EwoudVV/steer/releases/latest/download/steer-windows-x64.exe" -OutFile "$exe.new"
# a running watcher keeps the old file locked
Get-Process steer -ErrorAction SilentlyContinue | Stop-Process -Force
Move-Item -Force "$exe.new" $exe

# so you can type steer in any new terminal
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ";") -contains $bin)) {
  [Environment]::SetEnvironmentVariable("Path", ((@($userPath, $bin) | Where-Object { $_ }) -join ";"), "User")
}
if (-not (($env:Path -split ";") -contains $bin)) { $env:Path = "$env:Path;$bin" }
Write-Host ""

# where this script was downloaded from, so steer signs in there too. steer.dino.icu
# hands out this script with its own address here.
$env:STEER_SERVER = "https://steer.duck.hackclub.app"

# steer install explains what it does and asks first
& $exe install
exit $LASTEXITCODE
