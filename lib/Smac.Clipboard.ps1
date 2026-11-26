# Smac.Clipboard.ps1 - Win<->Mac 剪贴板（文本 / 图片）双向同步，由 smac.ps1 点源加载
# 依赖 smac.ps1 中的核心函数：Invoke-Remote / Quote-Remote / Get-ScpArgs / Remote-TargetString /
# Invoke-NativeCapture / Get-RemoteHome / Format-Size 等
#
# 同步对象：纯文本（含中文、多行）与图片。
#   - 剪贴板里同时有文本和图片时（如 Excel 单元格、网页文字），按文本同步，保持旧行为；
#   - 只有图片时（截图、右键「复制图像」、预览里复制图片）才同步图片。
#
# 防循环机制：为两端各记一个「上次同步时的内容签名」。
#   - 文本签名 = text:<规范化文本的 SHA256>，两端算法一致；
#   - 图片签名 = image:<本端 PNG 字节的 SHA256>，两端各算各的，只和本端基线比较；
#   - 某端签名变化说明该端有新内容：只有一端变 -> 同步到另一端；两端都变 -> 采用 Windows 版本；
#   - 写入远端后会同步更新基线，避免把刚写过去的内容再拉回来造成循环。
# 为减少开销：本机用 GetClipboardSequenceNumber、Mac 用 NSPasteboard.changeCount 判断是否变化，
# 只有变化时才真正读取文本/下载图片。
# 日志不记录剪贴板内容，只记录方向、类型和大小。

$script:ClipStopFile   = Join-Path $script:DataDir 'clip.stop'
$script:ClipPidFile    = Join-Path $script:DataDir 'clip.pid'
$script:ClipStatusPath = Join-Path $script:DataDir 'clip-status.json'
$script:ClipLogPath    = Join-Path $script:DataDir 'clip.log'
$script:ClipStatePath  = Join-Path $script:DataDir 'clipboard-state.json'

# 图片中转缓存放在系统临时目录，退出时清理；不放进 .smac 以免剪贴板内容长期留盘
$script:ClipCacheDir      = Join-Path $env:TEMP ('smac-clip-' + $PID)
$script:ClipMaxImageBytes = 100MB

$script:WinClipCache   = @{ Seq = $null; Desc = $null }
$script:MacClipCache   = @{ ChangeCount = $null; Desc = $null }
$script:WinClipTypesReady = $false
$script:LastClipImage  = $null

