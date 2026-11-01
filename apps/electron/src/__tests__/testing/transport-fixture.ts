import { strict as assert } from "node:assert";
import { WsRpcClient, type TransportConnectionState } from "../../transport/client";



export function assertRpcError(error: unknown): asserts error is Error & { code: string } {
  assert(error instanceof Error)
  assert('code' in error && typeof error.code === 'string')
}


/** Wait for client to be connected. */
export async function waitConnected(client: WsRpcClient, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!client.isConnected) {
    if (Date.now() - start > timeoutMs) throw new Error('Connection timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}


/** Wait for observable transport state, including transient reconnect events. */
export async function waitForState(
  client: WsRpcClient,
  predicate: (state: TransportConnectionState) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  if (predicate(client.getConnectionState())) return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Status wait timeout. Last status: ${client.getConnectionState().status}`));
    }, timeoutMs);
    unsubscribe = client.onConnectionStateChanged((state) => {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}


export async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Condition wait timeout')
    }
    await new Promise(r => setTimeout(r, 10))
  }
}
