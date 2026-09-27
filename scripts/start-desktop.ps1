param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$mutex = New-Object Threading.Mutex($false, 'Local\MirrorVideoDnaDesktopStart')
$locked = $false
function Test-Endpoint([string]$Url) {
    try { return (Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 }
    catch { return $false }
}
function Test-Port([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { Write-Host 'Startup is already in progress.'; exit 0 }
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath 'node_modules/vinext/dist/cli.js')) { throw 'Project dependencies are missing.' }
    $logRoot = Join-Path $projectRoot '.worker'
    [IO.Directory]::CreateDirectory($logRoot) | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    if (-not (Test-Port 3000)) {
        Start-Process -FilePath $nodePath -ArgumentList @('node_modules/vinext/dist/cli.js', 'dev', '--port', '3000', '--strictPort') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot "desktop-site-$stamp.out.log") -RedirectStandardError (Join-Path $logRoot "desktop-site-$stamp.err.log") | Out-Null
    }
    if (-not (Test-Port 43128)) {
        Start-Process -FilePath $nodePath -ArgumentList 'worker/previs/server.mjs' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot "desktop-previs-$stamp.out.log") -RedirectStandardError (Join-Path $logRoot "desktop-previs-$stamp.err.log") | Out-Null
    }
    Write-Host 'Starting Mirror Video DNA. Waiting for website and preview service...'
    $deadline = (Get-Date).AddSeconds(90)
    do {
        $siteReady = Test-Endpoint 'http://localhost:3000'
        $apiReady = Test-Endpoint 'http://localhost:3000/api/projects'
        try { $previsReady = (Invoke-RestMethod 'http://127.0.0.1:43128/health' -TimeoutSec 3).version -eq 'automatic-previs.v2' } catch { $previsReady = $false }
        if ($siteReady -and $apiReady -and $previsReady) {
            Write-Host 'Ready: http://localhost:3000'
            Write-Host 'Services run in the background. This window can be closed.'
            if (-not $NoBrowser) { Start-Process 'http://localhost:3000' }
            exit 0
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "Startup timed out. Logs: $logRoot\desktop-*.log . Check whether ports 3000 and 43128 are occupied."
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
