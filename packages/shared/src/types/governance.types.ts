/**
 * One governance policy as `governance:policies:list` summarises it.
 *
 * Declared once here: the handler that builds it, the message that carries it
 * and the panel that lists it each used to declare the same shape on its own.
 */
export interface GovernancePolicySummary {
  id: string;
  name: string;
  description: string;
  ruleCount: number;
  createdAt: string;
  updatedAt: string;
}
