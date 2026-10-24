import type { CliSkill } from './rpc-shapes.ts';
import { waitForSendEvents } from './validation-events.ts';
import type { ValidateStep } from './validation-types.ts';

export function getSkillValidationSteps(): ValidateStep[] {
  return [
// ----- Skill lifecycle -----
    {
      name: 'send + skill create',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceRootPath) return 'skipped (no session or workspace)'
        ctx.createdSkillSlug = '__cli-validate-skill'
        const sourceSlug = ctx.createdSourceSlug ?? 'cat-facts'
        const skillDir = `${ctx.workspaceRootPath}/skills/${ctx.createdSkillSlug}`
        // Use bash to create the skill file deterministically
        return await waitForSendEvents(client, ctx.createdSessionId,
          `Use the Bash tool to run this exact command:
mkdir -p "${skillDir}" && cat > "${skillDir}/SKILL.md" << 'SKILLEOF'
---
name: "CLI Validate Skill"
description: "Validation skill created by craft-cli"
requiredSources:
  - "${sourceSlug}"
---

This skill does two things:
1. Check the current water temperature of Lake Balaton (search the web or estimate based on the season)
2. Use the Cat Facts source to get a random cat fact

Always perform both steps when this skill is invoked.
SKILLEOF`, 90_000, true, undefined, ctx.onEvent)
      },
    },
{
      name: 'skills:get (verify)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        const r = (await client.invoke('skills:get', ctx.workspaceId)) as CliSkill[]
        const found = r?.find((s) => s.slug === ctx.createdSkillSlug)
        if (!found) throw new Error(`Skill '${ctx.createdSkillSlug}' not found in skills list`)
        return `found: ${found.name ?? found.slug}`
      },
    },
{
      name: 'send + skill mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSkillSlug) return 'skipped (no session or skill)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[skill:${ctx.createdSkillSlug}] Run the skill`, 120_000, false,
          { skillSlugs: [ctx.createdSkillSlug] }, ctx.onEvent)
      },
    },
{
      name: 'skills:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        await client.invoke('skills:delete', ctx.workspaceId, ctx.createdSkillSlug)
        return `deleted skill: ${ctx.createdSkillSlug}`
      },
    }
  ]
}
