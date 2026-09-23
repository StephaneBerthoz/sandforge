import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useNotificationStore,
  resetNotificationCounter,
  selectFilteredNotifications,
} from './useNotificationStore';
import type { NotificationInput } from './useNotificationStore';

function getState(): ReturnType<typeof useNotificationStore.getState> {
  return useNotificationStore.getState();
}

/** Every non-test source file under `dir`. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** `file:line` of every object literal in `text` that gives an error toast a delay. */
function errorsGivenADelay(file: string, text: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const property = (name: string): ts.PropertyAssignment | undefined =>
        node.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(source) === name,
        );
      const level = property('level')?.initializer;
      if (
        level &&
        ts.isStringLiteral(level) &&
        level.text === 'error' &&
        property('autoDismissMs')
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${file}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the delay an error toast is given', () => {
  // An error stays until it is dismissed, whatever delay it carries: thirteen
  // places still gave theirs five seconds, which read as if it went away.
  it('finds an error given a delay, and passes one given none', () => {
    expect(
      errorsGivenADelay(
        'x.ts',
        [
          "add({ level: 'error', title, message, autoDismissMs: 5000 });",
          "add({ level: 'error', title, message });",
          "add({ level: 'success', title, message, autoDismissMs: 3000 });",
        ].join('\n'),
      ),
    ).toEqual(['x.ts:1']);
  });

  it('is given by no error the panel raises', () => {
    const src = join(__dirname, '..');
    const files = sourceFiles(src);
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) =>
      errorsGivenADelay(relative(src, file), readFileSync(file, 'utf8')),
    );
    expect(found).toEqual([]);
  });
});

function createInput(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    level: 'info',
    title: 'Test notification',
    message: 'This is a test notification.',
    ...overrides,
  };
}

