#!/usr/bin/env bash
# smac 客机端一键安装与连接（macOS 双击入口）
cd "$(dirname "$0")"
bash ./install-guest.sh
echo ""
read -r -p "按回车键关闭窗口..." _
