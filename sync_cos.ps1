# Remote Commander - 本地同步 deb 到腾讯云 COS
# 用法: powershell -ExecutionPolicy Bypass -File sync_cos.ps1 -Version 1.14.5
# 说明: 从 GitHub Release 下载 deb，再用本机网络直连腾讯云 COS 上传（快，无需代理）。
# 密钥来源(按优先级): 环境变量 TENCENT_SECRET_ID / TENCENT_SECRET_KEY, 或本目录 cos_secret.txt(id=... / key=...)
param([Parameter(Mandatory=$true)][string]$Version)

$ErrorActionPreference = 'Stop'
$Repo   = 'WilliAMXOx/remote-commander'
$Bucket = 'ssh-remote-controller-1333945781'
$Region = 'ap-beijing'
$Base   = "https://ssh-remote-controller-1333945781.cos.ap-beijing.myqcloud.com"
$Root   = $PSScriptRoot

# ---- 读取腾讯云密钥 ----
$SecretId  = $env:TENCENT_SECRET_ID
$SecretKey = $env:TENCENT_SECRET_KEY
if([string]::IsNullOrEmpty($SecretId)){
  $sec = Join-Path $Root 'cos_secret.txt'
  if(Test-Path $sec){
    foreach($l in (Get-Content $sec)){
      if($l -match '^id\s*=\s*(.+)$'){ $SecretId = $matches[1] }
      if($l -match '^key\s*=\s*(.+)$'){ $SecretKey = $matches[1] }
    }
  }
}
if([string]::IsNullOrEmpty($SecretId)){
  throw "未设置腾讯云密钥：请设置环境变量 TENCENT_SECRET_ID / TENCENT_SECRET_KEY，或在 $Root\cos_secret.txt 填 id=... / key=..."
}

$Deb = "RemoteCommander-$Version.deb"
Write-Host "== 同步 v$Version 到 COS ==" -ForegroundColor Cyan

# 1) 从 GitHub Release 下载 deb（本地直连 GitHub）
Write-Host "[1/4] 从 GitHub Release 下载 $Deb ..."
$debLocal = Join-Path $Root $Deb
gh release download "v$Version" --repo $Repo --pattern "$Deb" --dir $Root --clobber
if(-not (Test-Path $debLocal)){ throw "下载失败: $debLocal" }
Write-Host "  已下载 $((Get-Item $debLocal).Length) 字节"

# 2) 上传 deb 到 COS
Write-Host "[2/4] 上传 $Deb 到 COS ..."
if(-not (Get-Command coscmd -ErrorAction SilentlyContinue)){ cmd /c "pip install coscmd >nul 2>&1" }
cmd /c "coscmd config -a $SecretId -s $SecretKey -b $Bucket -r $Region 2>&1"
cmd /c "coscmd upload $debLocal $Deb 2>&1"

# 3) 更新 latest-deb-version
Write-Host "[3/4] 更新 latest-deb-version ..."
$verFile = Join-Path $Root 'latest-deb-version'
[IO.File]::WriteAllText($verFile, $Version, (New-Object Text.UTF8Encoding $false))
cmd /c "coscmd upload $verFile latest-deb-version 2>&1"

# 4) 上传 DownloadToUbuntu.sh（一键安装脚本）
Write-Host "[4/4] 上传 DownloadToUbuntu.sh ..."
$sh = Join-Path $Root 'DownloadToUbuntu.sh'
if(Test-Path $sh){ cmd /c "coscmd upload $sh DownloadToUbuntu.sh 2>&1" }
else { Write-Host "  未找到 DownloadToUbuntu.sh，跳过" }

# 清理下载的 deb 临时文件
Remove-Item $debLocal -Force -ErrorAction SilentlyContinue
Remove-Item $verFile -Force -ErrorAction SilentlyContinue

Write-Host "完成！可访问: $Base/$Deb" -ForegroundColor Green
