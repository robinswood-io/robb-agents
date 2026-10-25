import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { ensureConfinedDirectory, openConfinedRegularFile, unlinkConfinedRegularFile, type ConfinedRegularFile } from "../../missions/confined-file.ts";
import type { SpecializedProfileRegistryStore } from '../registry-store.ts';
import { STORE_DIRECTORY_MODE, STORE_FILE_MODE, SpecializedProfileRegistryBusyError, isNodeError, isRecord, processIsAlive } from './shared.ts';

export async function withLock<T>(transportOwner: SpecializedProfileRegistryStore, operation: () => Promise<T>): Promise<T> {
    transportOwner["ensureStoreDirectory"]();
    const handle = transportOwner["acquireLock"]();
    try {
        return await operation();
    }
    finally {
        try {
            unlinkConfinedRegularFile(handle);
        }
        finally {
            handle.close();
        }
    }
}

export function acquireLock(transportOwner: SpecializedProfileRegistryStore): ConfinedRegularFile {
    const createLock = () => {
        const handle = openConfinedRegularFile(transportOwner["workspaceRoot"], transportOwner["lockPath"], {
            flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            mode: STORE_FILE_MODE,
            allowCreate: true,
        });
        writeSync(handle.descriptor, JSON.stringify({ pid: process.pid, acquiredAt: transportOwner["now"]().toISOString() }), undefined, 'utf8');
        fsyncSync(handle.descriptor);
        handle.assertStillBound();
        return handle;
    };
    try {
        return createLock();
    }
    catch (error) {
        if (!isNodeError(error, 'EEXIST'))
            throw error;
    }
    let existing: ConfinedRegularFile;
    try {
        existing = openConfinedRegularFile(transportOwner["workspaceRoot"], transportOwner["lockPath"], { flags: constants.O_RDONLY });
        const lockStat = fstatSync(existing.descriptor);
        let ownerPid: number | undefined;
        try {
            const metadata: unknown = JSON.parse(readFileSync(existing.descriptor, 'utf8'));
            if (isRecord(metadata) && Number.isSafeInteger(metadata.pid) && Number(metadata.pid) > 0) {
                ownerPid = Number(metadata.pid);
            }
        }
        catch { /* age remains the fallback for malformed abandoned locks */ }
        existing.assertStillBound();
        if ((ownerPid !== undefined && processIsAlive(ownerPid))
            || transportOwner["now"]().getTime() - lockStat.mtimeMs <= transportOwner["lockTimeoutMs"]) {
            existing.close();
            throw new SpecializedProfileRegistryBusyError(transportOwner["lockPath"]);
        }
        try {
            unlinkConfinedRegularFile(existing);
        }
        finally {
            existing.close();
        }
        return createLock();
    }
    catch (error) {
        if (error instanceof SpecializedProfileRegistryBusyError)
            throw error;
        if (isNodeError(error, 'ENOENT'))
            return createLock();
        throw new SpecializedProfileRegistryBusyError(transportOwner["lockPath"]);
    }
}

export function ensureStoreDirectory(transportOwner: SpecializedProfileRegistryStore): string {
    const directory = ensureConfinedDirectory(transportOwner["workspaceRoot"], '.robb');
    if (process.platform !== 'win32') {
        const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
            fchmodSync(descriptor, STORE_DIRECTORY_MODE);
        }
        finally {
            closeSync(descriptor);
        }
    }
    return directory;
}
