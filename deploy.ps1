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
# Add ?v=<version> to the script URL so the app file is cache-busted on its own
# URL too — even if index.html itself is served from a stale cache layer.
$newTag = "<script src=`"./$($appVersioned)?v=$($v.version)`"></script>"
# Match both old app.js?v=... and new app_YYYYMMDD_HHMM.js patterns
$html = $html -replace '<script src="\./app(_\d{8}_\d{4})?\.js[^"]*"></script>', $newTag
Set-Content $indexFile $html -Encoding UTF8

Write-Host "Version bumped to $($v.version)"

# 2b. VERIFY the chain before committing. Fail fast if anything is inconsistent.
if (-not (Test-Path $appVersioned)) {
    throw "BUILD FAILED: expected app file '$appVersioned' does not exist."
}
$appBody = Get-Content $appVersioned -Raw -Encoding UTF8
if (-not ($appBody -match 'function aiHubQueryAll\(')) {
    throw "BUILD FAILED: '$appVersioned' does not contain the aiHubQueryAll helper."
}
if ($appBody -match '\bqsa\(') {
    throw "BUILD FAILED: '$appVersioned' still contains a qsa( call. Rename incomplete."
}
$indexBody = Get-Content $indexFile -Raw -Encoding UTF8
if (-not ($indexBody -match [regex]::Escape($newTag))) {
    throw "BUILD FAILED: index.html does not reference '$newTag'."
}
# Old conflict-prone references must be gone from the served shell.
if ($indexBody -match 'app_20260828_1931\.js|app_20260826_1939\.js|app_20260826_1948\.js|app_20260827_1914\.js') {
    throw "BUILD FAILED: index.html still references a known-broken legacy app file."
}
Write-Host "Chain verified: index.html -> $appVersioned (aiHubQueryAll present, no qsa)."

# 3. Git add, commit, push
git add -A
git commit -m $Message
git push origin gh-pages

Write-Host "Deployed."
