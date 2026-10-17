import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { holdsOnlyOnChange } from './validationRuleFormula.js';

/** The validation rules of the trap org's contacts, as the fixture deploys them. */
const TRAP_RULES = join(
  __dirname,
  '../../../../../test/fixtures/trap-org/target/main/default/objects/Contact/validationRules',
);

/** A rule's formula, as its metadata file holds it. */
function formulaOf(file: string): string {
  const xml = readFileSync(join(TRAP_RULES, file), 'utf8');
  const formula = /<errorConditionFormula>([\s\S]*?)<\/errorConditionFormula>/.exec(xml)?.[1];
  return (formula ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

describe('holdsOnlyOnChange — the trap org', () => {
  it('reads the contacts rule that refuses only a change as such, and the others as refusing an insert', () => {
    const read = Object.fromEntries(
      readdirSync(TRAP_RULES).map((file) => [
        file.replace('.validationRule-meta.xml', ''),
        holdsOnlyOnChange(formulaOf(file)),
      ]),
    );

    expect(read).toEqual({
      Trap_Email_Required: false,
      Trap_Lead_Source_Locked: true,
      Trap_Phone_Format: false,
    });
  });
});

describe('holdsOnlyOnChange — formulas that refuse an update only', () => {
  it.each([
    [
      'a change away from an approved status',
      'AND(\n  ISCHANGED(Status__c),\n  ISPICKVAL(PRIORVALUE(Status__c), "Approved")\n)',
    ],
    [
      'a change of an amount, past a permission',
      'AND(ISCHANGED(Amount__c), NOT($Permission.Edit_Locked_Invoices))',
    ],
    ['a NOT(ISNEW()) guard', 'AND(NOT(ISNEW()), ISBLANK(Reason__c))'],
    ['a !ISNEW() guard with &&', '!ISNEW() && ISBLANK(Reason__c)'],
    ['ISNEW() compared with false', 'AND(ISNEW() = FALSE, Amount__c > 1000)'],
    ['a change of any of three fields', 'OR(ISCHANGED(A__c), ISCHANGED(B__c), ISCHANGED(C__c))'],
    ['a prior value different from the value', 'PRIORVALUE(Amount__c) <> Amount__c'],
    ['a prior value greater than the value', 'Amount__c < PRIORVALUE(Amount__c)'],
    ['the prior text of a picklist compared', 'TEXT(PRIORVALUE(Stage__c)) != TEXT(Stage__c)'],
    [
      'a status that leaves Approved, by its prior value',
      'AND(ISPICKVAL(PRIORVALUE(Status__c), "Approved"), NOT(ISPICKVAL(Status__c, "Approved")))',
    ],
    ['an IF that refuses nothing on an insert', 'IF(ISNEW(), FALSE, ISCHANGED(OwnerId))'],
    [
      'a guard behind a comment, in any case',
      '/* locked once sent */ and(isChanged(sent_date__c), Not($User.Bypass__c))',
    ],
  ])('reads %s as holding only on a change', (_, formula) => {
    expect(holdsOnlyOnChange(formula)).toBe(true);
  });
});

describe('holdsOnlyOnChange — formulas that can refuse an insert', () => {
  it.each([
    [
      'a required email past a permission',
      'AND(\n    NOT($Permission.Trap_Bypass_VR),\n    ISBLANK(Email)\n)',
    ],
    [
      'a phone format',
      'AND(\n    NOT(ISBLANK(Phone)),\n    NOT(REGEX(Phone, "\\\\+33 [1-9]( [0-9]{2}){4}"))\n)',
    ],
    // On an insert, PRIORVALUE gives the value itself: a record inserted
    // approved is refused.
    ['a prior value alone', 'AND(ISPICKVAL(PRIORVALUE(Status__c), "Approved"), Amount__c > 0)'],
    ['a change or a blank field', 'OR(ISCHANGED(Status__c), ISBLANK(Reason__c))'],
    ['ISNEW() itself', 'AND(ISNEW(), ISBLANK(Reason__c))'],
    ['an IF whose branches differ', 'IF(ISBLANK(Reason__c), ISCHANGED(Status__c), Amount__c > 5)'],
    ['a value compared with itself for equality', 'Amount__c = PRIORVALUE(Amount__c)'],
    ['a CASE the reading does not evaluate', 'CASE(Status__c, "A", ISCHANGED(X__c), TRUE)'],
  ])('keeps %s', (_, formula) => {
    expect(holdsOnlyOnChange(formula)).toBe(false);
  });

  it.each([
    ['an unclosed parenthesis', 'AND(ISCHANGED(Status__c)'],
    ['an unclosed text', 'AND(ISCHANGED(Status__c), Name = "x)'],
    ['an unclosed comment', 'ISCHANGED(Status__c) /* note'],
    ['a merge field of a flow', '{!$Record.Status} <> "A"'],
    ['nothing', ''],
  ])('keeps a formula it cannot read: %s', (_, formula) => {
    expect(holdsOnlyOnChange(formula)).toBe(false);
  });
});
