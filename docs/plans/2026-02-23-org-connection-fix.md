# Org Connection Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Connect Org, Import SFDX, and Disconnect work end-to-end in the SandForge sidebar.

**Architecture:** Fix 4 bugs in the existing message pipeline. No new architecture — all code exists, the wiring has gaps. (1) MessageBroker.dispatch() silently drops async errors. (2) useVSCodeApi falls back to no-op without warning. (3) Notifications go to a panel that's always closed — user sees nothing. (4) No isConnecting feedback during async operations.

**Tech Stack:** TypeScript, VSCode Extension API, React, Zustand, Vitest.

---

## Root Cause Analysis

```
WebView click → sendMessage() → [works if acquireVsCodeApi exists]
                                    ↓
Extension MessageBroker.dispatch() → calls async handler → Promise rejected? → SILENTLY LOST
                                    ↓ (if success)
Extension sends notification → WebView receives → stored in NotificationStore
                                    ↓
NotificationCenter renders only when `open=true` → `open` starts `false` → USER SEES NOTHING
```

4 fixes needed, in dependency order:
1. **Task 1**: useVSCodeApi — warn on fallback
2. **Task 2**: MessageBroker.dispatch() — catch async errors
3. **Task 3**: FloatingToasts — auto-show notifications
4. **Task 4**: isConnecting feedback — show loading state
5. **Task 5**: Build + validate

---

### Task 1: useVSCodeApi — warn on noopApi fallback

**Files:**
- Modify: `packages/webview/src/hooks/useVSCodeApi.ts`
- Test: `packages/webview/src/hooks/useVSCodeApi.test.ts` (already exists — verify)

**Why:** When `acquireVsCodeApi` isn't available (dev server, broken webview), `postMessage` silently does nothing. Adding a console.warn gives immediate diagnostic signal.

**Step 1: Modify useVSCodeApi.ts**

In `getApi()`, add a console.warn when falling back to noopApi:

```typescript
function getApi(): VSCodeApi {
  if (cachedApi) {
    return cachedApi;
  }

  if (typeof acquireVsCodeApi === 'function') {
    cachedApi = acquireVsCodeApi();
  } else {
    console.warn('[SandForge] acquireVsCodeApi not available — messages will be no-ops');
    cachedApi = noopApi;
  }

  return cachedApi;
}
```

**Step 2: Run typecheck**

Run: `pnpm --filter @sandforge/webview typecheck`
Expected: 0 errors

**Step 3: Run tests**

Run: `pnpm --filter @sandforge/webview test`
Expected: All pass

---

### Task 2: MessageBroker.dispatch() — handle async errors

**Files:**
- Modify: `packages/extension/src/bridge/MessageBroker.ts:72-79`
- Modify: `packages/extension/src/bridge/MessageBroker.test.ts`

**Why:** `dispatch()` calls handlers without awaiting. Async handlers (org:connect, org:disconnect) that reject silently lose their errors. The user gets zero feedback.

**Step 1: Write the failing test**

Add to `MessageBroker.test.ts` in the `on` describe block:

```typescript
it('should catch and log errors from async handlers without crashing', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const handler = vi.fn().mockRejectedValue(new Error('async boom'));
  broker.on('org:connect', handler);

  const panel = createMockPanel();
  broker.registerPanel(panel as unknown as vscode.WebviewPanel);

  const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
  messageCallback(createMessage('org:connect'));

  // Wait for the microtask queue to flush
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(handler).toHaveBeenCalledOnce();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('[SandForge] Handler error for "org:connect"'),
    expect.any(Error),
  );
  consoleError.mockRestore();
});

it('should catch and log errors from sync handlers without crashing', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const handler = vi.fn().mockImplementation(() => { throw new Error('sync boom'); });
  broker.on('org:list', handler);

  const panel = createMockPanel();
  broker.registerPanel(panel as unknown as vscode.WebviewPanel);

  const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
  messageCallback(createMessage('org:list'));

  expect(handler).toHaveBeenCalledOnce();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('[SandForge] Handler error for "org:list"'),
    expect.any(Error),
  );
  consoleError.mockRestore();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter sandforge test -- src/bridge/MessageBroker.test.ts`
