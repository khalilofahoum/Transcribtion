# Creates the "Transcriber" icon on the desktop, pointing at this copy of the app.
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $desktop 'Transcriber.lnk'))
$link.TargetPath = Join-Path $root 'Transcriber.bat'
$link.WorkingDirectory = $root
$link.IconLocation = (Join-Path $root 'windows\transcriber.ico') + ',0'
$link.WindowStyle = 7
$link.Description = 'Record a conversation and get corrected text'
$link.Save()
Write-Host "Desktop icon created: $(Join-Path $desktop 'Transcriber.lnk')"
