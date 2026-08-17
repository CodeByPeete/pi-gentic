import type { UnknownRecord } from "../shared/types.js";

export interface AgentDefinition extends UnknownRecord {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly disabled: boolean;
  readonly agents?: string[];
  readonly tools?: string[];
  readonly skills?: string[];
  readonly model?: string;
  readonly thinking?: string;
  readonly theme?: string;
  readonly systemPromptFiles?: string[];
  readonly maxSubagentDepth?: number;
  readonly agentsTool?: UnknownRecord;
  readonly sourcePath: string;
}

export interface SkillDefinition extends UnknownRecord {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly allowedTools?: string[];
  readonly disableModelInvocation: boolean;
  readonly instructions: string;
}
