# Starts WSL for Herdr when it isn't running, and keeps it running.
#
# The Windows Herdr reaches its "wsl" machine over ssh (127.0.0.1:2222, sshd under systemd in
# Ubuntu). ssh can't start WSL, and WSL stops a distro once no wsl.exe session is left, so this
# starts one that never ends: `wsl.exe -d <distro> --exec sleep infinity` in a hidden console.
# herdr-core reconnects by itself once sshd answers.
#
# Run by: the Windows t3-spaces mod whenever the wsl machine isn't connected (Herdr opening, or
# WSL stopped while it's open), and the Startup shortcut "Herdr WSL keepalive" at login.
# Safe to run any number of times: an existing keepalive means there's nothing to do.
param(
    [string]$Distro = 'Ubuntu',
    [int]$Port = 2222,
    [int]$WaitSeconds = 45
)

$ErrorActionPreference = 'Stop'
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$keepalive = "-d $Distro --exec sleep infinity"

function Test-Keepalive {
    # The keepalive's wsl.exe exits when the distro stops, so finding it means WSL is up.
    @(Get-CimInstance Win32_Process -Filter "Name = 'wsl.exe'" |
        Where-Object { $_.CommandLine -like "*$keepalive*" }).Count -gt 0
}

function Test-Port {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        return $attempt.AsyncWaitHandle.WaitOne(1000) -and $client.Connected
    }
    catch { return $false }
    finally { $client.Close() }
}

# One run at a time: Herdr's mod and the Startup shortcut can fire together.
$mutex = New-Object Threading.Mutex($false, 'Local\herdr-start-wsl')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    if (-not (Test-Keepalive)) {
        # Created through WMI, so it isn't a child of whoever ran this script (Herdr's exec, a
        # shortcut): it keeps running after they exit. conhost --headless: no window.
        $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
            -Arguments @{ CommandLine = "`"$conhost`" --headless `"$wsl`" $keepalive" }
        if ($result.ReturnValue -ne 0) { exit 2 }
    }
    # Wait until sshd answers so a caller knows WSL is ready for Herdr.
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port) { exit 0 }
        Start-Sleep -Milliseconds 500
    }
    exit 1
}
finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
