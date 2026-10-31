import { guardLargeResult } from "../../utils/large-response.ts";
import { collectionSummaryCache } from "../collection-cache.ts";
import { classifyToolNameMutationSemantics } from "../../agent/core/tool-name-semantics.ts";
import { saveBinaryResponse, detectExtensionFromMagic, sanitizeFilename } from "../../utils/binary-detection.ts";
import type { McpClientPool } from '../mcp-pool.ts';
import { normalizeInputSchema, normalizeStructuredContent } from './shared.ts';
import type { McpToolResult } from './shared.ts';

export async function callTool(transportOwner: McpClientPool, proxyName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const info = transportOwner.proxyTools.get(proxyName);
    if (!info) {
        return {
            content: `Unknown MCP proxy tool: ${proxyName}`,
            isError: true,
        };
    }
    const { slug, originalName } = info;
    const client = transportOwner["clients"].get(slug);
    if (!client) {
        return {
            content: `MCP client for source "${slug}" is not connected.`,
            isError: true,
            sourceSlug: slug,
        };
    }
    const sourceTool = transportOwner["toolCache"].get(slug)?.find(tool => tool.name === originalName);
    if (!sourceTool) {
        return {
            content: `MCP tool "${originalName}" is no longer advertised by source "${slug}".`,
            isError: true,
            sourceSlug: slug,
        };
    }
    const inputSchema = normalizeInputSchema(sourceTool.inputSchema);
    try {
        const schemaKey = JSON.stringify(inputSchema);
        let cachedValidator = transportOwner.toolInputValidators.get(proxyName);
        if (!cachedValidator || cachedValidator.schemaKey !== schemaKey) {
            cachedValidator = {
                schemaKey,
                validate: transportOwner.inputSchemaValidator.getValidator<Record<string, unknown>>(inputSchema),
            };
            transportOwner.toolInputValidators.set(proxyName, cachedValidator);
        }
        const validation = cachedValidator.validate(args);
        if (!validation.valid) {
            return {
                content: `Invalid arguments for MCP tool "${originalName}". The call was blocked before execution.`,
                isError: true,
                sourceSlug: slug,
            };
        }
    }
    catch (error) {
        transportOwner.debug(`Invalid input schema for ${proxyName}: ${error instanceof Error ? error.message : String(error)}`);
        return {
            content: `MCP tool "${originalName}" has an invalid input schema and was not executed.`,
            isError: true,
            sourceSlug: slug,
        };
    }
    const possibleMutation = classifyToolNameMutationSemantics(originalName) !== 'neutral'
        || (typeof args["method"] === 'string' && !['GET', 'HEAD'].includes(args["method"].toUpperCase()));
    const mutationWorkspace = possibleMutation ? transportOwner["resolveCollectionCacheScope"]()?.workspace : undefined;
    try {
        // This is deliberately the final awaited host fence before dispatching to
        // either a remote MCP transport or an in-process API source client.
        await transportOwner["beforeSourceToolExecution"]?.({
            sourceSlug: slug,
            toolName: originalName,
            args,
            capabilities: transportOwner["getProxyToolCapabilities"](proxyName),
        });
        // Names only invalidate; they never authorize a cached source call. Sources
        // are always read afresh, including tools with remote readOnly annotations.
        if (mutationWorkspace)
            collectionSummaryCache.invalidateWorkspace(mutationWorkspace);
        const result = await client.callTool(originalName, args) as {
            content?: Array<{
                type: string;
                text?: unknown;
                data?: string;
                mimeType?: string;
            }>;
            isError?: boolean;
            structuredContent?: unknown;
        };
        const structuredContent = normalizeStructuredContent(result.structuredContent);
        if (structuredContent && sourceTool.outputSchema) {
            try {
                const outputSchema = normalizeInputSchema(sourceTool.outputSchema);
                const schemaKey = JSON.stringify(outputSchema);
                let cachedValidator = transportOwner.toolOutputValidators.get(proxyName);
                if (!cachedValidator || cachedValidator.schemaKey !== schemaKey) {
                    cachedValidator = {
                        schemaKey,
                        validate: transportOwner.inputSchemaValidator.getValidator<Record<string, unknown>>(outputSchema),
                    };
                    transportOwner.toolOutputValidators.set(proxyName, cachedValidator);
                }
                if (!cachedValidator.validate(structuredContent).valid) {
                    return {
                        content: `MCP tool "${originalName}" returned structured output that does not match its declared schema.`,
                        isError: true,
                        sourceSlug: slug,
                    };
                }
            }
            catch (error) {
                transportOwner.debug(`Invalid output schema for ${proxyName}: ${error instanceof Error ? error.message : String(error)}`);
                return {
                    content: `MCP tool "${originalName}" has an invalid output schema. Its structured result was rejected.`,
                    isError: true,
                    sourceSlug: slug,
                };
            }
        }
        const contentBlocks = result.content || [];
        const parts: string[] = [];
        // 1. Process each content block — handle text, image, audio
        for (const block of contentBlocks) {
            if (block.type === 'text') {
                // Handle non-string text fields (e.g., objects from non-conforming servers)
                if (typeof block.text === 'string') {
                    parts.push(block.text);
                }
                else if (block.text !== undefined && block.text !== null) {
                    parts.push(JSON.stringify(block.text, null, 2));
                }
            }
            else if ((block.type === 'image' || block.type === 'audio') && block.data && transportOwner["sessionPath"]) {
                // Decode base64 binary content and save to downloads/
                try {
                    const buffer = Buffer.from(block.data, 'base64');
                    const ext = detectExtensionFromMagic(buffer) || '.bin';
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                    const safeName = sanitizeFilename(proxyName);
                    const filename = `${safeName}_${timestamp}${ext}`;
                    const saved = saveBinaryResponse(transportOwner["sessionPath"], filename, buffer, block.mimeType ?? null);
                    if (saved.type === 'file_download') {
                        parts.push(`[${block.type.charAt(0).toUpperCase() + block.type.slice(1)} saved: ${saved.path} (${saved.sizeHuman})]`);
                    }
                }
                catch {
                    // Base64 decode failed — skip this block
                }
            }
        }
        // 2. Combine parts (fallback to JSON.stringify if no content extracted)
        const text = parts.join('\n') || JSON.stringify(result);
        // 3. Centralized binary + large response handling
        if (!result.isError && transportOwner["sessionPath"]) {
            const guarded = await guardLargeResult(text, {
                sessionPath: transportOwner["sessionPath"],
                toolName: proxyName,
                input: args,
                ...(transportOwner.summarizeCallback !== undefined ? { summarize: transportOwner.summarizeCallback } : {}),
            });
            if (guarded) {
                return { content: guarded, isError: false };
            }
        }
        return {
            content: text,
            isError: !!result.isError,
            ...(structuredContent ? { structuredContent } : {}),
        };
    }
    catch (err) {
        return {
            content: `MCP tool "${originalName}" (source: ${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
            sourceSlug: slug,
        };
    }
    finally {
        if (mutationWorkspace)
            collectionSummaryCache.invalidateWorkspace(mutationWorkspace);
    }
}
