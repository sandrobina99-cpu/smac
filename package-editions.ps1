#requires -Version 5.1
<#
  package-editions.ps1 - 将 smac 主机端与客机端打包为原生独立窗口应用（Windows .exe 与 macOS .app）：
  输出目录: <项目目录>\dist\
    1. smac-host-windows.exe   (Windows 主机端单文件自解压独立窗口版 EXE，自动创建桌面与开始菜单快捷方式)
    2. smac-host-windows.zip   (Windows 主机端完整压缩包，内含 smac-host.exe 独立窗口启动器)
    3. smac-guest-windows.exe  (Windows 客机端单文件自解压独立窗口版 EXE，自动创建桌面与开始菜单快捷方式)
    4. smac-guest-windows.zip  (Windows 客机端完整压缩包，内含 smac-guest.exe 独立窗口启动器)
    5. smac-host-macos.zip     (macOS 主机端完整包，内含原生 Universal 独立窗口应用「smac 主机控制台.app」，支持 Command+空格 打开)
    6. smac-guest-macos.zip    (macOS 客机端完整包，内含原生 Universal 独立窗口应用「smac 客机控制台.app」，支持 Command+空格 打开)
#>
param(
  [switch]$IncludeLocalGuest,
  [switch]$SkipLocalShortcuts
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Drawing

function Find-CscExe {
  foreach ($c in @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  throw '未找到 .NET Framework csc.exe 编译器。'
}

function New-SmacIconFile([string]$OutIcoPath, [bool]$IsGuest) {
  $relPng = if ($IsGuest) { 'macos\icon-guest-1024.png' } else { 'macos\icon-host-1024.png' }
  $srcPng = Join-Path $PSScriptRoot $relPng
  $masterBmp = $null
  if (Test-Path -LiteralPath $srcPng) {
    $masterBmp = [System.Drawing.Bitmap]::FromFile($srcPng)
  } else {
    $size = 256
    $masterBmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g0 = [System.Drawing.Graphics]::FromImage($masterBmp)
    $g0.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g0.Clear([System.Drawing.Color]::Transparent)
    $c1 = if ($IsGuest) { [System.Drawing.Color]::FromArgb(255, 8, 28, 38) } else { [System.Drawing.Color]::FromArgb(255, 10, 16, 42) }
    $c2 = if ($IsGuest) { [System.Drawing.Color]::FromArgb(255, 16, 165, 135) } else { [System.Drawing.Color]::FromArgb(255, 58, 92, 235) }
    $rect = New-Object System.Drawing.Rectangle(16, 16, 224, 224)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 135.0)
    $g0.FillEllipse($brush, $rect)
    $g0.Dispose()
  }

  $sizes = @(256, 64, 48, 32, 16)
  $pngBlobs = New-Object System.Collections.Generic.List[byte[]]
  foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($masterBmp, 0, 0, $sz, $sz)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBlobs.Add($ms.ToArray())
    $ms.Dispose()
    $bmp.Dispose()
  }
  $masterBmp.Dispose()

  $fs = New-Object System.IO.FileStream($OutIcoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]$sizes.Count)

  $offset = 6 + ($sizes.Count * 16)
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]
    $blob = $pngBlobs[$i]
    $dimByte = if ($sz -ge 256) { [Byte]0 } else { [Byte]$sz }
    $bw.Write($dimByte)
    $bw.Write($dimByte)
    $bw.Write([Byte]0)
    $bw.Write([Byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$blob.Length)
    $bw.Write([UInt32]$offset)
    $offset += $blob.Length
  }
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $bw.Write($pngBlobs[$i])
  }
  $bw.Flush()
  $bw.Dispose()
  $fs.Dispose()
}

