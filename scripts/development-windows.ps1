param([int]$Port = 19431)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$daemonPath = Join-Path $repositoryRoot 'bin\sing-box-daemon.exe'
$daemonData = Join-Path $repositoryRoot 'bin\development-daemon'
$userData = Join-Path $repositoryRoot 'bin\development-user-data'
$daemonProcess = $null

Push-Location $repositoryRoot
try {
    $boxDirectory = Join-Path (Split-Path $repositoryRoot -Parent) 'sing-box'
    # Match the Linux daemon's TCP development identity without editing the sibling checkout.
    $peerSourcePath = Join-Path $boxDirectory 'experimental\boxdd\peer_windows.go'
    $overlaySourcePath = Join-Path $repositoryRoot 'bin\development-peer_windows.go'
    $overlayPath = Join-Path $repositoryRoot 'bin\development-overlay.json'
    $peerSource = [System.IO.File]::ReadAllText($peerSourcePath)
    $fallback = @'
func platformFallbackPeerIdentity(ctx context.Context) (peerIdentity, error) {
    if listenAddress != "" {
        tokenUser, err := windows.GetCurrentProcessToken().GetTokenUser()
        if err != nil { return peerIdentity{}, err }
        processID := uint32(os.Getpid())
        var sessionID uint32
        if err := windows.ProcessIdToSessionId(processID, &sessionID); err != nil {
            return peerIdentity{}, err
        }
        return peerIdentity{UserID: tokenUser.User.Sid.String(), ProcessID: processID, SessionID: sessionID}, nil
    }
'@
    $functionHeader = 'func platformFallbackPeerIdentity(ctx context.Context) (peerIdentity, error) {'
    if (-not $peerSource.Contains($functionHeader)) { throw 'Unsupported daemon peer identity source.' }
    $overlaySource = $peerSource.Replace($functionHeader, $fallback)
    New-Item (Split-Path $daemonPath -Parent) -ItemType Directory -Force | Out-Null
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    if (-not (Test-Path $overlaySourcePath) -or [System.IO.File]::ReadAllText($overlaySourcePath) -ne $overlaySource) {
        [System.IO.File]::WriteAllText($overlaySourcePath, $overlaySource, $utf8)
    }
    $replacement = @{}
    $replacement[$peerSourcePath] = $overlaySourcePath
    $serverSourcePath = Join-Path $boxDirectory 'experimental\boxdd\server.go'
    $serverOverlayPath = Join-Path $repositoryRoot 'bin\development-server.go'
    $serverSource = [System.IO.File]::ReadAllText($serverSourcePath)
    $desktopRegistration = 'RegisterDesktopServiceServer(d.server, &desktopService{daemon: d})'
    if (-not $serverSource.Contains($desktopRegistration)) { throw 'Unsupported daemon service registration source.' }
    $serverOverlay = $serverSource.Replace($desktopRegistration, ($desktopRegistration + "`n" + @'
    if listenAddress != "" {
        RegisterApplicationServiceServer(d.server, &applicationService{startedService: d.startedService})
    }
'@))
    if (-not (Test-Path $serverOverlayPath) -or [System.IO.File]::ReadAllText($serverOverlayPath) -ne $serverOverlay) {
        [System.IO.File]::WriteAllText($serverOverlayPath, $serverOverlay, $utf8)
    }
    $replacement[$serverSourcePath] = $serverOverlayPath
    [System.IO.File]::WriteAllText($overlayPath, (@{ Replace = $replacement } | ConvertTo-Json), $utf8)
    if (-not (Test-Path $daemonPath) -or (Get-Item $overlaySourcePath).LastWriteTimeUtc -gt (Get-Item $daemonPath).LastWriteTimeUtc -or (Get-Item $serverOverlayPath).LastWriteTimeUtc -gt (Get-Item $daemonPath).LastWriteTimeUtc) {
        Push-Location $boxDirectory
        $previousGoFlags = $env:GOFLAGS
        try {
            $env:GOFLAGS = ($previousGoFlags + ' "-overlay=' + $overlayPath + '"').Trim()
            & go run ./cmd/internal/build_boxdd -debug "-output=$daemonPath"
            if ($LASTEXITCODE -ne 0) { throw 'Daemon build failed.' }
        } finally {
            $env:GOFLAGS = $previousGoFlags
            Pop-Location
        }
    }
    & pnpm generate
    if ($LASTEXITCODE -ne 0) { throw 'Desktop code generation failed.' }
    & pnpm -C dashboard generate
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard code generation failed.' }

    New-Item $daemonData -ItemType Directory -Force | Out-Null
    $daemonProcess = Start-Process -FilePath $daemonPath -ArgumentList @(
        'run', '--working-directory', ('"' + $daemonData + '"'),
        '--listen', "127.0.0.1:$Port"
    ) -WindowStyle Hidden -PassThru -RedirectStandardOutput 'bin\daemon.stdout.log' -RedirectStandardError 'bin\daemon.stderr.log'
    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if ($daemonProcess.HasExited) { throw 'Daemon exited. See bin/daemon.stderr.log.' }
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $client.Connect('127.0.0.1', $Port)
            $ready = $true
            break
        } catch { Start-Sleep -Milliseconds 100 } finally { $client.Dispose() }
    }
    if (-not $ready) { throw 'Daemon startup timed out.' }
    & pnpm exec electron-vite dev -- "--daemon-address=http://127.0.0.1:$Port" "--user-data=$userData"
    if ($LASTEXITCODE -ne 0) { throw 'Desktop application exited with an error.' }
} finally {
    if ($null -ne $daemonProcess -and -not $daemonProcess.HasExited) {
        Stop-Process -Id $daemonProcess.Id
    }
    Pop-Location
}
