import type { Tool } from "@nine-eight/core/types";

/**
 * One export per tool. This one takes no input, so its schema is an empty
 * object — Claude still needs to see `{ type: "object", properties: {},
 * required: [] }` even when there's nothing to fill in.
 */
export const getCurrentTimeTool: Tool = {
  name: "get_current_time",
  description: "Returns the current time in ISO 8601 format",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: () => new Date().toISOString(),
};

/**
 * The combined list passed to `runAgentLoop`. To add a new tool: define it
 * above following the same pattern, then add it here.
 */
export const tools: Tool[] = [getCurrentTimeTool];
