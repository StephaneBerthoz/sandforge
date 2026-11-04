import { describe, it, expect } from 'vitest';
import { readSfdmuQuery, selectedFieldsOf } from './sfdmuQuery';

describe('readSfdmuQuery', () => {
  describe('the object', () => {
    it.each([
      ['a plain query', 'SELECT Id, Name FROM Account', 'Account'],
      ['a custom object', 'SELECT Id FROM ns__Thing__c', 'ns__Thing__c'],
      ['lower case', 'select id from Account', 'Account'],
      ['mixed case', 'SeLeCt Id FrOm Account', 'Account'],
      ['line breaks', 'SELECT\n  Id,\n  Name\nFROM\n  Account\n', 'Account'],
      ['tabs and carriage returns', 'SELECT Id\r\n\tFROM\tAccount\r\n', 'Account'],
      ['an alias', 'SELECT a.Name FROM Account a', 'Account'],
      ['an alias after AS', 'SELECT a.Name FROM Account AS a', 'Account'],
      ['a subquery', 'SELECT Id, (SELECT Id FROM Contacts) FROM Account', 'Account'],
      ['a nested subquery', 'SELECT (SELECT (SELECT Id FROM C) FROM B) FROM Account', 'Account'],
      ['FROM in a literal', "SELECT Id FROM Account WHERE Name = 'x FROM Lead'", 'Account'],
      ['a literal before the FROM', "SELECT 'x FROM Lead', Id FROM Account", 'Account'],
      ['an escaped quote', "SELECT 'it\\'s FROM Lead', Id FROM Account", 'Account'],
      ['a field that ends in From', 'SELECT Valid_From__c FROM Account', 'Account'],
      ['a path that ends in From', 'SELECT Owner.From FROM Account', 'Account'],
      ['a polymorphic field', 'SELECT Id, WhatId$Case FROM Task', 'Task'],
      ['a TYPEOF', 'SELECT TYPEOF What WHEN Case THEN Id END FROM Task', 'Task'],
      ['SFDMU’s multiselect', 'SELECT all FROM Account', 'Account'],
      ['a function', 'SELECT toLabel(Status), FORMAT(Amount) FROM Case', 'Case'],
    ])('reads it through %s', (_label, query, object) => {
      expect(readSfdmuQuery(query).object).toBe(object);
    });

    it.each([
      ['no FROM', 'SELECT Id'],
      ['nothing after FROM', 'SELECT Id FROM'],
      ['an empty text', ''],
      ['a FROM only in a subquery', 'SELECT (SELECT Id FROM Contacts)'],
      ['a FROM only in a literal', "SELECT 'FROM Lead'"],
      ['no API name after FROM', 'SELECT Id FROM 123'],
    ])('reads none from %s', (_label, query) => {
      expect(readSfdmuQuery(query).object).toBeUndefined();
    });
  });

  describe('the filter', () => {
    it('reads it up to the next clause', () => {
      expect(readSfdmuQuery("SELECT Id FROM Account WHERE Name = 'x' ORDER BY Name").where).toBe(
        "Name = 'x'",
      );
    });

    it('puts it on one line, a literal as written', () => {
      const read = readSfdmuQuery(`SELECT Id
        FROM Account
        WHERE Name = 'two
        lines'
          AND Phone != null`);

      expect(read.where).toBe("Name = 'two\n        lines' AND Phone != null");
    });

    it('takes the alias off the fields, for Sync’s read declares none', () => {
      const read = readSfdmuQuery(
        "SELECT a.Id FROM Account a WHERE a.Name = 'a.b' AND (A.Phone != null) ORDER BY a.Name",
      );

      expect(read.where).toBe("Name = 'a.b' AND (Phone != null)");
      expect(read.orderBy).toBe('Name');
    });

    it('leaves a path that only ends in the alias', () => {
      expect(readSfdmuQuery('SELECT Id FROM Account a WHERE Data.a.Name = 1').where).toBe(
        'Data.a.Name = 1',
      );
    });

    it('keeps a subquery in the filter whole', () => {
      expect(
        readSfdmuQuery('SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)').where,
      ).toBe('Id IN (SELECT AccountId FROM Contact)');
    });

    it('does not take a field for a clause', () => {
      expect(readSfdmuQuery('SELECT Id FROM Account WHERE Limit__c = 1 AND For__c = 2').where).toBe(
        'Limit__c = 1 AND For__c = 2',
      );
    });

    it('has none where the query has none', () => {
      expect(readSfdmuQuery('SELECT Id FROM Account').where).toBeUndefined();
    });
  });

  describe('the order and the cap', () => {
    it('reads both, whatever their case', () => {
      const read = readSfdmuQuery('select Id from Account order  by Name DESC NULLS LAST limit 10');

      expect(read.orderBy).toBe('Name DESC NULLS LAST');
      expect(read.limit).toBe(10);
      expect(read.otherClauses).toEqual([]);
    });
  });

  describe('the rest of the statement', () => {
    it.each([
      ['OFFSET', 'SELECT Id FROM Account OFFSET 5', 'OFFSET 5'],
      ['ALL ROWS', 'SELECT Id FROM Account ALL ROWS', 'ALL ROWS'],
      ['FOR VIEW', 'SELECT Id FROM Account FOR VIEW', 'FOR VIEW'],
      ['USING SCOPE', 'SELECT Id FROM Account USING SCOPE mine', 'USING SCOPE mine'],
      ['WITH', 'SELECT Id FROM Account WITH SECURITY_ENFORCED', 'WITH SECURITY_ENFORCED'],
      ['GROUP BY', 'SELECT Name FROM Account GROUP BY Name', 'GROUP BY Name'],
      ['UPDATE TRACKING', 'SELECT Id FROM Account UPDATE TRACKING', 'UPDATE TRACKING'],
      ['a LIMIT that is no number', 'SELECT Id FROM Account LIMIT :cap', 'LIMIT :cap'],
      ['a second object', 'SELECT Id FROM Contact c, c.Account a', ', c.Account a'],
    ])('keeps %s as written, to be named', (_label, query, clause) => {
      expect(readSfdmuQuery(query).otherClauses).toEqual([clause]);
    });
  });
});

