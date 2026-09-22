import { describe, it, expect, vi } from 'vitest';
import type { Connection } from 'jsforce';
import { createContentReader, canonicalMetadata, normalizeLineEndings } from './ContentReader';

interface ApexRow {
  NamespacePrefix: string | null;
  Name: string;
  Body: string;
}

/** A connection that answers the Apex query with `rows` and readMetadata with `records`. */
function connection(rows: ApexRow[] = [], records: unknown[] = []) {
  const query = vi.fn((soql: string) => {
    const asked = [...(/Name IN \((.*)\)/.exec(soql)?.[1] ?? '').matchAll(/'([^']*)'/g)].map(
      (m) => m[1],
    );
    return Promise.resolve({
      records: rows.filter((row) => asked.includes(row.Name)),
      done: true,
      totalSize: rows.length,
    });
  });
  const read = vi.fn((_type: string, _names: string[]) => Promise.resolve(records));
  const conn = { query, metadata: { read }, limitInfo: undefined } as unknown as Connection;
  return { conn, query, read };
}

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/**
 * A zip archive holding `files`, stored uncompressed, each packed at `time`:
 * local headers, the central directory, and its end record. The checksum is
 * the one given, since only its equality matters here.
 */
function zipOf(files: Array<{ name: string; data: string; crc: number }>, time: number): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data, crc } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = Buffer.from(data, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(23811, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(23811, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]).toString('base64');
}

