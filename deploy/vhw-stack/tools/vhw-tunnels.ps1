<#
  Open SSH tunnels to the VHW web interfaces through the jump host and open each one
  in a browser tab. Runs on a Windows PC (PowerShell 5.1 or 7).

    powershell -ExecutionPolicy Bypass -File .\vhw-tunnels.ps1            # usual set
    powershell -ExecutionPolicy Bypass -File .\vhw-tunnels.ps1 -All       # also old VitalLink + preprod
    powershell -ExecutionPolicy Bypass -File .\vhw-tunnels.ps1 -NoBrowser # tunnels only

  A separate window opens for SSH: type the jump host password there and leave that
  window open. Closing it (or Ctrl+C in it) ends all tunnels.
  A local port that is already in use on this PC is skipped (shown in the list).
#>
param(
  [switch]$All,
  [switch]$NoBrowser,
  [string]$JumpHost = "203.0.113.67",
  [int]$JumpPort = 22,
  [string]$User = "deploy-user"
)

# name, local port, destination host (as seen from the jump host), destination port, url path, in the usual set
$targets = @(
  @{ Name = "Superset (current, .236)";      Local = 8088;  Host = "192.0.2.236"; Port = 8088;  Path = "/";             Usual = $true  }
  @{ Name = "Pipeline page (.236)";          Local = 8090;  Host = "192.0.2.236"; Port = 8090;  Path = "/";             Usual = $true  }
  @{ Name = "Spark status (.236)";           Local = 4041;  Host = "192.0.2.236"; Port = 4041;  Path = "/";             Usual = $false }
  @{ Name = "Superset 5.0 (new, jump host)"; Local = 18088; Host = "192.0.2.132"; Port = 18088; Path = "/";             Usual = $true  }
  @{ Name = "Grafana (jump host)";           Local = 3005;  Host = "127.0.0.1";      Port = 3005;  Path = "/";             Usual = $true  }
  @{ Name = "Prometheus (jump host)";        Local = 9290;  Host = "127.0.0.1";      Port = 9290;  Path = "/";             Usual = $false }
  @{ Name = "Old VitalLink portal";          Local = 9902;  Host = "127.0.0.1";      Port = 9902;  Path = "/";             Usual = $false }
  @{ Name = "Old VitalLink Keycloak";        Local = 8083;  Host = "127.0.0.1";      Port = 8083;  Path = "/admin/";       Usual = $false }
  @{ Name = "Old OpenSRP web";               Local = 9901;  Host = "127.0.0.1";      Port = 9901;  Path = "/";             Usual = $false }
  @{ Name = "OpenHIM console";               Local = 9285;  Host = "127.0.0.1";      Port = 9285;  Path = "/";             Usual = $false }
  @{ Name = "OpenHIM core API (for console)";Local = 8080;  Host = "127.0.0.1";      Port = 8080;  Path = $null;           Usual = $false }
  @{ Name = "DHIS2 dev (jump host)";         Local = 8081;  Host = "127.0.0.1";      Port = 8081;  Path = "/";             Usual = $false }
  @{ Name = "Mailhog";                       Local = 8025;  Host = "127.0.0.1";      Port = 8025;  Path = "/";             Usual = $false }
  @{ Name = "Preprod menu builder";          Local = 18902; Host = "192.0.2.132"; Port = 18902; Path = "/";             Usual = $false }
  @{ Name = "Preprod portal";                Local = 18300; Host = "192.0.2.132"; Port = 18300; Path = "/";             Usual = $false }
  @{ Name = "Preprod Keycloak admin";        Local = 18182; Host = "192.0.2.132"; Port = 18182; Path = "/auth/admin/";  Usual = $false }
)
if (-not $All) { $targets = $targets | Where-Object { $_.Usual } }

function Test-LocalPort([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect("127.0.0.1", $port); $true } catch { $false } finally { $c.Close() }
}

# skip local ports that something on this PC already uses
$use = @()
foreach ($t in $targets) {
  if (Test-LocalPort $t.Local) { Write-Host ("  skip  {0,-32} local port {1} already in use" -f $t.Name, $t.Local) -ForegroundColor Yellow }
  else { $use += $t }
}
if (-not $use) { Write-Host "Nothing to forward."; exit 1 }

$sshArgs = @("-p", $JumpPort, "-N", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes")
foreach ($t in $use) { $sshArgs += @("-L", ("{0}:{1}:{2}" -f $t.Local, $t.Host, $t.Port)) }
$sshArgs += "$User@$JumpHost"

# Full path to ssh.exe. A 32-bit PowerShell does not see System32\OpenSSH (Windows redirects
# it to SysWOW64), but can reach it through Sysnative.
$sshExe = @(
  (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source,
  "$env:windir\Sysnative\OpenSSH\ssh.exe",
  "$env:windir\System32\OpenSSH\ssh.exe",
  "$env:ProgramFiles\Git\usr\bin\ssh.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $sshExe) {
  Write-Host "ssh.exe not found. Install it: Settings > Apps > Optional features > OpenSSH Client." -ForegroundColor Red
  exit 1
}

Write-Host "Opening the tunnel window: type the jump host password there and leave it open." -ForegroundColor Cyan
$ssh = Start-Process -FilePath $sshExe -ArgumentList $sshArgs -PassThru

# wait until the first forwarded port answers (password typed, tunnel up)
$probe = $use[0].Local
$deadline = (Get-Date).AddMinutes(3)
while (-not (Test-LocalPort $probe)) {
  if ($ssh.HasExited) { Write-Host "SSH stopped (wrong password or a port problem). Run the script again." -ForegroundColor Red; exit 1 }
  if ((Get-Date) -gt $deadline) { Write-Host "Tunnel not up after 3 minutes; giving up." -ForegroundColor Red; exit 1 }
  Start-Sleep -Milliseconds 700
}

Write-Host ""
Write-Host "Tunnels are up:" -ForegroundColor Green
foreach ($t in $use) {
  $url = if ($t.Path) { "http://localhost:{0}{1}" -f $t.Local, $t.Path } else { "(no web page)" }
  Write-Host ("  {0,-32} {1}" -f $t.Name, $url)
  if (-not $NoBrowser -and $t.Path) { Start-Process $url; Start-Sleep -Milliseconds 400 }
}
Write-Host ""
Write-Host "Close the SSH window to end all tunnels."
