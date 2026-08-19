import type { Api, Model, OAuthProviderInterface } from '@earendil-works/pi-ai';
import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';

import { getPiModelsForAuthProvider } from '../../shared/src/config/models-pi.ts';

type RuntimeModel = Model<Api>;

const CATALOG_MODEL_TEMPLATES: Readonly<Record<string, {
  templateId: string;
  supplementalIdPrefix: string;
}>> = {
  openai: {
    templateId: 'gpt-5.5',
    supplementalIdPrefix: 'gpt-5.6-',
  },
  'openai-codex': {
    templateId: 'gpt-5.5',
    supplementalIdPrefix: 'gpt-5.6-',
  },
};

/**
 * Current standard-processing prices in USD per 1M tokens.
 *
 * Pi 0.80.3 predates GPT-5.6, so cloning the GPT-5.5 transport would otherwise
 * also clone its prices. That is correct for Sol input/output but materially
 * overstates Terra/Luna and misses GPT-5.6 cache-write billing. Keep these
 * explicit until the upstream SDK catalogue contains the models itself.
 * Source: https://developers.openai.com/api/docs/models/gpt-5.6-sol
 */
const GPT_56_RUNTIME_OVERRIDES: Readonly<Record<string, Pick<RuntimeModel, 'cost' | 'maxTokens'>>> = {
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
 * The shared catalogue intentionally exposes GPT-5.6 for OpenAI API-key and
 * ChatGPT-account auth. Pi SDK 0.80.3 does not know these IDs yet, so create
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
    return bareId.startsWith(rule.supplementalIdPrefix) && !existingIds.has(bareId);
  });
  if (missingDefinitions.length === 0) return [];

  const supplementalModels = missingDefinitions.map(definition => {
    const id = definition.id.replace(/^pi\//, '');
    const overrides = GPT_56_RUNTIME_OVERRIDES[id];
    return {
      ...toRegistrationModel(template),
      id,
      name: definition.name,
      reasoning: definition.supportsThinking ?? template.reasoning,
      contextWindow: definition.contextWindow ?? template.contextWindow,
      ...(overrides ? { cost: { ...overrides.cost }, maxTokens: overrides.maxTokens } : {}),
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
