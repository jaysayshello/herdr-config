# Ctrl+r in Herdr (Windows): give every pane in a tab an equal share of its row or column.
# Port of scripts/balance-panes.sh (macOS). Rewrites the pane weights in herdr-core's
# "herdr-app" doc; the window follows the doc.
# Usage: balance-panes.ps1 <tab-id> [machine]
param(
  [Parameter(Mandatory = $true)][string]$Tab,
  [string]$Machine = ""
)
$ErrorActionPreference = "Stop"

# hc connect answers only while its stdin is open, so keep it open until the reply with id 1
# arrives. Windows PowerShell writes a BOM ahead of the first line; a throwaway first line
# takes the resulting parse error.
function Invoke-Rpc([hashtable]$Request) {
  $hc = Get-Command herdr-core -ErrorAction SilentlyContinue
  $exe = if ($hc) { $hc.Source } else { Join-Path $env:LOCALAPPDATA "Programs\herdr-core\herdr-core.exe" }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = "connect --json"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $p = [Diagnostics.Process]::Start($psi)
  try {
    $p.StandardInput.WriteLine("")
    $p.StandardInput.WriteLine('{"jsonrpc":"2.0","id":0,"method":"hello","params":{}}')
    $p.StandardInput.WriteLine(($Request | ConvertTo-Json -Depth 100 -Compress))
    $p.StandardInput.Flush()
    while ($null -ne ($line = $p.StandardOutput.ReadLine())) {
      if (-not $line.Trim()) { continue }
      $msg = $line | ConvertFrom-Json
      if ($msg.id -eq 1) { return $msg }
    }
    return $null
  } finally {
    try { $p.StandardInput.Close() } catch {}
    if (-not $p.WaitForExit(3000)) { $p.Kill() }
  }
}

function Set-Even($node) {
  if ($null -ne $node.children) {
    $n = @($node.children).Count
    foreach ($child in $node.children) {
      $child | Add-Member -NotePropertyName size -NotePropertyValue ([pscustomobject]@{ weight = 1.0 / $n }) -Force
      Set-Even $child
    }
  }
}

for ($try = 0; $try -lt 3; $try++) {
  $params = @{ name = "herdr-app" }
  if ($Machine) { $params.on = $Machine }
  $got = Invoke-Rpc @{ jsonrpc = "2.0"; id = 1; method = "doc.get"; params = $params }
  if (-not $got -or -not $got.result) { Write-Error "doc.get failed"; exit 1 }

  $found = $false
  foreach ($space in @($got.result.value.spaces)) {
    foreach ($t in @($space.tabs)) {
      if ($t.id -eq $Tab) { Set-Even $t.root; $found = $true }
    }
  }
  if (-not $found) { Write-Error "tab $Tab not found"; exit 1 }

  $setParams = @{ name = "herdr-app"; version = $got.result.version; value = $got.result.value }
  if ($Machine) { $setParams.on = $Machine }
  $set = Invoke-Rpc @{ jsonrpc = "2.0"; id = 1; method = "doc.set"; params = $setParams }
  if ($set -and $set.result) { exit 0 }
}
exit 1
