// Connects a real MCP client to createTestMateServer over the SDK's in-memory
// transport, with fetch stubbed, and checks the verification tools end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TestMateClient, createTestMateServer, FEEDBACK_STATUSES, SERVER_NAME } from "../lib/server.mjs";

function stubFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url, method: init.method ?? "GET", auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const { status = 200, json } = responder(call);
    return new Response(json === undefined ? "" : JSON.stringify(json), { status });
  };
  return { calls, fetchImpl };
}

async function connect(responder, { accountId } = {}) {
  const { calls, fetchImpl } = stubFetch(responder);
  const api = new TestMateClient({ apiUrl: "http://tm.test/api/v1", apiToken: "token_test", accountId, fetchImpl });
  const server = createTestMateServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls, close: () => client.close() };
}

test("registers every upstream tool plus verify and reject", async () => {
  const { client, close } = await connect(() => ({ json: {} }));
  try {
    assert.equal(client.getServerVersion().name, SERVER_NAME);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "archive", "decline", "detail", "duplicate", "list", "pick",
      "project_create", "project_list", "project_show", "project_update",
      "ready", "reject", "reopen", "respond", "restore", "verify",
    ]);
    const reject = tools.find((t) => t.name === "reject");
    assert.deepEqual(reject.inputSchema.required.sort(), ["feedback_id", "note"]);
    const verify = tools.find((t) => t.name === "verify");
    assert.deepEqual(verify.inputSchema.required, ["feedback_id"]);
    assert.match(verify.description, /QA verification turned on/);
  } finally {
    await close();
  }
});

test("list accepts and advertises pending_verification", async () => {
  const { client, calls, close } = await connect(() => ({
    json: [{ id: "fb_1", reference: "demo/FB-3", status: "pending_verification", labels: [], priority: null, description: "x", updated_at: "2026-11-04T00:00:00Z" }],
  }));
  try {
    const { tools } = await client.listTools();
    const list = tools.find((t) => t.name === "list");
    assert.deepEqual(list.inputSchema.properties.status.enum, FEEDBACK_STATUSES);
    assert.match(list.description, /pending_verification \(released and waiting for QA verification/);

    const result = await client.callTool({ name: "list", arguments: { project_handle: "demo", status: "pending_verification" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.result[0].status, "pending_verification");
    assert.equal(calls[0].url, "http://tm.test/api/v1/projects/demo/feedbacks?status=pending_verification&limit=20");
  } finally {
    await close();
  }
});

test("verify posts a passed outcome to the v2 verification endpoint", async () => {
  const { client, calls, close } = await connect(() => ({
    json: { id: "fb_1", reference: "demo/FB-3", status: "closed", close_reason: "shipped" },
  }), { accountId: "acct_1" });
  try {
    const result = await client.callTool({
      name: "verify",
      arguments: { feedback_id: "demo/FB-3", note: "Checked on prod", evidence_url: "https://ci.test/run/1" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "closed");
    assert.equal(result.structuredContent.close_reason, "shipped");
    assert.deepEqual(calls, [{
      url: "http://tm.test/api/v2/projects/demo/feedbacks/3/verification?account_id=acct_1",
      method: "POST",
      auth: "Bearer token_test",
      body: { feedback_verification: { outcome: "passed", note: "Checked on prod", evidence_url: "https://ci.test/run/1" } },
    }]);

    await client.callTool({ name: "verify", arguments: { feedback_id: "demo/FB-3" } });
    assert.deepEqual(calls[1].body, { feedback_verification: { outcome: "passed" } });
  } finally {
    await close();
  }
});

test("reject posts a failed outcome with the required note", async () => {
  const { client, calls, close } = await connect(() => ({
    json: { id: "fb_1", reference: "demo/FB-3", status: "in_progress", assignee: { id: "user_1", name: "Devon" } },
  }));
  try {
    const result = await client.callTool({ name: "reject", arguments: { feedback_id: "demo/FB-3", note: "Still 500s on export" } });
    assert.equal(result.structuredContent.status, "in_progress");
    assert.equal(result.structuredContent.assignee.name, "Devon");
    assert.deepEqual(calls[0].body, { feedback_verification: { outcome: "failed", note: "Still 500s on export" } });
  } finally {
    await close();
  }
});

test("input validation rejects bad calls before any request", async () => {
  const { client, calls, close } = await connect(() => ({ json: {} }));
  try {
    const cases = [
      { name: "reject", arguments: { feedback_id: "demo/FB-3" } },
      { name: "reject", arguments: { feedback_id: "demo/FB-3", note: "   " } },
      { name: "verify", arguments: { feedback_id: "FB-3" } },
      { name: "verify", arguments: { feedback_id: "demo/FB-3", evidence_url: "ftp://files.test/x" } },
      { name: "verify", arguments: { feedback_id: "demo/FB-3", note: "x".repeat(2001) } },
      { name: "list", arguments: { project_handle: "demo", status: "verifying" } },
    ];
    for (const args of cases) {
      const result = await client.callTool(args).catch((error) => ({ isError: true, content: [{ text: error.message }] }));
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("server errors come back as tool errors with the server message", async () => {
  const { client, close } = await connect(() => ({
    status: 409,
    json: { error: "Feedback must be pending_verification to verify it (is in_progress).", code: "invalid_transition" },
  }));
  try {
    const result = await client.callTool({ name: "verify", arguments: { feedback_id: "demo/FB-3" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /must be pending_verification to verify it \(is in_progress\)/);
  } finally {
    await close();
  }
});
