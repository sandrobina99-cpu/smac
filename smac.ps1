#requires -Version 5.1
<#
  smac.ps1 - Windows -> Mac 文件传输工具

  用法:
    smac.ps1 send <文件或文件夹...>
    smac.ps1 doctor
    smac.ps1 ls
    smac.ps1 config [set <键> <值>]
    smac.ps1 help

  机制:
    - 通过 SSH/SCP 上传到 Mac（默认 ~/Downloads/FromWindows）
    - 先传到远端临时名，SHA256 校验通过后再原子改名，避免半截文件
    - 文件夹上传后逐文件校验，再与远端同名目录合并
#>

param(
    [Parameter(Position = 0)]
    [string]$Command = 'help',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8
$script:Utf8 = [System.Text.Encoding]::UTF8
$script:Rest = @($Rest)

$script:DataDir    = Join-Path $env:USERPROFILE '.smac'
$script:ConfigPath = Join-Path $script:DataDir 'config.json'
$script:LogPath    = Join-Path $script:DataDir 'history.log'
$script:SshExe     = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$script:ScpExe     = Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'
$script:AppDir     = $PSScriptRoot
$script:RemoteHome = $null
$script:ActiveHost = $null

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Good([string]$Message) { Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Note([string]$Message) { Write-Host "[..] $Message" -ForegroundColor DarkGray }
function Write-Warn2([string]$Message) { Write-Host "[!] $Message" -ForegroundColor Yellow }
function Write-Bad([string]$Message) { Write-Host "[X] $Message" -ForegroundColor Red }

function Format-Size([long]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
    return "$Bytes B"
}

function Get-DefaultConfig {
    return [pscustomobject]@{
        host                     = ''
        lanHost                  = ''
        user                     = ''
        port                     = 22
        key                      = ''
        remoteDir                = '~/Desktop'
        syncRemoteDir            = '~/Documents'
        zerotierNetworkId        = ''
        defaultDeviceId          = ''
        clipboardDeviceIds       = @()
        syncPairs                = @()
        syncIntervalSeconds      = 20
        clipboardIntervalSeconds = 2
    }
}

function Save-SmacConfig($Config) {
    if (-not (Test-Path -LiteralPath $script:DataDir)) {
        New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null
    }
    $Config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $script:ConfigPath -Encoding UTF8
}

function Get-SmacConfig {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
        $cfg = Get-DefaultConfig
        Save-SmacConfig $cfg
        return $cfg
    }
    $cfg = Get-Content -LiteralPath $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $cfg | Add-Member -NotePropertyName host -NotePropertyValue ([string]$cfg.host) -Force
    $cfg | Add-Member -NotePropertyName user -NotePropertyValue ([string]$cfg.user) -Force
    $cfg | Add-Member -NotePropertyName key -NotePropertyValue ([string]$cfg.key) -Force
    $cfg | Add-Member -NotePropertyName port -NotePropertyValue $(if ($cfg.port) { [int]$cfg.port } else { 22 }) -Force
    $cfg | Add-Member -NotePropertyName lanHost -NotePropertyValue ([string]$cfg.lanHost) -Force
    $cfg | Add-Member -NotePropertyName remoteDir -NotePropertyValue $(if ([string]::IsNullOrWhiteSpace([string]$cfg.remoteDir)) { '~/Desktop' } else { [string]$cfg.remoteDir }) -Force
    $cfg | Add-Member -NotePropertyName syncRemoteDir -NotePropertyValue $(if ([string]::IsNullOrWhiteSpace([string]$cfg.syncRemoteDir)) { '~/Documents' } else { [string]$cfg.syncRemoteDir }) -Force
    $cfg | Add-Member -NotePropertyName zerotierNetworkId -NotePropertyValue ([string]$cfg.zerotierNetworkId) -Force
    $cfg | Add-Member -NotePropertyName defaultDeviceId -NotePropertyValue ([string]$cfg.defaultDeviceId) -Force
    $cfg | Add-Member -NotePropertyName syncPairs -NotePropertyValue @($cfg.syncPairs | Where-Object { $_ }) -Force
    $cfg | Add-Member -NotePropertyName syncIntervalSeconds -NotePropertyValue $(if ($cfg.syncIntervalSeconds) { [int]$cfg.syncIntervalSeconds } else { 20 }) -Force
    $cfg | Add-Member -NotePropertyName clipboardIntervalSeconds -NotePropertyValue $(if ($cfg.clipboardIntervalSeconds) { [int]$cfg.clipboardIntervalSeconds } else { 2 }) -Force
    return $cfg
}

function Assert-LegacyHostConfigured($Config) {
    if ([string]::IsNullOrWhiteSpace([string]$Config.host) -or [string]::IsNullOrWhiteSpace([string]$Config.user)) {
        throw '尚未配置默认 SSH 目标，请在控制台「远程设备 · 客机」添加设备（支持局域网 / Tailscale / ZeroTier），或使用 --device <设备名>。'
    }
    if ([string]::IsNullOrWhiteSpace([string]$Config.key)) {
        throw "默认 SSH 目标缺少私钥配置（key），请在控制台使用「远程设备 · 客机」连接或编辑 $script:ConfigPath。"
    }
}

function Get-ConfiguredHostName($Config) {
    if ($script:ActiveHost) { return $script:ActiveHost }
    if (-not [string]::IsNullOrWhiteSpace($Config.lanHost)) { return $Config.lanHost }
    return $Config.host
}

function Get-SshArgs($Config) {
    $hostName = Get-ConfiguredHostName $Config
    return @(
        '-n',
        '-i', $Config.key,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-p', [string]$Config.port,
        ('{0}@{1}' -f $Config.user, $hostName)
    )
}

function Get-ScpArgs($Config) {
    $hostName = Get-ConfiguredHostName $Config
    return @(
        '-i', $Config.key,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-P', [string]$Config.port
    )
}

function Quote-Remote([string]$Value) {
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function Quote-NativeArg([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return '""' }
    if ($Value -match '\s') { return ('"' + $Value + '"') }
    return $Value
}

# 通过 .NET 直接启动原生命令：可控超时，避免 SSH/SCP 半开连接把进程永久挂住
function Invoke-NativeCapture([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 180) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (($Arguments | ForEach-Object { Quote-NativeArg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $script:Utf8
    $psi.StandardErrorEncoding = $script:Utf8

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw "无法启动: $FilePath" }
        $process.StandardInput.Close()
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            try { [void]$process.WaitForExit(5000) } catch { }
            return [pscustomobject]@{ Code = -1; Output = ''; TimedOut = $true }
        }
        $output = $outTask.Result
        $errorText = $errTask.Result
        if (-not [string]::IsNullOrEmpty($errorText)) {
            if ([string]::IsNullOrEmpty($output)) { $output = $errorText }
            else { $output = $output + "`n" + $errorText }
        }
        return [pscustomobject]@{ Code = $process.ExitCode; Output = $output; TimedOut = $false }
    }
    finally {
        $process.Dispose()
    }
}

function Remote-TargetString($Config, [string]$RemotePath) {
    # 新版 scp 走 SFTP 协议，远端路径不再经过 shell，不能加引号
    return ('{0}@{1}:{2}' -f $Config.user, (Get-ConfiguredHostName $Config), $RemotePath)
}

function Invoke-Remote($Config, [string]$RemoteCommand, [int]$TimeoutSeconds = 180) {
    $a = Get-SshArgs $Config
    # PowerShell 5.1 传参给原生 exe 时会破坏引号/反斜杠，
    # 因此把远端脚本 base64 后交给远端 openssl 解码再执行。
    $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes($RemoteCommand))
    $wrapped = "echo $b64 | openssl base64 -d -A | sh"
    $result = Invoke-NativeCapture $script:SshExe ($a + $wrapped) $TimeoutSeconds
    if ($result.TimedOut) {
        throw "远端命令超时（${TimeoutSeconds} 秒），连接已中断。"
    }
    $text = $result.Output.Trim()
    if ($result.Code -ne 0) {
        if ([string]::IsNullOrWhiteSpace($text)) { $text = '(无输出)' }
        throw "远端命令失败 (exit $($result.Code)): $text"
    }
    return $text
}

function Get-RemoteHome($Config) {
    if ($script:RemoteHome) { return $script:RemoteHome }
    $remoteHomePath = (Invoke-Remote $Config 'printf %s "$HOME"').Trim()
    if ([string]::IsNullOrWhiteSpace($remoteHomePath)) { throw '无法获取远端用户主目录。' }
    $script:RemoteHome = $remoteHomePath
    return $remoteHomePath
}

function Resolve-RemotePath($Config, [string]$Path) {
    if ($Path -eq '~') { return Get-RemoteHome $Config }
    if ($Path.StartsWith('~/')) { return (Get-RemoteHome $Config) + $Path.Substring(1) }
    return $Path
}

function Test-RemoteConnection($Config) {
    return (Invoke-Remote $Config 'echo "$HOME"; sw_vers -productVersion').Trim()
}

function Test-SshHost($Config, [string]$HostName, [int]$TimeoutSeconds = 3) {
    if ([string]::IsNullOrWhiteSpace($HostName)) { return $false }
    $a = @(
        '-n',
        '-i', $Config.key,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', ("ConnectTimeout={0}" -f $TimeoutSeconds),
        '-p', [string]$Config.port,
        ('{0}@{1}' -f $Config.user, $HostName)
    )
    $result = Invoke-NativeCapture $script:SshExe ($a + 'echo SMAC_PROBE_OK') ([Math]::Max($TimeoutSeconds + 5, 8))
    if ($result.Code -ne 0) { return $false }
    return ($result.Output -match 'SMAC_PROBE_OK')
}

function Resolve-ActiveHost($Config, [switch]$Quiet) {
    if (-not [string]::IsNullOrWhiteSpace($Config.lanHost)) {
        if (Test-SshHost $Config $Config.lanHost 3) {
            if (-not $Quiet) { Write-Note ("局域网直连: {0}" -f $Config.lanHost) }
            $script:ActiveHost = $Config.lanHost
            return $Config.lanHost
        }
        if (-not $Quiet) { Write-Warn2 ("局域网地址不可达: {0}，改用 Tailscale" -f $Config.lanHost) }
    }
    if (-not $Quiet) { Write-Note ("使用 Tailscale 地址: {0}（如速度很慢，可运行 doctor 重新探测局域网）" -f $Config.host) }
    $script:ActiveHost = $Config.host
    return $Config.host
}

function Get-LocalSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

function Get-LocalManifest([string]$Directory) {
    $root = (Get-Item -LiteralPath $Directory -Force).FullName.TrimEnd('\', '/')
    $map = @{}
    $files = Get-ChildItem -LiteralPath $root -Recurse -File -Force
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        $map[$relative] = Get-LocalSha256 $file.FullName
    }
    return $map
}

function Get-RemoteManifest($Config, [string]$RemoteDirectory) {
    $q = Quote-Remote $RemoteDirectory
    # 用 base64 回传，避免中文文件名受控制台代码页影响
    $text = Invoke-Remote $Config ("cd $q && find . -type f -exec shasum -a 256 {} + | base64")
    $b64 = ($text -replace '\s', '')
    if ([string]::IsNullOrEmpty($b64)) { return @{} }
    $bytes = [Convert]::FromBase64String($b64)
    $manifestText = $script:Utf8.GetString($bytes)

    $map = @{}
    foreach ($line in ($manifestText -split "`n")) {
        $line = $line.TrimEnd("`r")
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -match '^([0-9a-fA-F]{64})\s+\./(.+)$') {
            $map[$Matches[2]] = $Matches[1].ToLower()
        }
    }
    return $map
}

