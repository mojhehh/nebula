# Recreate all Neko containers WITHOUT NEKO_NAT1TO1 env var
# This fixes the 5-minute WebRTC freeze on iPad/remote clients

$image = "ghcr.io/m1k1o/neko/google-chrome:latest"

# Container configs: name, HTTP port, EPR range
$containers = @(
    @{ Name="neko1";  Port=3611; EPR="59000-59049" },
    @{ Name="neko2";  Port=3612; EPR="59050-59099" },
    @{ Name="neko3";  Port=3613; EPR="50160-50179" },
    @{ Name="neko4";  Port=3614; EPR="50180-50199" },
    @{ Name="neko5";  Port=3615; EPR="59200-59249" },
    @{ Name="neko6";  Port=3616; EPR="50060-50079" },
    @{ Name="neko7";  Port=3617; EPR="50200-50219" },
    @{ Name="neko8";  Port=3618; EPR="50100-50119" },
    @{ Name="neko9";  Port=3619; EPR="50120-50139" },
    @{ Name="neko10"; Port=3630; EPR="50140-50159" }
)

foreach ($c in $containers) {
    $name = $c.Name
    $port = $c.Port
    $epr = $c.EPR
    $eprParts = $epr -split '-'
    $eprStart = [int]$eprParts[0]
    $eprEnd = [int]$eprParts[1]

    Write-Host "`n=== Recreating $name (HTTP:$port, EPR:$epr) ===" -ForegroundColor Cyan

    # Stop and remove old container
    Write-Host "Stopping $name..."
    docker stop $name 2>$null
    Write-Host "Removing $name..."
    docker rm $name 2>$null

    # Build UDP port args
    $udpPorts = @()
    for ($p = $eprStart; $p -le $eprEnd; $p++) {
        $udpPorts += "-p"
        $udpPorts += "${p}:${p}/udp"
    }

    # Create new container WITHOUT NEKO_NAT1TO1
    Write-Host "Creating $name..."
    $args = @(
        "run", "-d",
        "--name", $name,
        "--restart", "unless-stopped",
        "--cpus=4",
        "--memory=4g",
        "--shm-size=2g",
        "--gpus", "all",
        "--cap-add=SYS_ADMIN",
        "--security-opt", "seccomp=unconfined",
        "-p", "${port}:8080",
        "-e", "NEKO_ICELITE=false",
        "-e", "NEKO_EPR=$epr",
        "-e", "NEKO_SERVER_BIND=:8080",
        "-e", "NEKO_PLUGINS_ENABLED=true",
        "-e", "NEKO_PLUGINS_DIR=/etc/neko/plugins/"
    ) + $udpPorts + @($image)

    & docker @args

    if ($LASTEXITCODE -eq 0) {
        Write-Host "$name created successfully!" -ForegroundColor Green
    } else {
        Write-Host "FAILED to create $name!" -ForegroundColor Red
        continue
    }

    # Wait for container to start
    Start-Sleep -Seconds 3

    Write-Host "$name done."
}

Write-Host "`n=== All containers recreated ===" -ForegroundColor Green
Write-Host "Next: run deploy-configs.ps1 to push neko.yaml, nebula-ipad.js, etc."
