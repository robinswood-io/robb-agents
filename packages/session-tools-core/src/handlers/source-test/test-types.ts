import type { z } from 'zod';
import type { SourceTestSchema } from '../../tool-defs/schemas.ts';

export type SourceTestArgs = z.infer<typeof SourceTestSchema>;

