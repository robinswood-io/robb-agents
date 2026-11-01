
// 2MB total across all attachments

// ============================================================================
// PREDEFINED OUTPUT FORMATS
// These provide structured output schemas for common use cases
// ============================================================================

export const OUTPUT_FORMATS = {
  summary: {
    type: 'object' as const,
    properties: {
      summary: { type: 'string', description: 'Concise summary' },
      key_points: { type: 'array', items: { type: 'string' }, description: 'Main points' },
      word_count: { type: 'number', description: 'Approximate word count of source' },
    },
    required: ['summary', 'key_points'],
  },
  classification: {
    type: 'object' as const,
    properties: {
      category: { type: 'string', description: 'Primary category' },
      confidence: { type: 'number', description: 'Confidence 0-1' },
      reasoning: { type: 'string', description: 'Why this classification' },
    },
    required: ['category', 'confidence', 'reasoning'],
  },
  extraction: {
    type: 'object' as const,
    properties: {
      items: { type: 'array', items: { type: 'object' }, description: 'Extracted items' },
      count: { type: 'number', description: 'Number of items found' },
    },
    required: ['items', 'count'],
  },
  analysis: {
    type: 'object' as const,
    properties: {
      findings: { type: 'array', items: { type: 'string' }, description: 'Key findings' },
      issues: { type: 'array', items: { type: 'string' }, description: 'Problems found' },
      recommendations: { type: 'array', items: { type: 'string' }, description: 'Suggested actions' },
    },
    required: ['findings'],
  },
  comparison: {
    type: 'object' as const,
    properties: {
      similarities: { type: 'array', items: { type: 'string' } },
      differences: { type: 'array', items: { type: 'string' } },
      verdict: { type: 'string', description: 'Overall comparison result' },
    },
    required: ['similarities', 'differences', 'verdict'],
  },
  validation: {
    type: 'object' as const,
    properties: {
      valid: { type: 'boolean', description: 'Whether input is valid' },
      errors: { type: 'array', items: { type: 'string' }, description: 'Validation errors' },
      warnings: { type: 'array', items: { type: 'string' }, description: 'Warnings' },
    },
    required: ['valid', 'errors', 'warnings'],
  },
};
