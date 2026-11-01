import type { Workspace } from '@craft-agent/core/types';
import { BaseAgent } from '@craft-agent/shared/agent';

interface SessionScript {
  chat: (...args: Parameters<BaseAgent['chat']>) => ReturnType<BaseAgent['chat']>;
  isProcessing?: () => boolean;
  forceAbort?: () => void;
}

/** An offline backend with the real typed agent contract and a scripted stream. */
export class ScriptedSessionAgent extends BaseAgent {
  protected backendName = 'Offline session fixture';

  constructor(workspace: Workspace, private readonly script: SessionScript = { async *chat() {} }) {
    super({ workspace, provider: 'pi', authType: 'api_key', isHeadless: true }, 'fixture');
  }

  override getSessionId(): null { return null; }

  override async *chat(...args: Parameters<BaseAgent['chat']>): ReturnType<BaseAgent['chat']> {
    let acknowledged = false;
    for await (const event of this.script.chat(...args)) {
      if (!acknowledged) {
        await this.awaitProviderDispatchWriteAhead();
        this.performProviderHandoff(() => undefined);
        acknowledged = true;
      }
      yield event;
    }
  }

  protected chatImpl(...args: Parameters<BaseAgent['chat']>): ReturnType<BaseAgent['chat']> {
    return this.script.chat(...args);
  }

  async abort(): Promise<void> { this.forceAbort(); }
  forceAbort(): void { this.script.forceAbort?.(); }
  isProcessing(): boolean { return this.script.isProcessing?.() ?? false; }
  respondToPermission(): void {}
  async runMiniCompletion(): Promise<null> { return null; }

  queryLlm(): ReturnType<BaseAgent['queryLlm']> {
    return Promise.reject(new Error('This offline fixture cannot call a model'));
  }
}

/** Fill a legacy fixture's methods without adding optional dispatch capabilities. */
export function completeSessionAgentFixture<Fixture extends Partial<BaseAgent>>(
  workspace: Workspace,
  fixture: Fixture,
) {
  const agent = Object.assign(new ScriptedSessionAgent(workspace), fixture);
  for (const hook of ['onProviderHandoff', 'onBeforeProviderDispatch',
    'onProviderDispatchRejected', 'onProviderDispatchUncertain'] as const) {
    if (!(hook in fixture)) Reflect.deleteProperty(agent, hook);
  }
  return agent;
}
