import datetime
import json
import os
import pathlib
import re
import shutil
import sys
import threading
import time

import pyte
from PIL import Image, ImageDraw, ImageFont

if os.name == "nt":
    import winpty
else:
    import pexpect

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = PACKAGE / "test-e2e" / "output"
AGENT_DIR = OUTPUT / "agent"
SESSION_DIR = OUTPUT / "sessions"
WORK_DIR = OUTPUT / "default-agent-work"
INTERACTIVE_WORK_DIR = OUTPUT / "interactive-work"
LAG_SESSION_SOURCE = (
    pathlib.Path(os.environ["PI_E2E_LAG_SESSION"])
    if os.environ.get("PI_E2E_LAG_SESSION")
    else None
)
LAG_SESSION_FILE = OUTPUT / "lag-session-019eb810.jsonl"
RAW_LOG = OUTPUT / "terminal.raw.log"
LAG_TIMING = OUTPUT / "lag-regression-tree-019eb810-timing.txt"
NODE = shutil.which("node") or "node"
PI_CLI = os.environ.get(
    "PI_CLI",
    str(PACKAGE / "node_modules" / "@earendil-works" / "pi-coding-agent" / "dist" / "cli.js"),
)
COLS = int(os.environ.get("PI_E2E_COLS", "140"))
ROWS = int(os.environ.get("PI_E2E_ROWS", "42"))


class TerminalScreen(pyte.Screen):
    def report_device_status(self, mode, private=False):
        super().report_device_status(mode)


screen = TerminalScreen(COLS, ROWS)
stream = pyte.ByteStream(screen)
raw_chunks = []
stop_reader = False


def write_test_agents(root):
    agents_dir = root / ".pi" / "extensions" / "pi-gentic" / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    for name, skills in {
        "researcher": "html, playwright-cli, report",
        "reviewer": "report",
    }.items():
        (agents_dir / f"{name}.md").write_text(
            "---\n"
            f"name: {name}\n"
            f"description: Deterministic {name} agent for terminal validation.\n"
            "model: openai-codex/gpt-5.6-luna\n"
            "thinking: high\n"
            f"skills: {skills}\n"
            "---\n",
            encoding="utf-8",
        )


def reset_terminal():
    global raw_chunks, screen, stop_reader, stream
    screen = TerminalScreen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    raw_chunks = []
    stop_reader = False


def reset_output(clear_artifacts=True):
    reset_terminal()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if AGENT_DIR.exists():
        shutil.rmtree(AGENT_DIR)
    if SESSION_DIR.exists():
        shutil.rmtree(SESSION_DIR)
    if WORK_DIR.exists():
        shutil.rmtree(WORK_DIR)
    if INTERACTIVE_WORK_DIR.exists():
        shutil.rmtree(INTERACTIVE_WORK_DIR)
    AGENT_DIR.mkdir(parents=True, exist_ok=True)
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    INTERACTIVE_WORK_DIR.mkdir(parents=True, exist_ok=True)
    LAG_SESSION_FILE.unlink(missing_ok=True)
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic").mkdir(parents=True, exist_ok=True)
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic" / "settings.json").write_text('{"defaultAgent":"reviewer"}', encoding="utf-8")
    write_test_agents(WORK_DIR)
    write_test_agents(INTERACTIVE_WORK_DIR)
    if LAG_SESSION_SOURCE is not None and LAG_SESSION_SOURCE.exists():
        shutil.copyfile(LAG_SESSION_SOURCE, LAG_SESSION_FILE)
    if clear_artifacts:
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
    font_candidates = [
        os.environ.get("PI_E2E_FONT"),
        "C:/Windows/Fonts/consola.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    font_path = next(
        (path for path in font_candidates if path and pathlib.Path(path).exists()),
        None,
    )
    font = ImageFont.truetype(font_path, 16) if font_path else ImageFont.load_default()
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
        "PI_CODING_AGENT_DIR": str(AGENT_DIR),
        "PI_TUI_WRITE_LOG": str(OUTPUT / "pi-tui-write.log"),
    })
    extension = os.environ.get(
        "PI_E2E_EXTENSION",
        str(PACKAGE / "dist" / "extension.js"),
    )
    extension_args = ["--no-extensions", "--extension", extension]
    args = [
        NODE,
        PI_CLI,
        "--approve",
        "--offline",
        "--session-dir",
        str(SESSION_DIR),
        *extension_args,
        *(extra_args or []),
    ]
    if os.name == "nt":
        proc = winpty.PtyProcess.spawn(
            args,
            cwd=str(cwd),
            env=env,
            dimensions=(ROWS, COLS),
        )
    else:
        proc = pexpect.spawn(
            args[0],
            args[1:],
            cwd=str(cwd),
            env=env,
            dimensions=(ROWS, COLS),
            encoding="utf-8",
            codec_errors="replace",
        )
    thread = threading.Thread(target=reader, args=(proc,), daemon=True)
    thread.start()
    time.sleep(0.4)
    proc.write("\x1b[?0u\x1b[?1;2c")
    wait_for("initial editor", lambda text: "[Extensions]" in text and "extension.js" in text, timeout=20)
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


