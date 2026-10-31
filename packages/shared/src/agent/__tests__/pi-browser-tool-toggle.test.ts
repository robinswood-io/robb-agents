import { describe, it, expect } from 'bun:test'
import { filterPiSessionToolDefs } from '../pi-agent/subprocess-start.ts'

function toolDefinitions(): Parameters<typeof filterPiSessionToolDefs>[0] {
  return [
    { name: 'mcp__session__SubmitPlan', description: 'Submit a plan', inputSchema: { type: 'object' } },
    { name: 'mcp__session__browser_tool', description: 'Use the browser', inputSchema: { type: 'object' } },
    { name: 'mcp__session__config_validate', description: 'Validate configuration', inputSchema: { type: 'object' } },
  ]
}

describe('pi-agent browser_tool toggle', () => {
  it('omits the disabled browser without removing the other session tools', () => {
    const tools = toolDefinitions()
    const registered = filterPiSessionToolDefs(tools, false, false)
    expect(registered.map(tool => tool.name)).toEqual([
      'mcp__session__SubmitPlan', 'mcp__session__config_validate',
    ])
    expect(tools).toHaveLength(3)
  })

  it('keeps the enabled browser and the original tool definitions', () => {
    const tools = toolDefinitions()
    const registered = filterPiSessionToolDefs(tools, true, false)
    expect(registered).toEqual(tools)
    expect(registered.map(tool => tool.name)).toContain('mcp__session__browser_tool')
  })
})
