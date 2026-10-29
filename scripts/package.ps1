# Package EtsyHunt for Chrome Web Store upload.
# Creates dist/etsyhunt-<version>.zip with only extension runtime files.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$manifest = Get-Content ".\manifest.json" -Raw | ConvertFrom-Json
$version = $manifest.version
$outDir = Join-Path $Root "dist"
$stage = Join-Path $outDir "stage"
$zipName = "etsyhunt-$version.zip"
$zipPath = Join-Path $outDir $zipName

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$include = @(
  "manifest.json",
  "icons",
  "src"
)

foreach ($item in $include) {
  $src = Join-Path $Root $item
  $dst = Join-Path $stage $item
  if (Test-Path $src -PathType Container) {
    Copy-Item $src $dst -Recurse
  } else {
    Copy-Item $src $dst
  }
}

# Strip editor junk if any slipped in
Get-ChildItem $stage -Recurse -Force -Include *.map,*.md,.DS_Store,Thumbs.db | Remove-Item -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$size = (Get-Item $zipPath).Length
Write-Host "Created $zipPath ($([Math]::Round($size/1KB,1)) KB)"
Write-Host "Upload this ZIP in the Chrome Web Store developer dashboard."
