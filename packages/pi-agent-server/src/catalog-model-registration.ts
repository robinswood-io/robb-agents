import type { Api, Model, OAuthProviderInterface } from '@earendil-works/pi-ai';
import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';

import { getPiModelsForAuthProvider } from '../../shared/src/config/models-pi.ts';

type RuntimeModel = Model<Api>;

const OPENAI_SUPPLEMENTAL_MODEL_IDS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const;

const CATALOG_MODEL_TEMPLATES: Readonly<Record<string, {
  templateId: string;
  supplementalModelIds: readonly string[];
}>> = {
  openai: {
    templateId: 'gpt-5.5',
    supplementalModelIds: OPENAI_SUPPLEMENTAL_MODEL_IDS,
  },
  'openai-codex': {
    templateId: 'gpt-5.5',
    supplementalModelIds: OPENAI_SUPPLEMENTAL_MODEL_IDS,
  },
};

/**
 * Current standard-processing prices in USD per 1M tokens.
 *
 * Pi 0.80.3 predates these models, so cloning the GPT-5.5 transport would also
 * clone stale prices and reasoning compatibility. Keep the overrides explicit
 * until the upstream SDK catalogue contains the models itself.
 * Sources:
 * - https://developers.openai.com/api/docs/models/gpt-6-astra
 * - https://developers.openai.com/api/docs/models/gpt-5.6-sol
 */
const OPENAI_RUNTIME_OVERRIDES: Readonly<Record<
  string,
  Pick<RuntimeModel, 'cost' | 'maxTokens' | 'thinkingLevelMap'>
>> = {
  'gpt-6-astra': {
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    maxTokens: 128_000,
    // Astra rejects the legacy `none` and `minimal` efforts. Pi 0.80.3 has no
    // distinct `max` enum yet, so Robb's current max setting safely clamps to
    // xhigh until the pinned runtime is upgraded.
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    },
  },
  'gpt-5.6-sol': {
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    maxTokens: 128_000,
  },
  'gpt-5.6-terra': {
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
    maxTokens: 128_000,
  },
  'gpt-5.6-luna': {
    cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
    maxTokens: 128_000,
  },
};

/**
 * Convert a resolved SDK model back to registerProvider's model shape.
 * registerProvider replaces every model for a provider, so all existing
 * entries must be carried forward when adding a catalog supplement.
 */
function toRegistrationModel(model: RuntimeModel) {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers ? { ...model.headers } : undefined,
    compat: model.compat,
  };
}

type RegistrationAuth =
  | { apiKey: string }
  | { oauth: Omit<OAuthProviderInterface, 'id'> };

function getRegistrationAuth(
  modelRegistry: PiModelRegistry,
  provider: string,
): RegistrationAuth | undefined {
  const credential = modelRegistry.authStorage.get(provider);
  if (credential?.type === 'api_key') return { apiKey: credential.key };
  if (credential?.type !== 'oauth') return undefined;

  const oauthProvider = modelRegistry.authStorage
    .getOAuthProviders()
    .find(candidate => candidate.id === provider);
  if (!oauthProvider) return undefined;

  // registerProvider requires either apiKey or oauth when defining models.
  // Passing the current OAuth access token as apiKey would create a stale
  // fallback if refresh fails. Re-register the provider's OAuth contract so
  // AuthStorage remains the sole source of credentials and refresh behavior.
  const { id: _providerId, ...oauth } = oauthProvider;
  return { oauth };
}

/**
 * Register catalog models that are newer than the bundled Pi SDK catalogue.
 *
 * The shared catalogue intentionally exposes recent OpenAI models for API-key
 * and ChatGPT-account auth. Pi SDK 0.80.3 does not know these IDs yet, so create
 * runtime entries using the latest compatible provider model as the transport
 * template. Unknown providers and unauthenticated registries are left intact.
 */
export function registerSupplementalCatalogModels(
  modelRegistry: PiModelRegistry,
  provider: string,
): string[] {
  const rule = CATALOG_MODEL_TEMPLATES[provider];
  if (!rule) return [];

  const existingModels = modelRegistry.getAll().filter(model => model.provider === provider);
  const template = existingModels.find(model => model.id === rule.templateId);
  const registrationAuth = getRegistrationAuth(modelRegistry, provider);
  if (!template || !registrationAuth) return [];

  const existingIds = new Set(existingModels.map(model => model.id));
  const missingDefinitions = getPiModelsForAuthProvider(provider).filter(definition => {
    const bareId = definition.id.replace(/^pi\//, '');
    return rule.supplementalModelIds.includes(bareId) && !existingIds.has(bareId);
  });
  if (missingDefinitions.length === 0) return [];

  const supplementalModels = missingDefinitions.map(definition => {
    const id = definition.id.replace(/^pi\//, '');
    const overrides = OPENAI_RUNTIME_OVERRIDES[id];
    return {
      ...toRegistrationModel(template),
      id,
      name: definition.name,
      reasoning: definition.supportsThinking ?? template.reasoning,
      contextWindow: definition.contextWindow ?? template.contextWindow,
      ...(overrides ? {
        cost: { ...overrides.cost },
        maxTokens: overrides.maxTokens,
        ...(overrides.thinkingLevelMap
          ? { thinkingLevelMap: { ...overrides.thinkingLevelMap } }
          : {}),
      } : {}),
    };
  });

  modelRegistry.registerProvider(provider, {
    baseUrl: template.baseUrl,
    ...registrationAuth,
    models: [
      ...existingModels.map(toRegistrationModel),
      ...supplementalModels,
    ],
  });

  return supplementalModels.map(model => model.id);
}
