import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as lark from '@larksuiteoapi/node-sdk';
import { Readable } from 'node:stream';
import { readFileSync, writeFileSync, truncateSync, existsSync, unlinkSync } from 'node:fs';
import { LarkAdapter } from '../adapters/lark/index.ts';
import { MAX_ATTACHMENT_BYTES, stripMentionPrefix } from '../adapters/lark/lark-adapter/shared.ts';

const files: string[] = [];
afterEach(() => { for (const file of files.splice(0)) if (existsSync(file)) unlinkSync(file); });
function setup() {
  const client = new lark.Client({ appId: 'qa', appSecret: 'qa', loggerLevel: lark.LoggerLevel.error });
  const adapter = new LarkAdapter();
  adapter['client'] = client;
  return { client, adapter };
}

describe('Lark installed SDK contract, no external requests', () => {
  it('uses the documented bot endpoint and its root bot object', async () => {
    const { client, adapter } = setup();
    const request = spyOn(client, 'request').mockResolvedValue({ code: 0, bot: { app_name: 'QA bot' } });
    expect(await adapter.getBotInfo()).toEqual({ name: 'QA bot' });
    expect(request).toHaveBeenCalledWith({ url: '/open-apis/bot/v3/info', method: 'GET' });
  });
  it('ignores a malformed profile without assuming its name type', async () => {
    const { client, adapter } = setup();
    spyOn(client, 'request').mockResolvedValue({ bot: { app_name: 42 } });
    expect(await adapter.getBotInfo()).toBeNull();
  });
  it('downloads through messageResource and preserves the file bytes', async () => {
    const { client, adapter } = setup();
    const bytes = Buffer.from([0, 255, 7]);
    const get = spyOn(client.im.messageResource, 'get').mockResolvedValue({
      writeFile: async (path: string) => { files.push(path); writeFileSync(path, bytes); },
      getReadableStream: () => Readable.from([bytes]), headers: {},
    });
    const file = await adapter.downloadResource({ messageId: 'qa-message', fileKey: 'qa-file', filename: 'test.bin', isImage: false });
    expect(file).not.toBeNull();
    if (file === null) throw new Error('Expected a QA download');
    expect(readFileSync(file)).toEqual(bytes);
    expect(get).toHaveBeenCalledWith({ path: { message_id: 'qa-message', file_key: 'qa-file' }, params: { type: 'file' } });
  });
  it('removes an oversized download instead of passing it to the agent', async () => {
    const { client, adapter } = setup();
    spyOn(client.im.messageResource, 'get').mockResolvedValue({
      writeFile: async (path: string) => { files.push(path); writeFileSync(path, ''); truncateSync(path, MAX_ATTACHMENT_BYTES + 1); },
      getReadableStream: () => Readable.from([]), headers: {},
    });
    expect(await adapter.downloadResource({ messageId: 'qa', fileKey: 'qa', filename: 'oversized.bin', isImage: false })).toBeNull();
    expect(files.every(file => !existsSync(file))).toBe(true);
  });
  it('keeps mention-prefix removal intact', () => {
    expect(stripMentionPrefix('<at user_id="qa">QA</at> Read this')).toBe('Read this');
  });
});
