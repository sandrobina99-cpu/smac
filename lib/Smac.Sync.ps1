# Smac.Sync.ps1 - Win<->Mac 双向文件夹同步（由 smac.ps1 点源加载）
# 依赖 smac.ps1 中的核心函数：Invoke-Remote / Quote-Remote / Get-ScpArgs / Get-ConfiguredHostName 等

$script:SyncStopFile        = Join-Path $script:DataDir 'watch.stop'
$script:SyncPidFile         = Join-Path $script:DataDir 'watch.pid'
$script:SyncStatusPath      = Join-Path $script:DataDir 'sync-status.json'
$script:SyncLogPath         = Join-Path $script:DataDir 'sync.log'
$script:SyncMutexName       = 'Local\smac-sync-lock'
$script:SyncDefaultExcludes = @('.DS_Store', 'Thumbs.db', 'desktop.ini', '~$*', '.smac-tmp-*')
$script:SyncMutex           = $null
$script:SyncRunning         = $false

function Ensure-SyncDataDir {
    if (-not (Test-Path -LiteralPath $script:DataDir)) {
        New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null
    }
}

function Write-SyncLog([string]$Message) {
    try {
        Ensure-SyncDataDir
        if ((Test-Path -LiteralPath $script:SyncLogPath) -and ((Get-Item -LiteralPath $script:SyncLogPath).Length -gt 5MB)) {
            Move-Item -LiteralPath $script:SyncLogPath -Destination ($script:SyncLogPath + '.1') -Force
        }
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $script:SyncLogPath -Value ("$stamp | $Message") -Encoding UTF8
    }
    catch { }
}

function ConvertTo-SyncSafeName([string]$Name) {
    $safe = ($Name -replace '[^\w.\-]', '_')
    if ([string]::IsNullOrWhiteSpace($safe)) { $safe = 'sync' }
    return $safe
}

function Get-SyncStatePath([string]$PairName) {
    return (Join-Path $script:DataDir ('sync-state-' + (ConvertTo-SyncSafeName $PairName) + '.json'))
}

function Get-SyncPairs($Config) {
    return @($Config.syncPairs | Where-Object { $_ -and -not [string]::IsNullOrWhiteSpace([string]$_.name) })
}

function Get-SyncPair($Config, [string]$Name) {
    return (Get-SyncPairs $Config | Where-Object { $_.name -eq $Name } | Select-Object -First 1)
}

function Save-SyncPairs($Config, [object[]]$Pairs) {
    $Config.syncPairs = @($Pairs)
    Save-SmacConfig $Config
}

