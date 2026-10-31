$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# This fake never sends input or reads a desktop window.
Add-Type @'
using System;
public static class XzgCodexWindow {
    public static bool Foreground = true;
    public static bool AcceptInput = true;
    public static int Pastes = 0;
    public static bool SourceExists = true;
    public static int Restores = 0;
    public static IntPtr RestoredWindow;
    public static bool IsForeground(IntPtr target) { return Foreground; }
    public static bool IsWindow(IntPtr target) { return SourceExists; }
    public static bool SetForegroundWindow(IntPtr target) { Restores++; RestoredWindow = target; return true; }
    public static bool Paste() { Pastes++; return AcceptInput; }
}
'@
$sourcePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'xzg_codex_upload.ps1'
$parseTokens = $null
$parseErrors = $null
$sourceAst = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Upload script has syntax errors' }
$pasteFunction = $sourceAst.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Paste-Files'
}, $true)
Invoke-Expression $pasteFunction.Extent.Text
$restoreFunction = $sourceAst.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Restore-SourceWindow'
}, $true)
Invoke-Expression $restoreFunction.Extent.Text
$handle = [IntPtr]1

function New-FakeEditor($focusWorks = $true) {
    $element = [pscustomobject]@{
        FocusWorks = $focusWorks
        Current = [pscustomobject]@{
            IsKeyboardFocusable = $true
            HasKeyboardFocus = $false
            ControlType = [System.Windows.Automation.ControlType]::Edit
        }
    }
    $element | Add-Member ScriptMethod SetFocus { $this.Current.HasKeyboardFocus = $this.FocusWorks }
    return $element
}

$editor = New-FakeEditor
Paste-Files $editor
if ([XzgCodexWindow]::Pastes -ne 1) { throw 'Focused composer did not receive paste' }

$editor = New-FakeEditor $false
$blocked = $false
try { Paste-Files $editor } catch { $blocked = $true }
if (!$blocked -or [XzgCodexWindow]::Pastes -ne 1) { throw 'Unfocused composer received paste' }

[XzgCodexWindow]::Foreground = $false
$editor = New-FakeEditor
$blocked = $false
try { Paste-Files $editor } catch { $blocked = $true }
if (!$blocked -or [XzgCodexWindow]::Pastes -ne 1) { throw 'Another foreground app received paste' }

[XzgCodexWindow]::Foreground = $true
$editor = New-FakeEditor
$editor.Current.ControlType = [System.Windows.Automation.ControlType]::Button
$blocked = $false
try { Paste-Files $editor } catch { $blocked = $true }
if (!$blocked -or [XzgCodexWindow]::Pastes -ne 1) { throw 'Non-editor received paste' }

[XzgCodexWindow]::AcceptInput = $false
$editor = New-FakeEditor
$blocked = $false
try { Paste-Files $editor } catch { $blocked = $true }
if (!$blocked) { throw 'Rejected keyboard input was reported as success' }

'PASS: composer paste, failed focus, other foreground app, non-editor, rejected input'

[XzgCodexWindow]::Foreground = $true
Restore-SourceWindow ([IntPtr]2) ([IntPtr]1)
if ([XzgCodexWindow]::Restores -ne 1 -or [XzgCodexWindow]::RestoredWindow -ne [IntPtr]2) {
    throw 'Source window was not restored after paste'
}

[XzgCodexWindow]::Foreground = $false
Restore-SourceWindow ([IntPtr]2) ([IntPtr]1)
if ([XzgCodexWindow]::Restores -ne 1) { throw 'Restore stole focus from another app' }

[XzgCodexWindow]::Foreground = $true
[XzgCodexWindow]::SourceExists = $false
Restore-SourceWindow ([IntPtr]2) ([IntPtr]1)
if ([XzgCodexWindow]::Restores -ne 1) { throw 'Closed source window was activated' }

[XzgCodexWindow]::SourceExists = $true
Restore-SourceWindow ([IntPtr]::Zero) ([IntPtr]1)
Restore-SourceWindow ([IntPtr]1) ([IntPtr]1)
if ([XzgCodexWindow]::Restores -ne 1) { throw 'Invalid or identical source was activated' }

'PASS: return to source, preserve user focus change, closed source, invalid source, same window'

