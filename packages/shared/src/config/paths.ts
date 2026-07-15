/**
 * Centralized path configuration for Robb Agents.
 *
 * Robb is a compatible Craft Agents distribution: on a normal launch it uses
 * the existing ~/.craft-agent root directly, so workspaces (and therefore
 * sessions, sources, skills and projects), global preferences and credentials
 * are immediately available without copying or migrating any user data.
 *
 * CRAFT_CONFIG_DIR remains an explicit opt-in override for tests, development
 * instances and users who deliberately want an isolated profile.
 */

import { homedir } from 'os';
import { join } from 'path';

export function resolveConfigDir(
  override: string | undefined = process.env.CRAFT_CONFIG_DIR,
  home: string = homedir(),
): string {
  return override || join(home, '.craft-agent');
}

export const CONFIG_DIR = resolveConfigDir();
