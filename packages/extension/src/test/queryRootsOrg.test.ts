import { describe, expect, it } from 'vitest';
import { energyOrg, fakeId, queryRootsGraph, QueryRootsOrg } from './queryRootsOrg.js';

describe('the org of a clone from records', () => {
  it('answers a statement as the sample’s source does, and counts each request', async () => {
    const org = energyOrg();
    const deps = org.deps();
    const rows = await deps.queryRecords(
      'src',
      "SELECT Id FROM Account WHERE (Industry = 'Energy') ORDER BY Id LIMIT 201",
    );
    expect(rows.map((row) => row['Id'])).toEqual([
      fakeId('Account', 'S', 1),
      fakeId('Account', 'S', 2),
    ]);
    expect(org.requests).toBe(1);
    expect(org.statementsOf('Account')).toHaveLength(1);
    expect(org.answered.get('Account')?.size).toBe(2);
  });

  it('refuses a column the describe does not list, as the org does', async () => {
    const org = energyOrg();
    await expect(
      org.deps().queryRecords('src', 'SELECT Id, Rating FROM Account'),
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD' });
  });

  it('refuses a statement past the URI the org holds', async () => {
    const org = new QueryRootsOrg();
    const ids = Array.from({ length: 900 }, (_, n) => `'${fakeId('Account', 'S', n)}'`);
    await expect(
      org.deps().queryRecords('src', `SELECT Id FROM Account WHERE Id IN (${ids.join(', ')})`),
    ).rejects.toMatchObject({ errorCode: 'ERROR_HTTP_431' });
  });

  it('creates what the target is sent, and the graph puts the root first', async () => {
    const org = energyOrg();
    const [answer] = await org.deps().insertRecords('tgt', 'Account', [{ Name: 'A' }]);
    expect(answer).toMatchObject({ success: true, id: fakeId('Account', 'T', 1) });
    expect(org.inserted.get('Account')).toEqual([{ Name: 'A' }]);
    const graph = queryRootsGraph(org, 'Contact', ['Account', 'Contact', 'Case']);
    expect(graph.nodes.map((node) => [node.objectApiName, node.level])).toEqual([
      ['Contact', 0],
      ['Account', 1],
      ['Case', 1],
    ]);
    expect(graph.edges.map((edge) => `${edge.sourceObject}>${edge.targetObject}`)).toEqual([
      'Account>Contact',
      'Account>Case',
      'Contact>Case',
    ]);
  });
});
