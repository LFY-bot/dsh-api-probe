@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   发布 dsh-api-probe 到 npm
echo ==========================================
echo.
npm publish --access public
echo.
if errorlevel 1 (
  echo 发布失败。若提示 OTP 错误，是因为验证码已过期（每 30 秒一换），
  echo 请重新双击本脚本，并在 "Enter OTP:" 出现后立刻粘贴验证器里当前显示的 6 位码。
) else (
  echo 发布成功！查看：https://www.npmjs.com/package/dsh-api-probe
)
echo.
pause
