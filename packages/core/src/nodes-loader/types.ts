export namespace n8n {
	export interface PackageJson {
		name: string;
		version: string;
		n8n?: {
			credentials?: string[];
			nodes?: string[];
			/** Optional: override package name for node type identifiers (for workflow compatibility) */
			nodeTypePrefix?: string;
		};
		author?: {
			name?: string;
			email?: string;
		};
	}
}
