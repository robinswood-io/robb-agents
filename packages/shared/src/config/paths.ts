/**
 * Centralized path configuration for Robb Agents.
 *
 * Robb is a compatible Craft Agents distribution. Stable production builds
 * use the existing ~/.craft-agent root, while development builds use the
 * isolated ~/.craft-agent-dev root so local development can never mutate or
 * lock production data.
 *
 * CRAFT_CONFIG_DIR remains an explicit opt-in override for tests, development
 * instances and users who deliberately want an isolated profile.
 */

import { homedir } from 'os';
import { join } from 'path';

export type RobbBuildChannel = 'development' | 'production';

export const PRODUCTION_CONFIG_DIR_NAME = '.craft-agent';
export const DEVELOPMENT_CONFIG_DIR_NAME = '.craft-agent-dev';

export function resolveBuildChannel(value: string | undefined): RobbBuildChannel {
  return value === 'development' ? 'development' : 'production';
}

export function resolveConfigDir(
  override: string | undefined = process.env.CRAFT_CONFIG_DIR,
  home: string = homedir(),
  channel: RobbBuildChannel = resolveBuildChannel(process.env.ROBB_BUILD_CHANNEL),
): string {
  if (override) return override;
  return join(
    home,
    channel === 'development' ? DEVELOPMENT_CONFIG_DIR_NAME : PRODUCTION_CONFIG_DIR_NAME,
  );
}

export const CONFIG_DIR = resolveConfigDir();