describe('createContentReader', () => {
  it('reads Apex fifty at a time and the other types Compare lists ten at a time', () => {
    const reader = createContentReader(() => connection().conn);

    expect(reader.batchSize('ApexClass')).toBe(50);
    expect(reader.batchSize('ApexTrigger')).toBe(50);
    expect(reader.batchSize('Flow')).toBe(10);
    expect(reader.batchSize('CustomField')).toBe(10);
    expect(reader.batchSize('Profile')).toBe(10);
  });

  it('reads nothing of a name that is not a Metadata API type', () => {
    const reader = createContentReader(() => connection().conn);

    expect(reader.batchSize('CustomSetting')).toBeUndefined();
    expect(reader.batchSize('Other')).toBeUndefined();
  });

  it('reads the org it is asked about', async () => {
    const source = connection([{ NamespacePrefix: null, Name: 'A', Body: 'source body' }]);
    const target = connection([{ NamespacePrefix: null, Name: 'A', Body: 'target body' }]);
    const reader = createContentReader((orgId) => (orgId === 'src' ? source.conn : target.conn));

    expect((await reader.read('tgt', 'ApexClass', ['A'])).get('A')).toBe('target body');
    expect(source.query).not.toHaveBeenCalled();
  });

  describe('Apex', () => {
    it('queries the bodies of the classes asked for, by name', async () => {
      const { conn, query } = connection([
        { NamespacePrefix: null, Name: 'Invoicing', Body: 'public class Invoicing {}' },
        { NamespacePrefix: null, Name: 'Billing', Body: 'public class Billing {}' },
      ]);

      const content = await createContentReader(() => conn).read('src', 'ApexClass', [
        'Invoicing',
        'Billing',
      ]);

      expect(query).toHaveBeenCalledWith(
        "SELECT NamespacePrefix, Name, Body FROM ApexClass WHERE Name IN ('Invoicing', 'Billing')",
      );
      expect(content).toEqual(
        new Map([
          ['Invoicing', 'public class Invoicing {}'],
          ['Billing', 'public class Billing {}'],
        ]),
      );
    });

    it('reads a body saved with Windows line endings as the same body', async () => {
      const { conn } = connection([
        { NamespacePrefix: null, Name: 'Invoicing', Body: 'public class Invoicing {\r\n}\r' },
      ]);

      const content = await createContentReader(() => conn).read('src', 'ApexClass', ['Invoicing']);

      expect(content.get('Invoicing')).toBe('public class Invoicing {\n}\n');
    });

    it('answers null for a managed class, whose body reads "(hidden)" in every org', async () => {
      const { conn, query } = connection([
        { NamespacePrefix: 'pkg', Name: 'Engine', Body: '(hidden)' },
      ]);

      const content = await createContentReader(() => conn).read('src', 'ApexClass', [
        'pkg__Engine',
      ]);

      // Asked for by its own name, and keyed back the way listMetadata names it.
      expect(query.mock.calls[0][0]).toContain("Name IN ('Engine')");
      expect(content).toEqual(new Map([['pkg__Engine', null]]));
    });

    it('leaves out a class of the same name that was not asked for', async () => {
      const { conn } = connection([
        { NamespacePrefix: 'pkg', Name: 'Util', Body: '(hidden)' },
        { NamespacePrefix: null, Name: 'Util', Body: 'public class Util {}' },
      ]);

      const content = await createContentReader(() => conn).read('src', 'ApexClass', ['Util']);

      expect(content).toEqual(new Map([['Util', 'public class Util {}']]));
    });

    it('reads triggers from ApexTrigger', async () => {
      const { conn, query } = connection([
        {
          NamespacePrefix: null,
          Name: 'OnAccount',
          Body: 'trigger OnAccount on Account (before insert) {}',
        },
      ]);

      await createContentReader(() => conn).read('src', 'ApexTrigger', ['OnAccount']);

      expect(query.mock.calls[0][0]).toContain('FROM ApexTrigger WHERE');
    });

    it('quotes a name so that it cannot end the query string', async () => {
      const { conn, query } = connection();

      await createContentReader(() => conn).read('src', 'ApexClass', ["O'Brien"]);

      expect(query.mock.calls[0][0]).toContain("Name IN ('O\\'Brien')");
    });
  });

  describe('readMetadata', () => {
    it('reads the components asked for and keys each by its fullName', async () => {
      const { conn, read } = connection(
        [],
        [
          { fullName: 'Account.Region__c', type: 'Text', length: 40 },
          { fullName: 'Account.Tier__c', type: 'Picklist' },
        ],
      );

      const content = await createContentReader(() => conn).read('src', 'CustomField', [
        'Account.Region__c',
        'Account.Tier__c',
      ]);

      expect(read).toHaveBeenCalledWith('CustomField', ['Account.Region__c', 'Account.Tier__c']);
      expect(content.get('Account.Region__c')).toBe(
        'fullName: "Account.Region__c"\nlength: 40\ntype: "Text"',
      );
      expect(content.get('Account.Tier__c')).toBe('fullName: "Account.Tier__c"\ntype: "Picklist"');
    });

    it('reads a report in a subfolder, which comes back named by its whole folder path', async () => {
      // The listing names it by its last folder; readMetadata answers with the
      // path from the top folder, in the place of the name asked for.
      const { conn } = connection(
        [],
        [{ fullName: 'Sales/Pipeline/Won_Deals', name: 'Won Deals', format: 'Tabular' }],
      );

      const content = await createContentReader(() => conn).read('src', 'Report', [
        'Pipeline/Won_Deals',
      ]);

      expect(content.get('Pipeline/Won_Deals')).toContain('name: "Won Deals"');
    });

    it("does not take a record in a name's place for it unless its path ends with that name", async () => {
      const { conn } = connection([], [{ fullName: 'Other/Report', name: 'Other' }]);

      const content = await createContentReader(() => conn).read('src', 'Report', [
        'Pipeline/Won_Deals',
      ]);

      expect(content.size).toBe(0);
    });

    it('reads a managed layout under its namespaced name when its listed one returns nothing', async () => {
      const read = vi.fn((_type: string, names: string[]) =>
        Promise.resolve(
          names.map((name) =>
            name === 'pkg__Lock__c-pkg__Lock Layout'
              ? { fullName: name, showEmailCheckbox: false }
              : { showEmailCheckbox: false },
          ),
        ),
      );
      const conn = { metadata: { read }, limitInfo: undefined } as unknown as Connection;

      const content = await createContentReader(() => conn).read('src', 'Layout', [
        'pkg__Lock__c-Lock Layout',
        'Account-Account Layout',
      ]);

      expect(read).toHaveBeenLastCalledWith('Layout', ['pkg__Lock__c-pkg__Lock Layout']);
      expect([...content.keys()]).toEqual(['pkg__Lock__c-Lock Layout']);
    });

    it('leaves out a component the org did not return, which comes back without a fullName', async () => {
      const { conn } = connection(
        [],
        [
          { fullName: 'Kept', value: 'x' },
          { value: '', protected: false },
        ],
      );

      const content = await createContentReader(() => conn).read('src', 'CustomLabel', [
        'Kept',
        'Missing',
      ]);

      expect([...content.keys()]).toEqual(['Kept']);
    });
  });
});

