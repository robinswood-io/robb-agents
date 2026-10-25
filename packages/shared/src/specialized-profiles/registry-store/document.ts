import { constants, readFileSync } from "node:fs";
import { openConfinedRegularFile, type ConfinedRegularFile } from "../../missions/confined-file.ts";
import { SpecializedProfileRegistryAnchorSchema, SpecializedProfileRegistryDocumentSchema, type SpecializedProfileRegistryDocument } from "../schema.ts";
import type { SpecializedProfileRegistryStore } from '../registry-store.ts';
import { SpecializedProfileTransitionGateError, SpecializedProfileRegistryBusyError, isNodeError, registryAnchorRef, sameAnchorRef } from './shared.ts';

export async function load(transportOwner: SpecializedProfileRegistryStore): Promise<SpecializedProfileRegistryDocument | null> {
    return transportOwner["loadDocument"](false);
}

export async function loadDocument(transportOwner: SpecializedProfileRegistryStore, recover: boolean): Promise<SpecializedProfileRegistryDocument | null> {
    let handle: ConfinedRegularFile;
    try {
        handle = openConfinedRegularFile(transportOwner["workspaceRoot"], transportOwner["documentPath"], { flags: constants.O_RDONLY });
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return null;
        throw error;
    }
    try {
        const raw = readFileSync(handle.descriptor, 'utf8');
        handle.assertStillBound();
        const document = transportOwner["parseAndVerifyDocument"](JSON.parse(raw) as unknown);
        return await transportOwner["verifyAndRecoverAnchoredDocument"](document, recover);
    }
    finally {
        handle.close();
    }
}

export async function loadOrCreate(transportOwner: SpecializedProfileRegistryStore, workspaceId: string, actorId: string): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["withLock"](async () => {
        const existing = await transportOwner["loadDocument"](true);
        if (existing) {
            if (existing.workspaceId !== workspaceId) {
                throw new Error(`Specialized profile registry belongs to workspace "${existing.workspaceId}"`);
            }
            return existing;
        }
        transportOwner["requireDurableAuthority"]();
        const orphanedAnchor = await transportOwner["anchorStore"]!.load(workspaceId);
        if (orphanedAnchor) {
            const anchor = SpecializedProfileRegistryAnchorSchema.parse(orphanedAnchor);
            if (anchor.workspaceId === workspaceId
                && transportOwner["authority"]!.verifyRegistryAnchor(anchor)
                && anchor.committed === null
                && anchor.pending?.revision === 0) {
                const pending = transportOwner["readPendingDocument"]();
                if (pending.workspaceId === workspaceId
                    && pending.head.previousDocumentSha256 === null
                    && sameAnchorRef(anchor.pending, registryAnchorRef(pending))) {
                    transportOwner["promotePendingDocument"]();
                    await transportOwner["anchorStore"]!.save(workspaceId, transportOwner["sealAnchor"]({
                        schemaVersion: 1,
                        workspaceId,
                        committed: registryAnchorRef(pending),
                        updatedAt: transportOwner["now"]().toISOString(),
                    }));
                    return pending;
                }
            }
            throw new SpecializedProfileTransitionGateError('Specialized profile registry is missing while its host monotone anchor still exists');
        }
        const initial = transportOwner["sealDocument"]({
            schemaVersion: 2,
            workspaceId,
            revision: 0,
            updatedAt: transportOwner["now"]().toISOString(),
            updatedBy: actorId,
            profiles: [],
        }, null);
        await transportOwner["writeDocument"](initial, null);
        return initial;
    });
}

