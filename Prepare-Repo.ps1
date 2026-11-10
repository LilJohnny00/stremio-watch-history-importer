<#
  Prepare-Repo.ps1 - run ONCE in the project folder before your first git push.
  1. Renames the .txt copies back to .mjs / .bat (if present)
  2. Strips SharePoint/Office metadata (your name etc.) from the .html files
  3. Sets the page <title> in the .html files
  4. Blocks if config.json / token.json are still present
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$renames = @{ 'server.txt'='server.mjs'; 'matcher.txt'='matcher.mjs'; 'parsers.txt'='parsers.mjs'; 'Start-Trakt-Backfill.txt'='Start-Trakt-Backfill.bat' }
foreach ($k in $renames.Keys) {
    if (Test-Path $k) { Move-Item $k $renames[$k] -Force; Write-Host "Renamed $k -> $($renames[$k])" }
}

$titles = @{ 'index.html'='Stremio Watch History Importer'; 'crunchyroll-help.html'='Crunchyroll export guide'; 'primevideo-help.html'='Prime Video export guide' }
foreach ($f in $titles.Keys) {
    if (-not (Test-Path $f)) { Write-Warning "$f not found"; continue }
    $c = [IO.File]::ReadAllText((Resolve-Path $f))
    $c = [regex]::Replace($c, '<!--\[if gte mso 9\]>.*?<!\[endif\]-->\s*', '', 'Singleline')
    $c = $c -replace ' xmlns:mso="[^"]*"', '' -replace ' xmlns:msdt="[^"]*"', ''
    $c = $c -replace '<title>\s*</title>', "<title>$($titles[$f])</title>"
    [IO.File]::WriteAllText((Resolve-Path $f), $c, (New-Object Text.UTF8Encoding $false))
    Write-Host "Cleaned $f"
}

$bad = @('config.json','token.json') | Where-Object { Test-Path $_ }
if ($bad) { Write-Host "`nSTOP: delete $($bad -join ', ') before pushing (they hold your Trakt secrets)." -ForegroundColor Red; exit 1 }

$hits = Select-String -Path *.mjs,*.html,*.bat,*.md -Pattern 'Bowen|access_token"\s*:\s*"[A-Za-z0-9_-]{20,}' -ErrorAction SilentlyContinue
if ($hits) { Write-Host "`nCheck these lines before pushing:" -ForegroundColor Yellow; $hits | ForEach-Object { "  $($_.Filename):$($_.LineNumber)" } }
else { Write-Host "`nClean - ready for git." -ForegroundColor Green }
