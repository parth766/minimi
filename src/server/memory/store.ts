import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Conversation,
  Episode,
  ExtractedClaim,
  Message,
  MessageMetadata,
  Role,
} from '../../shared/types.js';
import { getDayOfWeekName, toLocalDateString } from './temporal.js';

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  created_at: string;
  local_date: string;
  timezone: string;
  metadata_json: string | null;
}

interface EpisodeRow {
  id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  created_at: string;
  local_date: string;
  day_of_week: string;
  topic: string;
  user_query: string;
  assistant_summary: string;
  entities_json: string;
  claims_json: string;
}

export class MemoryStore {
  public readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        timezone TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv_time
        ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_local_date
        ON messages(local_date);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        message_id UNINDEXED,
        conversation_id UNINDEXED,
        local_date UNINDEXED,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        day_of_week TEXT NOT NULL,
        topic TEXT NOT NULL,
        user_query TEXT NOT NULL,
        assistant_summary TEXT NOT NULL,
        entities_json TEXT NOT NULL,
        claims_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_local_date
        ON episodes(local_date, created_at);
      CREATE INDEX IF NOT EXISTS idx_episodes_conv
        ON episodes(conversation_id, created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        topic,
        user_query,
        assistant_summary,
        entities,
        claims_text,
        episode_id UNINDEXED,
        tokenize = 'porter unicode61'
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createConversation(
    title = 'New Chat',
    id: string = randomUUID(),
    createdAt = new Date().toISOString(),
  ): Conversation {
    this.db
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, createdAt, createdAt);
    return { id, title, createdAt, updatedAt: createdAt };
  }

