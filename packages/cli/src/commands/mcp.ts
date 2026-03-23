import { Command } from '@n8n/decorators';
import fs from 'fs';
import path from 'path';
import type { IWorkflowBase } from 'n8n-workflow';
import { jsonParse, UserError } from 'n8n-workflow';
import { z } from 'zod';

import { BaseCommand } from './base-command';

const flagsSchema = z.object({
	file: z.string().describe('Path to the .n8n workflow file to expose as an MCP tool').optional(),
});

@Command({
	name: 'mcp',
	description:
		'Starts an MCP (Model Context Protocol) server over stdio, exposing one or more .n8n ' +
		'workflow files as callable tools. The server reads JSON-RPC from stdin and writes to stdout. ' +
		'Designed to be used as an MCP server command in MCP client configurations.',
	examples: [
		'workflow.n8n',
		'workflow1.n8n workflow2.n8n workflow3.n8n',
		'--file=workflow.n8n',
		'/path/to/*.n8n',
	],
	flagsSchema,
})
export class Mcp extends BaseCommand<z.infer<typeof flagsSchema>> {
	override needsCommunityPackages = false;

	override needsTaskRunner = false;

	async init() {
		await super.init();
	}

	async run() {
		const { flags } = this;

		// Resolve file paths: collect from --file flag and positional args
		const filePaths = this.resolveAllFiles(flags.file);
		this.logStderr(`[mcp] Resolved ${filePaths.length} workflow file(s)`);

		if (filePaths.length === 0) {
			throw new UserError(
				'No workflow file specified. Usage: n8n mcp <file.n8n> [file2.n8n ...] or n8n mcp --file=<file.n8n>',
			);
		}

		// ── Step 1: Read and parse all .n8n workflow files ─────────────
		this.logStderr(`[mcp] ── STARTING MCP SERVER ──`);

		const workflows: Array<{ filePath: string; data: IWorkflowBase }> = [];

		for (const fileArg of filePaths) {
			const filePath = path.resolve(fileArg);
			this.logStderr(`[mcp] Loading: ${filePath}`);

			if (!fs.existsSync(filePath)) {
				throw new UserError(`[mcp] The workflow file does not exist: ${filePath}`);
			}

			try {
				const fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
				const workflowData = jsonParse<IWorkflowBase>(fileContent);
				this.logStderr(
					`[mcp]   ✓ "${workflowData.name}" (${workflowData.nodes?.length ?? 0} nodes)`,
				);
				workflows.push({ filePath, data: workflowData });
			} catch (error) {
				throw new UserError(
					`[mcp] Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		this.logStderr(`[mcp] Loaded ${workflows.length} workflow(s)`);

		// ── Step 2: Create the MCP server ──────────────────────────────
		this.logStderr(`[mcp] Creating MCP server...`);

		const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
		const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

		const serverPort = this.globalConfig.port;
		const serverUrl = `http://localhost:${serverPort}`;
		this.logStderr(`[mcp] n8n server URL: ${serverUrl}`);

		// Use first workflow name for single-file, generic name for multi-file
		const serverName =
			workflows.length === 1
				? workflows[0].data.name ||
					this.sanitizeToolName(path.basename(workflows[0].filePath, '.n8n'))
				: 'n8n MCP Server';

		const server = new McpServer({
			name: 'n8n MCP Server',
			version: '1.0.0',
		});

		// ── Step 3: Register each workflow as a tool ──────────────────
		const usedToolNames = new Set<string>();

		for (const { filePath, data: workflowData } of workflows) {
			let toolName = this.sanitizeToolName(workflowData.name || path.basename(filePath, '.n8n'));

			// Ensure uniqueness by appending a suffix if needed
			if (usedToolNames.has(toolName)) {
				let suffix = 2;
				while (usedToolNames.has(`${toolName}_${suffix}`)) suffix++;
				toolName = `${toolName}_${suffix}`;
			}
			usedToolNames.add(toolName);

			// Detect trigger type
			const triggerNode = workflowData.nodes?.find(
				(node) =>
					node.type.toLowerCase().includes('trigger') ||
					node.type.toLowerCase().includes('webhook') ||
					node.type === 'n8n-nodes-base.start',
			);
			const triggerType = triggerNode?.type ?? 'unknown';
			const isChatTrigger = triggerType === '@n8n/n8n-nodes-langchain.chatTrigger';

			this.logStderr(`[mcp] Registering tool "${toolName}" (trigger: ${triggerType})`);

			const inputSchemaShape = isChatTrigger
				? { input: z.string().describe('Input text for the chat workflow') }
				: { input: z.string().optional().describe('Input text or data for the workflow') };

			// Capture variables for the closure
			const wfData = workflowData;
			const wfIsChatTrigger = isChatTrigger;
			const wfToolName = toolName;

			server.registerTool(
				toolName,
				{
					description: `Execute the n8n workflow "${workflowData.name}". ${
						isChatTrigger
							? 'This is a chat-based workflow — provide input text.'
							: 'Provide optional input text for the workflow trigger.'
					}`,
					inputSchema: inputSchemaShape,
				},
				async (args: { input?: string }) => {
					return await this.executeWorkflowTool(
						wfToolName,
						wfData,
						wfIsChatTrigger,
						serverUrl,
						args,
					);
				},
			);
		}

		this.logStderr(
			`[mcp] Registered ${usedToolNames.size} tool(s): ${[...usedToolNames].join(', ')}`,
		);

		// ── Step 4: Start stdio transport ────────────────────────────
		this.logStderr(`[mcp] Connecting via stdio transport...`);
		const transport = new StdioServerTransport();
		await server.connect(transport);
		this.logStderr(`[mcp] ✅ MCP server is running. Waiting for requests on stdin...`);

		// Keep the process alive — the MCP client will close stdin when done
		await new Promise<void>((resolve) => {
			process.stdin.on('end', () => {
				this.logStderr(`[mcp] stdin closed. Shutting down.`);
				resolve();
			});
			process.stdin.on('close', () => {
				this.logStderr(`[mcp] stdin closed. Shutting down.`);
				resolve();
			});
		});

		this.logStderr(`[mcp] Server stopped.`);
	}

	/**
	 * Execute a workflow via the /rest/cli/run API and return an MCP tool result.
	 */
	private async executeWorkflowTool(
		toolName: string,
		workflowData: IWorkflowBase,
		isChatTrigger: boolean,
		serverUrl: string,
		args: { input?: string },
	) {
		this.logStderr(`[mcp] ── TOOL CALL: "${toolName}" ──`);
		this.logStderr(`[mcp] Input: ${JSON.stringify(args)}`);

		try {
			// Health check
			this.logStderr(`[mcp] Checking server health at ${serverUrl}...`);
			const healthResponse = await fetch(`${serverUrl}/rest/cli/health`);
			if (!healthResponse.ok) {
				throw new Error(`Health check returned ${healthResponse.status}`);
			}
			this.logStderr(`[mcp] Server is reachable.`);

			// Call the synchronous run API
			const executeUrl = `${serverUrl}/rest/cli/run`;
			this.logStderr(`[mcp] POST ${executeUrl}`);

			const requestBody: Record<string, unknown> = { workflowData };

			// Pass input based on trigger type
			if (args.input !== undefined) {
				if (isChatTrigger) {
					requestBody.chatInput = String(args.input);
				} else {
					// Try to parse as JSON object, fall back to chatInput string
					try {
						const parsed = JSON.parse(String(args.input));
						if (typeof parsed === 'object' && parsed !== null) {
							requestBody.inputData = parsed;
						} else {
							requestBody.chatInput = String(args.input);
						}
					} catch {
						requestBody.chatInput = String(args.input);
					}
				}
			}

			const response = await fetch(executeUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
			});

			this.logStderr(`[mcp] Response status: ${response.status} ${response.statusText}`);

			if (!response.ok) {
				const errorBody = await response.text();
				this.logStderr(`[mcp] API error: ${errorBody}`);
				return {
					content: [
						{
							type: 'text' as const,
							text: `Error executing workflow: ${response.status} ${response.statusText} — ${errorBody}`,
						},
					],
					isError: true,
				};
			}

			const result = (await response.json()) as {
				success: boolean;
				executionId?: string;
				status?: string;
				executionTime?: string;
				data?: {
					runData?: Record<
						string,
						Array<{
							data?: { main?: Array<Array<{ json: unknown }>> };
						}>
					>;
					lastNodeExecuted?: string;
					error?: unknown;
				};
				error?: string;
			};

			this.logStderr(
				`[mcp] Execution complete — success: ${result.success}, executionId: ${result.executionId ?? 'unknown'}, time: ${result.executionTime ?? '?'}s`,
			);

			// Extract the last node's output
			const lastNodeName = result.data?.lastNodeExecuted;
			const outputItems: unknown[] = [];

			if (lastNodeName && result.data?.runData?.[lastNodeName]) {
				const nodeRuns = result.data.runData[lastNodeName];
				const lastRun = nodeRuns[nodeRuns.length - 1];
				if (lastRun?.data?.main) {
					for (const branch of lastRun.data.main) {
						if (branch) {
							for (const item of branch) {
								outputItems.push(item.json);
							}
						}
					}
				}
			}

			this.logStderr(`[mcp] Output items: ${outputItems.length}`);

			if (!result.success) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `Workflow execution failed: ${result.error ?? JSON.stringify(result.data?.error ?? 'Unknown error')}`,
						},
					],
					isError: true,
				};
			}

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(outputItems.length === 1 ? outputItems[0] : outputItems, null, 2),
					},
				],
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.logStderr(`[mcp] Error: ${errorMsg}`);
			return {
				content: [{ type: 'text' as const, text: `Error: ${errorMsg}` }],
				isError: true,
			};
		}
	}

	/**
	 * Collect all workflow file paths from --file flag and positional arguments.
	 */
	private resolveAllFiles(flagFile?: string): string[] {
		const files: string[] = [];

		// Add --file flag value if provided
		if (flagFile) {
			this.logStderr(`[mcp] From --file flag: "${flagFile}"`);
			files.push(flagFile);
		}

		// Add positional arguments
		const positionalFiles = this.resolvePositionalFiles();
		for (const f of positionalFiles) {
			if (!files.includes(f)) {
				files.push(f);
			}
		}

		return files;
	}

	/**
	 * Resolve workflow files from positional arguments in process.argv.
	 * Returns all non-flag args after 'mcp'.
	 */
	private resolvePositionalFiles(): string[] {
		const argv = process.argv;
		const mcpIndex = argv.indexOf('mcp');
		if (mcpIndex === -1) return [];

		const files: string[] = [];
		for (let i = mcpIndex + 1; i < argv.length; i++) {
			const arg = argv[i];
			if (!arg.startsWith('--') && !arg.startsWith('-')) {
				this.logStderr(`[mcp] Found positional file argument: "${arg}"`);
				files.push(arg);
			}
		}
		return files;
	}

	/**
	 * Write log messages to stderr so they don't interfere with the
	 * MCP JSON-RPC protocol on stdout.
	 */
	private logStderr(message: string) {
		process.stderr.write(`${message}\n`);
	}

	/**
	 * Sanitize a workflow name to be a valid MCP tool name.
	 * Tool names should be lowercase with underscores, no spaces or special chars.
	 */
	private sanitizeToolName(name: string): string {
		return (
			name
				.toLowerCase()
				.replace(/[^a-z0-9_-]/g, '_')
				.replace(/_+/g, '_')
				.replace(/^_|_$/g, '') || 'n8n_workflow'
		);
	}

	async catch(error: Error) {
		this.logStderr(`[mcp] Fatal error: ${error.message}`);
		if (error.stack) this.logStderr(`[mcp] ${error.stack}`);
	}

	/**
	 * Override finally() to NOT call process.exit() on success.
	 * The MCP server needs to stay alive until the client disconnects.
	 */
	async finally(error: Error | undefined) {
		if (error) {
			await super.finally(error);
		}
		// On success, do NOT exit — keep the process running for MCP
	}
}
