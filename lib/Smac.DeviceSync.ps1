# Smac.DeviceSync.ps1 - 非 Mac SSH 设备上的同步远端操作
# 由 smac.ps1 点源加载；依赖 Smac.Device.ps1 与 Smac.Sync.ps1 中的函数。

function Resolve-ContextRemoteRoot($Context, [string]$Value) {
    if ($Context.Kind -eq 'mac') { return (Resolve-SyncRemoteRoot $Context.Config $Value) }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { throw '远端路径不能为空' }
    return (Resolve-ContextPath $Context $text)
}

function Assert-ContextPairRoots($Context, [string]$LocalRoot, [string]$RemoteRoot) {
    $localFull = [IO.Path]::GetFullPath($LocalRoot).TrimEnd('\', '/')
    $localHome = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\', '/')
    $drive = [IO.Path]::GetPathRoot($localFull).TrimEnd('\', '/')
    if ($localFull -eq $drive) { throw "不能同步整个盘符: $localFull" }
    if ($localFull -eq $localHome) { throw "不能同步整个用户目录: $localFull" }
    if ($localHome.StartsWith($localFull + '\')) { throw "Windows 目录范围过大: $localFull" }

    if ([string]::IsNullOrWhiteSpace($RemoteRoot)) { throw '远端目录不能为空' }
    $remoteHome = Get-ContextHome $Context
    if ($Context.Os -eq 'windows') {
        $trim = $RemoteRoot.Replace('\', '/').TrimEnd('/')
        if ($trim -match '^[A-Za-z]:$') { throw "不能同步整个盘符: $RemoteRoot" }
        if ($trim -ieq $remoteHome) { throw "不能同步整个用户目录: $RemoteRoot" }
        if ($remoteHome.ToLowerInvariant().StartsWith($trim.ToLowerInvariant() + '/')) {
            throw "远端目录范围过大: $RemoteRoot"
        }
        return
    }

    $trim = $RemoteRoot.TrimEnd('/')
    if ($trim -eq '' -or $trim -eq '/') { throw "不能同步远端根目录: $RemoteRoot" }
    if ($trim -eq $remoteHome) { throw "不能同步整个用户目录: $RemoteRoot" }
    if ($remoteHome.StartsWith($trim + '/')) { throw "远端目录范围过大: $RemoteRoot" }
}

function Get-ContextFileIndex($Context, [string]$RemoteRoot) {
    if ($Context.Kind -eq 'mac') { return (Get-RemoteFileIndex $Context.Config $RemoteRoot) }

    if ($Context.Os -eq 'windows') {
        $payload = @{ root = $RemoteRoot; excludes = @($script:SyncDefaultExcludes) }
        $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes(($payload | ConvertTo-Json -Depth 5 -Compress)))
        $script = New-WindowsScript @"
`$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')) | ConvertFrom-Json
`$root = [IO.Path]::GetFullPath([string]`$j.root).TrimEnd('\','/')
`$items = New-Object System.Collections.Generic.List[object]
foreach (`$f in (Get-ChildItem -LiteralPath `$root -Recurse -File -Force -ErrorAction Stop)) {
    if ((`$f.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    `$skip = `$false
    foreach (`$pattern in @(`$j.excludes)) {
        if (`$f.Name -like [string]`$pattern) { `$skip = `$true; break }
    }
    if (`$skip) { continue }
    `$rel = `$f.FullName.Substring(`$root.Length).TrimStart('\','/').Replace('\','/')
    `$items.Add([pscustomobject]@{
        p = `$rel
        m = [long]([DateTimeOffset]::new(`$f.LastWriteTimeUtc).ToUnixTimeSeconds())
        s = [long]`$f.Length
    })
}
`$json = @{ files = `$items.ToArray() } | ConvertTo-Json -Depth 4 -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(`$json))
"@
        $text = Invoke-ContextRemote $Context $script 300
        $b64Out = ($text -replace '\s', '')
        $map = @{}
        if ([string]::IsNullOrEmpty($b64Out)) { return $map }
        $decoded = $script:Utf8.GetString([Convert]::FromBase64String($b64Out))
        $obj = $decoded | ConvertFrom-Json
        foreach ($item in @($obj.files)) {
            if (-not $item -or [string]::IsNullOrWhiteSpace([string]$item.p)) { continue }
            $map[[string]$item.p] = [pscustomobject]@{
                Mtime = [long]$item.m
                Size  = [long]$item.s
            }
        }
        return $map
    }

    $q = Quote-Remote $RemoteRoot
    $exclude = ''
    foreach ($pattern in $script:SyncDefaultExcludes) {
        $exclude += ' ! -name ' + (Quote-Remote $pattern)
    }
    if ($Context.Os -eq 'linux') {
        $stat = "stat -c '%Y|%s|%n'"
    }
    else {
        $stat = "stat -f '%m|%z|%N'"
    }
    $cmd = "cd $q || exit 9`nfind . -type f$exclude -exec $stat {} + | base64"
    $text = Invoke-ContextRemote $Context $cmd 300
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

function Get-ContextHashes($Context, [string]$RemoteRoot, [string[]]$RelativePaths) {
    if ($Context.Kind -eq 'mac') { return (Get-RemoteHashes $Context.Config $RemoteRoot $RelativePaths) }
    $result = @{}
    if (-not $RelativePaths -or $RelativePaths.Count -eq 0) { return $result }

    if ($Context.Os -eq 'windows') {
        $batchSize = 100
        for ($i = 0; $i -lt $RelativePaths.Count; $i += $batchSize) {
            $end = [Math]::Min($i + $batchSize - 1, $RelativePaths.Count - 1)
            $batch = @($RelativePaths[$i..$end])
            $payload = @{ root = $RemoteRoot; paths = $batch }
            $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes(($payload | ConvertTo-Json -Depth 5 -Compress)))
            $script = New-WindowsScript @"
`$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')) | ConvertFrom-Json
`$root = [IO.Path]::GetFullPath([string]`$j.root).TrimEnd('\','/')
`$out = [ordered]@{}
foreach (`$p in @(`$j.paths)) {
    `$full = Join-Path `$root ([string]`$p).Replace('/','\')
    try {
        `$h = (Get-FileHash -LiteralPath `$full -Algorithm SHA256 -ErrorAction Stop).Hash
        `$out[[string]`$p] = `$h.ToLowerInvariant()
    }
    catch { }
}
`$json = @{ hashes = `$out } | ConvertTo-Json -Depth 4 -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(`$json))
"@
            $text = Invoke-ContextRemote $Context $script 300
            $b64Out = ($text -replace '\s', '')
            if ([string]::IsNullOrEmpty($b64Out)) { continue }
            $decoded = $script:Utf8.GetString([Convert]::FromBase64String($b64Out))
            $obj = $decoded | ConvertFrom-Json
            foreach ($prop in $obj.hashes.PSObject.Properties) {
                if ($prop.Value) { $result[$prop.Name] = ([string]$prop.Value).ToLower() }
            }
        }
        return $result
    }

    $batchSize = 100
    for ($i = 0; $i -lt $RelativePaths.Count; $i += $batchSize) {
        $end = [Math]::Min($i + $batchSize - 1, $RelativePaths.Count - 1)
        $batch = $RelativePaths[$i..$end]
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add("cd " + (Quote-Remote $RemoteRoot) + " || exit 9")
        $lines.Add('{')
        foreach ($relative in $batch) {
            $lines.Add("if command -v shasum >/dev/null 2>&1; then shasum -a 256 " + (Quote-Remote ('./' + $relative)) + " 2>/dev/null; else sha256sum " + (Quote-Remote ('./' + $relative)) + " 2>/dev/null; fi")
        }
        $lines.Add('} | base64')
        $text = Invoke-ContextRemote $Context ($lines -join "`n") 300
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

function Ensure-ContextParents($Context, [string]$RemoteRoot, [System.Collections.Generic.HashSet[string]]$RelativePaths) {
    if ($Context.Kind -eq 'mac') {
        Ensure-RemoteParents $Context.Config $RemoteRoot $RelativePaths
        return
    }
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
        $batch = @($items[$i..$end])
        if ($Context.Os -eq 'windows') {
            $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes((@{ dirs = $batch } | ConvertTo-Json -Depth 4 -Compress)))
            $script = New-WindowsScript @"
`$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')) | ConvertFrom-Json
foreach (`$d in @(`$j.dirs)) { New-Item -ItemType Directory -Force -Path ([string]`$d) | Out-Null }
"@
            Invoke-ContextRemote $Context $script 120 | Out-Null
        }
        else {
            $quoted = ($batch | ForEach-Object { Quote-Remote $_ }) -join ' '
            Invoke-ContextRemote $Context ("mkdir -p $quoted") 120 | Out-Null
        }
    }
}

function Remove-ContextFile($Context, [string]$RemotePath) {
    try {
        if ($Context.Kind -eq 'mac' -or $Context.Os -ne 'windows') {
            Invoke-ContextRemote $Context ("rm -f " + (Quote-Remote $RemotePath)) 30 | Out-Null
        }
        else {
            $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes($RemotePath))
            $script = New-WindowsScript @"
`$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64'))
Remove-Item -LiteralPath `$p -Force -ErrorAction SilentlyContinue
"@
            Invoke-ContextRemote $Context $script 30 | Out-Null
        }
    }
    catch { }
}

function Push-ContextFile($Context, [string]$LocalFull, [string]$RemoteFull, [string]$ExpectedHash) {
    if ($Context.Kind -eq 'mac') { return (Push-SyncFile $Context.Config $LocalFull $RemoteFull $ExpectedHash) }

    $tempPath = $RemoteFull + '.smac-tmp-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $upload = Invoke-SshBridge @{
        op       = 'upload'
        deviceId = $Context.DeviceId
        local    = $LocalFull
        remote   = $tempPath
    } 7200
    if (-not $upload.ok) {
        throw ("上传失败: " + [string]$upload.error)
    }

    try {
        if ($Context.Os -eq 'windows') {
            $payload = @{ tmp = $tempPath; target = $RemoteFull; hash = $ExpectedHash }
            $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes(($payload | ConvertTo-Json -Depth 4 -Compress)))
            $script = New-WindowsScript @"
`$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')) | ConvertFrom-Json
`$tmp = [string]`$j.tmp
`$target = [string]`$j.target
if (Test-Path -LiteralPath `$target -PathType Container) {
    Remove-Item -LiteralPath `$tmp -Force -ErrorAction SilentlyContinue
    throw '远端存在同名文件夹，无法用文件覆盖'
}
`$h = (Get-FileHash -LiteralPath `$tmp -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
if (`$h -ne [string]`$j.hash) {
    Remove-Item -LiteralPath `$tmp -Force -ErrorAction SilentlyContinue
    throw ('远端校验失败: 期望 ' + `$j.hash + ' 实际 ' + `$h)
}
`$parent = Split-Path -Parent `$target
if (`$parent -and -not (Test-Path -LiteralPath `$parent)) { New-Item -ItemType Directory -Force -Path `$parent | Out-Null }
Remove-Item -LiteralPath `$target -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath `$tmp -Destination `$target -Force
`$f = Get-Item -LiteralPath `$target
@{ m = [long]([DateTimeOffset]::new(`$f.LastWriteTimeUtc).ToUnixTimeSeconds()); s = [long]`$f.Length } | ConvertTo-Json -Compress
"@
            $out = Invoke-ContextRemote $Context $script 120
            $info = $out | ConvertFrom-Json
            return [pscustomobject]@{ Hash = $ExpectedHash; Mtime = [long]$info.m; Size = [long]$info.s }
        }

        $qTemp = Quote-Remote $tempPath
        $qTarget = Quote-Remote $RemoteFull
        $template = @'
if [ -d {{TARGET}} ]; then echo SMAC_DIR_CONFLICT; rm -f {{TMP}}; exit 3; fi
if command -v shasum >/dev/null 2>&1; then h=$(shasum -a 256 {{TMP}} | cut -c1-64); else h=$(sha256sum {{TMP}} | cut -c1-64); fi
if [ "$h" != "{{HASH}}" ]; then echo "SMAC_HASH $h"; rm -f {{TMP}}; exit 4; fi
mv -f {{TMP}} {{TARGET}}
if stat -c '%Y' / >/dev/null 2>&1; then st=$(stat -c '%Y|%s' {{TARGET}}); else st=$(stat -f '%m|%z' {{TARGET}}); fi
echo "SMAC_OK $st"
'@
        $verify = $template.Replace('{{TARGET}}', $qTarget).Replace('{{TMP}}', $qTemp).Replace('{{HASH}}', $ExpectedHash)
        $out = Invoke-ContextRemote $Context $verify 120
        if ($out -notmatch 'SMAC_OK (\d+)\|(\d+)') { throw "远端写入失败: $out" }
        return [pscustomobject]@{ Hash = $ExpectedHash; Mtime = [long]$Matches[1]; Size = [long]$Matches[2] }
    }
    catch {
        Remove-ContextFile $Context $tempPath
        throw
    }
}

function Pull-ContextFile($Context, [string]$RemoteFull, [string]$LocalFull, [string]$ExpectedHash) {
    if ($Context.Kind -eq 'mac') { return (Pull-SyncFile $Context.Config $RemoteFull $LocalFull $ExpectedHash) }

    $localDir = Split-Path -Parent $LocalFull
    if (-not (Test-Path -LiteralPath $localDir)) {
        New-Item -ItemType Directory -Path $localDir -Force | Out-Null
    }
    $tmpPath = Join-Path $localDir ('.smac-tmp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        $download = Invoke-SshBridge @{
            op       = 'download'
            deviceId = $Context.DeviceId
            remote   = $RemoteFull
            local    = $tmpPath
        } 7200
        if (-not $download.ok) { throw ("下载失败: " + [string]$download.error) }
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

function Move-ContextFilesToTrash($Context, [string]$PairName, [string]$RemoteRoot, [string[]]$RelativePaths) {
    if (-not $RelativePaths -or $RelativePaths.Count -eq 0) { return }
    if ($Context.Kind -eq 'mac') {
        Move-RemoteFilesToTrash $Context.Config $PairName $RemoteRoot $RelativePaths
        return
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $safePair = ConvertTo-SyncSafeName $PairName
    if ($Context.Os -eq 'windows') {
        $payload = @{ root = $RemoteRoot; pair = $safePair; stamp = $stamp; paths = @($RelativePaths) }
        $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes(($payload | ConvertTo-Json -Depth 5 -Compress)))
        $script = New-WindowsScript @"
`$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')) | ConvertFrom-Json
`$root = [string]`$j.root
`$trash = Join-Path ([Environment]::GetFolderPath('UserProfile')) (Join-Path '.smac-trash' (Join-Path ([string]`$j.pair) ([string]`$j.stamp)))
`$failed = 0
foreach (`$rel in @(`$j.paths)) {
    `$relText = [string]`$rel
    `$src = Join-Path `$root (`$relText.Replace('/','\'))
    if (-not (Test-Path -LiteralPath `$src)) { continue }
    `$dst = Join-Path `$trash (`$relText.Replace('/','\'))
    `$parent = Split-Path -Parent `$dst
    try {
        if (`$parent -and -not (Test-Path -LiteralPath `$parent)) { New-Item -ItemType Directory -Force -Path `$parent | Out-Null }
        Move-Item -LiteralPath `$src -Destination `$dst -Force
    }
    catch {
        `$failed++
        Write-Output ('SMAC_DELFAIL ' + `$relText)
    }
}
if (`$failed -gt 0) { throw '部分远端文件删除失败' }
Write-Output 'SMAC_DELETE_DONE'
"@
        $out = Invoke-ContextRemote $Context $script 300
        if ($out -notmatch 'SMAC_DELETE_DONE') { throw "远端删除未完成: $out" }
        return
    }

    $remoteHomePath = Get-ContextHome $Context
    $trashRoot = $remoteHomePath + '/.smac-trash/' + $safePair + '/' + $stamp
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
    $out = Invoke-ContextRemote $Context ($lines -join "`n") 300
    if ($out -notmatch 'SMAC_DELETE_DONE') { throw "远端删除未完成: $out" }
    if ($out -match 'SMAC_DELFAIL') { throw "部分远端文件删除失败: $out" }
}

function Get-ContextConflictRel([string]$RelativePath, [string]$Stamp, [int]$Counter, [string]$Label) {
    $safe = ConvertTo-SyncSafeName $Label
    if ([string]::IsNullOrWhiteSpace($safe)) { $safe = 'device' }
    $dir = ''
    $leaf = $RelativePath
    $idx = $RelativePath.LastIndexOf('/')
    if ($idx -ge 0) {
        $dir = $RelativePath.Substring(0, $idx + 1)
        $leaf = $RelativePath.Substring($idx + 1)
    }
    $extension = [IO.Path]::GetExtension($leaf)
    $base = [IO.Path]::GetFileNameWithoutExtension($leaf)
    $suffix = '.conflict-' + $safe + '-' + $Stamp
    if ($Counter -gt 0) { $suffix += '-' + $Counter }
    return ($dir + $base + $suffix + $extension)
}
