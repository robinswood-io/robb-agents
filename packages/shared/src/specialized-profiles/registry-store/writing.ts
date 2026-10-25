import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { openConfinedRegularFile, type ConfinedRegularFile } from "../../missions/confined-file.ts";
import { SpecializedProfileRegistryAnchorSchema, SpecializedProfileRegistryDocumentSchema, canonicalSpecializedProfileRegistryPayloadHash, type SpecializedProfileRegistryAnchor, type SpecializedProfileRegistryDocument } from "../schema.ts";
import type { SpecializedProfileRegistryStore } from '../registry-store.ts';
import { STORE_FILE_MODE, SpecializedProfileRegistryRevisionConflictError, SpecializedProfileTransitionGateError, removeConfinedFileIfPresent, assertConfinedFileOrAbsent, assertPinnedDirectory, registryAnchorRef } from './shared.ts';

export async function update(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, actorId: string, mutate: (document: SpecializedProfileRegistryDocument, occurredAt: string) => Promise<void> | void): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["withLock"](async () => {
        const current = await transportOwner["loadDocument"](true);
        if (!current)
            throw new Error(`Specialized profile registry does not exist for workspace "${transportOwner["workspaceRoot"]}"`);
        if (current.revision !== expectedRevision) {
            throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
        }
        const next = structuredClone(current);
        const occurredAt = transportOwner["now"]().toISOString();
        await mutate(next, occurredAt);
        next.revision += 1;
        const mutationCompletedAt = transportOwner["now"]().toISOString();
        next.updatedAt = Date.parse(mutationCompletedAt) >= Date.parse(occurredAt)
            ? mutationCompletedAt
            : occurredAt;
        next.updatedBy = actorId;
        const sealed = transportOwner["sealDocument"](next, current.head.documentSha256);
        await transportOwner["writeDocument"](sealed, current);
        return sealed;
    });
}

export async function writeDocument(transportOwner: SpecializedProfileRegistryStore, document: SpecializedProfileRegistryDocument, previous: SpecializedProfileRegistryDocument | null): Promise<void> {
    const parsed = transportOwner["parseAndVerifyDocument"](document);
    transportOwner["requireDurableAuthority"]();
    const committed = previous ? registryAnchorRef(previous) : null;
    const pending = registryAnchorRef(parsed);
    const pendingAnchor = transportOwner["sealAnchor"]({
        schemaVersion: 1,
        workspaceId: parsed.workspaceId,
        committed,
        pending,
        updatedAt: transportOwner["now"]().toISOString(),
    });
    transportOwner["writeDocumentFile"](parsed, transportOwner["pendingDocumentPath"]);
    await transportOwner["anchorStore"]!.save(parsed.workspaceId, pendingAnchor);
    transportOwner["promotePendingDocument"]();
    const committedAnchor = transportOwner["sealAnchor"]({
        schemaVersion: 1,
        workspaceId: parsed.workspaceId,
        committed: pending,
        updatedAt: transportOwner["now"]().toISOString(),
    });
    await transportOwner["anchorStore"]!.save(parsed.workspaceId, committedAnchor);
}

