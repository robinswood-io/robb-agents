import { getAutomationValidationSteps } from './validation-automations.ts';
import { getCleanupValidationSteps } from './validation-cleanup.ts';
import { getHostValidationSteps } from './validation-host.ts';
import { getSessionValidationSteps } from './validation-sessions.ts';
import { getSkillValidationSteps } from './validation-skills.ts';
import { getSourceValidationSteps } from './validation-sources.ts';
import type { ValidateStep } from './validation-types.ts';

export function getValidateSteps(): ValidateStep[] {
  return [
    ...getHostValidationSteps(),
    ...getSessionValidationSteps(),
    ...getSourceValidationSteps(),
    ...getSkillValidationSteps(),
    ...getAutomationValidationSteps(),
    ...getCleanupValidationSteps(),
  ]
}
