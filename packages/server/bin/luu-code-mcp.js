#!/usr/bin/env node
// Runs the Luu Code MCP server on stdio. Nothing may be written to stdout other
// than protocol frames, so all logging goes to stderr.
import { runStdioServer } from "../dist/mcp/stdio.js";

runStdioServer().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
