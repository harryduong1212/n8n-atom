import {
	WorkflowRepository,
	SharedWorkflowRepository,
	ProjectRepository,
	ExecutionRepository,
	generateNanoId,
} from '@n8n/db';
import { Command } from '@n8n/decorators';
import { Container } from '@n8n/di';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { IWorkflowBase } from 'n8n-workflow';
import { ExecutionBaseError, jsonParse, UserError } from 'n8n-workflow';
import { z } from 'zod';

import { OwnershipService } from '@/services/ownership.service';
import { isWorkflowIdValid } from '@/utils';

import { BaseCommand } from './base-command';

const flagsSchema = z.object({
	file: z.string().describe('Path to the .n8n workflow file to run'),
	rawOutput: z.boolean().describe('Outputs only JSON data, with no other text').optional(),
	input: z.string().describe('Input text for chat/webhook trigger workflows').optional(),
});

@Command({
	name: 'run',
	description:
		'Syncs a .n8n workflow file to the server and executes it. ' +
		'If a workflow with the same ID or name exists, it compares timestamps and updates if the file is newer. ' +
		'Otherwise, it creates a new workflow. Then executes the workflow via the running n8n server and returns the output.',
	examples: ['--file=workflow.n8n', '--file=/path/to/workflow.n8n --rawOutput'],
	flagsSchema,
})
export class Run extends BaseCommand<z.infer<typeof flagsSchema>> {
	override needsCommunityPackages = false;

