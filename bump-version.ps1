# Auto bump cache version for gh-pages deploy
$ErrorActionPreference = 'Stop'
$versionFile = Join-Path $PSScriptRoot 'version.json'
$indexFile = Join-Path $PSScriptRoot 'index.html'

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

$html = Get-Content $indexFile -Raw -Encoding UTF8
$newTag = "<script src=`"./app.js?v=$($v.version)`"></script>"
$html = $html -replace '<script src="\./app\.js\?v=[^"]+"></script>', $newTag
Set-Content $indexFile $html -Encoding UTF8

Write-Host "Bumped version to $($v.version)"