function Build-LauncherExe([string]$CscPath, [string]$OutExePath, [string]$Mode, [string]$Title, [string]$IconPath) {
  $csCode = @"
using System;
using System.IO;
using System.Net;
using System.Diagnostics;
using System.Threading;
using System.Windows.Forms;

static class SmacLauncher {
    static string FindNode() {
        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathEnv.Split(Path.PathSeparator)) {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try {
                string cand = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(cand)) return cand;
            } catch { }
        }
        string[] fallbacks = new string[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "hermes", "node", "node.exe")
        };
        foreach (string f in fallbacks) {
            if (File.Exists(f)) return f;
        }
        return "";
    }

    static string FindAppWindowBrowser() {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string[] candidates = new string[] {
            Path.Combine(progFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(progFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(progFiles, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(progFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe")
        };
        foreach (string c in candidates) {
            if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
        }
        return "";
    }

    static void OpenStandaloneWindow(string url, bool isGuest) {
        string browserExe = FindAppWindowBrowser();
        if (!string.IsNullOrEmpty(browserExe)) {
            try {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string profileDir = Path.Combine(localAppData, "smac-window-profile", isGuest ? "guest" : "host");
                Directory.CreateDirectory(profileDir);
                string winSize = isGuest ? "1260,860" : "1380,880";
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = browserExe;
                psi.Arguments = "--app=\"" + url + "\" --user-data-dir=\"" + profileDir + "\" --window-size=" + winSize + " --no-first-run --no-default-browser-check";
                psi.UseShellExecute = false;
                Process.Start(psi);
                return;
            } catch { }
        }
        try {
            Process.Start(url);
        } catch { }
    }

    static bool CheckHealth(int port, string appTag) {
        if (port <= 0) return false;
        try {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
            req.Timeout = 1000;
            req.ReadWriteTimeout = 1000;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream())) {
                string body = sr.ReadToEnd();
                return body.IndexOf("\"" + appTag + "\"", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        } catch {
            return false;
        }
    }

    static int FindRunningPort(string portFile, int basePort, string appTag) {
        try {
            if (File.Exists(portFile)) {
                int p = 0;
                if (int.TryParse(File.ReadAllText(portFile).Trim(), out p) && CheckHealth(p, appTag)) return p;
            }
        } catch { }
        for (int p = basePort; p <= basePort + 6; p++) {
            if (CheckHealth(p, appTag)) return p;
        }
        return 0;
    }

    [STAThread]
    static int Main(string[] args) {
        bool isGuest = "$Mode" == "guest";
        bool noOpen = false;
        foreach (string a in args) {
            if (string.Equals(a, "--no-open", StringComparison.OrdinalIgnoreCase)) noOpen = true;
        }
        string appTag = isGuest ? "smac-guest" : "smac";
        int basePort = isGuest ? 8790 : 8788;
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string dataDir = Path.Combine(home, isGuest ? ".smac-guest" : ".smac");
        Directory.CreateDirectory(dataDir);
        string portFile = Path.Combine(dataDir, isGuest ? "guest-web-port" : "web-port");
        string errFile = Path.Combine(dataDir, isGuest ? "guest-web.err.log" : "web.err.log");

        int runningPort = FindRunningPort(portFile, basePort, appTag);
        if (runningPort > 0) {
            if (!noOpen) OpenStandaloneWindow("http://127.0.0.1:" + runningPort + "/", isGuest);
            return 0;
        }

        string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        string scriptPath = isGuest
            ? (File.Exists(Path.Combine(exeDir, "guest-server.js"))
                ? Path.Combine(exeDir, "guest-server.js")
                : Path.Combine(exeDir, "guest", "guest-server.js"))
            : Path.Combine(exeDir, "web", "server.js");

        if (!File.Exists(scriptPath)) {
            MessageBox.Show("未找到控制台脚本: " + scriptPath, "$Title", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string nodeExe = FindNode();
        if (string.IsNullOrEmpty(nodeExe)) {
            MessageBox.Show("未检测到 Node.js 运行环境。请先安装 Node.js (https://nodejs.org/) 后再启动。", "$Title", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = nodeExe;
        psi.Arguments = "\"" + scriptPath + "\"";
        psi.WorkingDirectory = Path.GetDirectoryName(scriptPath);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        try {
            Process.Start(psi);
        } catch (Exception ex) {
            MessageBox.Show("启动后台服务失败: " + ex.Message, "$Title", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        for (int i = 0; i < 40; i++) {
            Thread.Sleep(200);
            runningPort = FindRunningPort(portFile, basePort, appTag);
            if (runningPort > 0) {
                if (!noOpen) OpenStandaloneWindow("http://127.0.0.1:" + runningPort + "/", isGuest);
                return 0;
            }
        }

        MessageBox.Show("控制台服务启动超时，请检查日志: " + errFile, "$Title", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 1;
    }
}
"@
  $tmpCs = Join-Path $env:TEMP ('smac-launcher-' + [guid]::NewGuid().ToString('N') + '.cs')
  try {
    [IO.File]::WriteAllText($tmpCs, $csCode, [Text.Encoding]::UTF8)
    $cscArgs = @('/nologo', '/target:winexe', '/optimize+', "/out:$OutExePath", '/r:System.dll', '/r:System.Windows.Forms.dll')
    if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
      $cscArgs += "/win32icon:$IconPath"
    }
    $cscArgs += $tmpCs
    $res = & $CscPath @cscArgs 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutExePath)) {
      throw ("编译 $OutExePath 失败: " + $res)
    }
  } finally {
    Remove-Item -LiteralPath $tmpCs -Force -ErrorAction SilentlyContinue
  }
}

function Build-SelfExtractingExe([string]$CscPath, [string]$PayloadZipPath, [string]$OutExePath, [string]$AppSubDir, [string]$InnerExeRelPath, [string]$ShortcutName, [string]$Title, [string]$IconPath) {
  $csCode = @"
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;
using System.Windows.Forms;

static class SmacSelfExtractor {
    static void CreateShortcuts(string targetExe, string workingDir, string shortcutName) {
        try {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) return;
            dynamic shell = Activator.CreateInstance(t);
            string[] dirs = new string[] {
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Environment.GetFolderPath(Environment.SpecialFolder.Programs)
            };
            foreach (string dir in dirs) {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
                string lnkPath = Path.Combine(dir, shortcutName + ".lnk");
                dynamic sc = shell.CreateShortcut(lnkPath);
                sc.TargetPath = targetExe;
                sc.WorkingDirectory = workingDir;
                sc.Description = "$Title（独立窗口）";
                sc.IconLocation = targetExe + ",0";
                sc.Save();
            }
        } catch { }
    }

    [STAThread]
    static int Main(string[] args) {
        try {
            string baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "$AppSubDir");
            Directory.CreateDirectory(baseDir);

            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("payload.zip")) {
                if (s == null) {
                    MessageBox.Show("内置安装包资源缺失。", "$Title", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read)) {
                    foreach (ZipArchiveEntry entry in zip.Entries) {
                        string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        string fullPath = Path.Combine(baseDir, rel);
                        if (string.IsNullOrEmpty(entry.Name)) {
                            Directory.CreateDirectory(fullPath);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
                        using (Stream inStream = entry.Open())
                        using (FileStream outStream = new FileStream(fullPath, FileMode.Create, FileAccess.Write)) {
                            inStream.CopyTo(outStream);
                        }
                    }
                }
            }

            string targetExe = Path.Combine(baseDir, "$InnerExeRelPath".Replace('/', Path.DirectorySeparatorChar));
            string workDir = Path.GetDirectoryName(targetExe);
            CreateShortcuts(targetExe, workDir, "$ShortcutName");

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = targetExe;
            psi.WorkingDirectory = workDir;
            psi.UseShellExecute = true;
            Process.Start(psi);
            return 0;
        } catch (Exception ex) {
            MessageBox.Show("释放并启动 $Title 失败: " + ex.Message, "$Title", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
"@
  $tmpCs = Join-Path $env:TEMP ('smac-sfx-' + [guid]::NewGuid().ToString('N') + '.cs')
  try {
    [IO.File]::WriteAllText($tmpCs, $csCode, [Text.Encoding]::UTF8)
    $cscArgs = @('/nologo', '/target:winexe', '/optimize+', "/out:$OutExePath", "/resource:$PayloadZipPath,payload.zip", '/r:System.dll', '/r:System.IO.Compression.dll', '/r:System.Windows.Forms.dll', '/r:Microsoft.CSharp.dll')
    if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
      $cscArgs += "/win32icon:$IconPath"
    }
    $cscArgs += $tmpCs
    $res = & $CscPath @cscArgs 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutExePath)) {
      throw ("编译自解压 $OutExePath 失败: " + $res)
    }
  } finally {
    Remove-Item -LiteralPath $tmpCs -Force -ErrorAction SilentlyContinue
  }
}

function New-WindowsShortcuts([string]$TargetExe, [string]$WorkingDir, [string]$ShortcutName, [string]$Description) {
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $dirs = @(
      [Environment]::GetFolderPath('DesktopDirectory'),
      [Environment]::GetFolderPath('Programs')
    )
    foreach ($d in $dirs) {
      if ($d -and (Test-Path -LiteralPath $d)) {
        $lnk = Join-Path $d ($ShortcutName + '.lnk')
        $sc = $wsh.CreateShortcut($lnk)
        $sc.TargetPath = $TargetExe
        $sc.WorkingDirectory = $WorkingDir
        $sc.Description = $Description
        $sc.IconLocation = "$TargetExe,0"
        $sc.Save()
      }
    }
  } catch { }
}

function New-Utf8Zip([string]$SourceDir, [string]$ZipPath) {
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  $srcFull = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\', '/')
  $fs = [IO.File]::Open($ZipPath, [IO.FileMode]::Create)
  try {
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create, $false, [System.Text.Encoding]::UTF8)
    try {
      $files = Get-ChildItem -LiteralPath $srcFull -Recurse -File -Force
      foreach ($f in $files) {
        $rel = $f.FullName.Substring($srcFull.Length + 1).Replace('\', '/')
        $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        if ($rel -match '\.(sh|command)$' -or $rel -match '/Contents/MacOS/' -or $rel -match 'smac-mac-bin$') {
          $entry.ExternalAttributes = (([int]0x81ED) -shl 16) # -rwxr-xr-x (0100755)
        } else {
          $entry.ExternalAttributes = (([int]0x81A4) -shl 16) # -rw-r--r-- (0100644)
        }
        $es = $entry.Open()
        try {
          $inFs = [IO.File]::OpenRead($f.FullName)
          try { $inFs.CopyTo($es) } finally { $inFs.Dispose() }
        } finally { $es.Dispose() }
      }
    } finally { $zip.Dispose() }
  } finally { $fs.Dispose() }
}

function Copy-CleanTree([string]$SrcDir, [string]$DstDir, [switch]$StripWindowsBinaries) {
  if (-not (Test-Path -LiteralPath $SrcDir)) { return }
  Copy-Item -LiteralPath $SrcDir -Destination $DstDir -Recurse -Force

  $badDirs = @(
    (Join-Path $DstDir 'node_modules\cpu-features'),
    (Join-Path $DstDir 'node_modules\ssh2\lib\protocol\crypto\build'),
    (Join-Path $DstDir '.smac'),
    (Join-Path $DstDir '.ssh'),
    (Join-Path $DstDir '.git')
  )
  foreach ($d in $badDirs) {
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
  }

  $badFiles = Get-ChildItem -LiteralPath $DstDir -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Extension -in @('.node', '.dll', '.dylib', '.so', '.log', '.pid', '.tmp', '.bak') -or
    ($StripWindowsBinaries -and $_.Extension -in @('.exe', '.ico')) -or
    $_.Name -in @(
      'host-pairing.json', 'guest-pairing.json', 'hub-admin.json', 'account-session.json',
      'devices.json', 'config.json',
      'agent-credentials.json', 'bootstrap-peer.json', 'sync-status.json',
      'clip-status.json', 'clipboard-state.json', 'clipboard-multi-state.json',
      'host-profile.json', 'host-profile.seed.json', 'pairing-code.txt',
      'smac-guest-setup.zip', 'smac-ssh-setup.zip', '.DS_Store', 'Thumbs.db'
    )
  }
  foreach ($bf in $badFiles) {
    Remove-Item -LiteralPath $bf.FullName -Force -ErrorAction SilentlyContinue
  }
}

function Build-MacAppBundle([string]$StageDir, [string]$AppName, [string]$BundleId, [string]$ExecName, [string]$Mode, [string]$MacBinPath, [string]$IcnsPath, [string]$RootDir) {
  $appDir = Join-Path $StageDir ($AppName + '.app')
  $macOsDir = Join-Path $appDir 'Contents\MacOS'
  $resDir = Join-Path $appDir 'Contents\Resources'
  $resAppDir = Join-Path $resDir 'app'
  New-Item -ItemType Directory -Force -Path $macOsDir | Out-Null
  New-Item -ItemType Directory -Force -Path $resAppDir | Out-Null

  Copy-Item -LiteralPath $MacBinPath -Destination (Join-Path $macOsDir $ExecName) -Force
  if (Test-Path -LiteralPath $IcnsPath) {
    Copy-Item -LiteralPath $IcnsPath -Destination (Join-Path $resDir 'AppIcon.icns') -Force
  }

  $plist = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>$AppName</string>
  <key>CFBundleName</key>
  <string>$AppName</string>
  <key>CFBundleExecutable</key>
  <string>$ExecName</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>$BundleId</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>2.0.0</string>
  <key>CFBundleVersion</key>
  <string>200</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
  <key>SmacAppMode</key>
  <string>$Mode</string>
</dict>
</plist>
"@
  [IO.File]::WriteAllText((Join-Path $appDir 'Contents\Info.plist'), ($plist -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))

  if ($Mode -eq 'host') {
    foreach ($dirName in @('agent', 'guest', 'web')) {
      Copy-CleanTree (Join-Path $RootDir $dirName) (Join-Path $resAppDir $dirName) -StripWindowsBinaries
    }
    $smacSh = Join-Path $RootDir 'smac.sh'
    if (Test-Path -LiteralPath $smacSh) {
      $shText = [IO.File]::ReadAllText($smacSh, [Text.Encoding]::UTF8) -replace "`r`n", "`n"
      [IO.File]::WriteAllText((Join-Path $resAppDir 'smac.sh'), $shText, (New-Object Text.UTF8Encoding($false)))
    }
  } else {
    $guestSub = Join-Path $resAppDir 'guest'
    New-Item -ItemType Directory -Force -Path $guestSub | Out-Null
    foreach ($gf in @('guest-server.js', 'guest.html', 'guest.css', 'guest.js', 'guest-env.js')) {
      $srcGf = Join-Path $RootDir ('guest\' + $gf)
      if (Test-Path -LiteralPath $srcGf) {
        Copy-Item -LiteralPath $srcGf -Destination (Join-Path $guestSub $gf) -Force
      }
    }
  }
}

function Get-LocalSensitiveTokens {
  $tokens = New-Object System.Collections.Generic.List[string]
  $add = {
    param([string]$v)
    if (-not [string]::IsNullOrWhiteSpace($v)) {
      $clean = $v.Trim()
      if ($clean.Length -ge 6 -and -not $tokens.Contains($clean)) { $tokens.Add($clean) }
    }
  }
  $smacDir = Join-Path $env:USERPROFILE '.smac'
  $cfgPath = Join-Path $smacDir 'config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    try {
      $c = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      & $add ([string]$c.host)
      & $add ([string]$c.lanHost)
      & $add ([string]$c.zerotierNetworkId)
      if ($c.key) { & $add (Split-Path -Leaf ([string]$c.key)) }
    } catch { }
  }
  $devPath = Join-Path $smacDir 'devices.json'
  if (Test-Path -LiteralPath $devPath) {
    try {
      $dRaw = Get-Content -LiteralPath $devPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $arr = if ($dRaw.devices) { $dRaw.devices } else { $dRaw }
      foreach ($d in @($arr)) {
        if (-not $d) { continue }
        & $add ([string]$d.host)
        & $add ([string]$d.fallbackHost)
        & $add ([string]$d.zerotierIp)
        & $add ([string]$d.zerotierNodeId)
        & $add ([string]$d.zerotierNetworkId)
      }
    } catch { }
  }
  $pairPath = Join-Path $smacDir 'guest-pairing.json'
  if (Test-Path -LiteralPath $pairPath) {
    try {
      $p = Get-Content -LiteralPath $pairPath -Raw -Encoding UTF8 | ConvertFrom-Json
      & $add ([string]$p.pairToken)
    } catch { }
  }
  $pubPath = Join-Path $env:USERPROFILE '.ssh\smac_peer_ed25519.pub'
  if (Test-Path -LiteralPath $pubPath) {
    try {
      $pub = (Get-Content -LiteralPath $pubPath -Raw -Encoding UTF8).Trim()
      $parts = $pub -split '\s+'
      if ($parts.Length -ge 2) { & $add $parts[1] }
    } catch { }
  }
  if ($env:COMPUTERNAME) { & $add $env:COMPUTERNAME }
  return @($tokens)
}

function Assert-CleanHostZip([string]$ZipPath, [string[]]$SensitiveTokens) {
  $issues = New-Object System.Collections.Generic.List[string]
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if ($name -match '(?i)(^|/)(enable-ssh|\.smac|\.ssh|\.git)(/|$)' -or
          $name -match '(?i)(devices|config|guest-pairing|host-pairing|bootstrap-peer|agent-credentials|host-profile|host-profile\.seed)\.json$' -or
          $name -match '(?i)smac-(guest|ssh)-setup\.zip$' -or
          $name -match '(?i)\.(node|log|pid)$') {
        $issues.Add("禁止打包的文件: $name")
        continue
      }
      if ($name -match '(?i)/(node_modules|katex|vendor)/') { continue }
      if ($name -notmatch '(?i)\.(js|ps1|sh|cmd|command|html|css|txt|md|json|vbs|plist)$') { continue }

      $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
      try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }

      if ($text -match 'BEGIN (OPENSSH|RSA|EC) PRIVATE KEY') {
        $issues.Add("检测到私钥内容: $name")
      }
      if ($text -match 'ssh-(ed25519|rsa)\s+AAAA[A-Za-z0-9+/]{16,}') {
        $issues.Add("检测到真实 SSH 公钥: $name")
      }
      if ($text -match "DEFAULT_NETWORK_ID\s*=\s*['""][0-9a-fA-F]{16}['""]") {
        $issues.Add("检测到硬编码 ZeroTier 组号: $name")
      }
      foreach ($tok in $SensitiveTokens) {
        if ($tok -and $text.IndexOf($tok, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
          $issues.Add("检测到本机敏感配置 '$tok' 出现在: $name")
        }
      }
    }
  } finally {
    $zip.Dispose()
  }

  if ($issues.Count -gt 0) {
    Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
    throw ("发行包纯净度校验失败 ($ZipPath):`n  - " + ($issues -join "`n  - "))
  }
}

