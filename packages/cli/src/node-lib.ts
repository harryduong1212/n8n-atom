/**
 * n8n Node.js Library
 *
 * Provides a programmatic API for running n8n workflows from Node.js code.
 * Communicates with a running n8n server via the internal CLI API.
 *
 * Usage:
 *   import n8n from 'n8n';
 *   const result = await n8n.run('workflow.n8n', 'hello world');
 *   console.log(result);
 */
import fs from 'fs';
import path from 'path';

const LOG_PREFIX = '[n8n-lib]';

interface N8nRunOptions {
	/** Port of the running n8n server. Defaults to N8N_PORT env var or 5678. */
	port?: number;
	/** Base URL of the n8n server. Overrides port if provided. */
	baseUrl?: string;
}

/** Shape of the raw API response from /rest/cli/run */
interface N8nApiResponse {
	success: boolean;
	executionId?: string;
	status?: string;
	executionTime?: string;
	data?: {
		runData?: Record<
			string,
			Array<{
				executionStatus?: string;
				data?: { main?: Array<Array<{ json: unknown }>> };
			}>
		>;
		lastNodeExecuted?: string;
		error?: unknown;
	};
	error?: string;
}

/**
 * Run an n8n workflow file programmatically.
 *
 * @param filePath - Path to the .n8n workflow JSON file
 * @param input - Optional input string (used as chatInput for chat/webhook triggers)
 * @param options - Optional configuration (port, baseUrl)
 * @returns The output data from the last executed node (array of JSON items)
 */
async function run(filePath: string, input?: string, options?: N8nRunOptions): Promise<unknown[]> {
	console.log(`${LOG_PREFIX} ── RUN START ──`);
	console.log(`${LOG_PREFIX} filePath: "${filePath}"`);
	console.log(`${LOG_PREFIX} input: ${input !== undefined ? `"${input}"` : '(none)'}`);

	// ── Step 1: Resolve and read the workflow file ───────────────────
	const resolvedPath = path.resolve(filePath);
	console.log(`${LOG_PREFIX} Resolved path: "${resolvedPath}"`);

	if (!fs.existsSync(resolvedPath)) {
		const errorMsg = `Workflow file does not exist: ${resolvedPath}`;
		console.error(`${LOG_PREFIX} ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	let workflowData: Record<string, unknown>;
	try {
		const fileContent = fs.readFileSync(resolvedPath, { encoding: 'utf8' });
		workflowData = JSON.parse(fileContent) as Record<string, unknown>;
		console.log(`${LOG_PREFIX} Successfully parsed workflow file`);
		console.log(`${LOG_PREFIX}   Name: "${workflowData.name as string}"`);
		console.log(
			`${LOG_PREFIX}   Nodes: ${Array.isArray(workflowData.nodes) ? workflowData.nodes.length : 0}`,
		);
	} catch (error) {
		const errorMsg = `Failed to parse workflow file: ${error instanceof Error ? error.message : String(error)}`;
		console.error(`${LOG_PREFIX} ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	// ── Step 2: Determine server URL ────────────────────────────────
	let serverUrl: string;
	if (options?.baseUrl) {
		serverUrl = options.baseUrl.replace(/\/+$/, '');
		console.log(`${LOG_PREFIX} Using provided baseUrl: "${serverUrl}"`);
	} else {
		const port = options?.port ?? parseInt(process.env.N8N_PORT ?? '5888', 10);
		serverUrl = `http://localhost:${port}`;
		console.log(`${LOG_PREFIX} Using server URL: "${serverUrl}" (port: ${port})`);
	}

	// ── Step 3: Health check ────────────────────────────────────────
	const healthUrl = `${serverUrl}/rest/cli/health`;
	console.log(`${LOG_PREFIX} Health check: GET ${healthUrl}`);
	try {
		const healthResponse = await fetch(healthUrl);
		if (!healthResponse.ok) {
			throw new Error(`Health check returned status ${healthResponse.status}`);
		}
		console.log(`${LOG_PREFIX} Server is reachable`);
	} catch (error) {
		const errorMsg = `Cannot reach n8n server at ${serverUrl}. Is the server running? Error: ${error instanceof Error ? error.message : String(error)}`;
		console.error(`${LOG_PREFIX} ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	// ── Step 4: Call the synchronous run API ────────────────────────
	const runUrl = `${serverUrl}/rest/cli/run`;
	console.log(`${LOG_PREFIX} Executing workflow: POST ${runUrl}`);

	const requestBody = {
		workflowData,
		...(input !== undefined ? { chatInput: input } : {}),
	};

	let response: Response;
	try {
		response = await fetch(runUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(requestBody),
		});
		console.log(`${LOG_PREFIX} Response status: ${response.status} ${response.statusText}`);
	} catch (error) {
		const errorMsg = `Failed to call n8n API: ${error instanceof Error ? error.message : String(error)}`;
		console.error(`${LOG_PREFIX} ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	if (!response.ok) {
		const errorBody = await response.text();
		const errorMsg = `API error: ${response.status} ${response.statusText} — ${errorBody}`;
		console.error(`${LOG_PREFIX} ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	// ── Step 5: Parse result and extract last node output ───────────
	const apiResult = (await response.json()) as N8nApiResponse;

	console.log(`${LOG_PREFIX} ── RESULT ──`);
	console.log(`${LOG_PREFIX} Success: ${apiResult.success}`);
	console.log(`${LOG_PREFIX} Execution ID: ${apiResult.executionId ?? 'unknown'}`);
	console.log(`${LOG_PREFIX} Status: ${apiResult.status ?? 'unknown'}`);
	console.log(`${LOG_PREFIX} Execution time: ${apiResult.executionTime ?? '?'}s`);

	if (!apiResult.success) {
		const errorMsg = apiResult.error ?? 'Workflow execution failed';
		console.error(`${LOG_PREFIX} Execution error: ${errorMsg}`);
		throw new Error(String(errorMsg));
	}

	// Extract only the last node's output
	const lastNodeName = apiResult.data?.lastNodeExecuted;
	console.log(`${LOG_PREFIX} Last node executed: "${lastNodeName ?? 'unknown'}"`);

	if (!lastNodeName || !apiResult.data?.runData?.[lastNodeName]) {
		console.warn(`${LOG_PREFIX} No output data found for last node`);
		console.log(`${LOG_PREFIX} ── RUN END ──`);
		return [];
	}

	const lastNodeRuns = apiResult.data.runData[lastNodeName];
	const lastRun = lastNodeRuns[lastNodeRuns.length - 1];
	const outputItems: unknown[] = [];

	if (lastRun?.data?.main) {
		for (const branch of lastRun.data.main) {
			if (branch) {
				for (const item of branch) {
					outputItems.push(item.json);
				}
			}
		}
	}

	console.log(`${LOG_PREFIX} Output items: ${outputItems.length}`);
	console.log(`${LOG_PREFIX} ── RUN END ──`);
	return outputItems;
}

/** The n8n library API object */
const n8n = { run };

export default n8n;
export { run, type N8nRunOptions };
