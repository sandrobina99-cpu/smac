# Smac.Device.ps1 - 通过网页控制台保存的 SSH 设备进行发送/同步
# 由 smac.ps1 点源加载；依赖 smac.ps1 里的 Write-* / Format-Size / Get-LocalSha256 等函数。
# 密码设备通过 web/ssh-bridge.js（ssh2）连接，避免把密码放到命令行上。

$script:SmacBridgePath = Join-Path $script:AppDir 'web\ssh-bridge.js'

function Get-SmacNodeExe {
    if ($script:SmacNodeExe -and (Test-Path -LiteralPath $script:SmacNodeExe)) { return $script:SmacNodeExe }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { $script:SmacNodeExe = $node.Source; return $script:SmacNodeExe }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $script:SmacNodeExe = $candidate
            return $candidate
        }
    }
    throw '未找到 Node.js，无法连接非 Mac 的 SSH 设备。'
}

function Get-SmacDeviceList {
    $path = Join-Path $script:DataDir 'devices.json'
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    try {
        $data = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($data -is [array]) { return @($data) }
        if ($data.devices) { return @($data.devices) }
    }
    catch { }
    return @()
}

function Find-SmacDevice([string]$IdOrName) {
    $wanted = [string]$IdOrName
    if ([string]::IsNullOrWhiteSpace($wanted)) { return $null }
    $devices = @(Get-SmacDeviceList)
    foreach ($device in $devices) {
        if ([string]$device.id -eq $wanted) { return $device }
    }
    foreach ($device in $devices) {
        if ([string]$device.name -eq $wanted) { return $device }
    }
    return $null
}

