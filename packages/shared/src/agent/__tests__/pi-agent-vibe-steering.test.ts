import { describe, expect, it, mock } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';

function agentFor(provider: string) {
  const agent = Object.create(PiAgent.prototype) as any;
  agent.config = { runtime: { piAuthProvider: provider } };
  agent._isProcessing = true;
  agent.subprocess = {};
  agent.send = mock(() => {});
  agent.forceAbort = mock(() => {});
  agent.debug = mock(() => {});
  return agent;
}

describe('PiAgent mid-stream input delivery', () => {
  it('declines unsupported Vibe steering so the host queues the complete user input', () => {
    const agent = agentFor('mistral-vibe');
    expect(agent.redirect('Continue with the corrected target.')).toBe(false);
    expect(agent.send).not.toHaveBeenCalled();
    expect(agent.forceAbort).not.toHaveBeenCalled();
  });

  it('continues delivering steering to a Pi provider that supports it', () => {
    const agent = agentFor('mistral');
    expect(agent.redirect('Continue with the corrected target.')).toBe(true);
    expect(agent.send).toHaveBeenCalledWith({ type: 'steer', message: 'Continue with the corrected target.' });
    expect(agent.forceAbort).not.toHaveBeenCalled();
  });
});
