import os
import pathlib
import shutil
import sys
import threading
import time

import pyte
import winpty
from PIL import Image, ImageDraw, ImageFont

PI_HOME = pathlib.Path(__file__).resolve().parents[3]
PACKAGE = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = PACKAGE / "test-e2e" / "output"
SESSION_DIR = OUTPUT / "sessions"
WORK_DIR = OUTPUT / "default-agent-work"
INTERACTIVE_WORK_DIR = OUTPUT / "interactive-work"
LAG_SESSION_SOURCE = PI_HOME / "agent" / "sessions" / "--C--Users-petro-Documents-Bewerbungen--" / "2026-06-11T19-02-42-430Z_019eb810-b1fe-7c14-b1f6-f78fbbfaed52.jsonl"
LAG_SESSION_FILE = OUTPUT / "lag-session-019eb810.jsonl"
RAW_LOG = OUTPUT / "terminal.raw.log"
LAG_TIMING = OUTPUT / "lag-regression-tree-019eb810-timing.txt"
NODE = shutil.which("node") or "node"
PI_CLI = os.environ.get("PI_CLI", r"C:\Users\petro\AppData\Local\pi-managed\node_modules\@earendil-works\pi-coding-agent\dist\cli.js")
COLS = int(os.environ.get("PI_E2E_COLS", "140"))
ROWS = int(os.environ.get("PI_E2E_ROWS", "42"))

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
raw_chunks = []
stop_reader = False


def reset_output():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if SESSION_DIR.exists():
        shutil.rmtree(SESSION_DIR)
    if WORK_DIR.exists():
        shutil.rmtree(WORK_DIR)
    if INTERACTIVE_WORK_DIR.exists():
        shutil.rmtree(INTERACTIVE_WORK_DIR)
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    INTERACTIVE_WORK_DIR.mkdir(parents=True, exist_ok=True)
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic").mkdir(parents=True, exist_ok=True)
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic" / "settings.json").write_text('{"defaultAgent":"reviewer"}', encoding="utf-8")
    if LAG_SESSION_SOURCE.exists():
        shutil.copyfile(LAG_SESSION_SOURCE, LAG_SESSION_FILE)
    for path in OUTPUT.glob("*.png"):
        path.unlink()
    for path in OUTPUT.glob("*.txt"):
        path.unlink()


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


def screen_text():
    return "\n".join(screen.display)


def wait_for(label, predicate, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = screen_text()
        if predicate(text):
            return text
        time.sleep(0.1)
    raise TimeoutError(f"Timed out waiting for {label}\n--- screen ---\n{screen_text()}")


def color(name):
    if isinstance(name, str) and name.startswith("#") and len(name) == 7:
        return tuple(int(name[i : i + 2], 16) for i in (1, 3, 5))
    palette = {
        "default": (229, 229, 229),
        "black": (24, 24, 27),
        "red": (248, 113, 113),
        "green": (74, 222, 128),
        "yellow": (250, 204, 21),
        "blue": (96, 165, 250),
        "magenta": (216, 180, 254),
        "cyan": (103, 232, 249),
        "white": (229, 229, 229),
    }
    return palette.get(str(name), palette["default"])


def render_png(name):
    font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 16)
    cell_w = 9
    cell_h = 20
    margin = 8
    image = Image.new("RGB", (COLS * cell_w + margin * 2, ROWS * cell_h + margin * 2), (9, 9, 11))
    draw = ImageDraw.Draw(image)
    for y, line in enumerate(list(screen.buffer.values())):
        for x, char in line.items():
            text = char.data or " "
            fg = color(char.fg)
            if char.bold:
                fg = tuple(min(255, c + 35) for c in fg)
            if char.reverse:
                draw.rectangle((margin + x * cell_w, margin + y * cell_h, margin + (x + 1) * cell_w, margin + (y + 1) * cell_h), fill=(39, 39, 42))
            draw.text((margin + x * cell_w, margin + y * cell_h), text, font=font, fill=fg)
    path = OUTPUT / name
    image.save(path)
    (OUTPUT / f"{pathlib.Path(name).stem}.txt").write_text(screen_text(), encoding="utf-8")
    return path


def spawn(extra_args=None, cwd=INTERACTIVE_WORK_DIR):
    env = os.environ.copy()
    env.update({
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "PI_TUI_WRITE_LOG": str(OUTPUT / "pi-tui-write.log"),
    })
    args = [NODE, PI_CLI, "--session-dir", str(SESSION_DIR), *(extra_args or [])]
    proc = winpty.PtyProcess.spawn(args, cwd=str(cwd), env=env, dimensions=(ROWS, COLS))
    thread = threading.Thread(target=reader, args=(proc,), daemon=True)
    thread.start()
    time.sleep(0.4)
    proc.write("\x1b[?0u\x1b[?1;2c")
    wait_for("initial editor", lambda text: "MCP:" in text or "gpt" in text.lower(), timeout=20)
    return proc


def stop(proc):
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


