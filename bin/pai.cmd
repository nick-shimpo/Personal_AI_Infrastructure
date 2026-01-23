@echo off
:: PAI Launcher - Displays banner then starts Claude Code
:: Place this file in a directory on your PATH (e.g., %USERPROFILE%\.local\bin\)
bun run "%USERPROFILE%\.claude\skills\CORE\tools\Banner.ts" 2>nul
claude %*
