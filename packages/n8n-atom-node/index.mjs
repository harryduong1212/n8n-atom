/**
 * @atom8n/n8n-lib — Lightweight client for running n8n workflows.
 *
 * Zero dependencies. Uses only built-in Node.js APIs (fs, path, fetch).
 *
 * Usage:
 *   import n8n from '@atom8n/n8n-lib';
 *   const result = await n8n.run('workflow.n8n', { text: 'hello' });
 *   console.log(result);
 */
import fs from 'fs';
import path from 'path';

const LOG_PREFIX = '[n8n-lib]';

/**
 * Run an n8n workflow file programmatically.
 *
 * @param {string} filePath - Path to the .n8n workflow JSON file
 * @param {string|object} [input] - Optional input: string (chatInput) or object (injected as trigger data)
 * @param {boolean} [debug=false] - Enable debug logging
 * @param {{ port?: number, baseUrl?: string }} [options] - Optional configuration
 * @returns {Promise<object[]>} The output data from the last executed node
 */
async function run(filePath, input, debug = false, options) {
	const log = (...args) => {
		if (debug) console.log(LOG_PREFIX, ...args);
	};
	const logError = (...args) => {
		if (debug) console.error(LOG_PREFIX, ...args);
	};
	const logWarn = (...args) => {
		if (debug) console.warn(LOG_PREFIX, ...args);
	};

	log('── RUN START ──');
	log(`filePath: "${filePath}"`);
	log(`input: ${input !== undefined ? JSON.stringify(input) : '(none)'}`);

	// ── Step 1: Resolve and read the workflow file ───────────────────
	const resolvedPath = path.resolve(filePath);
	log(`Resolved path: "${resolvedPath}"`);

	if (!fs.existsSync(resolvedPath)) {
		const errorMsg = `Workflow file does not exist: ${resolvedPath}`;
		logError(`ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	let workflowData;
	try {
		const fileContent = fs.readFileSync(resolvedPath, { encoding: 'utf8' });
		workflowData = JSON.parse(fileContent);
		log('Successfully parsed workflow file');
		log(`  Name: "${workflowData.name}"`);
		log(`  Nodes: ${Array.isArray(workflowData.nodes) ? workflowData.nodes.length : 0}`);
	} catch (error) {
		const errorMsg = `Failed to parse workflow file: ${error instanceof Error ? error.message : String(error)}`;
		logError(`ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	// ── Step 2: Determine server URL ────────────────────────────────
	let serverUrl;
	if (options?.baseUrl) {
		serverUrl = options.baseUrl.replace(/\/+$/, '');
		log(`Using provided baseUrl: "${serverUrl}"`);
	} else {
		const port = options?.port ?? parseInt(process.env.N8N_PORT ?? '5888', 10);
		serverUrl = `http://localhost:${port}`;
		log(`Using server URL: "${serverUrl}" (port: ${port})`);
	}

	// ── Step 3: Health check ────────────────────────────────────────
	const healthUrl = `${serverUrl}/rest/cli/health`;
	log(`Health check: GET ${healthUrl}`);
	try {
		const healthResponse = await fetch(healthUrl);
		if (!healthResponse.ok) {
			throw new Error(`Health check returned status ${healthResponse.status}`);
		}
		log('Server is reachable');
	} catch (error) {
		const errorMsg = `Cannot reach n8n server at ${serverUrl}. Is the server running? Error: ${error instanceof Error ? error.message : String(error)}`;
		logError(`ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	// ── Step 4: Call the synchronous run API ────────────────────────
	const runUrl = `${serverUrl}/rest/cli/run`;
	log(`Executing workflow: POST ${runUrl}`);

	const requestBody = { workflowData };
	if (input !== undefined) {
		if (typeof input === 'string') {
			requestBody.chatInput = input;
		} else {
			requestBody.inputData = input;
		}
	}
	log(`Request body keys: ${Object.keys(requestBody).join(', ')}`);

	let response;
	try {
		response = await fetch(runUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(requestBody),
		});
		log(`Response status: ${response.status} ${response.statusText}`);
	} catch (error) {
		const errorMsg = `Failed to call n8n API: ${error instanceof Error ? error.message : String(error)}`;
		logError(`ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	if (!response.ok) {
		const errorBody = await response.text();
		const errorMsg = `API error: ${response.status} ${response.statusText} — ${errorBody}`;
		logError(`ERROR: ${errorMsg}`);
		throw new Error(errorMsg);
	}

	// ── Step 5: Parse result and extract last node output ───────────
	const apiResult = await response.json();

	log('── RESULT ──');
	log(`Success: ${apiResult.success}`);
	log(`Execution ID: ${apiResult.executionId ?? 'unknown'}`);
	log(`Status: ${apiResult.status ?? 'unknown'}`);
	log(`Execution time: ${apiResult.executionTime ?? '?'}s`);

	if (!apiResult.success) {
		const errorMsg = apiResult.error ?? 'Workflow execution failed';
		logError(`Execution error: ${errorMsg}`);
		throw new Error(String(errorMsg));
	}

	// Extract only the last node's output
	const lastNodeName = apiResult.data?.lastNodeExecuted;
	log(`Last node executed: "${lastNodeName ?? 'unknown'}"`);

	if (!lastNodeName || !apiResult.data?.runData?.[lastNodeName]) {
		logWarn('No output data found for last node');
		log('── RUN END ──');
		return [];
	}

	const lastNodeRuns = apiResult.data.runData[lastNodeName];
	const lastRun = lastNodeRuns[lastNodeRuns.length - 1];
	const outputItems = [];

	if (lastRun?.data?.main) {
		for (const branch of lastRun.data.main) {
			if (branch) {
				for (const item of branch) {
					outputItems.push(item.json);
				}
			}
		}
	}

	log(`Output items: ${outputItems.length}`);
	log('── RUN END ──');
	return outputItems;
}

/** The n8n library API object */
const n8n = { run };

export default n8n;
export { run };
