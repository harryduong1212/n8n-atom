/**
 * Run Workflow — Execute an n8n workflow file via the n8n REST API.
 *
 * Lightweight equivalent of packages/cli/src/commands/run.ts.
 * Zero n8n dependencies — only uses built-in Node.js APIs (fs, path, fetch).
 */
import fs from 'fs';
import path from 'path';

const LOG_PREFIX = '[n8n-run]';

function log(msg) {
	console.error(`${LOG_PREFIX} ${msg}`);
}

/**
 * Run an n8n workflow file.
 *
 * @param {string} filePath - Path to the .n8n workflow file
 * @param {{ input?: string, port?: number, raw?: boolean }} [options]
 */
export async function runWorkflow(filePath, options = {}) {
	const { input, raw = false } = options;
	const port = options.port ?? parseInt(process.env.N8N_PORT ?? '5888', 10);
	const serverUrl = `http://localhost:${port}`;

	// ── Step 1: Read and parse the .n8n file ──────────────────────
	const resolvedPath = path.resolve(filePath);
	log(`── READING FILE ──`);
	log(`File path: ${resolvedPath}`);

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`The workflow file does not exist: ${resolvedPath}`);
	}

	const fileStat = fs.statSync(resolvedPath);
	log(`File size: ${fileStat.size} bytes, Last modified: ${fileStat.mtime.toISOString()}`);

	let fileData;
	try {
		const fileContent = fs.readFileSync(resolvedPath, { encoding: 'utf8' });
		fileData = JSON.parse(fileContent);
		log(`Successfully parsed workflow file.`);
		log(`  Name: "${fileData.name}"`);
		log(`  ID: "${fileData.id ?? 'none'}"`);
		log(`  Nodes (${fileData.nodes?.length ?? 0}):`);
		if (fileData.nodes && Array.isArray(fileData.nodes)) {
			for (const node of fileData.nodes) {
				log(`    - "${node.name}" (type: ${node.type}, version: ${node.typeVersion})`);
			}
		}
	} catch (error) {
		throw new Error(
			`Failed to parse workflow file: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// ── Step 2: Health check ─────────────────────────────────────
	log(`── EXECUTING ──`);
	log(`n8n server URL: ${serverUrl}`);

	try {
		const healthResponse = await fetch(`${serverUrl}/rest/cli/health`);
		if (!healthResponse.ok) {
			throw new Error(`Health check returned ${healthResponse.status}`);
		}
		log(`Server is reachable.`);
	} catch (error) {
		throw new Error(
			`Cannot reach n8n server at ${serverUrl}. Is the server running? Error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// ── Step 3: POST to the synchronous CLI API ──────────────────
	const executeUrl = `${serverUrl}/rest/cli/run`;
	log(`POST ${executeUrl}`);

	const requestBody = {
		workflowData: fileData,
	};

	// Pass input based on content: JSON objects → inputData, strings → chatInput
	if (input !== undefined) {
		try {
			const parsed = JSON.parse(input);
			if (typeof parsed === 'object' && parsed !== null) {
				requestBody.inputData = parsed;
			} else {
				requestBody.chatInput = String(input);
			}
		} catch {
			requestBody.chatInput = input;
		}
	}

	const response = await fetch(executeUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(requestBody),
	});

	log(`Response status: ${response.status} ${response.statusText}`);

	if (!response.ok) {
		const errorBody = await response.text();
		log(`API error response: ${errorBody}`);
		throw new Error(
			`Failed to execute workflow: ${response.status} ${response.statusText} — ${errorBody}`,
		);
	}

	// ── Step 4: Display results ──────────────────────────────────
	const result = await response.json();

	log(`── RESULTS ──`);
	log(
		`Execution ID: ${result.executionId ?? 'unknown'}, Status: ${result.status ?? 'unknown'}, Time: ${result.executionTime ?? '?'}s`,
	);

	if (result.success) {
		if (!raw) {
			log('✅ Execution was successful!');
			log('====================================');
		}
	} else {
		log('❌ Execution FAILED');
		log('====================================');
		if (result.error) {
			log(`Error: ${result.error}`);
		}
	}

	// Log per-node results
	if (result.data?.runData && !raw) {
		const runData = result.data.runData;
		const nodeNames = Object.keys(runData);
		log(`Nodes executed (${nodeNames.length}): ${nodeNames.join(' → ')}`);

		for (const [nodeName, nodeRuns] of Object.entries(runData)) {
			for (const nodeRun of nodeRuns) {
				const status = nodeRun.executionStatus ?? 'unknown';
				const time = nodeRun.executionTime ?? 0;
				log(`  ✅ "${nodeName}" — status: ${status}, time: ${time}ms`);

				if (nodeRun.data?.main) {
					for (const outputBranch of nodeRun.data.main) {
						if (outputBranch) {
							log(`    Output items: ${outputBranch.length}`);
							for (const item of outputBranch) {
								if (item.json) {
									log(`    → ${JSON.stringify(item.json)}`);
								}
							}
						}
					}
				}
			}
		}
	}

	// Output the full result as JSON to stdout
	console.log(JSON.stringify(result, null, 2));
	log(`Done.`);

	return result;
}
