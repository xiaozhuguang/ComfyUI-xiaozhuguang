@echo off
setlocal
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
    echo Git is required. Run this script from the plugin's Git checkout.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "if (-not (Test-Path -LiteralPath '.git')) { throw 'Run this from the plugin Git checkout.' };" ^
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8;" ^
    "$files = @(git -c core.quotepath=false ls-files --cached --others --exclude-standard);" ^
    "if ($LASTEXITCODE -ne 0) { throw 'Git could not list the release files.' };" ^
    "$files = @($files | Sort-Object -Unique | Where-Object {" ^
    "  $_ -notmatch '^(docs/|dist/|build/|package-release\.bat$)' -and" ^
    "  $_ -notmatch '(^|/)(\.git|\.github|\.agents|\.codex|\.aws|\.vscode|\.idea|tests?|__pycache__|node_modules|\.venv)(/|$)|\.(pyc|pyo|log|tmp|temp|safetensors|ckpt|onnx|gguf|pth|pt)$' -and" ^
    "  (Test-Path -LiteralPath $_ -PathType Leaf)" ^
    "});" ^
    "$launcher = -join ((0x4E00,0x952E,0x5B89,0x88C5,0x4F9D,0x8D56) | ForEach-Object { [char]$_ });" ^
    "foreach ($required in @('__init__.py', 'requirements.txt', 'installer/install.ps1', 'installer/engine.py', ($launcher + '.exe'))) {" ^
    "  if ($files -notcontains $required) { throw ('Missing release file: ' + $required) }" ^
    "};" ^
    "$outputDir = 'dist'; if ($env:XZG_RELEASE_OUTPUT) { $outputDir = $env:XZG_RELEASE_OUTPUT };" ^
    "New-Item -ItemType Directory -Path $outputDir -Force | Out-Null;" ^
    "$zipPath = Join-Path (Resolve-Path -LiteralPath $outputDir).Path 'ComfyUI-xiaozhuguang.zip';" ^
    "$tempPath = $zipPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp';" ^
    "$backupPath = $tempPath + '.bak';" ^
    "Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem;" ^
    "try {" ^
    "  $zip = [IO.Compression.ZipFile]::Open($tempPath, [IO.Compression.ZipArchiveMode]::Create, [Text.Encoding]::UTF8);" ^
    "  try {" ^
    "    foreach ($file in $files) {" ^
    "      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $PWD.Path $file), ('ComfyUI-xiaozhuguang/' + $file), [IO.Compression.CompressionLevel]::Optimal) | Out-Null" ^
    "    }" ^
    "  } finally { $zip.Dispose() };" ^
    "  if ([IO.File]::Exists($zipPath)) { [IO.File]::Replace($tempPath, $zipPath, $backupPath); [IO.File]::Delete($backupPath) }" ^
    "  else { [IO.File]::Move($tempPath, $zipPath) }" ^
    "} finally { [IO.File]::Delete($tempPath) };" ^
    "Write-Host ('Created: ' + $zipPath);"

set "package_result=%errorlevel%"
if not "%package_result%"=="0" echo Packaging failed.
pause
exit /b %package_result%
