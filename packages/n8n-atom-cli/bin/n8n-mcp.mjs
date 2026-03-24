#!/usr/bin/env node

/**
 * n8n-mcp — Lightweight CLI to expose n8n workflow files as MCP servers.
 *
 * Usage:
 *   n8n-mcp workflow.n8n
 *   n8n-mcp workflow1.n8n workflow2.n8n
 *   n8n-mcp --port=5888 workflow.n8n
 *   n8n-mcp --help
 */

import { startMcpServer } from '../mcp-server.mjs';

const LOG_PREFIX = '[n8n-mcp]';

function logStderr(msg) {
	process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

function printHelp() {
	console.log(`
n8n-mcp — Expose n8n workflow files as MCP (Model Context Protocol) servers

USAGE
  n8n-mcp <file.n8n> [file2.n8n ...]
  n8n-mcp --port=5888 workflow.n8n

OPTIONS
  --port <number>   Port of the running n8n server (default: N8N_PORT env or 5888)
  --help, -h        Show this help message

EXAMPLES
  n8n-mcp workflow.n8n
  n8n-mcp mcp-logger.n8n mcp-curl.n8n
  n8n-mcp --port=5888 workflow.n8n
`);
}

// ── Parse arguments ──────────────────────────────────────────────
const args = process.argv.slice(2);
const files = [];
let port = undefined;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];

	if (arg === '--help' || arg === '-h') {
		printHelp();
		process.exit(0);
	}

	if (arg.startsWith('--port=')) {
		port = parseInt(arg.split('=')[1], 10);
		continue;
	}

	if (arg === '--port') {
		port = parseInt(args[++i], 10);
		continue;
	}

	// Skip other flags
	if (arg.startsWith('-')) {
		logStderr(`Unknown flag: ${arg}`);
		continue;
	}

	// Positional argument = workflow file
	files.push(arg);
}

if (files.length === 0) {
	logStderr('Error: No workflow file(s) specified.');
	logStderr('Usage: n8n-mcp <file.n8n> [file2.n8n ...]');
	logStderr('Run "n8n-mcp --help" for more information.');
	process.exit(1);
}

// ── Start MCP server ─────────────────────────────────────────────
logStderr(`Starting MCP server with ${files.length} workflow file(s)...`);

startMcpServer(files, { port }).catch((error) => {
	logStderr(`Fatal error: ${error.message}`);
	if (error.stack) logStderr(error.stack);
	process.exit(1);
});
