import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

import { getConnectionHintNoticeField } from '@utils/sharedFields';

import { N8nLlmTracing } from '../N8nLlmTracing';
import { spawn } from 'child_process';

interface CursorAgentFields {
	model: string;
	binaryPath: string;
	workingDirectory: string;
}

/**
 * Custom LangChain chat model that wraps the cursor-agent CLI binary.
 * Spawns cursor-agent as a subprocess, passes the prompt via stdin,
 * and parses the stream-json output to extract the assistant response.
 */
class ChatCursorAgentCLI extends SimpleChatModel {
	model: string;

	binaryPath: string;

	workingDirectory: string;

	constructor(fields: CursorAgentFields) {
		super({});
		this.model = fields.model;
		this.binaryPath = fields.binaryPath;
		this.workingDirectory = fields.workingDirectory;
	}

	_llmType(): string {
		return 'cursor-agent-cli';
	}

	async _call(
		messages: BaseMessage[],
		_options: this['ParsedCallOptions'],
		_runManager?: CallbackManagerForLLMRun,
	): Promise<string> {
		// Build prompt from messages — use the last human message as primary prompt
		const prompt = messages
			.map((m) => {
				const role = m._getType();
				const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
				return `[${role}]: ${content}`;
			})
			.join('\n\n');

		// Build cursor-agent command args
		const args = ['-p', '--output-format=stream-json', '--trust'];
		if (this.model && this.model !== 'auto') {
			args.push('--model', this.model);
		}

		return await new Promise<string>((resolve, reject) => {
			const child = spawn(this.binaryPath, args, {
				cwd: this.workingDirectory || undefined,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env },
			});

			let stdout = '';
			let stderr = '';

			child.stdout.on('data', (data: Buffer) => {
				stdout += data.toString();
			});

			child.stderr.on('data', (data: Buffer) => {
				stderr += data.toString();
			});

			child.on('error', (err: Error) => {
				reject(
					new Error(
						`Failed to spawn cursor-agent: ${err.message}. Make sure cursor-agent CLI is installed and accessible.`,
					),
				);
			});

			child.on('close', (code: number | null) => {
				if (code !== 0 && !stdout) {
					const errorMsg = stderr.trim() || `cursor-agent exited with code ${code}`;
					reject(new Error(errorMsg));
					return;
				}

				// Parse stream-json output lines to extract assistant messages
				const assistantContent = this.parseStreamJsonOutput(stdout);

				if (!assistantContent) {
					reject(new Error('No assistant response received from cursor-agent'));
					return;
				}

				resolve(assistantContent);
			});

			// Write prompt to stdin and close it
			if (child.stdin) {
				child.stdin.write(prompt);
				child.stdin.end();
			}
		});
	}

	private parseStreamJsonOutput(output: string): string {
		const lines = output.split('\n').filter((line) => line.trim());
		const assistantParts: string[] = [];

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as {
					type?: string;
					message?: {
						content?: Array<{ type?: string; text?: string }>;
					};
					text?: string;
				};

				if (parsed.type === 'assistant' && parsed.message?.content) {
					for (const item of parsed.message.content) {
						if (item.type === 'text' && item.text) {
							assistantParts.push(item.text);
						}
					}
				}
			} catch {
				// Skip non-JSON lines
			}
		}

		return assistantParts.join('');
	}
}

export class LmChatCursorAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cursor Agent CLI Chat Model',

		name: 'lmChatCursorAgent',
		icon: 'file:cursorAgent.svg',
		group: ['transform'],
		version: [1],
		description:
			'Chat model powered by the Cursor Agent CLI. Requires cursor-agent to be installed locally.',
		defaults: {
			name: 'Cursor Agent CLI Chat Model',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {},
		},

		inputs: [],

		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiChain, NodeConnectionTypes.AiAgent]),
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				description: 'The model to use via cursor-agent CLI.',
				// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
				options: [
					{ name: 'Auto', value: 'auto' },
					{ name: 'Composer 1', value: 'composer-1' },
					{ name: 'Composer 1.5', value: 'composer-1.5' },
					{ name: 'Gemini 3 Flash', value: 'gemini-3-flash' },
					{ name: 'Gemini 3 Pro', value: 'gemini-3-pro' },
					{ name: 'GPT-5.1 Codex Max', value: 'gpt-5.1-codex-max' },
					{ name: 'GPT-5.1 Codex Max High', value: 'gpt-5.1-codex-max-high' },
					{ name: 'GPT-5.2', value: 'gpt-5.2' },
					{ name: 'GPT-5.2 High', value: 'gpt-5.2-high' },
					{ name: 'Grok', value: 'grok' },
					{ name: 'Opus 4.5', value: 'opus-4.5' },
					{ name: 'Opus 4.5 Thinking', value: 'opus-4.5-thinking' },
					{ name: 'Sonnet 4.5', value: 'sonnet-4.5' },
					{ name: 'Sonnet 4.5 Thinking', value: 'sonnet-4.5-thinking' },
				],
				default: 'auto',
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				description: 'Additional options to configure',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Binary Path',
						name: 'binaryPath',
						default: 'cursor-agent',
						description:
							'Path to the cursor-agent binary. Defaults to "cursor-agent" (must be in PATH).',
						type: 'string',
					},
					{
						displayName: 'Working Directory',
						name: 'workingDirectory',
						default: '',
						description:
							'Working directory for the cursor-agent process. Leave empty to use the default.',
						type: 'string',
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const modelName = this.getNodeParameter('model', itemIndex) as string;

		const options = this.getNodeParameter('options', itemIndex, {}) as {
			binaryPath?: string;
			workingDirectory?: string;
		};

		const model = new ChatCursorAgentCLI({
			model: modelName,
			binaryPath: options.binaryPath ?? 'cursor-agent',
			workingDirectory: options.workingDirectory ?? '',
		});

		// Attach tracing callback
		model.callbacks = [new N8nLlmTracing(this)];

		return {
			response: model,
		};
	}
}
