param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$pluginDir = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'XiaozhuguangInstaller'
$configPath = Join-Path $stateDir 'settings.json'
$saved = $null
if (Test-Path -LiteralPath $configPath) {
    try { $saved = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
function Find-ComfyDirectory($path) {
    if (-not $path) { return }
    foreach ($candidate in @($path, (Join-Path $path 'ComfyUI'))) {
        if ((Test-Path -LiteralPath (Join-Path $candidate 'main.py') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'folder_paths.py') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'custom_nodes') -PathType Container)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }
}

$comfyDir = $null
for ($ancestor = Get-Item -LiteralPath $pluginDir; $ancestor -and -not $comfyDir; $ancestor = $ancestor.Parent) {
    $comfyDir = Find-ComfyDirectory $ancestor.FullName
}
if (-not $comfyDir -and $saved) { $comfyDir = Find-ComfyDirectory $saved.comfy }
if (-not $comfyDir) {
    $matchesOnDisk = @(foreach ($drive in [IO.DriveInfo]::GetDrives()) {
        if ($drive.DriveType -eq 'Fixed') {
            Find-ComfyDirectory $drive.RootDirectory.FullName
            foreach ($folder in Get-ChildItem -LiteralPath $drive.RootDirectory.FullName -Directory -Filter 'ComfyUI*' -ErrorAction SilentlyContinue) {
                Find-ComfyDirectory $folder.FullName
            }
        }
    })
    $matchesOnDisk = @($matchesOnDisk | Sort-Object -Unique)
    if ($matchesOnDisk.Count -eq 1) { $comfyDir = $matchesOnDisk[0] }
}
$form = New-Object System.Windows.Forms.Form
$form.Text = '小珠光 · 依赖安装'
$form.ClientSize = New-Object System.Drawing.Size(700, 470)
$form.MinimumSize = New-Object System.Drawing.Size(650, 430)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

function Label($text, $x, $y) {
    $control = New-Object System.Windows.Forms.Label
    $control.Text = $text; $control.Location = New-Object System.Drawing.Point($x, $y)
    $control.AutoSize = $true; $form.Controls.Add($control)
}
$targetButton = New-Object System.Windows.Forms.Button
$targetButton.Text = '选择 ComfyUI'; $targetButton.SetBounds(18, 17, 105, 28)
$form.Controls.Add($targetButton)
$targetLabel = New-Object System.Windows.Forms.Label
$targetLabel.SetBounds(132, 23, 548, 22); $targetLabel.Anchor = 'Top,Left,Right'
$targetLabel.AutoEllipsis = $true
$form.Controls.Add($targetLabel)
Label 'Python 环境' 18 63
$pythonBox = New-Object System.Windows.Forms.TextBox
$pythonBox.SetBounds(108, 59, 478, 26)
$pythonBox.Anchor = 'Top,Left,Right'
$form.Controls.Add($pythonBox)
$browse = New-Object System.Windows.Forms.Button
$browse.Text = '选择'; $browse.SetBounds(596, 58, 84, 28); $browse.Anchor = 'Top,Right'
$browse.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Filter = 'Python (python.exe)|python.exe|程序 (*.exe)|*.exe'
    if ($dialog.ShowDialog() -eq 'OK') { $pythonBox.Text = $dialog.FileName }
    $dialog.Dispose()
})
$form.Controls.Add($browse)
Label '下载源' 18 105
$sourceBox = New-Object System.Windows.Forms.ComboBox
$sourceBox.DropDownStyle = 'DropDownList'; $sourceBox.SetBounds(108, 100, 200, 28)
$sourceBox.Items.AddRange(@('自动选择', '官方 PyPI', '清华镜像', '阿里云镜像', '自定义 HTTPS'))
$sourceBox.SelectedIndex = 0
if ($saved -and $saved.source -ge 0 -and $saved.source -lt 5) { $sourceBox.SelectedIndex = $saved.source }
$form.Controls.Add($sourceBox)
$customBox = New-Object System.Windows.Forms.TextBox
$customBox.SetBounds(320, 100, 360, 26); $customBox.Anchor = 'Top,Left,Right'
if ($saved) { $customBox.Text = $saved.custom }
$customBox.Visible = $sourceBox.SelectedIndex -eq 4
$sourceBox.Add_SelectedIndexChanged({ $customBox.Visible = $sourceBox.SelectedIndex -eq 4 })
$form.Controls.Add($customBox)
Label '安装范围' 18 140
$profileBox = New-Object System.Windows.Forms.ComboBox
$profileBox.DropDownStyle = 'DropDownList'; $profileBox.SetBounds(108, 135, 320, 28)
$profileBox.Items.AddRange(@('基础依赖', '完整依赖（特殊组件按环境匹配）'))
$profileBox.SelectedIndex = 0
if ($saved -and $saved.profile -eq 1) { $profileBox.SelectedIndex = 1 }
$form.Controls.Add($profileBox)
$checkButton = New-Object System.Windows.Forms.Button
$checkButton.Text = '检查'; $checkButton.SetBounds(490, 134, 88, 30); $checkButton.Anchor = 'Top,Right'
$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = '安装'; $installButton.SetBounds(592, 134, 88, 30); $installButton.Anchor = 'Top,Right'
$form.Controls.AddRange(@($checkButton, $installButton))
function Set-ComfyDirectory($path) {
    $script:comfyDir = $path
    $targetLabel.Text = '请选择 ComfyUI 主目录'
    $pythonBox.Clear()
    $script:detected = @()
    $script:destination = $null
    if (-not $path) { return }
    $distributionDir = Split-Path -Parent $path
    $customNodes = Join-Path $path 'custom_nodes'
    $script:destination = Join-Path $customNodes 'ComfyUI-xiaozhuguang'
    if ((Split-Path -Parent $pluginDir) -eq $customNodes) { $script:destination = $pluginDir }
    $targetLabel.Text = $script:destination
    $script:detected = @(@(
        (Join-Path $distributionDir 'python\python.exe'),
        (Join-Path $distributionDir 'python_embeded\python.exe'),
        (Join-Path $distributionDir 'python_embedded\python.exe'),
        (Join-Path $path '.venv\Scripts\python.exe'),
        (Join-Path $path 'venv\Scripts\python.exe'),
        (Join-Path $distributionDir '.venv\Scripts\python.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($saved -and ($saved.comfy -eq $path -or (-not $saved.comfy -and $destination -eq $pluginDir)) -and $saved.python -and
        (Test-Path -LiteralPath $saved.python -PathType Leaf)) { $pythonBox.Text = $saved.python }
    elseif ($detected.Count) { $pythonBox.Text = $detected[0] }
}
Set-ComfyDirectory $comfyDir
$targetButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择 ComfyUI 主目录、custom_nodes 或整合包目录'
    $dialog.ShowNewFolderButton = $false
    if ($comfyDir) { $dialog.SelectedPath = $comfyDir }
    try {
        if ($dialog.ShowDialog($form) -eq 'OK') {
            $path = $dialog.SelectedPath
            if ((Split-Path -Leaf $path) -eq 'custom_nodes') { $path = Split-Path -Parent $path }
            $selected = Find-ComfyDirectory $path
            if ($selected) { Set-ComfyDirectory $selected }
            else { [Windows.Forms.MessageBox]::Show('没有找到有效的 ComfyUI 主目录。', '小珠光安装器') | Out-Null }
        }
    } finally { $dialog.Dispose() }
})
$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = 'Vertical'
$logBox.SetBounds(18, 169, 662, 254); $logBox.Anchor = 'Top,Bottom,Left,Right'
$logBox.Text = "确认目标目录和 Python，点击检查或安装。`r`n安装前请关闭 ComfyUI。目标已有插件时，仅为已安装版本补齐依赖。"
$form.Controls.Add($logBox)
$status = New-Object System.Windows.Forms.Label
$status.SetBounds(18, 438, 662, 24); $status.Anchor = 'Bottom,Left,Right'; $status.Text = '就绪'
$form.Controls.Add($status)
$script:worker = $null
$script:lastText = ''
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250

