import { createHash } from 'node:crypto';
import { redactProviderDiagnostic } from '@craft-agent/core';
import { codeAssistJson, codeAssistGet, codeAssistLoadSchema, codeAssistOperationSchema } from './google-code-assist-wire.ts';
import type { CodeAssistLoadResponse, CodeAssistTier } from './google-code-assist-wire.ts';

const METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
};
const INDIVIDUAL_CODE_ASSIST_UNAVAILABLE =
  'Google Gemini Code Assist OAuth is no longer available for individual accounts. Use a Google AI Studio API key in Robb Agents. Organization accounts require an active Code Assist Standard or Enterprise license and GOOGLE_CLOUD_PROJECT.';
interface CodeAssistUserData {
  projectId?: string;
  expiresAt: number;
}

const userDataCache = new Map<string, CodeAssistUserData>();

function pickDefaultTier(loadRes: CodeAssistLoadResponse): CodeAssistTier | undefined {
  return loadRes?.allowedTiers?.find((tier) => tier?.isDefault) ?? loadRes?.allowedTiers?.[0];
}

function pickOrganizationTier(loadRes: CodeAssistLoadResponse): CodeAssistTier | undefined {
  return loadRes?.allowedTiers?.find((tier) =>
    tier?.id && tier?.userDefinedCloudaicompanionProject === true);
}

function codeAssistIneligibilityReasons(loadRes: CodeAssistLoadResponse): string[] {
  return (loadRes?.ineligibleTiers ?? [])
    .map((tier) => tier?.reasonMessage)
    .filter((reason: unknown): reason is string => typeof reason === 'string' && reason.trim().length > 0);
}

function isIndividualCodeAssistUnavailable(reasons: string[]): boolean {
  return reasons.some(reason =>
    /no longer supported for Gemini Code Assist for individuals|Antigravity suite of products/i.test(reason));
}

export async function ensureCodeAssistUser(accessToken: string, signal?: AbortSignal): Promise<CodeAssistUserData> {
  const cacheKey = createHash('sha256').update(accessToken).digest('hex');
  const cached = userDataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const envProject = process.env["GOOGLE_CLOUD_PROJECT"] || process.env["GOOGLE_CLOUD_PROJECT_ID"] || undefined;
  if (envProject && /^\d+$/.test(envProject)) {
    throw new Error('GOOGLE_CLOUD_PROJECT must be the string project ID, not a numeric project number.');
  }

  const loadReq = {
    cloudaicompanionProject: envProject,
    metadata: { ...METADATA, duetProject: envProject },
  };
  let loadRes = codeAssistLoadSchema.parse(await codeAssistJson('loadCodeAssist', accessToken, loadReq, signal));

  if (!loadRes?.currentTier) {
    const ineligibilityReasons = codeAssistIneligibilityReasons(loadRes);
    const organizationTier = pickOrganizationTier(loadRes);

    // Google may return an ineligible Individuals tier alongside an allowed
    // Standard/Enterprise tier. An explicit Cloud project selects the latter;
    // the personal-tier deprecation must not mask that valid organization path.
    if (!envProject && organizationTier) {
      throw new Error(
        'Google Gemini Code Assist requires GOOGLE_CLOUD_PROJECT for this organization tier. Individual accounts should use a Google AI Studio API key in Robb Agents.',
      );
    }
    if (!organizationTier && isIndividualCodeAssistUnavailable(ineligibilityReasons)) {
      throw new Error(INDIVIDUAL_CODE_ASSIST_UNAVAILABLE);
    }

    const validationTier = loadRes?.ineligibleTiers?.find((tier) => tier?.validationUrl);
    if (validationTier?.validationUrl) {
      throw new Error(`Google account validation required before using Gemini Code Assist: ${validationTier.reasonMessage ?? validationTier.validationUrl}`);
    }

    const tier = organizationTier ?? pickDefaultTier(loadRes);
    if (!tier?.id) {
      const reasons = ineligibilityReasons.join(', ');
      throw new Error(reasons || 'Google Gemini Code Assist account is not eligible or no tier is available.');
    }

    if (tier.userDefinedCloudaicompanionProject && !envProject) {
      throw new Error(
        'Google Gemini Code Assist requires GOOGLE_CLOUD_PROJECT for this organization tier. Individual accounts should use a Google AI Studio API key in Robb Agents.',
      );
    }

    const onboardReq = tier.id === 'FREE'
      ? { tierId: tier.id, cloudaicompanionProject: undefined, metadata: METADATA }
      : { tierId: tier.id, cloudaicompanionProject: envProject, metadata: { ...METADATA, duetProject: envProject } };

    let operation = codeAssistOperationSchema.parse(await codeAssistJson('onboardUser', accessToken, onboardReq, signal));
    while (operation && !operation.done && operation.name) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      operation = codeAssistOperationSchema.parse(await codeAssistGet(operation.name, accessToken, signal));
    }

    if (operation?.error) {
      throw new Error(`Google Gemini Code Assist onboarding failed: ${redactProviderDiagnostic(JSON.stringify(operation.error), [accessToken]).slice(0, 800)}`);
    }

    const projectId = operation?.response?.cloudaicompanionProject?.id ?? envProject;
    loadRes = { currentTier: tier, cloudaicompanionProject: projectId };
  }

  const projectId = loadRes.cloudaicompanionProject || envProject;
  if (loadRes.currentTier?.userDefinedCloudaicompanionProject && !projectId) {
    throw new Error(
      'Google Gemini Code Assist requires GOOGLE_CLOUD_PROJECT for this organization tier. Individual accounts should use a Google AI Studio API key in Robb Agents.',
    );
  }
  const data = { ...(projectId !== undefined ? { projectId } : {}), expiresAt: Date.now() + 30_000 };
  userDataCache.set(cacheKey, data);
  return data;
}
