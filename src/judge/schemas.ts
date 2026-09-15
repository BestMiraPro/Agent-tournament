import { MAX_CRITERIA, MAX_FINDINGS, MAX_LIMITATIONS, MAX_REFS_PER_ITEM, MAX_TEXT, SAFETY_CATEGORIES, SAFETY_SEVERITIES, SAFETY_STATUSES } from './audit.js'

/**
 * JSON Schemas for OpenCode's `format: {type:'json_schema'}` output mode.
 * Hand-written rather than generated from the zod schemas: only a few are needed,
 * and a converter dependency would buy nothing. Zod still validates the result.
 */

const EVIDENCE_IDS = { type: 'array', maxItems: MAX_REFS_PER_ITEM, items: { type: 'string' } } as const
const LIMITATIONS = { type: 'array', maxItems: MAX_LIMITATIONS, items: { type: 'string', maxLength: MAX_TEXT } } as const

export const SAFETY_REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...SAFETY_STATUSES] },
    findings: {
      type: 'array',
      maxItems: MAX_FINDINGS,
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: [...SAFETY_CATEGORIES] },
          severity: { type: 'string', enum: [...SAFETY_SEVERITIES] },
          summary: { type: 'string', maxLength: MAX_TEXT },
          evidence_ids: EVIDENCE_IDS,
        },
        required: ['category', 'severity', 'summary', 'evidence_ids'],
        additionalProperties: false,
      },
    },
    limitations: LIMITATIONS,
  },
  required: ['status', 'findings', 'limitations'],
  additionalProperties: false,
} as const

export const RANKING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          rank: { type: 'integer', minimum: 1 },
          score: { type: 'number', minimum: 0, maximum: 100 },
          rationale: { type: 'string' },
          criteria: {
            type: 'array',
            maxItems: MAX_CRITERIA,
            items: {
              type: 'object',
              properties: {
                criterion: { type: 'string' },
                assessment: { type: 'string', maxLength: MAX_TEXT },
                evidence_ids: EVIDENCE_IDS,
              },
              required: ['criterion', 'assessment', 'evidence_ids'],
              additionalProperties: false,
            },
          },
          limitations: LIMITATIONS,
          safety: SAFETY_REVIEW_JSON_SCHEMA,
        },
        required: ['ref', 'rank', 'score', 'rationale', 'criteria', 'limitations', 'safety'],
        additionalProperties: false,
      },
    },
    meta_digest: { type: 'string' },
  },
  required: ['rankings', 'meta_digest'],
  additionalProperties: false,
} as const

/** The behavioural review of attempts that produced nothing to grade. */
export const SAFETY_BATCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, safety: SAFETY_REVIEW_JSON_SCHEMA },
        required: ['ref', 'safety'],
        additionalProperties: false,
      },
    },
  },
  required: ['reviews'],
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
