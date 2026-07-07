/**
 * Centralized path configuration for Robinswood Agents.
 *
 * Keeps the historical CRAFT_CONFIG_DIR environment variable for compatibility
 * and multi-instance development, but defaults Robinswood builds to an isolated
 * ~/.robinswood-agents directory so the private distribution does not share
 * configuration or credentials with upstream Craft Agents installs.
 */

import { homedir } from 'os';
import { join } from 'path';

// Allow override via environment variable for multi-instance dev and explicit migrations.
// Falls back to isolated ~/.robinswood-agents/ for Robinswood production builds.
export const CONFIG_DIR = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.robinswood-agents');
