import 'ws';

declare module 'ws' {
	export interface WebSocket {
		isAlive?: boolean;
	}
}
