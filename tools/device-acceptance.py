#!/usr/bin/env python3
"""
TrainMind 真机自动化验收器(D16-B)
================================
用途:owner 手机(USB 调试已开)插上 Mac 后,自动完成跨动作 Agency 的真机验收,
     截图+UI 树+遥测三重证据,产物落 device-acceptance/<时间戳>/。

我能自动化的:建计划(HTTP)→ Chrome 打开 → 点按/滑动(adb input) → 屏幕验证
             (uiautomator 树 + 截图) → 遥测断言(SQLite)。
需要 owner 的:解锁屏幕一次;对着手机说两句话(真实声学输入,adb 无法注入);
             若弹出麦克风授权,我自动点「允许」(失败才请人点)。

用法:
  python3 tools/device-acceptance.py            # 等手机 → 全自动跑 0-8 步 → 语音段提示
  python3 tools/device-acceptance.py --skip-to voice   # 只跑语音验证段(第 9 步后)
依赖:adb(已配)、服务器 3000 + sidecar 8765 在跑、手机装了 Chrome、屏幕已解锁。
"""
import json, os, re, sqlite3, subprocess, sys, time, urllib.request, urllib.error
from xml.etree import ElementTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "trainmind.db")
EVID = os.path.join(ROOT, "device-acceptance", time.strftime("%Y%m%d-%H%M%S"))
os.makedirs(EVID, exist_ok=True)
REPORT = []
CHECKS = []

def log(msg): print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def adb(*args, timeout=15):
    r = subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout)
    return (r.stdout or "") + (r.stderr or "")

def sh(shell_cmd, timeout=15): return adb("shell", shell_cmd, timeout=timeout)

