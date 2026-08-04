import type Anthropic from "@anthropic-ai/sdk";

/**
 * A tool the agent loop can call. This is our own shape, not the Anthropic
 * SDK's — `runAgentLoop` translates it into the `input_schema` shape Claude's
 * API expects. Keeping our own shape means the `execute` function (the part
 * that actually does something) lives right next to the schema that
 * describes it, instead of being wired up separately.
 */
export interface Tool {
  /** Must match the name Claude will use when it calls the tool. */
  name: string;
  /** Shown to Claude — this is how it decides *when* to call the tool. */
  description: string;
  /**
   * JSON Schema describing the tool's input. For a tool with no arguments,
   * use `{ type: "object", properties: {}, required: [] }` (see tools.ts).
   */
  inputSchema: Record<string, unknown>;
  /**
   * Runs the tool with Claude-supplied input and returns a string result.
   * Whatever this returns (or throws) gets fed back to Claude as a
   * `tool_result` block — see agent-loop.ts for how errors are handled.
   */
  execute: (input: Record<string, unknown>) => Promise<string> | string;
}

/** A single tool call made during an agent loop run, plus its outcome. */
export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: string;
}

/** Everything `runAgentLoop` needs to run a full tool-use conversation. */
export interface AgentConfig {
  /** A configured Anthropic client — get one from `getModelClient()`. */
  client: Anthropic;
  /** Model ID, e.g. "claude-sonnet-4-5-20250929". */
  model: string;
  /** The system prompt — sets the assistant's role and behavior. */
  systemPrompt: string;
  /** The user's message that starts the conversation. */
  userMessage: string;
  /** Tools available to Claude during this run. */
  tools: Tool[];
  /**
   * Safety valve against infinite loops. If Claude keeps calling tools
   * forever, the loop stops after this many round-trips and returns
   * whatever it has. Defaults to 10 in `runAgentLoop`.
   */
  maxIterations?: number;
}

/** What `runAgentLoop` hands back once it's done. */
export interface AgentLoopResult {
  /** Claude's final text response (empty string if it never produced one). */
  finalResponse: string;
  /** Every tool call made along the way, in order. */
  toolCalls: ToolCallRecord[];
  /** How many request/response round-trips the loop actually took. */
  iterations: number;
}