$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$csc = Find-CscExe

# 同步最新 guest-env.js 到 guest 模板目录
Copy-Item -LiteralPath (Join-Path $root 'agent\guest-env.js') -Destination (Join-Path $root 'guest\guest-env.js') -Force

# 1. 生成图标并编译原生独立窗口 Windows 启动器 (smac-host.exe 与 guest\smac-guest.exe)
Write-Host '==> 1/6 正在编译原生独立窗口 Windows 启动器 (smac-host.exe / smac-guest.exe)…' -ForegroundColor Cyan
$hostIco = Join-Path $root 'web\smac-host.ico'
$guestIco = Join-Path $root 'guest\smac-guest.ico'
New-SmacIconFile $hostIco $false
New-SmacIconFile $guestIco $true

$hostLauncherExe = Join-Path $root 'smac-host.exe'
$guestLauncherExe = Join-Path $root 'guest\smac-guest.exe'
Build-LauncherExe $csc $hostLauncherExe 'host' 'smac 主机端控制台' $hostIco
Build-LauncherExe $csc $guestLauncherExe 'guest' 'smac 客机端控制台' $guestIco
Write-Host '[OK] 已生成原生独立窗口启动器: smac-host.exe 与 guest\smac-guest.exe' -ForegroundColor Green

# 部署本机 ~/.smac-guest 并生成本机桌面与开始菜单快捷方式
if (-not $SkipLocalShortcuts) {
  $localGuestDir = Join-Path $env:USERPROFILE '.smac-guest'
  New-Item -ItemType Directory -Force -Path $localGuestDir | Out-Null
  foreach ($gf in @('guest-server.js', 'guest.html', 'guest.css', 'guest.js', 'guest-env.js', 'smac-guest.exe', 'smac-guest.ico')) {
    $srcGf = Join-Path $root ('guest\' + $gf)
    if (Test-Path -LiteralPath $srcGf) {
      Copy-Item -LiteralPath $srcGf -Destination (Join-Path $localGuestDir $gf) -Force
    }
  }
  New-WindowsShortcuts $hostLauncherExe $root 'smac 主机控制台' 'smac 主机端文件中枢与远程终端控制台（独立窗口）'
  New-WindowsShortcuts (Join-Path $localGuestDir 'smac-guest.exe') $localGuestDir 'smac 客机控制台' 'smac 客机端连接与环境控制台（独立窗口）'
  Write-Host '[OK] 已在本机桌面与开始菜单生成快捷方式: 「smac 主机控制台」与「smac 客机控制台」' -ForegroundColor Green
}

$sensitiveTokens = Get-LocalSensitiveTokens

# 2. Windows 通用纯净主机端 (smac-host-windows.zip & smac-host-windows.exe)
Write-Host '==> 2/6 正在打包 Windows 通用纯净主机端 (smac-host-windows.zip & smac-host-windows.exe)…' -ForegroundColor Cyan
$hostStageRoot = Join-Path $dist 'host-stage'
$hostStage = Join-Path $hostStageRoot 'smac-host'
if (Test-Path -LiteralPath $hostStageRoot) { Remove-Item -LiteralPath $hostStageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $hostStage | Out-Null

foreach ($file in @('README.md', 'smac-host.exe', 'smac.ps1', 'smac.cmd', 'send-to-mac.cmd', 'sync-service.vbs', 'clip-service.vbs', 'package-editions.ps1')) {
  $src = Join-Path $root $file
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $hostStage $file) -Force
  }
}
$hostLauncherCmd = "@echo off`r`nchcp 65001 >nul`r`ncd /d ""%~dp0""`r`nif exist ""%~dp0smac-host.exe"" (`r`n  start """" ""%~dp0smac-host.exe""`r`n) else (`r`n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0smac.ps1"" web`r`n)`r`n"
[IO.File]::WriteAllText((Join-Path $hostStage '一键启动主机控制台.cmd'), $hostLauncherCmd, [Text.Encoding]::UTF8)

foreach ($dirName in @('lib', 'agent', 'guest', 'web', 'macos')) {
  if (Test-Path -LiteralPath (Join-Path $root $dirName)) {
    Copy-CleanTree (Join-Path $root $dirName) (Join-Path $hostStage $dirName)
  }
}

$hostZip = Join-Path $dist 'smac-host-windows.zip'
New-Utf8Zip $hostStageRoot $hostZip
Remove-Item -LiteralPath $hostStageRoot -Recurse -Force -ErrorAction SilentlyContinue
Assert-CleanHostZip $hostZip $sensitiveTokens

$hostSingleExe = Join-Path $dist 'smac-host-windows.exe'
Build-SelfExtractingExe $csc $hostZip $hostSingleExe 'smac-host-app' 'smac-host/smac-host.exe' 'smac 主机控制台' 'smac 主机端控制台' $hostIco
$winSizeMb = [Math]::Round((Get-Item -LiteralPath $hostZip).Length / 1MB, 2)
$winExeSizeMb = [Math]::Round((Get-Item -LiteralPath $hostSingleExe).Length / 1MB, 2)
Write-Host ("[OK] Windows 主机端已生成: {0} ({1} MB) 与 {2} ({3} MB)" -f $hostSingleExe, $winExeSizeMb, $hostZip, $winSizeMb) -ForegroundColor Green

# 3. Windows 通用纯净客机端 (smac-guest-windows.zip & smac-guest-windows.exe)
Write-Host '==> 3/6 正在打包 Windows 通用纯净客机端 (smac-guest-windows.zip & smac-guest-windows.exe)…' -ForegroundColor Cyan
$guestWinStageRoot = Join-Path $dist 'guest-win-stage'
$guestWinStage = Join-Path $guestWinStageRoot 'smac-guest'
if (Test-Path -LiteralPath $guestWinStageRoot) { Remove-Item -LiteralPath $guestWinStageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $guestWinStage | Out-Null

foreach ($gf in @('guest-server.js', 'guest.html', 'guest.css', 'guest.js', 'guest-env.js', 'smac-guest.exe', 'smac-guest.ico', 'install-guest.ps1', '一键安装客机端.cmd', '使用说明.txt')) {
  $srcGf = Join-Path $root ('guest\' + $gf)
  if (Test-Path -LiteralPath $srcGf) {
    Copy-Item -LiteralPath $srcGf -Destination (Join-Path $guestWinStage $gf) -Force
  }
}
$winGuestCmd = "@echo off`r`nchcp 65001 >nul`r`ncd /d ""%~dp0""`r`nif exist ""%~dp0smac-guest.exe"" (`r`n  start """" ""%~dp0smac-guest.exe""`r`n) else (`r`n  node ""%~dp0guest-server.js"" --open`r`n)`r`n"
[IO.File]::WriteAllText((Join-Path $guestWinStage '启动客机控制台.cmd'), $winGuestCmd, [Text.Encoding]::UTF8)

