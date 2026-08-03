import { describe, expect, it } from 'vitest';
import { RuleProposer, type FieldPatternInput } from './RuleProposer.js';

const proposer = new RuleProposer();

function field(name: string, type: string, objectApiName = 'Contact'): FieldPatternInput {
  return { objectApiName, name, type };
}

describe('RuleProposer — name/type patterns', () => {
  it('maps PII-ish fields to the right generators', () => {
    expect(proposer.proposeField(field('Email', 'string')).generator).toBe('email');
    expect(proposer.proposeField(field('MobilePhone__c', 'string')).generator).toBe('phoneE164');
    expect(proposer.proposeField(field('FirstName', 'string')).generator).toBe('firstName');
    expect(proposer.proposeField(field('LastName', 'string')).generator).toBe('lastName');
    expect(proposer.proposeField(field('Prenom__c', 'string')).generator).toBe('firstName');
    expect(proposer.proposeField(field('Employeur__c', 'string')).generator).toBe('companyName');
    expect(proposer.proposeField(field('Immatriculation__c', 'string')).generator).toBe(
      'registrationSIV',
    );
    expect(proposer.proposeField(field('NumeroContrat__c', 'string')).generator).toBe(
      'contractNumber',
    );
    expect(proposer.proposeField(field('CodePostal__c', 'string')).generator).toBe(
      'postalCodeGeneralize',
    );
    expect(proposer.proposeField(field('DateNaissance__c', 'date')).generator).toBe(
      'dateMonthStart',
    );
    expect(proposer.proposeField(field('Latitude__c', 'number')).generator).toBe('geoRound1');
    expect(proposer.proposeField(field('Kilometrage__c', 'number')).generator).toBe('kmRound10');
  });

  it('falls back on Salesforce types (email/phone/date/datetime/location)', () => {
    expect(proposer.proposeField(field('Coordonnees__c', 'email')).generator).toBe('email');
    expect(proposer.proposeField(field('Ligne__c', 'phone')).generator).toBe('phoneE164');
    expect(proposer.proposeField(field('Echeance__c', 'date')).generator).toBe('dateShift');
    expect(proposer.proposeField(field('CreeLe__c', 'datetime')).generator).toBe('dateShift');
  });

  it('defaults to clear when nothing matches — never clear-text', () => {
    const proposal = proposer.proposeField(field('NotesInternes__c', 'textarea'));
    expect(proposal.generator).toBe('clear');
    expect(proposal.reviewKeep).toBe(false);
  });

  it('never emits keep: keep-candidates are clear + reviewKeep (human gate)', () => {
    const proposal = proposer.proposeField(field('Statut__c', 'picklist'));
    expect(proposal.generator).not.toBe('keep');
    expect(proposal.generator).toBe('clear');
    expect(proposal.reviewKeep).toBe(true);
    // Sanity across the whole pattern surface:
    for (const f of [
      field('Email', 'string'),
      field('Statut__c', 'picklist'),
      field('X__c', 'boolean'),
      field('Unknown__c', 'string'),
    ]) {
      expect(proposer.proposeField(f).generator).not.toBe('keep');
    }
  });

  it('proposes in bulk with Object.Field keys', () => {
    const proposals = proposer.propose([field('Email', 'string'), field('FirstName', 'string')]);
    expect(proposals.map((p) => p.key)).toEqual(['Contact.Email', 'Contact.FirstName']);
  });
});
