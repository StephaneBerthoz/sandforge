/** Standard Salesforce objects commonly used in data operations */
export const SF_STANDARD_OBJECTS = [
  'Account', 'Contact', 'Lead', 'Opportunity', 'Case',
  'Task', 'Event', 'User', 'Profile', 'PermissionSet',
  'OpportunityLineItem', 'PricebookEntry', 'Pricebook2', 'Product2',
  'Contract', 'Order', 'OrderItem', 'Asset', 'Campaign', 'CampaignMember',
  'Solution', 'ContentDocument', 'ContentVersion', 'Attachment',
  'Note', 'FeedItem', 'Group', 'GroupMember', 'UserRole',
  'RecordType', 'BusinessProcess', 'EmailTemplate',
] as const;

export type StandardObjectName = typeof SF_STANDARD_OBJECTS[number];

/** Objects that cannot be inserted via API */
export const SF_READ_ONLY_OBJECTS = [
  'User', 'Profile', 'UserRole', 'PermissionSet', 'RecordType',
  'BusinessProcess', 'Group',
] as const;

/** Objects that support Bulk API 2.0 */
export const SF_BULK_API_SUPPORTED_OBJECTS = [
  'Account', 'Contact', 'Lead', 'Opportunity', 'Case',
  'Task', 'Event', 'OpportunityLineItem', 'PricebookEntry',
  'Product2', 'Contract', 'Order', 'OrderItem', 'Asset',
  'Campaign', 'CampaignMember', 'Solution', 'ContentVersion',
] as const;

/** Common parent-child relationships */
export const SF_COMMON_RELATIONSHIPS: Record<string, string[]> = {
  Account: ['Contact', 'Opportunity', 'Case', 'Task', 'Event', 'Asset', 'Contract', 'Order'],
  Contact: ['Task', 'Event', 'Case', 'OpportunityContactRole'],
  Opportunity: ['OpportunityLineItem', 'Task', 'Event', 'OpportunityContactRole'],
  Campaign: ['CampaignMember'],
  Pricebook2: ['PricebookEntry'],
  Product2: ['PricebookEntry'],
  Order: ['OrderItem'],
};