function Read-SharedText($path) {
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    $stream = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose(); $stream.Dispose() }
}
function Set-Busy($busy) {
    foreach ($control in @($targetButton, $pythonBox, $browse, $sourceBox, $customBox, $profileBox, $checkButton, $installButton)) {
        $control.Enabled = -not $busy
    }
}
function Start-JobProcess($action) {
    try {
        if (-not $destination) { throw '请先选择 ComfyUI 主目录。' }
        $engine = Join-Path $PSScriptRoot 'engine.py'
        $script:deploy = $false
        if ($destination -ne $pluginDir) {
            if (Test-Path -LiteralPath $destination) {
                $engine = Join-Path $destination 'installer\engine.py'
                if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) {
                    throw ('目标目录已存在，但缺少依赖安装脚本：' + $destination)
                }
            } else { $script:deploy = $action -eq 'install' }
        }
        $python = $pythonBox.Text.Trim()
        if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw '请选择有效的 ComfyUI Python 程序。' }
        if ([IO.Path]::GetFileName($python) -ne 'python.exe') { throw '请选择 python.exe。' }
        $sources = @('auto', 'official', 'tsinghua', 'aliyun', 'custom')
        $profile = 'base'; if ($profileBox.SelectedIndex -eq 1) { $profile = 'full' }
        $argsList = @('-u', $engine, '--action', $action,
            '--source', $sources[$sourceBox.SelectedIndex], '--profile', $profile)
        if ($sourceBox.SelectedIndex -eq 4) {
            $address = $customBox.Text.Trim()
            if (-not $address.StartsWith('https://')) { throw '自定义源需填写 HTTPS 地址。' }
            $argsList += @('--custom', $address)
        }
        foreach ($arg in $argsList) { if ($arg -match '["\r\n]') { throw '输入包含不支持的字符。' } }
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        @{ comfy=$comfyDir; python=$python; source=$sourceBox.SelectedIndex; custom=$customBox.Text; profile=$profileBox.SelectedIndex } |
            ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $script:outPath = Join-Path $stateDir ($stamp + '.log')
        $script:errPath = Join-Path $stateDir ($stamp + '.stderr.log')
        $quoted = ($argsList | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $script:worker = Start-Process -FilePath $python -ArgumentList $quoted -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $script:outPath -RedirectStandardError $script:errPath
        $null = $script:worker.Handle
        $script:lastText = ''; Set-Busy $true
        $status.Text = '正在处理…'; $timer.Start()
    } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message, '小珠光安装器') | Out-Null }
}
function Install-Plugin {
    $customNodes = Split-Path -Parent $destination
    $stage = Join-Path $customNodes ('.xiaozhuguang-' + [guid]::NewGuid().ToString('N') + '.disabled')
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        if ((Get-Item -LiteralPath $pluginDir).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw '请从实际解压目录运行安装器。'
        }
        & robocopy.exe $pluginDir $stage /E /XJ /SL /R:0 /W:0 /XD .git .github .agents .codex .aws .vscode .idea test tests __pycache__ node_modules .venv dist | Out-Null
        if ($LASTEXITCODE -ge 8) { throw '复制插件失败，请检查目标目录权限和剩余空间。' }
        [IO.Directory]::Move($stage, $destination)
    } finally {
        if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
    }
}
$timer.Add_Tick({
    try {
        $text = (Read-SharedText $script:outPath) + (Read-SharedText $script:errPath)
        if ($text -ne $script:lastText) {
            $logBox.Text = $text.Replace("`r`n", "`n").Replace("`n", "`r`n")
            $logBox.SelectionStart = $logBox.TextLength; $logBox.ScrollToCaret(); $script:lastText = $text
        }
        if ($script:worker -and $script:worker.HasExited) {
            $timer.Stop(); $code = $script:worker.ExitCode
            $status.Text = '完成；日志：' + $script:outPath
            $script:worker.Dispose(); $script:worker = $null; Set-Busy $false
            if ($code -ne 0) { $status.Text = '未完成，请查看日志；可切换下载源重试。' }
            elseif ($script:deploy) {
                Install-Plugin
                $status.Text = '插件和依赖安装完成。'
                $logBox.AppendText("`r`n插件已安装到：$destination")
            }
        }
    } catch { $status.Text = $_.Exception.Message }
})
$checkButton.Add_Click({ Start-JobProcess 'check' })
$installButton.Add_Click({ Start-JobProcess 'install' })
$form.Add_FormClosing({
    if ($script:worker -and -not $script:worker.HasExited) {
        $_.Cancel = $true
        [Windows.Forms.MessageBox]::Show('安装正在进行，请等待完成后关闭。', '小珠光安装器') | Out-Null
    }
})
if ($ValidateOnly) {
    Write-Output ('UI OK; target: ' + $destination + '; detected Python environments: ' + $detected.Count)
    $timer.Dispose(); $form.Dispose(); exit 0
}
try { [void]$form.ShowDialog() } finally { $timer.Dispose(); $form.Dispose() }