function Compare-Manifests([hashtable]$Local, [hashtable]$Remote, [string]$Label) {
    $problems = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Local.Keys) {
        if (-not $Remote.ContainsKey($key)) {
            $problems.Add("远端缺少: $key")
        }
        elseif ($Remote[$key] -ne $Local[$key]) {
            $problems.Add("内容不一致: $key")
        }
    }
    foreach ($key in $Remote.Keys) {
        if (-not $Local.ContainsKey($key)) { $problems.Add("远端多出: $key") }
    }

    if ($problems.Count -gt 0) {
        $preview = ($problems | Select-Object -First 5) -join '; '
        throw ("$Label 校验失败（$($problems.Count) 个问题）: $preview")
    }
}

function Write-Log([string]$Line) {
    try {
        if (-not (Test-Path -LiteralPath $script:DataDir)) {
            New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null
        }
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $script:LogPath -Value ("$stamp | $Line") -Encoding UTF8
    }
    catch { }
}

function Send-OneFile($Config, [System.IO.FileInfo]$File) {
    $remoteDir = Resolve-RemotePath $Config $Config.remoteDir
    $name      = $File.Name
    $target    = ($remoteDir.TrimEnd('/') + '/' + $name)
    $tempName  = ('.smac-{0}-{1}-{2}' -f (Get-Date -Format 'yyyyMMddHHmmss'), $PID, (Get-Random -Minimum 1000 -Maximum 9999))
    $tempPath  = ($remoteDir.TrimEnd('/') + '/' + $tempName)

    $started = Get-Date
    try {
        $scpArgs = (Get-ScpArgs $Config) + @($File.FullName, (Remote-TargetString $Config $tempPath))
        $scp = Invoke-NativeCapture $script:ScpExe $scpArgs 7200
        if ($scp.TimedOut) { throw 'scp 上传超时，连接已中断' }
        if ($scp.Code -ne 0) { throw ("scp 上传失败 (exit {0}): {1}" -f $scp.Code, $scp.Output.Trim()) }

        $localHash = Get-LocalSha256 $File.FullName
        $qTemp     = Quote-Remote $tempPath
        $qTarget   = Quote-Remote $target
        $template  = @'
if [ -d {{TARGET}} ]; then echo SMAC_CONFLICT_DIR; rm -f {{TEMP}}; exit 3; fi
h=$(shasum -a 256 {{TEMP}} | cut -c1-64)
if [ "$h" != "{{HASH}}" ]; then echo "SMAC_HASH $h"; rm -f {{TEMP}}; exit 4; fi
mv -f {{TEMP}} {{TARGET}} && echo SMAC_MOVED
'@
        $verifyScript = $template.Replace('{{TARGET}}', $qTarget).Replace('{{TEMP}}', $qTemp).Replace('{{HASH}}', $localHash)
        $result = Invoke-Remote $Config $verifyScript
        if ($result -notmatch 'SMAC_MOVED') {
            throw "远端校验/改名未成功: $result"
        }

        $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
        Write-Good ("已发送 {0} ({1}, {2}s)  SHA256 {3}..." -f $name, (Format-Size $File.Length), $seconds, $localHash.Substring(0, 8))
        Write-Log ("OK | file | {0} | {1} bytes | {2}s | {3}" -f $File.FullName, $File.Length, $seconds, $target)
        return $true
    }
    catch {
        try {
            $qTemp = Quote-Remote $tempPath
            Invoke-Remote $Config ("rm -rf $qTemp") | Out-Null
        }
        catch { }
        $reason = $_.Exception.Message
        if ($reason -match 'SMAC_CONFLICT_DIR') {
            $reason = "远端存在同名文件夹，无法用文件覆盖: $target"
        }
        Write-Bad ("发送失败 {0}: {1}" -f $name, $reason)
        Write-Log ("FAIL | file | {0} | {1}" -f $File.FullName, $reason)
        return $false
    }
}

