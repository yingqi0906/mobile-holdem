<#
把本机的游戏临时发布到公网，方便发给朋友试玩。

原理：本地起一个静态服务器，再用 Cloudflare 的免费快速隧道
(trycloudflare.com) 把它映射成一个 https 地址。不需要注册任何账号。

用法：npm run share
停止：在这个窗口按任意键，或者直接关掉窗口

注意：链接只在"这台电脑开着 + 这个窗口还开着"期间有效。
想要一个永久地址，得部署到 GitHub Pages / Cloudflare Pages / Netlify 这类静态托管。
#>

param([int]$Port = 5173)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $env:LOCALAPPDATA 'holdem-share'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cfd = Join-Path $binDir 'cloudflared.exe'
if (-not (Test-Path $cfd)) {
  Write-Host '第一次运行，正在下载 cloudflared（约 50MB）…'
  Invoke-WebRequest -UseBasicParsing -OutFile $cfd `
    -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
}

$srvOut = Join-Path $binDir 'server.out.log'
$srvErr = Join-Path $binDir 'server.err.log'
$cfLog = Join-Path $binDir 'tunnel.log'
if (Test-Path $cfLog) { Remove-Item -LiteralPath $cfLog -Force }

Write-Host "启动本地服务器（端口 $Port）…"
$srv = Start-Process -FilePath 'node' -ArgumentList 'tools/serve.js' `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr

Start-Sleep -Seconds 2

Write-Host '建立公网隧道…'
$cf = Start-Process -FilePath $cfd -ArgumentList 'tunnel', '--url', "http://127.0.0.1:$Port" `
  -WindowStyle Hidden -PassThru -RedirectStandardError $cfLog

# 隧道分配地址要几秒钟，轮询日志把它抠出来
$url = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $cfLog) {
    $found = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' |
      Select-Object -First 1
    if ($found) {
      $url = $found.Matches[0].Value
      break
    }
  }
}

if (-not $url) {
  Write-Host '没能拿到公网地址。隧道日志：' $cfLog
  Stop-Process -Id $cf.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Host ''
Write-Host '  把这个网址发给朋友就能玩：' -ForegroundColor DarkGray
Write-Host "    $url" -ForegroundColor Green
Write-Host ''
Write-Host '  手机浏览器打开即可，可以「添加到主屏幕」。'
Write-Host '  按任意键停止分享…' -ForegroundColor DarkGray

$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

Stop-Process -Id $cf.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
Write-Host '已停止分享。'
