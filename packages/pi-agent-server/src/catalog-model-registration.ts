import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

// Current metadata belongs to Pi. These saved IDs remain accepted by the
// provider; keep old sessions resolvable without offering retired IDs again.
// https://api-docs.deepseek.com/updates/ (2026-09-10 compatibility aliases)
const savedModelAliases: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  mistral: { 'mistral-medium-3-5': 'mistral-medium-2604' },
  deepseek: {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  },
};

export function registerSupplementalCatalogModels(registry: ModelRegistry, provider: string): string[] {
  const aliases = savedModelAliases[provider];
  if (!aliases) return [];
  const models = registry.getAll().filter(model => model.provider === provider);
  const missing = Object.entries(aliases).flatMap(([id, source]) => {
    const template = models.find(model => model.id === source);
    return !registry.find(provider, id) && template && registry.hasConfiguredAuth(template)
      ? [{ ...template, id, name: provider === 'mistral' ? 'Mistral Medium 3.5' : template.name }]
      : [];
  });
  if (!missing.length) return [];
  const registration = (model: (typeof models)[number]) => ({ ...model, input: [...model.input] });
  registry.registerProvider(provider, {
    baseUrl: missing[0]!.baseUrl,
    models: [...models, ...missing].map(registration),
  });
  return missing.map(model => model.id);
}
