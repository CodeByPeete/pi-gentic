import pathlib
import shutil
import subprocess
import threading
import time

import pyte
import winpty
from PIL import Image, ImageDraw, ImageFont

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = PACKAGE / "test-e2e" / "output" / "send-orchestration-flow"
SESSION_DIR = OUTPUT / "sessions"
WORK_DIR = OUTPUT / "work"
RAW_LOG = OUTPUT / "terminal.raw.log"
PI = shutil.which("pi")
if not PI:
    PI_CLI = r"C:\Users\petro\AppData\Local\pi-managed\node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
    PI = [shutil.which("node") or "node", PI_CLI]
else:
    PI = [PI]
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
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic" / "agents").mkdir(parents=True, exist_ok=True)
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic" / "settings.json").write_text(
        '{"agentlessSession":{"tools":["read","write","edit","bash","agents"],"agents":["*"],"skills":[]},"agentDefaults":{"tools":["read","write","edit","bash","agents"],"agents":["*"],"skills":[]},"globalMaxSubagentDepth":6}',
        encoding="utf-8",
    )
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic" / "agents" / "worker.md").write_text(
        "---\nname: worker\ndescription: Performs file-editing validation tasks.\ntools: read,write,edit,bash\nmodel: openai-codex/gpt-5.4-mini\nthinking: high\n---\nYou are a worker agent. Follow the requested file-editing task directly. Use the requested tools. Keep the final answer short and include the edited file path.",
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
        current = text()
        if predicate(current):
            return current
        time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for {label}\n--- screen ---\n{text()}")


def render_png(name):
    font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 16)
    cell_w = 9
    cell_h = 20
    margin = 8
    image = Image.new("RGB", (COLS * cell_w + margin * 2, ROWS * cell_h + margin * 2), (9, 9, 11))
    draw = ImageDraw.Draw(image)
    for y, line in enumerate(list(screen.buffer.values())):
        for x, char in list(line.items()):
            fg = color(char.fg)
            if char.bold:
                fg = tuple(min(255, c + 35) for c in fg)
            if char.reverse:
                draw.rectangle((margin + x * cell_w, margin + y * cell_h, margin + (x + 1) * cell_w, margin + (y + 1) * cell_h), fill=(39, 39, 42))
            draw.text((margin + x * cell_w, margin + y * cell_h), char.data or " ", font=font, fill=fg)
    path = OUTPUT / name
    image.save(path)
    (OUTPUT / f"{pathlib.Path(name).stem}.txt").write_text(text(), encoding="utf-8")
    return path


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


def spawn():
    env = dict(**__import__("os").environ)
    env.update({
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "PI_TUI_WRITE_LOG": str(OUTPUT / "pi-tui-write.log"),
    })
    args = [*PI, "--session-dir", str(SESSION_DIR)]
    proc = winpty.PtyProcess.spawn(args, cwd=str(WORK_DIR), env=env, dimensions=(ROWS, COLS))
    threading.Thread(target=reader, args=(proc,), daemon=True).start()
    time.sleep(0.5)
    proc.write("\x1b[?0u\x1b[?1;2c")
    wait_for("initial pi terminal", lambda value: "MCP:" in value or "gpt" in value.lower(), timeout=30)
    return proc


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


def run_command(proc, command):
    proc.write(command + "\r")


def newest_session_files():
    return sorted(SESSION_DIR.glob("*.jsonl"), key=lambda item: item.stat().st_mtime, reverse=True)


def assert_session_file_contains(needle):
    for path in newest_session_files():
        content = path.read_text(encoding="utf-8", errors="replace")
        if needle in content:
            return path, content
    raise AssertionError(f"No session file contains {needle!r}")


def newest_child_session_file():
    for path in newest_session_files():
        content = path.read_text(encoding="utf-8", errors="replace")
        if '"parentSession"' in content and '"role":"user"' in content:
            return path, content
    raise AssertionError("No child session file found")


def child_session_file_containing(needle):
    for path in newest_session_files():
        content = path.read_text(encoding="utf-8", errors="replace")
        if needle in content and '"parentSession"' in content:
            return path, content
    raise AssertionError(f"No child session file contains {needle!r}")


def ensure_model(proc):
    if MODEL in text():
        return
    run_command(proc, f"/model {MODEL_FULL}")
    wait_for("gpt-5.4-mini model", lambda value: MODEL in value, timeout=60)


def tree_session_line(needle):
    return next((line for line in reversed(text().splitlines()) if needle in line and ("└─" in line or "├─" in line or "○" in line or "●" in line)), "")


def select_current_tree_row(proc):
    proc.write("\r")
    time.sleep(1.0)


def select_child_tree_row(proc, needle):
    proc.write("\x1b[B")
    wait_for(
        f"tree child selected for {needle}",
        lambda value: any(">" in line and "worker" in line for line in value.splitlines()),
        timeout=15,
    )
    render_png("04b-tree-child-selected.png")
    proc.write("\r")
    time.sleep(1.0)


