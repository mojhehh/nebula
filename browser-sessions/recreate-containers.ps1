# Recreate all 10 KasmVNC browser containers with optimized settings
# System: i9-14900KF (32 threads), 64GB RAM, RTX 5070 12GB
# Allocation per container: 3 CPUs, 4GB RAM, 2GB SHM, GPU shared

$IMAGE = "kasmweb/chrome:1.16.0"
$POLICY_JSON = '{"URLBlocklist":["*://pornhub.com","*://www.pornhub.com","*://*.pornhub.com"]}'
$POLICY_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($POLICY_JSON))

# Quality yaml for KasmVNC (only supported keys in v1.2.0)
$QUALITY_YAML = @"
logging:
  log_writer_name: all
  log_dest: logfile
  level: 30

encoding:
  max_frame_rate: 60
  rect_encoding_mode:
    min_quality: 9
    max_quality: 9
    consider_lossless_quality: 9
    rectangle_compress_threads: 0
  video_encoding_mode:
    jpeg_quality: 9
    webp_quality: 9

network:
  ssl:
    pem_certificate: /home/kasm-user/.vnc/self.pem
    pem_key: /home/kasm-user/.vnc/self.pem
  udp:
    public_ip: 127.0.0.1

runtime_configuration:
  allow_override_standard_vnc_server_settings: true
  allow_override_list:
    - pointer.enabled
"@
$YAML_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($QUALITY_YAML))

# Container configs: name, vncPort, audioPort
$containers = @(
    @{ Name="browser";   VncPort=6901; AudioPort=4901 },
    @{ Name="browser2";  VncPort=6902; AudioPort=4902 },
    @{ Name="browser3";  VncPort=6903; AudioPort=4903 },
    @{ Name="browser4";  VncPort=6904; AudioPort=4904 },
    @{ Name="browser5";  VncPort=6905; AudioPort=4905 },
    @{ Name="browser6";  VncPort=6906; AudioPort=4906 },
    @{ Name="browser7";  VncPort=6907; AudioPort=4907 },
    @{ Name="browser8";  VncPort=6908; AudioPort=4908 },
    @{ Name="browser9";  VncPort=6909; AudioPort=4909 },
    @{ Name="browser10"; VncPort=6910; AudioPort=4910 }
)

foreach ($c in $containers) {
    Write-Host "`n=== Recreating $($c.Name) ===" -ForegroundColor Cyan
    
    # Stop and remove old container
    docker stop $c.Name 2>$null
    docker rm $c.Name 2>$null
    
    # Create with optimized settings
    docker run -d `
        --name $c.Name `
        --restart unless-stopped `
        --cpus=3 `
        --memory=4g `
        --shm-size=2g `
        --gpus all `
        -p "$($c.VncPort):6901" `
        -p "$($c.AudioPort):4901" `
        -e VNC_PW=password `
        -e VNC_RESOLUTION=1920x1080 `
        -e VNC_COL_DEPTH=24 `
        -e "VNCOPTIONS=-DynamicQualityMin=9 -DynamicQualityMax=9 -TreatLossless=9 -JpegVideoQuality=9 -WebpVideoQuality=9 -VideoScaling=0 -VideoArea=65 -CompareFB=0 -DLP_ClipDelay=0" `
        -e MAX_FRAME_RATE=60 `
        -e DISABLE_AUTH=true `
        -e START_PULSEAUDIO=1 `
        -e AUDIO_PORT=4901 `
        -e KASM_RESTRICTED_FILE_CHOOSER=1 `
        -e "LAUNCH_URL=https://www.google.com" `
        -e "CHROME_ARGS=--enable-gpu-rasterization --enable-zero-copy --enable-features=VaapiVideoDecoder,VaapiVideoEncoder,CanvasOopRasterization --ignore-gpu-blocklist --disable-software-rasterizer" `
        $IMAGE
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Created $($c.Name) OK" -ForegroundColor Green
    } else {
        Write-Host "  FAILED to create $($c.Name)" -ForegroundColor Red
    }
}

# Wait for containers to start
Write-Host "`nWaiting 10s for containers to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Deploy Chrome blocklist policy + quality yaml to all containers
Write-Host "`nDeploying Chrome policies and VNC quality config..." -ForegroundColor Yellow
foreach ($c in $containers) {
    docker exec -u root $c.Name bash -c "mkdir -p /etc/opt/chrome/policies/managed && echo $POLICY_B64 | base64 -d > /etc/opt/chrome/policies/managed/blocklist.json && echo $YAML_B64 | base64 -d > /etc/kasmvnc/kasmvnc.yaml && echo $YAML_B64 | base64 -d > /home/kasm-user/.vnc/kasmvnc.yaml && chown kasm-user:kasm-user /home/kasm-user/.vnc/kasmvnc.yaml"
    Write-Host "  Configured $($c.Name)"
}

Write-Host "`nDone! All containers recreated with:" -ForegroundColor Green
Write-Host "  - 3 CPUs, 4GB RAM, 2GB SHM per container"
Write-Host "  - RTX 5070 GPU passthrough (hardware acceleration)"
Write-Host "  - 60fps max frame rate"
Write-Host "  - Quality 9/9 (max)"
Write-Host "  - Google.com as default homepage"
Write-Host "  - pornhub.com blocked"
Write-Host "  - Chrome GPU rasterization + VAAPI decode enabled"