function Send-OneDirectory($Config, [System.IO.DirectoryInfo]$Directory) {
    $remoteDir = Resolve-RemotePath $Config $Config.remoteDir
    $name      = $Directory.Name
    $target    = ($remoteDir.TrimEnd('/') + '/' + $name)
    $tempName  = ('.smac-{0}-{1}-{2}' -f (Get-Date -Format 'yyyyMMddHHmmss'), $PID, (Get-Random -Minimum 1000 -Maximum 9999))
    $tempPath  = ($remoteDir.TrimEnd('/') + '/' + $tempName)

    $started = Get-Date
    try {
        $qTargetCheck = Quote-Remote $target
        $targetType = (Invoke-Remote $Config ("if [ -d $qTargetCheck ]; then echo dir; elif [ -e $qTargetCheck ]; then echo file; else echo none; fi")).Trim()
        if ($targetType -eq 'file') {
            throw "远端存在同名文件，无法用文件夹覆盖: $target"
        }

        $scpArgs = (Get-ScpArgs $Config) + @('-r', $Directory.FullName, (Remote-TargetString $Config $tempPath))
        $scp = Invoke-NativeCapture $script:ScpExe $scpArgs 7200
        if ($scp.TimedOut) { throw 'scp 上传超时，连接已中断' }
        if ($scp.Code -ne 0) { throw ("scp 上传失败 (exit {0}): {1}" -f $scp.Code, $scp.Output.Trim()) }

        Write-Note '正在逐文件校验（中文/大量小文件时会稍慢）...'
        $localManifest  = Get-LocalManifest $Directory.FullName
        $remoteManifest = Get-RemoteManifest $Config $tempPath
        Compare-Manifests $localManifest $remoteManifest $name

        $qTemp   = Quote-Remote $tempPath
        $qTarget = Quote-Remote $target
        $template = @'
if [ -d {{TARGET}} ]; then
  rsync -a {{TEMP}}/ {{TARGET}}/ && rm -rf {{TEMP}} && echo SMAC_MERGED
elif [ -e {{TARGET}} ]; then
  rm -rf {{TEMP}}; echo SMAC_CONFLICT_FILE; exit 5
else
  mv {{TEMP}} {{TARGET}} && echo SMAC_MOVED
fi
'@
        $mergeScript = $template.Replace('{{TARGET}}', $qTarget).Replace('{{TEMP}}', $qTemp)
        $result = Invoke-Remote $Config $mergeScript
        if ($result -notmatch 'SMAC_(MOVED|MERGED)') {
            throw "远端合并/改名未成功: $result"
        }
        if ($result -match 'SMAC_MERGED') {
            Write-Note "远端已有同名文件夹，已按文件合并: $name"
        }

        $totalBytes = 0L
        Get-ChildItem -LiteralPath $Directory.FullName -Recurse -File -Force | ForEach-Object { $totalBytes += $_.Length }
        $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
        Write-Good ("已发送文件夹 {0} ({1} 个文件, {2}, {3}s) -> {4}" -f $name, $localManifest.Count, (Format-Size $totalBytes), $seconds, $target)
        Write-Log ("OK | dir | {0} | files={1} bytes={2} | {3}s | {4}" -f $Directory.FullName, $localManifest.Count, $totalBytes, $seconds, $target)
        return $true
    }
    catch {
        try {
            $qTemp = Quote-Remote $tempPath
            Invoke-Remote $Config ("rm -rf $qTemp") | Out-Null
        }
        catch { }
        $reason = $_.Exception.Message
        if ($reason -match 'SMAC_CONFLICT_FILE') {
            $reason = "远端存在同名文件，无法用文件夹覆盖: $target"
        }
        Write-Bad ("发送失败 {0}: {1}" -f $name, $reason)
        Write-Log ("FAIL | dir | {0} | {1}" -f $Directory.FullName, $reason)
        return $false
    }
}