def select_parent_tree_row(proc):
    proc.write("\x1b[A")
    time.sleep(0.7)
    proc.write("\r")
    time.sleep(1.0)


def main():
    reset_output()
    proc = spawn()
    try:
        ensure_model(proc)
        render_png("01-pi-started-with-gpt-5-4-mini.png")

        sync_prompt = "write a new temporary file and edit it 20 times using the edit tool; name each edit step sync-step-01 through sync-step-20; use only files under this working directory"
        run_command(proc, f"/send {sync_prompt} --agent worker --no-invoke")
        wait_for("sync send running card", lambda value: "sync-step" in value or "Sent message" in value or "Sending message" in value, timeout=60)
        render_png("02-sync-send-card-started.png")
        time.sleep(8)
        render_png("03-sync-send-card-updating.png")

        run_command(proc, "/orchestration-tree")
        wait_for("tree after sync send", lambda value: "Orchestration Tree" in value and ("worker" in value or "sync-step" in value), timeout=60)
        render_png("04-tree-with-running-child.png")
        select_child_tree_row(proc, "sync-step")
        time.sleep(3)
        render_png("05-opened-running-child-session.png")
        try:
            wait_for("child session screen", lambda value: "sync-step" in value and "Orchestration Tree" not in value, timeout=60)
            time.sleep(10)
            render_png("06-child-session-updating.png")
        except TimeoutError as error:
            (OUTPUT / "child-session-screen-failure.txt").write_text(str(error), encoding="utf-8")
            render_png("06-child-session-not-updating.png")

        run_command(proc, "/orchestration-tree")
        wait_for("tree from child", lambda value: "Orchestration Tree" in value, timeout=60)
        render_png("07-tree-from-child-session.png")
        select_parent_tree_row(proc)
        wait_for("parent after sync return", lambda value: MODEL in value and "Orchestration Tree" not in value, timeout=60)
        render_png("08-parent-returned-to-live-card.png")
        returned_parent = text()
        wait_for("parent live card refresh after return", lambda value: value != returned_parent and "Sent a message" in value, timeout=20)
        render_png("09-parent-live-card-refreshed-after-return.png")
        wait_for("parent after sync child answer", lambda value: "Agent answered" in value or "Message from [worker]" in value or "Message from agent" in value, timeout=300)
        render_png("10-parent-after-sync-child-answer.png")
        assert_session_file_contains("sync-step-20")

        async_prompt = "write a new temporary file and edit it 20 times using the edit tool; name each edit step async-step-01 through async-step-20; use only files under this working directory"
        run_command(proc, f"/send {async_prompt} --agent worker --bg --no-invoke")
        wait_for("async send running", lambda value: "[ASYNC]" in value or "async-step" in value or "Sent message" in value, timeout=60)
        render_png("11-async-send-card-started.png")
        time.sleep(8)
        render_png("12-async-send-card-updating.png")
        run_command(proc, "/orchestration-tree")
        wait_for("async tree", lambda value: "Orchestration Tree" in value and ("worker" in value or "async-step" in value), timeout=60)
        render_png("13-tree-with-async-child.png")
        select_current_tree_row(proc)
        wait_for("parent after async tree", lambda value: MODEL in value and "Orchestration Tree" not in value, timeout=60)

        queue_prompt_a = "create .agentfiles/queue-slow/queue.txt, then perform 20 cycles; before every edit cycle run bash command sleep 2; after each sleep use the edit tool once to add the next line queue-step-a-01 through queue-step-a-20; do not batch edits, do not use loops, and use only files under this working directory"
        queue_prompt_b = "after the current queued or running task, append a short queued-follow-up marker to .agentfiles/queue-slow/queue.txt if possible"
        run_command(proc, f"/send {queue_prompt_a} --agent worker --bg --no-invoke")
        wait_for("queue target started", lambda value: "queue-step-a" in value or "Sent a message" in value or "Sent message" in value, timeout=60)
        render_png("14-queue-first-message-running.png")
        child_path, _ = child_session_file_containing("queue-step-a")
        session_id = child_path.stem.split("_")[-1]
        run_command(proc, f"/send {queue_prompt_b} --session {session_id} --no-invoke")
        wait_for("queued send card", lambda value: "Message queued" in value or "Queued message for" in value, timeout=60)
        render_png("15-queued-message-card.png")
        run_command(proc, "/orchestration-tree")
        wait_for("tree with queued session", lambda value: "Orchestration Tree" in value and "worker" in value, timeout=60)
        render_png("16-tree-with-queued-session.png")

        report = [
            "send orchestration flow screenshots:",
            *[str(path.name) for path in sorted(OUTPUT.glob("*.png"))],
        ]
        (OUTPUT / "summary.txt").write_text("\n".join(report), encoding="utf-8")
    finally:
        stop(proc)


if __name__ == "__main__":
    main()