$candidateFunction = $sourceAst.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-ComposerCandidate'
}, $true)
Invoke-Expression $candidateFunction.Extent.Text
$windowBounds = [pscustomobject]@{Top = 100; Height = 800}
$candidate = [pscustomobject]@{Current = [pscustomobject]@{
    IsOffscreen = $false; IsEnabled = $true; IsKeyboardFocusable = $true; IsPassword = $false
    Name = ''; BoundingRectangle = [pscustomobject]@{Top = 650; Width = 600; Height = 100}
}}
if (!(Test-ComposerCandidate $candidate $windowBounds)) { throw 'Unnamed lower composer rejected' }
$candidate.Current.Name = '搜索'
if (Test-ComposerCandidate $candidate $windowBounds) { throw 'Search field accepted as composer' }
$candidate.Current.Name = ''
$candidate.Current.IsPassword = $true
if (Test-ComposerCandidate $candidate $windowBounds) { throw 'Password field accepted as composer' }
$candidate.Current.IsPassword = $false
$candidate.Current.IsOffscreen = $true
if (Test-ComposerCandidate $candidate $windowBounds) { throw 'Hidden field accepted as composer' }
$candidate.Current.IsOffscreen = $false
$candidate.Current.BoundingRectangle.Top = 200
if (Test-ComposerCandidate $candidate $windowBounds) { throw 'Upper toolbar field accepted as composer' }
'PASS: unnamed lower composer, reject search/password/hidden/upper field'

# Replace only the UIA focus read with a fake; do not inspect the live desktop.
$focusFunction = $sourceAst.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Paste-DoubaoFocus'
}, $true)
$focusText = $focusFunction.Extent.Text.Replace('[System.Windows.Automation.AutomationElement]::FocusedElement', '$global:fakeFocusedElement')
Invoke-Expression $focusText
[XzgCodexWindow]::AcceptInput = $true
[XzgCodexWindow]::Foreground = $true
$global:fakeFocusedElement = $null
$before = [XzgCodexWindow]::Pastes
Paste-DoubaoFocus
if ([XzgCodexWindow]::Pastes -ne $before + 1) { throw 'Doubao foreground without UIA editor did not receive paste' }
[XzgCodexWindow]::Foreground = $false
$blocked = $false
try { Paste-DoubaoFocus } catch { $blocked = $true }
if (!$blocked -or [XzgCodexWindow]::Pastes -ne $before + 1) { throw 'Other foreground app received paste' }
[XzgCodexWindow]::Foreground = $true
foreach ($focused in @(
    [pscustomobject]@{Current = [pscustomobject]@{Name = '搜索'; IsPassword = $false}},
    [pscustomobject]@{Current = [pscustomobject]@{Name = ''; IsPassword = $true}}
)) {
    $global:fakeFocusedElement = $focused
    $blocked = $false
    try { Paste-DoubaoFocus } catch { $blocked = $true }
    if (!$blocked -or [XzgCodexWindow]::Pastes -ne $before + 1) { throw 'Search/password field received paste' }
}
$global:fakeFocusedElement = $null
[XzgCodexWindow]::AcceptInput = $false
$blocked = $false
try { Paste-DoubaoFocus } catch { $blocked = $true }
if (!$blocked) { throw 'Rejected keyboard input reported as success' }
'PASS: Doubao foreground paste without UIA/caret, reject other app/search/password/failed input'

$composerFunction = $sourceAst.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-CodexComposer'
}, $true)
Invoke-Expression $composerFunction.Extent.Text
$composer = [pscustomobject]@{Current = [pscustomobject]@{
    ControlType = [System.Windows.Automation.ControlType]::Edit
    IsOffscreen = $false; IsEnabled = $true; IsKeyboardFocusable = $true; IsPassword = $false
    Name = 'Work with Codex'; AutomationId = ''
}}
if (!(Test-CodexComposer $composer)) { throw 'Codex composer was not recognized for fast paste' }
$composer.Current.Name = 'Search chats'
if (Test-CodexComposer $composer) { throw 'Search field accepted as Codex composer' }
$composer.Current.Name = ''
$composer.Current.AutomationId = 'prompt-textarea'
if (!(Test-CodexComposer $composer)) { throw 'Composer automation ID not recognized' }
$composer.Current.IsPassword = $true
if (Test-CodexComposer $composer) { throw 'Password field accepted as Codex composer' }
'PASS: Codex composer fast path, reject search/password field'