function Send-Items($Config, [string[]]$Paths, [string]$DeviceId = '') {
    if (-not $Paths -or $Paths.Count -eq 0) {
        Write-Bad '没有指定要发送的文件或文件夹。用法: smac.ps1 send <路径...>'
        return 1
    }
    if (-not [string]::IsNullOrWhiteSpace($DeviceId)) {
        if (-not (Get-Command Send-ItemsToDevice -ErrorAction SilentlyContinue)) { throw '远程设备发送模块缺失。' }
        return (Send-ItemsToDevice $Config $Paths $DeviceId)
    }

    Assert-LegacyHostConfigured $Config
    $script:ActiveHost = Resolve-ActiveHost $Config
    $remoteDir = Resolve-RemotePath $Config $Config.remoteDir
    Write-Step ("目标: {0}@{1}:{2}" -f $Config.user, $script:ActiveHost, $remoteDir)
    Write-Note '正在检查连接与远端目录...'
    Invoke-Remote $Config ("mkdir -p " + (Quote-Remote $remoteDir)) | Out-Null

    $okCount = 0
    $failCount = 0
    foreach ($rawPath in $Paths) {
        if ([string]::IsNullOrWhiteSpace($rawPath)) { continue }
        $path = $rawPath
        if (-not [System.IO.Path]::IsPathRooted($path)) {
            $path = Join-Path (Get-Location).Path $path
        }
        if (-not (Test-Path -LiteralPath $path)) {
            Write-Bad "路径不存在: $rawPath"
            $failCount++
            continue
        }

        $item = Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer) {
            if (Send-OneDirectory $Config $item) { $okCount++ } else { $failCount++ }
        }
        else {
            if (Send-OneFile $Config $item) { $okCount++ } else { $failCount++ }
        }
    }

    Write-Host ''
    if ($failCount -eq 0) {
        Write-Good ("全部完成：{0} 项成功。" -f $okCount)
        return 0
    }
    Write-Warn2 ("完成：{0} 项成功，{1} 项失败。日志: {2}" -f $okCount, $failCount, $script:LogPath)
    return 1
}

