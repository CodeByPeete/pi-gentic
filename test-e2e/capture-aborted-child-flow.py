import pathlib
import shutil
import threading
import time

import pyte
import winpty
from PIL import Image, ImageDraw, ImageFont

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = PACKAGE / "test-e2e" / "output" / "aborted-child-flow"
SESSION_DIR = OUTPUT / "sessions"
WORK_DIR = OUTPUT / "work"
RAW_LOG = OUTPUT / "terminal.raw.log"
PI_BIN = shutil.which("pi")
PI = [PI_BIN] if PI_BIN else [shutil.which("node") or "node", r"C:\Users\petro\AppData\Local\pi-managed\node_modules\@earendil-works\pi-coding-agent\dist\cli.js"]
COLS = 150
ROWS = 46
MODEL = "gpt-5.4-mini"
MODEL_FULL = "openai-codex/gpt-5.4-mini"

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
raw_chunks = []
stop_reader = False


def reset_output():
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    agent_dir = WORK_DIR / ".pi" / "extensions" / "pi-gentic"
    (agent_dir / "agents").mkdir(parents=True, exist_ok=True)
    (agent_dir / "settings.json").write_text(
        '{"agentlessSession":{"tools":["read","write","edit","bash","agents"],"agents":["*"],"skills":[]},"agentDefaults":{"tools":["read","write","edit","bash","agents"],"agents":["*"],"skills":[]},"globalMaxSubagentDepth":6}',
        encoding="utf-8",
    )
    (agent_dir / "agents" / "worker.md").write_text(
        "---\nname: worker\ndescription: Performs validation tasks.\ntools: read,write,edit,bash\nmodel: openai-codex/gpt-5.4-mini\nthinking: high\n---\nFollow the requested task directly.",
        encoding="utf-8",
    )


def reader(proc):
    while not stop_reader:
        try:
            data = proc.read(4096)
        except Exception:
            break
        if not data:
            time.sleep(0.02)
            continue
        raw_chunks.append(data)
        stream.feed(data.encode("utf-8", errors="replace"))


def text():
    return "\n".join(screen.display)


def wait_for(label, predicate, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = text()
        if predicate(value):
            return value
        time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for {label}\n--- screen ---\n{text()}")


def color(name):
    if isinstance(name, str) and name.startswith("#") and len(name) == 7:
        return tuple(int(name[i : i + 2], 16) for i in (1, 3, 5))
    return {
        "default": (229, 229, 229),
        "black": (24, 24, 27),
        "red": (248, 113, 113),
        "green": (74, 222, 128),
        "yellow": (250, 204, 21),
        "blue": (96, 165, 250),
        "magenta": (216, 180, 254),
        "cyan": (103, 232, 249),
        "white": (229, 229, 229),
    }.get(str(name), (229, 229, 229))


def render_png(name):
    font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 16)
    cell_w = 9
    cell_h = 20
    margin = 8
    image = Image.new("RGB", (COLS * cell_w + margin * 2, ROWS * cell_h + margin * 2), (9, 9, 11))
    draw = ImageDraw.Draw(image)
    for y, line in enumerate(list(screen.buffer.values())):
        for x, ch in list(line.items()):
            draw.text((margin + x * cell_w, margin + y * cell_h), ch.data or " ", font=font, fill=color(ch.fg))
    path = OUTPUT / name
    image.save(path)
    (OUTPUT / f"{pathlib.Path(name).stem}.txt").write_text(text(), encoding="utf-8")
    return path


def spawn():
    import os
    env = dict(os.environ)
    env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor"})
    proc = winpty.PtyProcess.spawn([*PI, "--session-dir", str(SESSION_DIR)], cwd=str(WORK_DIR), env=env, dimensions=(ROWS, COLS))
    threading.Thread(target=reader, args=(proc,), daemon=True).start()
    time.sleep(0.5)
    proc.write("\x1b[?0u\x1b[?1;2c")
    wait_for("pi start", lambda value: "MCP:" in value or "gpt" in value.lower(), 30)
    return proc


def run_command(proc, command):
    proc.write(command + "\r")


def ensure_model(proc):
    if MODEL in text():
        return
    run_command(proc, f"/model {MODEL_FULL}")
    wait_for("gpt-5.4-mini model", lambda value: MODEL in value, 60)


def select_child_tree_row(proc):
    proc.write("\x1b[B")
    wait_for("child selected", lambda value: any(">" in line and "worker" in line for line in value.splitlines()), 15)
    render_png("04-child-row-selected.png")
    proc.write("\r")
    time.sleep(1)


def select_parent_tree_row(proc):
    proc.write("\x1b[A")
    time.sleep(0.7)
    proc.write("\r")
    time.sleep(1)


def stop(proc):
    global stop_reader
    try:
        proc.write("/quit\r")
    except Exception:
        pass
    time.sleep(0.7)
    try:
        if proc.isalive():
            proc.terminate(force=True)
    except Exception:
        pass
    stop_reader = True
    RAW_LOG.write_text("".join(raw_chunks), encoding="utf-8", errors="replace")


def main():
    reset_output()
    proc = spawn()
    try:
        ensure_model(proc)
        render_png("01-started.png")
        prompt = "run bash command sleep 120, then write abort-should-not-finish to .agentfiles/abort-child/result.txt; use only files under this working directory"
        run_command(proc, f"/send {prompt} --agent worker --no-invoke")
        wait_for("running send card", lambda value: "Sent a message" in value and "worker" in value, 60)
        render_png("02-running-child-card.png")
        run_command(proc, "/orchestration-tree")
        wait_for("tree", lambda value: "Orchestration Tree" in value and "worker" in value, 60)
        render_png("03-tree-with-running-child.png")
        select_child_tree_row(proc)
        wait_for("opened child", lambda value: "sleep 120" in value and "Orchestration Tree" not in value, 60)
        render_png("05-opened-running-child.png")
        proc.write("\x1b")
        wait_for("child abort visible", lambda value: "aborted" in value.lower() or "interrupt" in value.lower(), 60)
        render_png("06-child-aborted.png")
        run_command(proc, "/orchestration-tree")
        wait_for("tree after abort", lambda value: "Orchestration Tree" in value, 60)
        render_png("07-tree-after-child-abort.png")
        select_parent_tree_row(proc)
        wait_for("parent abort result", lambda value: "Agent got aborted" in value or "was aborted while handling your request" in value, 120)
        render_png("08-parent-continued-after-child-abort.png")
        if "Final answer from this session" in text():
            raise AssertionError("Opened session displayed a duplicate final-answer component")
        (OUTPUT / "summary.txt").write_text("\n".join(path.name for path in sorted(OUTPUT.glob("*.png"))), encoding="utf-8")
    finally:
        stop(proc)


if __name__ == "__main__":
    main()