function Invoke-SshBridge($Request, [int]$TimeoutSeconds = 240) {
    $node = Get-SmacNodeExe
    if (-not (Test-Path -LiteralPath $script:SmacBridgePath)) { throw "缺少 SSH 桥接脚本: $script:SmacBridgePath" }
    $temp = Join-Path ([IO.Path]::GetTempPath()) ('smac-bridge-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        $json = $Request | ConvertTo-Json -Depth 10 -Compress
        [IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $node
        $psi.Arguments = ((Quote-NativeArg $script:SmacBridgePath) + ' ' + (Quote-NativeArg $temp))
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
            if (-not $process.Start()) { throw '无法启动 SSH 桥接进程。' }
            $process.StandardInput.Close()
            $outTask = $process.StandardOutput.ReadToEndAsync()
            $errTask = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
                try { $process.Kill() } catch { }
                throw "SSH 设备操作超时（${TimeoutSeconds} 秒）。"
            }
            $stdout = $outTask.Result
            $stderr = $errTask.Result
        }
        finally {
            $process.Dispose()
        }

        $line = ($stdout -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
        if ([string]::IsNullOrWhiteSpace($line)) {
            $detail = ($stderr -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
            if (-not $detail) { $detail = 'SSH 桥接没有返回结果' }
            throw $detail
        }
        try {
            return ($line.Trim() | ConvertFrom-Json)
        }
        catch {
            throw ("SSH 桥接返回格式错误: " + $line.Trim())
        }
    }
    finally {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
}

function New-RemoteContext($Config, [string]$DeviceId) {
    $id = [string]$DeviceId
    if ([string]::IsNullOrWhiteSpace($id) -or $id -eq 'mac' -or $id -eq 'Mac') {
        return [pscustomobject]@{
            Kind       = 'mac'
            Os         = 'macos'
            Name       = 'Mac'
            DeviceId   = ''
            Device     = $null
            Config     = $Config
            Home       = $null
            ActiveHost = $null
            LastError  = ''
        }
    }
    $device = Find-SmacDevice $id
    if (-not $device) { throw "找不到远程设备: $id（可能已在控制台删除）" }

    $os = ''
    $rawOs = [string]$device.os
    if ($rawOs -match '(?i)windows') { $os = 'windows' }
    elseif ($rawOs -match '(?i)darwin|mac') { $os = 'macos' }
    elseif ($rawOs -match '(?i)linux') { $os = 'linux' }
    elseif ($rawOs -match '(?i)bsd') { $os = 'bsd' }

    return [pscustomobject]@{
        Kind       = 'device'
        Os         = $os
        Name       = [string]$device.name
        DeviceId   = [string]$device.id
        Device     = $device
        Config     = $Config
        Home       = $null
        ActiveHost = $null
        LastError  = ''
    }
}

function Get-ContextKey($Context) {
    if ($Context.Kind -eq 'mac') { return 'mac' }
    return ('device:' + $Context.DeviceId)
}

function Test-ContextPresence($Context, [int]$ConnectTimeoutMs = 20000) {
    if ($Context.Kind -eq 'mac') {
        $presence = Test-MacPresence $Context.Config
        if ($presence) {
            $Context.ActiveHost = $presence
            return [pscustomobject]@{ Online = $true; Host = $presence; Error = '' }
        }
        $Context.LastError = 'Mac 不可达'
        return [pscustomobject]@{ Online = $false; Host = ''; Error = 'Mac 不可达' }
    }

    $request = @{
        op               = 'probe'
        deviceId         = $Context.DeviceId
        connectTimeoutMs = $ConnectTimeoutMs
        timeoutMs        = 15000
    }
    $timeoutSeconds = [Math]::Ceiling($ConnectTimeoutMs / 1000) + 20
    try {
        $result = Invoke-SshBridge $request $timeoutSeconds
    }
    catch {
        $Context.LastError = $_.Exception.Message
        return [pscustomobject]@{ Online = $false; Host = ''; Error = $_.Exception.Message }
    }
    if ($result.ok -and $result.online) {
        $Context.ActiveHost = [string]$result.host
        $probeOs = [string]$result.os
        # 只接受具体系统类型；不要把已保存的 Windows/macOS 降级成通用 posix。
        if ($probeOs -and ($probeOs -ne 'posix' -or [string]::IsNullOrWhiteSpace([string]$Context.Os))) {
            $Context.Os = $probeOs
        }
        return [pscustomobject]@{ Online = $true; Host = [string]$result.host; Error = '' }
    }
    $message = [string]$result.error
    if (-not $message) { $message = '设备不可达' }
    $Context.LastError = $message
    return [pscustomobject]@{ Online = $false; Host = [string]$result.host; Error = $message }
}

function Get-ContextHome($Context) {
    if ($Context.Home) { return $Context.Home }
    if ($Context.Kind -eq 'mac') {
        $Context.Home = Get-RemoteHome $Context.Config
        return $Context.Home
    }
    if ($Context.Os -eq 'windows') {
        $value = (Invoke-ContextRemote $Context "[Environment]::GetFolderPath('UserProfile')" 30).Trim()
        if ([string]::IsNullOrWhiteSpace($value)) { throw '无法获取 Windows 设备的主目录。' }
        $Context.Home = $value.Replace('\', '/').TrimEnd('/')
        return $Context.Home
    }
    $value = (Invoke-ContextRemote $Context 'printf %s "$HOME"' 30).Trim()
    if ([string]::IsNullOrWhiteSpace($value)) { throw '无法获取远端用户主目录。' }
    $Context.Home = $value.TrimEnd('/')
    return $Context.Home
}

function Resolve-ContextPath($Context, [string]$Path) {
    $value = [string]$Path
    if ([string]::IsNullOrWhiteSpace($value)) { return (Get-ContextHome $Context) }
    if ($value -eq '~') { return (Get-ContextHome $Context) }
    if ($value.StartsWith('~/') -or $value.StartsWith('~\')) {
        return ((Get-ContextHome $Context) + '/' + $value.Substring(2).TrimStart('\', '/'))
    }
    if ($Context.Os -eq 'windows') {
        $value = $value.Replace('\', '/').TrimEnd('/')
        if ($value -match '^[A-Za-z]:$') { return ($value + '/') }
        if ($value -notmatch '^[A-Za-z]:/' -and -not $value.StartsWith('/')) {
            return ((Get-ContextHome $Context) + '/' + $value.TrimStart('/'))
        }
        return $value
    }
    return $value.TrimEnd('/')
}

function New-WindowsScript([string]$Body) {
    return @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding(`$false)
"@ + "`n" + $Body
}

function Invoke-ContextRemote($Context, [string]$Script, [int]$TimeoutSeconds = 180) {
    if ($Context.Kind -eq 'mac') {
        return (Invoke-Remote $Context.Config $Script $TimeoutSeconds)
    }

    $osName = 'posix'
    if ($Context.Os -eq 'windows') { $osName = 'windows' }
    elseif ([string]::IsNullOrWhiteSpace($Context.Os)) { $osName = '' }

    $request = @{
        op        = 'exec'
        deviceId  = $Context.DeviceId
        script    = $Script
        timeoutMs = $TimeoutSeconds * 1000
    }
    if ($osName) { $request.os = $osName }
    $result = Invoke-SshBridge $request ($TimeoutSeconds + 30)
    if (-not $result.ok) {
        $detail = ([string]$result.stderr).Trim()
        if (-not $detail) { $detail = ([string]$result.stdout).Trim() }
        if (-not $detail) { $detail = 'exit ' + [string]$result.code }
        throw ("设备 {0} 执行失败: {1}" -f $Context.Name, $detail)
    }
    return ([string]$result.stdout).Trim()
}

function Test-ContextPathType($Context, [string]$RemotePath) {
    if ($Context.Kind -eq 'mac' -or $Context.Os -ne 'windows') {
        $q = Quote-Remote $RemotePath
        $result = Invoke-ContextRemote $Context ("if [ -d $q ]; then echo dir; elif [ -e $q ]; then echo file; else echo none; fi") 30
        return $result.Trim()
    }
    $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes($RemotePath))
    $script = New-WindowsScript @"
`$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64'))
if (Test-Path -LiteralPath `$p -PathType Container) { 'dir' }
elseif (Test-Path -LiteralPath `$p) { 'file' }
else { 'none' }
"@
    return (Invoke-ContextRemote $Context $script 30).Trim()
}

function Ensure-ContextDirectory($Context, [string]$RemotePath) {
    if ($Context.Kind -eq 'mac' -or $Context.Os -ne 'windows') {
        Invoke-ContextRemote $Context ("mkdir -p " + (Quote-Remote $RemotePath)) 60 | Out-Null
        return
    }
    $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes($RemotePath))
    $script = New-WindowsScript @"
`$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64'))
New-Item -ItemType Directory -Force -Path `$p | Out-Null
"@
    Invoke-ContextRemote $Context $script 60 | Out-Null
}