function Show-Doctor($Config) {
    Assert-LegacyHostConfigured $Config
    Write-Step '检查本地配置'
    Write-Host ("  配置文件 : {0}" -f $script:ConfigPath)
    Write-Host ("  Tailscale: {0}" -f $Config.host)
    Write-Host ("  局域网   : {0}" -f $(if ($Config.lanHost) { $Config.lanHost } else { '(未记录，将自动探测)' }))
    Write-Host ("  用户/端口: {0} / {1}" -f $Config.user, $Config.port)
    Write-Host ("  私钥     : {0}" -f $Config.key)
    if (-not (Test-Path -LiteralPath $Config.key)) {
        Write-Bad "私钥不存在: $($Config.key)"
        return 1
    }
    Write-Good '私钥存在'
    if (-not (Test-Path -LiteralPath $script:SshExe)) {
        Write-Bad "找不到 ssh.exe: $($script:SshExe)"
        return 1
    }

    Write-Step '选择连接路径（局域网优先）'
    $script:ActiveHost = Resolve-ActiveHost $Config
    Write-Good ("当前使用: {0}" -f $script:ActiveHost)

    Write-Step '检查 SSH 连接'
    $info = Test-RemoteConnection $Config
    $lines = $info -split "`n"
    Write-Good ("SSH 正常，macOS {0}，远端主目录 {1}" -f $lines[1], $lines[0])

    if ($script:ActiveHost -eq $Config.host) {
        Write-Step '尝试通过 Tailscale 刷新局域网地址'
        try {
            $lanIp = (Invoke-Remote $Config 'ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null').Trim()
            if ($lanIp -match '^\d{1,3}(\.\d{1,3}){3}$') {
                if ($lanIp -ne $Config.lanHost) {
                    $Config.lanHost = $lanIp
                    Save-SmacConfig $Config
                    Write-Good ("已记录局域网地址: {0}（下次发送会优先直连）" -f $lanIp)
                }
                else {
                    Write-Note ("局域网地址未变化: {0}" -f $lanIp)
                }
            }
            else {
                Write-Warn2 '未能获取 Mac 的局域网地址（可能没连 Wi-Fi/网线）'
            }
        }
        catch {
            Write-Warn2 ("刷新局域网地址失败: {0}" -f $_.Exception.Message)
        }
    }

    Write-Step '检查远端接收目录'
    $remoteDir = Resolve-RemotePath $Config $Config.remoteDir
    Invoke-Remote $Config ("mkdir -p " + (Quote-Remote $remoteDir)) | Out-Null
    Write-Good ("接收目录可用: {0}" -f $remoteDir)
    $df = Invoke-Remote $Config ("df -h " + (Quote-Remote $remoteDir) + " | tail -1")
    Write-Host ("  磁盘空间 : {0}" -f $df.Trim())

    Write-Step '检查远端工具'
    $rsync = Invoke-Remote $Config 'rsync --version | head -1'
    Write-Host ("  {0}" -f $rsync.Trim())
    Write-Good '环境检查完成'
    return 0
}

