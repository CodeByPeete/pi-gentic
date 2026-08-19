import { Tool } from "effect/unstable/ai";
import { AgentsToolParametersSchema, ExistingSessionAgentsToolParametersSchema } from "../domain/agents-tool.js";

export function agentsToolDefinition(canCreateChildSession: boolean) {
  const send = canCreateChildSession
    ? "Send can target a different existing sessionId or create a child when sessionId is omitted."
    : "Send requires a different existing sessionId.";

  return {
    description: `Perform one pi-gentic orchestration action. ${send} Use one action per call. Do not send slash commands, prose wrappers, or shell commands as the action.`,
    promptSnippet:
      "Orchestrate durable pi-gentic agent sessions; reuse a different sessionId when continuing the same work",
    parameters: Tool.getJsonSchemaFromSchema(
      canCreateChildSession ? AgentsToolParametersSchema : ExistingSessionAgentsToolParametersSchema,
    ),
  };
}
