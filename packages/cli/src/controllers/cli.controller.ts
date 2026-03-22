import { Logger } from '@n8n/backend-common';
import { WorkflowRepository } from '@n8n/db';
import { Get, Post, Param, RestController } from '@n8n/decorators';
import type { Request, Response } from 'express';
import { CHAT_TRIGGER_NODE_TYPE, createRunExecutionData } from 'n8n-workflow';

import { OwnershipService } from '@/services/ownership.service';
import { WorkflowExecutionService } from '@/workflows/workflow-execution.service';

/**
 * Internal CLI controller for executing workflows from the command line.
 * All endpoints skip authentication (skipAuth: true) and are restricted to
 * localhost requests only for security.
 */
@RestController('/cli')
export class CliController {
	constructor(
		private readonly logger: Logger,
		private readonly workflowRepository: WorkflowRepository,
		private readonly ownershipService: OwnershipService,
		private readonly workflowExecutionService: WorkflowExecutionService,
	) {}

	/**
	 * Check if a trigger node is a webhook-based trigger that needs special handling.
	 * Webhook/chat triggers return { waitingForWebhook: true } from executeManually(),
	 * so we need to inject mock data and use executeChatWorkflow() instead.
	 */
	private isWebhookBasedTrigger(nodeType: string): boolean {
		return (
			nodeType === CHAT_TRIGGER_NODE_TYPE ||
			nodeType === 'n8n-nodes-base.webhook' ||
			nodeType.toLowerCase().includes('webhook')
		);
	}

	/**
	 * Execute a workflow by ID. Restricted to localhost only.
	 * POST /rest/cli/workflows/:workflowId/run
	 */
	@Post('/workflows/:workflowId/run', { skipAuth: true })
	async runWorkflow(req: Request, res: Response, @Param('workflowId') workflowId: string) {
		this.logger.info(`[cli-controller] Received run request for workflow ${workflowId}`);

		// Security: Only allow requests from localhost
		const remoteAddress = req.ip || req.socket.remoteAddress || '';
		const isLocalhost =
			remoteAddress === '127.0.0.1' ||
			remoteAddress === '::1' ||
			remoteAddress === '::ffff:127.0.0.1' ||
			remoteAddress === 'localhost';

		this.logger.info(
			`[cli-controller] Request from IP: ${remoteAddress}, isLocalhost: ${isLocalhost}`,
		);

		if (!isLocalhost) {
			this.logger.warn(`[cli-controller] Rejected non-localhost request from ${remoteAddress}`);
			res.status(403).json({ error: 'CLI endpoint is only accessible from localhost' });
			return;
		}

		// Find the workflow
		const workflow = await this.workflowRepository.findOneBy({ id: workflowId });
		if (!workflow) {
			this.logger.error(`[cli-controller] Workflow ${workflowId} not found`);
			res.status(404).json({ error: `Workflow with ID "${workflowId}" not found` });
			return;
		}

		this.logger.info(`[cli-controller] Found workflow: "${workflow.name}" (ID: ${workflow.id})`);

		// Find the trigger/start node in the workflow
		const triggerNode = workflow.nodes.find(
			(node) =>
				node.type.toLowerCase().includes('trigger') ||
				node.type.toLowerCase().includes('webhook') ||
				node.type === 'n8n-nodes-base.start',
		);

		if (!triggerNode) {
			this.logger.error(`[cli-controller] No trigger node found in workflow ${workflowId}`);
			res.status(400).json({ error: 'No trigger node found in workflow. Cannot execute.' });
			return;
		}

		this.logger.info(
			`[cli-controller] Trigger node: "${triggerNode.name}" (type: ${triggerNode.type})`,
		);

		// Get the instance owner for execution context
		const user = await this.ownershipService.getInstanceOwner();
		this.logger.info(`[cli-controller] Executing as instance owner: ${user.id}`);

		try {
			// Check if this is a webhook-based trigger (chatTrigger, webhook, etc.)
			// These triggers return { waitingForWebhook: true } from executeManually(),
			// so we bypass the webhook mechanism by injecting mock data and using executeChatWorkflow()
			if (this.isWebhookBasedTrigger(triggerNode.type)) {
				this.logger.info(
					`[cli-controller] Webhook-based trigger detected (${triggerNode.type}). Using direct execution with mock data.`,
				);

				// Build mock input data for the trigger node, similar to how chat-hub does it
				const isChatTrigger = triggerNode.type === CHAT_TRIGGER_NODE_TYPE;
				const mockInputData = isChatTrigger
					? {
							sessionId: `cli-${Date.now()}`,
							action: 'sendMessage',
							chatInput: (req.body as Record<string, unknown>)?.chatInput ?? 'CLI execution',
						}
					: {
							headers: {},
							params: {},
							query: {},
							body: (req.body as Record<string, unknown>) ?? {},
						};

				const executionData = createRunExecutionData({
					executionData: {
						nodeExecutionStack: [
							{
								node: triggerNode,
								data: {
									main: [[{ json: mockInputData }]],
								},
								source: null,
							},
						],
					},
					manualData: {
						userId: user.id,
					},
				});

				const result = await this.workflowExecutionService.executeChatWorkflow(
					workflow,
					executionData,
					user,
				);

				this.logger.info(`[cli-controller] Execution triggered: ${JSON.stringify(result)}`);
				res.json(result);
			} else {
				// Regular trigger: use executeManually() as before
				const result = await this.workflowExecutionService.executeManually(
					{
						workflowData: workflow,
						triggerToStartFrom: {
							name: triggerNode.name,
						},
					} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
					user,
				);

				this.logger.info(`[cli-controller] Execution triggered: ${JSON.stringify(result)}`);
				res.json(result);
			}
		} catch (error) {
			this.logger.error(
				`[cli-controller] Execution failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			res.status(500).json({
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Health check endpoint for the CLI to verify server connectivity.
	 * GET /rest/cli/health
	 */
	@Get('/health', { skipAuth: true })
	async health() {
		this.logger.info('[cli-controller] Health check');
		return { status: 'ok', timestamp: new Date().toISOString() };
	}
}