Expected: FAIL — dispatch doesn't catch errors

**Step 3: Implement the fix in MessageBroker.ts**

Replace the `dispatch` method:

```typescript
private dispatch(message: BaseMessage): void {
  const handlerSet = this.handlers.get(message.type);
  if (!handlerSet) {
    return;
  }
  for (const handler of handlerSet) {
    try {
      const result = handler(message);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          console.error(`[SandForge] Handler error for "${message.type}":`, err);
        });
      }
    } catch (err: unknown) {
      console.error(`[SandForge] Handler error for "${message.type}":`, err);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter sandforge test -- src/bridge/MessageBroker.test.ts`
Expected: All pass

**Step 5: Run full extension tests**

Run: `pnpm --filter sandforge test`
Expected: All pass

---

### Task 3: FloatingToasts — auto-show notifications to user

**Files:**
- Create: `packages/webview/src/components/ui/FloatingToasts.tsx`
- Create: `packages/webview/src/components/ui/FloatingToasts.test.tsx`
- Modify: `packages/webview/src/layouts/AppShell.tsx`

**Why:** The NotificationCenter is a slide-out panel that starts closed. When the extension sends notification messages (success, error), they go into the store but the user never sees them. We need floating toasts that auto-appear.

**Step 1: Write the failing test for FloatingToasts**

Create `packages/webview/src/components/ui/FloatingToasts.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FloatingToasts } from './FloatingToasts';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { resetNotificationCounter } from '../../stores/useNotificationStore';

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], maxNotifications: 50 });
  resetNotificationCounter();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FloatingToasts', () => {
  it('should render nothing when there are no notifications', () => {
    const { container } = render(<FloatingToasts />);
    expect(container.querySelector('[data-testid="floating-toasts"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid^="floating-toast-"]')).toHaveLength(0);
  });

  it('should display a new notification as a toast', () => {
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'success',
        title: 'Connected',
        message: 'Org connected successfully',
      });
    });

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Org connected successfully')).toBeInTheDocument();
  });

  it('should show at most 3 toasts', () => {
    render(<FloatingToasts />);

    act(() => {
      for (let i = 0; i < 5; i++) {
        useNotificationStore.getState().addNotification({
          level: 'info',
          title: `Toast ${i}`,
          message: `Message ${i}`,
        });
      }
    });

    const toasts = screen.getAllByText(/^Toast \d$/);
    expect(toasts.length).toBeLessThanOrEqual(3);
  });

  it('should auto-dismiss toasts after autoDismissMs', () => {
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'success',
        title: 'Temp',
        message: 'Goes away',
        autoDismissMs: 3000,
      });
    });

    expect(screen.getByText('Temp')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3100);
    });

    expect(screen.queryByText('Temp')).not.toBeInTheDocument();
  });

  it('should render error toasts with error styling', () => {
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'error',
        title: 'Failed',
        message: 'Something broke',
      });
    });

    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @sandforge/webview test -- src/components/ui/FloatingToasts.test.tsx`
Expected: FAIL — module not found

**Step 3: Implement FloatingToasts.tsx**

Create `packages/webview/src/components/ui/FloatingToasts.tsx`:

