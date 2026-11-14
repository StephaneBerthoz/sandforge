import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import { ForgeSoqlNotices } from './ForgeSoqlNotices';

describe('ForgeSoqlNotices', () => {
  it('says which object a WHERE clause narrows, and that nothing else is', () => {
    render(
      <ForgeSoqlNotices
        query="SELECT Id FROM Account WHERE Industry = 'Energy'"
        objectNameRefused={false}
      />,
    );

    const warning = screen.getByTestId('forge-soql-where-warning');
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.textContent).toContain(
      i18n.t('forge.soqlUnscopedWarnTitle', { object: 'Account' }),
    );
    expect(screen.queryByTestId('forge-soql-filter-refused')).toBeNull();
  });

  it('names the filter of Review → Controls that narrows a related object, as a semi-join on the query’s object', () => {
    // It said only that related objects were read from their whole tables:
    // a clone of a few accounts read every contact, and nothing said what
    // narrows them.
    render(
      <ForgeSoqlNotices
        query="SELECT Id FROM Account WHERE Industry = 'Energy'"
        objectNameRefused={false}
      />,
    );

    const warning = screen.getByTestId('forge-soql-where-warning').textContent ?? '';
    expect(warning).toContain('Review → Controls');
    expect(warning).toContain('AccountId IN (SELECT Id FROM Account WHERE …)');
  });

  it('gives a custom object’s example lookup the object’s own name', () => {
    render(
      <ForgeSoqlNotices
        query="SELECT Id FROM Invoice__c WHERE Status__c = 'Open'"
        objectNameRefused={false}
      />,
    );

    expect(screen.getByTestId('forge-soql-where-warning').textContent).toContain(
      'Invoice__c IN (SELECT Id FROM Invoice__c WHERE …)',
    );
  });

  it('refuses a clause the extension would reject, and gives no warning beside it', () => {
    render(
      <ForgeSoqlNotices
        query="SELECT Id FROM Account WHERE Name = 'a' -- and the rest"
        objectNameRefused={false}
      />,
    );

    expect(screen.getByTestId('forge-soql-filter-refused').textContent).toBe(
      i18n.t('forge.soqlFilterRefused'),
    );
    expect(screen.queryByTestId('forge-soql-where-warning')).toBeNull();
  });

  it('names the object when its name is refused', () => {
    render(<ForgeSoqlNotices query="SELECT Id FROM 1Account WHERE Name = 'a'" objectNameRefused />);

    expect(screen.getByTestId('forge-soql-object-invalid').textContent).toBe(
      i18n.t('forge.soqlObjectNameInvalid', { object: '1Account' }),
    );
    expect(screen.queryByTestId('forge-soql-where-warning')).toBeNull();
  });

  it('says nothing about a query with no WHERE clause', () => {
    const { container } = render(
      <ForgeSoqlNotices query="SELECT Id FROM Account" objectNameRefused={false} />,
    );

    expect(container.textContent).toBe('');
  });
});