function Show-RemoteList($Config, [string]$DeviceId = '') {
    if (-not [string]::IsNullOrWhiteSpace($DeviceId)) {
        if (-not (Get-Command Show-ContextRemoteList -ErrorAction SilentlyContinue)) { throw '远程设备模块缺失。' }
        return (Show-ContextRemoteList $Config $DeviceId)
    }
    Assert-LegacyHostConfigured $Config
    $script:ActiveHost = Resolve-ActiveHost $Config
    $remoteDir = Resolve-RemotePath $Config $Config.remoteDir
    $q = Quote-Remote $remoteDir
    $text = Invoke-Remote $Config ("if [ -d $q ]; then cd $q && ls -lh; else echo '目录尚未创建，发送第一个文件时会自动创建。'; fi")
    Write-Step ("{0}:{1}" -f $script:ActiveHost, $remoteDir)
    Write-Host $text
    return 0
}

function Show-Config($Config) {
    Write-Step '当前配置'
    $Config | ConvertTo-Json
    Write-Host ''
    Write-Note ("配置文件: {0}" -f $script:ConfigPath)
    Write-Note '修改示例: smac.ps1 config set remoteDir ~/Downloads/FromWindows'
    return 0
}

function Set-ConfigValue([string]$Name, [string]$Value) {
    $allowed = @('host', 'lanHost', 'user', 'port', 'key', 'remoteDir', 'syncRemoteDir', 'zerotierNetworkId', 'defaultDeviceId', 'syncIntervalSeconds', 'clipboardIntervalSeconds')
    if ($allowed -notcontains $Name) {
        throw ("不支持的配置项: {0}。可选: {1}" -f $Name, ($allowed -join ', '))
    }
    $cfg = Get-SmacConfig
    if ($Name -eq 'port') {
        $parsed = 0
        if (-not [int]::TryParse($Value, [ref]$parsed) -or $parsed -le 0 -or $parsed -gt 65535) {
            throw "端口无效: $Value"
        }
        $cfg.port = $parsed
    }
    elseif ($Name -eq 'syncIntervalSeconds') {
        $parsed = 0
        if (-not [int]::TryParse($Value, [ref]$parsed) -or $parsed -lt 5 -or $parsed -gt 86400) {
            throw "同步间隔无效（5-86400 秒）: $Value"
        }
        $cfg.syncIntervalSeconds = $parsed
    }
    elseif ($Name -eq 'clipboardIntervalSeconds') {
        $parsed = 0
        if (-not [int]::TryParse($Value, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 300) {
            throw "剪贴板同步间隔无效（1-300 秒）: $Value"
        }
        $cfg.clipboardIntervalSeconds = $parsed
    }
    elseif ($Name -eq 'syncRemoteDir') {
        $value = $Value.Trim().TrimEnd('/')
        if ([string]::IsNullOrWhiteSpace($value) -or $value -eq '~' -or $value -match '[\x00-\x1f\\]' -or
            ($value -notmatch '^(~/|/)') -or ($value.Split('/') -contains '..') -or ($value.Split('/') -contains '.')) {
            throw '默认同步目录需为 Mac 子文件夹路径，例如 ~/Documents；不能使用根目录、整个用户目录或相对路径。'
        }
        $cfg.syncRemoteDir = $value
    }
    else {
        $cfg.$Name = $Value
    }
    Save-SmacConfig $cfg
    Write-Good ("已更新 {0} = {1}" -f $Name, $Value)
    return 0
}

function Show-Help {
    Write-Host @'
smac - 本机与 Mac / SSH 远程设备之间的文件传输与文件夹同步

用法:
  smac.ps1 send <文件或文件夹...> [--device <设备>]   上传并校验（可一次多个，拖动图标也可以）
  smac.ps1 ls [--device <设备>]                     查看接收目录
  smac.ps1 doctor                   检查 SSH、密钥、远端目录与空间
  smac.ps1 config [set <键> <值>]   查看/修改配置
  smac.ps1 web                      打开图形控制台（本地网页）
  smac.ps1 sync <子命令>            文件夹双向同步，详见 smac.ps1 sync help
  smac.ps1 clip <子命令>            剪贴板文本双向同步，详见 smac.ps1 clip help
  smac.ps1 help                     显示帮助

说明:
  - 不带 --device 时使用内置 Mac 配置；--device 可填控制台里添加的设备名称或 ID。
  - 其他 SSH 设备目前支持 Windows 11 与 macOS/Linux，发送默认落到远端桌面。
  - 密码设备的密码保存在 %USERPROFILE%\.smac\devices.json（明文），仅供本机后台同步/发送使用。

clip 子命令:
  start | stop                      启动/停止后台剪贴板同步
  status                            查看运行状态与最近同步
  now                               立即同步一次
  install | uninstall               设置/取消开机自启

sync 子命令:
  add <本机文件夹> <远端路径> [名称] [--device <设备>]
                                    添加同步文件夹对（默认 Mac）
  remove <名称>                     移除文件夹对（不删文件）
  list                              查看文件夹对
  now [名称]                        立即同步一次
  status                            查看守护与同步状态
  start | stop                      启动/停止后台守护
  install | uninstall               设置/取消开机自启

说明:
  - 同一局域网时自动走 Mac 的局域网 IP（快），不在同一网络时回退 Tailscale。
  - 文件先上传为远端临时名，SHA256 一致后才改名为正式文件，失败不会留下半截文件。
  - 文件夹会逐文件校验；若远端已有同名目录，则合并而不是覆盖整个目录。
  - 同步是双向的：哪边改动就同步到另一边；两端同时改同一文件会保留两份。
  - 传输日志: %USERPROFILE%\.smac\history.log
  - 同步日志: %USERPROFILE%\.smac\sync.log

示例:
  powershell -ExecutionPolicy Bypass -File .\smac.ps1 send "D:\论文.pdf"
  powershell -ExecutionPolicy Bypass -File .\smac.ps1 sync add "D:\论文" "~/Desktop/论文"
  powershell -ExecutionPolicy Bypass -File .\smac.ps1 sync install
  powershell -ExecutionPolicy Bypass -File .\smac.ps1 web
'@
    return 0
}

function Get-SmacWebCommandLine([int]$TargetPid) {
    if ($TargetPid -le 0) { return '' }
    try {
        $info = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId={0}" -f $TargetPid) -ErrorAction Stop
        if ($info) { return [string]$info.CommandLine }
    }
    catch { }
    return ''
}

function Test-SmacWebProcess([int]$TargetPid, [string]$ServerPath) {
    if ($TargetPid -le 0) { return $false }
    $line = Get-SmacWebCommandLine $TargetPid
    if (-not $line) { return $false }
    return $line.IndexOf($ServerPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Read-SmacNumberFile([string]$Path) {
    $port = 0
    if (Test-Path -LiteralPath $Path) {
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
        if ($raw) { [void][int]::TryParse($raw.Trim(), [ref]$port) }
    }
    return $port
}

function Test-SmacWebHealth([int]$Port) {
    if ($Port -le 0) { return $false }
    $client = $null
    $reader = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(1200)) { return $false }
        $client.EndConnect($connect)
        $stream = $client.GetStream()
        $stream.ReadTimeout = 1500
        $request = "GET /api/health HTTP/1.0`r`nHost: 127.0.0.1:$Port`r`nConnection: close`r`n`r`n"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($request)
        $stream.Write($bytes, 0, $bytes.Length)
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        return ($text -match '200' -and $text -match '"app"\s*:\s*"smac"')
    }
    catch { return $false }
    finally {
        if ($reader) { $reader.Close() }
        if ($client) { $client.Close() }
    }
}

function Start-WebConsole([string]$Action) {
    $server = Join-Path $script:AppDir 'web\server.js'
    if (-not (Test-Path -LiteralPath $server)) { throw "缺少网页控制台文件: $server" }
    $pidPath = Join-Path $script:DataDir 'web.pid'
    $portPath = Join-Path $script:DataDir 'web-port'
    $logPath = Join-Path $script:DataDir 'web.log'
    $errPath = Join-Path $script:DataDir 'web.err.log'

    if ($Action -eq 'stop') {
        $webPid = Read-SmacNumberFile $pidPath
        if (Test-SmacWebProcess $webPid $server) {
            Stop-Process -Id $webPid -Force -ErrorAction SilentlyContinue
            Write-Good '网页控制台已停止。'
        }
        else {
            Write-Note '网页控制台未在运行（已清理残留记录）。'
        }
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $portPath -Force -ErrorAction SilentlyContinue
        return 0
    }

    $nodePath = $null
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { $nodePath = $node.Source }
    if (-not $nodePath) {
        $candidates = @(
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
        )
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate) { $nodePath = $candidate; break }
        }
    }
    if (-not $nodePath) { throw '未找到 Node.js，无法打开网页控制台。请先安装 Node.js (https://nodejs.org/)。' }

    $webDir = Join-Path $script:AppDir 'web'
    if ((-not (Test-Path -LiteralPath (Join-Path $webDir 'node_modules\ssh2'))) -or (-not (Test-Path -LiteralPath (Join-Path $webDir 'node_modules\ws')))) {
        $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($npmCmd) {
            Write-Step '首次启动正在安装控制台依赖 (ssh2 / ws)...'
            Push-Location $webDir
            try { & $npmCmd.Source install --omit=optional --no-audit --no-fund | Out-Null } catch { } finally { Pop-Location }
        }
    }

    $OpenConsole = {
        param([int]$Port)
        Start-Process ("http://127.0.0.1:{0}/" -f $Port)
        Write-Good "网页控制台已打开: http://127.0.0.1:$Port/"
    }

    # 已在运行：优先用记录的端口，其次扫描可能的端口，避免重复起进程
    $existingPid = Read-SmacNumberFile $pidPath
    if (Test-SmacWebProcess $existingPid $server) {
        $existingPort = Read-SmacNumberFile $portPath
        if (Test-SmacWebHealth $existingPort) { & $OpenConsole $existingPort; return 0 }
    }
    for ($p = 8788; $p -le 8796; $p++) {
        if (Test-SmacWebHealth $p) { & $OpenConsole $p; return 0 }
    }

    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $portPath -Force -ErrorAction SilentlyContinue

    Start-Process -FilePath $nodePath -ArgumentList ('"' + $server + '"') -WorkingDirectory $script:AppDir -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errPath

    $livePort = 0
    for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 200
        $candidate = Read-SmacNumberFile $portPath
        if ($candidate -gt 0 -and (Test-SmacWebHealth $candidate)) { $livePort = $candidate; break }
    }
    if ($livePort -le 0) {
        $detail = ''
        foreach ($candidatePath in @($errPath, $logPath)) {
            if (-not $detail -and (Test-Path -LiteralPath $candidatePath)) {
                $detail = ((Get-Content -LiteralPath $candidatePath -Tail 3 -ErrorAction SilentlyContinue) -join ' / ').Trim()
            }
        }
        if ($detail) { throw ("网页控制台启动失败: {0}" -f $detail) }
        throw ('网页控制台启动失败（10 秒内未通过健康检查），请查看 ' + $errPath)
    }

    & $OpenConsole $livePort
    return 0
}

