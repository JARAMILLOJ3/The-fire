/**
 * Security Rules Verification Suite (Dirty Dozen Adversarial Payloads)
 * Covers all 12 adversarial vectors defined in security_spec.md.
 */

export interface DirtyDozenCase {
  id: string;
  description: string;
  collectionPath: string;
  operation: 'create' | 'update' | 'get' | 'list' | 'delete';
  expected: 'PERMISSION_DENIED';
}

export const dirtyDozenCases: DirtyDozenCase[] = [
  {
    id: 'DD-01',
    description: 'Unverified email spoofing bootstrapped admin',
    collectionPath: 'workspaces/restaurante_principal',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-02',
    description: 'Shadow field injection (ghost key isVerified) on items create',
    collectionPath: 'items/item_ghost',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-03',
    description: 'Self-role escalation in teamMembers without matching invite',
    collectionPath: 'teamMembers/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-04',
    description: 'Cross-station report write by mesera into hamburguesas',
    collectionPath: 'dailyReports/restaurante_principal_2026-11-13_hamburguesas',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-05',
    description: 'Orphaned entry injection without parent dailyReport',
    collectionPath: 'dailyReports/nonexistent_report/entries/item_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-06',
    description: 'ID poisoning with oversized or invalid characters',
    collectionPath: 'items/invalid$id!',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-07',
    description: 'Negative stock value poisoning on entry update',
    collectionPath: 'dailyReports/restaurante_principal_2026-11-13_mesera/entries/item_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-08',
    description: 'Client timestamp forgery bypassing request.time',
    collectionPath: 'items/item_forged_time',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-09',
    description: 'Terminal state bypass by station staff on completed report',
    collectionPath: 'dailyReports/restaurante_principal_2026-11-13_mesera',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-10',
    description: 'Catalog mutation by station staff on items collection',
    collectionPath: 'items/item_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-11',
    description: 'Unfiltered list scraping by unauthorized external user',
    collectionPath: 'items',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-12',
    description: 'Owner UID reassignment on workspace update',
    collectionPath: 'workspaces/restaurante_principal',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
  },
];
