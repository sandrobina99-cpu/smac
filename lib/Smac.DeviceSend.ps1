# Smac.DeviceSend.ps1 - 发送文件到非 Mac SSH 设备的桌面
# 由 smac.ps1 点源加载。

function Get-DeviceSendDir($Context) {
    $value = '~/Desktop'
    if ($Context.Device) {
        try {
            if ($Context.Device.PSObject.Properties['sendDir'] -and -not [string]::IsNullOrWhiteSpace([string]$Context.Device.sendDir)) {
                $value = [string]$Context.Device.sendDir
            }
        }
        catch { }
    }
    return (Resolve-ContextPath $Context $value)
}

function Send-DeviceOneFile($Context, [System.IO.FileInfo]$File, [string]$SendDir) {
    $target = ($SendDir.TrimEnd('/') + '/' + $File.Name)
    $started = Get-Date
    try {
        $type = Test-ContextPathType $Context $target
        if ($type -eq 'dir') { throw "远端存在同名文件夹，无法用文件覆盖: $target" }
        $hash = Get-LocalSha256 $File.FullName
        Push-ContextFile $Context $File.FullName $target $hash | Out-Null
        $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
        Write-Good ("已发送到 {0}: {1} ({2}, {3}s)  SHA256 {4}..." -f $Context.Name, $File.Name, (Format-Size $File.Length), $seconds, $hash.Substring(0, 8))
        Write-Log ("OK | device-file | {0} | {1} | {2} bytes | {3}s | {4}" -f $Context.Name, $File.FullName, $File.Length, $seconds, $target)
        return $true
    }
    catch {
        $reason = $_.Exception.Message
        Write-Bad ("发送失败 {0}: {1}" -f $File.Name, $reason)
        Write-Log ("FAIL | device-file | {0} | {1} | {2}" -f $Context.Name, $File.FullName, $reason)
        return $false
    }
}

function Send-DeviceOneDirectory($Context, [System.IO.DirectoryInfo]$Directory, [string]$SendDir) {
    $target = ($SendDir.TrimEnd('/') + '/' + $Directory.Name)
    $started = Get-Date
    try {
        $type = Test-ContextPathType $Context $target
        if ($type -eq 'file') { throw "远端存在同名文件，无法用文件夹覆盖: $target" }
        Ensure-ContextDirectory $Context $target

        $files = @(Get-ChildItem -LiteralPath $Directory.FullName -Recurse -File -Force)
        $subDirs = @(Get-ChildItem -LiteralPath $Directory.FullName -Recurse -Directory -Force)
        $totalBytes = 0L
        foreach ($sub in $subDirs) {
            $rel = $sub.FullName.Substring($Directory.FullName.TrimEnd('\', '/').Length).TrimStart('\', '/').Replace('\', '/')
            if ($rel) { Ensure-ContextDirectory $Context ($target + '/' + $rel) }
        }

        Write-Note '正在逐文件上传并校验（文件较多时会稍慢）...'
        $okFiles = 0
        $failedFiles = 0
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($Directory.FullName.TrimEnd('\', '/').Length).TrimStart('\', '/').Replace('\', '/')
            $remoteFile = $target + '/' + $relative
            try {
                $hash = Get-LocalSha256 $file.FullName
                Push-ContextFile $Context $file.FullName $remoteFile $hash | Out-Null
                $totalBytes += $file.Length
                $okFiles++
            }
            catch {
                $failedFiles++
                Write-Bad ("发送失败 {0}: {1}" -f $relative, $_.Exception.Message)
                Write-Log ("FAIL | device-dir-file | {0} | {1} | {2}" -f $Context.Name, $file.FullName, $_.Exception.Message)
            }
        }

        $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
        if ($failedFiles -gt 0) {
            Write-Warn2 ("文件夹 {0} 部分完成：{1} 个成功，{2} 个失败，{3}s" -f $Directory.Name, $okFiles, $failedFiles, $seconds)
            Write-Log ("PART | device-dir | {0} | {1} | files={2} failed={3} | {4}s | {5}" -f $Context.Name, $Directory.FullName, $okFiles, $failedFiles, $seconds, $target)
            return $false
        }
        Write-Good ("已发送文件夹到 {0}: {1} ({2} 个文件, {3}, {4}s) -> {5}" -f $Context.Name, $Directory.Name, $okFiles, (Format-Size $totalBytes), $seconds, $target)
        Write-Log ("OK | device-dir | {0} | {1} | files={2} bytes={3} | {4}s | {5}" -f $Context.Name, $Directory.FullName, $okFiles, $totalBytes, $seconds, $target)
        return $true
    }
    catch {
        $reason = $_.Exception.Message
        Write-Bad ("发送失败 {0}: {1}" -f $Directory.Name, $reason)
        Write-Log ("FAIL | device-dir | {0} | {1} | {2}" -f $Context.Name, $Directory.FullName, $reason)
        return $false
    }
}

function Send-ItemsToDevice($Config, [string[]]$Paths, [string]$DeviceId) {
    if (-not $Paths -or $Paths.Count -eq 0) {
        Write-Bad '没有指定要发送的文件或文件夹。'
        return 1
    }
    $context = New-RemoteContext $Config $DeviceId
    Write-Step ("目标设备: {0}" -f $context.Name)
    $presence = Test-ContextPresence $context 20000
    if (-not $presence.Online) {
        throw ("设备 {0} 不可达: {1}" -f $context.Name, $presence.Error)
    }
    $sendDir = Get-DeviceSendDir $context
    Ensure-ContextDirectory $context $sendDir
    Write-Step ("目标: {0} ({1}) -> {2}" -f $context.Name, $context.Device.user, $sendDir)

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
            if (Send-DeviceOneDirectory $context $item $sendDir) { $okCount++ } else { $failCount++ }
        }
        else {
            if (Send-DeviceOneFile $context $item $sendDir) { $okCount++ } else { $failCount++ }
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

function Show-ContextRemoteList($Config, [string]$DeviceId) {
    $context = New-RemoteContext $Config $DeviceId
    $presence = Test-ContextPresence $context 15000
    if (-not $presence.Online) { throw ("设备 {0} 不可达: {1}" -f $context.Name, $presence.Error) }
    $sendDir = Get-DeviceSendDir $context
    Ensure-ContextDirectory $context $sendDir
    Write-Step ("{0} 接收目录: {1}" -f $context.Name, $sendDir)
    if ($context.Os -eq 'windows') {
        $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes($sendDir))
        $script = New-WindowsScript @"
`$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64'))
`$items = @(Get-ChildItem -LiteralPath `$p -Force | Sort-Object Name)
if (`$items.Count -eq 0) { '(空)' }
else { `$items | Format-Table Name, Length, LastWriteTime -AutoSize | Out-String -Width 220 }
"@
        Write-Host (Invoke-ContextRemote $context $script 60)
    }
    else {
        Write-Host (Invoke-ContextRemote $context ("ls -la " + (Quote-Remote $sendDir)) 60)
    }
    return 0
}
