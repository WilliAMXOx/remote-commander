# 启动内网更新服务器（双击或右键“使用 PowerShell 运行”）
# 首次运行会弹 UAC，用于添加 8088 端口防火墙入站规则（仅一次）
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$rule = Get-NetFirewallRule -DisplayName 'RC Update Server 8088' -ErrorAction SilentlyContinue
if (-not $rule) {
    Write-Host '首次运行：添加防火墙规则（需管理员，仅一次）...'
    $inner = "New-NetFirewallRule -DisplayName 'RC Update Server 8088' -Direction Inbound -Protocol TCP -LocalPort 8088 -Action Allow -Profile Private | Out-Null"
    Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',$inner -Wait
}

Write-Host '启动更新服务，关闭本窗口即停止服务...'
node (Join-Path $root 'serve-updates.js')
