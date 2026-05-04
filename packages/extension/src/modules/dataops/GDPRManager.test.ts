import { describe, it, expect, vi } from 'vitest';
import { GDPRManager } from './GDPRManager';
import type { GDPRConnection, DSRType } from './GDPRManager';

function makeConn(overrides: Partial<GDPRConnection> = {}): GDPRConnection {
  return {
    queryRecordsByEmail: vi.fn().mockResolvedValue([]),
    queryRecordCount: vi.fn().mockResolvedValue(0),
    describeFields: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('GDPRManager', () => {
  const manager = new GDPRManager();

  it('should create a DSR with correct defaults and hashed PII', () => {
    const dsr = manager.createDSR('erasure', 'john@example.com', 'John Doe');
    expect(dsr.type).toBe('erasure');
    expect(dsr.subjectEmail).toBe(manager.hashPII('john@example.com'));
    expect(dsr.subjectName).toBe(manager.hashPII('John Doe'));
    // PII must not be stored in clear text
    expect(dsr.subjectEmail).not.toBe('john@example.com');
    expect(dsr.subjectName).not.toBe('John Doe');
    expect(dsr.status).toBe('pending');
    expect(dsr.recordsFound).toBe(0);
    expect(dsr.recordsProcessed).toBe(0);
  });

  it('should set due date to 30 days from now', () => {
    const dsr = manager.createDSR('access', 'a@b.com', 'A');
    const requestDate = new Date(dsr.requestDate);
    const dueDate = new Date(dsr.dueDate);
    const diffDays = Math.round(
      (dueDate.getTime() - requestDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    expect(diffDays).toBe(30);
  });

  it('should list all DSRs', () => {
    const m = new GDPRManager();
    m.createDSR('erasure', 'a@b.com', 'A');
    m.createDSR('access', 'c@d.com', 'C');
    expect(m.listDSRs()).toHaveLength(2);
  });

  it('should get a specific DSR by ID', () => {
    const m = new GDPRManager();
    const dsr = m.createDSR('portability', 'x@y.com', 'X');
    expect(m.getDSR(dsr.id)).toBeDefined();
    expect(m.getDSR('nonexistent')).toBeUndefined();
  });

  it('should update DSR status', () => {
    const m = new GDPRManager();
    const dsr = m.createDSR('erasure', 'a@b.com', 'A');
    expect(m.updateDSR(dsr.id, { status: 'in_progress' })).toBe(true);
    expect(m.getDSR(dsr.id)?.status).toBe('in_progress');
  });

  it('should set completedDate when marking as completed', () => {
    const m = new GDPRManager();
    const dsr = m.createDSR('erasure', 'a@b.com', 'A');
    m.updateDSR(dsr.id, { status: 'completed' });
    expect(m.getDSR(dsr.id)?.completedDate).toBeDefined();
  });

  it('should return false when updating non-existent DSR', () => {
    const m = new GDPRManager();
    expect(m.updateDSR('fake-id', { status: 'completed' })).toBe(false);
  });

  it('should detect PII category for email fields', () => {
    expect(manager.detectPIICategory('Email', 'Email')).toBe('email');
    expect(manager.detectPIICategory('PersonalEmail__c', 'Personal Email')).toBe('email');
  });

  it('should detect PII category for phone fields', () => {
    expect(manager.detectPIICategory('Phone', 'Phone')).toBe('phone');
    expect(manager.detectPIICategory('MobilePhone', 'Mobile')).toBe('phone');
  });

  it('should detect PII category for name fields', () => {
    expect(manager.detectPIICategory('FirstName', 'First Name')).toBe('name');
    expect(manager.detectPIICategory('LastName', 'Last Name')).toBe('name');
  });

  it('should detect PII category for address fields', () => {
    expect(manager.detectPIICategory('MailingAddress', 'Mailing Address')).toBe('address');
    expect(manager.detectPIICategory('MailingStreet', 'Street')).toBe('address');
  });

  it('should return null for non-PII fields', () => {
    expect(manager.detectPIICategory('Industry', 'Industry')).toBeNull();
    expect(manager.detectPIICategory('StageName', 'Stage')).toBeNull();
  });

  it('should scan for PII fields', async () => {
    const conn = makeConn({
      describeFields: vi.fn().mockResolvedValue([
        { apiName: 'Email', label: 'Email', type: 'String' },
        { apiName: 'Name', label: 'Name', type: 'String' },
        { apiName: 'Industry', label: 'Industry', type: 'Picklist' },
      ]),
      queryRecordCount: vi.fn().mockResolvedValue(500),
    });

    const results = await manager.scanForPII(conn, 'org-1', ['Contact']);
    expect(results.length).toBeGreaterThan(0);
    const emailResult = results.find((r) => r.fieldApiName === 'Email');
    expect(emailResult).toBeDefined();
    expect(emailResult?.piiCategory).toBe('email');
    expect(emailResult?.recordCount).toBe(500);
  });

  it('should handle scan errors gracefully', async () => {
    const conn = makeConn({
      describeFields: vi.fn().mockRejectedValue(new Error('No access')),
    });

    const results = await manager.scanForPII(conn, 'org-1', ['Contact']);
    expect(results).toHaveLength(0);
  });

  it('should build erasure plan for a DSR', async () => {
    const m = new GDPRManager();
    const dsr = m.createDSR('erasure', 'john@example.com', 'John Doe');

    const conn = makeConn({
      describeFields: vi.fn().mockResolvedValue([
        { apiName: 'Email', label: 'Email', type: 'String' },
        { apiName: 'FirstName', label: 'First Name', type: 'String' },
        { apiName: 'LastName', label: 'Last Name', type: 'String' },
      ]),
      queryRecordsByEmail: vi
        .fn()
        .mockResolvedValue([{ Id: '003xx0001', Email: 'john@example.com', FirstName: 'John' }]),
    });

    const plan = await m.buildErasurePlan(conn, 'org-1', dsr);
    expect(plan.dsrId).toBe(dsr.id);
    expect(plan.totalRecords).toBeGreaterThan(0);
    expect(plan.objects.length).toBeGreaterThan(0);
  });

  it('should anonymize core objects and delete others in erasure plan', async () => {
    const m = new GDPRManager();
    const dsr = m.createDSR('erasure', 'john@example.com', 'John');

    const conn = makeConn({
      describeFields: vi.fn().mockResolvedValue([
        { apiName: 'Email', label: 'Email', type: 'String' },
        { apiName: 'FirstName', label: 'First Name', type: 'String' },
      ]),
      queryRecordsByEmail: vi.fn().mockResolvedValue([{ Id: '001xx', Email: 'john@example.com' }]),
    });

    const plan = await m.buildErasurePlan(conn, 'org-1', dsr);
    const contactObj = plan.objects.find((o) => o.objectApiName === 'Contact');
    const accountObj = plan.objects.find((o) => o.objectApiName === 'Account');

    // Contact is not a core object → delete
    if (contactObj) {
      expect(contactObj.action).toBe('delete');
    }
    // Account is a core object → anonymize
    if (accountObj) {
      expect(accountObj.action).toBe('anonymize');
    }
  });

  it('should detect overdue DSRs', () => {
    const m = new GDPRManager();
    const dsr = m.createDSR('erasure', 'a@b.com', 'A');
    // Manually set due date in the past
    m.updateDSR(dsr.id, { dueDate: '2020-01-01T00:00:00.000Z' });
    expect(m.getOverdueDSRs()).toHaveLength(1);
  });

  it('should not count completed DSRs as overdue', () => {
    const m = new GDPRManager();
    const dsr = m.createDSR('erasure', 'a@b.com', 'A');
    m.updateDSR(dsr.id, { dueDate: '2020-01-01T00:00:00.000Z', status: 'completed' });
    expect(m.getOverdueDSRs()).toHaveLength(0);
  });

  it('should compute compliance summary', () => {
    const m = new GDPRManager();
    m.createDSR('erasure', 'a@b.com', 'A');
    m.createDSR('access', 'c@d.com', 'C');
    const dsr3 = m.createDSR('portability', 'e@f.com', 'E');
    m.updateDSR(dsr3.id, { status: 'completed' });

    const summary = m.getComplianceSummary();
    expect(summary.total).toBe(3);
    expect(summary.pending).toBe(2);
    expect(summary.completed).toBe(1);
  });

  it('should support all DSR types', () => {
    const m = new GDPRManager();
    const types: DSRType[] = ['access', 'erasure', 'rectification', 'portability', 'restriction'];
    for (const type of types) {
      const dsr = m.createDSR(type, `${type}@test.com`, type);
      expect(dsr.type).toBe(type);
    }
    expect(m.listDSRs()).toHaveLength(5);
  });
});
