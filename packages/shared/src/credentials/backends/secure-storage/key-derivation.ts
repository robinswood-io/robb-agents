import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { userInfo, homedir } from "os";
import { join } from "path";
import { CONFIG_DIR } from "../../../config/paths.ts";

// File location — shared with existing Craft Agents installs by default, unless
// CRAFT_CONFIG_DIR explicitly selects an isolated profile.
const CREDENTIALS_DIR = CONFIG_DIR;

export const DEFAULT_CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.enc');

// File format constants
export const MAGIC_BYTES = Buffer.from('CRAFT01\0');

export const HEADER_SIZE = 64;

export const MAGIC_SIZE = 8;

export const FLAGS_SIZE = 4;

export const SALT_SIZE = 32;

export const IV_SIZE = 12;

export const AUTH_TAG_SIZE = 16;

export const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
export const PBKDF2_ITERATIONS = 100000;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 */
export function getStableMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID - tied to logic board, never changes
      const output = execFileSync(
        '/usr/sbin/ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: MachineGuid from registry - set at OS install
      const output = execFileSync(
        'reg',
        ['query', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id - set at OS install
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: username + homedir (stable enough for most cases)
  return `${userInfo().username}:${homedir()}`;
}