  getConversation(id: string): Conversation | null {
    const row = this.db
      .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
      .get(id) as ConversationRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listConversations(): Conversation[] {
    const rows = this.db
      .prepare('SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC')
      .all() as unknown as ConversationRow[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  updateConversationTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ?')
      .run(title, id);
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM messages_fts WHERE conversation_id = ?').run(id);
    const episodeRows = this.db
      .prepare('SELECT id FROM episodes WHERE conversation_id = ?')
      .all(id) as unknown as Array<{ id: string }>;
    const delEpFts = this.db.prepare('DELETE FROM episodes_fts WHERE episode_id = ?');
    for (const row of episodeRows) {
      delEpFts.run(row.id);
    }
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  addMessage(params: {
    id?: string;
    conversationId: string;
    role: Role;
    content: string;
    timezone?: string;
    createdAt?: string;
    metadata?: MessageMetadata;
  }): Message {
    const id = params.id ?? randomUUID();
    const createdAt = params.createdAt ?? new Date().toISOString();
    const timezone = params.timezone ?? 'UTC';
    const localDate = toLocalDateString(new Date(createdAt), timezone);
    const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at, local_date, timezone, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, params.conversationId, params.role, params.content, createdAt, localDate, timezone, metadataJson);

    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND updated_at < ?')
      .run(createdAt, params.conversationId, createdAt);

    this.db
      .prepare(
        `INSERT INTO messages_fts (content, message_id, conversation_id, local_date)
         VALUES (?, ?, ?, ?)`,
      )
      .run(params.content, id, params.conversationId, localDate);

    return {
      id,
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      createdAt,
      localDate,
      timezone,
      metadata: params.metadata,
    };
  }

  getMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, created_at, local_date, timezone, metadata_json
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
      )
      .all(conversationId) as unknown as MessageRow[];

    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      localDate: r.local_date,
      timezone: r.timezone,
      metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as MessageMetadata) : undefined,
    }));
  }

  getMessageById(id: string): Message | null {
    const r = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, created_at, local_date, timezone, metadata_json
         FROM messages WHERE id = ?`,
      )
      .get(id) as MessageRow | undefined;
    if (!r) return null;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      localDate: r.local_date,
      timezone: r.timezone,
      metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as MessageMetadata) : undefined,
    };
  }

  upsertEpisode(params: {
    id?: string;
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    createdAt: string;
    localDate: string;
    topic: string;
    userQuery: string;
    assistantSummary: string;
    entities: string[];
    claims: ExtractedClaim[];
  }): Episode {
    const id = params.id ?? randomUUID();
    const dayOfWeek = getDayOfWeekName(params.localDate);
    const entitiesJson = JSON.stringify(params.entities);
    const claimsJson = JSON.stringify(params.claims);
    const claimsText = params.claims
      .map((c) => `${c.entity} ${c.category} ${c.claim} ${c.valueSnapshot ?? ''}`)
      .join(' | ');

    const existing = this.db
      .prepare('SELECT id FROM episodes WHERE user_message_id = ? AND assistant_message_id = ?')
      .get(params.userMessageId, params.assistantMessageId) as { id: string } | undefined;

    const targetId = existing?.id ?? id;

    if (existing) {
      this.db
        .prepare(
          `UPDATE episodes
           SET topic = ?, assistant_summary = ?, entities_json = ?, claims_json = ?
           WHERE id = ?`,
        )
        .run(params.topic, params.assistantSummary, entitiesJson, claimsJson, targetId);
      this.db.prepare('DELETE FROM episodes_fts WHERE episode_id = ?').run(targetId);
    } else {
      this.db
        .prepare(
          `INSERT INTO episodes (
             id, conversation_id, user_message_id, assistant_message_id,
             created_at, local_date, day_of_week, topic, user_query,
             assistant_summary, entities_json, claims_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          targetId,
          params.conversationId,
          params.userMessageId,
          params.assistantMessageId,
          params.createdAt,
          params.localDate,
          dayOfWeek,
          params.topic,
          params.userQuery,
          params.assistantSummary,
          entitiesJson,
          claimsJson,
        );
    }

    this.db
      .prepare(
        `INSERT INTO episodes_fts (topic, user_query, assistant_summary, entities, claims_text, episode_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.topic,
        params.userQuery,
        params.assistantSummary,
        params.entities.join(', '),
        claimsText,
        targetId,
      );

    return {
      id: targetId,
      conversationId: params.conversationId,
      userMessageId: params.userMessageId,
      assistantMessageId: params.assistantMessageId,
      createdAt: params.createdAt,
      localDate: params.localDate,
      dayOfWeek,
      topic: params.topic,
      userQuery: params.userQuery,
      assistantSummary: params.assistantSummary,
      entities: params.entities,
      claims: params.claims,
    };
  }

  getEpisodesByDates(dates: string[]): Episode[] {
    if (dates.length === 0) return [];
    const placeholders = dates.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM episodes WHERE local_date IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...dates) as unknown as EpisodeRow[];
    return rows.map(mapEpisodeRow);
  }

  getEpisodesByDateRange(start: string, end: string): Episode[] {
    const rows = this.db
      .prepare('SELECT * FROM episodes WHERE local_date >= ? AND local_date <= ? ORDER BY created_at ASC')
      .all(start, end) as unknown as EpisodeRow[];
    return rows.map(mapEpisodeRow);
  }

  searchEpisodesFts(ftsQuery: string, limit = 12): Array<{ episode: Episode; rank: number }> {
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT e.*, bm25(episodes_fts, 3.0, 2.0, 1.5, 4.0, 2.0) AS rank
         FROM episodes_fts
         JOIN episodes e ON e.id = episodes_fts.episode_id
         WHERE episodes_fts MATCH ?
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as unknown as Array<EpisodeRow & { rank: number }>;
    return rows.map((r) => ({ episode: mapEpisodeRow(r), rank: r.rank }));
  }

  getRecentEpisodeDates(limit = 5): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT local_date FROM episodes ORDER BY local_date DESC LIMIT ?')
      .all(limit) as unknown as Array<{ local_date: string }>;
    return rows.map((r) => r.local_date);
  }

  getStats(): { conversationCount: number; episodeCount: number } {
    const conv = this.db.prepare('SELECT COUNT(*) AS c FROM conversations').get() as { c: number };
    const ep = this.db.prepare('SELECT COUNT(*) AS c FROM episodes').get() as { c: number };
    return { conversationCount: conv.c, episodeCount: ep.c };
  }
}

function mapEpisodeRow(r: EpisodeRow): Episode {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    userMessageId: r.user_message_id,
    assistantMessageId: r.assistant_message_id,
    createdAt: r.created_at,
    localDate: r.local_date,
    dayOfWeek: r.day_of_week,
    topic: r.topic,
    userQuery: r.user_query,
    assistantSummary: r.assistant_summary,
    entities: JSON.parse(r.entities_json) as string[],
    claims: JSON.parse(r.claims_json) as ExtractedClaim[],
  };
}
