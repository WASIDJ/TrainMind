// C5(2026-11-09):本地 whisper 置信度的回归测试。
//
// 为什么要这个测试:2026-11-06 的 H6 修复只做了 py_compile 就记为"已验证生效",
// 而 faster-whisper 的 segments 是生成器,旧写法先 join 再算 durations,
// 拿到空列表 → confidence 永远不返回 → 前端 0.45 低置信守门仍是死代码。
// 所以这里用"返回生成器的假 model"直接复现当年的形状,而不是只验语法。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sidecarPath = fileURLToPath(new URL("../tools/stt-sidecar.py", import.meta.url));
const pythonCandidates = [process.env.TRAINMIND_PYTHON, "/opt/homebrew/bin/python3", "python3"].filter(Boolean) as string[];
const python = pythonCandidates.find(candidate => spawnSync(candidate, ["-c", "import faster_whisper"], { encoding: "utf8" }).status === 0);

// 驱动脚本:导入 sidecar 模块(不走 __main__,不加载真模型),喂一个"生成器型"假 model。
const driver = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("tm_sidecar", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Seg:
    def __init__(self, text, start, end, logprob):
        self.text, self.start, self.end, self.avg_logprob = text, start, end, logprob

class FakeModel:
    """模仿 faster_whisper:transcribe() 返回 (生成器, info)。"""
    def __init__(self, segments):
        self._segments = segments
    def transcribe(self, *_args, **_kwargs):
        return (segment for segment in self._segments), None

text, conf = module.transcribe_payload(
    FakeModel([Seg("开始", 0.0, 1.0, -0.2), Seg("下一组", 1.0, 3.0, -0.4)]),
    b"\0" * 128,
)
empty_text, empty_conf = module.transcribe_payload(FakeModel([]), b"\0" * 128)
print(json.dumps({"text": text, "conf": conf, "emptyText": empty_text, "emptyConf": empty_conf}))
`;

function runDriver() {
  const result = spawnSync(python!, ["-c", driver, sidecarPath], { encoding: "utf8" });
  assert.equal(result.status, 0, `sidecar 驱动脚本失败: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

test("whisper 置信度:生成器型 segments 也能算出时长加权 confidence", { skip: python ? false : "本机没有可导入 faster_whisper 的 python" }, () => {
  const out = runDriver();
  assert.equal(out.text, "开始下一组");
  assert.equal(typeof out.conf, "number", "confidence 必须是数字(旧代码这里恒为 null)");
  // exp((-0.2*1 + -0.4*2) / 3) = exp(-1/3) ≈ 0.7165
  assert.ok(Math.abs(out.conf - 0.717) < 0.002, `置信度应约为 0.717,实际 ${out.conf}`);
  assert.ok(out.conf > 0 && out.conf <= 1, "置信度必须落在 (0,1]");
});

test("whisper 置信度:静音(无 segment)返回 null,不伪造 0", { skip: python ? false : "本机没有可导入 faster_whisper 的 python" }, () => {
  const out = runDriver();
  assert.equal(out.emptyText, "");
  assert.equal(out.emptyConf, null, "没有时长证据时必须给 null,不能给 0 冒充低置信");
});
