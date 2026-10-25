import http from "node:http";
import type { PiRuntimeState } from "./runtime-state.ts";
import { preExecuteCallLlm } from "./queries.ts";
import { debugLog } from "./stdio.ts";

// ============================================================
// Callback Server (for call_llm from session MCP server)
// ============================================================
export async function startCallbackServer(runtimeState: PiRuntimeState): Promise<void> {
    if (runtimeState.callbackServer)
        return;
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/call-llm') {
            res.writeHead(404);
            res.end();
            return;
        }
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of req)
                chunks.push(chunk as Buffer);
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            debugLog('Received call_llm request via callback server');
            const result = await preExecuteCallLlm(runtimeState, body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            debugLog(`call_llm via callback failed: ${msg}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'LLM callback failed' }));
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            runtimeState.callbackPort = typeof addr === 'object' && addr ? addr.port : 0;
            debugLog(`Callback server listening on 127.0.0.1:${runtimeState.callbackPort}`);
            resolve();
        });
        server.on('error', reject);
    });
    runtimeState.callbackServer = server;
}

export function stopCallbackServer(runtimeState: PiRuntimeState): void {
    if (runtimeState.callbackServer) {
        runtimeState.callbackServer.close();
        runtimeState.callbackServer = null;
        runtimeState.callbackPort = 0;
    }
}
