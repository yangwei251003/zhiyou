$ErrorActionPreference = 'Stop'

$appDirectory = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $appDirectory 'package.json') -Raw | ConvertFrom-Json
$sourceDirectory = Join-Path $appDirectory 'release\win-unpacked'
$archiveName = "BossHunter-Next-$($package.version)-windows-x64.zip"
$archivePath = Join-Path $appDirectory "release\$archiveName"

if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory 'BossHunter-Next.exe'))) {
  throw 'Packaged Windows executable is missing'
}

Compress-Archive -Path (Join-Path $sourceDirectory '*') -DestinationPath $archivePath -CompressionLevel Optimal -Force

$archive = Get-Item -LiteralPath $archivePath
if ($archive.Length -lt 50MB) {
  throw "Packaged Windows archive is unexpectedly small: $($archive.Length) bytes"
}

Write-Output "Created $($archive.FullName) ($($archive.Length) bytes)"
