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

# 2. Copy app.js to a VERSIONED FILENAME. Changing the PATH (not just a ?v= query)
#    busts EVERY cache layer at once: browser HTTP cache, service worker cache,
#    and Telegram's WebView cache. A ?v= query alone was being ignored by all of them.
$appVersioned = "app_$($v.version).js"
# Inject the real build version into the copied file (source keeps the placeholder).
$appContent = Get-Content "app.js" -Raw -Encoding UTF8
$appContent = $appContent -replace 'const APP_VERSION = "[^"]*";', "const APP_VERSION = `"$($v.version)`";"
Set-Content $appVersioned $appContent -Encoding UTF8
$html = Get-Content $indexFile -Raw -Encoding UTF8
$newTag = "<script src=`"./$($appVersioned)`"></script>"
$html = $html -replace '<script src="\./app\.js[^"]*"></script>', $newTag
Set-Content $indexFile $html -Encoding UTF8

Write-Host "Version bumped to $($v.version)"

# 3. Git add, commit, push
git add -A
git commit -m $Message
git push origin gh-pages

Write-Host "Deployed."
