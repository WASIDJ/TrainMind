#!/bin/bash
# 7B.3 真机测试启动脚本(含 LLM + 神经网络 TTS 配置)
# 用法:./start-7b3.sh   (替代 npm run start;手机侧不变:adb reverse tcp:3000 tcp:3000)
cd "$(dirname "$0")"
# B1:密钥不进仓库。放在 ~/.trainmind.env(chmod 600),轮换 key 只改那个文件。
ENV_FILE="${TRAINMIND_ENV_FILE:-$HOME/.trainmind.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi
if [ -z "$TRAINMIND_CHAT_API_KEY" ] || [ -z "$TRAINMIND_TTS_KEY" ]; then
  echo "⚠ 缺少 TRAINMIND_CHAT_API_KEY / TRAINMIND_TTS_KEY(应写入 $ENV_FILE)。LLM/TTS 将静默退化为模板话术。" >&2
fi
export TRAINMIND_CHAT_BASE_URL="${TRAINMIND_CHAT_BASE_URL:-https://ai-maas.zen5prod.com/ai-router/v1}"
export TRAINMIND_CHAT_MODEL="${TRAINMIND_CHAT_MODEL:-linksure-deepseek-v4.1-flash}"
export TRAINMIND_CHAT_PROTOCOL="${TRAINMIND_CHAT_PROTOCOL:-openai}"
export TRAINMIND_TTS_URL="${TRAINMIND_TTS_URL:-https://ai-maas.zen5prod.com/ai-router/v1/audio/speech}"
export TRAINMIND_TTS_MODEL="${TRAINMIND_TTS_MODEL:-speech-02-turbo}"
export TRAINMIND_TTS_VOICE="${TRAINMIND_TTS_VOICE:-alloy}"
export TRAINMIND_NARRATION="${TRAINMIND_NARRATION:-1}"  # 教练人格层(D11):LLM 改写指令话术;失效自动回退模板
# 本地 whisper sidecar 需要装了 faster-whisper 的解释器(系统 python3 没有)
export TRAINMIND_PYTHON="${TRAINMIND_PYTHON:-/opt/homebrew/bin/python3}"
exec node src/server.ts "$@"
