/**
 * JSON Schemas for OpenCode's `format: {type:'json_schema'}` output mode.
 * Hand-written rather than generated from the zod schemas: only three are needed,
 * and a converter dependency would buy nothing. Zod still validates the result.
 */
export const RANKING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          rank: { type: 'integer' },
          score: { type: 'number' },
          rationale: { type: 'string' },
        },
        required: ['ref', 'rank', 'score', 'rationale'],
        additionalProperties: false,
      },
    },
    meta_digest: { type: 'string' },
  },
  required: ['rankings', 'meta_digest'],
  additionalProperties: false,
} as const

export const CRITERIA_JSON_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          weight: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['name', 'weight'],
        additionalProperties: false,
      },
    },
  },
  required: ['criteria'],
  additionalProperties: false,
} as const
