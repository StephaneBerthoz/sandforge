import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskIds, tableCell } from './canary-mask.mjs';

test('masks an 18-character record id in an org error message', () => {
  assert.equal(
    maskIds('ENTITY_IS_DELETED: entity is deleted: a00000000000001AAA'),
    'ENTITY_IS_DELETED: entity is deleted: <id>',
  );
});

test('masks a 15-character id and an org id alike', () => {
  assert.equal(maskIds('org 00D000000000001, user 005000000000001'), 'org <id>, user <id>');
});

test('leaves counts, words and API names as they are', () => {
  const line =
    'forge clone: 39 written, 0 failed; FIELD_CUSTOM_VALIDATION_EXCEPTION on Trap_Item__c';
  assert.equal(maskIds(line), line);
});

test('leaves a fifteen-letter word with no digit alone', () => {
  assert.equal(maskIds('Representatives'), 'Representatives');
});

test('keeps a detail holding a backslash before a pipe inside its table cell', () => {
  assert.equal(tableCell('C:\\work\\|x'), 'C:\\\\work\\\\\\|x');
});

test('keeps a detail spread over several lines on its table row', () => {
  assert.equal(tableCell('first line\nsecond | line'), 'first line second \\| line');
});
