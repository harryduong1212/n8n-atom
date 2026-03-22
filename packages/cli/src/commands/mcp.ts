import { Command } from '@n8n/decorators';
import fs from 'fs';
import path from 'path';
import type { IWorkflowBase } from 'n8n-workflow';
import { jsonParse, UserError } from 'n8n-workflow';
import { z } from 'zod';

import { BaseCommand } from './base-command';

const flagsSchema = z.object({
	file: z.string().describe('Path to the .n8n workflow file to expose as an MCP tool'),
});

@Command({
	name: 'mcp',
	description:
		'Starts an MCP (Model Context Protocol) server over stdio, exposing a .n8n workflow file ' +
		'as a callable tool. The server reads JSON-RPC from stdin and writes to stdout. ' +
		'Designed to be used as an MCP server command in MCP client configurations.',
	examples: ['--file=workflow.n8n', '--file=/path/to/my-workflow.n8n'],
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

		if (!flags.file) {
			throw new UserError('The --file flag is required. Provide a path to the .n8n workflow file.');
		}

		// ── Step 1: Read and parse the .n8n workflow file ──────────────
		const filePath = path.resolve(flags.file);
		this.logStderr(`[mcp] ── STARTING MCP SERVER ──`);
		this.logStderr(`[mcp] Workflow file: ${filePath}`);

		if (!fs.existsSync(filePath)) {
			throw new UserError(`[mcp] The workflow file does not exist: ${filePath}`);
		}

		let workflowData: IWorkflowBase;
		try {
			const fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
			workflowData = jsonParse<IWorkflowBase>(fileContent);
			this.logStderr(`[mcp] Parsed workflow: "${workflowData.name}"`);
			this.logStderr(`[mcp]   ID: "${workflowData.id ?? 'none'}"`);
			this.logStderr(`[mcp]   Nodes: ${workflowData.nodes?.length ?? 0}`);
		} catch (error) {
			throw new UserError(
				`[mcp] Failed to parse workflow file: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// ── Step 2: Determine the tool name and description ───────────
		const toolName = this.sanitizeToolName(workflowData.name || path.basename(filePath, '.n8n'));
		this.logStderr(`[mcp] Tool name: "${toolName}"`);

		// Detect trigger type to build appropriate input schema
		const triggerNode = workflowData.nodes?.find(
			(node) =>
				node.type.toLowerCase().includes('trigger') ||
				node.type.toLowerCase().includes('webhook') ||
				node.type === 'n8n-nodes-base.start',
		);

		const triggerType = triggerNode?.type ?? 'unknown';
		this.logStderr(`[mcp] Trigger node: "${triggerNode?.name ?? 'none'}" (type: ${triggerType})`);

		const isChatTrigger = triggerType === '@n8n/n8n-nodes-langchain.chatTrigger';

		// ── Step 3: Create the MCP server ──────────────────────────────
		this.logStderr(`[mcp] Creating MCP server...`);

		const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
		const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

		const serverPort = this.globalConfig.port;
		const serverUrl = `http://localhost:${serverPort}`;
		this.logStderr(`[mcp] n8n server URL: ${serverUrl}`);

		const server = new McpServer({
			name: `${workflowData.name || toolName}`,
			version: '1.0.0',
		});

		// ── Step 4: Register the workflow as a tool ───────────────────
		const inputSchemaShape = isChatTrigger
			? { input: z.string().describe('Input text for the chat workflow') }
			: { input: z.string().optional().describe('Input text or data for the workflow') };

		this.logStderr(`[mcp] Registering tool "${toolName}"...`);

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

					const requestBody: Record<string, unknown> = {
						workflowData,
					};

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
								text: JSON.stringify(
									outputItems.length === 1 ? outputItems[0] : outputItems,
									null,
									2,
								),
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
			},
		);

		// ── Step 5: Start stdio transport ────────────────────────────
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