# 远端 AppleScript 源码（保持纯 ASCII，避免编码问题）
$script:MacProbeScript = @'
use framework "AppKit"
use framework "Foundation"
on run
  set pb to current application's NSPasteboard's generalPasteboard()
  set cc to (pb's changeCount()) as integer
  set ts to pb's types()
  set outText to ""
  if ts is not missing value then
    repeat with x in (ts as list)
      set outText to outText & (x as text) & ","
    end repeat
  end if
  return (cc as text) & "|" & outText
end run
'@

$script:MacExportScript = @'
use framework "AppKit"
use framework "Foundation"
on run argv
  set outPath to item 1 of argv
  set pb to current application's NSPasteboard's generalPasteboard()
  set cc to (pb's changeCount()) as integer
  set pngD to pb's dataForType:"public.png"
  if pngD is not missing value then
    if pngD's writeToFile:outPath atomically:true then return "OK|" & (cc as text)
    return "FAIL|" & (cc as text)
  end if
  set srcD to pb's dataForType:"public.tiff"
  if srcD is missing value then
    set srcD to pb's dataForType:"public.jpeg"
  end if
  if srcD is missing value then return "NONE|" & (cc as text)
  set rep to current application's NSBitmapImageRep's imageRepWithData:srcD
  if rep is missing value then return "NONE|" & (cc as text)
  set outD to rep's representationUsingType:(current application's NSPNGFileType) |properties|:(current application's NSDictionary's dictionary())
  if outD's writeToFile:outPath atomically:true then return "OK|" & (cc as text)
  return "FAIL|" & (cc as text)
end run
'@

$script:MacSetImageScript = @'
use framework "AppKit"
use framework "Foundation"
on run argv
  set inPath to item 1 of argv
  set pb to current application's NSPasteboard's generalPasteboard()
  set pngD to current application's NSData's dataWithContentsOfFile:inPath
  if pngD is missing value then return "NODATA|0"
  set rep to current application's NSBitmapImageRep's imageRepWithData:pngD
  if rep is missing value then return "NOREP|0"
  set tiffD to rep's TIFFRepresentation()
  pb's clearContents()
  set ok1 to pb's setData:pngD forType:"public.png"
  set ok2 to pb's setData:tiffD forType:"public.tiff"
  set cc to (pb's changeCount()) as integer
  if ok1 then return "OK|" & (cc as text)
  return "FAIL|" & (cc as text)
end run
'@

function Ensure-ClipDataDir {
    if (-not (Test-Path -LiteralPath $script:DataDir)) {
        New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null
    }
}

function Write-ClipLog([string]$Message) {
    try {
        Ensure-ClipDataDir
        if ((Test-Path -LiteralPath $script:ClipLogPath) -and ((Get-Item -LiteralPath $script:ClipLogPath).Length -gt 2MB)) {
            Move-Item -LiteralPath $script:ClipLogPath -Destination ($script:ClipLogPath + '.1') -Force
        }
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $script:ClipLogPath -Value ("$stamp | $Message") -Encoding UTF8
    }
    catch { }
}

function Get-ClipInterval($Config) {
    $value = 2
    if ($Config.clipboardIntervalSeconds) { $value = [int]$Config.clipboardIntervalSeconds }
    if ($value -lt 1) { $value = 1 }
    if ($value -gt 300) { $value = 300 }
    return $value
}

function Get-ClipKindLabel([string]$Kind) {
    if ($Kind -eq 'image') { return '图片' }
    if ($Kind -eq 'text') { return '文本' }
    return ''
}

function Get-ClipCacheDir {
    if (-not (Test-Path -LiteralPath $script:ClipCacheDir)) {
        New-Item -ItemType Directory -Path $script:ClipCacheDir -Force | Out-Null
    }
    return $script:ClipCacheDir
}

function Clear-ClipCache {
    try {
        if (Test-Path -LiteralPath $script:ClipCacheDir) {
            Remove-Item -LiteralPath $script:ClipCacheDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    catch { }
}

# 统一换行符，避免 Windows(\r\n) 与 Mac(\n) 反复互相"改写"造成死循环
function Normalize-ClipText([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    return (($Text -replace "`r`n", "`n") -replace "`r", "`n")
}

function Get-ClipHash([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash($script:Utf8.GetBytes([string]$Text))
        return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally { $sha.Dispose() }
}

function Get-BytesHash([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { $bytes = $sha.ComputeHash($stream) }
        finally { $stream.Dispose() }
        return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally { $sha.Dispose() }
}

function New-ClipDescriptor([string]$Kind, [string]$Sig, [string]$Text, [string]$Path, [long]$Size) {
    return [pscustomobject]@{
        Kind  = $Kind
        Sig   = $Sig
        Text  = $Text
        Path  = $Path
        Size  = $Size
        # 剪贴板变化计数变了但内容签名没变（用户重复复制同一内容），只在本轮生效
        Fresh = $false
    }
}

# ---------------- 本机剪贴板 ----------------

function Ensure-WindowsClipboardTypes {
    if ($script:WinClipTypesReady) { return }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not ('Smac.NativeClip' -as [type])) {
        Add-Type -Namespace Smac -Name NativeClip -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
    }
    $script:WinClipTypesReady = $true
}

function Get-WindowsClipSequence {
    try {
        Ensure-WindowsClipboardTypes
        return [long]([Smac.NativeClip]::GetClipboardSequenceNumber())
    }
    catch { return -1 }
}

function Read-LocalClipboardText {
    $lastError = $null
    for ($i = 0; $i -lt 3; $i++) {
        try {
            $text = Get-Clipboard -Raw -ErrorAction Stop
            if ($null -eq $text) { return '' }
            return (Normalize-ClipText ([string]$text))
        }
        catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 120
        }
    }
    throw ("本机剪贴板暂时无法读取: {0}" -f $lastError)
}

function Write-LocalClipboardText([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { throw '拒绝写入空内容到剪贴板' }
    $lastError = $null
    for ($i = 0; $i -lt 3; $i++) {
        try {
            Set-Clipboard -Value $Text -ErrorAction Stop
            return
        }
        catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 120
        }
    }
    throw ("本机剪贴板暂时无法写入: {0}" -f $lastError)
}

# 把本机剪贴板里的图片存成临时 PNG，返回文件路径；没有图片返回 $null
function Read-LocalClipboardImage {
    $lastError = $null
    for ($i = 0; $i -lt 3; $i++) {
        try {
            if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { return $null }
            $image = [System.Windows.Forms.Clipboard]::GetImage()
            if ($null -eq $image) { return $null }
            $path = Join-Path (Get-ClipCacheDir) ('win-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.png')
            try {
                $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
            }
            finally {
                $image.Dispose()
            }
            return $path
        }
        catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 150
        }
    }
    throw ("本机剪贴板图片读取失败: {0}" -f $lastError)
}

function Write-LocalClipboardImage([string]$Path) {
    Ensure-WindowsClipboardTypes
    if ([string]::IsNullOrEmpty($Path) -or -not (Test-Path -LiteralPath $Path)) {
        throw '图片缓存已失效，请重新复制后重试'
    }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $stream = [IO.MemoryStream]::new($bytes, $false)
    try {
        $source = [System.Drawing.Image]::FromStream($stream)
        try {
            # 复制一份独立位图，避免依赖文件流生命周期
            $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $source
        }
        finally { $source.Dispose() }
    }
    finally { $stream.Dispose() }

    $lastError = $null
    for ($i = 0; $i -lt 3; $i++) {
        try {
            [System.Windows.Forms.Clipboard]::SetImage($bitmap)
            $script:LastClipImage = $bitmap
            return
        }
        catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 150
        }
    }
    $bitmap.Dispose()
    throw ("本机剪贴板图片写入失败: {0}" -f $lastError)
}

# 读取本机剪贴板并生成描述符（带 SequenceNumber 缓存，未变化时直接复用）
function Get-WindowsClipDescriptor {
    Ensure-WindowsClipboardTypes
    $seq = Get-WindowsClipSequence
    $cached = $script:WinClipCache.Desc
    if ($cached -and $seq -ge 0 -and $null -ne $script:WinClipCache.Seq -and [long]$script:WinClipCache.Seq -eq $seq) {
        return $cached
    }

    $desc = $null
    $textError = $null
    try {
        $text = Read-LocalClipboardText
        if ($text.Length -gt 0) {
            $desc = New-ClipDescriptor 'text' ('text:' + (Get-ClipHash $text)) $text '' 0
        }
    }
    catch { $textError = $_.Exception.Message }

    if (-not $desc) {
        try {
            $imagePath = Read-LocalClipboardImage
            if ($imagePath) {
                $size = (Get-Item -LiteralPath $imagePath).Length
                if ($size -gt $script:ClipMaxImageBytes) {
                    Remove-Item -LiteralPath $imagePath -Force -ErrorAction SilentlyContinue
                    Write-ClipLog ("[剪贴板] 本机图片过大（{0}），已跳过（上限 {1}）" -f (Format-Size $size), (Format-Size $script:ClipMaxImageBytes))
                    $desc = New-ClipDescriptor 'image' ('image:oversize:' + $seq + ':' + $size) '' '' $size
                }
                else {
                    $desc = New-ClipDescriptor 'image' ('image:' + (Get-BytesHash $imagePath)) '' $imagePath $size
                }
            }
        }
        catch {
            if ($textError) { throw ("本机剪贴板无法读取: {0} / {1}" -f $textError, $_.Exception.Message) }
        }
    }
    if (-not $desc) { $desc = New-ClipDescriptor 'empty' 'empty' '' '' 0 }

    $previous = $script:WinClipCache.Desc
    # 序列号变了但签名相同：用户重复复制了同一内容
    if ($seq -ge 0 -and $previous -and $desc.Sig -eq $previous.Sig -and $desc.Kind -ne 'empty') { $desc.Fresh = $true }
    $script:WinClipCache.Seq = $seq
    $script:WinClipCache.Desc = $desc
    if ($previous -and $previous.Kind -eq 'image' -and $previous.Path -and $previous.Path -ne $desc.Path) {
        Remove-Item -LiteralPath $previous.Path -Force -ErrorAction SilentlyContinue
    }
    return $desc
}

function Update-WindowsClipDescriptor {
    $script:WinClipCache.Seq = $null
    $script:WinClipCache.Desc = $null
    return (Get-WindowsClipDescriptor)
}

# ---------------- Mac 剪贴板（pbpaste / pbcopy / NSPasteboard） ----------------

function Invoke-MacAppleScript($Config, [string]$Script, [string[]]$ScriptArgs, [int]$TimeoutSeconds = 60) {
    $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes($Script))
    $remoteScript = '/tmp/smac-clip-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.applescript'
    $quoted = Quote-Remote $remoteScript
    $cmd = 'printf %s ' + (Quote-Remote $b64) + ' | base64 -d > ' + $quoted + ' && osascript ' + $quoted
    foreach ($item in $ScriptArgs) {
        $cmd += ' ' + (Quote-Remote ([string]$item))
    }
    $cmd += '; rc=$?; rm -f ' + $quoted + '; exit $rc'
    return (Invoke-Remote $Config $cmd $TimeoutSeconds).Trim()
}

function Get-MacClipboardProbe($Config) {
    $out = Invoke-MacAppleScript $Config $script:MacProbeScript @() 25
    $index = $out.IndexOf('|')
    if ($index -lt 0) { throw ("Mac 剪贴板探测返回异常: {0}" -f $out) }
    $changeCount = 0
    if (-not [int]::TryParse($out.Substring(0, $index).Trim(), [ref]$changeCount)) {
        throw ("Mac 剪贴板探测返回异常: {0}" -f $out)
    }
    $types = @()
    $rest = $out.Substring($index + 1).Trim()
    if ($rest) {
        $types = @($rest -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
    }
    return [pscustomobject]@{ ChangeCount = $changeCount; Types = $types }
}

function Test-MacPasteboardType($Probe, [string[]]$Names) {
    foreach ($name in $Names) {
        if ($Probe.Types -contains $name) { return $true }
    }
    return $false
}

function Read-RemoteClipboardText($Config) {
    # SSH 会话默认没有 locale，pbpaste/pbcopy 会静默丢弃非 ASCII（中文）内容，必须显式指定 UTF-8
    $text = Invoke-Remote $Config 'LC_ALL=en_US.UTF-8 pbpaste | base64' 60
    $b64 = ($text -replace '\s', '')
    if ([string]::IsNullOrEmpty($b64)) { return '' }
    $bytes = [Convert]::FromBase64String($b64)
    return (Normalize-ClipText ($script:Utf8.GetString($bytes)))
}

function Write-RemoteClipboardText($Config, [string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { throw '拒绝写入空内容到远端剪贴板' }
    $b64 = [Convert]::ToBase64String($script:Utf8.GetBytes($Text))

    # 小文本直接走 SSH 命令行；大文本走 scp，避免命令行长度限制
    if ($b64.Length -le 6000) {
        $cmd = 'printf %s ' + (Quote-Remote $b64) + ' | base64 -d | LC_ALL=en_US.UTF-8 pbcopy'
        Invoke-Remote $Config $cmd 60 | Out-Null
        return
    }

    $remoteDir = Get-RemoteHome $Config
    $remoteTmp = $remoteDir + '/.smac-clip-' + [guid]::NewGuid().ToString('N').Substring(0, 10)
    $localTmp = Join-Path $env:TEMP ('smac-clip-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.txt')
    try {
        [IO.File]::WriteAllText($localTmp, $Text, [System.Text.UTF8Encoding]::new($false))
        $scpArgs = (Get-ScpArgs $Config) + @($localTmp, (Remote-TargetString $Config $remoteTmp))
        $scp = Invoke-NativeCapture $script:ScpExe $scpArgs 120
        if ($scp.TimedOut) { throw '剪贴板上传超时，连接已中断' }
        if ($scp.Code -ne 0) { throw ("剪贴板上传失败 (exit {0}): {1}" -f $scp.Code, $scp.Output.Trim()) }
        $run = 'LC_ALL=en_US.UTF-8 pbcopy < ' + (Quote-Remote $remoteTmp) + '; rc=$?; rm -f ' + (Quote-Remote $remoteTmp) + '; exit $rc'
        Invoke-Remote $Config $run 60 | Out-Null
    }
    finally {
        Remove-Item -LiteralPath $localTmp -Force -ErrorAction SilentlyContinue
    }
}

# 把 Mac 剪贴板里的图片导出到本机临时目录，返回描述信息；没有图片返回 $null
function Export-RemoteClipboardImage($Config) {
    $remoteHome = Get-RemoteHome $Config
    $remoteTmp = $remoteHome + '/.smac-clip-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.png'
    try {
        $out = Invoke-MacAppleScript $Config $script:MacExportScript @($remoteTmp) 60
        $parts = $out.Split('|')
        if ($parts.Count -lt 2) { throw ("Mac 图片导出返回异常: {0}" -f $out) }
        if ($parts[0] -ne 'OK') {
            if ($parts[0] -eq 'NONE') { return $null }
            throw ("Mac 图片导出失败: {0}" -f $out)
        }
        $changeCount = 0
        [void][int]::TryParse($parts[1], [ref]$changeCount)

        $localPath = Join-Path (Get-ClipCacheDir) ('mac-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.png')
        $scpArgs = (Get-ScpArgs $Config) + @((Remote-TargetString $Config $remoteTmp), $localPath)
        $scp = Invoke-NativeCapture $script:ScpExe $scpArgs 180
        if ($scp.TimedOut) { throw '剪贴板图片下载超时，连接已中断' }
        if ($scp.Code -ne 0) { throw ("剪贴板图片下载失败 (exit {0}): {1}" -f $scp.Code, $scp.Output.Trim()) }

        $size = (Get-Item -LiteralPath $localPath).Length
        if ($size -gt $script:ClipMaxImageBytes) {
            Remove-Item -LiteralPath $localPath -Force -ErrorAction SilentlyContinue
            Write-ClipLog ("[剪贴板] Mac 图片过大（{0}），已跳过（上限 {1}）" -f (Format-Size $size), (Format-Size $script:ClipMaxImageBytes))
            return [pscustomobject]@{
                Sig         = 'image:oversize:' + $changeCount + ':' + $size
                Path        = ''
                Size        = $size
                ChangeCount = $changeCount
            }
        }
        return [pscustomobject]@{
            Sig         = 'image:' + (Get-BytesHash $localPath)
            Path        = $localPath
            Size        = $size
            ChangeCount = $changeCount
        }
    }
    finally {
        try { Invoke-Remote $Config ('rm -f ' + (Quote-Remote $remoteTmp)) 30 | Out-Null } catch { }
    }
}

# 读取 Mac 剪贴板并生成描述符（带 changeCount 缓存，未变化时直接复用）
function Get-MacClipDescriptor($Config) {
    $probe = Get-MacClipboardProbe $Config
    $cached = $script:MacClipCache.Desc
    if ($cached -and $null -ne $script:MacClipCache.ChangeCount -and [int]$script:MacClipCache.ChangeCount -eq $probe.ChangeCount) {
        return $cached
    }

    $desc = $null
    $cacheKey = $probe.ChangeCount

    # 有文本时优先按文本同步（Excel 单元格、网页文字等）
    if (Test-MacPasteboardType $probe @('public.utf8-plain-text', 'nsstringpboardtype', 'public.rtf', 'public.html')) {
        $text = Read-RemoteClipboardText $Config
        if ($text.Length -gt 0) {
            $desc = New-ClipDescriptor 'text' ('text:' + (Get-ClipHash $text)) $text '' 0
        }
    }

    if (-not $desc -and (Test-MacPasteboardType $probe @('public.png', 'public.tiff', 'public.jpeg', 'com.apple.pict'))) {
        $image = Export-RemoteClipboardImage $Config
        if ($image) {
            $desc = New-ClipDescriptor 'image' $image.Sig '' $image.Path $image.Size
            if ($null -ne $image.ChangeCount) { $cacheKey = $image.ChangeCount }
        }
    }

    if (-not $desc) { $desc = New-ClipDescriptor 'empty' 'empty' '' '' 0 }

    $previous = $script:MacClipCache.Desc
    # changeCount 变了但签名相同：用户重复复制了同一内容
    if ($previous -and $desc.Sig -eq $previous.Sig -and $desc.Kind -ne 'empty') { $desc.Fresh = $true }
    $script:MacClipCache.ChangeCount = $cacheKey
    $script:MacClipCache.Desc = $desc
    if ($previous -and $previous.Kind -eq 'image' -and $previous.Path -and $previous.Path -ne $desc.Path) {
        Remove-Item -LiteralPath $previous.Path -Force -ErrorAction SilentlyContinue
    }
    return $desc
}

# 把本机 PNG 写到 Mac 剪贴板，返回写入后的 changeCount
function Write-RemoteClipboardImage($Config, [string]$LocalPath) {
    if ([string]::IsNullOrEmpty($LocalPath) -or -not (Test-Path -LiteralPath $LocalPath)) {
        throw '图片缓存已失效，请重新复制后重试'
    }
    $remoteHome = Get-RemoteHome $Config
    $remoteTmp = $remoteHome + '/.smac-clip-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.png'
    try {
        $scpArgs = (Get-ScpArgs $Config) + @($LocalPath, (Remote-TargetString $Config $remoteTmp))
        $scp = Invoke-NativeCapture $script:ScpExe $scpArgs 180
        if ($scp.TimedOut) { throw '剪贴板图片上传超时，连接已中断' }
        if ($scp.Code -ne 0) { throw ("剪贴板图片上传失败 (exit {0}): {1}" -f $scp.Code, $scp.Output.Trim()) }

        $out = Invoke-MacAppleScript $Config $script:MacSetImageScript @($remoteTmp) 60
        $parts = $out.Split('|')
        if ($parts.Count -lt 2 -or $parts[0] -ne 'OK') {
            throw ("Mac 剪贴板图片写入失败: {0}" -f $out)
        }
        $changeCount = 0
        [void][int]::TryParse($parts[1], [ref]$changeCount)
        return $changeCount
    }
    finally {
        try { Invoke-Remote $Config ('rm -f ' + (Quote-Remote $remoteTmp)) 30 | Out-Null } catch { }
    }
}

# ---------------- 同步基准状态 ----------------

function Read-ClipState {
    $state = @{
        LastWin       = ''
        LastMac       = ''
        LastSyncAt    = $null
        LastDirection = ''
        LastKind      = ''
        LastLength    = 0
        LastSize      = 0
    }
    if (-not (Test-Path -LiteralPath $script:ClipStatePath)) { return $state }
    try {
        $obj = Get-Content -LiteralPath $script:ClipStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $obj.lastWinSig) { $state.LastWin = [string]$obj.lastWinSig }
        elseif ($null -ne $obj.lastSynced -and [string]$obj.lastSynced) { $state.LastWin = 'text:' + [string]$obj.lastSynced }
        if ($null -ne $obj.lastMacSig) { $state.LastMac = [string]$obj.lastMacSig }
        elseif ($null -ne $obj.lastSynced -and [string]$obj.lastSynced) { $state.LastMac = 'text:' + [string]$obj.lastSynced }
        if ($null -ne $obj.lastSyncAt) { $state.LastSyncAt = [string]$obj.lastSyncAt }
        if ($null -ne $obj.lastDirection) { $state.LastDirection = [string]$obj.lastDirection }
        if ($null -ne $obj.lastKind) { $state.LastKind = [string]$obj.lastKind }
        if ($null -ne $obj.lastLength) { $state.LastLength = [long]$obj.lastLength }
        if ($null -ne $obj.lastSize) { $state.LastSize = [long]$obj.lastSize }
    }
    catch { }
    return $state
}

function Save-ClipState($State) {
    try {
        Ensure-ClipDataDir
        $payload = [ordered]@{
            lastWinSig    = [string]$State.LastWin
            lastMacSig    = [string]$State.LastMac
            lastSyncAt    = $State.LastSyncAt
            lastDirection = [string]$State.LastDirection
            lastKind      = [string]$State.LastKind
            lastLength    = [long]$State.LastLength
            lastSize      = [long]$State.LastSize
        }
        $tmp = $script:ClipStatePath + '.tmp'
        $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $script:ClipStatePath -Force
    }
    catch { }
}

function Complete-ClipSync($State, [string]$Direction, [string]$Kind, [string]$WinSig, [string]$MacSig, [long]$Length, [long]$Size) {
    $State.LastWin = $WinSig
    $State.LastMac = $MacSig
    $State.LastDirection = $Direction
    $State.LastKind = $Kind
    $State.LastLength = $Length
    $State.LastSize = $Size
    $State.LastSyncAt = (Get-Date).ToString('o')
    Save-ClipState $State
    if ($Kind -eq 'image') {
        $detail = '图片 ' + (Format-Size $Size)
    }
    else {
        $detail = ('文本 {0} 字符' -f $Length)
    }
    Write-ClipLog ("[剪贴板] {0}（{1}）" -f $Direction, $detail)
}

# 两端内容相同或都不需要同步时，仅刷新基线，不产生日志
function Absorb-ClipBaseline($State, [string]$WinSig, [string]$MacSig) {
    if ($State.LastWin -ne $WinSig -or $State.LastMac -ne $MacSig) {
        $State.LastWin = $WinSig
        $State.LastMac = $MacSig
        Save-ClipState $State
    }
}

# ---------------- 单轮同步 ----------------

function Invoke-ClipPull($Config, $State, $Mac, $Result) {
    if ($Mac.Kind -eq 'text') {
        Write-LocalClipboardText $Mac.Text
        $check = Read-LocalClipboardText
        $checkHash = Get-ClipHash $check
        if ($checkHash -ne (Get-ClipHash $Mac.Text)) { throw '写入本机剪贴板后内容被其他程序改写' }
        Complete-ClipSync $State 'Mac → Win' 'text' ('text:' + $checkHash) $Mac.Sig ([long]$Mac.Text.Length) 0
        $Result.Action = 'pull'
        $Result.Kind = 'text'
        $Result.Length = $Mac.Text.Length
        return
    }

    Write-LocalClipboardImage $Mac.Path
    $after = Update-WindowsClipDescriptor
    if (-not $after -or $after.Kind -ne 'image') { throw '写入本机剪贴板后未检测到图片' }
    Complete-ClipSync $State 'Mac → Win' 'image' $after.Sig $Mac.Sig 0 $Mac.Size
    $Result.Action = 'pull'
    $Result.Kind = 'image'
    $Result.Size = $Mac.Size
}

function Invoke-ClipPush($Config, $State, $Win, [string]$Direction, $Result) {
    if ($Win.Kind -eq 'text') {
        Write-RemoteClipboardText $Config $Win.Text
        $sig = 'text:' + (Get-ClipHash $Win.Text)
        $script:MacClipCache.ChangeCount = $null
        $script:MacClipCache.Desc = $null
        Complete-ClipSync $State $Direction 'text' $sig $sig ([long]$Win.Text.Length) 0
        $Result.Action = 'push'
        $Result.Kind = 'text'
        $Result.Length = $Win.Text.Length
        return
    }

    $changeCount = Write-RemoteClipboardImage $Config $Win.Path
    # 远端 public.png 就是刚上传的这份字节，签名可直接沿用
    $script:MacClipCache.ChangeCount = $changeCount
    $script:MacClipCache.Desc = New-ClipDescriptor 'image' $Win.Sig '' '' $Win.Size
    Complete-ClipSync $State $Direction 'image' $Win.Sig $Win.Sig 0 $Win.Size
    $Result.Action = 'push'
    $Result.Kind = 'image'
    $Result.Size = $Win.Size
}

function Invoke-ClipboardCycle($Config, $State) {
    $result = [pscustomobject]@{
        Ok       = $true
        Error    = ''
        Action   = ''
        Kind     = ''
        Length   = 0
        Size     = 0
        Conflict = $false
        Skipped  = $false
    }

    try {
        $win = Get-WindowsClipDescriptor
    }
    catch {
        $result.Ok = $false
        $result.Error = $_.Exception.Message
        return $result
    }

    try {
        $mac = Get-MacClipDescriptor $Config
    }
    catch {
        $result.Ok = $false
        $result.Error = $_.Exception.Message
        return $result
    }

    $winSig = [string]$win.Sig
    $macSig = [string]$mac.Sig

    try {
        # 文本签名跨平台一致：相同则无事发生
        if ($winSig -eq $macSig) {
            Absorb-ClipBaseline $State $winSig $macSig
            return $result
        }

        # 本机没有内容（清空或只剩不支持的类型）：只拉取，不回灌，也不清空 Mac
        if ($win.Kind -eq 'empty') {
            if ($mac.Kind -eq 'empty') {
                Absorb-ClipBaseline $State $winSig $macSig
                return $result
            }
            if ($macSig -ne $State.LastMac -or [string]::IsNullOrEmpty($State.LastMac) -or $mac.Fresh) {
                if ($mac.Kind -eq 'image' -and [string]::IsNullOrEmpty($mac.Path)) {
                    $State.LastWin = $winSig
                    $State.LastMac = $macSig
                    Save-ClipState $State
                    $result.Skipped = $true
                    return $result
                }
                Invoke-ClipPull $Config $State $mac $result
            }
            return $result
        }

        # Mac 端为空：把本机内容推过去
        if ($mac.Kind -eq 'empty') {
            if ($winSig -ne $State.LastWin -or [string]::IsNullOrEmpty($State.LastWin) -or $win.Fresh) {
                if ($win.Kind -eq 'image' -and [string]::IsNullOrEmpty($win.Path)) {
                    $State.LastWin = $winSig
                    $State.LastMac = $macSig
                    Save-ClipState $State
                    $result.Skipped = $true
                    return $result
                }
                Invoke-ClipPush $Config $State $win 'Win → Mac' $result
            }
            return $result
        }

        $winChanged = ($winSig -ne $State.LastWin)
        $macChanged = ($macSig -ne $State.LastMac)

        if (-not $winChanged -and -not $macChanged) {
            # 签名没变，但某一端刚刚重复复制了同一内容：按最新动作同步一次
            if ($win.Fresh) {
                if ($win.Kind -eq 'image' -and [string]::IsNullOrEmpty($win.Path)) {
                    $State.LastWin = $winSig
                    $State.LastMac = $macSig
                    Save-ClipState $State
                    $result.Skipped = $true
                    return $result
                }
                if ($mac.Fresh) { $result.Conflict = $true }
                $direction = if ($mac.Fresh) { 'Win → Mac（两端同时复制，采用 Windows 版本）' } else { 'Win → Mac' }
                Invoke-ClipPush $Config $State $win $direction $result
                return $result
            }
            if ($mac.Fresh) {
                if ($mac.Kind -eq 'image' -and [string]::IsNullOrEmpty($mac.Path)) {
                    $State.LastWin = $winSig
                    $State.LastMac = $macSig
                    Save-ClipState $State
                    $result.Skipped = $true
                    return $result
                }
                Invoke-ClipPull $Config $State $mac $result
                return $result
            }
            # 两端都没变化：保持现状，不要再来回灌
            Absorb-ClipBaseline $State $winSig $macSig
            return $result
        }

        if ($winChanged -and -not $macChanged) {
            Invoke-ClipPush $Config $State $win 'Win → Mac' $result
            return $result
        }

        if ($macChanged -and -not $winChanged) {
            if ($mac.Kind -eq 'image' -and [string]::IsNullOrEmpty($mac.Path)) {
                $State.LastWin = $winSig
                $State.LastMac = $macSig
                Save-ClipState $State
                $result.Skipped = $true
                return $result
            }
            Invoke-ClipPull $Config $State $mac $result
            return $result
        }

        # 两端都变了（或首次同步两端就不同）：采用 Windows 版本
        if ($win.Kind -eq 'image' -and [string]::IsNullOrEmpty($win.Path)) {
            $State.LastWin = $winSig
            $State.LastMac = $macSig
            Save-ClipState $State
            $result.Skipped = $true
            return $result
        }
        $result.Conflict = $true
        Invoke-ClipPush $Config $State $win 'Win → Mac（两端同时修改，采用 Windows 版本）' $result
        return $result
    }
    catch {
        $result.Ok = $false
        $result.Error = $_.Exception.Message
        return $result
    }
    finally {
        # Fresh 只代表本轮刚发生的“重复复制”，处理完即失效
        if ($script:WinClipCache.Desc) { $script:WinClipCache.Desc.Fresh = $false }
        if ($script:MacClipCache.Desc) { $script:MacClipCache.Desc.Fresh = $false }
    }
}

# ---------------- 状态文件 ----------------

function Write-ClipStatus($Status) {
    try {
        Ensure-ClipDataDir
        $tmp = $script:ClipStatusPath + '.tmp'
        $Status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $script:ClipStatusPath -Force
    }
    catch { }
}

function Read-ClipStatusFile {
    if (-not (Test-Path -LiteralPath $script:ClipStatusPath)) { return $null }
    try {
        return (Get-Content -LiteralPath $script:ClipStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch { return $null }
}

# ---------------- 后台守护 ----------------

function Get-ClipWatcherPid {
    if (-not (Test-Path -LiteralPath $script:ClipPidFile)) { return 0 }
    $raw = (Get-Content -LiteralPath $script:ClipPidFile -Raw -ErrorAction SilentlyContinue)
    $watcherPid = 0
    if ($raw -and [int]::TryParse($raw.Trim(), [ref]$watcherPid)) {
        $process = Get-Process -Id $watcherPid -ErrorAction SilentlyContinue
        if ($process) { return $watcherPid }
    }
    Remove-Item -LiteralPath $script:ClipPidFile -Force -ErrorAction SilentlyContinue
    return 0
}

function Start-ClipWatcher {
    $existing = Get-ClipWatcherPid
    if ($existing) {
        Write-Host ("剪贴板同步已在运行 (PID {0})" -f $existing)
        return 0
    }

    Ensure-ClipDataDir
    Clear-ClipCache
    Remove-Item -LiteralPath $script:ClipStopFile -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $script:ClipPidFile -Value $PID -Encoding ASCII
    Write-ClipLog ("剪贴板同步启动 PID={0}" -f $PID)

    $startedAt = (Get-Date).ToString('o')
    $state = Read-ClipState
    $offline = $false
    $failStrikes = 0
    $lastError = ''

    Write-ClipStatus ([ordered]@{
        running         = $true
        pid             = $PID
        startedAt       = $startedAt
        intervalSeconds = 2
        macOnline       = $true
        lastSyncAt      = $state.LastSyncAt
        lastDirection   = $state.LastDirection
        lastKind        = $state.LastKind
        lastLength      = $state.LastLength
        lastSize        = $state.LastSize
        updatedAt       = (Get-Date).ToString('o')
    })

    try {
        while (-not (Test-Path -LiteralPath $script:ClipStopFile)) {
            $interval = 2
            try {
                $config = Get-SmacConfig
                $interval = Get-ClipInterval $config
                $cycle = Invoke-ClipboardCycle $config $state
                if ($cycle.Ok) {
                    if ($offline) {
                        Write-ClipLog 'Mac 已上线，剪贴板同步恢复'
                    }
                    $offline = $false
                    $failStrikes = 0
                    $lastError = ''
                }
                else {
                    $failStrikes++
                    $lastError = $cycle.Error
                    if (-not $offline -and $failStrikes -ge 3) {
                        $offline = $true
                        Write-ClipLog ('Mac 离线或剪贴板不可用，暂停同步；恢复后自动继续（{0}）' -f $cycle.Error)
                    }
                }
            }
            catch {
                $lastError = $_.Exception.Message
                Write-ClipLog ("剪贴板循环异常: {0}" -f $lastError)
            }

            Write-ClipStatus ([ordered]@{
                running         = $true
                pid             = $PID
                startedAt       = $startedAt
                intervalSeconds = $interval
                macOnline       = (-not $offline)
                lastSyncAt      = $state.LastSyncAt
                lastDirection   = $state.LastDirection
                lastKind        = $state.LastKind
                lastLength      = $state.LastLength
                lastSize        = $state.LastSize
                lastError       = $lastError
                updatedAt       = (Get-Date).ToString('o')
            })

            $until = (Get-Date).AddSeconds($interval)
            while ((Get-Date) -lt $until -and -not (Test-Path -LiteralPath $script:ClipStopFile)) {
                Start-Sleep -Milliseconds 200
            }
        }
    }
    finally {
        Clear-ClipCache
        Remove-Item -LiteralPath $script:ClipPidFile -Force -ErrorAction SilentlyContinue
        Write-ClipLog ("剪贴板同步停止 PID={0}" -f $PID)
        Write-ClipStatus ([ordered]@{
            running         = $false
            pid             = $null
            startedAt       = $startedAt
            stoppedAt       = (Get-Date).ToString('o')
            lastSyncAt      = $state.LastSyncAt
            lastDirection   = $state.LastDirection
            lastKind        = $state.LastKind
            lastLength      = $state.LastLength
            lastSize        = $state.LastSize
        })
    }
    return 0
}

function Start-ClipService {
    $existing = Get-ClipWatcherPid
    if ($existing) {
        Write-Host ("剪贴板同步已在运行 (PID {0})" -f $existing)
        return 0
    }
    $vbs = Join-Path $script:AppDir 'clip-service.vbs'
    if (-not (Test-Path -LiteralPath $vbs)) { throw "缺少启动脚本: $vbs" }
    Remove-Item -LiteralPath $script:ClipStopFile -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Get-ClipWatcherPid) { break }
    }
    $watcherPid = Get-ClipWatcherPid
    if (-not $watcherPid) { throw '剪贴板同步启动失败，请查看 clip.log' }
    Write-Host ("剪贴板同步已启动 (PID {0})" -f $watcherPid)
    return 0
}

function Stop-ClipService {
    $watcherPid = Get-ClipWatcherPid
    if (-not $watcherPid) {
        Remove-Item -LiteralPath $script:ClipStopFile -Force -ErrorAction SilentlyContinue
        Write-Host '剪贴板同步未在运行。'
        return 0
    }
    Set-Content -LiteralPath $script:ClipStopFile -Value 'stop' -Encoding ASCII
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Id $watcherPid -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-Process -Id $watcherPid -ErrorAction SilentlyContinue) {
        Stop-Process -Id $watcherPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    Remove-Item -LiteralPath $script:ClipStopFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:ClipPidFile -Force -ErrorAction SilentlyContinue
    Write-Host ("剪贴板同步已停止 (PID {0})" -f $watcherPid)
    return 0
}

function Get-ClipStartupShortcutPath {
    return (Join-Path ([Environment]::GetFolderPath('Startup')) 'smac-clip.lnk')
}

function Install-ClipStartup {
    $vbs = Join-Path $script:AppDir 'clip-service.vbs'
    if (-not (Test-Path -LiteralPath $vbs)) { throw "缺少启动脚本: $vbs" }
    $shortcutPath = Get-ClipStartupShortcutPath
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + $vbs + '"'
    $shortcut.WorkingDirectory = $script:AppDir
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Win-Mac 剪贴板同步'
    $shortcut.Save()
    Write-Host ("已设置开机自启: {0}" -f $shortcutPath)
    return 0
}

function Uninstall-ClipStartup {
    $shortcutPath = Get-ClipStartupShortcutPath
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
        Write-Host '已取消剪贴板同步开机自启。'
    }
    else {
        Write-Host '未找到剪贴板同步开机自启项。'
    }
    return 0
}

# ---------------- 命令 ----------------

function Show-ClipHelp {
    Write-Host @'
smac clip - 剪贴板（文本 / 图片）双向同步

命令:
  smac.ps1 clip start       启动后台同步（默认每 2 秒检查一次）
  smac.ps1 clip stop        停止后台同步
  smac.ps1 clip status      查看运行状态与最近同步
  smac.ps1 clip now         立即同步一次
  smac.ps1 clip install     设置开机自启并启动
  smac.ps1 clip uninstall   取消开机自启（不停止当前进程）

规则:
  - 同步纯文本（含中文、多行）和图片；同时带文本的内容优先按文本同步（如 Excel 单元格、网页文字）；
  - 图片走系统剪贴板格式（PNG/TIFF），单张超过 100 MB 会跳过并记日志；
  - Mac 端用系统自带的 pbpaste/pbcopy/NSPasteboard，不需要安装任何东西；
  - 两端同时复制时采用 Windows 版本；
  - 日志不记录内容，只记录方向、类型和大小: %USERPROFILE%\.smac\clip.log
'@
    return 0
}

function Invoke-ClipCommand($Config, [string[]]$ClipArgs) {
    $sub = 'status'
    if ($ClipArgs.Count -gt 0) { $sub = $ClipArgs[0].ToLowerInvariant() }

    switch ($sub) {
        'now' {
            $state = Read-ClipState
            try {
                $cycle = Invoke-ClipboardCycle $Config $state
            }
            finally {
                Clear-ClipCache
            }
            if (-not $cycle.Ok) {
                Write-Bad ("剪贴板同步失败: {0}" -f $cycle.Error)
                return 1
            }
            if ($cycle.Action -eq 'push') {
                if ($cycle.Kind -eq 'image') { Write-Good ("已同步到 Mac（图片 {0}）" -f (Format-Size $cycle.Size)) }
                else { Write-Good ("已同步到 Mac（{0} 字符）" -f $cycle.Length) }
            }
            elseif ($cycle.Action -eq 'pull') {
                if ($cycle.Kind -eq 'image') { Write-Good ("已从 Mac 同步到本机（图片 {0}）" -f (Format-Size $cycle.Size)) }
                else { Write-Good ("已从 Mac 同步到本机（{0} 字符）" -f $cycle.Length) }
            }
            elseif ($cycle.Skipped) {
                Write-Note '图片过大，已跳过本次同步（详见 clip.log）。'
            }
            else {
                Write-Note '两端内容已一致，无需同步。'
            }
            return 0
        }
        'status' {
            $watcherPid = Get-ClipWatcherPid
            $status = Read-ClipStatusFile
            Write-Step '剪贴板同步状态'
            if ($watcherPid) { Write-Good ("后台同步运行中 (PID {0})" -f $watcherPid) }
            else { Write-Warn2 '后台同步未运行' }
            Write-Host ("  间隔  : {0} 秒" -f (Get-ClipInterval $Config))
            if ($status) {
                if ($status.PSObject.Properties['macOnline'] -and $status.macOnline -eq $false) {
                    Write-Warn2 ("  Mac   : 离线或剪贴板不可用，等待恢复（{0}）" -f $status.lastError)
                }
                elseif ($status.lastSyncAt) {
                    $direction = [string]$status.lastDirection
                    $kind = ''
                    if ($status.PSObject.Properties['lastKind']) { $kind = Get-ClipKindLabel ([string]$status.lastKind) }
                    if ($kind) { $direction = $direction + ' · ' + $kind }
                    Write-Host ("  最近  : {0}（{1}）" -f $status.lastSyncAt, $direction)
                }
                else {
                    Write-Host '  最近  : 尚未同步'
                }
            }
            Write-Host ("  日志  : {0}" -f $script:ClipLogPath)
            return 0
        }
        'start' { return Start-ClipService }
        'stop' { return Stop-ClipService }
        'install' {
            Install-ClipStartup | Out-Null
            return Start-ClipService
        }
        'uninstall' {
            return Uninstall-ClipStartup
        }
        'watch' {
            $daemonScript = Join-Path $script:AppDir 'web\clip-daemon.js'
            if (Test-Path -LiteralPath $daemonScript) {
                $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
                if (-not $nodeExe) {
                    foreach ($cand in @(
                        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
                        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
                    )) { if (Test-Path -LiteralPath $cand) { $nodeExe = $cand; break } }
                }
                if ($nodeExe) {
                    & $nodeExe $daemonScript
                    return $LASTEXITCODE
                }
            }
            return Start-ClipWatcher
        }
        default {
            return Show-ClipHelp
        }
    }
}
