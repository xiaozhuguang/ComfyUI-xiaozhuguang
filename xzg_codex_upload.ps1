param(
    [ValidateSet("codex", "doubao")][string]$Target = "codex",
    [long]$SourceWindow = 0
)
$targetLabel = if ($Target -eq "doubao") { "豆包" } else { "Codex" }
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public static class XzgCodexWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public INPUTDATA data; }
    [StructLayout(LayoutKind.Explicit)] private struct INPUTDATA {
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public MOUSEINPUT mouse;
    }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT {
        public ushort key, scan; public uint flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT {
        public int x, y; public uint data, flags, time; public UIntPtr extra;
    }
    private delegate bool EnumWindowCallback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    public static IntPtr[] FindWindows(int[] processes) {
        var result = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            uint process;
            GetWindowThreadProcessId(hwnd, out process);
            if (!IsWindowVisible(hwnd) || Array.IndexOf(processes, (int)process) < 0) return true;
            var name = new StringBuilder(256);
            GetClassName(hwnd, name, name.Capacity);
            if (name.ToString() != "#32770") result.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public static bool IsForeground(IntPtr target) { return GetForegroundWindow() == target; }
    public static bool Paste() {
        INPUT[] inputs = new INPUT[4];
        for (int i = 0; i < inputs.Length; i++) inputs[i].type = 1;
        inputs[0].data.keyboard.key = inputs[3].data.keyboard.key = 0x11;
        inputs[1].data.keyboard.key = inputs[2].data.keyboard.key = 0x56;
        inputs[2].data.keyboard.flags = inputs[3].data.keyboard.flags = 2;
        if (SendInput(4, inputs, Marshal.SizeOf(typeof(INPUT))) == 4) return true;
        SendInput(2, new INPUT[] { inputs[2], inputs[3] }, Marshal.SizeOf(typeof(INPUT)));
        return false;
    }
}
'@
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($nativeSource))).Replace('-', '')
    } finally { $hasher.Dispose() }
    $assemblyPath = Join-Path ([IO.Path]::GetTempPath()) ("xzg-clipboard-" + [IntPtr]::Size + "-" + $digest + ".dll")
    if (Test-Path -LiteralPath $assemblyPath) {
        Add-Type -Path $assemblyPath
    } else {
        $buildPath = Join-Path ([IO.Path]::GetTempPath()) ("xzg-clipboard-" + [Guid]::NewGuid().ToString('N') + ".dll")
        try {
            Add-Type -TypeDefinition $nativeSource -OutputAssembly $buildPath
            Copy-Item -LiteralPath $buildPath -Destination $assemblyPath -Force
            Add-Type -Path $assemblyPath
        } finally {
            if (Test-Path -LiteralPath $buildPath) { Remove-Item -LiteralPath $buildPath }
        }
    }
    $originalWindow = if ($SourceWindow -ne 0) { [IntPtr]$SourceWindow } else { [XzgCodexWindow]::GetForegroundWindow() }
    $handle = [IntPtr]::Zero

    function Restore-SourceWindow($source, $target) {
        if ($source -eq [IntPtr]::Zero -or $source -eq $target -or ![XzgCodexWindow]::IsWindow($source)) { return }
        # Do not steal focus if the user switched to another app during the operation.
        if ([XzgCodexWindow]::IsForeground($target)) {
            [void][XzgCodexWindow]::SetForegroundWindow($source)
        }
    }

    function Test-ComposerCandidate($element, $windowBounds) {
        $current = $element.Current
        $bounds = $current.BoundingRectangle
        return (!$current.IsOffscreen -and $current.IsEnabled -and $current.IsKeyboardFocusable -and
            !$current.IsPassword -and $current.Name -notmatch '(?i)search|find|搜索|查找' -and
            $bounds.Width -ge 100 -and $bounds.Height -ge 20 -and
            $bounds.Top -ge ($windowBounds.Top + $windowBounds.Height * 0.5))
    }

    function Paste-DoubaoFocus {
        if (![XzgCodexWindow]::IsForeground($handle)) {
            throw "豆包不是当前前台窗口，未执行粘贴，请在豆包聊天框按 Ctrl+V。"
        }
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused -and ($focused.Current.IsPassword -or
            $focused.Current.Name -match '(?i)search|find|搜索|查找')) {
            throw "当前焦点是搜索或密码输入框，未执行粘贴，请点击豆包聊天框后按 Ctrl+V。"
        }
        if (![XzgCodexWindow]::IsForeground($handle)) {
            throw "前台窗口已切换，未执行粘贴，请在豆包聊天框按 Ctrl+V。"
        }
        if (![XzgCodexWindow]::Paste()) {
            throw "Windows 未接受粘贴按键，请在豆包聊天框按 Ctrl+V。"
        }
    }

    function Test-CodexComposer($element) {
        if ($null -eq $element -or $element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { return $false }
        return (!$element.Current.IsOffscreen -and $element.Current.IsEnabled -and $element.Current.IsKeyboardFocusable -and !$element.Current.IsPassword -and
                    ($element.Current.Name -match '(?i)^(Work with (Codex|ChatGPT)|Ask Codex|Message Codex|Message ChatGPT|Ask ChatGPT|与\s*Codex\s*协作|向\s*(Codex|ChatGPT)\s*(提问|发送消息)|Ask anything|Message|输入消息|发送消息|询问任何问题|有问题，尽管问|发消息|给豆包发送消息|和豆包聊聊|输入你想聊的内容|有什么可以帮忙的|你想聊些什么|描述任务|What would you like to do|Describe a task|Describe a new image|描述新图像|描述一张新图片)([\s.…。?!？!，,]|$)' -or
                     $element.Current.AutomationId -match '(?i)^(prompt-textarea|chat-input|composer-input)$'))
    }

    function Paste-Files($element) {
        if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit -or
            !$element.Current.IsKeyboardFocusable) {
            throw "未找到可聚焦的聊天输入框，请在 ${targetLabel} 输入框按 Ctrl+V。"
        }
        if (!$element.Current.HasKeyboardFocus) { $element.SetFocus() }
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        while ([DateTime]::UtcNow -lt $deadline -and !$element.Current.HasKeyboardFocus) {
            Start-Sleep -Milliseconds 50
        }
        if (!$element.Current.HasKeyboardFocus -or ![XzgCodexWindow]::IsForeground($handle)) {
            throw "无法确认 ${targetLabel} 输入框焦点，请切到目标聊天并按 Ctrl+V。"
        }
        if (![XzgCodexWindow]::Paste()) {
            throw "Windows 未接受粘贴按键，请在 ${targetLabel} 输入框按 Ctrl+V。"
        }
    }

    $files = @(ConvertFrom-Json ([Console]::In.ReadToEnd()))
    if (!$files.Count) { throw '未选择素材文件。' }
    $fileList = New-Object System.Collections.Specialized.StringCollection
    foreach ($file in $files) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw '素材文件不存在，请重新选择。' }
        [void]$fileList.Add([System.IO.Path]::GetFullPath($file))
    }
    $copied = $false
    try {
        $processNames = if ($Target -eq "doubao") { @("Doubao", "豆包") } else { @("Codex", "ChatGPT") }
        $processes = @(Get-Process -Name $processNames -ErrorAction SilentlyContinue | Where-Object {
            if ($Target -eq 'doubao') {
                $_.ProcessName -match '^(Doubao|豆包)$' -and
                $_.Path -match '(?i)[\\/](Doubao|豆包)\.exe$'
            } else {
                ($_.ProcessName -match '^(Codex|ChatGPT)$') -and
                ($_.Path -match '(?i)([\\/]OpenAI\.(Codex|ChatGPT)[_\\/]|[\\/](Codex|ChatGPT)[\\/]|[\\/](Codex|ChatGPT)\.exe$)')
            }
        })
        $windows = @([XzgCodexWindow]::FindWindows([int[]]@($processes.Id)))
        if ($windows.Count -ne 1) {
            throw "请打开唯一的 ${targetLabel} 目标聊天窗口，在输入框按 Ctrl+V。"
        }
        $handle = $windows[0]
        if ([XzgCodexWindow]::IsIconic($handle)) { [void][XzgCodexWindow]::ShowWindowAsync($handle, 9) }
        [void][XzgCodexWindow]::SetForegroundWindow($handle)
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        Add-Type -AssemblyName System.Windows.Forms
        # CF_HDROP is the actual file-copy format, not text containing file paths.
        $data = New-Object System.Windows.Forms.DataObject
        $data.SetFileDropList($fileList)
        $copyEffect = New-Object System.IO.MemoryStream(,([byte[]]@(1, 0, 0, 0)))
        $data.SetData('Preferred DropEffect', $copyEffect)
        try {
            [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 5, 100)
            $copied = $true
        } finally {
            $copyEffect.Dispose()
        }
        $foregroundDeadline = [DateTime]::UtcNow.AddMilliseconds(600)
        while (![XzgCodexWindow]::IsForeground($handle) -and [DateTime]::UtcNow -lt $foregroundDeadline) {
            Start-Sleep -Milliseconds 25
        }
        if ($Target -eq "doubao") {
            Paste-DoubaoFocus
        } else {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            $editCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
            $deadline = [DateTime]::UtcNow.AddSeconds(8)
            $editors = @()
            $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
            if ($null -ne $focused -and $focused.Current.HasKeyboardFocus -and (Test-CodexComposer $focused)) {
                $editors = @($focused)
            }
            while ($editors.Count -ne 1 -and [DateTime]::UtcNow -lt $deadline) {
                $allEditors = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition))
                $editors = @($allEditors | Where-Object { Test-CodexComposer $_ })
                if ($editors.Count -eq 0) {
                    $windowBounds = $root.Current.BoundingRectangle
                    $candidates = @($allEditors | Where-Object {
                        Test-ComposerCandidate $_ $windowBounds
                    })
                    if ($candidates.Count -eq 1) { $editors = $candidates }
                }
                if ($editors.Count -eq 1) { break }
                Start-Sleep -Milliseconds 200
            }
            if ($editors.Count -ne 1) {
                throw "未能定位 ${targetLabel} 聊天输入框，请在目标输入框按 Ctrl+V。"
            }
            Paste-Files $editors[0]
        }
        # Give the composer time to process the paste event before returning focus.
        Start-Sleep -Milliseconds 250
        [Console]::Write('{"ok":true,"copied":true,"pasted":true,"verified":false}')
    } catch {
        [Console]::Write((@{ok = $copied; copied = $copied; pasted = $false; verified = $false; warning = $_.Exception.Message} | ConvertTo-Json -Compress))
    } finally {
        Restore-SourceWindow $originalWindow $handle
    }
} catch {
    [Console]::Write((@{ok = $false; error = $_.Exception.Message} | ConvertTo-Json -Compress))
    exit 1
}
