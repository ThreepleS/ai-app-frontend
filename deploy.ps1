# Deploy script for gh-pages: bumps cache version, commits, and pushes
# Usage: .\deploy.ps1 [-Message "commit message"]
param(
  [string]$Message = "deploy: bump cache version and push"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 1. Bump version
$versionFile = Join-Path $root 'version.json'
$indexFile = Join-Path $root 'index.html'

if (-not (Test-Path $versionFile)) {
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $dateStr = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd_HHmm')
  @{ version = $dateStr; updated_at = $ts } | ConvertTo-Json | Set-Content $versionFile
}

$v = Get-Content $versionFile -Raw | ConvertFrom-Json
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$dateStr = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd_HHmm')
if ($v.version -ne $dateStr) {
  $v.version = $dateStr
  $v.updated_at = $ts
  $v | ConvertTo-Json | Set-Content $versionFile
}

# 2. Update script tag in index.html
$html = Get-Content $indexFile -Raw -Encoding UTF8
$newTag = "<script src=`"./app.js?v=$($v.version)`"></script>"
$html = $html -replace '<script src="\./app\.js\?v=[^"]+"></script>', $newTag
Set-Content $indexFile $html -Encoding UTF8

Write-Host "Version bumped to $($v.version)"

# 3. Git add, commit, push
git add -A
git commit -m $Message
git push origin gh-pages

Write-Host "Deployed."