def newest_session_file_containing(needle):
    files = sorted(SESSION_DIR.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in files:
        try:
            if needle in path.read_text(encoding="utf-8", errors="replace"):
                return path
        except OSError:
            pass
    raise RuntimeError(f"No session file contains {needle!r}")


def newest_child_session_file_containing(needle):
    files = sorted(SESSION_DIR.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            if needle in text and '"parentSession"' in text:
                return path, text
        except OSError:
            pass
    raise RuntimeError(f"No child session file contains {needle!r}")


def screen_line(needle):
    return next((line for line in screen_text().splitlines() if needle in line), "")


def tree_session_line(needle):
    return next((line for line in reversed(screen_text().splitlines()) if needle in line and ("└─" in line or "├─" in line)), "")


def main():
    global stop_reader, screen, stream
    reset_output()
    proc = spawn()
    try:
        proc.write("/agent researcher\r")
        wait_for("researcher loaded", lambda text: "Loaded researcher" in text and "skills: playwright-cli" in text, timeout=20)
        researcher_card = render_png("loaded-agent-skills-terminal.png")
        proc.write("\x0f")
        wait_for("expanded researcher prompt resources", lambda text: "Available skills" in text and "playwright-cli" in text and "Path:" in text and "<available_skills" not in text, timeout=20)
        researcher_prompt = render_png("expanded-agent-resolved-prompt-terminal.png")

        proc.write("/agent clear\r")
        wait_for("expanded agentless configuration", lambda text: "Available skills" in text and "Path:" in text and "<active-agent" not in text and "<available_skills" not in text, timeout=20)
        clear_prompt = render_png("agentless-clear-configuration-terminal.png")
        proc.write("\x0f")
        time.sleep(0.4)

        proc.write("/agent researcher\r")
        wait_for("researcher reloaded", lambda text: "researcher" in text, timeout=20)

        proc.write("/send hello --agent missing --no-invoke\r")
        wait_for("invalid agent error card", lambda text: "Agent call failed." in text and 'Unknown agent "missing"' in text, timeout=30)
        invalid_agent_error = render_png("invalid-agent-error-card-terminal.png")

        proc.write("/send reply with the exact text no invoke receipt --no-invoke\r")
        wait_for("no invoke returned context", lambda text: "Message from agent from session" in text and "no invoke receipt" in text, timeout=180)
        no_invoke_child, no_invoke_child_text = newest_child_session_file_containing("reply with the exact text no invoke receipt")
        if '"modelId":"gpt-5.4-mini"' not in no_invoke_child_text:
            raise AssertionError(f"Expected agentless child to inherit gpt-5.4-mini, got {no_invoke_child}")
        (OUTPUT / "model-inheritance-check.txt").write_text(f"child_session={no_invoke_child}\nmodel=gpt-5.4-mini\n", encoding="utf-8")
        no_invoke = render_png("send-no-invoke-returned-without-caller-run-terminal.png")

        proc.write("/send escape-abort-receipt use the bash tool to run python -c \"import time; time.sleep(60)\" before replying with escape-abort-receipt --bg --no-invoke\r")
        wait_for("escape abort send running", lambda text: "escape-abort-receipt" in text and "Sent a message" in text, timeout=45)
        proc.write("\x1b")
        wait_for("escape abort stops target", lambda text: "Agent got aborted" in text or "was aborted while handling your request" in text, timeout=60)
        escape_abort = render_png("escape-abort-target-terminal.png")

        proc.write("/send ask one short random question --agent reviewer --bg --no-invoke\r")
        wait_for("reviewer async answer", lambda text: "Agent answered" in text and "reviewer" in text, timeout=180)
        reviewer_card = render_png("send-reviewer-completed-terminal.png")

        proc.write("/orchestration-tree\r")
        wait_for("tree has message title", lambda text: "Orchestration Tree" in text and "reply with the exact text no invoke receipt" in text, timeout=30)
        tree_message = render_png("tree-child-last-message-terminal.png")
        proc.write("\x1b")
        time.sleep(0.4)

        parent_session = newest_session_file_containing("pi-gentic:card")
        stop(proc)

        screen = pyte.Screen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        proc = spawn(["--session", str(parent_session)])
        wait_for("restored session card without inactive timer", lambda text: "reply with the exact text no invoke receipt" in text or "ask one short random question" in text, timeout=30)
        restored_card = render_png("restart-restored-agents-card-no-inactive-terminal.png")

        proc.write("/orchestration-tree\r")
        wait_for("restart tree keeps agent names", lambda text: "Orchestration Tree" in text and "[reviewer]" in text and "reply with the exact text no invoke receipt" in text, timeout=40)
        restart_tree = render_png("restart-tree-persists-agent-names-terminal.png")
        stop(proc)

        if LAG_SESSION_FILE.exists():
            screen = pyte.Screen(COLS, ROWS)
            stream = pyte.ByteStream(screen)
            proc = spawn(["--session", str(LAG_SESSION_FILE)])
            wait_for("lag regression session 019eb810 visible and footer stable", lambda text: "MCP:" in text and ("Bewerbungen" in text or "019eb810" in text), timeout=30)
            time.sleep(2)
            lag_regression_path = render_png("lag-regression-session-019eb810-terminal.png")
            started = time.perf_counter()
            proc.write("/orchestration-tree\r")
            wait_for("lag regression orchestration tree stays within width", lambda text: "Orchestration Tree" in text and "019eb810" in text, timeout=30)
            lag_tree_seconds = time.perf_counter() - started
            LAG_TIMING.write_text(f"tree_open_seconds={lag_tree_seconds:.3f}\n", encoding="utf-8")
            lag_tree_path = render_png("lag-regression-tree-019eb810-terminal.png")
            stop(proc)
        else:
            lag_regression_path = None
            lag_tree_path = None

        screen = pyte.Screen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        proc = spawn()
        proc.write("/send tree-refresh-receipt use the bash tool to run python -c \"import time; time.sleep(10)\" before replying with the exact text tree-refresh-receipt --bg --no-invoke\r")
        time.sleep(1.0)
        proc.write("/orchestration-tree\r")
        wait_for("tree refresh child is initially active", lambda text: "Orchestration Tree" in text and "●" in tree_session_line("tree-refresh-receipt") and "Inactive:" in tree_session_line("tree-refresh-receipt"), timeout=45)
        active_tree_refresh = render_png("tree-refresh-child-active-terminal.png")
        proc.write("\x1b[B")
        wait_for("active tree child selected", lambda text: ">" in tree_session_line("tree-refresh-receipt"), timeout=10)
        proc.write("\r")
        wait_for("running tree child opens", lambda text: "tree-refresh-receipt" in text and "MCP:" in text and "Orchestration Tree" not in text, timeout=30)
        proc.write("/orchestration-tree\r")
        wait_for("tree opens from running child", lambda text: "Orchestration Tree" in text and "tree-refresh-receipt" in text, timeout=30)
        proc.write("\r")
        wait_for("visible final answer appears without reopen", lambda text: "[pi-gentic:return-context]" in text and "Message from agent from session" in text and "tree-refresh-receipt" in text and "was aborted" not in text, timeout=180)
        running_child_returned = render_png("running-child-returned-after-switch-terminal.png")
        parent_session = newest_session_file_containing("pi-gentic:card")
        stop(proc)
        screen = pyte.Screen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        proc = spawn(["--session", str(parent_session)])
        proc.write("/orchestration-tree\r")
        wait_for("tree refresh child becomes inactive", lambda text: "Orchestration Tree" in text and "○" in tree_session_line("tree-refresh-receipt") and "Inactive:" not in tree_session_line("tree-refresh-receipt"), timeout=45)
        inactive_tree_refresh = render_png("tree-refresh-child-inactive-terminal.png")
        proc.write("\x1b[B")
        wait_for("inactive tree child selected", lambda text: ">" in tree_session_line("tree-refresh-receipt"), timeout=10)
        proc.write("\r")
        wait_for("inactive tree child opens without crash", lambda text: "Resumed session" in text and "tree-refresh-receipt" in text and "MCP:" in text and "Orchestration Tree" not in text, timeout=30)
        switched_tree_refresh = render_png("tree-refresh-child-opened-terminal.png")
        stop(proc)

        screen = pyte.Screen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        proc = spawn(cwd=WORK_DIR)
        wait_for("default agent loaded on CLI startup", lambda text: "Loaded reviewer" in text and "reviewer" in text, timeout=30)
        startup_default_agent_path = render_png("startup-default-agent-terminal.png")

        proc.write("\x1b[18~")
        wait_for("F7 cycle shortcut clears active agent", lambda text: "Cleared active agent" in text, timeout=30)
        cycle_clear_path = render_png("agent-cycle-keybind-cleared-terminal.png")

        proc.write("/new\r")
        time.sleep(1)
        wait_for("default agent loaded after new session command", lambda text: "New session started" in text and "Loaded reviewer" in text and "Cleared active agent" not in text, timeout=30)
        new_default_agent_path = render_png("new-session-default-agent-terminal.png")

        RAW_LOG.write_text("".join(raw_chunks), encoding="utf-8", errors="replace")
        paths = [researcher_card, researcher_prompt, clear_prompt, invalid_agent_error, no_invoke, OUTPUT / "model-inheritance-check.txt", reviewer_card, tree_message, restored_card, restart_tree, lag_regression_path, lag_tree_path, LAG_TIMING, active_tree_refresh, running_child_returned, inactive_tree_refresh, switched_tree_refresh, startup_default_agent_path, cycle_clear_path, new_default_agent_path, RAW_LOG]
        for path in filter(None, paths):
            print(path)
    finally:
        stop_reader = True
        stop(proc)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        RAW_LOG.write_text("".join(raw_chunks), encoding="utf-8", errors="replace")
        print(exc, file=sys.stderr)
        raise
