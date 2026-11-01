import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

export function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}
