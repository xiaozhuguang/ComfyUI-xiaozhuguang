$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $files = ConvertFrom-Json ([Console]::In.ReadToEnd())
    if (!$files.Count) { throw '未选择素材文件。' }
    $fileList = New-Object System.Collections.Specialized.StringCollection
    foreach ($file in $files) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw '素材文件不存在，请重新选择。' }
        [void]$fileList.Add([System.IO.Path]::GetFullPath($file))
    }
    Add-Type -AssemblyName System.Windows.Forms
    $data = New-Object System.Windows.Forms.DataObject
    $data.SetFileDropList($fileList)
    $copyEffect = New-Object System.IO.MemoryStream(,([byte[]]@(1, 0, 0, 0)))
    $data.SetData('Preferred DropEffect', $copyEffect)
    try {
        # Persistent CF_HDROP data survives this helper process exiting.
        [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
    } finally {
        $copyEffect.Dispose()
    }
    [Console]::Write('{"ok":true,"copied":true}')
} catch {
    [Console]::Write((@{ok = $false; error = $_.Exception.Message} | ConvertTo-Json -Compress))
    exit 1
}