describe('useNotificationStore', () => {
  beforeEach(() => {
    resetNotificationCounter();
    useNotificationStore.setState({
      notifications: [],
      maxNotifications: 50,
      filterLevel: 'all',
      filterCategory: 'all',
      searchQuery: '',
    });
  });

  it('should have correct initial state', () => {
    const state = getState();
    expect(state.notifications).toEqual([]);
    expect(state.maxNotifications).toBe(50);
    expect(state.filterLevel).toBe('all');
    expect(state.filterCategory).toBe('all');
    expect(state.searchQuery).toBe('');
  });

  it('should add a notification and return its id', () => {
    const id = getState().addNotification(createInput({ title: 'Hello' }));
    expect(id).toBe('sf-notif-1');

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Hello');
    expect(notifications[0].read).toBe(false);
    expect(notifications[0].timestamp).toBeGreaterThan(0);
  });

  it('should assign sequential ids to notifications', () => {
    const id1 = getState().addNotification(createInput());
    const id2 = getState().addNotification(createInput());
    const id3 = getState().addNotification(createInput());

    expect(id1).toBe('sf-notif-1');
    expect(id2).toBe('sf-notif-2');
    expect(id3).toBe('sf-notif-3');
  });

  it('should prepend new notifications (newest first)', () => {
    getState().addNotification(createInput({ title: 'First' }));
    getState().addNotification(createInput({ title: 'Second' }));

    const notifications = getState().notifications;
    expect(notifications[0].title).toBe('Second');
    expect(notifications[1].title).toBe('First');
  });

  it('should enforce maxNotifications limit', () => {
    useNotificationStore.setState({ maxNotifications: 3 });

    getState().addNotification(createInput({ title: 'One' }));
    getState().addNotification(createInput({ title: 'Two' }));
    getState().addNotification(createInput({ title: 'Three' }));
    getState().addNotification(createInput({ title: 'Four' }));

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(3);
    expect(notifications[0].title).toBe('Four');
    expect(notifications[2].title).toBe('Two');
  });

  it('should remove a notification by id', () => {
    const id = getState().addNotification(createInput({ title: 'To Remove' }));
    getState().addNotification(createInput({ title: 'To Keep' }));

    getState().removeNotification(id);

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('To Keep');
  });

  it('should mark a single notification as read', () => {
    const id = getState().addNotification(createInput());
    expect(getState().notifications[0].read).toBe(false);

    getState().markRead(id);
    expect(getState().notifications[0].read).toBe(true);
  });

  it('should mark all notifications as read', () => {
    getState().addNotification(createInput({ title: 'A' }));
    getState().addNotification(createInput({ title: 'B' }));
    getState().addNotification(createInput({ title: 'C' }));

    getState().markAllRead();

    const allRead = getState().notifications.every((n) => n.read);
    expect(allRead).toBe(true);
  });

  it('should clear all notifications', () => {
    getState().addNotification(createInput());
    getState().addNotification(createInput());
    expect(getState().notifications).toHaveLength(2);

    getState().clearAll();
    expect(getState().notifications).toEqual([]);
  });

  it('should return correct unread count', () => {
    getState().addNotification(createInput());
    getState().addNotification(createInput());
    const id3 = getState().addNotification(createInput());

    expect(getState().unreadCount()).toBe(3);

    getState().markRead(id3);
    expect(getState().unreadCount()).toBe(2);

    getState().markAllRead();
    expect(getState().unreadCount()).toBe(0);
  });

  it('should preserve notification actions and autoDismissMs', () => {
    const actions = [
      { label: 'Retry', command: 'sandforge.retry' },
      { label: 'Dismiss', command: 'sandforge.dismiss' },
    ];
    getState().addNotification(
      createInput({
        level: 'warning',
        title: 'Stalled',
        autoDismissMs: 5000,
        actions,
      }),
    );

    const notification = getState().notifications[0];
    expect(notification.level).toBe('warning');
    expect(notification.autoDismissMs).toBe(5000);
    expect(notification.actions).toEqual(actions);
  });

  // ── Category field ──

  it('should default category to system', () => {
    getState().addNotification(createInput());
    expect(getState().notifications[0].category).toBe('system');
  });

  it('should preserve category from input', () => {
    getState().addNotification(createInput({ category: 'sync' }));
    expect(getState().notifications[0].category).toBe('sync');
  });

  // ── Filter state ──

  it('should set filterLevel', () => {
    getState().setFilterLevel('error');
    expect(getState().filterLevel).toBe('error');
  });

  it('should set filterCategory', () => {
    getState().setFilterCategory('sync');
    expect(getState().filterCategory).toBe('sync');
  });

  it('should set searchQuery', () => {
    getState().setSearchQuery('test');
    expect(getState().searchQuery).toBe('test');
  });

  // ── selectFilteredNotifications ──

  it('should return all notifications when no filters are active', () => {
    getState().addNotification(createInput({ level: 'info', title: 'A' }));
    getState().addNotification(createInput({ level: 'error', title: 'B' }));
    const filtered = selectFilteredNotifications(getState());
    expect(filtered).toHaveLength(2);
  });

  it('should filter by level', () => {
    getState().addNotification(createInput({ level: 'info', title: 'Info one' }));
    getState().addNotification(createInput({ level: 'error', title: 'Error one' }));
    getState().addNotification(createInput({ level: 'info', title: 'Info two' }));
    getState().setFilterLevel('error');
    const filtered = selectFilteredNotifications(getState());
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('Error one');
  });

  it('should filter by category', () => {
    getState().addNotification(createInput({ category: 'sync', title: 'Sync notif' }));
    getState().addNotification(createInput({ category: 'seed', title: 'Seed notif' }));
    getState().setFilterCategory('sync');
    const filtered = selectFilteredNotifications(getState());
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('Sync notif');
  });

  it('should filter by search query on title', () => {
    getState().addNotification(createInput({ title: 'Deploy complete' }));
    getState().addNotification(createInput({ title: 'Sync failed' }));
    getState().setSearchQuery('deploy');
    const filtered = selectFilteredNotifications(getState());
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('Deploy complete');
  });

  it('should filter by search query on message', () => {
    getState().addNotification(createInput({ title: 'A', message: 'Records synced successfully' }));
    getState().addNotification(createInput({ title: 'B', message: 'Connection lost' }));
    getState().setSearchQuery('synced');
    const filtered = selectFilteredNotifications(getState());
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('A');
  });

  it('should combine level and category filters', () => {
    getState().addNotification(
      createInput({ level: 'error', category: 'sync', title: 'Sync error' }),
    );
    getState().addNotification(
      createInput({ level: 'error', category: 'seed', title: 'Seed error' }),
    );
    getState().addNotification(
      createInput({ level: 'info', category: 'sync', title: 'Sync info' }),
    );
    getState().setFilterLevel('error');
    getState().setFilterCategory('sync');
    const filtered = selectFilteredNotifications(getState());
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('Sync error');
  });
});
