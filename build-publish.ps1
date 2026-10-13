# ============================================================
#  Remote Commander 一键打包 + 发布到 GitHub Releases
#  用法：
#    .\build-publish.ps1 -Version 1.13.0 # 指定版本发布（双平台，推荐）
#    .\build-publish.ps1                 # 自动 patch+1 版本并发布
#    .\build-publish.ps1 -WinOnly        # 只打 Windows 安装包
#    .\build-publish.ps1 -SkipBuild      # 跳过构建，仅上传现有产物
#  前置：已安装 gh CLI 并登录（gh auth status 可查）
#
#  Windows 产物为 NSIS 安装包 RemoteCommander-Setup-<ver>.exe，
#  同时生成 latest.yml（electron-updater 自动更新索引）。
#  若更新源放在 OSS / 内网，请把 latest.yml 与安装包一并拷贝到该更新源目录。
# ============================================================
param(
    [string]$Version = '',
    [string]$Notes = '',
    [switch]$WinOnly,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$Repo = 'WilliAMXOx/remote-commander'
$Root = 'C:\Users\10257\Desktop\remote-commander'
Set-Location $Root

# ---------- 环境：代理（GitHub 国内访问，自动探测常见代理端口）+ Electron 镜像 ----------
$proxyPorts = 7897, 7890, 1080, 8889, 10809, 10808, 8080, 33210, 9910
$proxyPort = $null
foreach ($p in $proxyPorts) {
    $t = New-Object System.Net.Sockets.TcpClient
    try {
        if ($t.ConnectAsync('127.0.0.1', $p).Wait(500)) { $proxyPort = $p; break }
    } catch { }
    $t.Dispose()
}
if ($proxyPort) {
    $env:HTTPS_PROXY = "http://127.0.0.1:$proxyPort"
    $env:HTTP_PROXY  = "http://127.0.0.1:$proxyPort"
    Write-Host "[代理] 自动探测到本地代理 127.0.0.1:$proxyPort"
} else {
    Write-Host '[提示] 未检测到本地代理，尝试直连 GitHub'
}
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# ---------- gh 登录检查 ----------
gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'gh 未登录，请先运行 gh auth login'
    exit 1
}

# ---------- 读取旧版本 / 计算新版本 ----------
$pkgPath = Join-Path $Root 'package.json'
$pkgRaw = [IO.File]::ReadAllText($pkgPath, (New-Object Text.UTF8Encoding $false))
$old = ($pkgRaw | ConvertFrom-Json).version
if ($Version) { $new = $Version }
else {
    $parts = $old.Split('.')
    $new = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
}
Write-Host "====================="
Write-Host "旧版本: $old"
Write-Host "新版本: $new"
Write-Host "====================="
if (-not $env:RC_YES) {
    $confirm = Read-Host "确认发布版本 $new ？回车继续 / 输入其他内容取消"
    if ($confirm.Trim() -ne '') { Write-Host "已取消，未做任何改动。"; exit 0 }
}

# ---------- 更新 package.json 版本号（保留原格式，仅替换 version 字段） ----------
$pkgRaw = $pkgRaw -replace '("version"\s*:\s*")[^"]+(")', "`${1}$new`${2}"
[IO.File]::WriteAllText($pkgPath, $pkgRaw, (New-Object Text.UTF8Encoding $false))
Write-Host "[1/5] package.json 版本已更新为 $new"

# ---------- 更新 index.html 版本号（CURRENT_VERSION + 启动横幅） ----------
$htmlPath = Join-Path $Root 'index.html'
$html = [IO.File]::ReadAllText($htmlPath, (New-Object Text.UTF8Encoding $false))
$html = $html -replace "CURRENT_VERSION = new URLSearchParams\(location\.search\)\.get\('appv'\) \|\| '[^']+'", "CURRENT_VERSION = new URLSearchParams(location.search).get('appv') || '$new'"
$html = $html -replace '远程操作系统 V[0-9]+\.[0-9]+\.[0-9]+', "远程操作系统 V$new"
[IO.File]::WriteAllText($htmlPath, $html, (New-Object Text.UTF8Encoding $false))
Write-Host "[2/5] index.html 版本号与启动横幅已更新"

# ---------- 更新 release-meta.json（版本/发布日/更新内容，驱动启动横幅动态日期） ----------
$metaPath = Join-Path $Root 'release-meta.json'
$metaNotes = if ($Notes) { $Notes } else { "Remote Commander V$new" }
$meta = @{ version = $new; date = Get-Date -Format 'yyyy-MM-dd'; notes = $metaNotes } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($metaPath, $meta, (New-Object Text.UTF8Encoding $false))
Write-Host "[2.5/6] release-meta.json 已更新（发布日 $((Get-Date).ToString('yyyy-MM-dd'))）"

$setupName = "RemoteCommander-Setup-$new.exe"
$setupPath = Join-Path $Root "dist\$setupName"
$ymlPath   = Join-Path $Root 'dist\latest.yml'