describe('selectedFieldsOf', () => {
  it.each([
    ['a list', 'SELECT Id, Name, Industry FROM Account', ['Id', 'Name', 'Industry']],
    [
      'no Id',
      'SELECT FirstName, LastName, AccountId FROM Contact',
      ['FirstName', 'LastName', 'AccountId'],
    ],
    ['lower case and line breaks', 'select id,\n  name\nfrom account', ['id', 'name']],
    ['a field twice, in two cases', 'SELECT Name, NAME, Phone FROM Account', ['Name', 'Phone']],
    ['the object’s alias', 'SELECT a.Name, a.Phone FROM Account a', ['Name', 'Phone']],
    ['the alias after AS', 'SELECT a.Name FROM Account AS a WHERE a.Name != null', ['Name']],
    ['a field through toLabel', 'SELECT Name, toLabel(Rating) FROM Account', ['Name', 'Rating']],
    [
      'a field through convertCurrency',
      'SELECT convertCurrency(Amount) FROM Opportunity',
      ['Amount'],
    ],
    [
      'a subquery, left out',
      'SELECT Name, (SELECT Id, Email FROM Contacts) FROM Account',
      ['Name'],
    ],
    ['a parent’s field, left out', 'SELECT Name, Owner.Name FROM Account', ['Name']],
    [
      'a literal with a comma',
      "SELECT Name, Phone FROM Account WHERE Name = 'a, b'",
      ['Name', 'Phone'],
    ],
  ])('names the fields of %s', (_label, query, fields) => {
    expect(selectedFieldsOf(query)).toEqual({ list: fields });
  });

  it.each([
    ['Id alone', 'SELECT Id FROM Account', 'Id'],
    ['id alone, in lower case', 'select id from Account', 'id'],
    ['SFDMU’s all', 'SELECT all FROM Account', 'all'],
    ['all beside fields', 'SELECT Id, Name, ALL FROM Account', 'ALL'],
    ['custom_true', 'SELECT Id, Name, custom_true FROM Account', 'custom_true'],
    ['lookup_false', 'SELECT Name, lookup_false FROM Account', 'lookup_false'],
    ['a type keyword', 'SELECT Id, type_string FROM Account', 'type_string'],
    ['FIELDS(ALL)', 'SELECT FIELDS(ALL) FROM Account', 'FIELDS(ALL)'],
    [
      'FIELDS(CUSTOM) beside a field',
      'SELECT Name, FIELDS( CUSTOM ) FROM Account',
      'FIELDS( CUSTOM )',
    ],
    ['a parent’s field alone', 'SELECT Owner.Name FROM Account', 'Owner.Name'],
    ['no FROM', 'SELECT Id, Name', 'SELECT Id, Name'],
  ])('names no list for %s, and says what it selects', (_label, query, named) => {
    expect(selectedFieldsOf(query)).toEqual({ every: named });
  });
});
