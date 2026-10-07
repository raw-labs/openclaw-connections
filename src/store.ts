import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  receiptSchema,
  storedConnectionSchema,
  type Receipt,
  type StoredConnection,
} from "./contracts.js";
import { ConnectionError } from "./errors.js";

const payload = z.object({ payload: z.string() });
/** One Gateway owns this database. Provider keys and OAuth tokens are never stored here. */
export class ConnectionStore {
  readonly db: DatabaseSync;
  readonly userId: string;
  constructor(path: string, userId?: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, agent TEXT NOT NULL, session TEXT NOT NULL, call TEXT NOT NULL, expires TEXT NOT NULL, payload TEXT NOT NULL, pruned INTEGER NOT NULL DEFAULT 0, UNIQUE(agent, session, call));`);
    const saved = this.db
      .prepare("SELECT value FROM metadata WHERE key='userId'")
      .get();
    if (saved) {
      this.userId = z.object({ value: z.string() }).parse(saved).value;
      if (userId && this.userId !== userId) {
        this.db.close();
        throw new ConnectionError(
          "identity_changed",
          "The configured Composio userId differs from this plugin's retained identity. Use a separate OpenClaw state directory for a different identity.",
        );
      }
    } else {
      this.userId = userId ?? `openclaw-${randomUUID()}`;
      this.db
        .prepare("INSERT INTO metadata(key,value) VALUES('userId',?)")
        .run(this.userId);
    }
    // A process interruption after dispatch cannot establish an external outcome.
    for (const row of this.db.prepare("SELECT payload FROM receipts").all()) {
      const receipt = receiptSchema.parse(
        JSON.parse(payload.parse(row).payload),
      );
      if (receipt.state === "dispatching")
        this.saveReceipt({
          ...receipt,
          state: "unknown",
          failure: {
            detail:
              "The Gateway stopped before recording the external outcome. Do not execute again to recover it.",
          },
        });
    }
    for (const connection of this.list()) {
      if (connection.setup?.state === "creating")
        this.save({
          ...connection,
          state: "needs_attention",
          failure: {
            detail:
              "The Gateway stopped during setup. Cancel this setup and inspect your Composio project before starting another.",
          },
          setup: {
            ...connection.setup,
            state: "unknown",
            failure: {
              detail:
                "The Gateway stopped during setup. Its provider outcome is unknown. Cancel this setup and inspect your Composio project before starting another.",
            },
          },
        });
    }
    this.prune();
  }
  prune(now = new Date().toISOString()) {
    for (const row of this.db
      .prepare("SELECT payload FROM receipts WHERE expires < ? AND pruned=0")
      .all(now)) {
      const receipt = receiptSchema.parse(
        JSON.parse(payload.parse(row).payload),
      );
      const pruned = {
        ...receipt,
        result: null,
        failure:
          receipt.state === "unknown" || receipt.state === "dispatching"
            ? {
                detail:
                  "The outcome remains unknown; its saved details have expired. Do not execute again to recover it.",
              }
            : null,
      };
      this.db
        .prepare("UPDATE receipts SET payload=?,pruned=1 WHERE id=?")
        .run(JSON.stringify(pruned), receipt.id);
    }
  }
  list(): StoredConnection[] {
    return this.db
      .prepare("SELECT payload FROM connections ORDER BY id")
      .all()
      .map((row) =>
        storedConnectionSchema.parse(JSON.parse(payload.parse(row).payload)),
      );
  }
  get(id: string): StoredConnection {
    const row = this.db
      .prepare("SELECT payload FROM connections WHERE id=?")
      .get(id);
    if (!row)
      throw new ConnectionError(
        "not_found",
        "The connection could not be found.",
      );
    return storedConnectionSchema.parse(JSON.parse(payload.parse(row).payload));
  }
  insert(connection: StoredConnection) {
    if (this.list().length >= 1000)
      throw new ConnectionError(
        "limit",
        "This installation supports up to 1,000 connections.",
      );
    this.db
      .prepare("INSERT INTO connections(id,revision,payload) VALUES(?,?,?)")
      .run(
        connection.id,
        connection.revision,
        JSON.stringify(storedConnectionSchema.parse(connection)),
      );
  }
  save(connection: StoredConnection): StoredConnection {
    const value = storedConnectionSchema.parse({
      ...connection,
      revision: connection.revision + 1,
    });
    const updated = this.db
      .prepare(
        "UPDATE connections SET revision=?,payload=? WHERE id=? AND revision=?",
      )
      .run(
        value.revision,
        JSON.stringify(value),
        value.id,
        connection.revision,
      );
    if (updated.changes !== 1)
      throw new ConnectionError(
        "revision_conflict",
        "This connection changed. Refresh before saving.",
      );
    return value;
  }
  remove(id: string, revision: number) {
    const removed = this.db
      .prepare("DELETE FROM connections WHERE id=? AND revision=?")
      .run(id, revision);
    if (removed.changes !== 1)
      throw new ConnectionError(
        "revision_conflict",
        "This connection changed. Refresh before removing it.",
      );
  }
  claim(receipt: Receipt): Receipt {
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO receipts(id,agent,session,call,expires,payload) VALUES(?,?,?,?,?,?)",
      )
      .run(
        receipt.id,
        receipt.agentId,
        receipt.session,
        receipt.toolCallId,
        receipt.expiresAt,
        JSON.stringify(receiptSchema.parse(receipt)),
      );
    if (inserted.changes !== 1) {
      const existing = this.db
        .prepare(
          "SELECT expires FROM receipts WHERE agent=? AND session=? AND call=?",
        )
        .get(receipt.agentId, receipt.session, receipt.toolCallId);
      if (
        existing &&
        z.object({ expires: z.string() }).parse(existing).expires <
          new Date().toISOString()
      )
        throw new ConnectionError(
          "receipt_expired",
          "This native call was recorded previously and its result has expired. No operation was replayed.",
        );
    }
    return this.lookup(receipt.agentId, receipt.session, receipt.toolCallId);
  }
  lookup(agent: string, session: string, call: string): Receipt {
    const row = this.db
      .prepare(
        "SELECT payload FROM receipts WHERE agent=? AND session=? AND call=? AND expires>=?",
      )
      .get(agent, session, call, new Date().toISOString());
    if (!row)
      throw new ConnectionError(
        "receipt_not_found",
        "No retained call was found in this agent session. No operation was executed by this read.",
      );
    return receiptSchema.parse(JSON.parse(payload.parse(row).payload));
  }
  receipt(id: string, agent: string, session: string): Receipt {
    const row = this.db
      .prepare(
        "SELECT payload FROM receipts WHERE id=? AND agent=? AND session=? AND expires>=?",
      )
      .get(id, agent, session, new Date().toISOString());
    if (!row)
      throw new ConnectionError(
        "receipt_not_found",
        "The saved result is unavailable to this agent session.",
      );
    return receiptSchema.parse(JSON.parse(payload.parse(row).payload));
  }
  saveReceipt(receipt: Receipt) {
    this.db
      .prepare("UPDATE receipts SET payload=? WHERE id=?")
      .run(JSON.stringify(receiptSchema.parse(receipt)), receipt.id);
  }
  usage() {
    this.prune();
    const receipts = this.db
      .prepare("SELECT payload FROM receipts WHERE expires>=?")
      .all(new Date().toISOString())
      .map((row) =>
        receiptSchema.parse(JSON.parse(payload.parse(row).payload)),
      );
    return {
      calls: receipts.length,
      succeeded: receipts.filter((r) => r.state === "succeeded").length,
      rejected: receipts.filter((r) => r.state === "rejected").length,
      unknown: receipts.filter(
        (r) => r.state === "unknown" || r.state === "dispatching",
      ).length,
      retainedDays: 7,
    };
  }
  close() {
    this.db.close();
  }
}
