# Build with the .NET Framework compiler shipped with Windows (no .NET SDK needed).
# 产物：
#   DocBoxTrans.exe        主程序（GUI / 托盘）
#   DocBoxTransConfig.exe  配置界面（控制台，交互式修改 config.ini）
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw "Compiler not found: $csc" }

$refs = @(
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll',
    'System.Web.Extensions.dll',
    'System.Net.Http.dll'
) | ForEach-Object {
    $p = Join-Path $fw $_
    if (-not (Test-Path $p)) { throw "Missing reference assembly: $p" }
    '/r:' + $p
}

# 应用图标（与 Zotero 插件同款）：随 exe 内嵌为 Win32 图标，托盘运行时据此取帧
$icon = Join-Path $root 'DocBoxTrans.ico'
if (-not (Test-Path $icon)) { throw "Icon not found: $icon" }

# /codepage:65001 -> source files are UTF-8 (Chinese literals in the code)
$common = @('/nologo', '/platform:anycpu', '/optimize+', '/codepage:65001', ('/win32icon:' + $icon))

$allSources = Get-ChildItem (Join-Path $root 'src\*.cs') | ForEach-Object { $_.FullName }
$cliEntry = Join-Path $root 'src\ConfigCliMain.cs'
$cliCore = Join-Path $root 'src\ConfigCli.cs'
# 配置界面的两个文件只属于 DocBoxTransConfig.exe，不能混进主程序的编译
$mainSources = $allSources | Where-Object { $_ -ne $cliEntry -and $_ -ne $cliCore }

$out = Join-Path $root 'DocBoxTrans.exe'
& $csc $common ('/resource:' + $icon) /target:winexe "/out:$out" $refs $mainSources
if ($LASTEXITCODE -ne 0) { throw "Compile failed: DocBoxTrans.exe (exit=$LASTEXITCODE)" }
Write-Host ("Built: {0}  ({1:N0} bytes)" -f $out, (Get-Item $out).Length)

# 配置界面只依赖 AppConfig 与 ConfigCli
$outCli = Join-Path $root 'DocBoxTransConfig.exe'
$cliSources = @($cliEntry, $cliCore, (Join-Path $root 'src\AppConfig.cs'))
& $csc $common /target:exe "/out:$outCli" $refs $cliSources
if ($LASTEXITCODE -ne 0) { throw "Compile failed: DocBoxTransConfig.exe (exit=$LASTEXITCODE)" }
Write-Host ("Built: {0}  ({1:N0} bytes)" -f $outCli, (Get-Item $outCli).Length)
