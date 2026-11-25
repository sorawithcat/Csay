[CmdletBinding()]
param(
    [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'Csay')
)

$ErrorActionPreference = 'Stop'
$bin = Join-Path $Prefix 'bin'

Write-Host "[Csay] 卸载：$Prefix" -ForegroundColor Cyan

# 用户 PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
    $parts = $userPath.Split(';') | Where-Object { $_ -ne '' -and $_ -ne $bin }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
}

# 文件关联只删除 Csay 自己的项
$classes = 'HKCU:\Software\Classes'
if (Test-Path (Join-Path $classes '.csay')) {
    $current = (Get-ItemProperty -Path (Join-Path $classes '.csay')).'(default)'
    if ($current -eq 'Csay.Source') { Remove-Item -Path (Join-Path $classes '.csay') -Recurse -Force }
}
if (Test-Path (Join-Path $classes 'Csay.Source')) {
    Remove-Item -Path (Join-Path $classes 'Csay.Source') -Recurse -Force
}

# 开始菜单
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Csay 编辑器.lnk'
if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }

if (Test-Path -LiteralPath $Prefix) {
    Remove-Item -LiteralPath $Prefix -Recurse -Force
}
Write-Host "[Csay] 已卸载。已打开的终端可能需要重新启动。" -ForegroundColor Green
