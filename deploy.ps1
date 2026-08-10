# 部署最新构建产物（main.js/manifest.json/styles.css）到本地 Obsidian vault
param(
  [string]$Vault = "D:\re - 副本"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Vault)) { Write-Error "Vault 不存在：$Vault"; exit 1 }
$pluginDir = Join-Path $Vault ".obsidian\plugins\obsidian-gdrive-syncthing"
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
Copy-Item ".\main.js", ".\manifest.json", ".\styles.css" -Destination $pluginDir -Force
Write-Host "已部署到 $pluginDir（重启 Obsidian 生效）"