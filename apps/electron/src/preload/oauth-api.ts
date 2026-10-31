import { omitUndefined } from '@craft-agent/shared/utils/json'
import { assertOAuthStart, assertOAuthResult } from '@craft-agent/shared/protocol'
import { shell } from 'electron'
import { createCallbackServer, type CallbackPayload, type CallbackServer } from '@craft-agent/shared/auth/callback-server'
import { CHATGPT_OAUTH_CONFIG } from '@craft-agent/shared/auth/chatgpt-oauth-config'
import { GOOGLE_GEMINI_OAUTH_CONFIG } from '@craft-agent/shared/auth/google-gemini-oauth'
import type { RpcClient } from '@craft-agent/server-core/transport'
import type { ElectronAPI } from '../shared/types'
import { openSafeExternalUrl } from './safe-external-url'

type OAuthApi = Pick<ElectronAPI, "performOAuth" | "startClaudeOAuth" | "startMistralVibeSetup" | "startChatGptOAuth" | "startGeminiOAuth">;


export function configureOAuthApi(api: OAuthApi, client: RpcClient): void {
    api.performOAuth = async (args: {
        sourceSlug: string;
        sessionId?: string;
        authRequestId?: string;
    }): Promise<{
        success: boolean;
        error?: string;
        email?: string;
    }> => {
        let callbackServer: CallbackServer | null = null;
        let flowId: string | undefined;
        let state: string | undefined;
        try {
            // 1. Start local callback server to receive OAuth redirect
            callbackServer = await createCallbackServer({ appType: 'electron' });
            const callbackUrl = `${callbackServer.url}/callback`;
            // 2. Ask server to prepare the flow (PKCE, auth URL, store in flow store)
            const startResult = await client.invoke('oauth:start', {
                sourceSlug: args.sourceSlug,
                callbackUrl,
                sessionId: args.sessionId,
                authRequestId: args.authRequestId,
            });
            assertOAuthStart(startResult);
            flowId = startResult.flowId;
            state = startResult.state;
            // 3. Open browser for user consent (local — must open on the user's machine, not remote server)
            await openSafeExternalUrl(startResult.authUrl, (safeUrl) => shell.openExternal(safeUrl));
            // 4. Wait for OAuth provider to redirect to our callback server
            const callback = await callbackServer.promise;
            // 5. Check for errors from the provider
            if (callback.query["error"]) {
                const error = callback.query["error_description"] || callback.query["error"];
                await client.invoke('oauth:cancel', { flowId, state });
                return { success: false, error };
            }
            const code = callback.query["code"];
            if (!code) {
                await client.invoke('oauth:cancel', { flowId, state });
                return { success: false, error: 'No authorization code received' };
            }
            // 6. Send code to server for token exchange + credential storage
            const result = await client.invoke('oauth:complete', { flowId, code, state });
            assertOAuthResult(result);
            return omitUndefined({ success: result.success, error: result.error, email: result.email });
        }
        catch (err) {
            // Clean up server-side flow on error
            if (flowId && state) {
                client.invoke('oauth:cancel', { flowId, state }).catch(() => { });
            }
            return {
                success: false,
                error: err instanceof Error ? err.message : 'OAuth flow failed',
            };
        }
        finally {
            callbackServer?.close();
        }
    };
    api.startClaudeOAuth = async (): Promise<{
        success: boolean;
        authUrl?: string;
        error?: string;
    }> => {
        try {
            const result = await client.invoke('onboarding:startClaudeOAuth');
            assertOAuthResult(result);
            if (result.success && result.authUrl) {
                await openSafeExternalUrl(result.authUrl, (safeUrl) => shell.openExternal(safeUrl));
            }
            return result;
        }
        catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : 'Claude OAuth failed',
            };
        }
    };
    api.startMistralVibeSetup = async (): Promise<{
        success: boolean;
        error?: string;
    }> => {
        let flowId: string | undefined;
        try {
            const startResult = await client.invoke('onboarding:startMistralVibeSetup');
            assertOAuthResult(startResult);
            if (!startResult.success || !startResult.flowId || !startResult.authUrl) {
                return { success: false, error: startResult.error || 'Mistral Vibe authentication could not start' };
            }
            flowId = startResult.flowId;
            await openSafeExternalUrl(startResult.authUrl, (safeUrl) => shell.openExternal(safeUrl));
            const result = await client.invoke('onboarding:completeMistralVibeSetup', { flowId });
            assertOAuthResult(result);
            return omitUndefined({ success: result.success, error: result.error });
        }
        catch (err) {
            if (flowId) {
                client.invoke('onboarding:cancelMistralVibeSetup', { flowId }).catch(() => { });
            }
            return {
                success: false,
                error: err instanceof Error ? err.message : 'Mistral Vibe authentication failed',
            };
        }
    };
    // ── performChatGptOAuth ──────────────────────────────────────────────────
    // Same shape as performOAuth: callback server (port 1455) → chatgpt:startOAuth →
    // browser → callback → chatgpt:completeOAuth.
    // Track active OAuth callback servers so re-invocations cleanly close stale servers
    let activeChatGptCallbackServer: CallbackServer | null = null;
    let activeGeminiCallbackServer: CallbackServer | null = null;
    api.startChatGptOAuth = async (connectionSlug: string): Promise<{
        success: boolean;
        error?: string;
    }> => {
        if (activeChatGptCallbackServer) {
            try {
                activeChatGptCallbackServer.close();
            }
            catch {
                // Ignore cleanup error
            }
            activeChatGptCallbackServer = null;
        }
        let callbackServer: CallbackServer | null = null;
        let flowId: string | undefined;
        let state: string | undefined;
        try {
            // 1. Start callback server on ChatGPT's fixed port with /auth/callback path
            try {
                callbackServer = await createCallbackServer({
                    appType: 'electron',
                    port: CHATGPT_OAUTH_CONFIG.CALLBACK_PORT,
                    callbackPaths: ['/auth/callback'],
                });
                activeChatGptCallbackServer = callbackServer;
            }
            catch (bindErr: unknown) {
                const msg = bindErr instanceof Error ? bindErr.message : String(bindErr);
                const code = bindErr !== null && typeof bindErr === 'object' && 'code' in bindErr ? bindErr.code : undefined;
                if (msg.includes('already in use') || code === 'EADDRINUSE') {
                    throw new Error(`Port ${CHATGPT_OAUTH_CONFIG.CALLBACK_PORT} is in use by another application. Please ensure no other process is using port ${CHATGPT_OAUTH_CONFIG.CALLBACK_PORT} and try again.`);
                }
                throw bindErr;
            }
            // 2. Ask server to prepare the flow (PKCE, auth URL, store pending flow)
            const startResult = await client.invoke('chatgpt:startOAuth', connectionSlug);
            assertOAuthStart(startResult);
            flowId = startResult.flowId;
            state = startResult.state;
            // 3. Open browser for user consent
            await openSafeExternalUrl(startResult.authUrl, (safeUrl) => shell.openExternal(safeUrl));
            // 4. Wait for OpenAI to redirect to our callback server (with 5-minute timeout)
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error('ChatGPT authentication timed out. Please try again.'));
                }, 300000);
            });
            let callback: CallbackPayload;
            try {
                callback = await Promise.race([callbackServer.promise, timeoutPromise]);
            }
            finally {
                clearTimeout(timeoutId);
            }
            // 5. Check for errors from the provider
            if (callback.query["error"]) {
                const error = callback.query["error_description"] || callback.query["error"];
                await client.invoke('chatgpt:cancelOAuth', { state });
                return { success: false, error };
            }
            const code = callback.query["code"];
            if (!code) {
                await client.invoke('chatgpt:cancelOAuth', { state });
                return { success: false, error: 'No authorization code received' };
            }
            // 6. Send code to server for token exchange + credential storage
            const result = await client.invoke('chatgpt:completeOAuth', { flowId, code, state });
            assertOAuthResult(result);
            return omitUndefined({ success: result.success, error: result.error });
        }
        catch (err) {
            if (state) {
                client.invoke('chatgpt:cancelOAuth', { state }).catch(() => { });
            }
            return {
                success: false,
                error: err instanceof Error ? err.message : 'ChatGPT OAuth flow failed',
            };
        }
        finally {
            callbackServer?.close();
            if (activeChatGptCallbackServer === callbackServer) {
                activeChatGptCallbackServer = null;
            }
        }
    };
    api.startGeminiOAuth = async (connectionSlug: string): Promise<{
        success: boolean;
        error?: string;
    }> => {
        if (activeGeminiCallbackServer) {
            try {
                activeGeminiCallbackServer.close();
            }
            catch {
                // Ignore cleanup error
            }
            activeGeminiCallbackServer = null;
        }
        let callbackServer: CallbackServer | null = null;
        let flowId: string | undefined;
        let state: string | undefined;
        try {
            try {
                callbackServer = await createCallbackServer({
                    appType: 'electron',
                    port: GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PORT,
                    callbackPaths: [GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PATH],
                    host: '127.0.0.1',
                });
                activeGeminiCallbackServer = callbackServer;
            }
            catch (bindErr: unknown) {
                const msg = bindErr instanceof Error ? bindErr.message : String(bindErr);
                const code = bindErr !== null && typeof bindErr === 'object' && 'code' in bindErr ? bindErr.code : undefined;
                if (msg.includes('already in use') || code === 'EADDRINUSE') {
                    throw new Error(`Port ${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PORT} is in use by another application. Please ensure no other process is using port ${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PORT} and try again.`);
                }
                throw bindErr;
            }
            const redirectUri = `${callbackServer.url}${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PATH}`;
            const startResult = await client.invoke('gemini:startOAuth', { connectionSlug, redirectUri });
            assertOAuthStart(startResult);
            flowId = startResult.flowId;
            state = startResult.state;
            await openSafeExternalUrl(startResult.authUrl, (safeUrl) => shell.openExternal(safeUrl));
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error('Google Gemini authentication timed out. Please try again.'));
                }, 300000);
            });
            let callback: CallbackPayload;
            try {
                callback = await Promise.race([callbackServer.promise, timeoutPromise]);
            }
            finally {
                clearTimeout(timeoutId);
            }
            if (callback.query["error"]) {
                const error = callback.query["error_description"] || callback.query["error"];
                await client.invoke('gemini:cancelOAuth', { state });
                return { success: false, error };
            }
            const code = callback.query["code"];
            if (!code) {
                await client.invoke('gemini:cancelOAuth', { state });
                return { success: false, error: 'No authorization code received' };
            }
            const result = await client.invoke('gemini:completeOAuth', { flowId, code, state });
            assertOAuthResult(result);
            return omitUndefined({ success: result.success, error: result.error });
        }
        catch (err) {
            if (state) {
                client.invoke('gemini:cancelOAuth', { state }).catch(() => { });
            }
            return {
                success: false,
                error: err instanceof Error ? err.message : 'Google Gemini OAuth flow failed',
            };
        }
        finally {
            callbackServer?.close();
            if (activeGeminiCallbackServer === callbackServer) {
                activeGeminiCallbackServer = null;
            }
        }
    };
}