export function writeDocumentFile(transportOwner: SpecializedProfileRegistryStore, document: SpecializedProfileRegistryDocument, destinationPath: string): void {
    const directory = transportOwner["ensureStoreDirectory"]();
    const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
    const directoryDescriptor = process.platform === 'win32'
        ? undefined
        : openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directoryIdentity = directoryDescriptor === undefined ? undefined : fstatSync(directoryDescriptor);
    let temporaryHandle: ConfinedRegularFile | undefined;
    try {
        temporaryHandle = openConfinedRegularFile(transportOwner["workspaceRoot"], temporaryPath, {
            flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            mode: STORE_FILE_MODE,
            allowCreate: true,
        });
        const payload = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
        let offset = 0;
        while (offset < payload.length) {
            offset += writeSync(temporaryHandle.descriptor, payload, offset, payload.length - offset);
        }
        fsyncSync(temporaryHandle.descriptor);
        temporaryHandle.assertStillBound();
        temporaryHandle.close();
        temporaryHandle = undefined;
        // Validate an existing destination before replacing it. This rejects
        // symbolic and hard links instead of letting rename() follow/replace them.
        assertConfinedFileOrAbsent(transportOwner["workspaceRoot"], destinationPath);
        if (directoryDescriptor !== undefined && directoryIdentity) {
            assertPinnedDirectory(directory, directoryDescriptor, directoryIdentity);
        }
        renameSync(temporaryPath, destinationPath);
        if (directoryDescriptor !== undefined && directoryIdentity) {
            assertPinnedDirectory(directory, directoryDescriptor, directoryIdentity);
        }
        const committed = openConfinedRegularFile(transportOwner["workspaceRoot"], destinationPath, { flags: constants.O_RDONLY });
        try {
            committed.assertStillBound();
            if (process.platform !== 'win32')
                fchmodSync(committed.descriptor, STORE_FILE_MODE);
        }
        finally {
            committed.close();
        }
        if (directoryDescriptor !== undefined)
            fsyncSync(directoryDescriptor);
    }
    catch (error) {
        temporaryHandle?.close();
        removeConfinedFileIfPresent(transportOwner["workspaceRoot"], temporaryPath);
        throw error;
    }
    finally {
        if (directoryDescriptor !== undefined)
            closeSync(directoryDescriptor);
    }
}

export function promotePendingDocument(transportOwner: SpecializedProfileRegistryStore): void {
    const directory = transportOwner["ensureStoreDirectory"]();
    const directoryDescriptor = process.platform === 'win32'
        ? undefined
        : openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directoryIdentity = directoryDescriptor === undefined ? undefined : fstatSync(directoryDescriptor);
    try {
        assertConfinedFileOrAbsent(transportOwner["workspaceRoot"], transportOwner["documentPath"]);
        const pending = openConfinedRegularFile(transportOwner["workspaceRoot"], transportOwner["pendingDocumentPath"], { flags: constants.O_RDONLY });
        try {
            pending.assertStillBound();
        }
        finally {
            pending.close();
        }
        if (directoryDescriptor !== undefined && directoryIdentity) {
            assertPinnedDirectory(directory, directoryDescriptor, directoryIdentity);
        }
        renameSync(transportOwner["pendingDocumentPath"], transportOwner["documentPath"]);
        if (directoryDescriptor !== undefined)
            fsyncSync(directoryDescriptor);
    }
    finally {
        if (directoryDescriptor !== undefined)
            closeSync(directoryDescriptor);
    }
}

export function sealDocument(transportOwner: SpecializedProfileRegistryStore, value: Omit<SpecializedProfileRegistryDocument, 'head'> | SpecializedProfileRegistryDocument, previousDocumentSha256: string | null): SpecializedProfileRegistryDocument {
    transportOwner["requireDurableAuthority"]();
    const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'head')) as Omit<SpecializedProfileRegistryDocument, 'head'>;
    const documentSha256 = canonicalSpecializedProfileRegistryPayloadHash(payload);
    return SpecializedProfileRegistryDocumentSchema.parse({
        ...payload,
        head: {
            schemaVersion: 1,
            revision: payload.revision,
            documentSha256,
            previousDocumentSha256,
            authority: transportOwner["authority"]!.attestRegistryHead({
                workspaceId: payload.workspaceId,
                revision: payload.revision,
                documentSha256,
                previousDocumentSha256,
            }),
        },
    });
}

export function sealAnchor(transportOwner: SpecializedProfileRegistryStore, value: Omit<SpecializedProfileRegistryAnchor, 'authority'>): SpecializedProfileRegistryAnchor {
    transportOwner["requireDurableAuthority"]();
    return SpecializedProfileRegistryAnchorSchema.parse({
        ...value,
        authority: transportOwner["authority"]!.attestRegistryAnchor(value),
    });
}

export function requireDurableAuthority(transportOwner: SpecializedProfileRegistryStore): void {
    if (!transportOwner["authority"] || !transportOwner["anchorStore"]) {
        throw new SpecializedProfileTransitionGateError('Specialized profile registry requires host authority and an external monotone anchor');
    }
}
