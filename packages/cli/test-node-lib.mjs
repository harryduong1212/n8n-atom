/**
 * Test script for the n8n Node.js library.
 *
 * Usage:
 *   node test-node-lib.mjs
 *   node test-node-lib.mjs /path/to/workflow.n8n
 *   node test-node-lib.mjs /path/to/workflow.n8n "hello world"
 *
 * Prerequisites:
 *   - n8n server must be running (e.g. `pnpm dev` or `pnpm start`)
 */
import n8n from './dist/index.js';

const defaultWorkflow =
	'/Users/Shared/Data/Syncthing/MyApp/n8n-solution/n8n-sample/Untitled-1774177680378.n8n';

const filePath = process.argv[2] || defaultWorkflow;
const input = process.argv[3] || {text: 'world'};

console.log('=== n8n Node Lib Test ===');
console.log(`File:  ${filePath}`);
console.log(`Input: ${input ?? '(none)'}`);
console.log('========================\n');

try {
	const result = await n8n.run(filePath, input);

	console.log('\n=== Result ===');
	console.log(JSON.stringify(result, null, 2));

	process.exit(result.length > 0 ? 0 : 1);
} catch (error) {
	console.error('\n=== Error ===');
	console.error(error.message);
	process.exit(1);
}
