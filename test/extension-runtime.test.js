import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateToolCall } from "@earendil-works/pi-ai";
import piGentic from "../dist/extension.js";
import { reportRuntimeDiagnostic } from "../dist/diagnostics.js";
import { deleteRuntimeSession, loadPiCodingAgentPeer, setRuntimeSession } from "../dist/pi-host.js";

const theme = {
  bold: (text) => text,
  fg: (_name, text) => text,
};

test("extension boundary registers and runs native Pi interfaces", async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-gentic-extension-"));
  const configRoot = path.join(cwd, ".pi", "extensions", "pi-gentic");
  mkdirSync(path.join(configRoot, "agents"), { recursive: true });
  writeFileSync(
    path.join(configRoot, "settings.json"),
    JSON.stringify({
      defaultAgent: "fixture-reviewer",
      sessionMessagingScope: "all",
    }),
  );
  writeFileSync(
    path.join(configRoot, "agents", "fixture-reviewer.md"),
    "---\nname: fixture-reviewer\ndescription: Deterministic extension fixture.\ntools: agents\n---\n",
  );
  const skillRoot = path.join(cwd, ".agents", "skills", "fixture-skill");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Deterministic skill fixture.\n---\nFollow the request.",
  );
  const events = new Map();
  const commands = new Map();
  const renderers = new Map();
  const shortcuts = new Map();
  const tools = [];
  const getAllTools = () => [{ name: "native_tool" }, ...tools];
  let activeTools = ["native_tool"];
  const activeToolWrites = [];
  const notifications = [];
  const messages = [];
  const activeEntries = [];
  let activeLeafId;
  const pi = {
    events: { emit: () => {} },
    getAllTools,
    getActiveTools: () => activeTools,
    getCommands: () => [...commands].map(([name, command]) => ({ name, ...command })),
    getShortcuts: () => [...shortcuts].map(([key, shortcut]) => ({ key, ...shortcut })),
    on: (name, handler) => {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
    registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
    registerTool: (tool) => {
      tools.push(tool);
      activeTools.push(tool.name);
    },
    sendMessage: (message) => messages.push(message),
    sendUserMessage: async (message) => messages.push(message),
    setActiveTools: (selection) => {
      activeTools = selection;
      activeToolWrites.push(selection);
    },
    setModel: async () => {},
    setThinkingLevel: () => {},
  };
  const ctx = {
    cwd,
    mode: "tui",
    getSystemPrompt: () => "Base prompt",
    getSystemPromptOptions: () => ({ skills: [] }),
    abort: () => {
      ctx.aborted = true;
    },
    isIdle: () => true,
    isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      appendCustomEntry: (customType, data) => activeEntries.push({ type: "custom", customType, data }),
      getBranch: () => activeEntries,
      getCwd: () => cwd,
      getEntries: () => activeEntries,
      getSessionDir: () => cwd,
      getSessionFile: () => undefined,
      getSessionId: () => "019fdddd-1111-7111-8111-111111111111",
      getLeafId: () => activeLeafId,
    },
    ui: {
      notify: (...args) => notifications.push(args),
      setTheme: () => {},
      setTitle: () => {},
      setWidget: () => {},
    },
  };

  await piGentic(pi);
  t.after(async () => {
    for (const handler of events.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
  });

  assert.deepEqual([...commands.keys()].sort(), ["agent", "send", "skill"]);
  assert.equal(shortcuts.size, 1);
  assert.equal(tools[0].name, "agents");
  assert.throws(
    () =>
      validateToolCall([tools[0]], {
        id: "missing-action",
        name: "agents",
        arguments: {
          agent: "fixture-reviewer",
          message: "delegate this",
          async: true,
          fork: true,
        },
      }),
    /action/,
  );
  assert.deepEqual(
    validateToolCall([tools[0]], {
      id: "valid-send",
      name: "agents",
      arguments: {
        action: "send",
        agent: "fixture-reviewer",
        message: "delegate this",
        async: true,
        fork: true,
        worktree: true,
      },
    }),
    {
      action: "send",
      agent: "fixture-reviewer",
      message: "delegate this",
      async: true,
      fork: true,
      worktree: true,
    },
  );
  const toolSchema = JSON.stringify(tools[0].parameters);
  assert.match(toolSchema, /copies the caller's completed earlier conversation/);
  assert.match(toolSchema, /current request is replaced by the child's assignment/);
  assert.match(toolSchema, /Source Git repository/);
  assert.match(toolSchema, /automatic branch and path generation/);
  assert.equal(
    typeof renderers.get("pi-gentic:card")(
      { content: "done", details: { kind: "send", status: "done" } },
      { expanded: false },
      theme,
    ).render,
    "function",
  );

  for (const handler of events.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  assert.ok(Array.isArray(commands.get("agent").getArgumentCompletions("")));
  assert.ok((await commands.get("send").getArgumentCompletions("message --a")).length > 0);
  const peer = await loadPiCodingAgentPeer();
  const nativeList = peer.SessionManager.list;
  t.after(() => {
    peer.SessionManager.list = nativeList;
  });
  peer.SessionManager.list = async () => {
    throw new Error("completion list unavailable");
  };
  assert.deepEqual(await commands.get("send").getArgumentCompletions("message --session "), []);
  peer.SessionManager.list = nativeList;
  commands.get("skill").getArgumentCompletions("missing");
  for (const shortcut of shortcuts.values()) await shortcut.handler(ctx);
  const targetSessionId = "019feeee-1111-7111-8111-111111111111";
  const targetEntries = [];
  setRuntimeSession(targetSessionId, {
    session: {
      agent: { state: { messages: [] } },
      isStreaming: false,
      abort: async () => {},
      prompt: async function () {
        this.agent.state.messages.push({
          role: "assistant",
          content: "Target answer",
          stopReason: "stop",
        });
      },
      getAllTools: () => [{ name: "read" }],
      getActiveToolNames: () => ["read"],
      modelRuntime: { getAvailable: () => [] },
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      sessionManager: {
        appendCustomEntry: (customType, data) => targetEntries.push({ type: "custom", customType, data }),
        getEntries: () => targetEntries,
        getSessionFile: () => undefined,
        getSessionId: () => targetSessionId,
      },
      setActiveToolsByName: () => {},
      setModel: async () => {},
      setThinkingLevel: () => {},
    },
  });
  t.after(() => deleteRuntimeSession(targetSessionId));
  await commands.get("agent").handler("", ctx);
  await commands.get("agent").handler(`clear --session ${targetSessionId}`, ctx);
  await commands.get("agent").handler(`fixture-reviewer --session ${targetSessionId}`, ctx);
  await commands.get("agent").handler("clear", ctx);
  await commands.get("agent").handler("missing-agent", ctx);
  await commands.get("skill").handler("", ctx);
  await commands.get("skill").handler("missing-skill request", ctx);
  await commands.get("skill").handler("fixture-skill request", ctx);
  writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ enableSkillCommands: false }));
  await commands.get("skill").handler("fixture-reviewer request", ctx);
  await commands.get("send").handler("", ctx);
  await commands.get("send").handler(`message --session ${targetSessionId}`, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  await commands.get("send").handler("message --session missing", ctx);
  await commands.get("send").handler("message --agent missing-agent", ctx);
  assert.match(notifications.flat().join("\n"), /No active agent|Usage/);

  activeLeafId = "completed-conversation-entry";
  for (const handler of events.get("before_agent_start") ?? []) await handler({ systemPrompt: "Base" }, ctx);
  activeLeafId = "delegation-entry";
  const sendResult = await tools[0].execute(
    "tool-send",
    { action: "send", message: "delegate this", sessionId: targetSessionId, invokeMeLater: false },
    AbortSignal.timeout(1000),
    () => {},
    ctx,
  );
  assert.equal(sendResult.details.call.callerEntryId, "delegation-entry");
  assert.equal(sendResult.details.call.forkBoundaryEntryId, "completed-conversation-entry");
  activeLeafId = undefined;

  const toolResult = await tools[0].execute("tool-call", { action: "list" }, AbortSignal.timeout(1000), () => {}, ctx);
  assert.equal(toolResult.isError, undefined);
  assert.ok(toolResult.content[0].text.length > 0);
  assert.deepEqual(toolResult.details.call, {
    toolCallId: "tool-call",
    parameters: { action: "list" },
  });
  const getResult = await tools[0].execute(
    "tool-get",
    { action: "get", agent: "fixture-reviewer" },
    AbortSignal.timeout(1000),
    () => {},
    ctx,
  );
  assert.match(getResult.content[0].text, /fixture-reviewer/);
  const statusResult = await tools[0].execute(
    "tool-status",
    { action: "status", sessionId: targetSessionId },
    AbortSignal.timeout(1000),
    () => {},
    ctx,
  );
  assert.equal(statusResult.isError, undefined);
  const loadResult = await tools[0].execute(
    "tool-load",
    { action: "load", agent: "clear" },
    AbortSignal.timeout(1000),
    () => {},
    ctx,
  );
  assert.equal(loadResult.isError, undefined);
  const abortResult = await tools[0].execute(
    "tool-abort",
    { action: "abort" },
    AbortSignal.timeout(1000),
    () => {},
    ctx,
  );
  assert.equal(abortResult.isError, undefined);
  assert.equal(ctx.aborted, true);
  const discoverResult = await tools[0].execute(
    "tool-discover",
    { action: "discoverSessions", rx: 0, ry: 0 },
    AbortSignal.timeout(1000),
    () => {},
    ctx,
  );
  assert.equal(discoverResult.isError, undefined, discoverResult.content[0].text);
  await assert.rejects(
    tools[0].execute("tool-error", { action: "status" }, AbortSignal.timeout(1000), () => {}, ctx),
    /sessionId/,
  );

  pi.getAllTools = () => {
    throw new Error("stale tools");
  };
  pi.getCommands = () => {
    throw new Error("stale commands");
  };
  ctx.modelRegistry.getAvailable = () => {
    throw new Error("stale models");
  };
  await commands.get("agent").handler("", ctx);
  pi.getAllTools = getAllTools;
  pi.getCommands = () => [...commands].map(([name, command]) => ({ name, ...command }));
  ctx.modelRegistry.getAvailable = () => [];
  reportRuntimeDiagnostic("extension-test", "warning fixture", "warning");
  pi.setActiveTools = () => {
    throw new Error("policy unavailable");
  };
  for (const handler of events.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
  for (const shortcut of shortcuts.values()) await shortcut.handler(ctx);
  pi.setActiveTools = (selection) => {
    activeTools = selection;
    activeToolWrites.push(selection);
  };

  for (const handler of events.get("agent_start") ?? []) await handler({}, ctx);
  for (const handler of events.get("agent_end") ?? []) await handler({}, ctx);
  await commands.get("agent").handler("fixture-reviewer", ctx);
  activeTools = ["native_tool", "agents"];
  for (const handler of events.get("input") ?? []) await handler({ text: "Validate policy" }, ctx);
  const writesAfterInput = activeToolWrites.length;
  assert.deepEqual(activeTools, ["agents"]);
  for (const handler of events.get("before_agent_start") ?? []) {
    const append = handler({ systemPrompt: "Base" }, ctx);
    assert.ok(append === undefined || typeof append === "object");
  }
  assert.equal(activeToolWrites.length, writesAfterInput);
  assert.deepEqual(activeToolWrites.at(-1), ["agents"]);
  assert.ok(messages.some((message) => message.customType === "pi-gentic:card"));
});
