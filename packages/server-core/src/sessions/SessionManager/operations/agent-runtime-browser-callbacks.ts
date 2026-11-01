import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import type { BrowserMutationUrlPolicy } from '@craft-agent/server-core/handlers';
import { mergeSessionScopedToolCallbacks, assertContextualGmailBrowserMutationTargetAllowed, isContextualGmailBrowserMutationGuardEnabled } from '@craft-agent/shared/agent';
import type { BrowserPaneFns } from '@craft-agent/shared/agent';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';

export function installRuntimeBrowserCallbacks(sessionOperationContext: SessionOperationContext, managed: ManagedSession) {
    // Wire up browser pane tools — merge BrowserPaneFns into session callbacks
    // so browser_* tools can delegate to BrowserPaneManager.
    //
    // Always register when EITHER a local BPM is set OR an RPC server is
    // available (which lets `getBrowserPaneManagerForSession` lazily build a
    // RemoteBrowserPaneManager). Calls fail per-method with
    // BROWSER_NO_CAPABLE_CLIENT if no desktop client is connected, instead
    // of "tool unavailable".
    sessionLog.info('[browser-pane] BPF gate check', {
        sessionId: managed.id,
        hasLocalBpm: !!sessionOperationContext.state.browserPaneManager,
        hasRpcServer: !!sessionOperationContext.state.rpcServer,
    });
    if (sessionOperationContext.state.browserPaneManager || sessionOperationContext.state.rpcServer) {
        const sid = managed.id;
        const bpm = sessionOperationContext.owner.getBrowserPaneManagerForSession(sid);
        if (!bpm) {
            throw new Error('Browser pane manager unavailable despite passing the gate — this is a bug.');
        }
        sessionLog.info('[browser-pane] BPF block resolved BPM', {
            sessionId: sid,
            bpmKind: sessionOperationContext.state.browserPaneManager === bpm ? 'local' : 'remote',
        });
        const workspaceId = managed.workspace.id;
        const resolveSessionBrowserInstance = async (toolName: string, options?: {
            show?: boolean;
        }): Promise<string> => {
            const instanceId = await bpm.createForSessionAsync(sid, {
                show: options?.show ?? false,
                workspaceId,
            });
            const info = await bpm.getInstanceAsync(instanceId);
            sessionLog.info(`[browser-pane] tool target resolved: ${toolName} session=${sid} instance=${instanceId} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`);
            return instanceId;
        };
        const currentBrowserMutationUrlPolicy = (): BrowserMutationUrlPolicy | undefined => isContextualGmailBrowserMutationGuardEnabled(sid)
            ? {
                reason: 'contextual-gmail-reply',
                blockedHosts: ['mail.google.com'],
                matchSubdomains: true,
            }
            : undefined;
        const resolveSessionBrowserMutationInstance = async (toolName: string): Promise<{
            instanceId: string;
            mutationPolicy?: BrowserMutationUrlPolicy;
        }> => {
            const instanceId = await resolveSessionBrowserInstance(toolName);
            const info = await bpm.getInstanceAsync(instanceId);
            if (!info) {
                throw new Error(`Browser mutation guard could not inspect resolved instance ${instanceId}.`);
            }
            assertContextualGmailBrowserMutationTargetAllowed(sid, info.currentUrl);
            return omitUndefined({ instanceId, mutationPolicy: currentBrowserMutationUrlPolicy() });
        };
        const resolveLifecycleWindowTarget = async (command: 'release' | 'close' | 'hide', requestedInstanceId?: string) => {
            const windows = await bpm.listInstancesAsync();
            if (windows.length === 0) {
                return { windows, reason: 'No browser windows are available. Use "open" first.' };
            }
            const validateTarget = (target: (typeof windows)[number] | undefined) => {
                if (!target) {
                    return { ok: false as const, reason: `Browser window "${requestedInstanceId}" not found. Use "windows" to list available windows.` };
                }
                if (target.boundSessionId && target.boundSessionId !== sid) {
                    return { ok: false as const, reason: `Browser window "${target.id}" is locked to session ${target.boundSessionId}.` };
                }
                if (!target.boundSessionId && target.ownerSessionId && target.ownerSessionId !== sid) {
                    return { ok: false as const, reason: `Browser window "${target.id}" is currently owned by session ${target.ownerSessionId}.` };
                }
                return { ok: true as const, target };
            };
            if (requestedInstanceId) {
                const validated = validateTarget(windows.find((w) => w.id === requestedInstanceId));
                if (!validated.ok) {
                    return omitUndefined({ windows, reason: validated.reason });
                }
                return { windows, target: validated.target };
            }
            const fallbackTarget = windows.find((w) => w.boundSessionId === sid)
                ?? windows.find((w) => w.ownerSessionId === sid);
            if (!fallbackTarget) {
                return { windows, reason: `No ${command} target is currently associated with this session. Use "windows", then "${command} <id>".` };
            }
            const validated = validateTarget(fallbackTarget);
            if (!validated.ok) {
                return omitUndefined({ windows, reason: validated.reason });
            }
            return { windows, target: validated.target };
        };
        sessionLog.info('[browser-pane] BPF registering browserPaneFns', { sessionId: sid });
        mergeSessionScopedToolCallbacks(sid, {
            browserPaneFns: {
                openPanel: async (options) => {
                    const instanceId = options?.background
                        ? await bpm.createForSessionAsync(sid, { show: false, workspaceId })
                        : await bpm.focusBoundForSessionAsync(sid, { workspaceId });
                    const info = await bpm.getInstanceAsync(instanceId);
                    sessionLog.info(`[browser-pane] route decision: browser_open session=${sid} instance=${instanceId} background=${options?.background ?? false} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`);
                    return { instanceId };
                },
                resolveCurrentWindow: async () => {
                    const instanceId = await resolveSessionBrowserInstance('browser_guard');
                    const info = await bpm.getInstanceAsync(instanceId);
                    if (!info) {
                        throw new Error(`Browser guard could not inspect resolved instance ${instanceId}.`);
                    }
                    return {
                        instanceId,
                        title: info.title,
                        url: info.currentUrl,
                    };
                },
                navigate: async (url) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_navigate');
                    return bpm.navigate(instanceId, url);
                },
                snapshot: async () => {
                    const instanceId = await resolveSessionBrowserInstance('browser_snapshot');
                    return bpm.getAccessibilitySnapshot(instanceId);
                },
                click: async (ref, options) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_click');
                    return bpm.clickElement(instanceId, ref, options, mutationPolicy);
                },
                clickAt: async (x, y) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_click_at');
                    return bpm.clickAtCoordinates(instanceId, x, y, mutationPolicy);
                },
                drag: async (x1, y1, x2, y2) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_drag');
                    return bpm.drag(instanceId, x1, y1, x2, y2, mutationPolicy);
                },
                fill: async (ref, value) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_fill');
                    return bpm.fillElement(instanceId, ref, value, mutationPolicy);
                },
                type: async (text) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_type');
                    return bpm.typeText(instanceId, text, mutationPolicy);
                },
                select: async (ref, value) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_select');
                    return bpm.selectOption(instanceId, ref, value, mutationPolicy);
                },
                setClipboard: async (text) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_set_clipboard');
                    return bpm.setClipboard(instanceId, text, mutationPolicy);
                },
                getClipboard: async () => {
                    const instanceId = await resolveSessionBrowserInstance('browser_get_clipboard');
                    return bpm.getClipboard(instanceId);
                },
                screenshot: async (options) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_screenshot');
                    return bpm.screenshot(instanceId, options);
                },
                screenshotRegion: async (options) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_screenshot_region');
                    return bpm.screenshotRegion(instanceId, options);
                },
                getConsoleLogs: async (options) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_console');
                    return bpm.getConsoleLogs(instanceId, options);
                },
                windowResize: async (options) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_window_resize');
                    return bpm.windowResize(instanceId, options.width, options.height);
                },
                getNetworkLogs: async (options) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_network');
                    return bpm.getNetworkLogs(instanceId, options);
                },
                waitFor: async (options) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_wait');
                    return bpm.waitFor(instanceId, options);
                },
                sendKey: async (options) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_key');
                    return bpm.sendKey(instanceId, options, mutationPolicy);
                },
                getDownloads: async (options) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_downloads');
                    return bpm.getDownloads(instanceId, options);
                },
                upload: async (ref, filePaths) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_upload');
                    return bpm.uploadFile(instanceId, ref, filePaths, mutationPolicy).then(() => { });
                },
                scroll: async (direction, amount) => {
                    const instanceId = await resolveSessionBrowserInstance('browser_scroll');
                    return bpm.scroll(instanceId, direction, amount);
                },
                goBack: async () => {
                    const instanceId = await resolveSessionBrowserInstance('browser_back');
                    return bpm.goBack(instanceId);
                },
                goForward: async () => {
                    const instanceId = await resolveSessionBrowserInstance('browser_forward');
                    return bpm.goForward(instanceId);
                },
                evaluate: async (expression) => {
                    const { instanceId, mutationPolicy } = await resolveSessionBrowserMutationInstance('browser_evaluate');
                    return bpm.evaluate(instanceId, expression, mutationPolicy);
                },
                focusWindow: async (targetInstanceId) => {
                    const windows = await bpm.listInstancesAsync();
                    if (windows.length === 0) {
                        throw new Error('No browser windows available to focus. Use "open" first.');
                    }
                    const target = targetInstanceId
                        ? windows.find(w => w.id === targetInstanceId)
                        : windows.find(w => w.boundSessionId === sid || w.ownerSessionId === sid);
                    if (!target) {
                        if (targetInstanceId) {
                            throw new Error(`Browser window "${targetInstanceId}" not found. Use "windows" to list available windows.`);
                        }
                        throw new Error('No browser window is currently bound to this session. Use "open --foreground" to create or reuse one.');
                    }
                    const availableToSession = !target.boundSessionId || target.boundSessionId === sid;
                    if (!availableToSession) {
                        throw new Error(`Browser window "${target.id}" is locked to session ${target.boundSessionId}.`);
                    }
                    if (!target.boundSessionId) {
                        bpm.bindSession(target.id, sid, { workspaceId });
                    }
                    bpm.focus(target.id);
                    const focused = await bpm.getInstanceAsync(target.id);
                    return {
                        instanceId: target.id,
                        title: focused?.title ?? target.title,
                        url: focused?.currentUrl ?? target.url,
                    };
                },
                releaseControl: async (requestedInstanceId) => {
                    if (requestedInstanceId === 'all') {
                        const before = await bpm.listInstancesAsync();
                        const beforeActive = before.filter((w) => !!w.agentControlActive).length;
                        bpm.clearAgentControl(sid);
                        const after = await bpm.listInstancesAsync();
                        const afterActive = after.filter((w) => !!w.agentControlActive).length;
                        const released = afterActive < beforeActive;
                        sessionLog.info(`[browser-pane] lifecycle release-all session=${sid} overlays=${beforeActive}->${afterActive}`);
                        return omitUndefined({
                            action: released ? 'released' as const : 'noop' as const,
                            requestedInstanceId,
                            affectedIds: released ? before.filter((w) => !!w.agentControlActive).map((w) => w.id) : [],
                            reason: released ? undefined : 'No active overlay was found for this session.',
                        });
                    }
                    const resolution = await resolveLifecycleWindowTarget('release', requestedInstanceId);
                    if (!resolution.target) {
                        sessionLog.info(`[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`);
                        return omitUndefined({
                            action: 'noop' as const,
                            ...(requestedInstanceId !== undefined ? { requestedInstanceId: requestedInstanceId } : {}),
                            affectedIds: [],
                            reason: resolution.reason,
                        });
                    }
                    const result = bpm.clearAgentControlForInstance(resolution.target.id, sid);
                    const action = result.released ? 'released' : 'noop';
                    sessionLog.info(`[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=${action} reason=${result.reason ?? 'none'}`);
                    return {
                        action,
                        ...(requestedInstanceId !== undefined ? { requestedInstanceId: requestedInstanceId } : {}),
                        resolvedInstanceId: resolution.target.id,
                        affectedIds: result.released ? [resolution.target.id] : [],
                        ...(result.reason !== undefined ? { reason: result.reason } : {}),
                    };
                },
                closeWindow: async (requestedInstanceId) => {
                    const resolution = await resolveLifecycleWindowTarget('close', requestedInstanceId);
                    if (!resolution.target) {
                        sessionLog.info(`[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`);
                        return omitUndefined({
                            action: 'noop' as const,
                            ...(requestedInstanceId !== undefined ? { requestedInstanceId: requestedInstanceId } : {}),
                            affectedIds: [],
                            reason: resolution.reason,
                        });
                    }
                    bpm.destroyInstance(resolution.target.id);
                    sessionLog.info(`[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=closed`);
                    return {
                        action: 'closed',
                        ...(requestedInstanceId !== undefined ? { requestedInstanceId: requestedInstanceId } : {}),
                        resolvedInstanceId: resolution.target.id,
                        affectedIds: [resolution.target.id],
                    };
                },
                hideWindow: async (requestedInstanceId) => {
                    const resolution = await resolveLifecycleWindowTarget('hide', requestedInstanceId);
                    if (!resolution.target) {
                        sessionLog.info(`[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`);
                        return omitUndefined({
                            action: 'noop' as const,
                            ...(requestedInstanceId !== undefined ? { requestedInstanceId: requestedInstanceId } : {}),
                            affectedIds: [],
                            reason: resolution.reason,
                        });
                    }
                    bpm.hide(resolution.target.id);
                    sessionLog.info(`[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=hidden`);
                    return {
                        action: 'hidden',
                        ...(requestedInstanceId !== undefined ? { requestedInstanceId: requestedInstanceId } : {}),
                        resolvedInstanceId: resolution.target.id,
                        affectedIds: [resolution.target.id],
                    };
                },
                listWindows: async () => {
                    return bpm.listInstancesAsync();
                },
                detectChallenge: async () => {
                    const instanceId = await resolveSessionBrowserInstance('browser_detect_challenge');
                    return bpm.detectSecurityChallenge(instanceId);
                },
            } satisfies BrowserPaneFns,
        });
    }
}


