import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeStateDiagnostics } from "../application/agents/state.js";
import { loadConfiguration } from "../infrastructure/configuration/agents.js";
import { loadAvailableSkills } from "../infrastructure/configuration/skills.js";
import { piHostDiagnostics } from "../infrastructure/pi/host.js";
import type { PiContext } from "../infrastructure/pi/types.js";
import { readRuntimeDiagnostics } from "../shared/diagnostics.js";

export function reportDiagnostics(pi: ExtensionAPI, ctx: PiContext) {
  const projectTrusted = ctx.isProjectTrusted?.() === true;
  const diagnostics = [...loadConfiguration({ cwd: ctx.cwd, projectTrusted }).diagnostics];

  loadAvailableSkills({ cwd: ctx.cwd, diagnostics, projectTrusted });
  for (const message of piHostDiagnostics()) diagnostics.push({ severity: "error", message });
  for (const message of activeStateDiagnostics()) diagnostics.push({ severity: "warning", message });
  for (const diagnostic of readRuntimeDiagnostics("warning"))
    diagnostics.push({
      severity: diagnostic.severity,
      message: `${diagnostic.scope}: ${diagnostic.message}`,
    });

  for (const diagnostic of diagnostics) {
    const location = diagnostic.path ? ` (${diagnostic.path})` : "";

    pi.events.emit("pi-gentic:diagnostic", diagnostic);
    if (diagnostic.severity === "debug") continue;
    ctx.ui.notify(`pi-gentic: ${diagnostic.message}${location}`, diagnostic.severity === "error" ? "error" : "warning");
  }
}
