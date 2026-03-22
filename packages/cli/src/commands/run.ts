import { Command } from '@n8n/decorators';
import fs from 'fs';
import path from 'path';
import type { IWorkflowBase } from 'n8n-workflow';
import { ExecutionBaseError, jsonParse, UserError } from 'n8n-workflow';
import { z } from 'zod';

import { BaseCommand } from './base-command';

const flagsSchema = z.object({
	file: z.string().describe('Path to the .n8n workflow file to run'),
	rawOutput: z.boolean().describe('Outputs only JSON data, with no other text').optional(),
	input: z.string().describe('Input text for chat/webhook trigger workflows').optional(),
});

@Command({
	name: 'run',
	description:
		'Syncs a .n8n workflow file to the server and executes it synchronously. ' +
		'Returns the full execution result including per-node outputs.',
	examples: [
		'--file=workflow.n8n',
		'--file=/path/to/workflow.n8n --input="Hello"',
		'--file=workflow.n8n --rawOutput',
	],
	flagsSchema,
})
export class Run extends BaseCommand<z.infer<typeof flagsSchema>> {
	override needsCommunityPackages = false;

	override needsTaskRunner = false;

	async init() {
		await super.init();
	}

	async run() {
		const { flags } = this;

		if (!flags.file) {
			throw new UserError(
				'The --file flag is required. Please provide a path to the .n8n workflow file.',
			);
		}

		// ── Step 1: Read and parse the .n8n file ──────────────────────────
		const filePath = path.resolve(flags.file);
		this.logger.info(`[run] ── READING FILE ──`);
		this.logger.info(`[run] File path: ${filePath}`);

		if (!fs.existsSync(filePath)) {
			throw new UserError(`[run] The workflow file does not exist: ${filePath}`);
		}

		const fileStat = fs.statSync(filePath);
		this.logger.info(
			`[run] File size: ${fileStat.size} bytes, Last modified: ${fileStat.mtime.toISOString()}`,
		);

		let fileData: IWorkflowBase;
		try {
			const fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
			fileData = jsonParse<IWorkflowBase>(fileContent);
			this.logger.info(`[run] Successfully parsed workflow file.`);
			this.logger.info(`[run]   Name: "${fileData.name}"`);
			this.logger.info(`[run]   ID: "${fileData.id ?? 'none'}"`);
			this.logger.info(`[run]   Nodes (${fileData.nodes?.length ?? 0}):`);
			if (fileData.nodes && Array.isArray(fileData.nodes)) {
				for (const node of fileData.nodes) {
					this.logger.info(
						`[run]     - "${node.name}" (type: ${node.type}, version: ${node.typeVersion})`,
					);
				}
			}
		} catch (error) {
			throw new UserError(
				`[run] Failed to parse workflow file: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// ── Step 2: POST to the synchronous CLI API ─────────────────────
		const serverPort = this.globalConfig.port;
		const serverUrl = `http://localhost:${serverPort}`;
		this.logger.info(`[run] ── EXECUTING ──`);
		this.logger.info(`[run] n8n server URL: ${serverUrl}`);

		// Health check
		try {
			const healthResponse = await fetch(`${serverUrl}/rest/cli/health`);
			if (!healthResponse.ok) {
				throw new Error(`Health check returned ${healthResponse.status}`);
			}
			this.logger.info(`[run] Server is reachable.`);
		} catch (error) {
			throw new UserError(
				`[run] Cannot reach n8n server at ${serverUrl}. Is the server running? Error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// Call the synchronous run API
		const executeUrl = `${serverUrl}/rest/cli/run`;
		this.logger.info(`[run] POST ${executeUrl}`);

		const response = await fetch(executeUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workflowData: fileData,
				chatInput: flags.input,
			}),
		});

		this.logger.info(`[run] Response status: ${response.status} ${response.statusText}`);

		if (!response.ok) {
			const errorBody = await response.text();
			this.logger.error(`[run] API error response: ${errorBody}`);
			throw new UserError(
				`[run] Failed to execute workflow: ${response.status} ${response.statusText} — ${errorBody}`,
			);
		}

		// ── Step 3: Display results ─────────────────────────────────────
		const result = (await response.json()) as {
			success: boolean;
			executionId?: string;
			status?: string;
			executionTime?: string;
			data?: {
				runData?: Record<
					string,
					Array<{
						executionStatus?: string;
						executionTime?: number;
						data?: { main?: Array<Array<{ json: unknown }>> };
					}>
				>;
				error?: unknown;
			};
			error?: string;
		};

		this.logger.info(`[run] ── RESULTS ──`);
		this.logger.info(
			`[run] Execution ID: ${result.executionId ?? 'unknown'}, Status: ${result.status ?? 'unknown'}, Time: ${result.executionTime ?? '?'}s`,
		);

		if (result.success) {
			if (flags.rawOutput === undefined) {
				this.logger.info('[run] ✅ Execution was successful!');
				this.logger.info('====================================');
			}
		} else {
			this.logger.error(`[run] ❌ Execution FAILED`);
			this.logger.error('====================================');
			if (result.error) {
				this.logger.error(`[run] Error: ${result.error}`);
			}
		}

		// Log per-node results
		if (result.data?.runData) {
			const runData = result.data.runData;
			const nodeNames = Object.keys(runData);
			this.logger.info(`[run] Nodes executed (${nodeNames.length}): ${nodeNames.join(' → ')}`);

			for (const [nodeName, nodeRuns] of Object.entries(runData)) {
				for (const nodeRun of nodeRuns) {
					const status = nodeRun.executionStatus ?? 'unknown';
					const time = nodeRun.executionTime ?? 0;
					this.logger.info(`[run]   ✅ "${nodeName}" — status: ${status}, time: ${time}ms`);

					if (nodeRun.data?.main) {
						for (const outputBranch of nodeRun.data.main) {
							if (outputBranch) {
								this.logger.info(`[run]     Output items: ${outputBranch.length}`);
								for (const item of outputBranch) {
									if (item.json) {
										this.logger.info(`[run]     → ${JSON.stringify(item.json)}`);
									}
								}
							}
						}
					}
				}
			}
		}

		// Output the full result as JSON
		this.log(JSON.stringify(result, null, 2));
		this.logger.info(`[run] Done.`);
	}

	async catch(error: Error) {
		this.logger.error('[run] Error executing workflow. See log messages for details.');
		this.logger.error('[run] Execution error:');
		this.logger.info('====================================');
		this.logger.error(error.message);
		if (error instanceof ExecutionBaseError) this.logger.error(error.description!);
		if (error.stack) this.logger.error(error.stack);
	}
}
