import pathlib
import shutil
import threading
import time

import pyte
import winpty
from PIL import Image, ImageDraw, ImageFont

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = PACKAGE / "test-e2e" / "output" / "async-queue-flow"
SESSION_DIR = OUTPUT / "sessions"
WORK_DIR = OUTPUT / "work"
PI = [shutil.which("pi") or "pi"]
COLS = 150
ROWS = 46
MODEL = "gpt-5.4-mini"

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
raw_chunks = []
stop_reader = False


def reset_output():
    if OUTPUT.exists(): shutil.rmtree(OUTPUT)
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic" / "agents").mkdir(parents=True, exist_ok=True)
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic" / "settings.json").write_text('{"agentlessSession":{"tools":["read","write","edit","bash","agents"],"agents":["*"],"skills":[]},"globalMaxSubagentDepth":6}', encoding="utf-8")
    (WORK_DIR / ".pi" / "extensions" / "pi-gentic" / "agents" / "worker.md").write_text("---\nname: worker\ndescription: Performs file-editing validation tasks.\ntools: read,write,edit,bash\nmodel: openai-codex/gpt-5.4-mini\nthinking: high\n---\nUse the requested file tools. Keep the final answer short.", encoding="utf-8")


def reader(proc):
    while not stop_reader:
        try: data = proc.read(4096)
        except Exception: break
        if not data:
            time.sleep(0.02); continue
        raw_chunks.append(data)
        stream.feed(data.encode("utf-8", errors="replace"))


def text(): return "\n".join(screen.display)


def wait_for(label, pred, timeout=120):
    deadline=time.time()+timeout
    while time.time()<deadline:
        if pred(text()): return text()
        time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for {label}\n{text()}")


def color(name):
    return {"default":(229,229,229),"black":(24,24,27),"red":(248,113,113),"green":(74,222,128),"yellow":(250,204,21),"blue":(96,165,250),"magenta":(216,180,254),"cyan":(103,232,249),"white":(229,229,229)}.get(str(name),(229,229,229))


def render_png(name):
    font=ImageFont.truetype("C:/Windows/Fonts/consola.ttf",16); cell_w=9; cell_h=20; margin=8
    image=Image.new("RGB",(COLS*cell_w+margin*2,ROWS*cell_h+margin*2),(9,9,11)); draw=ImageDraw.Draw(image)
    for y,line in enumerate(list(screen.buffer.values())):
        for x,ch in list(line.items()): draw.text((margin+x*cell_w,margin+y*cell_h),ch.data or " ",font=font,fill=color(ch.fg))
    path=OUTPUT/name; image.save(path); (OUTPUT/f"{pathlib.Path(name).stem}.txt").write_text(text(),encoding="utf-8"); return path


def spawn():
    import os
    env=dict(os.environ); env.update({"TERM":"xterm-256color","COLORTERM":"truecolor"})
    proc=winpty.PtyProcess.spawn([*PI,"--session-dir",str(SESSION_DIR)],cwd=str(WORK_DIR),env=env,dimensions=(ROWS,COLS))
    threading.Thread(target=reader,args=(proc,),daemon=True).start(); time.sleep(.5); proc.write("\x1b[?0u\x1b[?1;2c")
    wait_for("pi start",lambda t:"gpt" in t.lower() or "MCP:" in t,30); return proc


def session_id_containing(needle):
    deadline=time.time()+90
    while time.time()<deadline:
        for p in sorted(SESSION_DIR.glob("*.jsonl"), key=lambda x:x.stat().st_mtime, reverse=True):
            s=p.read_text(encoding="utf-8", errors="replace")
            if needle in s and '"parentSession"' in s: return p.stem.split("_")[-1]
        time.sleep(.5)
    raise AssertionError(f"No child session contains {needle}")


def main():
    global stop_reader
    reset_output(); proc=spawn()
    try:
        render_png("01-started-gpt-5-4-mini.png")
        proc.write("/send create .agentfiles/async-queue/queue.txt, then perform 20 cycles; before every edit cycle run bash command sleep 2; after each sleep use the edit tool once to add the next line async-queue-step-01 through async-queue-step-20; do not batch edits, do not use loops, and use only files under this working directory --agent worker --bg --no-invoke\r")
        wait_for("async card", lambda t:"[ASYNC]" in t or "async-queue-step" in t or "Sent a message" in t,60)
        render_png("02-async-card-started.png")
        child=session_id_containing("async-queue-step")
        time.sleep(4); render_png("03-async-card-updating.png")
        proc.write(f"/send append queued-follow-up-marker after the running edit task finishes --session {child} --no-invoke\r")
        wait_for("queued card", lambda t:"Message queued" in t or "Queued message for" in t,90)
        render_png("04-queued-card.png")
        proc.write("/orchestration-tree\r")
        wait_for("queued tree", lambda t:"Orchestration Tree" in t and "worker" in t,60)
        render_png("05-queued-tree.png")
        (OUTPUT/"summary.txt").write_text("\n".join(p.name for p in sorted(OUTPUT.glob('*.png'))), encoding="utf-8")
    finally:
        try: proc.write("/quit\r")
        except Exception: pass
        time.sleep(.5)
        try:
            if proc.isalive(): proc.terminate(force=True)
        except Exception: pass
        stop_reader=True
        (OUTPUT/"terminal.raw.log").write_text("".join(raw_chunks), encoding="utf-8", errors="replace")


if __name__ == "__main__": main()
