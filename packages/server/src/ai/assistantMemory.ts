import { db } from '../db/pool.js';

export interface AssistantMemory {
  id: string;
  fact: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Permanent memory is opt-in and visible. This keeps ordinary questions,
 * customer names and copied conversations from silently becoming user-profile
 * data while still supporting natural instructions such as
 * "remember that I prefer WhatsApp drafts in Hinglish".
 */
export function extractMemoryFact(question: string): string | null {
  const match = question.trim().match(/^(?:please\s+)?remember(?:\s+that)?[\s,:-]+(.+)$/is);
  if (!match) return null;
  const fact = match[1].replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim();
  return fact.length >= 2 ? fact.slice(0, 500) : null;
}

export function normalizeMemoryFact(fact: string): string {
  return fact.toLocaleLowerCase('en-IN').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export async function rememberFact(
  userId: string,
  fact: string,
  sourceThreadId: string,
): Promise<AssistantMemory> {
  const normalized = normalizeMemoryFact(fact);
  const row = await db.queryOne<{
    id: string; fact: string; created_at: string; updated_at: string;
  }>(
    `INSERT INTO ipy_ai_memory (user_id, fact, normalized_fact, source_thread_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, normalized_fact)
     DO UPDATE SET fact = EXCLUDED.fact, source_thread_id = EXCLUDED.source_thread_id, updated_at = now()
     RETURNING id, fact, created_at, updated_at`,
    [userId, fact, normalized, sourceThreadId],
  );
  if (!row) throw new Error('Could not save assistant memory');
  return {
    id: row.id,
    fact: row.fact,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listMemories(userId: string, limit = 30): Promise<AssistantMemory[]> {
  const rows = await db.query<{
    id: string; fact: string; created_at: string; updated_at: string;
  }>(
    `SELECT id, fact, created_at, updated_at
     FROM ipy_ai_memory
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, Math.min(100, Math.max(1, limit))],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    fact: row.fact,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function forgetMemory(userId: string, memoryId: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM ipy_ai_memory WHERE id = $1 AND user_id = $2`,
    [memoryId, userId],
  );
  return result.rowCount > 0;
}

export function memoryPrompt(memories: AssistantMemory[]): string {
  if (!memories.length) return '(no saved preferences or instructions)';
  return memories.slice(0, 20).map((memory) => `- ${memory.fact}`).join('\n');
}
