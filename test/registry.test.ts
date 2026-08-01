import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WebhookRegistry } from "../src/registry.js";

function registry(): WebhookRegistry {
  const directory = mkdtempSync(path.join(tmpdir(), "codexhook-registry-"));
  return new WebhookRegistry(path.join(directory, "registry.sqlite"));
}

test("creates and resolves an opaque webhook token", () => {
  const store = registry();
  const hook = store.create(
    {
      id: "github-ci",
      threadId: "thread-1",
      mode: "queue",
      prependBody: "Webhook {hookId}:\n\n",
      expiresAt: 2_000,
      maxDeliveries: null,
    },
    1_000,
  );

  assert.equal(hook.token.length, 43);
  assert.equal(store.inspectToken(hook.token, 1_001)?.threadId, "thread-1");
  assert.equal(store.inspectToken("x".repeat(43), 1_001), null);
  store.close();
});

test("atomically consumes one-shot hooks", () => {
  const store = registry();
  const hook = store.create(
    {
      id: "once",
      threadId: "thread-1",
      mode: "queue",
      prependBody: "",
      expiresAt: null,
      maxDeliveries: 1,
    },
    1_000,
  );

  assert.equal(store.claimToken(hook.token, 1_001)?.id, "once");
  assert.equal(store.claimToken(hook.token, 1_001), null);
  assert.equal(store.list(1_001).length, 0);
  store.close();
});

test("expires and revokes hooks without separate status records", () => {
  const store = registry();
  const expired = store.create(
    {
      id: "expired",
      threadId: "thread-1",
      mode: "queue",
      prependBody: "",
      expiresAt: 1_010,
      maxDeliveries: null,
    },
    1_000,
  );
  store.create(
    {
      id: "active",
      threadId: "thread-1",
      mode: "queue",
      prependBody: "",
      expiresAt: null,
      maxDeliveries: null,
    },
    1_000,
  );

  assert.equal(store.inspectToken(expired.token, 1_010), null);
  assert.equal(store.revokeThread("thread-1"), 1);
  assert.deepEqual(store.list(1_011), []);
  store.close();
});

test("reissuing an id for the same thread atomically replaces its URL", () => {
  const store = registry();
  const input = {
    id: "deploy",
    threadId: "thread-1",
    mode: "queue" as const,
    prependBody: "",
    expiresAt: null,
    maxDeliveries: null,
  };
  const first = store.create(input, 1_000);
  const second = store.create(
    { ...input, mode: "steer", maxDeliveries: 1 },
    1_001,
  );

  assert.equal(store.inspectToken(first.token, 1_002), null);
  assert.equal(store.inspectToken(second.token, 1_002)?.mode, "steer");
  assert.equal(store.list(1_002).length, 1);
  store.close();
});

test("does not replace an id owned by another thread", () => {
  const store = registry();
  const first = store.create({
    id: "deploy",
    threadId: "thread-1",
    mode: "queue",
    prependBody: "",
    expiresAt: null,
    maxDeliveries: null,
  });

  assert.throws(
    () =>
      store.create({
        id: "deploy",
        threadId: "thread-2",
        mode: "queue",
        prependBody: "",
        expiresAt: null,
        maxDeliveries: null,
      }),
    /belongs to another thread/,
  );
  assert.equal(store.inspectToken(first.token)?.threadId, "thread-1");
  store.close();
});

test("refuses a registry written by a newer schema", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codexhook-schema-"));
  const filename = path.join(directory, "registry.sqlite");
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA user_version = 2");
  database.close();

  assert.throws(
    () => new WebhookRegistry(filename),
    /schema 2 is newer than supported schema 1/,
  );
});
