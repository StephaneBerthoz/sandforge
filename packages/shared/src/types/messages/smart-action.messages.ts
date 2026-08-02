import type { BaseMessage } from './base.messages.js';
import type { SmartActionRecommendation } from '../smart-action.types.js';

/** Request to analyze an org and get a smart action recommendation. */
export interface SmartActionAnalyzeRequest extends BaseMessage {
  type: 'smart-action:analyze';
  payload: { targetOrgId: string; sourceOrgId?: string };
}

/** Response containing the smart action recommendation. */
export interface SmartActionAnalyzeResponse extends BaseMessage {
  type: 'smart-action:analyze:response';
  payload: { recommendation: SmartActionRecommendation };
}
