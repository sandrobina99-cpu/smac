@echo off
chcp 65001 >nul
title smac 客机端一键安装与连接
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-guest.ps1"