describe('canonicalMetadata', () => {
  it('writes the same text for the same component, whatever order its keys came in', () => {
    const one = canonicalMetadata('CustomLabel', {
      fullName: 'Greeting',
      value: 'Hi',
      language: 'en_US',
    });
    const two = canonicalMetadata('CustomLabel', {
      language: 'en_US',
      value: 'Hi',
      fullName: 'Greeting',
    });

    expect(one).toBe(two);
    expect(one).toBe('fullName: "Greeting"\nlanguage: "en_US"\nvalue: "Hi"');
  });

  it('leaves out empty values, which one org may send and the other omit', () => {
    expect(
      canonicalMetadata('CustomLabel', {
        fullName: 'A',
        shortDescription: null,
        categories: undefined,
      }),
    ).toBe(canonicalMetadata('CustomLabel', { fullName: 'A' }));
  });

  it('writes a value of several lines as an indented block, line endings as LF', () => {
    expect(
      canonicalMetadata('ValidationRule', {
        fullName: 'Account.Needs_Region',
        errorConditionFormula: 'AND(\r\n  ISBLANK(Region__c),\r\n  IsActive__c\r\n)',
      }),
    ).toBe(
      [
        'errorConditionFormula: |',
        '  AND(',
        '    ISBLANK(Region__c),',
        '    IsActive__c',
        '  )',
        'fullName: "Account.Needs_Region"',
      ].join('\n'),
    );
  });

  it('names each nested value by its path', () => {
    expect(
      canonicalMetadata('PermissionSet', {
        fullName: 'Sales',
        fieldPermissions: [{ field: 'Account.Region__c', editable: true, readable: true }],
        tabSettings: [],
      }),
    ).toBe(
      [
        'fieldPermissions[0].editable: true',
        'fieldPermissions[0].field: "Account.Region__c"',
        'fieldPermissions[0].readable: true',
        'fullName: "Sales"',
        'tabSettings: []',
      ].join('\n'),
    );
  });

  it('ignores the user a dashboard runs as, whose username differs in every org', () => {
    const inSource = canonicalMetadata('Dashboard', {
      fullName: 'Sales/Pipeline',
      title: 'Pipeline',
      runningUser: 'autoproc@00d000000000001',
      owner: 'autoproc@00d000000000001',
    });
    const inTarget = canonicalMetadata('Dashboard', {
      fullName: 'Sales/Pipeline',
      title: 'Pipeline',
      runningUser: 'autoproc@00d000000000002',
      owner: 'autoproc@00d000000000002',
    });

    expect(inSource).toBe(inTarget);
    expect(inSource).not.toContain('autoproc');
  });

  it('still sees a dashboard whose title differs', () => {
    expect(canonicalMetadata('Dashboard', { fullName: 'D', title: 'One' })).not.toBe(
      canonicalMetadata('Dashboard', { fullName: 'D', title: 'Two' }),
    );
  });

  it("ignores a summary layout label that is the layout's own record id", () => {
    const layout = (masterLabel: string) =>
      canonicalMetadata('Layout', {
        fullName: 'Account-Account Layout',
        summaryLayout: { masterLabel, sizeX: 4, sizeY: 0 },
      });

    expect(layout('00h000000000001')).toBe(layout('00h000000000002'));
    expect(layout('Highlights')).not.toBe(layout('Summary'));
  });

  it('puts entries that state their sortOrder in that order, as two orgs list them in two', () => {
    const actions = (order: string[]) =>
      canonicalMetadata('Layout', {
        fullName: 'Account-Account Layout',
        platformActionList: {
          platformActionListItems: order.map((actionName) => ({
            actionName,
            sortOrder: { LogACall: 5, NewTask: 6, NewEvent: 7 }[actionName],
          })),
        },
      });

    expect(actions(['NewEvent', 'LogACall', 'NewTask'])).toBe(
      actions(['LogACall', 'NewTask', 'NewEvent']),
    );
  });

  it('keeps the order of a list that states none, since a list of values means its order', () => {
    const values = (order: string[]) =>
      canonicalMetadata('CustomField', {
        fullName: 'Account.Tier__c',
        valueSet: { valueSetDefinition: { value: order.map((fullName) => ({ fullName })) } },
      });

    expect(values(['Gold', 'Silver'])).not.toBe(values(['Silver', 'Gold']));
  });

  it("reads a bundle's files decoded and by path, as two orgs list the same files in two orders", () => {
    const bundle = (files: Array<[string, string]>) =>
      canonicalMetadata('LightningComponentBundle', {
        fullName: 'footer',
        lwcResources: {
          lwcResource: files.map(([filePath, text]) => ({ filePath, source: base64(text) })),
        },
      });
    const html: [string, string] = ['lwc/footer/footer.html', '<template>\r\n</template>'];
    const css: [string, string] = ['lwc/footer/footer.css', ':host {}'];

    const text = bundle([html, css]);

    expect(text).toBe(bundle([css, html]));
    expect(text).toContain('lwcResources.lwcResource[1].source: |\n  <template>\n  </template>');
  });

  it("reads an email template's body decoded", () => {
    expect(
      canonicalMetadata('EmailTemplate', {
        fullName: 'unfiled$public/Welcome',
        content: base64('Hello {!Contact.FirstName}'),
      }),
    ).toContain('content: "Hello {!Contact.FirstName}"');
  });

  it('leaves a static resource that is not an archive encoded, since it may be an image', () => {
    // It starts like a zip, and holds no directory of one.
    const content = base64('PK\u0003\u0004');

    expect(canonicalMetadata('StaticResource', { fullName: 'logo', content })).toContain(
      `content: ${JSON.stringify(content)}`,
    );
  });

  it('reads two archives holding the same files as the same, whenever they were packed', () => {
    // One package, installed in two sandboxes on two dates: the same
    // stylesheet in two archives that differed only in the date of packing.
    const files = [{ name: 'flow.css', data: '.footer { margin: 0 }', crc: 0xadeb7e27 }];
    const resource = (time: number) =>
      canonicalMetadata('StaticResource', {
        fullName: 'pkg__flowStyles',
        contentType: 'application/zip',
        content: zipOf(files, time),
      });

    expect(zipOf(files, 37039)).not.toBe(zipOf(files, 24984));
    expect(resource(37039)).toBe(resource(24984));
    expect(resource(37039)).toContain('content.archive[0].file: "flow.css"');
    expect(resource(37039)).toContain('content.archive[0].crc32: "adeb7e27"');
  });

  it('still sees an archive whose file changed', () => {
    const resource = (crc: number) =>
      canonicalMetadata('StaticResource', {
        fullName: 'pkg__flowStyles',
        content: zipOf([{ name: 'flow.css', data: '.footer { margin: 0 }', crc }], 37039),
      });

    expect(resource(0xadeb7e27)).not.toBe(resource(0x1234abcd));
  });

  it('leaves out the entries of a profile that grant nothing, as a class one org alone holds lists one', () => {
    const profile = (classAccesses: Array<{ apexClass: string; enabled: boolean }>) =>
      canonicalMetadata('Profile', {
        fullName: 'Read Only',
        classAccesses,
        tabVisibilities: [{ tab: 'standard-Account', visibility: 'DefaultOn' }],
      });

    // The target also holds a test class, which its profile lists, off.
    expect(profile([{ apexClass: 'Invoicing', enabled: true }])).toBe(
      profile([
        { apexClass: 'Invoicing', enabled: true },
        { apexClass: 'InvoicingTest', enabled: false },
      ]),
    );
  });

  it('still sees a grant one profile gives and the other does not', () => {
    const profile = (enabled: boolean) =>
      canonicalMetadata('Profile', {
        fullName: 'Admin',
        applicationVisibilities: [{ application: 'Sales', default: false, visible: enabled }],
      });

    expect(profile(true)).not.toBe(profile(false));
  });

  it('keeps the entries of a permission set that carry no flag', () => {
    expect(
      canonicalMetadata('PermissionSet', {
        fullName: 'Sales',
        tabSettings: [{ tab: 'Invoice__c', visibility: 'Visible' }],
      }),
    ).toContain('tabSettings[0].visibility: "Visible"');
  });

  it('does not change the record it was given', () => {
    const record = { fullName: 'D', runningUser: 'someone', title: 'T' };

    canonicalMetadata('Dashboard', record);

    expect(record).toEqual({ fullName: 'D', runningUser: 'someone', title: 'T' });
  });
});

describe('normalizeLineEndings', () => {
  it('turns CRLF and a lone CR into LF', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});
