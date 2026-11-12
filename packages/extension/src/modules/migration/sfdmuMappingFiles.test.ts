import { describe, it, expect } from 'vitest';
import { readFieldMappingRows, readValueMappingRows } from './sfdmuMappingFiles';

describe('readFieldMappingRows', () => {
  it('reads SFDMU’s columns, an empty field meaning the object goes to the target', () => {
    const rows = readFieldMappingRows(
      'ObjectName,FieldName,Target\nAccount,,TestObject__c\nAccount,ParentId,Parent__c\n',
      ',',
    );

    expect(rows).toEqual([
      { object: 'Account', field: '', target: 'TestObject__c' },
      { object: 'Account', field: 'ParentId', target: 'Parent__c' },
    ]);
  });

  it('reads a file with no FieldName column, as SFDMU asks only for the object and the target', () => {
    expect(readFieldMappingRows('ObjectName,Target\nAccount,TestObject__c\n', ',')).toEqual([
      { object: 'Account', field: '', target: 'TestObject__c' },
    ]);
  });

  it('skips the rows SFDMU skips, with no object or no target, and empty lines', () => {
    const rows = readFieldMappingRows(
      'ObjectName,FieldName,Target\n,Name,Title__c\nAccount,Name,\n\nCase,Subject,Title__c\n',
      ',',
    );

    expect(rows).toEqual([{ object: 'Case', field: 'Subject', target: 'Title__c' }]);
  });

  it('answers nothing for other columns: that is not the file', () => {
    expect(readFieldMappingRows('Object,Field\nAccount,Name\n', ',')).toBeUndefined();
    expect(readFieldMappingRows('', ',')).toBeUndefined();
  });

  it('takes columns in any order, with a byte order mark, CRLF and spaces around a cell', () => {
    const rows = readFieldMappingRows(
      '\uFEFFTarget,ObjectName,FieldName\r\n Title__c , Account , Name \r\n',
      ',',
    );

    expect(rows).toEqual([{ object: 'Account', field: 'Name', target: 'Title__c' }]);
  });

  it('reads another delimiter', () => {
    expect(readFieldMappingRows('ObjectName;Target\nAccount;Lead\n', ';')).toEqual([
      { object: 'Account', field: '', target: 'Lead' },
    ]);
  });
});

describe('readValueMappingRows', () => {
  it('reads SFDMU’s columns, past the ones it does not read', () => {
    const rows = readValueMappingRows(
      'ObjectName,FieldName,RawValue,Value,Reason\nCase,Status,New,Open,kept\n',
      ',',
    );

    expect(rows).toEqual([{ object: 'Case', field: 'Status', rawValue: 'New', value: 'Open' }]);
  });

  it('reads quoted cells: a delimiter, a doubled quote and a line break inside one', () => {
    const rows = readValueMappingRows(
      'ObjectName,FieldName,RawValue,Value\nCase,Subject,"a,b","say ""hi"""\nCase,Subject,"two\nlines",x\n',
      ',',
    );

    expect(rows).toEqual([
      { object: 'Case', field: 'Subject', rawValue: 'a,b', value: 'say "hi"' },
      { object: 'Case', field: 'Subject', rawValue: 'two\nlines', value: 'x' },
    ]);
  });

  it('keeps an empty raw value, which SFDMU maps, and skips a row with no field', () => {
    const rows = readValueMappingRows(
      'ObjectName,FieldName,RawValue,Value\nCase,Status,,Open\nCase,,x,y\n',
      ',',
    );

    expect(rows).toEqual([{ object: 'Case', field: 'Status', rawValue: '', value: 'Open' }]);
  });

  it('reads a last line with no line end', () => {
    expect(readValueMappingRows('ObjectName,FieldName,RawValue,Value\nA,B,C,D', ',')).toEqual([
      { object: 'A', field: 'B', rawValue: 'C', value: 'D' },
    ]);
  });

  it('answers nothing for other columns: that is not the file', () => {
    expect(readValueMappingRows('ObjectName,FieldName,Target\n', ',')).toBeUndefined();
  });
});
