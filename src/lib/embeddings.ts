import { env } from "@/lib/env";

/**
 * Text embeddings for semantic memory recall (OpenAI text-embedding-3-small,
 * 1536 dims — matches the pgvector column). Returns null when no OPENAI_API_KEY
 * is set or the provider errors; callers degrade to keyword search.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!env.openaiApiKey) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: env.embeddingModel, input: text.slice(0, 8000) }),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { data?: { embedding?: number[] }[] };
    const embedding = body.data?.[0]?.embedding;
    return Array.isArray(embedding) && embedding.length > 0 ? embedding : null;
  } catch {
    return null;
  }
}
