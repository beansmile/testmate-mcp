#!/usr/bin/env node
"use strict";
// TestMate MCP server: points @makethisbetter/mcp at ~/.testmate/config.json
// (unless MAKETHISBETTER_CONFIG is already set) and runs it in-process over
// stdio, with TestMate's QA verification tools added (lib/server.mjs).
// Run `testmate login --token <token>` first to create the config.
const path = require("path");
const { pathToFileURL } = require("url");
const fs = require("fs");
const { TOKENS_URL, applyConfigEnv } = require("../lib/config");

const configPath = applyConfigEnv(process.env);
if (!fs.existsSync(configPath)) {
  process.stderr.write(
    "TestMate 尚未登录：请在 " + TOKENS_URL + " 创建 Token，然后运行 " +
      "npx -y github:beansmile/testmate-cli login --token <token>\n" +
      "TestMate is not logged in: create a token at " + TOKENS_URL +
      " and run: npx -y github:beansmile/testmate-cli login --token <token>\n"
  );
}

// lib/server.mjs registers the upstream tools plus TestMate's verify/reject.
const entry = path.join(__dirname, "..", "lib", "server.mjs");

import(pathToFileURL(entry).href)
  .then((server) => server.runServer())
  .catch((error) => {
    process.stderr.write((error && error.message ? error.message : String(error)) + "\n");
    process.exit(1);
  });
