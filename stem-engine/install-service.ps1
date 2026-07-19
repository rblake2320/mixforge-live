# Installs the MixForge stem engine as a Windows service via NSSM.
# Run as Administrator. Same pattern as MemoryWeb-API.
$ErrorActionPreference = "Stop"

$nssm = "D:\tools\nssm\nssm.exe"
$python = "C:\Python312\python.exe"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $appDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

& $nssm install MixForge-StemEngine $python "-m" "uvicorn" "engine:app" "--host" "127.0.0.1" "--port" "9077"
& $nssm set MixForge-StemEngine AppDirectory $appDir
& $nssm set MixForge-StemEngine AppStdout (Join-Path $logDir "stem-engine.log")
& $nssm set MixForge-StemEngine AppStderr (Join-Path $logDir "stem-engine.err.log")
& $nssm set MixForge-StemEngine AppRotateFiles 1
& $nssm set MixForge-StemEngine AppRotateBytes 10485760
& $nssm set MixForge-StemEngine Start SERVICE_AUTO_START
# Uncomment and set to require an API key (do this before exposing via tunnel):
# & $nssm set MixForge-StemEngine AppEnvironmentExtra "STEM_ENGINE_API_KEY=<long-random-value>"

& $nssm start MixForge-StemEngine
Write-Host "Installed. Verify: curl http://127.0.0.1:9077/health"
