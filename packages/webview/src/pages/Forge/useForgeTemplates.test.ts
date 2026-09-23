import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BaseMessage, ForgeTemplate } from '@sandforge/shared';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { useForgeTemplates } from './useForgeTemplates';
import { useForgeStore } from '../../stores/useForgeStore';
import { useNotificationStore } from '../../stores/useNotificationStore';

function template(id: string, name: string): ForgeTemplate {
  return {
    id,
    name,
    description: '',
    config: {
      inputMode: 'record',
      recordId: '001000000000001AAA',
      depth: 'direct',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    },
    objectCount: 2,
    recordCount: 20,
    createdAt: '2026-09-01T08:00:00.000Z',
    lastUsedAt: '2026-09-01T08:00:00.000Z',
  };
}

/** The payloads of every message of `type` the hook posted. */
function sent<T>(type: string): T[] {
  return mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage & { payload: T } })
    .filter((envelope) => envelope.payload.type === type)
    .map((envelope) => envelope.payload.payload);
}

/** Answer the last `requestType` message on `responseType`, correlated as a handler does. */
function replyTo(requestType: string, responseType: string, payload: unknown): void {
  const request = mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage })
    .filter((envelope) => envelope.payload.type === requestType)
    .pop();
  if (!request) throw new Error(`no '${requestType}' message was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${responseType}`,
          type: responseType,
          timestamp: Date.now(),
          correlationId: request.payload.id,
          payload,
        },
      }),
    );
  });
}

function mount(selectedTemplate = '', setSelectedTemplate = vi.fn()) {
  return renderHook(() => useForgeTemplates({ selectedTemplate, setSelectedTemplate }));
}

describe('useForgeTemplates', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.getState().reset();
    useNotificationStore.setState({ notifications: [] });
  });

  it('shows the templates the extension keeps, in place of what the panel held', () => {
    useForgeStore.getState().setTemplates([template('gone', 'Held by this panel only')]);
    const { result } = mount();

    expect(sent('forge:templates:list')).toHaveLength(1);
    replyTo('forge:templates:list', 'forge:templates:list:response', {
      templates: [template('a', 'Weekly accounts'), template('b', 'Open cases')],
    });

    expect(result.current.templates.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('says why the templates imported for the workspace are not listed yet, with the ones that are', () => {
    const { result } = mount();

    replyTo('forge:templates:list', 'forge:templates:list:response', {
      templates: [template('a', 'Weekly accounts')],
      importNotMerged: 'EROFS: read-only file system',
    });

    expect(result.current.templates.map((t) => t.id)).toEqual(['a']);
    expect(result.current.importNotMerged).toBe('EROFS: read-only file system');
    expect(result.current.loadError).toBeNull();
  });

  it('renames through the extension, and on the list only once it answered', () => {
    useForgeStore.getState().setTemplates([template('a', 'Weekly accounts')]);
    const { result } = mount();

    act(() => result.current.handleStartEdit(template('a', 'Weekly accounts')));
    act(() => {
      result.current.setEditName('  Monday accounts ');
      result.current.setEditDescription('for the dev sandbox');
    });
    act(() => result.current.handleSaveEdit());

    expect(sent<{ template: ForgeTemplate }>('forge:templates:save')[0].template).toEqual({
      ...template('a', 'Weekly accounts'),
      name: 'Monday accounts',
      description: 'for the dev sandbox',
    });
    expect(useForgeStore.getState().templates[0].name).toBe('Weekly accounts');
    expect(result.current.editingTemplateId).toBe('a');

    replyTo('forge:templates:save', 'forge:templates:save:response', { success: true });

    expect(useForgeStore.getState().templates[0].name).toBe('Monday accounts');
    expect(result.current.editingTemplateId).toBeNull();
    expect(useNotificationStore.getState().notifications[0]?.message).toBe('Monday accounts');
  });

  it('keeps the rename open, and says why, when the extension could not write it', () => {
    useForgeStore.getState().setTemplates([template('a', 'Weekly accounts')]);
    const { result } = mount();

    act(() => result.current.handleStartEdit(template('a', 'Weekly accounts')));
    act(() => result.current.setEditName('Monday accounts'));
    act(() => result.current.handleSaveEdit());
    replyTo('forge:templates:save', 'forge:templates:save:error', {
      message: 'EROFS: read-only file system',
      code: 'UNKNOWN',
      retryable: false,
    });

    expect(result.current.saveError).toBe('EROFS: read-only file system');
    expect(result.current.editingTemplateId).toBe('a');
    expect(useForgeStore.getState().templates[0].name).toBe('Weekly accounts');
  });

  it('deletes through the extension, and clears the selection of the template it removed', () => {
    useForgeStore
      .getState()
      .setTemplates([template('a', 'Weekly accounts'), template('b', 'Weekly accounts')]);
    const setSelectedTemplate = vi.fn();
    const { result } = mount('a', setSelectedTemplate);

    act(() => result.current.requestDeleteTemplate('a'));
    act(() => result.current.handleDeleteTemplate());

    expect(sent('forge:templates:delete')).toEqual([{ templateId: 'a' }]);
    expect(useForgeStore.getState().templates).toHaveLength(2);

    replyTo('forge:templates:delete', 'forge:templates:delete:response', { success: true });

    // By id: the other template of the same name stays.
    expect(useForgeStore.getState().templates.map((t) => t.id)).toEqual(['b']);
    expect(setSelectedTemplate).toHaveBeenCalledWith('');
  });

  it('keeps a template the extension could not delete, and says why', () => {
    useForgeStore.getState().setTemplates([template('a', 'Weekly accounts')]);
    const { result } = mount();

    act(() => result.current.requestDeleteTemplate('a'));
    act(() => result.current.handleDeleteTemplate());
    replyTo('forge:templates:delete', 'forge:templates:delete:error', {
      message: 'EACCES: permission denied',
      code: 'UNKNOWN',
      retryable: false,
    });

    expect(useForgeStore.getState().templates.map((t) => t.id)).toEqual(['a']);
    expect(result.current.deleteError).toBe('EACCES: permission denied');
  });
});