# ---------- 构建（可跳过） ----------
if (-not $SkipBuild) {
    New-Item -ItemType Directory -Force (Join-Path $Root 'dist\build-logs') | Out-Null
    Remove-Item (Join-Path $Root 'dist\build-logs\build-win.log') -Force -ErrorAction SilentlyContinue
    Remove-Item $setupPath -Force -ErrorAction SilentlyContinue
    Remove-Item $ymlPath -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Root 'dist\win-unpacked') -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "[3/5] 构建 Windows NSIS 安装包 ..."
    npx electron-builder --win nsis --config.npmRebuild=false *>&1 | Out-File -Encoding utf8 (Join-Path $Root 'dist\build-logs\build-win.log')
    if ($LASTEXITCODE -ne 0) { Write-Error "Windows 构建失败，见 dist\build-logs\build-win.log"; exit 1 }
    Write-Host "      安装包完成: $([math]::Round((Get-Item $setupPath).Length / 1MB, 1)) MB"

    if (-not $WinOnly) {
        Remove-Item (Join-Path $Root 'dist\build-logs\build-linux.log') -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $Root 'dist\*.AppImage') -Force -ErrorAction SilentlyContinue

        Write-Host "[3b/5] 构建 Linux AppImage x64 ..."
        npx electron-builder --linux AppImage --config.npmRebuild=false *>&1 | Out-File -Encoding utf8 (Join-Path $Root 'dist\build-logs\build-linux.log')
        if ($LASTEXITCODE -ne 0) { Write-Error "Linux 构建失败，见 dist\build-logs\build-linux.log"; exit 1 }
        $appImage = Get-ChildItem (Join-Path $Root 'dist\*.AppImage') | Select-Object -First 1
        Write-Host "      Linux AppImage 完成: $([math]::Round($appImage.Length / 1MB, 1)) MB"
    }
}

# ---------- 生成 version.json（浏览器/旧版手动检查仍用） ----------
$base = "https://github.com/$Repo/releases/download/v$new"
$linuxPkg = if ($WinOnly) { "" } else { (Get-ChildItem (Join-Path $Root "dist\*.AppImage") | Select-Object -First 1).Name }
$vj = @{
    version  = $new
    url      = "$base/$setupName"
    linuxUrl = if ($WinOnly) { "" } else { "$base/$linuxPkg" }
    notes    = "Remote Commander V$new"
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $Root 'dist\version.json'), $vj, (New-Object Text.UTF8Encoding $false))
Write-Host "[4/6] version.json 已生成"

# ---------- 同步内网更新源 updates/ ----------
$updDir = Join-Path $Root 'updates'
New-Item -ItemType Directory -Force $updDir | Out-Null
Copy-Item $ymlPath (Join-Path $updDir 'latest.yml') -Force
Copy-Item $setupPath (Join-Path $updDir $setupName) -Force
Copy-Item "$setupPath.blockmap" (Join-Path $updDir "$setupName.blockmap") -Force
Write-Host "[5/6] 内网更新目录 updates\ 已同步（latest.yml + 安装包 + blockmap）"

# ---------- 上传 GitHub Release ----------
$tag = "v$new"
# release 不存在时 gh 会向 stderr 输出 not found，Stop 策略下需 try/catch 包住，不能因此中断
$releaseExists = $false
try {
    gh release view $tag --repo $Repo 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $releaseExists = $true }
} catch { $releaseExists = $false }

$assets = @($setupPath, $ymlPath, (Join-Path $Root 'dist\version.json'), (Join-Path $Root 'dist\DownloadToUbuntu.sh'))
if (-not $WinOnly) { $assets += (Join-Path $Root "dist\$linuxPkg") }

if ($releaseExists) {
    Write-Host "[6/6] Release $tag 已存在，更新 GitHub 资产 ..."
    gh release upload $tag $assets --repo $Repo --clobber 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Error 'GitHub 上传资产失败'; exit 1 }
} else {
    Write-Host "[6/6] 创建 GitHub Release $tag 并上传 ..."
    $notesText = if ($Notes) { $Notes } else { "Remote Commander V$new" }
    gh release create $tag $assets --repo $Repo --title "V$new" --notes $notesText 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Error 'GitHub 创建 Release 失败'; exit 1 }
}

# ---------- 自动上传公网更新源（腾讯云 COS，需先 coscmd config 配好密钥） ----------
$coscmd = 'C:\Users\10257\AppData\Local\Python\pythoncore-3.14-64\Scripts\coscmd.exe'
$cosCfg = Join-Path $env:USERPROFILE '.coscmd.conf'
if ((Test-Path $coscmd) -and (Test-Path $cosCfg)) {
    Write-Host "[公网] 上传 latest.yml / 安装包 / blockmap 到腾讯云 COS ..."
    & $coscmd upload $ymlPath 'latest.yml' 2>&1
    & $coscmd upload $setupPath $setupName 2>&1
    & $coscmd upload "$setupPath.blockmap" "$setupName.blockmap" 2>&1
    Write-Host "[公网] COS 上传完成"
} else {
    Write-Host "[公网] 未配置 coscmd（缺 $cosCfg），跳过 COS 上传；请手动传 updates\ 里的三个文件到 COS 桶根目录。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "======================================================"
Write-Host "  发布完成！版本号: $new"
Write-Host "  GitHub Release: https://github.com/$Repo/releases/tag/$tag"
Write-Host "  内网更新源: http://192.168.3.92:8088/  (已自动同步)"
Write-Host "======================================================"
