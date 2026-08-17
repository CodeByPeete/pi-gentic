export function delegationReceipt(callerAgent: unknown, callerSessionId: unknown, message: string) {
  const agent = callerAgent ? `[${callerAgent}] agent` : "agent";
  return `Message from ${agent} from session ${String(callerSessionId ?? "")}:\n${message}\nComplete the task before answering. Only your final result will be returned.`;
}

export function delegationReturn(agentName: unknown, sessionId: unknown, finalAnswer: string) {
  const agent = agentName ? `[${agentName}] agent` : "agent";
  return `Message from ${agent} from session ${String(sessionId ?? "")}:\n${finalAnswer}`;
}
