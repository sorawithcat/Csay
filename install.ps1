[CmdletBinding()]
param(
    [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'Csay'),
    [switch]$NoPath,
    [switch]$NoAssociation
)

$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
$NodeVersion = 'v24.19.0'
$NodeUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"

function Write-Step([string]$Text) {
    Write-Host "[Csay] $Text" -ForegroundColor Cyan
}

function Test-Node([string]$Exe) {
    try {
        $v = & $Exe --version 2>$null
        return ($v -match '^v(\d+)\.')
    } catch {
        return $false
    }
}

Write-Step "安装目录：$Prefix"

$required = @('src\cli.ts', 'tools\tcc\tcc.exe', 'selfhost\编译器.csay')
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $rel))) {
        throw "安装包不完整：缺少 $rel"
    }
}

New-Item -ItemType Directory -Force -Path $Prefix | Out-Null

# 复制编译器、文档与工具。node_modules 不需要，项目没有运行时依赖。
foreach ($item in @('src', 'tools', 'docs', 'selfhost', 'examples', 'tests')) {
    $from = Join-Path $Source $item
    if (-not (Test-Path -LiteralPath $from)) { continue }
    $to = Join-Path $Prefix $item
    if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
    Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
}
foreach ($file in @('package.json', 'README.md', 'tsconfig.json', '编辑器.bat')) {
    $from = Join-Path $Source $file
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $Prefix -Force }
}

# 选择 Node：优先使用系统 Node 22+，否则下载官方便携版。
$nodeExe = $null
$nodeFlags = ''
$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $sysNode -and (Test-Node $sysNode.Source)) {
    $major = [int]((& $sysNode.Source --version).Trim().Substring(1).Split('.')[0])
    if ($major -ge 22) {
        $nodeExe = $sysNode.Source
        if ($major -lt 23) { $nodeFlags = '--experimental-strip-types' }
        Write-Step "使用系统 Node：$nodeExe"
    }
}

if ($null -eq $nodeExe) {
    $nodeDir = Join-Path $Prefix 'node'
    $nodeExe = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        Write-Step "未找到 Node 22+，正在下载便携版 Node $NodeVersion ..."
        $zip = Join-Path $env:TEMP "csay-node-$NodeVersion.zip"
        try {
            Invoke-WebRequest -Uri $NodeUrl -OutFile $zip -UseBasicParsing
        } catch {
            throw "Node 下载失败。请先安装 Node.js 22 或更高版本后重试：https://nodejs.org/"
        }
        $tmp = Join-Path $env:TEMP "csay-node-$NodeVersion"
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
        $found = Get-ChildItem -LiteralPath $tmp -Filter node.exe -Recurse | Select-Object -First 1
        if ($null -eq $found) { throw "Node 压缩包中没有 node.exe" }
        New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
        Copy-Item -LiteralPath $found.FullName -Destination $nodeExe -Force
        Copy-Item -LiteralPath (Join-Path $found.Directory.FullName 'node_modules') -Destination $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Step "已安装便携版 Node：$nodeExe"
}

# 启动器
$bin = Join-Path $Prefix 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$launcher = Join-Path $bin 'csay.cmd'
$nodeCommand = 'node'
if ($nodeExe -like "$Prefix*") { $nodeCommand = '"%~dp0..\node\node.exe"' }
$launcherText = @"
@echo off
setlocal
chcp 65001 >nul
$nodeCommand $nodeFlags "%~dp0..\src\cli.ts" %*
"@
Set-Content -LiteralPath $launcher -Value $launcherText -Encoding ASCII
$editorLauncher = Join-Path $bin 'csay-editor.cmd'
$editorText = @"
@echo off
setlocal
chcp 65001 >nul
$nodeCommand $nodeFlags "%~dp0..\tools\editor.mjs" %*
"@
Set-Content -LiteralPath $editorLauncher -Value $editorText -Encoding ASCII

# 用户 PATH
if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($userPath) { $parts = $userPath.Split(';') | Where-Object { $_ -ne '' } }
    if ($parts -notcontains $bin) {
        $newPath = (@($parts) + $bin) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Step "已把 $bin 加入用户 PATH（新开终端生效）"
    }
}

# .csay 文件关联
if (-not $NoAssociation) {
    $classes = 'HKCU:\Software\Classes'
    New-Item -Path (Join-Path $classes '.csay') -Force | Out-Null
    Set-ItemProperty -Path (Join-Path $classes '.csay') -Name '(default)' -Value 'Csay.Source'
    $prog = Join-Path $classes 'Csay.Source'
    New-Item -Path $prog -Force | Out-Null
    Set-ItemProperty -Path $prog -Name '(default)' -Value 'Csay 源文件'
    $cmd = Join-Path $prog 'shell\open\command'
    New-Item -Path $cmd -Force | Out-Null
    Set-ItemProperty -Path $cmd -Name '(default)' -Value "`"$launcher`" `"%1`""
    $icon = Join-Path $prog 'DefaultIcon'
    New-Item -Path $icon -Force | Out-Null
    Set-ItemProperty -Path $icon -Name '(default)' -Value "$launcher,0"
    Write-Step "已关联 .csay 文件"
}

# 开始菜单快捷方式
try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Csay 编辑器.lnk'
    $shortcut = $shell.CreateShortcut($lnk)
    $shortcut.TargetPath = $editorLauncher
    $shortcut.WorkingDirectory = $Prefix
    $shortcut.Description = 'Csay 语言编辑器'
    $shortcut.Save()
    Write-Step "已创建开始菜单快捷方式"
} catch {
    Write-Warning "开始菜单快捷方式创建失败，不影响使用：$_"
}

Write-Host ''
Write-Step '安装完成。'
Write-Host "  csay 你的程序.csay       编译并运行"
Write-Host "  csay-editor              打开编辑器"
Write-Host "  文档：$Prefix\docs\手册"
Write-Host "  如需卸载：运行安装包中的 卸载Csay.bat"