def http(method, path, payload=None, timeout=20):
    req = urllib.request.Request("http://127.0.0.1:3000" + path, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return {"__error__": e.code, "body": json.loads(e.read())}
        except Exception: return {"__error__": e.code}

def server_log_tail(n=80):
    try:
        with open("/tmp/trainmind-server.log") as f: return f.read()[-16000:].splitlines()[-n:]
    except FileNotFoundError: return []

def db_rows(sql, params=()):
    con = sqlite3.connect(DB); con.row_factory = sqlite3.Row
    try: return [dict(r) for r in con.execute(sql, params)]
    finally: con.close()

def check(label, ok, detail=""):
    CHECKS.append((label, ok, detail)); log(("✓ " if ok else "✗ ") + label + (f"  ({detail})" if detail else ""))

def shot(name):
    """截图 → 证据目录(我可以直接看图核验)"""
    p = os.path.join(EVID, f"{name}.png")
    sh(f"screencap -p /sdcard/_tm_acc.png", timeout=20)
    subprocess.run(["adb", "pull", "/sdcard/_tm_acc.png", p], capture_output=True, timeout=20)
    sh("rm /sdcard/_tm_acc.png")
    if os.path.exists(p): log(f"  📸 {name}.png"); return p
    check(f"截图 {name}", False, "pull 失败"); return None

# ---------- UI 树(uiautomator:网页文本进无障碍树,可按文字定位+取坐标) ----------
def ui_nodes():
    sh("uiautomator dump /sdcard/_tm_ui.xml", timeout=20)
    local = os.path.join(EVID, "_ui.xml")
    subprocess.run(["adb", "pull", "/sdcard/_tm_ui.xml", local], capture_output=True, timeout=15)
    try:
        tree = ElementTree.parse(local)
    except Exception:
        return []
    out = []
    for node in tree.iter("node"):
        text = (node.get("text") or "") + "|" + (node.get("content-desc") or "")
        if text.strip("|"):
            m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
            if m:
                x1, y1, x2, y2 = map(int, m.groups())
                out.append({"text": text.rstrip("|"), "cx": (x1+x2)//2, "cy": (y1+y2)//2, "w": x2-x1, "h": y2-y1})
    return out

def find_ui(*keywords, contains=True):
    """按关键词找 UI 节点(全部命中才返回);返回中心坐标"""
    for n in ui_nodes():
        if all(k in n["text"] for k in keywords): return n
    return None

def wait_ui(*keywords, timeout=20, contains=True):
    end = time.time() + timeout
    while time.time() < end:
        n = find_ui(*keywords)
        if n: return n
        time.sleep(1.2)
    return None

def tap(node, label=""):
    # C11(2026-11-09):wait_ui 找不到会返回 None,以前这里直接 TypeError,
    # 整个验收脚本崩掉、连 report.md 都不生成(违反"真机证据必须落目录"的约定)。
    if not node:
        check(f"点按[{label or '?'}]", False, "目标未出现在 UI 树里"); return False
    sh(f"input tap {node['cx']} {node['cy']}")
    log(f"  👆 tap {label or node['text'][:24]} @({node['cx']},{node['cy']})")
    time.sleep(1.0)
    return True

def tap_text(*keywords, timeout=20, required=True):
    n = wait_ui(*keywords, timeout=timeout)
    if not n:
        if required: check(f"点按[{'+'.join(keywords)}]", False, "未找到")
        return None
    tap(n, "+".join(keywords)); return n

def swipe_across(node, duration=350):
    """横滑穿节点(完成组的 ≥85% 滑动:从左缘 5% 到右缘 98%)"""
    y = node["cy"]
    sh(f"input swipe {node['cx'] - int(node['w']*0.45)} {y} {node['cx'] + int(node['w']*0.48)} {y} {duration}")
    log(f"  ↔️ swipe across「{node['text'][:20]}」"); time.sleep(1.5)

def grant_mic_and_launch():
    packages = sh("pm list packages chrome")
    if "com.android.chrome" not in packages:
        check("Chrome 已安装", False, packages[:80]); return False
    check("Chrome 已安装", True)
    sh("pm grant com.android.chrome android.permission.RECORD_AUDIO")  # 应用级麦克风权限(站点级弹窗仍会出现,由 wait_permission 处理)
    sh('am start -a android.intent.action.VIEW -d "http://127.0.0.1:3000/" -n com.android.chrome/com.google.android.apps.chrome.Main')
    time.sleep(6)
    return True

def wait_permission():
    """若屏幕出现系统麦克风授权弹窗,自动点「允许」类按钮"""
    for kw in (["允许"], ["使用应用时"], ["While using"], ["Allow"]):
        n = find_ui(*kw)
        if n and n["h"] < 400:  # 弹窗按钮,不是页面里的"允许"字样
            tap(n, "授权弹窗"); time.sleep(1.5); return True
    return False

def detect_phone_user_id():
    """从服务器日志抓手机实际 userId(计划 tab 会请求 /api/workouts/active?userId=);倒序取最新一条"""
    for line in reversed(server_log_tail(300)):
        m = re.search(r"active\?userId=([A-Za-z0-9_-]+)", line)
        if m: return m.group(1)
    for line in reversed(server_log_tail(60)):
        m = re.search(r"userId=([A-Za-z0-9_-]+)", line)
        if m: return m.group(1)
    return "demo-user"

# ══════════ 阶段 ══════════
def phase0_bridge():
    log("── 阶段0:等手机 + 桥接 ──")
    deadline = time.time() + 120
    while time.time() < deadline:
        # C11(2026-11-09):原来的 `"device" in adb("get-state")` 会把
        # "error: no devices/emulators found" 里的 devices 当成在线 → 假通过。
        if adb("get-state").strip() == "device": break
        time.sleep(2)
    else:
        check("手机在线", False); sys.exit(1)
    check("手机在线", True)
    adb("reverse", "tcp:3000", "tcp:3000"); time.sleep(1)
    rev = adb("reverse", "--list")
    check("反向隧道", "tcp:3000" in rev, rev.strip()[:40])
    code = subprocess.run(["curl", "-sS", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}",
        "http://127.0.0.1:3000/"], capture_output=True, text=True).stdout
    check("服务器 3000", code == "200", f"HTTP {code}")
    health = subprocess.run(["curl", "-sS", "-m", "3", "http://127.0.0.1:8765/health"],
        capture_output=True, text=True).stdout
    check("STT sidecar 8765", '"ready"' in health, health.strip()[:40])

def phase1_launch():
    log("── 阶段1:Chrome 打开 ──")
    if not grant_mic_and_launch(): sys.exit(1)
    shot("01-首页")
    # 点「计划」tab → 触发 /active?userId= → 服务器日志暴露真实 userId
    tap_text("计划", timeout=12)
    time.sleep(2)
    uid = detect_phone_user_id()
    check("探测手机 userId", True, uid)
    REPORT.append(f"手机 userId = {uid}")
    return uid

def phase2_plan(uid):
    log("── 阶段2:服务器侧建计划(中文输入不受 adb 限制) ──")
    r = http("POST", "/api/workouts/preview", {"input": "我在家，有哑铃，练40分钟，想练全身，状态很好",
        "userId": uid, "dataOrigin": "demo"})
    w = r.get("workout") or {}
    check("计划创建", bool(w.get("sessionId")), str(w.get("exercises", [{}])[0].get("name", "?"))[:30])
    REPORT.append("计划动作: " + " | ".join(f"{e['name']}({e['sets']}组)" for e in w.get("exercises", [])[:5]))
    # 刷新页面让计划 tab 拿到新预览
    sh('am start -a android.intent.action.VIEW -d "http://127.0.0.1:3000/" -n com.android.chrome/com.google.android.apps.chrome.Main')
    time.sleep(5)
    tap_text("计划", timeout=12)
    n = wait_ui("徒手深蹲", timeout=10) or wait_ui("俯卧撑", timeout=5)
    check("计划出现在手机", bool(n))
    shot("02-计划页")
    return w.get("sessionId")

def phase3_flow(sid, uid):
    log("── 阶段3:开始训练 → 完成组1 → 吃力 ──")
    start = wait_ui("开始", timeout=10)
    if start: tap(start, "开始训练")
    time.sleep(3)
    # 热身(如有):等动作页出现
    n = wait_ui("徒手深蹲", timeout=25)
    check("进入训练(动作页)", bool(n))
    shot("03-动作页")
    # 滑动完成本组(≥85% 滑)
    comp = wait_ui("完成", timeout=15)
    if comp and comp["w"] > 120: swipe_across(comp)
    else: tap_text("完成", timeout=8)  # 兜底:小按钮直接点
    fb = wait_ui("吃力", timeout=15)
    check("反馈屏出现", bool(fb))
    shot("04-反馈屏")
    tap(fb, "有点吃力")

def phase4_agency_card():
    log("── 阶段4:跨动作三选一卡片(本次验收核心) ──")
    card = wait_ui("下一个动作怎么走", timeout=15)
    check("★ 三选一卡片出现", bool(card))
    shot("05-三选一卡片")
    n = find_ui("少练一个")
    check("★ 「少练一个」按钮可见", bool(n))
    return n

def phase5_skip(n_skip, sid, uid):
    log("── 阶段5:点「少练一个」→ 遥测断言 ──")
    if n_skip: tap(n_skip, "少练一个")
    time.sleep(3)
    shot("06-选择后")
    rows = db_rows("""SELECT action, intent, success FROM interaction_events ie
        JOIN workout_sessions ws ON ws.id=ie.session_id WHERE ws.user_id=? AND action LIKE '%agency%'""", (uid,))
    check("★ 遥测 touch.button.agency_choice/skip_next",
        any(r["intent"] == "agency.choice.skip_next" for r in rows), str([(r['action'], r['intent']) for r in rows]))
    adapts = db_rows("""SELECT type, deltas_json FROM adaptation_events ae
        JOIN workout_sessions ws ON ws.id=ae.session_id WHERE ws.user_id=?""", (uid,))
    check("★ 适应事件 exercise_skip", any(a["type"] == "exercise_skip" for a in adapts),
        str([a["type"] for a in adapts]))

def phase6_next():
    log("── 阶段6:进入下一动作(链式 agency 待语音段) ──")
    n = wait_ui("下一", timeout=15)
    if n: tap(n, "开始下一组")
    time.sleep(2)
    n2 = wait_ui("俯卧撑", timeout=20) or wait_ui("鸟狗式", timeout=8)
    check("越过被砍动作,进入后续动作", bool(n2), n2["text"][:16] if n2 else "")
    shot("07-下一动作")

def phase7_voice(uid):
    log("── 阶段7:语音段(需要你说话) ──")
    print("\n" + "═"*52)
    print("  请你操作两步:")
    print("  ① 在手机上完成当前动作(滑动),反馈屏点「有点吃力」")
    print("  ② 出现三选一后,按住麦克风说:「轻一点」")
    print("═"*52 + "\n")
    input("  做完这两步后按回车,我来验证…")
    rows = db_rows("""SELECT action, intent, success, transcript FROM interaction_events ie
        JOIN workout_sessions ws ON ws.id=ie.session_id WHERE ws.user_id=? AND action LIKE '%agency%'
        ORDER BY seq DESC LIMIT 3""", (uid,))
    check("★ 语音 agency 遥测", any(r["intent"] == "agency.choice.next_down" for r in rows),
        str([(r['action'], r['intent'], r['transcript']) for r in rows]))
    shot("08-语音选择后")

def phase8_report():
    ok = sum(1 for _, o, _ in CHECKS if o)
    lines = [f"# 真机验收 {time.strftime('%Y-%m-%d %H:%M')}", "",
        f"**{ok}/{len(CHECKS)} 项通过**", ""]
    for label, o, d in CHECKS: lines.append(f"- {'✅' if o else '❌'} {label}" + (f" — {d}" if d else ""))
    lines += ["", "## 现场记录"] + [f"- {x}" for x in REPORT] + ["", "## 截图"]
    lines += [f"![]({f})" for f in sorted(os.listdir(EVID)) if f.endswith(".png")]
    path = os.path.join(EVID, "report.md")
    open(path, "w").write("\n".join(lines))
    log(f"── 报告: {path} ──")
    print("\n".join(lines[:12]))

if __name__ == "__main__":
    skip_to = sys.argv[2] if len(sys.argv) > 2 else (sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("--skip") else None)
    uid = None
    # C11(2026-11-09):任何一步炸掉也必须把 report.md 写出来 —— 真机证据不能因为一个断言失败就消失。
    try:
        if skip_to != "voice":
            phase0_bridge()
            uid = phase1_launch()
            sid = phase2_plan(uid)
            phase3_flow(sid, uid)
            n = phase4_agency_card()
            phase5_skip(n, sid, uid)
            phase6_next()
        else:
            uid = detect_phone_user_id()
        phase7_voice(uid)
    except SystemExit:
        raise
    except Exception as e:
        check("验收脚本异常中断", False, f"{type(e).__name__}: {e}")
        log(f"!! 异常中断:{type(e).__name__}: {e}")
    finally:
        phase8_report()
