import { constants } from "node:fs";
import { join, relative, sep } from "node:path";
import { canonicalConfinementRoot, ensureConfinedDirectory, openConfinedRegularFile, type ConfinedRegularFile } from "@craft-agent/shared/missions";
import { errorCode, assertStorageSlug, readConfinedJson, writeConfinedJson, withLock, assertState, assertReceipt, sameReceiptMutation } from './shared.ts';
import type { ConnectorExecutionState, MutationReceipt } from './shared.ts';

export class MissionConnectorStateStore {
    private readonly workspaceRoot: string;
    constructor(workspaceRoot: string, private readonly workspaceId: string) {
        this.workspaceRoot = canonicalConfinementRoot(workspaceRoot);
    }
    read(missionId: string, workItemId: string): ConnectorExecutionState | null {
        this.assertIds(missionId, workItemId);
        return this.readStateAtPath(this.statePath(missionId, workItemId), missionId, workItemId);
    }
    initialize(initial: ConnectorExecutionState): ConnectorExecutionState {
        const validated = assertState(initial);
        this.assertStateBinding(validated, initial.missionId, initial.workItemId);
        const path = join(this.ensureDirectory(initial.missionId), `${initial.workItemId}.state.json`);
        return withLock(this.workspaceRoot, `${path}.lock`, (lock) => {
            lock.assertStillBound();
            const existing = this.readStateAtPath(path, initial.missionId, initial.workItemId);
            if (existing) {
                lock.assertStillBound();
                return existing;
            }
            let handle: ConfinedRegularFile;
            try {
                handle = openConfinedRegularFile(this.workspaceRoot, path, {
                    flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
                    mode: 0o600,
                    allowCreate: true,
                });
            }
            catch (error) {
                if (errorCode(error) !== 'EEXIST')
                    throw error;
                const raced = this.readStateAtPath(path, initial.missionId, initial.workItemId);
                if (!raced)
                    throw new Error('Mission connector state creation raced with removal');
                lock.assertStillBound();
                return raced;
            }
            try {
                // If the parent was replaced while the missing leaf was opened, the
                // lock binding fails before any state bytes are written.
                lock.assertStillBound();
                writeConfinedJson(handle, validated);
                lock.assertStillBound();
                return structuredClone(validated);
            }
            finally {
                handle.close();
            }
        });
    }
    update(missionId: string, workItemId: string, expectedRevision: number, update: (state: ConnectorExecutionState) => ConnectorExecutionState): ConnectorExecutionState {
        this.assertIds(missionId, workItemId);
        const path = join(this.ensureDirectory(missionId), `${workItemId}.state.json`);
        return withLock(this.workspaceRoot, `${path}.lock`, (lock) => {
            let handle: ConfinedRegularFile;
            try {
                handle = openConfinedRegularFile(this.workspaceRoot, path, { flags: constants.O_RDWR });
            }
            catch (error) {
                if (errorCode(error) === 'ENOENT')
                    throw new Error('Mission connector state is unavailable');
                throw error;
            }
            try {
                const current = this.stateFromHandle(handle, missionId, workItemId);
                if (current.revision !== expectedRevision)
                    throw new Error('Mission connector state changed concurrently');
                const next = assertState({ ...update(structuredClone(current)), revision: current.revision + 1 });
                this.assertStateBinding(next, missionId, workItemId);
                // Read and rewrite the same pinned descriptor. A final-component swap
                // can no longer redirect the truncation/write to an attacker file.
                lock.assertStillBound();
                writeConfinedJson(handle, next, { truncate: true });
                lock.assertStillBound();
                return next;
            }
            finally {
                handle.close();
            }
        });
    }
    writeReceipt(missionId: string, workItemId: string, receipt: MutationReceipt): string {
        this.assertIds(missionId, workItemId);
        const validated = assertReceipt(receipt);
        this.assertReceiptBinding(validated, missionId, workItemId);
        const path = join(this.ensureDirectory(missionId), `${workItemId}.receipt.json`);
        const uri = relative(this.workspaceRoot, path).split(sep).join('/');
        return withLock(this.workspaceRoot, `${path}.lock`, (lock) => {
            let handle: ConfinedRegularFile;
            try {
                handle = openConfinedRegularFile(this.workspaceRoot, path, {
                    flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
                    mode: 0o600,
                    allowCreate: true,
                });
            }
            catch (error) {
                if (errorCode(error) !== 'EEXIST')
                    throw error;
                const existing = this.readReceiptAtPath(path, missionId, workItemId);
                if (!existing || !sameReceiptMutation(existing, validated)) {
                    throw new Error('Mission connector receipt already exists with another mutation identity');
                }
                lock.assertStillBound();
                return uri;
            }
            try {
                lock.assertStillBound();
                writeConfinedJson(handle, validated);
                lock.assertStillBound();
                return uri;
            }
            finally {
                handle.close();
            }
        });
    }
    readReceipt(missionId: string, workItemId: string): MutationReceipt | null {
        this.assertIds(missionId, workItemId);
        return this.readReceiptAtPath(join(this.directory(missionId), `${workItemId}.receipt.json`), missionId, workItemId);
    }
    private assertIds(missionId: string, workItemId: string): void {
        assertStorageSlug('mission', missionId);
        assertStorageSlug('work item', workItemId);
    }
    private assertStateBinding(state: ConnectorExecutionState, missionId: string, workItemId: string): void {
        if (state.workspaceId !== this.workspaceId
            || state.missionId !== missionId
            || state.workItemId !== workItemId) {
            throw new Error('Mission connector state does not match its confined storage path');
        }
    }
    private assertReceiptBinding(receipt: MutationReceipt, missionId: string, workItemId: string): void {
        if (receipt.workspaceId !== this.workspaceId
            || receipt.missionId !== missionId
            || receipt.workItemId !== workItemId) {
            throw new Error('Mission connector receipt does not match its confined storage path');
        }
    }
    private stateFromHandle(handle: ConfinedRegularFile, missionId: string, workItemId: string): ConnectorExecutionState {
        const state = assertState(readConfinedJson(handle, 'Mission connector state'));
        this.assertStateBinding(state, missionId, workItemId);
        return state;
    }
    private readStateAtPath(path: string, missionId: string, workItemId: string): ConnectorExecutionState | null {
        let handle: ConfinedRegularFile;
        try {
            handle = openConfinedRegularFile(this.workspaceRoot, path, { flags: constants.O_RDONLY });
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT')
                return null;
            throw error;
        }
        try {
            return this.stateFromHandle(handle, missionId, workItemId);
        }
        finally {
            handle.close();
        }
    }
    private readReceiptAtPath(path: string, missionId: string, workItemId: string): MutationReceipt | null {
        let handle: ConfinedRegularFile;
        try {
            handle = openConfinedRegularFile(this.workspaceRoot, path, { flags: constants.O_RDONLY });
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT')
                return null;
            throw error;
        }
        try {
            const receipt = assertReceipt(readConfinedJson(handle, 'Mission connector receipt'));
            this.assertReceiptBinding(receipt, missionId, workItemId);
            return receipt;
        }
        finally {
            handle.close();
        }
    }
    private ensureDirectory(missionId: string): string {
        assertStorageSlug('mission', missionId);
        return ensureConfinedDirectory(this.workspaceRoot, 'missions', missionId, 'connector-executions');
    }
    private directory(missionId: string): string {
        assertStorageSlug('mission', missionId);
        return join(this.workspaceRoot, 'missions', missionId, 'connector-executions');
    }
    private statePath(missionId: string, workItemId: string): string {
        this.assertIds(missionId, workItemId);
        return join(this.directory(missionId), `${workItemId}.state.json`);
    }
}
