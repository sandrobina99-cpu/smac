# smac 客机端一键安装、环境探测与主机自动连接脚本（Windows）
# 1. 安装并启动 OpenSSH Server、放行防火墙端口、写入主机专用公钥；
# 2. 部署客机环境探测器至 ~/.smac-guest 与 ~/.smac-agent；
# 3. 扫描客机本地 CLI 环境（Hermes / Codex / Claude / Antigravity / OpenCode）
#    与 Desktop 桌面端环境（DeepSeek Harness / Claude Desktop / Codex / Antigravity / Hermes / OpenCode / LM Studio 等）；
# 4. 自动向主机端发起连接注册并上报环境清单，同时生成兜底配对码。
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$PublicKey = '__SMAC_PUBLIC_KEY__'
$PairToken = '__SMAC_PAIR_TOKEN__'
$HostName  = '__SMAC_HOST_NAME__'
$HostEndpointsJson = '__SMAC_HOST_ENDPOINTS__'
$ZeroTierNetwork = '__SMAC_ZEROTIER_NETWORK__'

try { $Host.UI.RawUI.WindowTitle = 'smac 客机端一键安装与连接' } catch { }

function Line([string]$Text, [string]$Color) {
  if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
}
function Step([string]$Text) {
  Write-Host ''
  Write-Host ('== ' + $Text + ' ==') -ForegroundColor Cyan
}
function Finish {
  Write-Host ''
  if (-not $DryRun) { try { Read-Host '按回车键关闭窗口' } catch { } }
  exit
}

# ---------- 管理员权限 ----------
$elevated = $false
try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

if (-not $elevated -and -not $DryRun) {
  Write-Host '正在请求管理员权限，请在弹窗中点击「是」…' -ForegroundColor Yellow
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  } catch {
    Write-Host '没有获得管理员权限。请右键「一键安装客机端.cmd」，选择「以管理员身份运行」。' -ForegroundColor Red
    Finish
  }
  exit
}

# ---------- 识别当前客机登录账户 ----------
$loginName = $env:USERNAME
try {
  $consoleUser = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).UserName
  if ($consoleUser) { $loginName = ($consoleUser -split '\\')[-1] }
} catch { }