# ---------------- 主入口 ----------------
$script:DeviceLib = Join-Path $script:AppDir 'lib\Smac.Device.ps1'
if (Test-Path -LiteralPath $script:DeviceLib) { . $script:DeviceLib }
$script:DeviceSyncLib = Join-Path $script:AppDir 'lib\Smac.DeviceSync.ps1'
if (Test-Path -LiteralPath $script:DeviceSyncLib) { . $script:DeviceSyncLib }
$script:DeviceSendLib = Join-Path $script:AppDir 'lib\Smac.DeviceSend.ps1'
if (Test-Path -LiteralPath $script:DeviceSendLib) { . $script:DeviceSendLib }
$script:SyncLib = Join-Path $script:AppDir 'lib\Smac.Sync.ps1'
if (Test-Path -LiteralPath $script:SyncLib) { . $script:SyncLib }
$script:ClipLib = Join-Path $script:AppDir 'lib\Smac.Clipboard.ps1'
if (Test-Path -LiteralPath $script:ClipLib) { . $script:ClipLib }

# 从参数中取出 --device <名称|ID>，其余参数保持顺序
function Split-SmacDeviceArgument([string[]]$Items) {
    $remaining = New-Object System.Collections.Generic.List[string]
    $deviceId = ''
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $item = [string]$Items[$i]
        if ($item -match '^--device=(.+)$') { $deviceId = $Matches[1]; continue }
        if ($item -eq '--device' -or $item -eq '-Device') {
            if ($i + 1 -lt $Items.Count) {
                $deviceId = [string]$Items[$i + 1]
                $i++
            }
            continue
        }
        $remaining.Add($item)
    }
    return [pscustomobject]@{ Args = @($remaining); DeviceId = $deviceId }
}

