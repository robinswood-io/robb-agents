import type { McpClientPool } from '../mcp-pool.ts';
import { normalizeInputSchema, sanitizeToolNamePart, withOutputBudgetGuidance } from './shared.ts';
import type { ProxyToolDef, ProxyToolCapabilities } from './shared.ts';

export function getProxyToolName(transportOwner: McpClientPool, slug: string, originalName: string): string | null {
    return transportOwner["sourceToolProxyNames"].get(slug)?.get(originalName) ?? null;
}

export function getProxyToolLocalName(transportOwner: McpClientPool, slug: string, originalName: string): string | null {
    const proxyName = transportOwner["getProxyToolName"](slug, originalName);
    if (!proxyName)
        return null;
    const prefix = `mcp__${sanitizeToolNamePart(slug)}__`;
    return proxyName.startsWith(prefix) ? proxyName.slice(prefix.length) : proxyName;
}

export function getProxyToolDefs(transportOwner: McpClientPool, slugs?: string[]): ProxyToolDef[] {
    const targetSlugs = slugs || Array.from(transportOwner["toolCache"].keys());
    const defs: ProxyToolDef[] = [];
    for (const slug of targetSlugs) {
        const tools = transportOwner["toolCache"].get(slug) || [];
        for (const tool of tools) {
            const proxyName = transportOwner["getProxyToolName"](slug, tool.name);
            if (!proxyName)
                continue;
            const inputSchema = normalizeInputSchema(tool.inputSchema);
            defs.push({
                name: proxyName,
                description: withOutputBudgetGuidance(tool.description || `Tool from ${slug}`, tool.name, inputSchema),
                inputSchema,
                ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
                readOnly: tool.annotations?.readOnlyHint,
                idempotent: tool.annotations?.idempotentHint,
                destructive: tool.annotations?.destructiveHint,
                openWorld: tool.annotations?.openWorldHint,
            });
        }
    }
    return defs;
}

export function getProxyToolCapabilities(transportOwner: McpClientPool, proxyName: string): ProxyToolCapabilities | undefined {
    for (const [slug, tools] of transportOwner["toolCache"].entries()) {
        for (const tool of tools) {
            if (transportOwner["getProxyToolName"](slug, tool.name) !== proxyName)
                continue;
            return {
                readOnly: tool.annotations?.readOnlyHint,
                idempotent: tool.annotations?.idempotentHint,
                destructive: tool.annotations?.destructiveHint,
                openWorld: tool.annotations?.openWorldHint,
                trusted: false,
            };
        }
    }
    return undefined;
}

export function isProxyTool(transportOwner: McpClientPool, toolName: string): boolean {
    return transportOwner["proxyTools"].has(toolName);
}
