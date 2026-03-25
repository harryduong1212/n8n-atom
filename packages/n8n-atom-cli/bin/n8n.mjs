#!/usr/bin/env node

/**
 * n8n — Lightweight CLI for n8n workflows.
 *
 * Subcommands:
 *   n8n mcp <file.n8n> [file2.n8n ...]   Start an MCP server
 *   n8n run <file.n8n> [--input="..."]    Run a workflow
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const subcommand = process.argv[2];

if (!subcommand || subcommand === '--help' || subcommand === '-h') {
	console.log(`
n8n — Lightweight CLI for n8n workflows

USAGE
  n8n <command> [options]

COMMANDS
  mcp <file.n8n> [...]       Start an MCP server exposing workflow(s) as tools
  run <file.n8n> [options]   Run a workflow and return the result

Run "n8n <command> --help" for command-specific help.
`);
	process.exit(0);
}

// Rewrite argv: remove the subcommand so child scripts see clean positional args
// "n8n mcp foo.n8n" → argv becomes [node, n8n.mjs, foo.n8n]
process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

switch (subcommand) {
	case 'mcp': {
		const { startMcpServer } = await import(pathToFileURL(join(__dirname, '..', 'mcp-server.mjs')).href);

		// Parse mcp-specific args from the rewritten argv
		const args = process.argv.slice(2);
		const files = [];
		let port = undefined;

		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === '--help' || arg === '-h') {
				console.log(`
n8n mcp — Expose n8n workflow files as MCP servers

USAGE
  n8n mcp <file.n8n> [file2.n8n ...]
  n8n mcp --port=5888 workflow.n8n

OPTIONS
  --port <number>   Port of the running n8n server (default: N8N_PORT env or 5888)
  --help, -h        Show this help message
`);
				process.exit(0);
			}
			if (arg.startsWith('--port=')) { port = parseInt(arg.split('=')[1], 10); continue; }
			if (arg === '--port') { port = parseInt(args[++i], 10); continue; }
			if (arg.startsWith('-')) continue;
			files.push(arg);
		}

		if (files.length === 0) {
			console.error('[n8n-mcp] Error: No workflow file(s) specified.');
			console.error('Usage: n8n mcp <file.n8n> [file2.n8n ...]');
			process.exit(1);
		}

		startMcpServer(files, { port }).catch((e) => {
			console.error(`[n8n-mcp] Fatal: ${e.message}`);
			process.exit(1);
		});
		break;
	}
	case 'run': {
		const { runWorkflow } = await import(pathToFileURL(join(__dirname, '..', 'run-workflow.mjs')).href);

		const args = process.argv.slice(2);
		let file = undefined;
		let input = undefined;
		let port = undefined;
		let raw = false;

		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === '--help' || arg === '-h') {
				console.log(`
n8n run — Run n8n workflow files

USAGE
  n8n run <file.n8n> [options]

OPTIONS
  --input <text>    Input text for chat/webhook trigger workflows
  --raw             Output only JSON data, with no other text
  --port <number>   Port of the running n8n server (default: N8N_PORT env or 5888)
  --help, -h        Show this help message
`);
				process.exit(0);
			}
			if (arg === '--raw') { raw = true; continue; }
			if (arg.startsWith('--input=')) { input = arg.substring('--input='.length); continue; }
			if (arg === '--input') { input = args[++i]; continue; }
			if (arg.startsWith('--port=')) { port = parseInt(arg.split('=')[1], 10); continue; }
			if (arg === '--port') { port = parseInt(args[++i], 10); continue; }
			if (arg.startsWith('-')) continue;
			if (!file) file = arg;
			else if (!input) input = arg;
		}

		if (!file) {
			console.error('[n8n-run] Error: No workflow file specified.');
			console.error('Usage: n8n run <file.n8n> [--input="..."]');
			process.exit(1);
		}

		runWorkflow(file, { input, port, raw }).catch((e) => {
			console.error(`[n8n-run] Fatal: ${e.message}`);
			process.exit(1);
		});
		break;
	}
	default:
		console.error(`Unknown command: "${subcommand}"`);
		console.error('Run "n8n --help" to see available commands.');
		process.exit(1);
}
