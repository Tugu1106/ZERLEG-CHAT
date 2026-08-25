import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BROADCAST_TARGET, type ChatMessage, type Target, type User, type UserId } from './protocol.js';

interface MessageRow {
  id: string;
  from_id: string;
  from_name: string;
  to_id: string;
  body: string;
  urgent: number;
  ts: number;
}

const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  from: r.from_id,
  fromName: r.from_name,
  to: r.to_id as Target,
  body: r.body,
  urgent: r.urgent === 1,
  ts: r.ts,
});

export class Store {
  private db: Database.Database;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        name       TEXT    NOT NULL,
        last_seen  INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id        TEXT PRIMARY KEY,
        from_id   TEXT    NOT NULL,
        from_name TEXT    NOT NULL,
        to_id     TEXT    NOT NULL,
        body      TEXT    NOT NULL,
        urgent    INTEGER NOT NULL DEFAULT 0,
        ts        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_ts    ON messages (ts);
      CREATE INDEX IF NOT EXISTS idx_messages_to    ON messages (to_id, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_from  ON messages (from_id, ts);

      CREATE TABLE IF NOT EXISTS acks (
        message_id TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        user_name  TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
      );
    `);
  }

  upsertUser(id: UserId, name: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, name, last_seen, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
      )
      .run(id, name, now, now);
  }

  touchUser(id: UserId): void {
    this.db.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`).run(Date.now(), id);
  }

  hasUser(id: UserId): boolean {
    return this.db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id) !== undefined;
  }

  /** All known users; `online` is filled in by the caller from live socket state. */
  listUsers(): Omit<User, 'online'>[] {
    return this.db
      .prepare(`SELECT id, name, last_seen AS lastSeen FROM users ORDER BY name COLLATE NOCASE`)
      .all() as Omit<User, 'online'>[];
  }

  insertMessage(m: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, from_id, from_name, to_id, body, urgent, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.from, m.fromName, m.to, m.body, m.urgent ? 1 : 0, m.ts);
  }

  getMessage(id: string): ChatMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
    return row && toMessage(row);
  }

  /** Everything this user can see: their DMs (either direction) plus all broadcasts. */
  historyFor(userId: UserId, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE to_id = ? OR from_id = ? OR to_id = ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(userId, userId, BROADCAST_TARGET, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  insertAck(messageId: string, userId: UserId, userName: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO acks (message_id, user_id, user_name, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, user_id) DO NOTHING`,
      )
      .run(messageId, userId, userName, ts);
  }

  /**
   * Urgent messages addressed to this user that they never acknowledged - used to
   * re-raise alerts that arrived while their machine was off.
   */
  pendingUrgentFor(userId: UserId, since: number, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.urgent = 1
           AND m.ts >= ?
           AND m.from_id != ?
           AND (m.to_id = ? OR m.to_id = ?)
           AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.message_id = m.id AND a.user_id = ?)
         ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(since, userId, userId, BROADCAST_TARGET, userId, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  close(): void {
    this.db.close();
  }
}
