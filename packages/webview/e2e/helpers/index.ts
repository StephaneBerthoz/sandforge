export { MockBridge } from './MockBridge';
export { checkAccessibility, formatViolations } from './axe-helper';
export type { AccessibilityCheckOptions } from './axe-helper';

// Re-export legacy helpers for backward compatibility with existing specs
export { injectVSCodeApiMock, sendExtensionMessage } from '../mocks/vscode-api';
