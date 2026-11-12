import { describe, it, expect } from 'vitest';
import type { RunCheckpointEstimate } from '@sandforge/shared';

import {
  ENGLISH_CHECKPOINT_WORDS,
  WRITE_QUESTION_BLOCKS,
  checkpointQuestionLines,
  inQuestionOrder,
  type CheckpointQuestionWords,
} from './ProductionGuard.js';

/** The checkpoint of the fixture clone's twelve objects on a scratch org, as the probes measured it. */
const CHECKPOINT: RunCheckpointEstimate = {
  state: 'planned',
  estimate: {
    records: 38,
    apiRequests: 68,
    apiRequestsLeft: 14_000,
    seconds: 44,
    bytes: 2_250_000,
  },
  objects: [
    'Account',
    'Contact',
    'Opportunity',
    'Case',
    'Asset',
    'Task',
    'ContentDocument',
    'Attachment',
    'Order',
    'OrderItem',
    'Product2',
    'PricebookEntry',
  ],
  added: [
    {
      objectApiName: 'Asset',
      reason: "The target's flow 'Case asset' creates Asset records as Case records go in.",
    },
  ],
  notHeld: [
    {
      objectApiName: 'FeedItem',
      reason: 'Chatter posts are not held. A rewind leaves its records as they are.',
    },
  ],
  keepDays: 7,
};

describe('the checkpoint’s block of a run’s question', () => {
  it('says what it costs, what it keeps where and for how long, what it adds and leaves out, and what no read can tell', () => {
    expect(checkpointQuestionLines(CHECKPOINT)).toEqual([
      'Checkpoint first: about 38 records of 12 objects, 68 API requests, 44 s, 2.2 MB on this ' +
        "machine, unencrypted, and none of the org's storage, kept 7 days.",
      "Added: Asset — The target's flow 'Case asset' creates Asset records as Case records go in.",
      'Not in the checkpoint: FeedItem — Chatter posts are not held. A rewind leaves its records ' +
        'as they are.',
      'What an Apex trigger, or automation that could not be read, creates as the run writes is ' +
        'not known: a rewind leaves those records as they are.',
    ]);
  });

  it('says one of each in the singular, a checkpoint kept until deleted, and never 0 MB of one that keeps something', () => {
    const [cost] = checkpointQuestionLines({
      ...CHECKPOINT,
      estimate: { ...CHECKPOINT.estimate, records: 1, apiRequests: 1, seconds: 0.2, bytes: 900 },
      objects: ['Account'],
      keepDays: 0,
    });
    expect(cost).toBe(
      'Checkpoint first: about 1 record of 1 object, 1 API request, 1 s, 0.1 MB on this ' +
        "machine, unencrypted, and none of the org's storage, kept until you delete it.",
    );
  });

  it('names ten objects of a list, and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      objectApiName: `Child${i}__c`,
      reason: `Made by flow ${i}.`,
    }));
    const lines = checkpointQuestionLines({ ...CHECKPOINT, added: many, notHeld: [] });
    expect(lines.filter((line) => line.startsWith('Added: '))).toHaveLength(10);
    expect(lines).toContain('… and 3 more');
  });

  it('is put in the words it is handed', () => {
    const words: CheckpointQuestionWords = {
      ...ENGLISH_CHECKPOINT_WORDS,
      cost: ({ records, objects, keepDays }) => `${records}/${objects}/${keepDays}`,
      added: (name) => `+${name}`,
      notHeld: (name) => `-${name}`,
      unknown: '?',
    };
    expect(checkpointQuestionLines(CHECKPOINT, words)).toEqual([
      '38/12/7',
      '+Asset',
      '-FeedItem',
      '?',
    ]);
  });
});

describe('the blocks of a run’s question', () => {
  it('puts what leaves the org first, then what still runs, then the checkpoint, then the limits, whatever order they were made in', () => {
    expect(WRITE_QUESTION_BLOCKS).toEqual(['leavesTheOrg', 'stillRunning', 'checkpoint', 'limits']);
    expect(
      inQuestionOrder({
        limits: ['storage', 'requests'],
        checkpoint: ['checkpoint'],
        leavesTheOrg: ['emails delivered'],
        stillRunning: ['flow X still runs'],
      }),
    ).toEqual(['emails delivered', 'flow X still runs', 'checkpoint', 'storage', 'requests']);
    expect(inQuestionOrder({ limits: ['storage'] })).toEqual(['storage']);
  });
});
