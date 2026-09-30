import { join } from 'node:path';
import { CONFIG_DIR } from '../../config/paths.ts';

/** Local app-only accounting: never mix global RTK users or Dev/production. */
export const RTK_STATE_DIR = join(CONFIG_DIR, 'rtk');
export const RTK_METRICS_PATH = join(RTK_STATE_DIR, 'output-savings.tsv');
