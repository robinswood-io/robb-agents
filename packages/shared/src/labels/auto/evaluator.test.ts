import { describe, expect, test } from 'bun:test'
import { evaluateAutoLabels, collectAutoLabelRules } from './evaluator.ts'
import type { LabelConfig } from '../types.ts'

const testLabels: LabelConfig[] = [
  {
    id: 'development',
    name: 'Development',
    children: [
      { id: 'bug', name: 'Bug' },
      { id: 'code', name: 'Code' },
      { id: 'automation', name: 'Automation' },
    ],
  },
  {
    id: 'content',
    name: 'Content',
    children: [
      { id: 'writing', name: 'Writing' },
      { id: 'research', name: 'Research' },
      { id: 'design', name: 'Design' },
    ],
  },
  {
    id: 'priority',
    name: 'Priority',
    valueType: 'number',
    autoRules: [
      {
        pattern: 'P([0-3])',
        valueTemplate: '$1',
      },
    ],
  },
  {
    id: 'auth',
    name: 'Auth',
  },
]

describe('evaluateAutoLabels', () => {
  test('automatically matches bug topic in English and French', () => {
    const enMatches = evaluateAutoLabels('We need to fix this crash in production', testLabels)
    expect(enMatches.some(m => m.labelId === 'bug')).toBe(true)
    expect(enMatches.find(m => m.labelId === 'bug')?.value).toBe('')

    const frMatches = evaluateAutoLabels('Corrige cette erreur sur le serveur', testLabels)
    expect(frMatches.some(m => m.labelId === 'bug')).toBe(true)
  })

  test('automatically matches code topic', () => {
    const matches = evaluateAutoLabels('Refactor the user authentication api endpoint', testLabels)
    expect(matches.some(m => m.labelId === 'code')).toBe(true)
  })

  test('automatically matches design topic', () => {
    const matches = evaluateAutoLabels('Update the Tailwind CSS theme and layout', testLabels)
    expect(matches.some(m => m.labelId === 'design')).toBe(true)
  })

  test('automatically matches automation topic', () => {
    const matches = evaluateAutoLabels('Set up GitHub Actions CI/CD pipeline with Docker', testLabels)
    expect(matches.some(m => m.labelId === 'automation')).toBe(true)
  })

  test('automatically matches research topic', () => {
    const matches = evaluateAutoLabels('Audit and benchmark performance', testLabels)
    expect(matches.some(m => m.labelId === 'research')).toBe(true)
  })

  test('matches hashtags for existing labels', () => {
    const matches = evaluateAutoLabels('Please review #auth changes', testLabels)
    expect(matches.some(m => m.labelId === 'auth')).toBe(true)
  })

  test('matches explicit autoRules with value normalization', () => {
    const matches = evaluateAutoLabels('This is a critical bug P1', testLabels)
    expect(matches.some(m => m.labelId === 'bug')).toBe(true)
    const priorityMatch = matches.find(m => m.labelId === 'priority')
    expect(priorityMatch).toBeDefined()
    expect(priorityMatch?.value).toBe('1')
  })

  test('does not match inside fenced code blocks', () => {
    const codeBlock = 'Here is the snippet:\n```\nconst bug = "error"\n```\nLooks good.'
    const matches = evaluateAutoLabels(codeBlock, testLabels)
    expect(matches.some(m => m.labelId === 'bug')).toBe(false)
  })
})