	override needsTaskRunner = false; // Execution happens on the running n8n server, not locally

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
			this.logger.info(`[run]   updatedAt: ${(fileData.updatedAt as unknown as string) ?? 'N/A'}`);
			this.logger.info(`[run]   Nodes (${fileData.nodes?.length ?? 0}):`);
			if (fileData.nodes && Array.isArray(fileData.nodes)) {
				for (const node of fileData.nodes) {
					this.logger.info(
						`[run]     - "${node.name}" (type: ${node.type}, version: ${node.typeVersion})`,
					);
				}
			}
			this.logger.info(
				`[run]   Connections: ${Object.keys(fileData.connections ?? {}).length} source nodes`,
			);
		} catch (error) {
			throw new UserError(
				`[run] Failed to parse workflow file: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// Validate basic workflow structure
		if (!fileData.nodes || !Array.isArray(fileData.nodes)) {
			throw new UserError('[run] The workflow file does not contain valid nodes.');
		}

		if (!fileData.connections || typeof fileData.connections !== 'object') {
			throw new UserError('[run] The workflow file does not contain valid connections.');
		}

		// ── Step 2: Sync workflow to server ────────────────────────────────
		this.logger.info(`[run] ── SYNCING WORKFLOW ──`);
		const user = await Container.get(OwnershipService).getInstanceOwner();
		this.logger.info(`[run] Instance owner: ${user.id}`);
		const workflowRepository = Container.get(WorkflowRepository);
		const sharedWorkflowRepository = Container.get(SharedWorkflowRepository);
		const projectRepository = Container.get(ProjectRepository);

		let workflowData: IWorkflowBase;
		let workflowId: string;
		let synced = false;

		// ── Step 2a: Try matching by ID ───────────────────────────────────
		if (fileData.id && isWorkflowIdValid(fileData.id)) {
			this.logger.info(`[run] Checking if workflow with ID "${fileData.id}" exists on server...`);
			const existingById = await workflowRepository.findOneBy({ id: fileData.id });

			if (existingById) {
				this.logger.info(
					`[run] Found existing workflow by ID: "${existingById.name}" (ID: ${existingById.id})`,
				);

				// Compare modified times: use file version if it's newer
				const fileUpdatedAt = fileData.updatedAt
					? new Date(fileData.updatedAt as unknown as string)
					: null;
				const serverUpdatedAt = existingById.updatedAt
					? new Date(existingById.updatedAt as unknown as string)
					: null;

				this.logger.info(
					`[run] File updatedAt: ${fileUpdatedAt?.toISOString() ?? 'N/A'}, Server updatedAt: ${serverUpdatedAt?.toISOString() ?? 'N/A'}`,
				);

				if (fileUpdatedAt && serverUpdatedAt && fileUpdatedAt > serverUpdatedAt) {
					this.logger.info('[run] File is newer than server version. Updating server workflow...');
					await workflowRepository.update(existingById.id, {
						nodes: fileData.nodes,
						connections: fileData.connections,
						settings: fileData.settings,
						name: fileData.name,
						updatedAt: new Date(),
					});
					this.logger.info('[run] Server workflow updated with file content.');
					workflowData = (await workflowRepository.findOneBy({ id: existingById.id }))!;
				} else {
					this.logger.info(
						'[run] Server version is up-to-date or newer. Using server workflow as-is.',
					);
					workflowData = existingById;
				}

				workflowId = existingById.id;
				synced = true;
			} else {
				this.logger.info(
					`[run] No workflow found with ID "${fileData.id}". Falling back to name search...`,
				);
			}
		}

		// ── Step 2b: Fall back to name search ─────────────────────────────
		if (!synced && fileData.name) {
			this.logger.info(`[run] Searching for workflow by name: "${fileData.name}"...`);
			const existingByName = await workflowRepository.findOneBy({ name: fileData.name });

			if (existingByName) {
				this.logger.info(
					`[run] Found existing workflow by name: "${existingByName.name}" (ID: ${existingByName.id})`,
				);

				const fileUpdatedAt = fileData.updatedAt
					? new Date(fileData.updatedAt as unknown as string)
					: null;
				const serverUpdatedAt = existingByName.updatedAt
					? new Date(existingByName.updatedAt as unknown as string)
					: null;

				this.logger.info(
					`[run] File updatedAt: ${fileUpdatedAt?.toISOString() ?? 'N/A'}, Server updatedAt: ${serverUpdatedAt?.toISOString() ?? 'N/A'}`,
				);

				if (fileUpdatedAt && serverUpdatedAt && fileUpdatedAt > serverUpdatedAt) {
					this.logger.info('[run] File is newer than server version. Updating server workflow...');
					await workflowRepository.update(existingByName.id, {
						nodes: fileData.nodes,
						connections: fileData.connections,
						settings: fileData.settings,
						name: fileData.name,
						updatedAt: new Date(),
					});
					this.logger.info('[run] Server workflow updated with file content.');
					workflowData = (await workflowRepository.findOneBy({ id: existingByName.id }))!;
				} else {
					this.logger.info(
						'[run] Server version is up-to-date or newer. Using server workflow as-is.',
					);
					workflowData = existingByName;
				}

				workflowId = existingByName.id;
				synced = true;
			} else {
				this.logger.info(
					`[run] No workflow found with name "${fileData.name}". Will create a new workflow.`,
				);
			}
		}

		// ── Step 2c: Create new workflow if no match ──────────────────────
		if (!synced) {
			workflowId = fileData.id && isWorkflowIdValid(fileData.id) ? fileData.id : generateNanoId();
			fileData.id = workflowId;

			this.logger.info(
				`[run] Creating new workflow on server with ID: "${workflowId}", Name: "${fileData.name}"...`,
			);

			await this.createWorkflowOnServer(
				fileData,
				user.id,
				workflowRepository,
				sharedWorkflowRepository,
				projectRepository,
			);

			this.logger.info('[run] New workflow created successfully on server.');
			workflowData = (await workflowRepository.findOneBy({ id: workflowId }))!;
		}

		// ── Step 3: Execute via HTTP API on the running n8n server ────────
		this.logger.info(`[run] ── EXECUTION PHASE ──`);
		this.logger.info(`[run] Workflow: "${workflowData!.name}" (ID: ${workflowId!})`);

		const serverPort = this.globalConfig.port;
		const serverUrl = `http://localhost:${serverPort}`;
		this.logger.info(`[run] n8n server URL: ${serverUrl}`);

		// First, check that the n8n server is reachable
		this.logger.info(`[run] Checking server health...`);
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

		// Trigger execution via the internal CLI endpoint (no API key needed)
		this.logger.info(`[run] Triggering workflow execution via CLI endpoint (no auth required)...`);
		const startTime = Date.now();

		const executeUrl = `${serverUrl}/rest/cli/workflows/${workflowId!}/run`;
		this.logger.info(`[run] POST ${executeUrl}`);

		const response = await fetch(executeUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ chatInput: flags.input }),
		});

		this.logger.info(`[run] Response status: ${response.status} ${response.statusText}`);

		if (!response.ok) {
			const errorBody = await response.text();
			this.logger.error(`[run] API error response: ${errorBody}`);
			throw new UserError(
				`[run] Failed to execute workflow via API: ${response.status} ${response.statusText} — ${errorBody}`,
			);
		}

		const executeResult = (await response.json()) as {
			data?: { executionId?: string };
			executionId?: string;
			id?: string;
			waitingForWebhook?: boolean;
		};
		const executionId =
			executeResult.data?.executionId || executeResult.executionId || executeResult.id;
		this.logger.info(
			`[run] Workflow execution triggered. Execution ID: ${executionId ?? 'unknown'}`,
		);

		if (!executionId) {
			if (executeResult.waitingForWebhook) {
				this.logger.info(
					'[run] Workflow is waiting for a webhook trigger. This trigger type requires external input (e.g. chat message). ' +
						'The CLI cannot provide this automatically. Please use the n8n UI to trigger this workflow.',
				);
			}
			this.logger.info(`[run] Full API response: ${JSON.stringify(executeResult, null, 2)}`);
			throw new UserError('[run] Could not determine execution ID from API response.');
		}

		// ── Step 4: Poll database for execution results ───────────────────
		this.logger.info(`[run] Polling for execution results...`);
		const executionRepository = Container.get(ExecutionRepository);
		let elapsedSeconds = 0;
		const pollIntervalMs = 2000;
		const maxWaitSeconds = 300; // 5 minutes max

		while (elapsedSeconds < maxWaitSeconds) {
			// First check status with a lightweight query
			const executionStatus = await executionRepository.findOneBy({ id: executionId });

			if (executionStatus) {
				if (
					executionStatus.status === 'success' ||
					executionStatus.status === 'error' ||
					executionStatus.status === 'crashed'
				) {
					const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
					this.logger.info(
						`[run] Execution completed in ${totalTime}s with status: ${executionStatus.status}`,
					);

					// Fetch full execution data including node outputs
					this.logger.info(`[run] Fetching full execution data with node outputs...`);
					const fullExecution = await executionRepository.findSingleExecution(executionId, {
						includeData: true,
						unflattenData: true,
					});

					this.logger.info(`[run] ── RESULTS ──`);

					if (executionStatus.status === 'error' || executionStatus.status === 'crashed') {
						this.logger.error(`[run] ❌ Execution FAILED (status: ${executionStatus.status})`);
						this.logger.error('====================================');
					} else {
						if (flags.rawOutput === undefined) {
							this.logger.info('[run] ✅ Execution was successful!');
							this.logger.info('====================================');
						}
					}

					// Log per-node results
					if (fullExecution?.data?.resultData?.runData) {
						const runData = fullExecution.data.resultData.runData;
						const nodeNames = Object.keys(runData);
						this.logger.info(
							`[run] Nodes executed (${nodeNames.length}): ${nodeNames.join(' → ')}`,
						);

						for (const [nodeName, nodeRuns] of Object.entries(runData)) {
							for (const nodeRun of nodeRuns as Array<{
								executionStatus?: string;
								executionTime?: number;
								data?: { main?: Array<Array<{ json: unknown }>> };
							}>) {
								const status = nodeRun.executionStatus ?? 'unknown';
								const time = nodeRun.executionTime ?? 0;
								this.logger.info(`[run]   ✅ "${nodeName}" — status: ${status}, time: ${time}ms`);

								// Log the output data from each node
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

					// Output the full execution result as JSON
					this.log(JSON.stringify(fullExecution ?? executionStatus, null, 2));
					this.logger.info(`[run] Done. Total time: ${totalTime}s`);
					return;
				}
			}

			// Wait before polling again
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
			elapsedSeconds += pollIntervalMs / 1000;

			if (Math.floor(elapsedSeconds) % 5 === 0 && elapsedSeconds > 0) {
				this.logger.info(
					`[run] ⏳ Still waiting for execution ${executionId}... (${Math.floor(elapsedSeconds)}s elapsed, status: ${executionStatus?.status ?? 'pending'})`,
				);
			}
		}

		throw new UserError(
			`[run] Execution timed out after ${maxWaitSeconds}s. Execution ID: ${executionId}`,
		);
	}

	async catch(error: Error) {
		this.logger.error('[run] Error executing workflow. See log messages for details.');
		this.logger.error('[run] Execution error:');
		this.logger.info('====================================');
		this.logger.error(error.message);
		if (error instanceof ExecutionBaseError) this.logger.error(error.description!);
		if (error.stack) this.logger.error(error.stack);
	}

	/**
	 * Creates a new workflow in the database with proper ownership/sharing setup.
	 */
	private async createWorkflowOnServer(
		workflowData: IWorkflowBase,
		userId: string,
		workflowRepository: WorkflowRepository,
		sharedWorkflowRepository: SharedWorkflowRepository,
		projectRepository: ProjectRepository,
	): Promise<void> {
		const { manager: dbManager } = workflowRepository;

		await dbManager.transaction(async (transactionManager) => {
			// Get user's personal project
			const personalProject = await projectRepository.getPersonalProjectForUserOrFail(
				userId,
				transactionManager,
			);

			// Create workflow entity with required fields
			const workflowEntity = workflowRepository.create({
				...workflowData,
				active: false,
				isArchived: false,
				versionId: workflowData.versionId || uuidv4(),
				createdAt: workflowData.createdAt || new Date(),
				updatedAt: workflowData.updatedAt || new Date(),
			});

			const savedWorkflow = await transactionManager.save(workflowEntity);
			this.logger.info(`[run] Workflow entity saved to database. ID: ${savedWorkflow.id}`);

			// Create shared workflow relationship
			const sharedWorkflow = sharedWorkflowRepository.create({
				role: 'workflow:owner',
				projectId: personalProject.id,
				workflow: savedWorkflow,
			});

			await transactionManager.save(sharedWorkflow);
			this.logger.info(
				`[run] Shared workflow relationship created for project: ${personalProject.id}`,
			);
		});
	}
}
