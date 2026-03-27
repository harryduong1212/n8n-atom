/**
 * MCP Server — Exposes n8n workflow files as MCP tools over stdio.
 *
 * This module is the core logic for the n8n-mcp CLI. It:
 * 1. Reads .n8n workflow files
 * 2. Creates an MCP server with StdioServerTransport
 * 3. Registers each workflow as a tool
 * 4. Tool handlers call the n8n /rest/cli/run API
 *
 * Zero-build ESM module — no TypeScript compilation required.
 */
import fs from 'fs';
import path from 'path';

const LOG_PREFIX = '[n8n-mcp]';

function logStderr(msg) {
	process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

/**
 * Sanitize a workflow name to be a valid MCP tool name.
 */
function sanitizeToolName(name) {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '') || 'n8n_workflow'
	);
}

/**
 * Execute a workflow via the n8n /rest/cli/run API.
 */
async function executeWorkflow(toolName, workflowData, isChatTrigger, isSubFlowTrigger, serverUrl, args, workflowFilePath, fileModifiedAt) {
	logStderr(`── TOOL CALL: "${toolName}" ──`);
	logStderr(`Input: ${JSON.stringify(args)}`);

	try {
		// Health check
		logStderr(`Checking server health at ${serverUrl}...`);
		const healthResponse = await fetch(`${serverUrl}/rest/cli/health`);
		if (!healthResponse.ok) {
			throw new Error(`Health check returned ${healthResponse.status}`);
		}
		logStderr(`Server is reachable.`);

		// Call the synchronous run API
		const executeUrl = `${serverUrl}/rest/cli/run`;
		logStderr(`POST ${executeUrl}`);

		const requestBody = { workflowData, fileModifiedAt };

		if (isSubFlowTrigger) {
			// Sub-flow: args are already structured from Zod schema, pass directly as inputData
			// Merge default values for any missing fields
			const triggerNode = workflowData.nodes?.find(
				(n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger',
			);
			const workflowInputs = triggerNode?.parameters?.workflowInputs?.values ?? [];
			const mergedArgs = { ...args };
			for (const field of workflowInputs) {
				if (field.name && mergedArgs[field.name] === undefined && field.defaultValue !== undefined && field.defaultValue !== '') {
					mergedArgs[field.name] = field.defaultValue;
				}
			}
			requestBody.inputData = mergedArgs;
		} else if (args.input !== undefined) {
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

		// Auto-inject workflow filepath into inputData
		if (!requestBody.inputData) {
			requestBody.inputData = {};
		}
		if (workflowFilePath) {
			requestBody.inputData.__filepath = workflowFilePath;
			requestBody.inputData.__dirpath = path.dirname(workflowFilePath);
		}

		const response = await fetch(executeUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(requestBody),
		});

		logStderr(`Response status: ${response.status} ${response.statusText}`);

		if (!response.ok) {
			const errorBody = await response.text();
			logStderr(`API error: ${errorBody}`);
			return {
				content: [
					{
						type: 'text',
						text: `Error executing workflow: ${response.status} ${response.statusText} — ${errorBody}`,
					},
				],
				isError: true,
			};
		}

		const result = await response.json();

		logStderr(
			`Execution complete — success: ${result.success}, executionId: ${result.executionId ?? 'unknown'}, time: ${result.executionTime ?? '?'}s`,
		);

		// Extract the last node's output
		const lastNodeName = result.data?.lastNodeExecuted;
		const outputItems = [];

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

		logStderr(`Output items: ${outputItems.length}`);

		// Sync workflow back to file if server had newer version
		if (result.syncedWorkflow && workflowFilePath) {
			logStderr(`Server had a newer workflow version — updating file: ${workflowFilePath}`);
			const syncedData = result.syncedWorkflow;
			// Strip runtime-injected __filepath and __dirpath from pinData
			if (syncedData.pinData && typeof syncedData.pinData === 'object') {
				for (const items of Object.values(syncedData.pinData)) {
					if (Array.isArray(items)) {
						for (const item of items) {
							if (item.json) {
								delete item.json.__filepath;
								delete item.json.__dirpath;
							}
						}
					}
				}
			}
			const fileContent = JSON.stringify(syncedData, null, 2) + '\n';
			fs.writeFileSync(workflowFilePath, fileContent, { encoding: 'utf8' });
			logStderr(`File updated with server workflow.`);
		}

		if (!result.success) {
			return {
				content: [
					{
						type: 'text',
						text: `Workflow execution failed: ${result.error ?? JSON.stringify(result.data?.error ?? 'Unknown error')}`,
					},
				],
				isError: true,
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(outputItems.length === 1 ? outputItems[0] : outputItems, null, 2),
				},
			],
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logStderr(`Error: ${errorMsg}`);
		return {
			content: [{ type: 'text', text: `Error: ${errorMsg}` }],
			isError: true,
		};
	}
}

/**
 * Start the MCP server with the given workflow files.
 *
 * @param {string[]} filePaths - Paths to .n8n workflow files
 * @param {{ port?: number }} [options] - Options
 */
export async function startMcpServer(filePaths, options = {}) {
	const { z } = await import('zod');
	const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
	const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

	const port = options.port ?? parseInt(process.env.N8N_PORT ?? '5888', 10);
	const serverUrl = `http://localhost:${port}`;

	logStderr(`── STARTING MCP SERVER ──`);
	logStderr(`n8n server URL: ${serverUrl}`);

	// ── Step 1: Load all workflow files ───────────────────────────
	const workflows = [];

	for (const fileArg of filePaths) {
		const filePath = path.resolve(fileArg);
		logStderr(`Loading: ${filePath}`);

		if (!fs.existsSync(filePath)) {
			throw new Error(`Workflow file does not exist: ${filePath}`);
		}

		try {
			const fileStat = fs.statSync(filePath);
			const fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
			const workflowData = JSON.parse(fileContent);
			logStderr(`  ✓ "${workflowData.name}" (${workflowData.nodes?.length ?? 0} nodes)`);
			workflows.push({ filePath, data: workflowData, fileModifiedAt: fileStat.mtime.toISOString() });
		} catch (error) {
			throw new Error(
				`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	logStderr(`Loaded ${workflows.length} workflow(s)`);

	// ── Step 2: Create MCP server ────────────────────────────────
	const serverName =
		workflows.length === 1
			? workflows[0].data.name || sanitizeToolName(path.basename(workflows[0].filePath, '.n8n'))
			: 'n8n MCP Server';

	const server = new McpServer({
		name: serverName,
		version: '1.0.0',
	});

	// ── Step 3: Register each workflow as a tool ─────────────────
	const usedToolNames = new Set();

	for (const { filePath, data: workflowData, fileModifiedAt } of workflows) {
		let toolName = sanitizeToolName(workflowData.name || path.basename(filePath, '.n8n'));

		// Ensure uniqueness
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
		const isSubFlowTrigger = triggerType === 'n8n-nodes-base.executeWorkflowTrigger';

		logStderr(`Registering tool "${toolName}" (trigger: ${triggerType})`);

		// Build input schema based on trigger type
		let inputSchemaShape;
		let description;

		if (isSubFlowTrigger) {
			// Extract workflowInputs from the trigger node parameters
			const workflowInputs = triggerNode.parameters?.workflowInputs?.values ?? [];
			inputSchemaShape = {};

			for (const field of workflowInputs) {
				const name = field.name;
				if (!name) continue;

				let zodType;
				switch (field.type) {
					case 'number':
						zodType = z.number();
						break;
					case 'boolean':
						zodType = z.boolean();
						break;
					default:
						zodType = z.string();
				}

				if (field.defaultValue !== undefined && field.defaultValue !== '') {
					zodType = zodType.optional().describe(`${name} (default: ${field.defaultValue})`);
				} else {
					zodType = zodType.describe(name);
				}
				inputSchemaShape[name] = zodType;
			}

			// Fallback: if no workflowInputs defined, use generic input
			if (Object.keys(inputSchemaShape).length === 0) {
				inputSchemaShape = { input: z.string().optional().describe('Input data for the workflow') };
			}

			description = `Execute the n8n workflow "${workflowData.name}". Provide the required input parameters.`;
			logStderr(`  Sub-flow inputs: ${workflowInputs.map((f) => f.name).join(', ') || '(none)'}`);
		} else if (isChatTrigger) {
			inputSchemaShape = { input: z.string().describe('Input text for the chat workflow') };
			description = `Execute the n8n workflow "${workflowData.name}". This is a chat-based workflow — provide input text.`;
		} else {
			inputSchemaShape = { input: z.string().optional().describe('Input text or data for the workflow trigger') };
			description = `Execute the n8n workflow "${workflowData.name}". Provide optional input text for the workflow trigger.`;
		}

		// Capture for closure
		const wfData = workflowData;
		const wfIsChatTrigger = isChatTrigger;
		const wfIsSubFlowTrigger = isSubFlowTrigger;
		const wfToolName = toolName;
		const wfFilePath = filePath;
		const wfFileModifiedAt = fileModifiedAt;

		server.registerTool(
			toolName,
			{
				description,
				inputSchema: inputSchemaShape,
			},
			async (args) => {
				return await executeWorkflow(wfToolName, wfData, wfIsChatTrigger, wfIsSubFlowTrigger, serverUrl, args, wfFilePath, wfFileModifiedAt);
			},
		);
	}

	logStderr(`Registered ${usedToolNames.size} tool(s): ${[...usedToolNames].join(', ')}`);

	// ── Step 4: Start stdio transport ────────────────────────────
	logStderr(`Connecting via stdio transport...`);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logStderr(`✅ MCP server is running. Waiting for requests on stdin...`);

	// Keep process alive until client disconnects
	await new Promise((resolve) => {
		process.stdin.on('end', () => {
			logStderr(`stdin closed. Shutting down.`);
			resolve();
		});
		process.stdin.on('close', () => {
			logStderr(`stdin closed. Shutting down.`);
			resolve();
		});
	});

	logStderr(`Server stopped.`);
}
