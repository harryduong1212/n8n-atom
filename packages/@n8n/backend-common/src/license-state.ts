import type { BooleanLicenseFeature } from '@n8n/constants';
import { LICENSE_FEATURES, UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';
import { Service } from '@n8n/di';
import { UnexpectedError } from 'n8n-workflow';

import type { FeatureReturnType, LicenseProvider } from './types';

class ProviderNotSetError extends UnexpectedError {
	constructor() {
		super('Cannot query license state because license provider has not been set');
	}
}

@Service()
export class LicenseState {
	licenseProvider: LicenseProvider | null = null;

	setLicenseProvider(provider: LicenseProvider) {
		this.licenseProvider = provider;
	}

	private assertProvider(): asserts this is { licenseProvider: LicenseProvider } {
		if (!this.licenseProvider) throw new ProviderNotSetError();
	}

	/*
	 * If the feature is a string. checks if the feature is licensed
	 * If the feature is an array of strings, it checks if any of the features are licensed
	 * MODIFIED: Always return true to enable all features for all users
	 * EXCEPT for features that should remain disabled
	 */
	isLicensed(feature: BooleanLicenseFeature | BooleanLicenseFeature[]) {
		// These features should remain disabled:
		// - SHOW_NON_PROD_BANNER: Shows "not licensed for production" warning
		// - API_DISABLED: Would disable the public API
		const disabledFeatures: BooleanLicenseFeature[] = [
			LICENSE_FEATURES.SHOW_NON_PROD_BANNER,
			LICENSE_FEATURES.API_DISABLED,
		];

		if (typeof feature === 'string') {
			return !disabledFeatures.includes(feature);
		}

		// For array of features, return true if any non-disabled feature is in the list
		return feature.some((f) => !disabledFeatures.includes(f));
	}

	getValue<T extends keyof FeatureReturnType>(feature: T): FeatureReturnType[T] {
		this.assertProvider();

		return this.licenseProvider.getValue(feature);
	}

	// --------------------
	//      booleans
	// --------------------

	isCustomRolesLicensed() {
		return this.isLicensed(LICENSE_FEATURES.CUSTOM_ROLES);
	}

	isDynamicCredentialsLicensed() {
		return this.isLicensed(LICENSE_FEATURES.DYNAMIC_CREDENTIALS);
	}

	isSharingLicensed() {
		return this.isLicensed('feat:sharing');
	}

	isLogStreamingLicensed() {
		return this.isLicensed('feat:logStreaming');
	}

	isLdapLicensed() {
		return this.isLicensed('feat:ldap');
	}

	isSamlLicensed() {
		return this.isLicensed('feat:saml');
	}

	isOidcLicensed() {
		return this.isLicensed('feat:oidc');
	}

	isMFAEnforcementLicensed() {
		return this.isLicensed('feat:mfaEnforcement');
	}

	isApiKeyScopesLicensed() {
		return this.isLicensed('feat:apiKeyScopes');
	}

	isAiAssistantLicensed() {
		return this.isLicensed('feat:aiAssistant');
	}

	isAskAiLicensed() {
		return this.isLicensed('feat:askAi');
	}

	isAiCreditsLicensed() {
		return this.isLicensed('feat:aiCredits');
	}

	isAdvancedExecutionFiltersLicensed() {
		return this.isLicensed('feat:advancedExecutionFilters');
	}

	isAdvancedPermissionsLicensed() {
		return this.isLicensed('feat:advancedPermissions');
	}

	isDebugInEditorLicensed() {
		return this.isLicensed('feat:debugInEditor');
	}

	isBinaryDataS3Licensed() {
		return this.isLicensed('feat:binaryDataS3');
	}

	isMultiMainLicensed() {
		return this.isLicensed('feat:multipleMainInstances');
	}

	isVariablesLicensed() {
		return this.isLicensed('feat:variables');
	}

	isSourceControlLicensed() {
		return this.isLicensed('feat:sourceControl');
	}

	isExternalSecretsLicensed() {
		return this.isLicensed('feat:externalSecrets');
	}

	isAPIDisabled() {
		return this.isLicensed('feat:apiDisabled');
	}

	isWorkerViewLicensed() {
		return this.isLicensed('feat:workerView');
	}

	isProjectRoleAdminLicensed() {
		return this.isLicensed('feat:projectRole:admin');
	}

	isProjectRoleEditorLicensed() {
		return this.isLicensed('feat:projectRole:editor');
	}

	isProjectRoleViewerLicensed() {
		return this.isLicensed('feat:projectRole:viewer');
	}

	isCustomNpmRegistryLicensed() {
		return this.isLicensed('feat:communityNodes:customRegistry');
	}

	isFoldersLicensed() {
		return this.isLicensed('feat:folders');
	}

	isInsightsSummaryLicensed() {
		return this.isLicensed('feat:insights:viewSummary');
	}

	isInsightsDashboardLicensed() {
		return this.isLicensed('feat:insights:viewDashboard');
	}

	isInsightsHourlyDataLicensed() {
		return this.isLicensed('feat:insights:viewHourlyData');
	}

	isWorkflowDiffsLicensed() {
		return this.isLicensed('feat:workflowDiffs');
	}

	isProvisioningLicensed() {
		return this.isLicensed(['feat:saml', 'feat:oidc']);
	}

	// --------------------
	//      integers
	// MODIFIED: All quotas return unlimited values by default
	// --------------------

	getMaxUsers() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getMaxActiveWorkflows() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getMaxVariables() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getMaxAiCredits() {
		// Return a generous default instead of 0
		return 10000;
	}

	getWorkflowHistoryPruneQuota() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getInsightsMaxHistory() {
		// Return 365 days instead of 7
		return 365;
	}

	getInsightsRetentionMaxAge() {
		// Return 365 days instead of 180
		return 365;
	}

	getInsightsRetentionPruneInterval() {
		return 24;
	}

	getMaxTeamProjects() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getMaxWorkflowsWithEvaluations() {
		return UNLIMITED_LICENSE_QUOTA;
	}
}