function New-SyncPairName($Config, [string]$LocalPath) {
    $base = Split-Path -Leaf ($LocalPath.TrimEnd('\', '/'))
    if ([string]::IsNullOrWhiteSpace($base)) { $base = 'sync' }
    $base = ConvertTo-SyncSafeName $base
    $names = @(Get-SyncPairs $Config | ForEach-Object { [string]$_.name })
    $name = $base
    $i = 2
    while ($names -contains $name) { $name = "$base-$i"; $i++ }
    return $name
}

function Get-SyncInterval($Config) {
    $value = 20
    if ($Config.syncIntervalSeconds) { $value = [int]$Config.syncIntervalSeconds }
    if ($value -lt 5) { $value = 5 }
    return $value
}

function Test-SyncExcluded([string]$RelativePath) {
    $leaf = $RelativePath
    $idx = $RelativePath.LastIndexOf('/')
    if ($idx -ge 0) { $leaf = $RelativePath.Substring($idx + 1) }
    foreach ($pattern in $script:SyncDefaultExcludes) {
        if ($leaf -like $pattern) { return $true }
    }
    return $false
}

function Get-LocalPathFromRel([string]$Root, [string]$RelativePath) {
    return (Join-Path $Root ($RelativePath.Replace('/', '\')))
}

function Get-RemotePathFromRel([string]$Root, [string]$RelativePath) {
    return ($Root.TrimEnd('/') + '/' + $RelativePath)
}

function Resolve-SyncRemoteRoot($Config, [string]$Value) {
    if ($Value -eq '~' -or $Value.StartsWith('~/')) { return Resolve-RemotePath $Config $Value }
    if ($Value.StartsWith('/')) { return $Value.TrimEnd('/') }
    return ((Get-RemoteHome $Config) + '/' + $Value.TrimStart('/'))
}

function Assert-SyncPairRoots($Config, [string]$LocalRoot, [string]$RemoteRoot) {
    $localFull = [IO.Path]::GetFullPath($LocalRoot).TrimEnd('\', '/')
    $localHome = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\', '/')
    $drive = [IO.Path]::GetPathRoot($localFull).TrimEnd('\', '/')
    if ($localFull -eq $drive) { throw "不能同步整个盘符: $localFull" }
    if ($localFull -eq $localHome) { throw "不能同步整个用户目录: $localFull" }
    if ($localHome.StartsWith($localFull + '\')) { throw "Windows 目录范围过大: $localFull" }

    if ($RemoteRoot -eq '/' -or [string]::IsNullOrWhiteSpace($RemoteRoot)) { throw '不能同步 Mac 根目录 /' }
    $remoteHome = Get-RemoteHome $Config
    $remoteTrim = $RemoteRoot.TrimEnd('/')
    if ($remoteTrim -eq $remoteHome) { throw "不能同步整个 Mac 用户目录: $RemoteRoot" }
    if ($remoteHome.StartsWith($remoteTrim + '/')) { throw "Mac 目录范围过大: $RemoteRoot" }
}

# ---------------- 状态文件 ----------------

function Read-SyncState([string]$Path) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    try {
        $obj = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($obj.files) {
            foreach ($property in $obj.files.PSObject.Properties) {
                $value = $property.Value
                if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value.hash)) { continue }
                $map[$property.Name] = @{
                    hash = [string]$value.hash
                    lm   = [long]$value.lm
                    ls   = [long]$value.ls
                    rm   = [long]$value.rm
                    rs   = [long]$value.rs
                }
            }
        }
    }
    catch {
        Write-SyncLog ("读取同步状态失败: {0} | {1}" -f $Path, $_.Exception.Message)
    }
    return $map
}

function Write-SyncState([string]$Path, [hashtable]$Map) {
    Ensure-SyncDataDir
    $files = [ordered]@{}
    foreach ($key in ($Map.Keys | Sort-Object)) {
        $value = $Map[$key]
        $files[$key] = [ordered]@{
            hash = $value.hash
            lm   = $value.lm
            ls   = $value.ls
            rm   = $value.rm
            rs   = $value.rs
        }
    }
    $payload = [ordered]@{
        version = 1
        savedAt = (Get-Date).ToString('o')
        files   = $files
    }
    $json = $payload | ConvertTo-Json -Depth 6
    $tmp = $Path + '.tmp'
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function New-SyncStateEntry([string]$Hash, [long]$LocalMtime, [long]$LocalSize, [long]$RemoteMtime, [long]$RemoteSize) {
    return @{
        hash = $Hash
        lm   = $LocalMtime
        ls   = $LocalSize
        rm   = $RemoteMtime
        rs   = $RemoteSize
    }
}

# ---------------- 扫描 ----------------

function Get-LocalFileIndex([string]$Root) {
    $rootFull = (Get-Item -LiteralPath $Root -Force).FullName.TrimEnd('\', '/')
    $map = @{}
    foreach ($file in (Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force -ErrorAction Stop)) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        $relative = $file.FullName.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
        if (Test-SyncExcluded $relative) { continue }
        $map[$relative] = [pscustomobject]@{
            Size     = [long]$file.Length
            Mtime    = [long]([DateTimeOffset]::new($file.LastWriteTimeUtc).ToUnixTimeSeconds())
            FullName = $file.FullName
        }
    }
    return $map
}

function Get-RemoteFileIndex($Config, [string]$RemoteRoot) {
    $q = Quote-Remote $RemoteRoot
    $exclude = ''
    foreach ($pattern in $script:SyncDefaultExcludes) {
        $exclude += ' ! -name ' + (Quote-Remote $pattern)
    }
    $cmd = "cd $q || exit 9`nfind . -type f$exclude -exec stat -f '%m|%z|%N' {} + | base64"
    $text = Invoke-Remote $Config $cmd
    $b64 = ($text -replace '\s', '')
    $map = @{}
    if ([string]::IsNullOrEmpty($b64)) { return $map }

    $decoded = $script:Utf8.GetString([Convert]::FromBase64String($b64))
    foreach ($line in ($decoded -split "`n")) {
        $line = $line.TrimEnd("`r")
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -match '^(\d+)\|(\d+)\|\./(.+)$') {
            $map[$Matches[3]] = [pscustomobject]@{
                Mtime = [long]$Matches[1]
                Size  = [long]$Matches[2]
            }
        }
    }
    return $map
}

function Get-RemoteHashes($Config, [string]$RemoteRoot, [string[]]$RelativePaths) {
    $result = @{}
    if (-not $RelativePaths -or $RelativePaths.Count -eq 0) { return $result }

    $batchSize = 100
    for ($i = 0; $i -lt $RelativePaths.Count; $i += $batchSize) {
        $end = [Math]::Min($i + $batchSize - 1, $RelativePaths.Count - 1)
        $batch = $RelativePaths[$i..$end]
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add("cd " + (Quote-Remote $RemoteRoot) + " || exit 9")
        $lines.Add('{')
        foreach ($relative in $batch) {
            $lines.Add("shasum -a 256 " + (Quote-Remote ('./' + $relative)) + " 2>/dev/null")
        }
        $lines.Add('} | base64')
        $text = Invoke-Remote $Config ($lines -join "`n")
        $b64 = ($text -replace '\s', '')
        if ([string]::IsNullOrEmpty($b64)) { continue }
        $decoded = $script:Utf8.GetString([Convert]::FromBase64String($b64))
        foreach ($line in ($decoded -split "`n")) {
            if ($line -match '^([0-9a-fA-F]{64})\s+\./(.+)$') {
                $result[$Matches[2]] = $Matches[1].ToLower()
            }
        }
    }
    return $result
}

# ---------------- 传输 ----------------

function Ensure-RemoteParents($Config, [string]$RemoteRoot, [System.Collections.Generic.HashSet[string]]$RelativePaths) {
    $parents = New-Object System.Collections.Generic.HashSet[string]
    foreach ($relative in $RelativePaths) {
        $parent = $RemoteRoot.TrimEnd('/')
        $idx = $relative.LastIndexOf('/')
        if ($idx -gt 0) { $parent = $parent + '/' + $relative.Substring(0, $idx) }
        [void]$parents.Add($parent)
    }
    $items = @($parents)
    for ($i = 0; $i -lt $items.Count; $i += 50) {
        $end = [Math]::Min($i + 49, $items.Count - 1)
        $batch = $items[$i..$end]
        $quoted = ($batch | ForEach-Object { Quote-Remote $_ }) -join ' '
        Invoke-Remote $Config ("mkdir -p $quoted") | Out-Null
    }
}

function Push-SyncFile($Config, [string]$LocalFull, [string]$RemoteFull, [string]$ExpectedHash) {
    $tmpPath = $RemoteFull + '.smac-tmp-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $scpArgs = (Get-ScpArgs $Config) + @($LocalFull, (Remote-TargetString $Config $tmpPath))
    $scp = Invoke-NativeCapture $script:ScpExe $scpArgs 7200
    if ($scp.TimedOut) { throw 'scp 上传超时，连接已中断' }
    if ($scp.Code -ne 0) { throw ("scp 上传失败 (exit {0}): {1}" -f $scp.Code, $scp.Output.Trim()) }

    $qTmp = Quote-Remote $tmpPath
    $qTarget = Quote-Remote $RemoteFull
    $template = @'
if [ -d {{TARGET}} ]; then echo SMAC_DIR_CONFLICT; rm -f {{TMP}}; exit 3; fi
h=$(shasum -a 256 {{TMP}} | cut -c1-64)
if [ "$h" != "{{HASH}}" ]; then echo "SMAC_HASH $h"; rm -f {{TMP}}; exit 4; fi
mv -f {{TMP}} {{TARGET}}
st=$(stat -f '%m|%z' {{TARGET}})
echo "SMAC_OK $st"
'@
    $verify = $template.Replace('{{TARGET}}', $qTarget).Replace('{{TMP}}', $qTmp).Replace('{{HASH}}', $ExpectedHash)
    $out = Invoke-Remote $Config $verify
    if ($out -notmatch 'SMAC_OK (\d+)\|(\d+)') {
        throw "远端写入失败: $out"
    }
    return [pscustomobject]@{
        Hash  = $ExpectedHash
        Mtime = [long]$Matches[1]
        Size  = [long]$Matches[2]
    }
}

function Pull-SyncFile($Config, [string]$RemoteFull, [string]$LocalFull, [string]$ExpectedHash) {
    $localDir = Split-Path -Parent $LocalFull
    if (-not (Test-Path -LiteralPath $localDir)) {
        New-Item -ItemType Directory -Path $localDir -Force | Out-Null
    }
    $tmpPath = Join-Path $localDir ('.smac-tmp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $scpArgs = (Get-ScpArgs $Config) + @((Remote-TargetString $Config $RemoteFull), $tmpPath)
    $scp = Invoke-NativeCapture $script:ScpExe $scpArgs 7200
    if ($scp.TimedOut) { throw 'scp 下载超时，连接已中断' }
    if ($scp.Code -ne 0) { throw ("scp 下载失败 (exit {0}): {1}" -f $scp.Code, $scp.Output.Trim()) }

    try {
        $hash = Get-LocalSha256 $tmpPath
        if ($hash -ne $ExpectedHash) {
            throw "下载校验失败: 期望 $ExpectedHash 实际 $hash"
        }
        Move-Item -LiteralPath $tmpPath -Destination $LocalFull -Force
    }
    catch {
        Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
        throw
    }

    $file = Get-Item -LiteralPath $LocalFull
    return [pscustomobject]@{
        Hash       = $hash
        LocalMtime = [long]([DateTimeOffset]::new($file.LastWriteTimeUtc).ToUnixTimeSeconds())
        LocalSize  = [long]$file.Length
    }
}

# ---------------- 回收站 ----------------

function Move-LocalFilesToTrash([string]$PairName, [string]$LocalRoot, [string[]]$RelativePaths) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $trashRoot = Join-Path (Join-Path (Join-Path $script:DataDir 'trash') (ConvertTo-SyncSafeName $PairName)) $stamp
    foreach ($relative in $RelativePaths) {
        $source = Get-LocalPathFromRel $LocalRoot $relative
        if (-not (Test-Path -LiteralPath $source)) { continue }
        $destination = Join-Path $trashRoot ($relative.Replace('/', '\'))
        $destinationDir = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $destinationDir)) {
            New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
        }
        Move-Item -LiteralPath $source -Destination $destination -Force
    }
}

function Move-RemoteFilesToTrash($Config, [string]$PairName, [string]$RemoteRoot, [string[]]$RelativePaths) {
    if (-not $RelativePaths -or $RelativePaths.Count -eq 0) { return }
    $remoteHomePath = Get-RemoteHome $Config
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $trashRoot = $remoteHomePath + '/.smac-trash/' + (ConvertTo-SyncSafeName $PairName) + '/' + $stamp

    $lines = @(
        ("cd " + (Quote-Remote $RemoteRoot) + " || exit 9"),
        ("mkdir -p " + (Quote-Remote $trashRoot))
    )
    foreach ($relative in $RelativePaths) {
        $source = './' + $relative
        $destination = $trashRoot + '/' + $relative
        $parent = $destination.Substring(0, $destination.LastIndexOf('/'))
        $lines += ("mkdir -p " + (Quote-Remote $parent))
        $lines += ("if [ -e " + (Quote-Remote $source) + " ]; then mv -f " + (Quote-Remote $source) + " " + (Quote-Remote $destination) + " || echo " + (Quote-Remote ('SMAC_DELFAIL ' + $relative)) + "; fi")
    }
    $lines += 'echo SMAC_DELETE_DONE'
    $out = Invoke-Remote $Config ($lines -join "`n")
    if ($out -notmatch 'SMAC_DELETE_DONE') { throw "远端删除未完成: $out" }
    if ($out -match 'SMAC_DELFAIL') { throw "部分远端文件删除失败: $out" }
}

# ---------------- 冲突命名 ----------------

function Get-SyncConflictRel([string]$RelativePath, [string]$Stamp, [int]$Counter = 0) {
    $dir = ''
    $leaf = $RelativePath
    $idx = $RelativePath.LastIndexOf('/')
    if ($idx -ge 0) {
        $dir = $RelativePath.Substring(0, $idx + 1)
        $leaf = $RelativePath.Substring($idx + 1)
    }
    $extension = [IO.Path]::GetExtension($leaf)
    $base = [IO.Path]::GetFileNameWithoutExtension($leaf)
    $suffix = '.conflict-mac-' + $Stamp
    if ($Counter -gt 0) { $suffix += '-' + $Counter }
    return ($dir + $base + $suffix + $extension)
}

# ---------------- 锁 ----------------

function Enter-SyncLock([int]$TimeoutMilliseconds = 0) {
    if ($script:SyncMutex) { return $true }
    $mutex = [System.Threading.Mutex]::new($false, $script:SyncMutexName)
    if ($mutex.WaitOne($TimeoutMilliseconds)) {
        $script:SyncMutex = $mutex
        return $true
    }
    $mutex.Dispose()
    return $false
}

function Exit-SyncLock {
    if ($script:SyncMutex) {
        try { $script:SyncMutex.ReleaseMutex() } catch { }
        $script:SyncMutex.Dispose()
        $script:SyncMutex = $null
    }
}

# ---------------- 在线握手探测 ----------------

# 每轮同步前做一次轻量握手：先探局域网地址，再探 Tailscale 地址。
# 返回可达的地址；都不可达返回 $null（此时调用方应整轮静默跳过，不刷错误日志）。
function Test-MacPresence($Config) {
    if (-not [string]::IsNullOrWhiteSpace([string]$Config.lanHost)) {
        if (Test-SshHost $Config ([string]$Config.lanHost) 3) { return [string]$Config.lanHost }
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Config.host)) {
        if (Test-SshHost $Config ([string]$Config.host) 3) { return [string]$Config.host }
    }
    return $null
}

# ---------------- 单对目录同步 ----------------

function Invoke-PairSync($Config, $Pair, $Context = $null) {
    $started = Get-Date
    if (-not $Context) {
        $Context = New-RemoteContext $Config ([string]$Pair.deviceId)
        if ($Context.Kind -ne 'mac') {
            $presence = Test-ContextPresence $Context 20000
            if (-not $presence.Online) { throw ("设备 {0} 不可达: {1}" -f $Context.Name, $presence.Error) }
        }
    }
    $summary = [pscustomobject]@{
        Name       = $Pair.name
        DeviceId   = [string]$Context.DeviceId
        DeviceName = [string]$Context.Name
        Uploaded   = 0
        Downloaded = 0
        Deleted    = 0
        Conflicts  = 0
        Adopted    = 0
        Failed     = 0
        Error      = ''
        At         = (Get-Date).ToString('o')
        DurationMs = 0
    }

    $localRoot = [IO.Path]::GetFullPath([string]$Pair.local)
    if (-not (Test-Path -LiteralPath $localRoot -PathType Container)) {
        throw "Windows 文件夹不存在: $localRoot"
    }
    $remoteRoot = Resolve-ContextRemoteRoot $Context ([string]$Pair.remote)
    Assert-ContextPairRoots $Context $localRoot $remoteRoot

    Ensure-ContextDirectory $Context $remoteRoot

    $statePath = Get-SyncStatePath $Pair.name
    $state = Read-SyncState $statePath
    $localIndex = Get-LocalFileIndex $localRoot
    $remoteIndex = Get-ContextFileIndex $Context $remoteRoot

    $all = New-Object System.Collections.Generic.HashSet[string]
    foreach ($key in $localIndex.Keys) { [void]$all.Add($key) }
    foreach ($key in $remoteIndex.Keys) { [void]$all.Add($key) }
    foreach ($key in $state.Keys) { [void]$all.Add($key) }

    $localHashes = @{}
    $remoteHashCandidates = New-Object System.Collections.Generic.List[string]
    foreach ($relative in $all) {
        $localItem = $localIndex[$relative]
        $stateItem = $state[$relative]
        if ($localItem) {
            if ($stateItem -and $localItem.Size -eq $stateItem.ls -and $localItem.Mtime -eq $stateItem.lm) {
                $localHashes[$relative] = $stateItem.hash
            }
            else {
                try { $localHashes[$relative] = Get-LocalSha256 $localItem.FullName }
                catch { $summary.Failed++; continue }
            }
        }

        $remoteItem = $remoteIndex[$relative]
        if ($remoteItem) {
            if (-not ($stateItem -and $remoteItem.Size -eq $stateItem.rs -and $remoteItem.Mtime -eq $stateItem.rm)) {
                $remoteHashCandidates.Add($relative)
            }
        }
    }

    $remoteHashes = @{}
    if ($remoteHashCandidates.Count -gt 0) {
        $remoteHashes = Get-ContextHashes $Context $remoteRoot @($remoteHashCandidates)
    }

    $actions = @()
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $conflictLabel = 'mac'
    if ($Context.Kind -ne 'mac') { $conflictLabel = $Context.Name }
    foreach ($relative in $all) {
        $localItem = $localIndex[$relative]
        $remoteItem = $remoteIndex[$relative]
        $stateItem = $state[$relative]
        $localHash = $null
        $remoteHash = $null

        if ($localItem) {
            if (-not $localHashes.ContainsKey($relative)) { continue }
            $localHash = $localHashes[$relative]
        }
        if ($remoteItem) {
            if ($remoteHashes.ContainsKey($relative)) {
                $remoteHash = $remoteHashes[$relative]
            }
            elseif ($stateItem -and $remoteItem.Size -eq $stateItem.rs -and $remoteItem.Mtime -eq $stateItem.rm) {
                $remoteHash = $stateItem.hash
            }
            else {
                continue
            }
        }

        if ($localItem -and $remoteItem) {
            if ($localHash -eq $remoteHash) {
                $needAdopt = (-not $stateItem) -or ($stateItem.hash -ne $localHash) -or
                    ($localItem.Mtime -ne $stateItem.lm) -or ($localItem.Size -ne $stateItem.ls) -or
                    ($remoteItem.Mtime -ne $stateItem.rm) -or ($remoteItem.Size -ne $stateItem.rs)
                if ($needAdopt) {
                    $actions += @{ Type = 'adopt'; Rel = $relative; Hash = $localHash }
                }
                continue
            }
            $localChanged = (-not $stateItem) -or ($localHash -ne $stateItem.hash)
            $remoteChanged = (-not $stateItem) -or ($remoteHash -ne $stateItem.hash)
            if ($localChanged -and $remoteChanged) {
                $conflictRel = Get-ContextConflictRel $relative $stamp 0 $conflictLabel
                $counter = 1
                while (Test-Path -LiteralPath (Get-LocalPathFromRel $localRoot $conflictRel)) {
                    $conflictRel = Get-ContextConflictRel $relative $stamp $counter $conflictLabel
                    $counter++
                    if ($counter -gt 100) { break }
                }
                $actions += @{ Type = 'conflict'; Rel = $relative; LocalHash = $localHash; RemoteHash = $remoteHash; ConflictRel = $conflictRel }
            }
            elseif ($localChanged) {
                $actions += @{ Type = 'upload'; Rel = $relative; Hash = $localHash }
            }
            else {
                $actions += @{ Type = 'download'; Rel = $relative; Hash = $remoteHash }
            }
        }
        elseif ($localItem -and -not $remoteItem) {
            if (-not $stateItem) {
                $actions += @{ Type = 'upload'; Rel = $relative; Hash = $localHash }
            }
            elseif ($localHash -ne $stateItem.hash) {
                $actions += @{ Type = 'upload'; Rel = $relative; Hash = $localHash; Resurrect = $true }
            }
            else {
                $actions += @{ Type = 'deleteLocal'; Rel = $relative }
            }
        }
        elseif (-not $localItem -and $remoteItem) {
            if (-not $stateItem) {
                $actions += @{ Type = 'download'; Rel = $relative; Hash = $remoteHash }
            }
            elseif ($remoteHash -ne $stateItem.hash) {
                $actions += @{ Type = 'download'; Rel = $relative; Hash = $remoteHash; Resurrect = $true }
            }
            else {
                $actions += @{ Type = 'deleteRemote'; Rel = $relative }
            }
        }
        elseif ($stateItem) {
            $actions += @{ Type = 'dropState'; Rel = $relative }
        }
    }

    $uploadRels = New-Object System.Collections.Generic.HashSet[string]
    foreach ($action in $actions) {
        if ($action.Type -eq 'upload') { [void]$uploadRels.Add($action.Rel) }
        if ($action.Type -eq 'conflict') {
            [void]$uploadRels.Add($action.Rel)
            [void]$uploadRels.Add($action.ConflictRel)
        }
    }
    if ($uploadRels.Count -gt 0) {
        Ensure-ContextParents $Context $remoteRoot $uploadRels
    }

    $remoteDeletes = New-Object System.Collections.Generic.List[string]
    foreach ($action in $actions) {
        try {
            $relative = $action.Rel
            switch ($action.Type) {
                'adopt' {
                    $li = $localIndex[$relative]
                    $ri = $remoteIndex[$relative]
                    $state[$relative] = New-SyncStateEntry $action.Hash $li.Mtime $li.Size $ri.Mtime $ri.Size
                    $summary.Adopted++
                }
                'upload' {
                    $li = $localIndex[$relative]
                    $remoteFull = Get-RemotePathFromRel $remoteRoot $relative
                    $result = Push-ContextFile $Context $li.FullName $remoteFull $action.Hash
                    $state[$relative] = New-SyncStateEntry $action.Hash $li.Mtime $li.Size $result.Mtime $result.Size
                    $summary.Uploaded++
                    if ($action.Resurrect) {
                        Write-SyncLog ("{0} | 远端已删除但本地有修改，已恢复: {1}" -f $Pair.name, $relative)
                    }
                }
                'download' {
                    $ri = $remoteIndex[$relative]
                    $localFull = Get-LocalPathFromRel $localRoot $relative
                    $remoteFull = Get-RemotePathFromRel $remoteRoot $relative
                    $result = Pull-ContextFile $Context $remoteFull $localFull $action.Hash
                    $state[$relative] = New-SyncStateEntry $action.Hash $result.LocalMtime $result.LocalSize $ri.Mtime $ri.Size
                    $summary.Downloaded++
                    if ($action.Resurrect) {
                        Write-SyncLog ("{0} | 本地已删除但远端有修改，已恢复: {1}" -f $Pair.name, $relative)
                    }
                }
                'conflict' {
                    $li = $localIndex[$relative]
                    $ri = $remoteIndex[$relative]
                    $mainRemote = Get-RemotePathFromRel $remoteRoot $relative
                    $conflictLocal = Get-LocalPathFromRel $localRoot $action.ConflictRel
                    $conflictRemote = Get-RemotePathFromRel $remoteRoot $action.ConflictRel

                    Pull-ContextFile $Context $mainRemote $conflictLocal $action.RemoteHash | Out-Null
                    $mainResult = Push-ContextFile $Context $li.FullName $mainRemote $action.LocalHash
                    $conflictResult = Push-ContextFile $Context $conflictLocal $conflictRemote $action.RemoteHash

                    $conflictFile = Get-Item -LiteralPath $conflictLocal
                    $conflictMtime = [long]([DateTimeOffset]::new($conflictFile.LastWriteTimeUtc).ToUnixTimeSeconds())
                    $state[$relative] = New-SyncStateEntry $action.LocalHash $li.Mtime $li.Size $mainResult.Mtime $mainResult.Size
                    $state[$action.ConflictRel] = New-SyncStateEntry $action.RemoteHash $conflictMtime ([long]$conflictFile.Length) $conflictResult.Mtime $conflictResult.Size
                    $summary.Conflicts++
                    Write-SyncLog ("{0} | 冲突，已保留两份: {1} -> {2}" -f $Pair.name, $relative, $action.ConflictRel)
                }
                'deleteLocal' {
                    Move-LocalFilesToTrash $Pair.name $localRoot @($relative)
                    $state.Remove($relative)
                    $summary.Deleted++
                    Write-SyncLog ("{0} | 已按远端删除（本机回收站）: {1}" -f $Pair.name, $relative)
                }
                'deleteRemote' {
                    $remoteDeletes.Add($relative)
                }
                'dropState' {
                    $state.Remove($relative)
                }
            }
        }
        catch {
            $summary.Failed++
            $summary.Error = $_.Exception.Message
            Write-SyncLog ("{0} | 同步失败 {1}: {2}" -f $Pair.name, $action.Rel, $_.Exception.Message)
        }
    }

    if ($remoteDeletes.Count -gt 0) {
        try {
            Move-ContextFilesToTrash $Context $Pair.name $remoteRoot @($remoteDeletes)
            foreach ($relative in $remoteDeletes) {
                $state.Remove($relative)
                $summary.Deleted++
                Write-SyncLog ("{0} | 已按本机删除（{1} 回收站）: {2}" -f $Pair.name, $Context.Name, $relative)
            }
        }
        catch {
            $summary.Failed++
            $summary.Error = $_.Exception.Message
            Write-SyncLog ("{0} | 远端删除失败: {1}" -f $Pair.name, $_.Exception.Message)
        }
    }

    Write-SyncState $statePath $state
    $summary.DurationMs = [long]((Get-Date) - $started).TotalMilliseconds
    if ($summary.Uploaded -gt 0 -or $summary.Downloaded -gt 0 -or $summary.Deleted -gt 0 -or $summary.Conflicts -gt 0 -or $summary.Failed -gt 0) {
        Write-SyncLog ("{0} | up={1} down={2} del={3} conflict={4} adopt={5} fail={6} {7}ms" -f $Pair.name, $summary.Uploaded, $summary.Downloaded, $summary.Deleted, $summary.Conflicts, $summary.Adopted, $summary.Failed, $summary.DurationMs)
    }
    return $summary
}

function Invoke-PairSyncSafe($Config, $Pair, $Context = $null) {
    try {
        return Invoke-PairSync $Config $Pair $Context
    }
    catch {
        $errorMessage = $_.Exception.Message
        Write-SyncLog ("{0} | 同步异常: {1}" -f $Pair.name, $errorMessage)
        $deviceName = 'Mac'
        $deviceId = ''
        if ($Pair.PSObject.Properties['deviceId']) { $deviceId = [string]$Pair.deviceId }
        if ($Context) { $deviceName = [string]$Context.Name }
        elseif ($deviceId) {
            $device = Find-SmacDevice $deviceId
            if ($device) { $deviceName = [string]$device.name }
            else { $deviceName = '(设备已删除)' }
        }
        return [pscustomobject]@{
            Name       = $Pair.name
            DeviceId   = $deviceId
            DeviceName = $deviceName
            Uploaded   = 0
            Downloaded = 0
            Deleted    = 0
            Conflicts  = 0
            Adopted    = 0
            Failed     = 1
            Error      = $errorMessage
            At         = (Get-Date).ToString('o')
            DurationMs = 0
        }
    }
}

# ---------------- 后台守护 ----------------

function Get-SyncWatcherPid {
    if (-not (Test-Path -LiteralPath $script:SyncPidFile)) { return 0 }
    $raw = (Get-Content -LiteralPath $script:SyncPidFile -Raw -ErrorAction SilentlyContinue)
    $watcherPid = 0
    if ($raw -and [int]::TryParse($raw.Trim(), [ref]$watcherPid)) {
        $process = Get-Process -Id $watcherPid -ErrorAction SilentlyContinue
        if ($process) { return $watcherPid }
    }
    Remove-Item -LiteralPath $script:SyncPidFile -Force -ErrorAction SilentlyContinue
    return 0
}

function Write-SyncStatus($Status) {
    try {
        Ensure-SyncDataDir
        $tmp = $script:SyncStatusPath + '.tmp'
        $Status | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $script:SyncStatusPath -Force
    }
    catch { }
}

function Start-SyncWatcher {
    $existing = Get-SyncWatcherPid
    if ($existing) {
        Write-Host ("同步守护已在运行 (PID {0})" -f $existing)
        return 0
    }

    Ensure-SyncDataDir
    Remove-Item -LiteralPath $script:SyncStopFile -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $script:SyncPidFile -Value $PID -Encoding ASCII
    $script:SyncRunning = $true
    Write-SyncLog ("同步守护启动 PID={0}" -f $PID)

    $startedAt = (Get-Date).ToString('o')
    $status = [ordered]@{
        running         = $true
        pid             = $PID
        startedAt       = $startedAt
        lastCycleAt     = $null
        nextRunAt       = $null
        host            = $script:ActiveHost
        intervalSeconds = 20
        pairs           = @()
        devices         = @()
    }
    Write-SyncStatus $status

    $macOnline = $null      # $null=未知(首轮) $true=在线 $false=离线静默中
    $offlineSince = $null
    $targetOnline = @{}
    $targetSince = @{}
    $deviceStatus = @()
    $lastPairResults = @()

    try {
        while (-not (Test-Path -LiteralPath $script:SyncStopFile)) {
            $config = $null
            $interval = 20
            $pairResults = $lastPairResults
            try {
                $config = Get-SmacConfig
                $interval = Get-SyncInterval $config
                $pairs = Get-SyncPairs $config
                $hostName = $script:ActiveHost
                $pairResults = @()
                $targetInfos = [ordered]@{}
                $roundContexts = @{}

                foreach ($pair in $pairs) {
                    if (Test-Path -LiteralPath $script:SyncStopFile) { break }
                    if ($pair.PSObject.Properties['enabled'] -and $pair.enabled -eq $false) { continue }

                    $previousEntry = $null
                    foreach ($old in $lastPairResults) {
                        if ($old.name -eq $pair.name) {
                            $previousEntry = $old
                            break
                        }
                    }

                    $context = $null
                    try {
                        $context = New-RemoteContext $config ([string]$pair.deviceId)
                    }
                    catch {
                        $errText = $_.Exception.Message
                        Write-SyncLog ("{0} | 跳过：无法读取远程设备配置（{1}）" -f $pair.name, $errText)
                        $pairResults += [ordered]@{
                            name       = $pair.name
                            deviceId   = [string]$pair.deviceId
                            deviceName = $(if ($pair.deviceId) { '(设备已删除)' } else { 'Mac' })
                            online     = $false
                            lastRun    = $(if ($previousEntry) { $previousEntry.lastRun } else { $null })
                            uploaded   = $(if ($previousEntry) { $previousEntry.uploaded } else { 0 })
                            downloaded = $(if ($previousEntry) { $previousEntry.downloaded } else { 0 })
                            deleted    = $(if ($previousEntry) { $previousEntry.deleted } else { 0 })
                            conflicts  = $(if ($previousEntry) { $previousEntry.conflicts } else { 0 })
                            adopted    = $(if ($previousEntry) { $previousEntry.adopted } else { 0 })
                            failed     = 1
                            error      = $errText
                            durationMs = 0
                        }
                        continue
                    }

                    $key = Get-ContextKey $context
                    $roundContexts[$key] = $context

                    if (-not $targetInfos.Contains($key)) {
                        $probeTimeout = 6000
                        if ($context.Kind -eq 'mac') { $probeTimeout = 4000 }
                        $probe = $null
                        try {
                            $probe = Test-ContextPresence $context $probeTimeout
                        }
                        catch {
                            $probe = [pscustomobject]@{ Online = $false; Host = $context.ActiveHost; Error = $_.Exception.Message }
                        }

                        $targetInfos[$key] = [ordered]@{
                            kind    = $context.Kind
                            id      = $context.DeviceId
                            name    = $context.Name
                            os      = $context.Os
                            online  = [bool]$probe.Online
                            host    = [string]$probe.Host
                            error   = [string]$probe.Error
                            pairs   = @()
                        }

                        if ($context.Kind -eq 'mac') {
                            if ($probe.Online) {
                                if ($macOnline -eq $false) {
                                    Write-SyncLog ("Mac 已上线 ({0})，恢复同步" -f $probe.Host)
                                }
                                $script:ActiveHost = $probe.Host
                                $macOnline = $true
                                $offlineSince = $null
                            }
                            else {
                                if ($macOnline -ne $false) {
                                    Write-SyncLog 'Mac 离线，暂停同步；等待 Mac 上线后自动恢复…'
                                }
                                $macOnline = $false
                                if (-not $offlineSince) { $offlineSince = (Get-Date).ToString('o') }
                            }
                        }
                        else {
                            $previousOnline = $targetOnline[$key]
                            if ($probe.Online) {
                                if ($previousOnline -eq $false) {
                                    Write-SyncLog ("设备 {0} 已上线，恢复其同步" -f $context.Name)
                                }
                                $targetOnline[$key] = $true
                                $targetSince[$key] = $null
                            }
                            else {
                                if ($previousOnline -ne $false) {
                                    Write-SyncLog ("设备 {0} 离线，暂停其同步；等待上线后自动恢复（{1}）" -f $context.Name, $probe.Error)
                                }
                                $targetOnline[$key] = $false
                                if (-not $targetSince[$key]) { $targetSince[$key] = (Get-Date).ToString('o') }
                            }
                        }
                    }

                    $targetInfos[$key].pairs += $pair.name
                    $online = [bool]$targetInfos[$key].online
                    if (-not $online) {
                        $pairResults += [ordered]@{
                            name       = $pair.name
                            deviceId   = $context.DeviceId
                            deviceName = $context.Name
                            online     = $false
                            lastRun    = $(if ($previousEntry) { $previousEntry.lastRun } else { $null })
                            uploaded   = $(if ($previousEntry) { $previousEntry.uploaded } else { 0 })
                            downloaded = $(if ($previousEntry) { $previousEntry.downloaded } else { 0 })
                            deleted    = $(if ($previousEntry) { $previousEntry.deleted } else { 0 })
                            conflicts  = $(if ($previousEntry) { $previousEntry.conflicts } else { 0 })
                            adopted    = $(if ($previousEntry) { $previousEntry.adopted } else { 0 })
                            failed     = 0
                            error      = ("设备离线: " + $targetInfos[$key].error)
                            durationMs = 0
                        }
                        continue
                    }

                    if (-not (Enter-SyncLock 0)) {
                        Write-SyncLog ("{0} | 跳过：另一个同步进程正在运行" -f $pair.name)
                        continue
                    }
                    try {
                        $result = Invoke-PairSyncSafe $config $pair $context
                    }
                    finally {
                        Exit-SyncLock
                    }
                    $pairResults += [ordered]@{
                        name       = $result.Name
                        deviceId   = $result.DeviceId
                        deviceName = $result.DeviceName
                        online     = $true
                        lastRun    = $result.At
                        uploaded   = $result.Uploaded
                        downloaded = $result.Downloaded
                        deleted    = $result.Deleted
                        conflicts  = $result.Conflicts
                        adopted    = $result.Adopted
                        failed     = $result.Failed
                        error      = $result.Error
                        durationMs = $result.DurationMs
                    }
                }
                $lastPairResults = $pairResults

                $deviceStatus = @()
                foreach ($key in @($targetInfos.Keys)) {
                    $info = $targetInfos[$key]
                    if ($info.kind -eq 'mac') { continue }
                    $deviceStatus += [ordered]@{
                        id           = $info.id
                        name         = $info.name
                        os           = $info.os
                        online       = $info.online
                        host         = $info.host
                        offlineSince = $targetSince[$key]
                        pairs        = @($info.pairs)
                    }
                }

                $macTarget = $null
                foreach ($key in @($targetInfos.Keys)) {
                    if ($targetInfos[$key].kind -eq 'mac') { $macTarget = $targetInfos[$key]; break }
                }
                if ($macTarget -and $macTarget.online -and $macTarget.host) {
                    $hostName = $macTarget.host
                }
                elseif ($deviceStatus.Count -gt 0) {
                    $hostName = $deviceStatus[0].host
                }

                Write-SyncStatus ([ordered]@{
                    running         = $true
                    pid             = $PID
                    startedAt       = $startedAt
                    lastCycleAt     = (Get-Date).ToString('o')
                    nextRunAt       = (Get-Date).AddSeconds($interval).ToString('o')
                    host            = $hostName
                    macOnline       = ($macOnline -ne $false)
                    offlineSince    = $offlineSince
                    intervalSeconds = $interval
                    pairs           = $pairResults
                    devices         = $deviceStatus
                })
            }
            catch {
                Write-SyncLog ("守护循环异常: {0}" -f $_.Exception.Message)
                Write-SyncStatus ([ordered]@{
                    running         = $true
                    pid             = $PID
                    startedAt       = $startedAt
                    lastCycleAt     = (Get-Date).ToString('o')
                    nextRunAt       = $null
                    host            = $script:ActiveHost
                    macOnline       = ($macOnline -ne $false)
                    offlineSince    = $offlineSince
                    intervalSeconds = $interval
                    error           = $_.Exception.Message
                    pairs           = $pairResults
                    devices         = $deviceStatus
                })
            }

            $until = (Get-Date).AddSeconds($interval)
            while ((Get-Date) -lt $until -and -not (Test-Path -LiteralPath $script:SyncStopFile)) {
                Start-Sleep -Seconds 1
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $script:SyncPidFile -Force -ErrorAction SilentlyContinue
        Write-SyncLog ("同步守护停止 PID={0}" -f $PID)
        Write-SyncStatus ([ordered]@{
            running   = $false
            pid       = $null
            startedAt = $startedAt
            stoppedAt = (Get-Date).ToString('o')
            pairs     = @()
        })
        $script:SyncRunning = $false
    }
    return 0
}

function Start-SyncService {
    $existing = Get-SyncWatcherPid
    if ($existing) {
        Write-Host ("同步守护已在运行 (PID {0})" -f $existing)
        return 0
    }
    $vbs = Join-Path $script:AppDir 'sync-service.vbs'
    if (-not (Test-Path -LiteralPath $vbs)) { throw "缺少启动脚本: $vbs" }
    Remove-Item -LiteralPath $script:SyncStopFile -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Get-SyncWatcherPid) { break }
    }
    $watcherPid = Get-SyncWatcherPid
    if (-not $watcherPid) { throw '同步守护启动失败，请查看 sync.log' }
    Write-Host ("同步守护已启动 (PID {0})" -f $watcherPid)
    return 0
}

function Stop-SyncService {
    $watcherPid = Get-SyncWatcherPid
    if (-not $watcherPid) {
        Remove-Item -LiteralPath $script:SyncStopFile -Force -ErrorAction SilentlyContinue
        Write-Host '同步守护未在运行。'
        return 0
    }
    Set-Content -LiteralPath $script:SyncStopFile -Value 'stop' -Encoding ASCII
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Id $watcherPid -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-Process -Id $watcherPid -ErrorAction SilentlyContinue) {
        Stop-Process -Id $watcherPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    Remove-Item -LiteralPath $script:SyncStopFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:SyncPidFile -Force -ErrorAction SilentlyContinue
    Write-Host ("同步守护已停止 (PID {0})" -f $watcherPid)
    return 0
}

function Get-SyncStartupShortcutPath {
    return (Join-Path ([Environment]::GetFolderPath('Startup')) 'smac-sync.lnk')
}

function Install-SyncStartup {
    $vbs = Join-Path $script:AppDir 'sync-service.vbs'
    if (-not (Test-Path -LiteralPath $vbs)) { throw "缺少启动脚本: $vbs" }
    $shortcutPath = Get-SyncStartupShortcutPath
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + $vbs + '"'
    $shortcut.WorkingDirectory = $script:AppDir
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Win-Mac 文件夹自动同步'
    $shortcut.Save()
    Write-Host ("已设置开机自启: {0}" -f $shortcutPath)
    return 0
}

function Uninstall-SyncStartup {
    $shortcutPath = Get-SyncStartupShortcutPath
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
        Write-Host '已取消开机自启。'
    }
    else {
        Write-Host '未找到开机自启项。'
    }
    return 0
}

function Read-SyncStatusFile {
    if (-not (Test-Path -LiteralPath $script:SyncStatusPath)) { return $null }
    try {
        return (Get-Content -LiteralPath $script:SyncStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch { return $null }
}

# ---------------- 命令 ----------------

function Show-SyncHelp {
    Write-Host @'
smac sync - 文件夹双向同步

命令:
  smac.ps1 sync add <本机文件夹> <远端路径> [名称] [--device <设备>]
                                                          添加同步文件夹对（默认 Mac）
  smac.ps1 sync remove <名称>                             移除文件夹对（不删除文件）
  smac.ps1 sync enable|disable <名称>                     启用 / 暂停某个文件夹对
  smac.ps1 sync list                                      查看文件夹对
  smac.ps1 sync now [名称]                                立即同步一次
  smac.ps1 sync status                                    查看守护与最近同步状态
  smac.ps1 sync start                                     启动后台守护
  smac.ps1 sync stop                                      停止后台守护
  smac.ps1 sync install                                   设置开机自启并启动
  smac.ps1 sync uninstall                                 取消开机自启（不停止当前守护）

规则:
  - --device 省略或为 mac 时同步到 Mac；其他值对应网页控制台添加的远程设备；
  - 其他设备需在设备配置中保存密码，后台守护才能自动连接；
  - 只传输变化的文件，每次传输做 SHA256 校验；
  - 两端同时修改同一文件时保留两份，远端版命名为 *.conflict-<设备名>-时间；
  - 删除会同步，被删除的文件进入回收站：
      本机: %USERPROFILE%\.smac\trash
      Mac:  ~/.smac-trash
      其他 Windows 设备: 用户目录\.smac-trash
      其他 Linux/macOS 设备: ~/.smac-trash
  - 日志: %USERPROFILE%\.smac\sync.log
'@
    return 0
}

function Invoke-SyncCommand($Config, [string[]]$SyncArgs) {
    $sub = 'status'
    if ($SyncArgs.Count -gt 0) { $sub = $SyncArgs[0].ToLowerInvariant() }

    switch ($sub) {
        'add' {
            $parsed = Split-SmacDeviceArgument $SyncArgs
            $SyncArgs = @($parsed.Args)
            $deviceId = [string]$parsed.DeviceId
            $deviceName = 'Mac'
            if ($deviceId) {
                $device = $null
                if (Get-Command Find-SmacDevice -ErrorAction SilentlyContinue) {
                    $device = Find-SmacDevice $deviceId
                }
                if (-not $device) { throw "找不到远程设备: $deviceId（先在网页控制台添加设备）" }
                $deviceId = [string]$device.id
                $deviceName = [string]$device.name
            }
            if ($SyncArgs.Count -lt 3) { throw '用法: smac.ps1 sync add <本机文件夹> <远端路径> [名称] [--device <设备>]' }
            $localPath = [IO.Path]::GetFullPath($SyncArgs[1])
            if (-not (Test-Path -LiteralPath $localPath -PathType Container)) {
                throw "本机文件夹不存在: $localPath"
            }
            $remotePath = [string]$SyncArgs[2]
            if ([string]::IsNullOrWhiteSpace($remotePath)) { throw '远端路径不能为空' }
            $name = ''
            if ($SyncArgs.Count -ge 4) { $name = [string]$SyncArgs[3] }
            if ([string]::IsNullOrWhiteSpace($name)) { $name = New-SyncPairName $Config $localPath }
            $name = ConvertTo-SyncSafeName $name
            if (Get-SyncPair $Config $name) { throw "同步名称已存在: $name" }

            $pair = [pscustomobject]@{
                name             = $name
                local            = $localPath
                remote           = $remotePath
                deviceId         = $deviceId
                enabled          = $true
                propagateDeletes = $true
            }
            Save-SyncPairs $Config (@(Get-SyncPairs $Config) + $pair)
            Write-Good ("已添加同步对: {0}" -f $name)
            Write-Host ("  本机    : {0}" -f $localPath)
            Write-Host ("  {0,-8}: {1}" -f $deviceName, $remotePath)
            $watcherPid = Get-SyncWatcherPid
            if ($watcherPid) {
                Write-Note ("后台守护运行中，将在下一轮自动开始同步（PID {0}）" -f $watcherPid)
            }
            else {
                Write-Note '后台守护未运行，可执行: smac.ps1 sync install'
            }
            return 0
        }
        'remove' {
            if ($SyncArgs.Count -lt 2) { throw '用法: smac.ps1 sync remove <名称>' }
            $name = [string]$SyncArgs[1]
            $pair = Get-SyncPair $Config $name
            if (-not $pair) { throw "找不到同步对: $name" }
            $remaining = @(Get-SyncPairs $Config | Where-Object { $_.name -ne $name })
            Save-SyncPairs $Config $remaining
            Remove-Item -LiteralPath (Get-SyncStatePath $name) -Force -ErrorAction SilentlyContinue
            Write-Good ("已移除同步对: {0}（不会删除任何文件）" -f $name)
            return 0
        }
        'list' {
            $pairs = Get-SyncPairs $Config
            if ($pairs.Count -eq 0) {
                Write-Host '还没有同步文件夹。添加: smac.ps1 sync add <Windows 文件夹> <Mac 路径>'
                return 0
            }
            Write-Host ("{0,-16} {1,-6} {2,-16} {3,-40} {4}" -f '名称', '启用', '设备', '本机文件夹', '远端路径')
            foreach ($pair in $pairs) {
                $enabledText = '是'
                if ($pair.PSObject.Properties['enabled'] -and $pair.enabled -eq $false) { $enabledText = '否' }
                $pairDeviceName = 'Mac'
                $pairDeviceId = ''
                if ($pair.PSObject.Properties['deviceId']) { $pairDeviceId = [string]$pair.deviceId }
                if ($pairDeviceId) {
                    $pairDeviceName = '(设备已删除)'
                    if (Get-Command Find-SmacDevice -ErrorAction SilentlyContinue) {
                        $pairDevice = Find-SmacDevice $pairDeviceId
                        if ($pairDevice) { $pairDeviceName = [string]$pairDevice.name }
                    }
                }
                Write-Host ("{0,-16} {1,-6} {2,-16} {3,-40} {4}" -f $pair.name, $enabledText, $pairDeviceName, $pair.local, $pair.remote)
            }
            return 0
        }
        'now' {
            $pairs = Get-SyncPairs $Config
            if ($pairs.Count -eq 0) { throw '还没有同步文件夹，先执行 sync add' }
            if ($SyncArgs.Count -ge 2) {
                $pair = Get-SyncPair $Config $SyncArgs[1]
                if (-not $pair) { throw "找不到同步对: $($SyncArgs[1])" }
                $pairs = @($pair)
            }
            if (-not (Enter-SyncLock 60000)) { throw '另一个同步进程正在运行，请稍后再试' }
            try {
                $failCount = 0
                foreach ($pair in $pairs) {
                    if ($pair.PSObject.Properties['enabled'] -and $pair.enabled -eq $false) {
                        Write-Note ("跳过已禁用: {0}" -f $pair.name)
                        continue
                    }
                    $pairDeviceName = 'Mac'
                    if ($pair.PSObject.Properties['deviceId'] -and $pair.deviceId) {
                        $pairDeviceName = [string]$pair.deviceId
                        if (Get-Command Find-SmacDevice -ErrorAction SilentlyContinue) {
                            $pairDevice = Find-SmacDevice ([string]$pair.deviceId)
                            if ($pairDevice) { $pairDeviceName = [string]$pairDevice.name }
                        }
                    }
                    Write-Step ("同步 {0} [{1}]: {2} -> {3}" -f $pair.name, $pairDeviceName, $pair.local, $pair.remote)
                    $result = Invoke-PairSyncSafe $Config $pair
                    $line = "上传 {0} / 下载 {1} / 删除 {2} / 冲突 {3} / 失败 {4} ({5} ms)" -f $result.Uploaded, $result.Downloaded, $result.Deleted, $result.Conflicts, $result.Failed, $result.DurationMs
                    if ($result.Failed -gt 0) {
                        Write-Warn2 ($line + ' ' + $result.Error)
                        $failCount++
                    }
                    else {
                        Write-Good $line
                    }
                }
                if ($failCount -gt 0) { return 1 }
                return 0
            }
            finally {
                Exit-SyncLock
            }
        }
        'status' {
            $watcherPid = Get-SyncWatcherPid
            $status = Read-SyncStatusFile
            Write-Step '同步状态'
            if ($watcherPid) { Write-Good ("后台守护运行中 (PID {0})" -f $watcherPid) }
            else { Write-Warn2 '后台守护未运行' }
            if ($status) {
                Write-Host ("  最近一轮: {0}" -f $status.lastCycleAt)
                Write-Host ("  连接地址: {0}" -f $status.host)
                if ($status.PSObject.Properties['macOnline'] -and $status.macOnline -eq $false) {
                    Write-Warn2 ("  Mac 状态 : 离线，暂停同步，等待上线后自动恢复（自 {0}）" -f $status.offlineSince)
                }
                if ($status.PSObject.Properties['devices']) {
                    foreach ($deviceEntry in @($status.devices)) {
                        if (-not $deviceEntry) { continue }
                        if ($deviceEntry.online) {
                            Write-Host ("  设备 {0} ({1}): 在线 {2}" -f $deviceEntry.name, $deviceEntry.os, $deviceEntry.host)
                        }
                        else {
                            Write-Warn2 ("  设备 {0} ({1}): 离线，暂停其同步（自 {2}）" -f $deviceEntry.name, $deviceEntry.os, $deviceEntry.offlineSince)
                        }
                    }
                }
                foreach ($entry in @($status.pairs)) {
                    if (-not $entry) { continue }
                    $entryDevice = ''
                    if ($entry.PSObject.Properties['deviceName'] -and $entry.deviceName) { $entryDevice = " [$($entry.deviceName)]" }
                    Write-Host ("  - {0}{1}: 上传 {2} 下载 {3} 删除 {4} 冲突 {5} 失败 {6}  {7}" -f $entry.name, $entryDevice, $entry.uploaded, $entry.downloaded, $entry.deleted, $entry.conflicts, $entry.failed, $entry.lastRun)
                    if ($entry.error) { Write-Host ("      错误: {0}" -f $entry.error) -ForegroundColor Red }
                }
            }
            Write-Host ''
            Write-Host ("  同步对: {0}" -f @(Get-SyncPairs $Config).Count)
            Write-Host ("  间隔  : {0} 秒" -f (Get-SyncInterval $Config))
            Write-Host ("  日志  : {0}" -f $script:SyncLogPath)
            return 0
        }
        'enable' {
            if ($SyncArgs.Count -lt 2) { throw '用法: smac.ps1 sync enable <名称>' }
            $name = [string]$SyncArgs[1]
            $pairs = @(Get-SyncPairs $Config)
            $found = $false
            foreach ($pair in $pairs) {
                if ($pair.name -eq $name) {
                    $pair | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
                    $found = $true
                }
            }
            if (-not $found) { throw "找不到同步对: $name" }
            Save-SyncPairs $Config $pairs
            Write-Good ("已启用: {0}" -f $name)
            return 0
        }
        'disable' {
            if ($SyncArgs.Count -lt 2) { throw '用法: smac.ps1 sync disable <名称>' }
            $name = [string]$SyncArgs[1]
            $pairs = @(Get-SyncPairs $Config)
            $found = $false
            foreach ($pair in $pairs) {
                if ($pair.name -eq $name) {
                    $pair | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
                    $found = $true
                }
            }
            if (-not $found) { throw "找不到同步对: $name" }
            Save-SyncPairs $Config $pairs
            Write-Good ("已暂停: {0}" -f $name)
            return 0
        }
        'start' { return Start-SyncService }
        'stop' { return Stop-SyncService }
        'install' {
            Install-SyncStartup | Out-Null
            return Start-SyncService
        }
        'uninstall' {
            return Uninstall-SyncStartup
        }
        'watch' { return Start-SyncWatcher }
        default {
            return Show-SyncHelp
        }
    }
}
