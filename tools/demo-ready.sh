#!/bin/bash
# 一条命令把投资人演示准备到位：
#   ① 重新生成演示用户的数据（demo-investor：3 周 6 场、实测 8→12 次、课程 6/12）
#   ② 逐项自检（服务 / LLM / TTS / 本地识别 / 数据）
#   ③ 打开浏览器演示入口
#
# 前提：服务已经在跑（另一个终端执行 ./start-7b3.sh，带 LLM/TTS 配置）。
# 用法：./tools/demo-ready.sh
set -uo pipefail
cd "$(dirname "$0")/.."

USER_ID="${TRAINMIND_DEMO_USER:-demo-investor}"
PORT="${PORT:-3000}"
BASE="http://localhost:$PORT"
fail=0
ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fail=1; }

echo "① 生成演示数据（demo 用户：$USER_ID）"
TRAINMIND_DEMO_USER="$USER_ID" TRAINMIND_APPLY=1 node tools/demo-seed.ts 2>&1 | grep -E "训练场次|课程|备份|已写入" | sed 's/^/  /'

echo "② 自检"
if curl -sf -o /dev/null "$BASE/"; then ok "服务在跑（$BASE）"; else bad "服务没在跑 —— 先在另一个终端执行 ./start-7b3.sh"; fi

progress=$(curl -s "$BASE/api/progress?userId=$USER_ID" 2>/dev/null)
if [ -n "$progress" ]; then
  summary=$(printf '%s' "$progress" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('summary',''))" 2>/dev/null)
  rel=$(printf '%s' "$progress" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('relationship',{});print(f\"{r.get('text','')}|{r.get('streakWeeks',0)}\")" 2>/dev/null)
  prog=$(printf '%s' "$progress" | python3 -c "import sys,json;d=json.load(sys.stdin);p=d.get('program');print(p['status']['text'] if p else '')" 2>/dev/null)
  case "$summary" in *做到*) ok "进步叙事：$summary";; *) bad "进步叙事为空（演示数据没生效？）";; esac
  case "$rel" in *连续*) ok "关系进度：${rel%%|*}";; *) bad "关系进度缺少连续周：$rel";; esac
  case "$prog" in *"第 3 周"*) ok "课程：$prog";; *) printf '  · 课程：%s\n' "${prog:-（无 active 课程）}";; esac
else
  bad "读不到 /api/progress"
fi

settings=$(curl -s "$BASE/api/coach/settings" 2>/dev/null)
case "$settings" in *'"configured":true'*) ok "LLM 已配置（叙事会改写话术）";; *) bad "LLM 未配置 —— 会退化成模板话术，检查 ~/.trainmind.env";; esac

tts=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"text":"演示自检"}' "$BASE/api/voice/tts")
if [ "$tts" = "200" ]; then ok "TTS 可用（神经语音）"; else printf '  · TTS 返回 %s（会退化为浏览器本地合成，不影响演示）\n' "$tts"; fi

if curl -sf -o /dev/null http://127.0.0.1:8765/health; then ok "本地 whisper 识别在线"; else printf '  · whisper sidecar 未就绪（语音输入会走浏览器识别或文字）\n'; fi

# 可选：真跑一遍全部 29 项（会调 LLM/TTS/识别，约 40 秒；测试数据用临时用户，跑完自动清空）
if [ "${TRAINMIND_FULL_VERIFY:-0}" = "1" ]; then
  echo "②b 全功能实测（临时用户，测完自动清场）"
  if verify_out=$(node tools/demo-verify.mjs 2>&1); then
    printf '%s\n' "$verify_out" | grep -E "合计|已清掉" | sed 's/^/  /'
    ok "全功能实测通过"
  else
    printf '%s\n' "$verify_out" | grep -E "FAIL|合计" | sed 's/^/  /'
    bad "全功能实测有失败项（见上面清单）"
  fi
fi

echo "③ 打开演示入口"
echo "  $BASE/?user=$USER_ID"
if command -v open >/dev/null; then open "$BASE/?user=$USER_ID"; fi

if [ "$fail" = "1" ]; then
  echo
  echo "有检查项没过 —— 先按上面的提示修，再跑一次本脚本。"
  exit 1
fi
echo
echo "演示就绪。讲稿见 docs/DEMO-SCRIPT.md（8–10 分钟）。"