$exitCode = 0
try {
    $config = Get-SmacConfig
    $sub = ''
    if ($script:Rest.Count -gt 0) { $sub = [string]$script:Rest[0] }

    switch ($Command.ToLowerInvariant()) {
        'send' {
            $parsed = Split-SmacDeviceArgument @($script:Rest)
            $exitCode = Send-Items $config @($parsed.Args) $parsed.DeviceId
        }
        'doctor' { $exitCode = Show-Doctor $config }
        'ls'     {
            $parsed = Split-SmacDeviceArgument @($script:Rest)
            $exitCode = Show-RemoteList $config $parsed.DeviceId
        }
        'config' {
            if ($sub -eq 'set') {
                if ($script:Rest.Count -lt 3) { throw '用法: smac.ps1 config set <键> <值>' }
                $exitCode = Set-ConfigValue ([string]$script:Rest[1]) ([string]$script:Rest[2])
            }
            else {
                $exitCode = Show-Config $config
            }
        }
        'sync' {
            if (-not (Get-Command Invoke-SyncCommand -ErrorAction SilentlyContinue)) {
                throw "同步模块缺失: $script:SyncLib"
            }
            $exitCode = Invoke-SyncCommand $config @($script:Rest)
        }
        'clip' {
            if (-not (Get-Command Invoke-ClipCommand -ErrorAction SilentlyContinue)) {
                throw "剪贴板模块缺失: $script:ClipLib"
            }
            $exitCode = Invoke-ClipCommand $config @($script:Rest)
        }
        'web' { $exitCode = Start-WebConsole $sub }
        'pack' {
            $packScript = Join-Path $script:AppDir 'package-editions.ps1'
            if (-not (Test-Path -LiteralPath $packScript)) { throw "缺少打包脚本: $packScript" }
            & $packScript
            $exitCode = 0
        }
        'help' { $exitCode = Show-Help }
        default {
            # 允许直接拖拽: smac.ps1 "C:\某个文件.pdf"
            if ($script:Rest.Count -eq 0 -and (Test-Path -LiteralPath $Command)) {
                $exitCode = Send-Items $config @($Command)
            }
            else {
                Show-Help
                $exitCode = 1
            }
        }
    }
}
catch {
    Write-Bad $_.Exception.Message
    $exitCode = 1
}

exit $exitCode
