// Claude calls — scope summaries, the PM-assignment recommendation, and the
// handoff brief. Ported from punch-worker's callClaude / extractJSON.
//
// Model matches the rest of the suite (proven working on this Anthropic key in
// scout-worker / tally-worker). Bump when the suite moves.
export const MODEL = "claude-sonnet-4-6";
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export async function callClaude(env, { model = MODEL, system, messages, userMessage, maxTokens = 2000 }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: messages || [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const textBlock = data.content.find((b) => b.type === "text");
  return (textBlock ? textBlock.text : "").replace(/```json|```/g, "").trim();
}

// Claude's reply is supposed to be pure JSON; a stray word before/after it breaks
// a naive JSON.parse. Pull the first {...} span regardless of what surrounds it.
export function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object in Claude's response: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}
