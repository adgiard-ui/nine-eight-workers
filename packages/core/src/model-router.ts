import Anthropic from "@anthropic-ai/sdk";

/**
 * Providers this router knows how to build a client for. Currently just
 * Anthropic — see the comment in `getModelClient` for how this extends.
 */
export type ModelProvider = "anthropic";

/**
 * Returns a configured client for the given model provider.
 *
 * Cloudflare Workers don't have Node's `process.env` — secrets arrive as
 * properties on the `env` object passed into your Worker's `fetch` handler.
 * That's true whether the secret came from `.dev.vars` locally or from
 * `wrangler secret put` in production; the Worker can't tell the difference,
 * and neither does this function. So instead of reaching into the
 * environment itself, `getModelClient` takes the API key as a parameter —
 * the Worker reads it from `env.ANTHROPIC_API_KEY` and passes it in.
 *
 * Extensibility: to add another model provider later (Gemini, OpenAI), add
 * a case below that builds and returns that provider's client, and widen
 * `ModelProvider` to include it. Since `AgentConfig.client` in types.ts is
 * currently typed as an Anthropic client, supporting a genuinely different
 * SDK shape would also mean introducing a shared client interface that
 * `agent-loop.ts` codes against instead of the Anthropic type directly.
 */
export function getModelClient(provider: ModelProvider, apiKey: string): Anthropic {
  if (!apiKey) {
    throw new Error(
      `Missing API key for model provider "${provider}". Pass in env.ANTHROPIC_API_KEY from your Worker.`
    );
  }

  switch (provider) {
    case "anthropic":
      return new Anthropic({ apiKey });

    // case "gemini":
    //   return new GeminiClient({ apiKey }); // hypothetical future provider

    // case "openai":
    //   return new OpenAI({ apiKey }); // hypothetical future provider

    default: {
      // Exhaustiveness check: if ModelProvider grows a new member without a
      // matching case above, this line fails to typecheck.
      const _exhaustive: never = provider;
      throw new Error(`Unsupported model provider: ${String(_exhaustive)}`);
    }
  }
}
