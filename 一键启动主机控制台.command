#!/usr/bin/env bash
cd "$(dirname "$0")"
chmod +x ./smac.sh 2>/dev/null || true
./smac.sh web
