import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createPiAgentTestConfig } from './fixtures/pi-agent-config.ts';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';

const agents: PiAgent[] = [];
afterEach(() => { for (const agent of agents.splice(0)) agent.destroy(); });

function agentFor(provider: string) {
  const agent = new PiAgent(createPiAgentTestConfig({ runtime: { piAuthProvider: provider } }));
  agents.push(agent);
  agent["_isProcessing"] = true;
  agent["subprocess"] = new ChildProcess();
  agent["send"] = mock(() => true);
  agent.forceAbort = mock(() => {});
  agent["debug"] = mock(() => {});
  agent.pendingPermissions = new Map();
  return agent;
}

describe('PiAgent mid-stream input delivery', () => {
  it('declines unsupported Vibe steering so the host queues the complete user input', () => {
    const agent = agentFor('mistral-vibe');
    expect(agent.redirect('Continue with the corrected target.')).toBe(false);
    expect(agent["send"]).not.toHaveBeenCalled();
    expect(agent.forceAbort).toHaveBeenCalledWith('redirect');
  });

  it('continues delivering steering to a Pi provider that supports it', () => {
    const agent = agentFor('mistral');
    expect(agent.redirect('Continue with the corrected target.')).toBe(true);
    expect(agent["send"]).toHaveBeenCalledWith({ type: 'steer', message: 'Continue with the corrected target.' });
    expect(agent.forceAbort).not.toHaveBeenCalled();
  });

  it('queues the user instruction when the Pi subprocess rejects the steer write', () => {
    const agent = agentFor('mistral');
    const stdin = new PassThrough();
    stdin.write = () => { throw new Error('pipe closed'); };
    const subprocess = new ChildProcess();
    Object.defineProperty(subprocess, 'stdin', { value: stdin });
    agent["subprocess"] = subprocess;
    agent["send"] = PiAgent.prototype['send'].bind(agent);
    agent["setCurrentTurnUserMessage"] = mock(() => {});

    expect(agent.redirect('Continue with the corrected target.')).toBe(false);
    expect(agent.forceAbort).toHaveBeenCalledWith('redirect');
    expect(agent["setCurrentTurnUserMessage"]).not.toHaveBeenCalled();
  });

  it('declines unsupported Antigravity steering so the host queues the complete user input', () => {
    const agent = agentFor('google-antigravity');
    expect(agent.redirect('Continue with the corrected target.')).toBe(false);
    expect(agent["send"]).not.toHaveBeenCalled();
    expect(agent.forceAbort).toHaveBeenCalledWith('redirect');
  });
});
