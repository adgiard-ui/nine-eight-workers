import type { Tool } from "@nine-eight/core/types";

/**
 * One export per tool. This one takes no input, so its schema is an empty
 * object — Claude still needs to see `{ type: "object", properties: {},
 * required: [] }` even when there's nothing to fill in.
 *
 * Copied verbatim from hello-agent/src/tools.ts.
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
 * Open-Meteo's forecast API reports sky conditions as a numeric WMO weather
 * code (e.g. 0, 61, 95) rather than text. This is the standard WMO code
 * table, trimmed to the codes Open-Meteo actually returns. Anything not in
 * this table falls back to a generic "weather code N" string rather than
 * failing the whole tool call.
 */
const WMO_WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snow fall",
  73: "moderate snow fall",
  75: "heavy snow fall",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
};

interface OpenMeteoGeocodingResult {
  results?: Array<{ name: string; latitude: number; longitude: number; country?: string }>;
}

interface OpenMeteoForecastResult {
  current_weather?: { temperature: number; weathercode: number };
}

/**
 * Every tool that reaches the network follows the same shape:
 *
 *   1. Validate input defensively — Claude fills in `input` from the tool
 *      schema, but nothing stops a malformed call from reaching here, so we
 *      check types before using the value.
 *   2. `fetch()` only rejects on network-level failures (DNS, timeout, no
 *      connection). A "city not found" or "bad API key" response is still a
 *      *successful* HTTP response as far as `fetch` is concerned — it just
 *      has a non-2xx status. So every call checks `res.ok` explicitly rather
 *      than relying on `fetch` to throw.
 *   3. Expected failures (no such city, bad currency code) are returned as a
 *      plain string, not thrown. Throwing would make agent-loop.ts report it
 *      as a *tool execution error* (is_error: true), which reads to Claude as
 *      "something broke" rather than "the answer is no such city" — a normal
 *      string result lets Claude relay the failure to the user naturally,
 *      the same way it would relay a successful answer. Unexpected failures
 *      (network down, API completely unreachable) are still allowed to throw
 *      out of `execute`; agent-loop.ts already handles that case as a real
 *      tool error.
 */
export const getWeatherTool: Tool = {
  name: "get_weather",
  description:
    "Returns the current weather (temperature and conditions) for a given city. Use when the user asks about current weather anywhere in the world.",
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: 'The city name, e.g. "Paris" or "San Francisco".',
      },
    },
    required: ["city"],
  },
  execute: async (input) => {
    const city = input.city;
    if (typeof city !== "string" || city.trim().length === 0) {
      return 'Error: "city" must be a non-empty string.';
    }

    // Open-Meteo's forecast endpoint takes latitude/longitude, not a city
    // name, so we look the city up via their geocoding endpoint first.
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
    );

    if (!geoRes.ok) {
      return `Error: weather lookup failed (geocoding service returned ${geoRes.status}).`;
    }

    const geoData = (await geoRes.json()) as OpenMeteoGeocodingResult;
    const match = geoData.results?.[0];

    if (!match) {
      // Not an exception — this is a normal "no result" outcome that Claude
      // should relay to the user, e.g. a misspelled or fictional city name.
      return `Error: could not find a city named "${city}".`;
    }

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${match.latitude}&longitude=${match.longitude}&current_weather=true`
    );

    if (!weatherRes.ok) {
      return `Error: weather lookup failed (forecast service returned ${weatherRes.status}).`;
    }

    const weatherData = (await weatherRes.json()) as OpenMeteoForecastResult;
    const current = weatherData.current_weather;

    if (!current) {
      return "Error: forecast service did not return current weather data.";
    }

    const conditions = WMO_WEATHER_CODES[current.weathercode] ?? `weather code ${current.weathercode}`;

    return `${match.name}${match.country ? `, ${match.country}` : ""}: ${current.temperature}°C, ${conditions}.`;
  },
};

interface FrankfurterLatestResult {
  rates?: Record<string, number>;
  message?: string;
}

export const convertCurrencyTool: Tool = {
  name: "convert_currency",
  description:
    "Converts an amount from one currency to another using current exchange rates. Use when the user asks to convert money between currencies (e.g. USD to EUR). Currency codes must be ISO 4217 (e.g. USD, EUR, JPY).",
  inputSchema: {
    type: "object",
    properties: {
      amount: {
        type: "number",
        description: "The amount to convert.",
      },
      from: {
        type: "string",
        description: 'The source currency as an ISO 4217 code, e.g. "USD".',
      },
      to: {
        type: "string",
        description: 'The target currency as an ISO 4217 code, e.g. "EUR".',
      },
    },
    required: ["amount", "from", "to"],
  },
  execute: async (input) => {
    const amount = input.amount;
    const from = input.from;
    const to = input.to;

    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return 'Error: "amount" must be a finite number.';
    }
    if (typeof from !== "string" || from.trim().length === 0) {
      return 'Error: "from" must be a non-empty currency code.';
    }
    if (typeof to !== "string" || to.trim().length === 0) {
      return 'Error: "to" must be a non-empty currency code.';
    }

    const fromCode = from.trim().toUpperCase();
    const toCode = to.trim().toUpperCase();

    // The API returns a `{"message":"bad currency pair"}` body (with a 200
    // status) when base === symbols, instead of a normal rates object.
    // Short-circuiting here avoids depending on that undocumented quirk.
    if (fromCode === toCode) {
      return `${amount} ${fromCode} = ${amount} ${toCode}`;
    }

    const res = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(fromCode)}&symbols=${encodeURIComponent(toCode)}`
    );

    // Frankfurter returns 404 (not 400) for an unrecognized currency code,
    // e.g. { "message": "not found" } — that's the "invalid currency code"
    // case we need to handle gracefully rather than let become a crash.
    if (!res.ok) {
      return `Error: could not convert "${fromCode}" to "${toCode}" — one or both currency codes may be invalid.`;
    }

    const data = (await res.json()) as FrankfurterLatestResult;
    const rate = data.rates?.[toCode];

    if (typeof rate !== "number") {
      return `Error: no exchange rate available for "${fromCode}" to "${toCode}".`;
    }

    const converted = amount * rate;
    return `${amount} ${fromCode} = ${converted.toFixed(2)} ${toCode}`;
  },
};

/**
 * The combined list passed to `runAgentLoop`. To add a new tool: define it
 * above following the same pattern, then add it here.
 */
export const tools: Tool[] = [getCurrentTimeTool, getWeatherTool, convertCurrencyTool];