def completed_card_state(needle):
    files = sorted(SESSION_DIR.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in files:
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                entry = json.loads(line)
                if entry.get("customType") != "pi-gentic:card-state":
                    continue
                state = entry.get("data", {})
                if needle in str(state.get("message", "")) and state.get("status") == "done":
                    return state
        except (OSError, json.JSONDecodeError):
            pass
    return None


def child_session_has_assistant_text(needle):
    for path in SESSION_DIR.glob("*.jsonl"):
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                entry = json.loads(line)
                message = entry.get("message", {})
                if message.get("role") == "assistant" and needle in json.dumps(message):
                    return True
        except (OSError, json.JSONDecodeError):
            pass
    return False


def latest_model_id(session_text):
    matches = re.findall(r'"modelId":"([^"]+)"', session_text)
    if not matches:
        raise RuntimeError("No model_change entry found")
    return matches[-1]


def parent_session_file(child_session_file):
    header = json.loads(child_session_file.read_text(encoding="utf-8", errors="replace").splitlines()[0])
    parent = header.get("parentSession")
    if not parent:
        raise RuntimeError(f"Session {child_session_file} has no parentSession")
    return pathlib.Path(parent)


def canonical_completion_entries(session_text, receipt):
    matches = []
    for line in session_text.splitlines():
        entry = json.loads(line)
        if entry.get("type") == "custom_message":
            content = entry.get("content", "")
        elif entry.get("type") == "message" and entry.get("message", {}).get("role") == "user":
            content = "".join(part.get("text", "") for part in entry["message"].get("content", []) if part.get("type") == "text")
        else:
            continue
        if content.startswith("Message from") and receipt in content:
            matches.append(entry)
    return matches


def screen_line(needle):
    return next((line for line in screen_text().splitlines() if needle in line), "")


def session_line(needle):
    return next((line for line in reversed(screen_text().splitlines()) if needle in line), "")


def session_selected(needle):
    return session_line(needle).lstrip().startswith((">", "›"))


def tree_session_line(needle):
    return next((line for line in reversed(screen_text().splitlines()) if needle in line and ("└─" in line or "├─" in line)), "")


def tree_session_selected(needle):
    return tree_session_line(needle).lstrip().startswith((">", "›"))


def write_resume_session(session_id, message, agent_name, timestamp, parent=None, name=None):
    session_file = SESSION_DIR / f"{timestamp.replace(':', '-')}_{session_id}.jsonl"
    entries = [
        {
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": timestamp,
            "cwd": str(INTERACTIVE_WORK_DIR),
            **({"parentSession": str(parent)} if parent else {}),
        },
        *([{
            "type": "session_info",
            "id": f"name-{session_id}",
            "parentId": None,
            "timestamp": timestamp,
            "name": name,
        }] if name else []),
        {
            "type": "message",
            "id": f"message-{session_id}",
            "parentId": None,
            "timestamp": timestamp,
            "message": {"role": "user", "content": message, "timestamp": int(time.time() * 1000)},
        },
        {
            "type": "custom",
            "id": f"agent-{session_id}",
            "parentId": f"message-{session_id}",
            "timestamp": timestamp,
            "customType": "pi-gentic:state",
            "data": {"agentName": agent_name},
        },
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")
    return session_file


def capture_unified_resume():
    reset_output()
    parent = write_resume_session(
        "019f1111-aaaa-7000-8000-000000000001",
        "Plan unified session navigation",
        "orchestrator",
        "2026-07-13T20:00:00.000Z",
        name="Named orchestration plan",
    )
    write_resume_session(
        "019f2222-bbbb-7000-8000-000000000002",
        "Implement native resume integration",
        "builder",
        "2026-07-13T20:02:00.000Z",
        parent,
    )
    write_resume_session(
        "019f3333-cccc-7000-8000-000000000003",
        "Verify original resume controls",
        "reviewer",
        "2026-07-13T20:03:00.000Z",
        parent,
        name="Named verification session",
    )
    proc = spawn(["--no-extensions"])
    try:
        proc.write("/resume\r")
        wait_for("unified resume", lambda text: "Resume Session" in text and "[builder]" in text and "[reviewer]" in text, timeout=30)
        screenshot = render_png("unified-resume-terminal.png")
        print(screenshot)

        proc.write("builder")
        wait_for("agent search", lambda text: "[builder]" in text and "[reviewer]" not in text, timeout=20)
        search_screenshot = render_png("unified-resume-search-terminal.png")
        print(search_screenshot)

        proc.write("\x1b")
        time.sleep(0.5)
        proc.write("/resume\r")
        wait_for("resume reopened", lambda text: "Resume Session (Current Folder)" in text, timeout=20)
        proc.write("\t")
        wait_for("all scope", lambda text: "Resume Session (All)" in text and "[builder]" in text, timeout=30)
        all_screenshot = render_png("unified-resume-all-terminal.png")
        print(all_screenshot)

        proc.write("\x1b")
        time.sleep(0.8)
        proc.write('/send resume-live-session use the bash tool to run python -c "import time; time.sleep(30)" before replying FINAL-resume-live-session --agent researcher --model openai-codex/gpt-5.6-luna --bg --no-invoke\r')
        wait_for("live child started", lambda text: "resume-live-session" in text and "Sent a message" in text, timeout=45)
        initial_inactivity = re.search(r"Inactive:\s+(\d+)s", screen_line("Inactive:"))
        if not initial_inactivity or int(initial_inactivity.group(1)) > 5:
            raise AssertionError(
                f"New child card started with stale inactivity: {screen_line('Inactive:')!r}"
            )
        proc.write("/resume\r")
        wait_for(
            "live unified resume",
            lambda text: "Resume Session" in text and "[researcher]" in text and "Inactive:" in tree_session_line("resume-live-session"),
            timeout=60,
        )
        live_screenshot = render_png("unified-resume-live-terminal.png")
        print(live_screenshot)

        proc.write("\x1b[B\r")
        wait_for(
            "opened live child",
            lambda text: "resume-live-session" in text and "Resume Session" not in text,
            timeout=30,
        )
        opened_screenshot = render_png("unified-resume-opened-live-terminal.png")
        print(opened_screenshot)

        wait_for(
            "opened child receives later live tool activity",
            lambda text: "resume-live-session" in text and "$ python" in text,
            timeout=90,
        )
        activity_screenshot = render_png(
            "unified-resume-opened-live-activity-terminal.png"
        )
        print(activity_screenshot)

        time.sleep(2.2)
        proc.write("/resume\r")
        wait_for(
            "resume keeps the live inactivity timestamp",
            lambda text: "Resume Session" in text
            and "Inactive:" in tree_session_line("resume-live-session"),
            timeout=30,
        )
        preserved_line = tree_session_line("resume-live-session")
        preserved_inactivity = re.search(r"Inactive:\s+(\d+)s", preserved_line)
        if not preserved_inactivity or int(preserved_inactivity.group(1)) < 1:
            raise AssertionError(
                f"Opening resume reset live session activity: {preserved_line!r}"
            )
        preserved_screenshot = render_png(
            "unified-resume-live-timer-preserved-terminal.png"
        )
        print(preserved_screenshot)

        proc.write("\r")
        wait_for(
            "reopened live child after timer check",
            lambda text: "resume-live-session" in text and "Resume Session" not in text,
            timeout=30,
        )
        wait_for(
            "opened child settles with its final answer",
            lambda _text: child_session_has_assistant_text(
                "FINAL-resume-live-session"
            ),
            timeout=120,
        )
        completed_screenshot = render_png(
            "unified-resume-opened-live-completed-terminal.png"
        )
        print(completed_screenshot)
    finally:
        stop(proc)


def capture_scroll_safe_live_panel():
    reset_output()
    proc = spawn()
    try:
        token = "scroll-safe-live-panel"
        proc.write(
            f'/send {token} use the bash tool to run python -c "import time; time.sleep(8)" before replying {token}-done --agent researcher --model openai-codex/gpt-5.6-luna --bg --no-invoke\r'
        )
        wait_for(
            "compact live panel",
            lambda text: token in text
            and "[ASYNC]" in text
            and "idle" in text
            and "total" in text,
            timeout=60,
        )
        before = screen_line("[ASYNC]")
        running = render_png("scroll-safe-live-panel-running-terminal.png")
        raw_start = len(raw_chunks)
        time.sleep(2.2)
        after = screen_line("[ASYNC]")
        timer_output = "".join(raw_chunks[raw_start:])
        total_before = re.search(r"total\s+(\d+)s", before)
        total_after = re.search(r"total\s+(\d+)s", after)

        if (
            not total_before
            or not total_after
            or int(total_after.group(1)) <= int(total_before.group(1))
        ):
            raise AssertionError(
                f"Compact live panel timer did not update autonomously: {before!r} -> {after!r}"
            )
        if "\x1b[3J" in timer_output:
            raise AssertionError("Live panel timer update cleared terminal scrollback")

        updated = render_png("scroll-safe-live-panel-updated-terminal.png")
        wait_for(
            "stable completion card",
            lambda text: "Agent answered." in text and f"{token}-done" in text,
            timeout=120,
        )
        completed = render_png("scroll-safe-live-panel-completed-terminal.png")
        evidence = OUTPUT / "scroll-safe-live-panel-check.txt"
        evidence.write_text(
            f"before={before}\nafter={after}\nclear_scrollback=false\n",
            encoding="utf-8",
        )

        for path in [running, updated, completed, evidence]:
            print(path)
    finally:
        stop(proc)


def capture_completed_card_answer():
    session_id = "019f8c5c-0000-7000-8000-000000000001"
    child_id = "019f8c5c-0000-7000-8000-000000000002"
    request = "Task: This request belongs only to the running card."
    answer = "The completed card now shows the agent answer in its body."
    reset_output()
    details = {
        "kind": "send",
        "status": "done",
        "cardId": f"send:{child_id}:1784768000000",
        "async": True,
        "agentName": "builder",
        "sessionId": child_id,
        "message": request,
        "answer": answer,
        "startedAt": 1784767990000,
        "updatedAt": 1784768000000,
        "completedAt": 1784768000000,
        "activities": [{"type": "tool", "name": "write", "summary": "result.json", "status": "done"}],
        "call": {
            "toolCallId": "tool-call-fixture",
            "callerEntryId": "entry-fixture",
            "parameters": {
                "action": "send",
                "agent": "builder",
                "message": request,
                "async": True,
                "fork": False,
                "cwd": str(INTERACTIVE_WORK_DIR),
                "worktree": "task-branch",
                "repo": str(INTERACTIVE_WORK_DIR),
                "invokeMeLater": False,
                "overrides": {"thinking": "high"},
            },
        },
    }
    fixture = SESSION_DIR / f"2026-07-23T00-00-00-000Z_{session_id}.jsonl"
    entries = [
        {"type": "session", "version": 3, "id": session_id, "timestamp": "2026-07-23T00:00:00.000Z", "cwd": str(INTERACTIVE_WORK_DIR)},
        {"type": "custom", "customType": "pi-gentic:card-state", "data": details, "id": "fixture-state", "parentId": None, "timestamp": "2026-07-23T00:00:02.000Z"},
        {"type": "custom_message", "customType": "pi-gentic:card", "content": f"Message from [builder] agent from session {child_id}:\n{answer}", "display": True, "details": details, "id": "fixture-card", "parentId": "fixture-state", "timestamp": "2026-07-23T00:00:03.000Z"},
    ]
    fixture.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")
    proc = spawn(["--session", str(fixture)])
    try:
        text = wait_for("completed card answer", lambda value: "Agent answered." in value and answer in value, timeout=30)
        if request in text:
            raise AssertionError("Completed card body displayed the request instead of the answer")
        proc.write("\x0f")
        expanded = wait_for(
            "completed card call properties",
            lambda value: "Call properties" in value
            and "toolCallId: tool-call-fixture" in value
            and "worktree: task-branch" in value,
            timeout=10,
        )
        if "callerEntryId: entry-fixture" not in expanded or "repo:" not in expanded:
            raise AssertionError("Expanded historical card omitted exact agent call properties")
        screenshot = render_png("completed-card-answer-terminal.png")
        evidence = OUTPUT / "completed-card-answer-check.txt"
        evidence.write_text(
            "answer_in_card=true\nrequest_in_collapsed_card=false\nexact_call_properties=true\n",
            encoding="utf-8",
        )
        print(screenshot)
        print(evidence)
    finally:
        stop(proc)


def capture_resume_1000_sessions():
    reset_output(clear_artifacts=False)
    start = datetime.datetime(2026, 7, 23, tzinfo=datetime.timezone.utc)
    fixtures = {}
    for index in range(1000):
        session_id = f"019f{index:04x}-aaaa-7000-8000-{index:012x}"
        timestamp = start + datetime.timedelta(seconds=index)
        filename_timestamp = timestamp.strftime("%Y-%m-%dT%H-%M-%S-000Z")
        fixture = SESSION_DIR / f"{filename_timestamp}_{session_id}.jsonl"
        child_session = index == 999
        header = {
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
            "cwd": str(INTERACTIVE_WORK_DIR / "child-worktree") if child_session else str(INTERACTIVE_WORK_DIR),
        }
        if child_session:
            header["parentSession"] = str(fixtures[998])
        entries = [
            header,
            {"type": "message", "message": {"role": "user", "content": f"Fixture session {index}"}},
        ]
        if index % 25 == 0 or index >= 998:
            entries.append(
                {
                    "type": "custom",
                    "customType": "fixture-history",
                    "data": {"payload": "history-" + ("x" * 262144)},
                }
            )
        fixture.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")
        fixtures[index] = fixture
    (INTERACTIVE_WORK_DIR / "child-worktree").mkdir(parents=True, exist_ok=True)

    proc = spawn()
    try:
        wait_for("Pi startup", lambda text: "[Extensions]" in text and "extension.js" in text, timeout=10)
        started_at = time.monotonic()
        proc.write("/resume\r")
        wait_for(
            "1000-session resume first render",
            lambda text: "Resume Session" in text and "019f03e7" in text,
            timeout=10,
        )
        first_render_ms = round((time.monotonic() - started_at) * 1000, 1)
        loading_text = screen_text()
        loading_screenshot = render_png(
            "resume-1000-sessions-loading-terminal.png"
            if "Loading session details" in loading_text
            else "resume-1000-sessions-cached-terminal.png"
        )
        cache_dir = AGENT_DIR / "pi-gentic" / "runtime" / "resume-cache"

        def hydrated_cache_ready():
            for cache_file in cache_dir.glob("*.json"):
                try:
                    sessions = json.loads(cache_file.read_text(encoding="utf-8")).get("sessions", [])
                except (OSError, json.JSONDecodeError):
                    continue
                messages = {session.get("firstMessage") for session in sessions}
                if {"Fixture session 998", "Fixture session 999"} <= messages:
                    return True
            return False

        wait_for("1000-session resume enrichment", lambda _text: hydrated_cache_ready(), timeout=30)
        enriched_ms = round((time.monotonic() - started_at) * 1000, 1)
        if first_render_ms >= 1000:
            raise AssertionError(f"1000-session resume first render took {first_render_ms}ms")
        stop(proc)
        reset_terminal()
        proc = spawn()
        proc.write("/resume\r")
        wait_for(
            "hydrated resume reopen",
            lambda text: "Fixture session 999" in text and "Fixture session 998" in text,
            timeout=10,
        )
        if not tree_session_line("Fixture session 999"):
            raise AssertionError("The large-session child was not nested under its parent")

        fresh_id = "019f0400-aaaa-7000-8000-000000000400"
        fresh_timestamp = start + datetime.timedelta(seconds=1000)
        fresh_file = SESSION_DIR / f"{fresh_timestamp.strftime('%Y-%m-%dT%H-%M-%S-000Z')}_{fresh_id}.jsonl"
        fresh_file.write_text(
            "\n".join(
                json.dumps(entry)
                for entry in [
                    {"type": "session", "version": 3, "id": fresh_id, "timestamp": fresh_timestamp.isoformat().replace("+00:00", "Z"), "cwd": str(INTERACTIVE_WORK_DIR)},
                    {"type": "message", "message": {"role": "user", "content": "Fresh session during runtime"}},
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        fresh_started_at = time.monotonic()
        stop(proc)
        reset_terminal()
        proc = spawn()
        proc.write("/resume\r")
        wait_for(
            "fresh session after restart",
            lambda text: "Fresh session during runtime" in text
            and "Fixture session 999" in text
            and "Fixture session 998" in text,
            timeout=20,
        )
        fresh_session_ms = round((time.monotonic() - fresh_started_at) * 1000, 1)
        if fresh_session_ms >= 20000:
            raise AssertionError(f"Fresh session appeared after {fresh_session_ms}ms")

        reopen_ms = []
        target_ready_ms = []
        switch_ms = []
        proc.write('"Fixture session 999"')
        wait_for("large child search", lambda text: session_selected("Fixture session 999"), timeout=5)
        proc.write("\r")
        wait_for(
            "large child opens",
            lambda text: "Resume Session" not in text and "Resumed session" in text and "child-worktree" in text,
            timeout=10,
        )
        targets = [("Fixture session 998", "parent"), ("Fixture session 999", "child")] * 5
        for attempt, (target, label) in enumerate(targets, start=1):
            reopened_at = time.monotonic()
            proc.write("/resume\r")
            wait_for(
                f"resume from {label} cycle {attempt}",
                lambda text: "Resume Session" in text,
                timeout=5,
            )
            reopen_elapsed = round((time.monotonic() - reopened_at) * 1000, 1)
            reopen_ms.append(reopen_elapsed)
            proc.write(f'"{target}"')
            wait_for(
                f"find {target} cycle {attempt}",
                lambda _text: session_selected(target),
                timeout=5,
            )
            target_elapsed = round((time.monotonic() - reopened_at) * 1000, 1)
            target_ready_ms.append(target_elapsed)
            switched_at = time.monotonic()
            proc.write("\r")
            wait_for(
                f"switch to {label} cycle {attempt}",
                lambda text: "Resume Session" not in text
                and "Resumed session" in text
                and (("child-worktree" in text) if label == "child" else ("child-worktree" not in text)),
                timeout=10,
            )
            switch_elapsed = round((time.monotonic() - switched_at) * 1000, 1)
            switch_ms.append(switch_elapsed)
            if reopen_elapsed >= 2000:
                raise AssertionError(f"Resume first render cycle {attempt} took {reopen_elapsed}ms")
            if target_elapsed >= 2000:
                raise AssertionError(f"Resume target cycle {attempt} took {target_elapsed}ms")
            if switch_elapsed >= 2000:
                raise AssertionError(f"Session switch {attempt} took {switch_elapsed}ms")

        proc.write("/resume\r")
        wait_for(
            "final child resume tree",
            lambda text: "Resume Session" in text and "Fixture session 999" in text,
            timeout=5,
        )
        screenshot = render_png("resume-1000-sessions-terminal.png")
        evidence = OUTPUT / "resume-1000-sessions-check.txt"
        evidence.write_text(
            "\n".join(
                [
                    "session_count=1001",
                    "nested_child=true",
                    "switch_cycles=10",
                    f"first_render_ms={first_render_ms}",
                    f"enriched_ms={enriched_ms}",
                    f"fresh_session_ms={fresh_session_ms}",
                    f"resume_cycle_ms={','.join(map(str, reopen_ms))}",
                    f"resume_cycle_max_ms={max(reopen_ms)}",
                    f"target_ready_cycle_ms={','.join(map(str, target_ready_ms))}",
                    f"target_ready_cycle_max_ms={max(target_ready_ms)}",
                    f"switch_cycle_ms={','.join(map(str, switch_ms))}",
                    f"switch_cycle_max_ms={max(switch_ms)}",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        print(loading_screenshot)
        print(screenshot)
        print(evidence)
    finally:
        stop(proc)


def capture_completion_deduplication():
    receipt = "completion-deduplication-receipt"
    request = f"reply with the exact text {receipt}"
    reset_output()
    proc = spawn()
    try:
        proc.write("/agent researcher\r")
        wait_for("researcher loaded", lambda text: "Loaded researcher" in text, timeout=30)
        proc.write(f"/send {request} --model openai-codex/gpt-5.6-luna --no-invoke\r")
        wait_for("single completion card", lambda text: "Agent answered." in text and receipt in text, timeout=180)
        child, _ = newest_child_session_file_containing(receipt)
        parent = parent_session_file(child)
        entries = canonical_completion_entries(parent.read_text(encoding="utf-8", errors="replace"), receipt)
        if len(entries) != 1 or entries[0].get("customType") != "pi-gentic:card":
            raise AssertionError(f"Expected one canonical completion context entry in {parent}, got {entries}")
        if entries[0].get("details", {}).get("answer") != receipt:
            raise AssertionError(f"Expected the terminal card state to contain the raw answer, got {entries[0]}")
        if request in screen_text():
            raise AssertionError("Completed card body displayed the request instead of the answer")
        screenshot = render_png("completion-deduplication-terminal.png")
        evidence = OUTPUT / "completion-deduplication-check.txt"
        evidence.write_text(f"parent={parent}\ncompletion_entries=1\ncustom_type=pi-gentic:card\nanswer_in_card=true\n", encoding="utf-8")
        print(screenshot)
        print(evidence)
    finally:
        stop(proc)


def capture_abort_after_session_switch():
    token = "stale-context-abort"
    reset_output()
    proc = spawn()
    try:
        proc.write("/agent researcher\r")
        wait_for("researcher loaded", lambda text: "Loaded researcher" in text, timeout=30)
        proc.write(
            f'/send {token} use the bash tool to run python -c "import time; time.sleep(60)" before replying {token}-done --model openai-codex/gpt-5.6-luna --bg --no-invoke\r'
        )
        wait_for(
            "async child starts",
            lambda text: token in text and "[ASYNC]" in text,
            timeout=60,
        )
        proc.write("/resume\r")
        wait_for(
            "running child appears in resume",
            lambda text: "Resume Session" in text and token in text,
            timeout=30,
        )
        proc.write("\x1b[B")
        wait_for(
            "running child selected",
            lambda _text: tree_session_selected(token),
            timeout=10,
        )
        proc.write("\r")
        wait_for(
            "running child opens",
            lambda text: token in text and "Resume Session" not in text,
            timeout=30,
        )
        proc.write("\x1b")
        wait_for(
            "switched child abort settles",
            lambda text: "Operation aborted" in text
            or "Agent got aborted" in text
            or "was aborted while handling your request" in text,
            timeout=60,
        )
        proc.write("/agent\r")
        wait_for(
            "CLI remains interactive after abort",
            lambda text: "Active agent: researcher" in text
            or "No active agent." in text,
            timeout=30,
        )
        if not proc.isalive():
            raise AssertionError("Pi exited after aborting the switched async child")

        screenshot = render_png("stale-context-abort-survives-terminal.png")
        evidence = OUTPUT / "stale-context-abort-check.txt"
        evidence.write_text(
            "child_opened=true\nchild_aborted=true\ncli_alive=true\n",
            encoding="utf-8",
        )
        RAW_LOG.write_text("".join(raw_chunks), encoding="utf-8", errors="replace")
        for path in [screenshot, evidence, RAW_LOG]:
            print(path)
    finally:
        stop(proc)


def main():
    global stop_reader, screen, stream
    if "--deterministic" in sys.argv:
        capture_completed_card_answer()
        if os.environ.get("RUNNER_OS") != "Linux":
            capture_resume_1000_sessions()
        return
    if os.environ.get("PI_E2E_ABORT_ONLY") == "1":
        capture_abort_after_session_switch()
        return
    if os.environ.get("PI_E2E_CARD_ONLY") == "1":
        capture_completed_card_answer()
        return
    if os.environ.get("PI_E2E_COMPLETION_ONLY") == "1":
        capture_completion_deduplication()
        return
    if os.environ.get("PI_E2E_RESUME_ONLY") == "1":
        capture_unified_resume()
        return
    if os.environ.get("PI_E2E_REFRESH_ONLY") == "1":
        capture_scroll_safe_live_panel()
        return
    reset_output()
    proc = spawn()
    try:
        proc.write("/agent researcher\r")
        wait_for("researcher loaded", lambda text: "Loaded researcher" in text and "skills:" in text and "playwright-cli" in text, timeout=20)
        researcher_card = render_png("loaded-agent-skills-terminal.png")
        proc.write("\x0f")
        wait_for(
            "expanded researcher prompt resources",
            lambda text: "Available agents" in text
            and "</pi-gentic-context>" in text
            and "<available_skills" not in text,
            timeout=20,
        )
        researcher_prompt = render_png("expanded-agent-resolved-prompt-terminal.png")
        proc.write("\x0f")
        wait_for(
            "researcher prompt collapse",
            lambda text: "Ctrl+O to expand" in text,
            timeout=20,
        )

        proc.write("/agent clear\r")
        wait_for(
            "agent cleared",
            lambda text: "Cleared active agent" in text,
            timeout=20,
        )
        proc.write("\x0f")
        wait_for(
            "expanded agentless configuration",
            lambda text: "Available agents" in text
            and "</pi-gentic-context>" in text
            and "<active-agent" not in text
            and "<available_skills" not in text,
            timeout=20,
        )
        clear_prompt = render_png("agentless-clear-configuration-terminal.png")
        proc.write("\x0f")
        time.sleep(0.4)

        proc.write("/agent researcher\r")
        wait_for("researcher reloaded", lambda text: "researcher" in text, timeout=20)

        proc.write("/send hello --agent missing --no-invoke\r")
        wait_for("invalid agent error card", lambda text: "Agent call failed." in text and 'Unknown agent "missing"' in text, timeout=30)
        invalid_agent_error = render_png("invalid-agent-error-card-terminal.png")

        proc.write("/send reply with the exact text no invoke receipt --model openai-codex/gpt-5.6-luna --no-invoke\r")
        wait_for("single no-invoke completion card", lambda text: "Agent answered." in text and "no invoke receipt" in text, timeout=180)
        no_invoke_child, no_invoke_child_text = newest_child_session_file_containing("reply with the exact text no invoke receipt")
        parent_session = parent_session_file(no_invoke_child)
        parent_text = parent_session.read_text(encoding="utf-8", errors="replace")
        completion_entries = canonical_completion_entries(parent_text, "no invoke receipt")
        if len(completion_entries) != 1 or completion_entries[0].get("customType") != "pi-gentic:card":
            raise AssertionError(f"Expected one canonical completion context entry in {parent_session}, got {completion_entries}")
        parent_model_id = latest_model_id(parent_text)
        child_model_id = latest_model_id(no_invoke_child_text)
        if child_model_id != parent_model_id:
            raise AssertionError(f"Expected agentless child to inherit {parent_model_id}, got {child_model_id} in {no_invoke_child}")
        (OUTPUT / "model-inheritance-check.txt").write_text(f"child_session={no_invoke_child}\nmodel={child_model_id}\n", encoding="utf-8")
        no_invoke = render_png("send-no-invoke-returned-without-caller-run-terminal.png")

        existing_session_id = json.loads(no_invoke_child_text.splitlines()[0])["id"]
        proc.write(f"/send existing-session-live-activity use the bash tool to run python -c \"import time; time.sleep(10)\" before replying with existing-session-live-activity --session {existing_session_id} --model openai-codex/gpt-5.6-luna --bg --no-invoke\r")
        wait_for(
            "existing session card shows tool activity",
            lambda text: "existing-session-live-activity" in text
            and "[bash]" in text
            and "(done)" in text,
            timeout=90,
        )
        existing_session_activity = render_png("existing-session-live-activity-terminal.png")
        wait_for("existing session activity completes", lambda text: "Agent answered." in text and "existing-session-live-activity" in text, timeout=180)

        proc.write("/send escape-abort-receipt use the bash tool to run python -c \"import time; time.sleep(60)\" before replying with escape-abort-receipt --model openai-codex/gpt-5.6-luna --bg --no-invoke\r")
        wait_for(
            "escape abort send running",
            lambda text: "[ASYNC]" in text and "[bash] (running)" in text,
            timeout=45,
        )
        proc.write("\x1b")
        wait_for("escape abort stops target", lambda text: "Agent got aborted" in text or "was aborted while handling your request" in text, timeout=60)
        escape_abort = render_png("escape-abort-target-terminal.png")

        proc.write("/send ask one short random question --agent reviewer --model openai-codex/gpt-5.6-luna --bg --no-invoke\r")
        wait_for(
            "reviewer async answer",
            lambda text: "Agent answered" in text
            and completed_card_state("ask one short random question") is not None,
            timeout=180,
        )
        reviewer_state = completed_card_state("ask one short random question")
        reviewer_answer = str(reviewer_state.get("answer", "")).strip()
        if not reviewer_answer:
            raise AssertionError("The reviewer completion card has no answer")
        reviewer_card = render_png("send-reviewer-completed-terminal.png")

        proc.write("/resume\r")
        wait_for("tree has message title", lambda text: "Resume Session" in text and "existing-session-live-activity" in text, timeout=30)
        tree_message = render_png("tree-child-last-message-terminal.png")
        proc.write("\x1b")
        time.sleep(0.4)

        parent_session = newest_session_file_containing("pi-gentic:card")
        parent_entries = [json.loads(line) for line in parent_session.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
        card_states = [entry["data"] for entry in parent_entries if entry.get("type") == "custom" and entry.get("customType") == "pi-gentic:card-state"]
        if not any(state.get("status") == "done" and state.get("completedAt", 0) > state.get("startedAt", 0) for state in card_states):
            raise AssertionError(f"No completed persisted card state with a positive duration in {parent_session}")
        persisted_card_state = OUTPUT / "persisted-card-state-check.txt"
        persisted_card_state.write_text(json.dumps(card_states, indent=2), encoding="utf-8")
        stop(proc)

        screen = TerminalScreen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        proc = spawn(["--session", str(parent_session)])
        restored_answer_fragment = reviewer_answer.splitlines()[0][:30]
        restored_text = wait_for(
            "restored completed session card",
            lambda text: "Agent answered." in text
            and restored_answer_fragment in text,
            timeout=30,
        )
        if "Inactive:" in restored_text:
            raise AssertionError("Restored completed agents card still shows an inactivity timer")
        restored_card = render_png("restart-restored-agents-card-no-inactive-terminal.png")

        proc.write("/resume\r")
        wait_for("restart tree keeps agent names", lambda text: "Resume Session" in text and "[reviewer]" in text and "existing-session-live-activity" in text, timeout=40)
        restart_tree = render_png("restart-tree-persists-agent-names-terminal.png")
        stop(proc)

        if LAG_SESSION_FILE.exists():
            screen = TerminalScreen(COLS, ROWS)
            stream = pyte.ByteStream(screen)
            proc = spawn(["--session", str(LAG_SESSION_FILE)])
            wait_for("lag regression session 019eb810 visible and footer stable", lambda text: "Bewerbungen" in text or "019eb810" in text, timeout=30)
            time.sleep(2)
            lag_regression_path = render_png("lag-regression-session-019eb810-terminal.png")
            started = time.perf_counter()
            proc.write("/resume\r")
            wait_for("lag regression orchestration tree stays within width", lambda text: "Resume Session" in text and "019eb810" in text, timeout=30)
            lag_tree_seconds = time.perf_counter() - started
            LAG_TIMING.write_text(f"tree_open_seconds={lag_tree_seconds:.3f}\n", encoding="utf-8")
            lag_tree_path = render_png("lag-regression-tree-019eb810-terminal.png")
            stop(proc)
        else:
            lag_regression_path = None
            lag_tree_path = None

        screen = TerminalScreen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        proc = spawn()
        proc.write("/send tree-refresh-receipt This deliberately long prompt should keep only its first two wrapped lines visible while recent activities fill the remaining collapsed card rows. Use the bash tool to run python -c \"import time; time.sleep(10)\" before replying with the exact text tree-refresh-receipt --model openai-codex/gpt-5.6-luna --bg --no-invoke\r")
        wait_for(
            "agents card timer starts",
            lambda text: "[ASYNC]" in text and "[bash] (running)" in text and "total" in text,
            timeout=45,
        )
        timer_before = screen_line("idle")
        total_before = screen_line("total")
        time.sleep(2.2)
        timer_after = screen_line("idle")
        total_after = screen_line("total")
        if total_before == total_after:
            raise AssertionError(
                f"Agents card total timer did not repaint without input: {total_before!r} -> {total_after!r}"
            )
        timer_check = OUTPUT / "autonomous-timer-check.txt"
        timer_check.write_text(
            f"inactive_before={timer_before}\ninactive_after={timer_after}\ntotal_before={total_before}\ntotal_after={total_after}\n",
            encoding="utf-8",
        )
        wait_for(
            "live agents panel shows recent activity",
            lambda text: "[bash] (running)" in text and "idle" in text,
            timeout=45,
        )
        autonomous_timer_card = render_png("agents-card-autonomous-timer-terminal.png")
        proc.write("/resume\r")
        wait_for("tree refresh child is initially active", lambda text: "Resume Session" in text and "●" in tree_session_line("tree-refresh-receipt") and "Inactive:" in tree_session_line("tree-refresh-receipt"), timeout=45)
        active_tree_refresh = render_png("tree-refresh-child-active-terminal.png")
        proc.write("\x1b[B")
        wait_for("active tree child selected", lambda text: tree_session_selected("tree-refresh-receipt"), timeout=10)
        proc.write("\r")
        wait_for("running tree child opens", lambda text: "tree-refresh-receipt" in text and "Resume Session" not in text, timeout=30)
        proc.write("/resume\r")
        wait_for("tree opens from running child", lambda text: "Resume Session" in text and "tree-refresh-receipt" in text, timeout=30)
        proc.write("\r")
        wait_for("visible final answer appears once without reopen", lambda text: "Agent answered." in text and "tree-refresh-receipt" in text and "was aborted" not in text, timeout=180)
        running_child_returned = render_png("running-child-returned-after-switch-terminal.png")
        parent_session = newest_session_file_containing("pi-gentic:card")
        stop(proc)
        screen = TerminalScreen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        proc = spawn(["--session", str(parent_session)])
        proc.write("/resume\r")
        wait_for("tree refresh child becomes inactive", lambda text: "Resume Session" in text and "○" in tree_session_line("tree-refresh-receipt") and "Inactive:" not in tree_session_line("tree-refresh-receipt"), timeout=45)
        inactive_tree_refresh = render_png("tree-refresh-child-inactive-terminal.png")
        proc.write("\x1b[B")
        wait_for("inactive tree child selected", lambda text: tree_session_selected("tree-refresh-receipt"), timeout=10)
        proc.write("\r")
        wait_for("inactive tree child opens without crash", lambda text: "Resumed session" in text and "tree-refresh-receipt" in text and "Resume Session" not in text, timeout=30)
        switched_tree_refresh = render_png("tree-refresh-child-opened-terminal.png")
        stop(proc)

        screen = TerminalScreen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        proc = spawn(cwd=WORK_DIR)
        wait_for("default agent loaded on CLI startup", lambda text: "Loaded reviewer" in text and "reviewer" in text, timeout=30)
        startup_default_agent_path = render_png("startup-default-agent-terminal.png")

        proc.write("\x1b[18~")
        wait_for("F7 cycle shortcut clears active agent", lambda text: "Cleared active agent" in text, timeout=30)
        cycle_clear_path = render_png("agent-cycle-keybind-cleared-terminal.png")

        proc.write("/new\r")
        time.sleep(1)
        wait_for("default agent loaded after new session command", lambda text: "New session started" in text and "reviewer" in text and "Cleared active agent" not in text, timeout=30)
        new_default_agent_path = render_png("new-session-default-agent-terminal.png")

        RAW_LOG.write_text("".join(raw_chunks), encoding="utf-8", errors="replace")
        paths = [researcher_card, researcher_prompt, clear_prompt, invalid_agent_error, no_invoke, existing_session_activity, OUTPUT / "model-inheritance-check.txt", reviewer_card, tree_message, persisted_card_state, restored_card, restart_tree, lag_regression_path, lag_tree_path, LAG_TIMING, timer_check, autonomous_timer_card, active_tree_refresh, running_child_returned, inactive_tree_refresh, switched_tree_refresh, startup_default_agent_path, cycle_clear_path, new_default_agent_path, RAW_LOG]
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
