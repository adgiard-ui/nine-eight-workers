import type Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, AgentLoopResult, ToolCallRecord } from "./types";
import { logger } from "./logger";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Runs a full "agent loop": send a message to Claude, and if it responds
 * with tool calls, execute them, send the results back, and repeat — until
 * Claude gives a plain text answer (no more tool calls) or we hit
 * `maxIterations`.
 *
 * This is the core pattern behind every tool-using Claude integration:
 * Claude can't run code itself, so it asks *us* to run something (a tool
 * call), we run it and hand back the result, and Claude keeps going with
 * that new information in hand.
 */
export async function runAgentLoop(config: AgentConfig): Promise<AgentLoopResult> {
  const {
    client,
    model,
    systemPrompt,
    userMessage,
    tools,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = config;

  // Claude's Messages API wants tool definitions in a specific shape
  // (name/description/input_schema). Our `Tool` type carries an `execute`
  // function too, which Claude never needs to see — so we strip it out here.
  const toolDefinitions: Anthropic.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));

  // The running conversation. We start with just the user's message, and
  // append Claude's replies and our tool results as the loop progresses.
  // The API is stateless, so every request sends the *entire* history.
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  const toolCalls: ToolCallRecord[] = [];
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    // Ask Claude what to do next, given the conversation so far.
    const response = await client.messages.create({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      tools: toolDefinitions,
      messages,
    });

    // Always append Claude's response to history *before* deciding what to
    // do with it — if it contains tool_use blocks, the API requires those
    // blocks to appear in history before the matching tool_result we send
    // back next.
    messages.push({ role: "assistant", content: response.content });

    // stop_reason !== "tool_use" means Claude is done calling tools and has
    // given (or attempted to give) a final answer — extract the text and
    // return.
    if (response.stop_reason !== "tool_use") {
      const finalResponse = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      return { finalResponse, toolCalls, iterations };
    }

    // Claude wants to call one or more tools. It can request several in a
    // single response, and all of their results must be sent back together
    // in a single user message (not one message per tool).
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const tool = tools.find((t) => t.name === toolUse.name);

      if (!tool) {
        // Claude asked for a tool that isn't registered. Don't throw — tell
        // Claude via an error tool_result so it can adjust and try again.
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: no tool named "${toolUse.name}" is registered.`,
          is_error: true,
        });
        continue;
      }

      const input = toolUse.input as Record<string, unknown>;

      try {
        const result = await tool.execute(input);
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
        toolCalls.push({ name: tool.name, input, result });
      } catch (error) {
        // Tool execution failures are handled gracefully, not thrown: we
        // report the failure back to Claude as an error tool_result so it
        // can decide how to recover (retry, try something else, or explain
        // the failure to the user) instead of crashing the whole request.
        const errorMessage = error instanceof Error ? error.message : String(error);
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error executing tool "${tool.name}": ${errorMessage}`,
          is_error: true,
        });
        toolCalls.push({ name: tool.name, input, result: `Error: ${errorMessage}` });
        logger.error("tool_execution_failed", { tool: tool.name, error: errorMessage });
      }
    }

    // Feed all tool results back as a single user turn, then loop again.
    messages.push({ role: "user", content: toolResultBlocks });
  }

  // We ran out of iterations without Claude producing a final text answer.
  // This isn't necessarily an error (some tasks are just long), so we
  // return normally with whatever we collected, rather than throwing.
  logger.warn("agent_loop_max_iterations_reached", { maxIterations, model });

  return {
    finalResponse: "The agent stopped after reaching the maximum number of tool-use iterations without a final answer.",
    toolCalls,
    iterations,
  };
}
