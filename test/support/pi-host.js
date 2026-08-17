import assert from "node:assert/strict";
import path from "node:path";
import { installPiHost } from "../../dist/infrastructure/pi/host.js";

export async function installPiHostForTest(state, flag) {
  process.env.PI_CLI = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  await installPiHost();

  assert.equal(state[flag], true);
}

export function createTransitionMode(peer, runtimeHost) {
  const history = [];
  const statuses = [];
  const mode = Object.assign(Object.create(peer.InteractiveMode.prototype), {
    defaultEditor: {},
    editor: {
      text: "",
      addToHistory: (text) => history.push(text),
      getText() {
        return this.text;
      },
      setText(text) {
        this.text = text;
      },
    },
    flushPendingBashComponents() {},
    handleClearCommand: async () => {
      await peer.AgentSessionRuntime.prototype.newSession.call(runtimeHost);
    },
    onInputCallback: undefined,
    runtimeHost,
    showStatus: (message) => statuses.push(message),
    ui: { requestRender() {} },
    updatePendingMessagesDisplay() {},
  });

  return { history, mode, statuses };
}

export async function settlesBeforeNextTurn(promise) {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

export async function waitForCondition(predicate, message, maxTurns = 100) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail(message);
}
