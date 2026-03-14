import OpenAI from 'openai';

export interface ThemeCluster {
  label: string;
  quotes: string[];
  count: number;
}

function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Send a batch of open-text cancellation responses to GPT-4o-mini
 * and get back 3–5 synthesised theme clusters.
 *
 * Cost estimate: ~$0.001 per 100 responses (gpt-4o-mini input tokens).
 */
export async function clusterResponses(
  responses: { text: string; reason: string }[],
): Promise<ThemeCluster[]> {
  const openai = getClient();

  const prompt = `You are analyzing cancellation survey responses for a SaaS product.

Responses (JSON array):
${JSON.stringify(responses, null, 2)}

Task:
1. Identify 3–5 distinct themes that explain why customers cancelled.
2. For each theme, pick 1–2 representative verbatim quotes from the responses.
3. Count how many responses belong to each theme.

Respond ONLY with a valid JSON array of objects with this shape:
[
  {
    "label": "Theme name (3–6 words)",
    "quotes": ["verbatim quote 1", "verbatim quote 2"],
    "count": <number>
  }
]`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices[0].message.content ?? '{"themes":[]}';
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.themes ?? []);
}