export function parseAndVerifyDocument(transportOwner: SpecializedProfileRegistryStore, value: unknown): SpecializedProfileRegistryDocument {
    const document = SpecializedProfileRegistryDocumentSchema.parse(value);
    if (!transportOwner["authority"]?.verifyRegistryHead(document)) {
        throw new SpecializedProfileTransitionGateError('Specialized profile registry lacks a valid whole-document host attestation');
    }
    for (const profile of document.profiles) {
        for (const evaluation of profile.evaluations) {
            const version = profile.versions[evaluation.profileVersion - 1]!;
            if (!transportOwner["authority"]?.verifyEvaluation({ evaluation, version })) {
                throw new SpecializedProfileTransitionGateError(`Evaluation "${evaluation.id}" lacks a valid host authority attestation`);
            }
        }
        for (const transition of profile.transitions) {
            const receipt = transition.approvalReceipt;
            if (!receipt)
                continue;
            const version = profile.versions[transition.profileVersion - 1]!;
            if (!transportOwner["authority"]?.verifyHumanApprovalReceipt({ receipt, version, transition })) {
                throw new SpecializedProfileTransitionGateError(`Human approval receipt "${receipt.receiptId}" lacks a valid host authority attestation`);
            }
        }
    }
    return document;
}

export async function verifyAndRecoverAnchoredDocument(transportOwner: SpecializedProfileRegistryStore, document: SpecializedProfileRegistryDocument, recover: boolean): Promise<SpecializedProfileRegistryDocument> {
    transportOwner["requireDurableAuthority"]();
    const anchorValue = await transportOwner["anchorStore"]!.load(document.workspaceId);
    if (!anchorValue) {
        throw new SpecializedProfileTransitionGateError('Specialized profile registry has no external monotone anchor');
    }
    const anchor = SpecializedProfileRegistryAnchorSchema.parse(anchorValue);
    if (anchor.workspaceId !== document.workspaceId || !transportOwner["authority"]!.verifyRegistryAnchor(anchor)) {
        throw new SpecializedProfileTransitionGateError('Specialized profile registry external anchor is invalid');
    }
    const current = registryAnchorRef(document);
    if (sameAnchorRef(anchor.pending, current)) {
        const expectedPrevious = anchor.committed?.documentSha256 ?? null;
        if (document.head.previousDocumentSha256 !== expectedPrevious) {
            throw new SpecializedProfileTransitionGateError('Specialized profile registry head chain is broken');
        }
        if (recover) {
            await transportOwner["anchorStore"]!.save(document.workspaceId, transportOwner["sealAnchor"]({
                schemaVersion: 1,
                workspaceId: document.workspaceId,
                committed: current,
                updatedAt: transportOwner["now"]().toISOString(),
            }));
        }
        return document;
    }
    if (sameAnchorRef(anchor.committed, current) && !anchor.pending)
        return document;
    if (sameAnchorRef(anchor.committed, current) && anchor.pending) {
        if (!recover) {
            throw new SpecializedProfileRegistryBusyError(transportOwner["lockPath"]);
        }
        const pending = transportOwner["readPendingDocument"]();
        if (!sameAnchorRef(anchor.pending, registryAnchorRef(pending))
            || pending.head.previousDocumentSha256 !== current.documentSha256) {
            throw new SpecializedProfileTransitionGateError('Pending specialized profile registry recovery does not match its external anchor');
        }
        transportOwner["promotePendingDocument"]();
        await transportOwner["anchorStore"]!.save(document.workspaceId, transportOwner["sealAnchor"]({
            schemaVersion: 1,
            workspaceId: document.workspaceId,
            committed: registryAnchorRef(pending),
            updatedAt: transportOwner["now"]().toISOString(),
        }));
        return pending;
    }
    throw new SpecializedProfileTransitionGateError('Specialized profile registry replay or unanchored composition detected');
}

export function readPendingDocument(transportOwner: SpecializedProfileRegistryStore): SpecializedProfileRegistryDocument {
    let handle: ConfinedRegularFile;
    try {
        handle = openConfinedRegularFile(transportOwner["workspaceRoot"], transportOwner["pendingDocumentPath"], { flags: constants.O_RDONLY });
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            throw new SpecializedProfileTransitionGateError('Pending specialized profile registry document is missing');
        }
        throw error;
    }
    try {
        const raw = readFileSync(handle.descriptor, 'utf8');
        handle.assertStillBound();
        return transportOwner["parseAndVerifyDocument"](JSON.parse(raw) as unknown);
    }
    finally {
        handle.close();
    }
}