$loginProfile = $env:USERPROFILE
try {
  $acct = Get-CimInstance -ClassName Win32_UserAccount -Filter ("Name='" + $loginName.Replace("'", "''") + "' AND LocalAccount=True") -ErrorAction Stop | Select-Object -First 1
  if ($acct) {
    $profile = Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object { $_.SID -eq $acct.SID } | Select-Object -First 1
    if ($profile -and $profile.LocalPath -and (Test-Path -LiteralPath $profile.LocalPath)) { $loginProfile = $profile.LocalPath }
  }
} catch { }
if (-not (Test-Path -LiteralPath $loginProfile)) {
  $candidate = Join-Path $env:SystemDrive ('Users\' + $loginName)
  if (Test-Path -LiteralPath $candidate) { $loginProfile = $candidate }
}

Step '客机信息'
Line ('计算机名：' + $env:COMPUTERNAME)
Line ('登录用户名：' + $loginName)
Line ('用户目录：' + $loginProfile)
if ($HostName -and $HostName -ne ('__' + 'SMAC_HOST_NAME__')) {
  Line ('目标主机端：' + $HostName) Green
}

# ---------- 1. 安装并启动 OpenSSH Server ----------
Step '1/6 配置 OpenSSH 服务'
if (-not $DryRun) {
  $cap = $null
  try { $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction Stop | Select-Object -First 1 } catch { }
  if ($cap -and $cap.State -ne 'Installed') {
    Line '正在安装 Windows OpenSSH Server 组件…' Yellow
    try { Add-WindowsCapability -Online -Name $cap.Name | Out-Null } catch { }
  }
  if (-not (Get-Service -Name sshd -ErrorAction SilentlyContinue)) {
    Line '正在下载安装官方 Win32-OpenSSH…' Yellow
    try {
      $arch = if ([Environment]::Is64BitOperatingSystem) { 'Win64' } else { 'Win32' }
      $zip = Join-Path $env:TEMP ('OpenSSH-' + $arch + '.zip')
      Invoke-WebRequest -UseBasicParsing -Uri ('https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-' + $arch + '.zip') -OutFile $zip
      $dest = Join-Path $env:ProgramFiles 'OpenSSH'
      if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
      $inner = Get-ChildItem -LiteralPath $dest -Directory | Select-Object -First 1
      $root = if ($inner) { $inner.FullName } else { $dest }
      $installer = Join-Path $root 'Install-sshd.ps1'
      Push-Location $root
      try { & $installer } finally { Pop-Location }
    } catch {
      Line ('安装 OpenSSH 失败：' + $_.Exception.Message) Red
    }
  }
  Set-Service -Name sshd -StartupType Automatic
  if ((Get-Service -Name sshd).Status -ne 'Running') { Start-Service -Name sshd }
  Line ('sshd 服务状态：' + (Get-Service -Name sshd).Status) Green
}

# ---------- 2. SSH 配置与防火墙 ----------
Step '2/6 检查端口与防火墙'
$configPath = Join-Path $env:ProgramData 'ssh\sshd_config'
$port = 22
if (Test-Path -LiteralPath $configPath) {
  $lines = @(Get-Content -LiteralPath $configPath)
  foreach ($row in $lines) {
    if ($row -match '^\s*Port\s+(\d+)') { $port = [int]$matches[1] }
  }
  if (-not $DryRun) {
    $updated = $lines -replace '^\s*PubkeyAuthentication\s+no\s*$', 'PubkeyAuthentication yes'
    [IO.File]::WriteAllLines($configPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
  }
}
if (-not $DryRun) {
  $rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
  if (-not $rule) {
    try {
      New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort $port | Out-Null
    } catch { }
  }
}
Line ('SSH 端口：' + $port)

# ---------- 3. 写入主机端公钥 ----------
Step '3/6 写入主机端授权公钥'
function Add-KeyLine([string]$File, [string]$Key) {
  $dir = Split-Path -Parent $File
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $existing = ''
  if (Test-Path -LiteralPath $File) { $existing = [IO.File]::ReadAllText($File) }
  foreach ($row in ($existing -split "`r?`n")) {
    if ($row.Trim() -eq $Key) { return $false }
  }
  $prefix = ''
  if ($existing -and -not $existing.EndsWith("`n")) { $prefix = "`r`n" }
  [IO.File]::AppendAllText($File, $prefix + $Key + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  return $true
}

if (-not $DryRun -and $PublicKey -match '^ssh-(ed25519|rsa) ') {
  $keyLine = $PublicKey.Trim()
  $userKeyFile = Join-Path $loginProfile '.ssh\authorized_keys'
  $adminKeyFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
  try { Add-KeyLine $userKeyFile $keyLine | Out-Null } catch { }
  try {
    Add-KeyLine $adminKeyFile $keyLine | Out-Null
    if (Test-Path -LiteralPath $adminKeyFile) {
      & icacls.exe $adminKeyFile /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
      & icacls.exe $adminKeyFile /setowner '*S-1-5-32-544' | Out-Null
    }
  } catch { }
  try { Restart-Service -Name sshd -ErrorAction SilentlyContinue } catch { }
  Line '主机端公钥已写入并生效。' Green
}

# ---------- 4. 配置 ZeroTier 内网穿透组网（自动安装并加入同组） ----------
Step '4/6 配置 ZeroTier 内网穿透组网'
$ztNodeId = ''
$ztStatus = ''
$ztIp = ''
if (-not $DryRun -and $ZeroTierNetwork -match '^[0-9a-fA-F]{16}$') {
  $ztNwid = $ZeroTierNetwork.ToLower()
  function Find-ZeroTierExe {
    foreach ($p in @(
      'C:\Program Files (x86)\ZeroTier\One\zerotier-one_x64.exe',
      'C:\Program Files\ZeroTier\One\zerotier-one_x64.exe',
      'C:\ProgramData\ZeroTier\One\zerotier-one_x64.exe'
    )) {
      if (Test-Path -LiteralPath $p) { return $p }
    }
    return ''
  }
  $ztExe = Find-ZeroTierExe
  if (-not $ztExe) {
    Line ('未检测到 ZeroTier One，正在自动静默下载并安装以加入穿透组 ' + $ztNwid + ' …') Yellow
    try {
      $wg = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source
      if ($wg) {
        & $wg install --id ZeroTier.ZeroTierOne -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
        $ztExe = Find-ZeroTierExe
      }
      if (-not $ztExe) {
        $msi = Join-Path $env:TEMP 'ZeroTierOne.msi'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://download.zerotier.com/dist/ZeroTier%20One.msi' -OutFile $msi -TimeoutSec 60
        Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msi, '/qn', '/norestart') -Wait | Out-Null
        Start-Sleep -Seconds 3
        $ztExe = Find-ZeroTierExe
      }
    } catch {
      Line ('自动下载 ZeroTier 失败（不影响局域网连接）：' + $_.Exception.Message) Yellow
    }
  }
  if ($ztExe) {
    $ztSvc = Get-Service -Name 'ZeroTierOneService' -ErrorAction SilentlyContinue
    if ($ztSvc -and $ztSvc.Status -ne 'Running') {
      try { Start-Service -Name 'ZeroTierOneService' -ErrorAction SilentlyContinue } catch { }
      Start-Sleep -Seconds 2
    }
    Line ('正在加入 ZeroTier 组：' + $ztNwid + ' …') DarkGray
    try { & $ztExe -q join $ztNwid 2>&1 | Out-Null } catch { }
    for ($i = 0; $i -lt 7; $i++) {
      try {
        $infoOut = (& $ztExe -q info 2>&1 | Out-String)
        if ($infoOut -match '200\s+info\s+([0-9a-fA-F]{10})') { $ztNodeId = $Matches[1].ToLower() }
        $netsOut = (& $ztExe -q -j listnetworks 2>&1 | Out-String).Trim()
        if ($netsOut.StartsWith('[')) {
          $arr = $netsOut | ConvertFrom-Json
          $hit = @($arr | Where-Object { ([string]$_.nwid).ToLower() -eq $ztNwid -or ([string]$_.id).ToLower() -eq $ztNwid }) | Select-Object -First 1
          if ($hit) {
            $ztStatus = [string]$hit.status
            foreach ($a in @($hit.assignedAddresses)) {
              $cand = ([string]$a).Split('/')[0]
              if ($cand -match '^\d+\.\d+\.\d+\.\d+$') { $ztIp = $cand; break }
            }
          }
        }
      } catch { }
      if ($ztStatus -eq 'OK' -and $ztIp) { break }
      Start-Sleep -Seconds 1
    }
    if ($ztStatus -eq 'OK' -and $ztIp) {
      Line ('[OK] 已接入 ZeroTier 内网穿透组 ' + $ztNwid + '，分配 IP：' + $ztIp + '（节点：' + $ztNodeId + '）') Green
    } elseif ($ztStatus -eq 'ACCESS_DENIED') {
      Line ('[待授权] 本机 ZeroTier 节点 ' + $ztNodeId + ' 已申请加入组 ' + $ztNwid + '。') Yellow
      Line ('        请在 ZeroTier 控制台 (https://my.zerotier.com/network/' + $ztNwid + ') 勾选 Auth 授权该节点！') Yellow
    } else {
      Line ('已执行入组（节点：' + $ztNodeId + '，状态：' + $ztStatus + '）。') DarkGray
    }
  } else {
    Line '未安装 ZeroTier One，跳过内网穿透入组（稍后也可在主机控制台一键远程安装或手动安装 https://www.zerotier.com/download/）。' Yellow
  }
} else {
  Line '主机端未配置 ZeroTier 组号，跳过 ZeroTier 自动入组（将使用局域网 / Tailscale 连接）。' DarkGray
}

# ---------- 5. 部署客机端组件并探测本地 CLI 与 Desktop 环境 ----------
Step '5/6 检测客机本地 CLI 环境与 Desktop 桌面端环境'
$guestDir = Join-Path $loginProfile '.smac-guest'
$agentDir = Join-Path $loginProfile '.smac-agent'
New-Item -ItemType Directory -Force -Path $guestDir | Out-Null
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null

$envScriptSrc = Join-Path $PSScriptRoot 'guest-env.js'
if (Test-Path -LiteralPath $envScriptSrc) {
  Copy-Item -LiteralPath $envScriptSrc -Destination (Join-Path $guestDir 'guest-env.js') -Force
  Copy-Item -LiteralPath $envScriptSrc -Destination (Join-Path $agentDir 'guest-env.js') -Force
}
foreach ($gf in @('guest-server.js', 'guest.html', 'guest.css', 'guest.js', 'smac-guest.exe')) {
  $srcGf = Join-Path $PSScriptRoot $gf
  if (Test-Path -LiteralPath $srcGf) {
    Copy-Item -LiteralPath $srcGf -Destination (Join-Path $guestDir $gf) -Force
  }
}
try {
  $seedEps = @()
  if ($HostEndpointsJson -and $HostEndpointsJson.StartsWith('[')) {
    $seedEps = @($HostEndpointsJson | ConvertFrom-Json)
  }
  $hostProfileObj = [ordered]@{
    hostName          = if ($HostName -and $HostName -ne ('__' + 'SMAC_HOST_NAME__')) { $HostName } else { '' }
    publicKey         = if ($PublicKey -match '^ssh-') { $PublicKey.Trim() } else { '' }
    pairToken         = if ($PairToken -and $PairToken -ne ('__' + 'SMAC_PAIR_TOKEN__')) { $PairToken.Trim() } else { '' }
    endpoints         = $seedEps
    zerotierNetworkId = if ($ZeroTierNetwork -match '^[0-9a-fA-F]{16}$') { $ZeroTierNetwork.ToLower() } else { '' }
    connected         = $true
    lastConnectedAt   = (Get-Date).ToString('o')
  }
  [IO.File]::WriteAllText((Join-Path $guestDir 'host-profile.json'), ($hostProfileObj | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
} catch { }

$nodeExe = $null
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
if (-not $nodeExe) {
  foreach ($cand in @(
    (Join-Path $loginProfile 'AppData\Local\hermes\node\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $loginProfile 'AppData\Local\Programs\nodejs\node.exe')
  )) {
    if (Test-Path -LiteralPath $cand) { $nodeExe = $cand; break }
  }
}

$envPayload = $null
if ($nodeExe -and (Test-Path -LiteralPath (Join-Path $guestDir 'guest-env.js'))) {
  try {
    $rawOut = (& $nodeExe (Join-Path $guestDir 'guest-env.js') 2>$null | Out-String)
    foreach ($l in ($rawOut -split "`r?`n")) {
      if ($l.Trim().StartsWith('SMAC_GUEST_ENV ')) {
        $jsonText = $l.Trim().Substring('SMAC_GUEST_ENV '.Length)
        $envPayload = $jsonText | ConvertFrom-Json
      }
    }
  } catch { }
}

$lanIps = @()
$tailIps = @()
try {
  $allIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { $_.IPAddress })
  foreach ($ip in $allIps) {
    if ($ip -like '100.*') { $tailIps += $ip }
    else { $lanIps += $ip }
  }
} catch { }

$primaryIp = if ($envPayload -and $envPayload.machine -and $envPayload.machine.primaryIp) { [string]$envPayload.machine.primaryIp } elseif ($lanIps.Count) { $lanIps[0] } elseif ($ztIp) { $ztIp } elseif ($tailIps.Count) { $tailIps[0] } else { '' }
$fallbackIp = if ($ztIp -and $ztIp -ne $primaryIp) { $ztIp } elseif ($envPayload -and $envPayload.machine -and $envPayload.machine.fallbackIp) { [string]$envPayload.machine.fallbackIp } elseif ($tailIps.Count) { $tailIps[0] } elseif ($lanIps.Count -gt 1) { $lanIps[1] } else { '' }

if ($envPayload) {
  $installedClis = @($envPayload.cli | Where-Object { $_.installed } | ForEach-Object { $_.name })
  $installedDesktops = @($envPayload.desktop | Where-Object { $_.installed } | ForEach-Object { $_.name })
  Line ('已检测到 CLI 环境：' + $(if ($installedClis.Count) { $installedClis -join '、' } else { '无（启动时可由主机端自动安装）' })) Green
  Line ('已检测到 Desktop 环境：' + $(if ($installedDesktops.Count) { $installedDesktops -join '、' } else { '无' })) Green
}

# ---------- 6. 自动连接主机端并上报环境 ----------
Step '6/6 与主机端建立连接'
$regObject = [ordered]@{
  name              = $env:COMPUTERNAME
  hostname          = $env:COMPUTERNAME
  primaryIp         = $primaryIp
  fallbackIp        = $fallbackIp
  sshPort           = $port
  user              = $loginName
  os                = 'Windows'
  zerotierNetworkId = if ($ZeroTierNetwork -match '^[0-9a-fA-F]{16}$') { $ZeroTierNetwork.ToLower() } else { '' }
  zerotierNodeId    = $ztNodeId
  zerotierStatus    = $ztStatus
  zerotierIp        = $ztIp
  env               = $envPayload
}
$regJson = $regObject | ConvertTo-Json -Depth 8 -Compress
$pairCode = 'SMAC-GUEST://' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($regJson))
[IO.File]::WriteAllText((Join-Path $guestDir 'pairing-code.txt'), $pairCode, [Text.Encoding]::UTF8)

$connectedHost = $false
try {
  if ($HostEndpointsJson -and $HostEndpointsJson.StartsWith('[')) {
    $endpoints = $HostEndpointsJson | ConvertFrom-Json
    foreach ($ep in $endpoints) {
      if (-not $ep) { continue }
      $uri = ([string]$ep).TrimEnd('/') + '/api/guest/register'
      Line ('正在尝试连接主机端 ' + $uri + ' …') DarkGray
      try {
        $resp = Invoke-RestMethod -Uri $uri -Method Post -Headers @{ 'X-Smac-Pair-Token' = $PairToken } -Body ([Text.Encoding]::UTF8.GetBytes($regJson)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 5
        if ($resp -and $resp.ok) {
          Line ('[连接成功] 已自动注册到主机端 ' + $resp.hostName + '（设备名：' + $resp.deviceName + '）！') Green
          Line '现在可以直接在主机端控制台确定同步文件夹、发送文件到本机桌面，或选择并启动本机的 CLI / Desktop 环境。' Green
          $connectedHost = $true
          break
        }
      } catch { }
    }
  }
} catch { }

if (-not $connectedHost) {
  $hasMeshIp = ($tailIps.Count -gt 0) -or ($envPayload -and $envPayload.machine -and $envPayload.machine.meshIps -and $envPayload.machine.meshIps.Count -gt 0)
  Line '未能直接回连主机端（可能主机控制台尚未打开，或本机与主机不在同一局域网）。' Yellow
  if (-not $hasMeshIp) {
    Line ''
    Line '[跨公网连接提示] 当前未检测到 Tailscale / ZeroTier 异地组网 IP：' Yellow
    Line '  • 若与主机不在同一局域网，仅凭 192.168 内网 IP 无法直接从外网连通。' DarkGray
    Line '  • 推荐方案 1：安装 Tailscale（可执行 winget install Tailscale.Tailscale）并登录/接受主机节点分享，再重跑本脚本即可自动互通。' DarkGray
    Line '  • 推荐方案 2：若本机已配置 FRP / 樱花FRP / 路由器端口映射，可在下方输入公网地址（如 frp.xxx.com:22022）直接写入配对码。' DarkGray
    if (-not $DryRun) {
      try {
        $pubInput = (Read-Host '如有公网映射地址（域名:端口），请输入后回车；否则直接按回车跳过').Trim()
        if ($pubInput -match '^([^:\s]+)(?::(\d{1,5}))?$') {
          $pubHost = $Matches[1]
          $pubPort = if ($Matches[2]) { [int]$Matches[2] } else { $port }
          if ($primaryIp -and $primaryIp -ne $pubHost -and -not $fallbackIp) { $fallbackIp = $primaryIp }
          $primaryIp = $pubHost
          $port = $pubPort
          $regObject.primaryIp = $primaryIp
          $regObject.fallbackIp = $fallbackIp
          $regObject.sshPort = $port
          $regJson = $regObject | ConvertTo-Json -Depth 8 -Compress
          $pairCode = 'SMAC-GUEST://' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($regJson))
          [IO.File]::WriteAllText((Join-Path $guestDir 'pairing-code.txt'), $pairCode, [Text.Encoding]::UTF8)
          Line ('已将公网地址 ' + $primaryIp + ':' + $port + ' 写入配对码！') Green
        }
      } catch { }
    }
  } else {
    Line ('已检测到异地组网 IP（Tailscale/ZeroTier），可直接跨公网连接！') Green
  }
  Line ''
  Line '请复制下方配对码，在主机端控制台点击「客机端安装 / 接入」粘贴即可一键完成连接：' Cyan
  Write-Host ''
  Write-Host $pairCode -ForegroundColor Green
  Write-Host ''
  Line ('（配对码也已保存在：' + (Join-Path $guestDir 'pairing-code.txt') + '）') DarkGray
}

Write-Host ''
Line ('本机 IP：' + $primaryIp + $(if ($fallbackIp) { '  (备用/穿透 IP: ' + $fallbackIp + ')' } else { '' }))
if ($ztNodeId) {
  Line ('ZeroTier：节点 ' + $ztNodeId + '  组号 ' + $ZeroTierNetwork + '  状态 ' + $ztStatus + $(if ($ztIp) { '  IP ' + $ztIp } else { '' }))
}
Line ('用户名：' + $loginName + '    SSH 端口：' + $port)
if (-not $DryRun) {
  $guestExePath = Join-Path $guestDir 'smac-guest.exe'
  try {
    if (Test-Path -LiteralPath $guestExePath) {
      $wsh = New-Object -ComObject WScript.Shell
      foreach ($lnkDir in @(
        (Join-Path $loginProfile 'Desktop'),
        (Join-Path $loginProfile 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs')
      )) {
        if (Test-Path -LiteralPath $lnkDir) {
          $lnkPath = Join-Path $lnkDir 'smac 客机控制台.lnk'
          $sc = $wsh.CreateShortcut($lnkPath)
          $sc.TargetPath = $guestExePath
          $sc.WorkingDirectory = $guestDir
          $sc.Description = 'smac 客机端连接与环境控制台（独立窗口）'
          $sc.IconLocation = "$guestExePath,0"
          $sc.Save()
        }
      }
      Line '[OK] 已生成桌面与开始菜单快捷方式：smac 客机控制台' Green
    }
  } catch { }

  if (Test-Path -LiteralPath $guestExePath) {
    try {
      Line '正在打开客机端独立窗口控制台 (smac 客机控制台) …' Cyan
      Start-Process -FilePath $guestExePath -WorkingDirectory $guestDir
    } catch { }
  } elseif ($nodeExe -and (Test-Path -LiteralPath (Join-Path $guestDir 'guest-server.js'))) {
    try {
      Line '正在启动客机端图形控制台 (http://127.0.0.1:8790/) …' Cyan
      Start-Process -FilePath $nodeExe -ArgumentList @((Join-Path $guestDir 'guest-server.js'), '--open') -WorkingDirectory $guestDir -WindowStyle Hidden
    } catch { }
  }
}
Finish
