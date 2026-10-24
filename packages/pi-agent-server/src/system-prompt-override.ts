import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Apply Robb's current instructions through Pi's public per-turn extension. */
export async function createSystemPromptController(options: DefaultResourceLoaderOptions) {
  let prompt: string | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', () => prompt === undefined ? undefined : { systemPrompt: prompt });
  };
  const resourceLoader = new DefaultResourceLoader({
    ...options,
    extensionFactories: [...(options.extensionFactories ?? []), extension],
  });
  await resourceLoader.reload();
  return {
    resourceLoader,
    setPrompt(value: string): void { prompt = value; },
  };
}
