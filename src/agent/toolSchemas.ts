import type Anthropic from '@anthropic-ai/sdk';

/**
 * What the model sees. These descriptions are load-bearing — they are the only
 * instructions the model gets about when each tool applies, so they read as
 * guidance ("call this before...") rather than as bare parameter docs.
 *
 * `strict: true` plus `additionalProperties: false` guarantees the arguments
 * validate exactly, so the executor can trust the shape without re-parsing.
 */
export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'lookup_order',
    description:
      'Look up an order by its id. Returns status, amount, age in days, and the ' +
      'customer it belongs to. Call this first when a ticket references an order, ' +
      'so later decisions are based on real data rather than the customer\'s claim.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'integer',
          description: 'The numeric id of the order to look up.',
        },
      },
      required: ['order_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_refund_policy',
    description:
      'Check whether an order is eligible for a refund under company policy. ' +
      'Returns an eligibility verdict, the reasons behind it, and the maximum ' +
      'refundable amount. Always call this before issuing a refund — do not ' +
      'judge eligibility yourself.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'integer',
          description: 'The numeric id of the order to evaluate.',
        },
      },
      required: ['order_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'issue_refund',
    description:
      'Issue a refund against an order. This moves real money and cannot be ' +
      'silently undone. Only call it after check_refund_policy returned ' +
      'eligible=true, and never for an amount above max_refundable_amount.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'integer',
          description: 'The numeric id of the order to refund.',
        },
        amount: {
          type: 'number',
          description:
            'Amount to refund. Must be positive and no greater than the order total.',
        },
        reason: {
          type: 'string',
          description:
            'Short customer-facing justification, e.g. "item arrived damaged". ' +
            'Stored in the audit log.',
        },
      },
      required: ['order_id', 'amount', 'reason'],
      additionalProperties: false,
    },
  },
];

/** Tools whose execution moves money. Week 3 routes these through the approval gate. */
export const MONEY_MOVING_TOOLS = new Set(['issue_refund']);
