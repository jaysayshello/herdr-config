# Stores the Claude Admin API key the AI usage panel uses for its "API cost" line, or removes it.
#   powershell -NoProfile -File "$env:USERPROFILE\.config\herdr-app\mods\t3-usage\set-claude-admin-key.ps1"
#   ... set-claude-admin-key.ps1 -Remove
# The key is typed into a hidden prompt and saved encrypted with Windows DPAPI, readable only by
# this Windows user on this computer, in Herdr's data folder (never synced to the repo). The
# collector hands it to `ant` on stdin. Without a key, the panel uses `ant auth login --admin`.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.config\herdr-app\data\t3-usage'
$file = Join-Path $dir 'claude-admin-key.dpapi'
$cache = Join-Path $dir 'claude-api-cost.json'

if ($Remove) {
    Remove-Item -LiteralPath $file, $cache -ErrorAction SilentlyContinue
    'Removed. The panel falls back to `ant auth login --admin`, if you have signed in.'
    exit 0
}

$secure = Read-Host 'Paste the Claude Admin API key (sk-ant-admin01-...)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $looksRight = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -like 'sk-ant-admin*' }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
if (-not $looksRight) {
    'That is not an Admin API key (they start with sk-ant-admin). Nothing was saved.'
    exit 1
}

[void][IO.Directory]::CreateDirectory($dir)
Set-Content -LiteralPath $file -Value ($secure | ConvertFrom-SecureString) -NoNewline
Remove-Item -LiteralPath $cache -ErrorAction SilentlyContinue
'Saved. The AI usage panel uses it on its next refresh (or click its refresh icon).'
