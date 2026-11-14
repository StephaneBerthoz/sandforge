import { describe, expect, it } from 'vitest';

import {
  lateCountStatement,
  sliceConditions,
  sliceStatement,
  tailCountStatement,
} from './sliceStatement.js';

const START = '003000000001000AAA';
const END = '003000000002000AAA';

describe('sliceStatement', () => {
  it('reads the first slice from the first row, by Id, as many as a slice holds', () => {
    expect(sliceStatement('Contact', 'Id, Email', undefined, {}, 1000)).toBe(
      'SELECT Id, Email FROM Contact ORDER BY Id LIMIT 1000',
    );
  });

  it('reads a slice past the last row of the one before, under the run filter in parentheses', () => {
    expect(
      sliceStatement(
        'Contact',
        'Id, Email',
        "LastName LIKE 'S%' OR Email = null",
        { afterId: START },
        500,
      ),
    ).toBe(
      "SELECT Id, Email FROM Contact WHERE (LastName LIKE 'S%' OR Email = null) AND " +
        `Id > '${START}' ORDER BY Id LIMIT 500`,
    );
  });

  it('reads the late rows of a range: created since a moment, between its bounds', () => {
    expect(
      sliceStatement(
        'Contact',
        'Id',
        undefined,
        { afterId: START, untilId: END, createdSince: '2026-11-14T10:00:01.734Z' },
        1000,
      ),
    ).toBe(
      'SELECT Id FROM Contact WHERE CreatedDate >= 2026-11-14T10:00:01Z AND ' +
        `Id > '${START}' AND Id <= '${END}' ORDER BY Id LIMIT 1000`,
    );
  });

  it('counts the rows created since in every range masked, and in one slice', () => {
    expect(
      lateCountStatement('Contact', undefined, '2026-11-14T10:00:00.000Z', { untilId: END }),
    ).toBe(
      `SELECT COUNT() FROM Contact WHERE CreatedDate >= 2026-11-14T10:00:00Z AND Id <= '${END}'`,
    );
    expect(
      lateCountStatement('Contact', "LastName LIKE 'S%'", '2026-11-14T10:00:00.000Z', {
        afterId: START,
        untilId: END,
      }),
    ).toBe(
      "SELECT COUNT() FROM Contact WHERE (LastName LIKE 'S%') AND CreatedDate >= " +
        `2026-11-14T10:00:00Z AND Id > '${START}' AND Id <= '${END}'`,
    );
  });

  it('counts the rows past the last slice', () => {
    expect(tailCountStatement('Contact', undefined, END)).toBe(
      `SELECT COUNT() FROM Contact WHERE Id > '${END}'`,
    );
  });

  it('refuses a bound that is not an id, a filter that does more than filter, and a size that is none', () => {
    expect(() => sliceConditions(undefined, { afterId: "x' OR Id != '" })).toThrow(
      'Not a record id',
    );
    expect(() => sliceConditions('Name = null LIMIT 1', {})).toThrow('Invalid SOQL WHERE clause');
    expect(() => sliceStatement('Contact', 'Id', undefined, {}, 0)).toThrow('Not a slice size');
    expect(() => sliceStatement('Contact; DELETE', 'Id', undefined, {}, 10)).toThrow();
    expect(() => sliceConditions(undefined, { createdSince: 'yesterday' })).toThrow('Not a date');
  });
});
