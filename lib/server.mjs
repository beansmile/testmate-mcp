// TestMate MCP server: the upstream @makethisbetter/mcp tools plus the
// TestMate-only QA verification step.
//
//   verify / reject   POST /api/v2/projects/:handle/feedbacks/:n/verification
//   list              status filter also accepts pending_verification
//
// Upstream tools are registered through their own register* functions; a thin
// proxy around McpServer lets us adjust the `list` schema before it is
// registered, without touching the upstream package.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MakeThisBetterClient } from "@makethisbetter/mcp/dist/api/client.js";
import { loadConfig } from "@makethisbetter/mcp/dist/config.js";
import { FEEDBACK_REFERENCE_MESSAGE, FEEDBACK_REFERENCE_PATTERN, feedbackReferenceSchema } from "@makethisbetter/mcp/dist/project-handle.js";
import { runTool } from "@makethisbetter/mcp/dist/tools/shared.js";
import { registerArchiveTool, registerRestoreTool } from "@makethisbetter/mcp/dist/tools/archive.js";
import { registerDeclineTool } from "@makethisbetter/mcp/dist/tools/decline.js";
import { registerDetailTool } from "@makethisbetter/mcp/dist/tools/detail.js";
import { registerDuplicateTool } from "@makethisbetter/mcp/dist/tools/duplicate.js";
import { registerListTool } from "@makethisbetter/mcp/dist/tools/list.js";
import { registerPickTool } from "@makethisbetter/mcp/dist/tools/pick.js";
import {
  registerProjectCreateTool,
  registerProjectListTool,
  registerProjectShowTool,
  registerProjectUpdateTool,
} from "@makethisbetter/mcp/dist/tools/projects.js";
import { registerReadyTool } from "@makethisbetter/mcp/dist/tools/ready.js";
import { registerReopenTool } from "@makethisbetter/mcp/dist/tools/reopen.js";
import { registerRespondTool } from "@makethisbetter/mcp/dist/tools/respond.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const SERVER_NAME = "@beansmile/testmate-mcp";
export const SERVER_VERSION = pkg.version;

export const FEEDBACK_STATUSES = ["received", "in_progress", "pending_release", "pending_verification", "closed"];
export const NOTE_MAX = 2000;

const UPSTREAM_LIST_STATUS_SENTENCE =
  "Filter by status: received (new), in_progress (claimed), pending_release (shipped but unreleased), closed (done).";
const LIST_STATUS_SENTENCE =
  "Filter by status: received (new), in_progress (claimed), pending_release (shipped but unreleased), " +
  "pending_verification (released and waiting for QA verification, only on projects with QA verification turned on), closed (done).";

export class TestMateClient extends MakeThisBetterClient {
  // TestMate-only: record the QA result for Feedback in pending_verification.
  // Returns the bare Feedback, like readiness and release.
  async verifyFeedback(reference, verification) {
    const match = FEEDBACK_REFERENCE_PATTERN.exec(reference);
    if (!match) throw new Error(FEEDBACK_REFERENCE_MESSAGE);
    return this.request(
      `/projects/${encodeURIComponent(match[1])}/feedbacks/${match[2]}/verification`,
      { method: "POST", body: JSON.stringify({ feedback_verification: verification }) },
      this.apiUrlForVersion("v2"),
    );
  }
}

// Rewrites upstream tool configs as they are registered.
function patchToolConfig(name, config) {
  if (name !== "list") return config;
  const description = typeof config.description === "string" && config.description.includes(UPSTREAM_LIST_STATUS_SENTENCE)
    ? config.description.replace(UPSTREAM_LIST_STATUS_SENTENCE, LIST_STATUS_SENTENCE)
    : `${config.description ?? ""} ${LIST_STATUS_SENTENCE}`.trim();
  return {
    ...config,
    description,
    inputSchema: {
      ...config.inputSchema,
      status: z.enum(FEEDBACK_STATUSES).optional().describe("Filter by feedback status."),
    },
  };
}

