$ErrorActionPreference = 'Stop'
$launcherArguments = $args
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDirectory = Join-Path $root '.clipforge\runtime'
$bootstrapMutex = $null
$ownsMutex = $false

function Find-CompatibleNode([string]$candidate) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    $npmCli = Join-Path (Split-Path -Parent $candidate) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { return $null }
    try {
        # Windows PowerShell 5.1 strips embedded double quotes from native arguments.
        $information = & $candidate -p 'process.versions.node+String.fromCharCode(124)+process.arch' 2>$null
        if ($LASTEXITCODE -ne 0 -or $information -notmatch '^(\d+\.\d+\.\d+)\|x64$') { return $null }
        $version = [Version]$Matches[1]
        if (($version.Major -eq 22 -and $version -ge [Version]'22.13.0') -or $version.Major -eq 24) { return $candidate }
    } catch { return $null }
    return $null
}

try {
    Set-Location -LiteralPath $root
    if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) { throw '请先解压完整源码，再双击 start.cmd。' }
    if ($launcherArguments -contains '--help') {
        Write-Host 'Usage: start.cmd [--port 3000] [--no-browser] [--check]'
        Write-Host 'Double-click to prepare dependencies and open ClipForge. Ctrl+C stops the service.'
        exit 0
    }
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($systemNode) { Find-CompatibleNode $systemNode.Source } else { $null }

    if (-not $nodePath -and (Test-Path -LiteralPath $runtimeDirectory)) {
        foreach ($directory in (Get-ChildItem -LiteralPath $runtimeDirectory -Directory -Filter 'node-v22.*-win-*' | Sort-Object LastWriteTime -Descending)) {
            if (Test-Path -LiteralPath (Join-Path $directory.FullName '.clipforge-node-ready')) {
                $nodePath = Find-CompatibleNode (Join-Path $directory.FullName 'node.exe')
                if ($nodePath) { break }
            }
        }
    }

    if (-not $nodePath) {
        if ($launcherArguments -contains '--check') { throw '未找到兼容的 Node.js（22.13+ 或 24 LTS）。正常双击启动时会自动下载。' }
        $hash = [System.Security.Cryptography.SHA256]::Create()
        $rootHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-', '')
        $hash.Dispose()
        $bootstrapMutex = New-Object System.Threading.Mutex($false, ('Local\ClipForge-bootstrap-' + $rootHash))
        try { $ownsMutex = $bootstrapMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) { Write-Host '另一个启动窗口正在准备 Node.js，请查看该窗口。'; exit 0 }

        $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        # Media packages do not supply Windows ARM64 binaries. Windows 11 ARM runs
        # the complete x64 stack under emulation, including SQLite and FFmpeg.
        $nodeArchitecture = switch ($architecture.ToUpperInvariant()) { 'AMD64' { 'x64' } 'ARM64' { 'x64' } default { throw '自动启动支持 Windows x64，或支持 x64 仿真的 Windows 11 ARM64。' } }
        New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Host '正在从 nodejs.org 下载便携 Node.js 22 LTS（首次启动需要联网）...'
        $manifest = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -TimeoutSec 90).Content
        $pattern = '^([0-9a-fA-F]{64})\s+(node-v22\.\d+\.\d+-win-' + $nodeArchitecture + '\.zip)$'
        $entry = $null
        foreach ($line in ($manifest -split "`n")) {
            if ($line.Trim() -match $pattern) { $entry = @{ Hash = $Matches[1]; File = $Matches[2] }; break }
        }
        if (-not $entry) { throw 'Node.js 官方校验清单中没有当前架构的安装包。' }
        $nodeVersion = [regex]::Match($entry.File, 'node-(v22\.\d+\.\d+)-').Groups[1].Value
        $archive = Join-Path $runtimeDirectory ('download-' + $PID + '.zip')
        try {
            Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/' + $nodeVersion + '/' + $entry.File) -OutFile $archive -TimeoutSec 300
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $entry.Hash) { throw 'Node.js 下载校验失败，请再次启动重试。' }
            Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDirectory -Force
            $installedDirectory = Join-Path $runtimeDirectory ($entry.File -replace '\.zip$', '')
            $nodePath = Find-CompatibleNode (Join-Path $installedDirectory 'node.exe')
            if (-not $nodePath) { throw '下载的 Node.js 无法运行，请检查系统架构及安全软件提示。' }
            [IO.File]::WriteAllText((Join-Path $installedDirectory '.clipforge-node-ready'), $nodeVersion)
        } finally {
            if (Test-Path -LiteralPath $archive -PathType Leaf) { Remove-Item -LiteralPath $archive -Force }
        }
    }
} catch {
    Write-Host ('启动准备失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($ownsMutex) { $bootstrapMutex.ReleaseMutex() }
    if ($bootstrapMutex) { $bootstrapMutex.Dispose() }
}

$env:Path = (Split-Path -Parent $nodePath) + ';' + $env:Path
$env:CLIPFORGE_NPM_CLI = Join-Path (Split-Path -Parent $nodePath) 'node_modules\npm\bin\npm-cli.js'
& $nodePath (Join-Path $root 'scripts\launch-local.mjs') @launcherArguments
exit $LASTEXITCODE