$guestWinZip = Join-Path $dist 'smac-guest-windows.zip'
New-Utf8Zip $guestWinStageRoot $guestWinZip
Remove-Item -LiteralPath $guestWinStageRoot -Recurse -Force -ErrorAction SilentlyContinue
Assert-CleanHostZip $guestWinZip $sensitiveTokens

$guestSingleExe = Join-Path $dist 'smac-guest-windows.exe'
Build-SelfExtractingExe $csc $guestWinZip $guestSingleExe 'smac-guest-app' 'smac-guest/smac-guest.exe' 'smac 客机控制台' 'smac 客机端控制台' $guestIco
$guestWinZipMb = [Math]::Round((Get-Item -LiteralPath $guestWinZip).Length / 1MB, 2)
$guestWinExeMb = [Math]::Round((Get-Item -LiteralPath $guestSingleExe).Length / 1MB, 2)
Write-Host ("[OK] Windows 客机端已生成: {0} ({1} MB) 与 {2} ({3} MB)" -f $guestSingleExe, $guestWinExeMb, $guestWinZip, $guestWinZipMb) -ForegroundColor Green

# 4. macOS 通用纯净主机端 (smac-host-macos.zip，内置原生 Universal 独立窗口 smac 主机控制台.app)
Write-Host '==> 4/6 正在打包 macOS 通用纯净主机端 (smac-host-macos.zip，含 smac 主机控制台.app)…' -ForegroundColor Cyan
$macStageRoot = Join-Path $dist 'mac-stage'
$macStage = Join-Path $macStageRoot 'smac-host-mac'
if (Test-Path -LiteralPath $macStageRoot) { Remove-Item -LiteralPath $macStageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $macStage | Out-Null

$macBinPath = Join-Path $root 'macos\smac-mac-bin'
$macHostIcns = Join-Path $root 'macos\AppIcon-host.icns'
$macGuestIcns = Join-Path $root 'macos\AppIcon-guest.icns'

if (Test-Path -LiteralPath $macBinPath) {
  Build-MacAppBundle $macStage 'smac 主机控制台' 'com.smac.host' 'smac-host' 'host' $macBinPath $macHostIcns $root
}

foreach ($file in @('README.md', 'smac.sh', '一键启动主机控制台.command')) {
  $src = Join-Path $root $file
  if (Test-Path -LiteralPath $src) {
    $text = [IO.File]::ReadAllText($src, [Text.Encoding]::UTF8) -replace "`r`n", "`n"
    [IO.File]::WriteAllText((Join-Path $macStage $file), $text, (New-Object Text.UTF8Encoding($false)))
  }
}

$macHostInstallCmd = @"
#!/usr/bin/env bash
set -e
DIR="`$(cd "`$(dirname "`$0")" && pwd)"
APP_SRC="`$DIR/smac 主机控制台.app"
if [ -d "`$APP_SRC" ]; then
  DEST="/Applications/smac 主机控制台.app"
  rm -rf "`$DEST" 2>/dev/null || sudo rm -rf "`$DEST"
  cp -R "`$APP_SRC" "`$DEST" 2>/dev/null || sudo cp -R "`$APP_SRC" "`$DEST"
  xattr -cr "`$DEST" 2>/dev/null || true
  codesign --force --deep --sign - "`$DEST" >/dev/null 2>&1 || true
  LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  [ -x "`$LSREG" ] && "`$LSREG" -f "`$DEST" || true
  mdimport "`$DEST" 2>/dev/null || true
  echo "[OK] 已安装到 /Applications/smac 主机控制台.app（可按 Command+空格 输入 smac 打开）"
  open -a "`$DEST"
