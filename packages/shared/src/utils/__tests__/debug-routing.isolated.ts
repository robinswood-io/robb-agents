import { describe, expect, test } from 'bun:test';
import { debug, enableDebug, setDebugSink } from '../debug';

describe('host debug routing', () => {
  test('mirrors logs only to the explicitly registered sink and respects JSON-only CLI output', () => {
    const messages: string[] = [];
    const previous = process.env['CRAFT_CLI_JSON_ONLY'];
    delete process.env['CRAFT_CLI_JSON_ONLY'];
    enableDebug();
    setDebugSink({ info: message => { messages.push(message); } });
    try {
      debug('registered-host-log');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('registered-host-log');
      process.env['CRAFT_CLI_JSON_ONLY'] = '1';
      debug('must-stay-silent');
      expect(messages).toHaveLength(1);
      delete process.env['CRAFT_CLI_JSON_ONLY'];
      setDebugSink(null);
      debug('unregistered-host-log');
      expect(messages).toHaveLength(1);
    } finally {
      setDebugSink(null);
      if (previous === undefined) delete process.env['CRAFT_CLI_JSON_ONLY'];
      else process.env['CRAFT_CLI_JSON_ONLY'] = previous;
    }
  });
});