function patchingServer(server) {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name, config, cb) => target.registerTool(name, patchToolConfig(name, config), cb);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const httpUrl = z.string().trim().url().refine((value) => /^https?:\/\//i.test(value), "evidence_url must be an http(s) URL.");

export function registerVerifyTool(server, client) {
  server.registerTool("verify", {
    title: "Pass QA Verification",
    description: [
      "Record that QA verification passed for Feedback in pending_verification (\"Verifying\") and close it as closed(shipped).",
      "Feedback reaches pending_verification only when the project has QA verification turned on: release then moves",
      "pending_release Feedback to pending_verification instead of closing it.",
      "Call this only after the fix was actually checked in the released build. Any project member, the fixer included, or a QA bot token may call it.",
      "Returns 409 invalid_transition when the Feedback is not in pending_verification.",
    ].join(" "),
    inputSchema: {
      feedback_id: feedbackReferenceSchema.describe("Project-scoped feedback reference (e.g. acme/FB-42)."),
      note: z.string().trim().min(1).max(NOTE_MAX).optional().describe("Optional note on what was checked."),
      evidence_url: httpUrl.optional().describe("Optional http(s) link to proof, e.g. a test run or screenshot."),
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ feedback_id, note, evidence_url }) => runTool(() => client.verifyFeedback(feedback_id, {
    outcome: "passed",
    ...(note ? { note } : {}),
    ...(evidence_url ? { evidence_url } : {}),
  })));
}

export function registerRejectTool(server, client) {
  server.registerTool("reject", {
    title: "Fail QA Verification",
    description: [
      "Record that QA verification failed for Feedback in pending_verification (\"Verifying\").",
      "The Feedback returns to in_progress with the same assignee and resolution summary.",
      "note is required and should say what failed so the developer can fix it.",
      "After the fix, commit with the same `Feedback: <handle/FB-n>` trailer and call 'ready' again;",
      "release evidence committed before the rejection is treated as stale.",
      "Returns 409 invalid_transition when the Feedback is not in pending_verification.",
    ].join(" "),
    inputSchema: {
      feedback_id: feedbackReferenceSchema.describe("Project-scoped feedback reference (e.g. acme/FB-42)."),
      note: z.string().trim().min(1).max(NOTE_MAX).describe("What failed (required)."),
      evidence_url: httpUrl.optional().describe("Optional http(s) link to proof, e.g. a failing test run or screenshot."),
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ feedback_id, note, evidence_url }) => runTool(() => client.verifyFeedback(feedback_id, {
    outcome: "failed",
    note,
    ...(evidence_url ? { evidence_url } : {}),
  })));
}

export function createTestMateServer(client) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const upstream = patchingServer(server);
  // Same order as upstream createMcpServer, with verify/reject after ready.
  registerListTool(upstream, client);
  registerPickTool(upstream, client);
  registerReadyTool(upstream, client);
  registerVerifyTool(server, client);
  registerRejectTool(server, client);
  registerDeclineTool(upstream, client);
  registerDuplicateTool(upstream, client);
  registerReopenTool(upstream, client);
  registerRespondTool(upstream, client);
  registerArchiveTool(upstream, client);
  registerRestoreTool(upstream, client);
  registerDetailTool(upstream, client);
  registerProjectListTool(upstream, client);
  registerProjectShowTool(upstream, client);
  registerProjectCreateTool(upstream, client);
  registerProjectUpdateTool(upstream, client);
  return server;
}

export async function runServer(argv = process.argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write([
      "TestMate MCP server (wraps @makethisbetter/mcp)",
      "",
      "Usage: testmate-mcp",
      "",
      "Reads ~/.testmate/config.json by default (written by `testmate login --token <token>`).",
      "Set MAKETHISBETTER_CONFIG=/path/to/config.json to override the config path.",
      "",
    ].join("\n"));
    return;
  }
  const config = await loadConfig();
  const client = new TestMateClient({
    apiUrl: config.api_url,
    apiToken: config.api_token,
    accountId: config.account_id,
  });
  const server = createTestMateServer(client);
  await server.connect(new StdioServerTransport());
}