```tsx
import React, { useEffect, useRef } from 'react';
import { cn } from '../../theme';
import { useNotificationStore } from '../../stores/useNotificationStore';
import type { Notification } from '../../stores/useNotificationStore';

const MAX_VISIBLE_TOASTS = 3;

const levelStyles: Record<Notification['level'], string> = {
  info: 'border-l-[var(--vscode-notificationsInfoIcon-foreground,#75beff)]',
  success: 'border-l-[#10b981]',
  warning: 'border-l-[var(--vscode-notificationsWarningIcon-foreground,#cca700)]',
  error: 'border-l-[var(--vscode-notificationsErrorIcon-foreground,#f14c4c)]',
};

/** Floating toast notifications that auto-appear on new notifications. */
export const FloatingToasts: React.FC = () => {
  const notifications = useNotificationStore((s) => s.notifications);
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const visible = notifications.slice(0, MAX_VISIBLE_TOASTS);

  useEffect(() => {
    for (const n of visible) {
      if (n.autoDismissMs && !timersRef.current.has(n.id)) {
        const timer = setTimeout(() => {
          removeNotification(n.id);
          timersRef.current.delete(n.id);
        }, n.autoDismissMs);
        timersRef.current.set(n.id, timer);
      }
    }

    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, [visible, removeNotification]);

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72 pointer-events-none"
      data-testid="floating-toasts"
    >
      {visible.map((n) => (
        <div
          key={n.id}
          className={cn(
            'pointer-events-auto rounded px-3 py-2 border-l-4 shadow-lg',
            'bg-[var(--vscode-notifications-background,#252526)]',
            'text-[var(--vscode-notifications-foreground,#cccccc)]',
            'border border-[var(--vscode-notifications-border,#3c3c3c)]',
            levelStyles[n.level],
          )}
          data-testid={`floating-toast-${n.id}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{n.title}</p>
              <p className="text-xs opacity-80 mt-0.5 line-clamp-2">{n.message}</p>
            </div>
            <button
              className="text-xs opacity-60 hover:opacity-100 shrink-0"
              onClick={() => removeNotification(n.id)}
              aria-label="Dismiss"
            >
              {'\u2715'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @sandforge/webview test -- src/components/ui/FloatingToasts.test.tsx`
Expected: All pass

**Step 5: Add FloatingToasts to AppShell**

Modify `packages/webview/src/layouts/AppShell.tsx`:

Add import at top:
```typescript
import { FloatingToasts } from '../components/ui/FloatingToasts';
```

Add `<FloatingToasts />` inside the root div, after `<NotificationCenter .../>`:
```tsx
      <NotificationCenter
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
      <FloatingToasts />
```

**Step 6: Run AppShell tests**

Run: `pnpm --filter @sandforge/webview test -- src/layouts/AppShell.test.tsx`
Expected: All pass (FloatingToasts renders empty by default)

---

### Task 4: isConnecting feedback — loading state in OrgManagerPage

**Files:**
- Modify: `packages/webview/src/pages/OrgManager/OrgManagerPage.tsx`
- Modify: `packages/webview/src/bridge/BridgeProvider.tsx`

**Why:** `handleConnect` sends the message and immediately closes the dialog. The `isConnecting` state is never toggled. The user gets no visual feedback.

**Step 1: Modify OrgManagerPage.tsx handleConnect**

Set `isConnecting` to true before sending, and keep the dialog open:

Replace the `handleConnect` callback (lines 29-50):

```typescript
const handleConnect = useCallback((payload: ConnectOrgPayload) => {
  useOrgStore.getState().setConnecting(true);
  sendMessage(
    buildMessage<{
      orgId: string;
      authMethod: string;
      alias?: string;
      loginUrl?: string;
      username?: string;
      password?: string;
      securityToken?: string;
    }>('org:connect', {
      orgId: '',
      authMethod: payload.authMethod,
      alias: payload.alias,
      loginUrl: payload.loginUrl,
      username: payload.username,
      password: payload.password,
      securityToken: payload.securityToken,
    }),
  );
}, [sendMessage]);
```

Note: the dialog stays open now (removed `setConnectDialogOpen(false)`). It will close when we receive a response.

**Step 2: Modify BridgeProvider.tsx — listen for connection results**

Add listeners that reset `isConnecting` and close the dialog. Add these after the existing `useMessageListener` calls:

```typescript
// Listen for org:statusChanged → reset connecting state
useMessageListener<BaseMessage & { payload: { orgId: string; status: string } }>(
  'org:statusChanged',
  (msg) => {
    useOrgStore.getState().updateOrg(msg.payload.orgId, {
      status: msg.payload.status as SalesforceOrg['status'],
    });
    useOrgStore.getState().setConnecting(false);
  },
);
```

Wait — the existing `org:statusChanged` listener already exists at line 61. We need to modify it to also call `setConnecting(false)`. Replace lines 61-68:

```typescript
// Listen for org:statusChanged → updateOrg + reset connecting
useMessageListener<BaseMessage & { payload: { orgId: string; status: string } }>(
  'org:statusChanged',
  (msg) => {
    useOrgStore.getState().updateOrg(msg.payload.orgId, {
      status: msg.payload.status as SalesforceOrg['status'],
    });
    useOrgStore.getState().setConnecting(false);
  },
);
```

And add a new listener for `state:sync` that also resets connecting (for SFDX import which syncs state):

In the existing `state:sync` listener (lines 44-58), add `setConnecting(false)` after updating orgs:

```typescript
useMessageListener<
  BaseMessage & {
    payload: {
      orgs?: SalesforceOrg[];
      extensionReady?: boolean;
    };
  }
>('state:sync', (msg) => {
  if (msg.payload.orgs) {
    useOrgStore.getState().setOrgs(msg.payload.orgs as SalesforceOrg[]);
    useOrgStore.getState().setConnecting(false);
  }
  if (msg.payload.extensionReady !== undefined) {
    useAppStore.getState().setExtensionReady(msg.payload.extensionReady);
  }
});
```

Also add a listener for `notification` with error level to reset connecting:

In the existing `notification` listener (lines 70-87), add `setConnecting(false)` for error notifications:

```typescript
useMessageListener<
  BaseMessage & {
    payload: {
      level: 'info' | 'success' | 'warning' | 'error';
      title: string;
      message: string;
      autoDismissMs?: number;
    };
  }
>('notification', (msg) => {
  useNotificationStore.getState().addNotification({
    level: msg.payload.level,
    title: msg.payload.title,
    message: msg.payload.message,
    autoDismissMs: msg.payload.autoDismissMs,
  });
  if (msg.payload.level === 'error' || msg.payload.level === 'success') {
    useOrgStore.getState().setConnecting(false);
  }
});
```

**Step 3: Close dialog on success in OrgManagerPage**

Add a `useEffect` in OrgManagerPage that closes the dialog when `isConnecting` goes from true to false and orgs changed:

```typescript
// Close dialog when connecting finishes
const prevConnecting = useRef(isConnecting);
useEffect(() => {
  if (prevConnecting.current && !isConnecting) {
    setConnectDialogOpen(false);
  }
  prevConnecting.current = isConnecting;
}, [isConnecting]);
```

Add `useRef` to the import line:
```typescript
import React, { useState, useCallback, useEffect, useRef } from 'react';
```

**Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

**Step 5: Run tests**

Run: `pnpm --filter @sandforge/webview test`
Expected: All pass

---

### Task 5: Build, package, and validate

**Files:** None (validation only)

**Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: 0 errors across all 3 packages

**Step 2: Full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Build all packages**

Run: `pnpm build`
Expected: All 3 packages build successfully

**Step 4: Package VSIX**

Run: `pnpm package`
Expected: `sandforge.vsix` generated

**Step 5: Manual validation**

Run: `code --profile-temp --install-extension sandforge.vsix`

Then:
1. Open sidebar SandForge
2. Navigate to Orgs page
3. Click "Connect Org"
4. Select "Import from SF CLI" and click Import
   - Expected: Loading spinner → floating toast shows result
5. If SF CLI is installed with connected orgs → orgs appear in list
6. If SF CLI not installed → error toast appears
7. Click Disconnect on an org → org disappears, toast confirms

---

## File Change Summary

| File | Action | Lines Changed |
|------|--------|---------------|
| `packages/webview/src/hooks/useVSCodeApi.ts` | Modify | +1 line |
| `packages/extension/src/bridge/MessageBroker.ts` | Modify | ~10 lines |
| `packages/extension/src/bridge/MessageBroker.test.ts` | Modify | +30 lines |
| `packages/webview/src/components/ui/FloatingToasts.tsx` | Create | ~70 lines |
| `packages/webview/src/components/ui/FloatingToasts.test.tsx` | Create | ~70 lines |
| `packages/webview/src/layouts/AppShell.tsx` | Modify | +2 lines |
| `packages/webview/src/pages/OrgManager/OrgManagerPage.tsx` | Modify | ~10 lines |
| `packages/webview/src/bridge/BridgeProvider.tsx` | Modify | ~6 lines |
