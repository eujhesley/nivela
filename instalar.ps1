# Instala o painel Nivela no Premiere Pro (usuario atual).
# Uso: clique direito > Executar com PowerShell, ou: powershell -ExecutionPolicy Bypass -File instalar.ps1
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'com.jhesley.nivela'
$ext = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$dst = Join-Path $ext 'com.jhesley.nivela'

# Extensoes sem assinatura precisam do PlayerDebugMode ligado
foreach ($v in 9..15) {
  $k = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
  Set-ItemProperty -Path $k -Name PlayerDebugMode -Value '1'
}

# Remove versoes anteriores (inclusive a de nome antigo "Nivelador")
foreach ($old in @($dst, (Join-Path $ext 'com.jhesley.nivelador'))) {
  if (Test-Path $old) { Remove-Item $old -Recurse -Force }
}
New-Item -ItemType Directory -Path $ext -Force | Out-Null
Copy-Item $src $dst -Recurse
Write-Host "Instalado em $dst"
Write-Host "Reinicie o Premiere e abra: Janela > Extensoes > Nivela"

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Warning "ffmpeg nao encontrado no PATH. Instale com: winget install Gyan.FFmpeg"
}
