$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'xzg_codex_upload.ps1') -Raw
$cache = [regex]::Match($source, '(?s)    \$nativeSource = .*?(?=    \$originalWindow)')
if (!$cache.Success) { throw 'Native assembly cache block not found' }
$timer = [Diagnostics.Stopwatch]::StartNew()
# Compile or load only; do not call native methods or access the desktop.
Invoke-Expression $cache.Value
$timer.Stop()
if (!(Test-Path -LiteralPath $assemblyPath)) { throw 'Native assembly was not cached' }
if (![XzgCodexWindow].GetMethod('FindWindows')) { throw 'Cached assembly is missing window lookup' }
Write-Output ('PASS: native assembly loaded in ' + $timer.ElapsedMilliseconds + ' ms')
