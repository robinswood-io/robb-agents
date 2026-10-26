import { getPermissionMode, setPermissionMode, cyclePermissionMode, type PermissionMode } from "../mode-manager.ts";
// Centralized PreToolUse pipeline
// Centralized PreToolUse pipeline
import { resolveContextualGmailPromptReservation } from "../core/pre-tool-use.ts";
import type { ClaudeAgent } from '../claude-agent.ts';
import type { ClaudeCheckToolPermissionResult } from './protocol.ts';

// Config watcher methods (startConfigWatcher, stopConfigWatcher) are now inherited from BaseAgent
  // Thinking level methods (setThinkingLevel, getThinkingLevel) are inherited from BaseAgent

  // Permission command utilities (getBaseCommand, isDangerousCommand, extractDomainFromNetworkCommand)
  // are now available via this.permissionManager

  /**
   * Respond to a pending permission request.
   * Uses permissionManager for whitelisting.
   */
export function respondToPermission(transportOwner: ClaudeAgent, requestId: string, allowed: boolean, alwaysAllow: boolean): void {
    transportOwner["debug"](`respondToPermission: ${requestId}, allowed=${allowed}, alwaysAllow=${alwaysAllow}, pending=${transportOwner["pendingPermissions"].has(requestId)}`);
    const pending = transportOwner["pendingPermissions"].get(requestId);
    if (pending) {
        transportOwner["debug"](`Resolving permission promise for ${requestId}`);
        // If "always allow" was selected, remember it (with special handling for curl/wget)
        if (alwaysAllow && allowed) {
            if (['curl', 'wget'].includes(pending.baseCommand)) {
                // For curl/wget, whitelist the domain instead of the command
                const domain = transportOwner["permissionManager"].extractDomainFromNetworkCommand(pending.command);
                if (domain) {
                    transportOwner["permissionManager"].whitelistDomain(domain);
                    transportOwner["debug"](`Added domain "${domain}" to always-allowed domains`);
                }
            }
            else if (!transportOwner["permissionManager"].isDangerousCommand(pending.baseCommand)) {
                transportOwner["permissionManager"].whitelistCommand(pending.baseCommand);
                transportOwner["debug"](`Added "${pending.baseCommand}" to always-allowed commands`);
            }
        }
        pending.resolve(allowed);
        transportOwner["pendingPermissions"].delete(requestId);
    }
    else {
        transportOwner["debug"](`No pending permission found for ${requestId}`);
    }
}

/**
   * Fail closed and settle every permission promise owned by this agent.
   *
   * Detach the entries before resolving them so continuations cannot observe a
   * stale request or resolve it a second time while teardown is in progress.
   */
export function denyAllPendingPermissions(transportOwner: ClaudeAgent): void {
    if (transportOwner["pendingPermissions"].size === 0)
        return;
    const pendingPermissions = [...transportOwner["pendingPermissions"].values()];
    transportOwner["pendingPermissions"].clear();
    for (const pending of pendingPermissions) {
        pending.resolve(false);
    }
}

export function resolveContextualGmailPromptDecision(transportOwner: ClaudeAgent, sessionId: string, toolName: string, toolInput: Record<string, unknown>, toolUseId: string | undefined, approved: boolean) {
    const currentRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
    const currentAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(currentRequest);
    return resolveContextualGmailPromptReservation({
        sessionId,
        toolUseId,
        toolName,
        toolInput,
        approved,
        permissionMode: getPermissionMode(sessionId),
        activeSourceSlugs: Array.from(transportOwner["sourceManager"].getActiveSlugs()),
        objectiveAuthorizationSegments: typeof currentAuthority === 'object'
            ? currentAuthority.authorizationSegments
            : currentRequest ? [currentRequest] : [],
    });
}

// isInSafeMode() is now inherited from BaseAgent

  /**
   * Check if a tool requires permission and handle it
   * Returns true if allowed, false if denied
   */
export async function checkToolPermission(transportOwner: ClaudeAgent, toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<ClaudeCheckToolPermissionResult> {
    // Bash commands require permission
    if (toolName === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : JSON.stringify(input);
        const baseCommand = command.trim().split(/\s+/)[0] || command;
        const requestId = `perm-${toolUseId}`;
        // Create a promise that will be resolved when user responds
        const permissionPromise = new Promise<boolean>((resolve) => {
            transportOwner["pendingPermissions"].set(requestId, {
                resolve,
                toolName,
                command,
                baseCommand,
            });
        });
        // Notify application of permission request via callback (not event yield)
        if (transportOwner["onPermissionRequest"]) {
            transportOwner["onPermissionRequest"]({
                requestId,
                toolName,
                toolUseId,
                command,
                description: `Execute bash command: ${command}`,
            });
        }
        else {
            // No permission handler - deny by default for safety
            transportOwner["pendingPermissions"].delete(requestId);
            return { allowed: false, updatedInput: input };
        }
        // Wait for user response
        const allowed = await permissionPromise;
        return { allowed, updatedInput: input };
    }
    // All other tools are auto-approved
    return { allowed: true, updatedInput: input };
}

/**
   * Get current permission mode.
   */
export function getPermissionModeOperation(transportOwner: ClaudeAgent): PermissionMode {
    return getPermissionMode(transportOwner["modeSessionId"]);
}

/**
   * Set permission mode.
   */
export function setPermissionModeOperation(transportOwner: ClaudeAgent, mode: PermissionMode): void {
    setPermissionMode(transportOwner["modeSessionId"], mode);
}

/**
   * Cycle to next permission mode.
   */
export function cyclePermissionModeOperation(transportOwner: ClaudeAgent): PermissionMode {
    return cyclePermissionMode(transportOwner["modeSessionId"]);
}
