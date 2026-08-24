export const REFLECT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    strategy_md: { type: 'string' },
    notes_md: { type: 'string' },
    model_id: { type: 'string' },
    temperature: { type: 'number' },
  },
  required: ['strategy_md', 'notes_md'],
  additionalProperties: false,
} as const
