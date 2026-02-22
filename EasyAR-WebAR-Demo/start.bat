@echo off
chcp 65001 >nul
echo [EasyAR WebAR] 正在从 config/application.txt 读取配置...

powershell -NoProfile -Command "$cfg = Get-Content -Raw 'config/application.txt' | ConvertFrom-Json; $url = $cfg.cloud.clientEndUrl; if (-not $url) { Write-Host '[错误] application.txt 中未找到 clientEndUrl'; exit 1 }; Set-Content -Path 'html/src/clientConfig.js' -Value ('var CLIENT_END_URL = ''' + $url + ''';') -Encoding UTF8; Write-Host ('[EasyAR WebAR] clientEndUrl =' + $url); Write-Host '[EasyAR WebAR] 已生成 html/src/clientConfig.js'"

if %errorlevel% neq 0 (
    echo [错误] 配置生成失败，请检查 config/application.txt
    pause
    exit /b 1
)

echo [EasyAR WebAR] 启动服务...
EasyAR-WebAR_windows.exe
