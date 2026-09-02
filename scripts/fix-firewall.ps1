<#
    Zerleg Chat - firewall repair
    Run this as Administrator (right-click -> Run with PowerShell as admin).

    Why this exists: if you clicked "Cancel" on the Windows firewall prompt,
    Windows does not simply skip it - it writes a persistent *Block* rule. Block
    rules beat Allow rules, so clicking "Allow" afterwards does not help and the
    app stays unable to receive messages. This deletes those blocks and adds the
    allow rule.

    Symptom this fixes: you can see people in the list, but sending shows
    "Could not reach them".
#>

$ErrorActionPreference = 'Stop'

# Must be elevated: firewall rules cannot be changed by a standard user.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ""
    Write-Host "  This needs to run as Administrator." -ForegroundColor Yellow
    Write-Host "  Right-click the file and choose 'Run with PowerShell' as admin," -ForegroundColor Yellow
    Write-Host "  or open an admin PowerShell and run it again." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

$exe = Join-Path $env:LOCALAPPDATA 'Programs\Zerleg Chat\Zerleg Chat.exe'
if (-not (Test-Path $exe)) {
    Write-Host "  Zerleg Chat is not installed at: $exe" -ForegroundColor Red
    Write-Host "  Install it first, then run this again."
    exit 1
}

Write-Host ""
Write-Host "  Zerleg Chat - firewall repair" -ForegroundColor Cyan
Write-Host ""

# 1. Remove every Block rule Windows created for this app.
$blocked = Get-NetFirewallRule -DisplayName '*Zerleg*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Action -eq 'Block' }

if ($blocked) {
    $blocked | Remove-NetFirewallRule
    Write-Host ("  Removed {0} Block rule(s) left behind by the firewall prompt." -f @($blocked).Count)
} else {
    Write-Host "  No Block rules found - nothing to clean up."
}

# 2. Replace any existing allow rule so re-running this stays safe.
Get-NetFirewallRule -DisplayName 'Zerleg Chat' -ErrorAction SilentlyContinue |
    Where-Object { $_.Action -eq 'Allow' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue

# A program rule, not a port rule: the app falls back to a random TCP port when
# its preferred one is taken, so a port-based rule can silently stop working.
New-NetFirewallRule -DisplayName 'Zerleg Chat' -Direction Inbound `
    -Program $exe -Action Allow -Profile Private, Domain | Out-Null

Write-Host "  Allowed Zerleg Chat to receive messages on private/domain networks."
Write-Host ""
Write-Host "  Done. Restart Zerleg Chat and try sending a message." -ForegroundColor Green
Write-Host ""