fi
"@
[IO.File]::WriteAllText((Join-Path $macStage '安装到应用程序(Command+空格可搜).command'), ($macHostInstallCmd -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))

foreach ($dirName in @('agent', 'guest', 'web', 'macos')) {
  if (Test-Path -LiteralPath (Join-Path $root $dirName)) {
    Copy-CleanTree (Join-Path $root $dirName) (Join-Path $macStage $dirName) -StripWindowsBinaries
  }
}

$macZip = Join-Path $dist 'smac-host-macos.zip'
New-Utf8Zip $macStageRoot $macZip
Remove-Item -LiteralPath $macStageRoot -Recurse -Force -ErrorAction SilentlyContinue
Assert-CleanHostZip $macZip $sensitiveTokens
$macSizeMb = [Math]::Round((Get-Item -LiteralPath $macZip).Length / 1MB, 2)
Write-Host ("[OK] macOS 通用主机端已生成并校验零泄漏: {0} ({1} MB)" -f $macZip, $macSizeMb) -ForegroundColor Green

# 5. macOS 通用纯净客机端 (smac-guest-macos.zip，内置原生 Universal 独立窗口 smac 客机控制台.app)
Write-Host '==> 5/6 正在打包 macOS 通用纯净客机端 (smac-guest-macos.zip，含 smac 客机控制台.app)…' -ForegroundColor Cyan
$macGuestStageRoot = Join-Path $dist 'mac-guest-stage'
$macGuestStage = Join-Path $macGuestStageRoot 'smac-guest-mac'
if (Test-Path -LiteralPath $macGuestStageRoot) { Remove-Item -LiteralPath $macGuestStageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $macGuestStage | Out-Null

if (Test-Path -LiteralPath $macBinPath) {
  Build-MacAppBundle $macGuestStage 'smac 客机控制台' 'com.smac.guest' 'smac-guest' 'guest' $macBinPath $macGuestIcns $root
  Copy-Item -LiteralPath $macBinPath -Destination (Join-Path $macGuestStage 'smac-mac-bin') -Force
}
if (Test-Path -LiteralPath $macGuestIcns) {
  Copy-Item -LiteralPath $macGuestIcns -Destination (Join-Path $macGuestStage 'AppIcon-guest.icns') -Force
}

foreach ($gf in @('guest-server.js', 'guest.html', 'guest.css', 'guest.js', 'guest-env.js', 'install-guest.sh', '一键安装客机端(Mac).command', '使用说明.txt')) {
  $srcGf = Join-Path $root ('guest\' + $gf)
  if (Test-Path -LiteralPath $srcGf) {
    $text = [IO.File]::ReadAllText($srcGf, [Text.Encoding]::UTF8) -replace "`r`n", "`n"
    [IO.File]::WriteAllText((Join-Path $macGuestStage $gf), $text, (New-Object Text.UTF8Encoding($false)))
  }
}

$macGuestInstallAppCmd = @"
#!/usr/bin/env bash
set -e
DIR="`$(cd "`$(dirname "`$0")" && pwd)"
APP_SRC="`$DIR/smac 客机控制台.app"
if [ -d "`$APP_SRC" ]; then
  DEST="/Applications/smac 客机控制台.app"
  rm -rf "`$DEST" 2>/dev/null || sudo rm -rf "`$DEST"
  cp -R "`$APP_SRC" "`$DEST" 2>/dev/null || sudo cp -R "`$APP_SRC" "`$DEST"
  xattr -cr "`$DEST" 2>/dev/null || true
  codesign --force --deep --sign - "`$DEST" >/dev/null 2>&1 || true
  LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  [ -x "`$LSREG" ] && "`$LSREG" -f "`$DEST" || true
  mdimport "`$DEST" 2>/dev/null || true
  echo "[OK] 已安装到 /Applications/smac 客机控制台.app（可按 Command+空格 输入 smac 打开）"
  open -a "`$DEST"
fi
"@
[IO.File]::WriteAllText((Join-Path $macGuestStage '安装到应用程序(Command+空格可搜).command'), ($macGuestInstallAppCmd -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))

$macGuestZip = Join-Path $dist 'smac-guest-macos.zip'
New-Utf8Zip $macGuestStageRoot $macGuestZip
Remove-Item -LiteralPath $macGuestStageRoot -Recurse -Force -ErrorAction SilentlyContinue
Assert-CleanHostZip $macGuestZip $sensitiveTokens
$macGuestSizeMb = [Math]::Round((Get-Item -LiteralPath $macGuestZip).Length / 1MB, 2)
Write-Host ("[OK] macOS 通用客机端已生成并校验零泄漏: {0} ({1} MB)" -f $macGuestZip, $macGuestSizeMb) -ForegroundColor Green

# 6. 可选生成本机专属客机安装包
if ($IncludeLocalGuest) {
  Write-Host '==> 6/6 额外生成当前本机的客机端安装包 (smac-guest-setup.zip)…' -ForegroundColor Cyan
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    foreach ($cand in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )) {
      if (Test-Path -LiteralPath $cand) { $node = $cand; break }
    }
  }
  if (-not $node) { throw '未找到 Node.js，无法执行客机端打包器。' }
  $guestRes = (& $node -e "const p=require('./web/guest-packager');const r=p.buildGuestSetupZip();console.log('GUEST_ZIP_OK '+r.zipPath);" 2>&1 | Out-String)
  if ($guestRes -notmatch 'GUEST_ZIP_OK\s+(.+)') {
    throw ('打包客机端失败: ' + $guestRes)
  }
  Remove-Item -LiteralPath (Join-Path $dist 'guest-stage') -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ('[OK] 当前本机客机端安装包已生成: ' + $Matches[1].Trim()) -ForegroundColor Green
}

Write-Host ''
Write-Host '主客机双端 Windows (.exe) 与 macOS (.app) 独立窗口版全部打包完成：' -ForegroundColor Cyan
Write-Host ('  1. Windows 主机端独立 EXE : ' + $hostSingleExe)
Write-Host ('  2. Windows 主机端完整 ZIP : ' + $hostZip)
Write-Host ('  3. Windows 客机端独立 EXE : ' + $guestSingleExe)
Write-Host ('  4. Windows 客机端完整 ZIP : ' + $guestWinZip)
Write-Host ('  5. macOS 主机端独立 App包 : ' + $macZip + ' (内置 smac 主机控制台.app)')
Write-Host ('  6. macOS 客机端独立 App包 : ' + $macGuestZip + ' (内置 smac 客机控制台.app)')
