#!/usr/bin/env node

/**
 * n8n-run — Lightweight CLI to run n8n workflow files.
 *
 * Usage:
 *   n8n-run workflow.n8n
 *   n8n-run workflow.n8n --input="Hello world"
 *   n8n-run --port=5888 workflow.n8n --raw
 *   n8n-run --help
 */

import { runWorkflow } from '../run-workflow.mjs';

const LOG_PREFIX = '[n8n-run]';

function log(msg) {
	console.error(`${LOG_PREFIX} ${msg}`);
}

function printHelp() {
	console.log(`
n8n-run — Run n8n workflow files from the command line

USAGE
  n8n-run <file.n8n> [options]

OPTIONS
  --input <text>    Input text for chat/webhook trigger workflows
  --raw             Output only JSON data, with no other text
  --port <number>   Port of the running n8n server (default: N8N_PORT env or 5888)
  --help, -h        Show this help message

EXAMPLES
  n8n-run workflow.n8n
  n8n-run workflow.n8n --input="Hello world"
  n8n-run workflow.n8n --raw
  n8n-run --port=5888 workflow.n8n
`);
}

// ── Parse arguments ──────────────────────────────────────────────
const args = process.argv.slice(2);
let file = undefined;
let input = undefined;
let port = undefined;
let raw = false;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];

	if (arg === '--help' || arg === '-h') {
		printHelp();
		process.exit(0);
	}

	if (arg === '--raw') {
		raw = true;
		continue;
	}

	if (arg.startsWith('--input=')) {
		input = arg.substring('--input='.length);
		continue;
	}
	if (arg === '--input') {
		input = args[++i];
		continue;
	}

	if (arg.startsWith('--port=')) {
		port = parseInt(arg.split('=')[1], 10);
		continue;
	}
	if (arg === '--port') {
		port = parseInt(args[++i], 10);
		continue;
	}

	// Skip unknown flags
	if (arg.startsWith('-')) {
		log(`Unknown flag: ${arg}`);
		continue;
	}

	// First positional argument = workflow file, second = input
	if (!file) {
		file = arg;
	} else if (!input) {
		input = arg;
	}
}

if (!file) {
	log('Error: No workflow file specified.');
	log('Usage: n8n-run <file.n8n> [--input="..."]');
	log('Run "n8n-run --help" for more information.');
	process.exit(1);
}

// ── Run workflow ─────────────────────────────────────────────────
runWorkflow(file, { input, port, raw }).catch((error) => {
	log(`Fatal error: ${error.message}`);
	if (error.stack) log(error.stack);
	process.exit(1);
});
