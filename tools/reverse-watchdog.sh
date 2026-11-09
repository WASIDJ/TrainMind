#!/bin/bash
# 反向隧道看门狗:USB 重连后自动重建 tcp:3000(手机 127.0.0.1:3000 → Mac 服务器)
cd "$(dirname "$0")/.."
while true; do
  if adb get-state >/dev/null 2>&1; then
    adb reverse --list 2>/dev/null | grep -q "tcp:3000" || { adb reverse tcp:3000 tcp:3000 >/dev/null 2>&1 && echo "$(date '+%H:%M:%S') 隧道已重建"; }
  fi
  sleep 2
done
