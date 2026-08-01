import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import pathModule from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  MAX_PREPEND_BYTES,
  databasePath,
  ensureDataDirectory,
} from "./config.js";
import type {
  CreatedWebhook,
  DeliveryMode,
  WebhookRecord,
} from "./types.js";
import { ThreadId } from "./types.js";

interface WebhookRow {
  id: string;
  token_hash: string;
  thread_id: string;
  mode: DeliveryMode;
  prepend_body: string;
  expires_at: number | null;
  remaining_deliveries: number | null;
  created_at: number;
}

export interface CreateWebhookInput {
  id: string;
  threadId: string;
  mode: DeliveryMode;
  prependBody: string;
  expiresAt: number | null;
  maxDeliveries: number | null;
}

const HOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCHEMA_VERSION = 1;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function rowToRecord(row: WebhookRow): WebhookRecord {
  return {
    id: row.id,
    threadId: ThreadId(row.thread_id),
    mode: row.mode,
    prependBody: row.prepend_body,
    expiresAt: row.expires_at,
    remainingDeliveries: row.remaining_deliveries,
    createdAt: row.created_at,
  };
}

function rowFromStatement(
  statement: StatementSync,
  ...parameters: string[]
): WebhookRow | null {
  return (statement.get(...parameters) as unknown as WebhookRow | undefined) ?? null;
}

export class WebhookRegistry {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path = databasePath()) {
    if (path === databasePath()) {
      ensureDataDirectory();
    } else {
      mkdirSync(pathModule.dirname(path), { recursive: true, mode: 0o700 });
    }
    this.path = path;
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec("PRAGMA busy_timeout = 5000");
    const version = (
      this.database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;
    if (version > SCHEMA_VERSION) {
      this.database.close();
      throw new Error(
        `registry schema ${version} is newer than supported schema ${SCHEMA_VERSION}`,
      );
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('queue', 'steer')),
        prepend_body TEXT NOT NULL,
        expires_at INTEGER,
        remaining_deliveries INTEGER CHECK (
          remaining_deliveries IS NULL OR remaining_deliveries > 0
        ),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS webhooks_thread_id
        ON webhooks(thread_id);
      CREATE INDEX IF NOT EXISTS webhooks_expires_at
        ON webhooks(expires_at);
    `);
    if (version < SCHEMA_VERSION) {
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  create(input: CreateWebhookInput, now = Math.floor(Date.now() / 1000)): CreatedWebhook {
    if (!HOOK_ID_PATTERN.test(input.id)) {
      throw new Error(
        "webhook id must be 1-64 characters using letters, numbers, dot, underscore, or hyphen",
      );
    }
    if (input.threadId.length === 0) throw new Error("thread id is required");
    if (Buffer.byteLength(input.prependBody) > MAX_PREPEND_BYTES) {
      throw new Error(`prepend body cannot exceed ${MAX_PREPEND_BYTES} bytes`);
    }
    if (input.expiresAt != null && input.expiresAt <= now) {
      throw new Error("expiration must be in the future");
    }
    if (input.maxDeliveries != null && input.maxDeliveries < 1) {
      throw new Error("max deliveries must be positive");
    }

    const token = randomBytes(32).toString("base64url");
    const result = this.database
      .prepare(`
        INSERT INTO webhooks (
          id, token_hash, thread_id, mode, prepend_body,
          expires_at, remaining_deliveries, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          token_hash = excluded.token_hash,
          mode = excluded.mode,
          prepend_body = excluded.prepend_body,
          expires_at = excluded.expires_at,
          remaining_deliveries = excluded.remaining_deliveries,
          created_at = excluded.created_at
        WHERE webhooks.thread_id = excluded.thread_id
      `)
      .run(
        input.id,
        tokenHash(token),
        input.threadId,
        input.mode,
        input.prependBody,
        input.expiresAt,
        input.maxDeliveries,
        now,
      );
    if (result.changes === 0) {
      throw new Error(
        `webhook id "${input.id}" already belongs to another thread`,
      );
    }

    return {
      id: input.id,
      token,
      threadId: ThreadId(input.threadId),
      mode: input.mode,
      prependBody: input.prependBody,
      expiresAt: input.expiresAt,
      remainingDeliveries: input.maxDeliveries,
      createdAt: now,
    };
  }

  inspectToken(token: string, now = Math.floor(Date.now() / 1000)): WebhookRecord | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const row = rowFromStatement(
      this.database.prepare("SELECT * FROM webhooks WHERE token_hash = ?"),
      tokenHash(token),
    );
    if (row == null) return null;
    if (row.expires_at != null && row.expires_at <= now) {
      this.database.prepare("DELETE FROM webhooks WHERE id = ?").run(row.id);
      return null;
    }
    return rowToRecord(row);
  }

  claimToken(token: string, now = Math.floor(Date.now() / 1000)): WebhookRecord | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const hash = tokenHash(token);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = rowFromStatement(
        this.database.prepare("SELECT * FROM webhooks WHERE token_hash = ?"),
        hash,
      );
      if (row == null) {
        this.database.exec("COMMIT");
        return null;
      }
      if (row.expires_at != null && row.expires_at <= now) {
        this.database.prepare("DELETE FROM webhooks WHERE id = ?").run(row.id);
        this.database.exec("COMMIT");
        return null;
      }

      const record = rowToRecord(row);
      if (row.remaining_deliveries === 1) {
        this.database.prepare("DELETE FROM webhooks WHERE id = ?").run(row.id);
      } else if (row.remaining_deliveries != null) {
        this.database
          .prepare(`
            UPDATE webhooks
            SET remaining_deliveries = remaining_deliveries - 1
            WHERE id = ?
          `)
          .run(row.id);
      }
      this.database.exec("COMMIT");
      return record;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  list(now = Math.floor(Date.now() / 1000)): WebhookRecord[] {
    this.deleteExpired(now);
    const rows = this.database
      .prepare("SELECT * FROM webhooks ORDER BY created_at DESC, id ASC")
      .all() as unknown as WebhookRow[];
    return rows.map(rowToRecord);
  }

  revoke(id: string): boolean {
    return (
      this.database.prepare("DELETE FROM webhooks WHERE id = ?").run(id)
        .changes > 0
    );
  }

  revokeThread(threadId: string): number {
    return Number(
      this.database
        .prepare("DELETE FROM webhooks WHERE thread_id = ?")
        .run(threadId).changes,
    );
  }

  revokeAll(): number {
    return Number(this.database.prepare("DELETE FROM webhooks").run().changes);
  }

  deleteExpired(now = Math.floor(Date.now() / 1000)): number {
    return Number(
      this.database
        .prepare("DELETE FROM webhooks WHERE expires_at IS NOT NULL AND expires_at <= ?")
        .run(now).changes,
    );
  }

  close(): void {
    this.database.close();
  }
}
