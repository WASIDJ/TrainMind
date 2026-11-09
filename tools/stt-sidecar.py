#!/usr/bin/env python3
"""TrainMind 本地语音识别常驻服务(whisper small / int8)。

为什么存在:安卓 Chrome 的网页语音识别需要把音频送到 Google 服务器,
国内网络下会话能启动但永远不返回结果(聋场)。本服务让识别完全发生在
Mac 本地:手机 getUserMedia 录音(纯本地能力)→ USB → 本服务 → 文本。
零外部依赖、零 API key、零网络需求。

协议:
  GET  /health    → {"ready": true}
  POST /transcribe  body=任意音频字节(WAV 优先;PyAV 可解码 webm/mp3 等)
                  → {"text": "...", "provider": "local-whisper", "confidence": 0.0-1.0} 或 422 空结果
                  confidence = exp(按时长加权的 avg_logprob):粗粒度但可比,
                  供前端"低置信先确认"守门用(阈值 0.45,见 index.html)。

启动:由 src/server.ts 自动 spawn(端口 8765,仅监听 127.0.0.1)。
"""
import io
import json
import math
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from faster_whisper import WhisperModel

MODEL = "small"          # 中文命令句足够;模型已缓存在 ~/.cache/huggingface
PORT = 8765
MAX_BYTES = 2 * 1024 * 1024


_INSTANCE = None


def load_model():
    """启动时才加载模型:导入本模块跑单测不该付这份代价(约 20s / 数百 MB)。"""
    global _INSTANCE
    if _INSTANCE is None:
        print(f"[stt-sidecar] loading whisper '{MODEL}' ...", flush=True)
        t0 = time.time()
        _INSTANCE = WhisperModel(MODEL, device="cpu", compute_type="int8")
        print(f"[stt-sidecar] model ready in {time.time()-t0:.0f}s", flush=True)
    return _INSTANCE


def transcribe_payload(model, audio):
    """返回 (text, confidence|None)。

    H6(2026-11-06):按时长加权平均 avg_logprob → exp 映射为 0-1 置信度,
    供前端"低置信先确认"守门用(阈值 0.45,见 public/index.html)。

    C5(2026-11-09):faster-whisper 的 segments 是**生成器**(generate_segments 是
    generator function),遍历一次就空。旧代码先 join 再算 durations,拿到空列表,
    confidence 永远不返回 —— H6 的修复从未生效。这里必须一次 list() 物化,
    之后只读这个列表;不要在列表上再做第二次遍历之外的惰性消费。
    """
    segments, _info = model.transcribe(io.BytesIO(audio), language="zh", beam_size=1, vad_filter=True)
    segments = list(segments)
    text = "".join(s.text for s in segments).strip()
    durations = [max(0.0, s.end - s.start) for s in segments]
    total = sum(durations)
    conf = None
    if total > 0:
        avg_logprob = sum(s.avg_logprob * d for s, d in zip(segments, durations)) / total
        conf = round(float(math.exp(avg_logprob)), 3)
    return text, conf


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ready": True, "model": MODEL})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        size = int(self.headers.get("content-length") or 0)
        if size <= 0 or size > MAX_BYTES:
            return self._send(400, {"error": "bad audio size"})
        audio = self.rfile.read(size)
        if len(audio) < 44:
            return self._send(400, {"error": "audio too short"})
        try:
            t1 = time.time()
            text, conf = transcribe_payload(load_model(), audio)
            print(f"[stt-sidecar] {len(audio)}B {time.time()-t1:.1f}s conf={conf} -> {text!r}", flush=True)
        except Exception as e:  # 解码失败/推理失败都如实返回
            print(f"[stt-sidecar] error: {e}", flush=True)
            return self._send(400, {"error": f"transcribe_failed: {type(e).__name__}"})
        if not text:
            return self._send(422, {"error": "没有听到清晰的语音，请再说一次。"})
        payload = {"text": text, "provider": "local-whisper"}
        if conf is not None:
            payload["confidence"] = conf
        self._send(200, payload)

    def log_message(self, *_args):  # 安静模式:每次请求已自行打印
        pass


if __name__ == "__main__":
    load_model()
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[stt-sidecar] listening on 127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
