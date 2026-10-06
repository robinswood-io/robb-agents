import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionAttachmentsPath } from '@craft-agent/shared/sessions/storage';
import type { FileAttachment } from '@craft-agent/shared/protocol';
import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '@craft-agent/core/types';
import type { SendMessageOptions } from '@craft-agent/shared/protocol';

/** Same logical handoff yields one inbox record; a new objective gets a new key. */
export function agentDeliveryId(sender: string, objective: string, target: string, content: string, attachments?: unknown): string {
  return `delivery_${createHash('sha256').update(JSON.stringify([sender, objective, target, content, attachments ?? []])).digest('hex')}`;
}

export function recoveredInternalMessageOptions(message: Message): SendMessageOptions | undefined {
  if (!message.internalOrigin && !message.hidden) return undefined;
  return { hidden: message.hidden, internalOrigin: message.internalOrigin };
}

/** Resolve only on fsynced acceptance, without awaiting the recipient's model turn. */
export function acknowledgeDurableDelivery(
  dispatch: (ack: (messageId: string) => void) => Promise<void>,
  onProcessingError: (error: unknown) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let accepted = false;
    const ack = (id: string) => { accepted = true; resolve(id); };
    try {
      void dispatch(ack).then(() => {
        if (!accepted) reject(new Error('Recipient did not acknowledge durable acceptance'));
      }, error => { if (accepted) onProcessingError(error); else reject(error); });
    } catch (error) { reject(error); }
  });
}

/** Private immutable payload, fsynced before the inbox receipt references it. */
export function persistAgentDeliveryAttachments(root: string, sessionId: string, attachments?: FileAttachment[]): string | undefined {
  if (!attachments?.length) return undefined;
  const payload = JSON.stringify(attachments);
  const digest = createHash('sha256').update(payload).digest('hex');
  const directory = getSessionAttachmentsPath(root, sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `delivery-${digest}.json`);
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== payload) throw new Error('Attachment bundle integrity mismatch');
    return digest;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* No committed bundle to remove. */ }
    throw error;
  }
  return digest;
}
export function restoreAgentDeliveryAttachments(root: string, sessionId: string, digest: string): FileAttachment[] {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid attachment bundle digest');
  const payload = readFileSync(join(getSessionAttachmentsPath(root, sessionId), `delivery-${digest}.json`), 'utf8');
  if (createHash('sha256').update(payload).digest('hex') !== digest) throw new Error('Attachment bundle integrity mismatch');
  return JSON.parse(payload) as FileAttachment[];
}
