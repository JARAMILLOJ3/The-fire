import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rulesPath = resolve(process.cwd(), 'firestore.rules');
const rulesText = readFileSync(rulesPath, 'utf8');

describe('firestore.rules structural security audit', () => {
  it('starts with default-deny catch-all and enforces rules_version 2', () => {
    expect(rulesText).toContain("rules_version = '2';");
    expect(rulesText).toContain('match /{document=**} {\n      allow read, write: if false;\n    }');
  });

  it('contains no hardcoded personal admin emails', () => {
    expect(rulesText).not.toContain('jsjg1023');
    expect(rulesText).toContain('match /admins/{adminUid}');
    expect(rulesText).toContain('exists(/databases/$(database)/documents/admins/$(request.auth.uid))');
  });

  it('validates all email entries and restricts workers to teamMembers + Bogotá schedule', () => {
    expect(rulesText).toContain('isValidEmailStr(listVal[14])');
    expect(rulesText).toContain('bogotaOpDateStr()');
    expect(rulesText).toContain('bogotaPrevOpDateStr()');
    expect(rulesText).toContain('inWindowWithGrace(');
    expect(rulesText).toContain('isWorkerWithinSchedule(');
  });

  it('blocks entry creation when parent dailyReport is completed and locks catalog fields', () => {
    expect(rulesText).toContain("get(/databases/$(database)/documents/dailyReports/$(reportId)).data.status != 'completed'");
    expect(rulesText).toContain('incoming().itemName == existing().itemName');
    expect(rulesText).toContain('incoming().minStock == existing().minStock');
    expect(rulesText).toContain('incoming().targetStock == existing().targetStock');
    expect(rulesText).toContain('incoming().station == existing().station');
  });

  it('never uses get() or exists() inside allow list rules', () => {
    const allowListMatches = [...rulesText.matchAll(/allow list:[\s\S]*?;/g)].map((m) => m[0]);
    expect(allowListMatches.length).toBeGreaterThanOrEqual(5);
    allowListMatches.forEach((ruleBlock) => {
      expect(ruleBlock).not.toMatch(/\b(get|exists|getAfter|existsAfter)\s*\(/);
    });
  });

  it('uses single-get helpers for worker report/entry creation and handles legacy hamburguesas station IDs', () => {
    expect(rulesText).toContain('function isActiveStationWorker(wsId, station)');
    expect(rulesText).toContain('function validWorkerMember(wsId, station, memberData)');
    expect(rulesText).toContain('function validWorkerReportCreate(wsData, report)');
    expect(rulesText).toContain('function reportAfterMatchesEntry(reportData, entry)');
    expect(rulesText).toContain('function entryMatchesItem(entry, itemData)');
    expect(rulesText).toContain("itemData.station == 'hamburguesas' && entry.station == 'comida_rapida'");
    expect(rulesText).toContain('entryMatchesItem(\n                incoming(),\n                get(/databases/$(database)/documents/items/$(itemId)).data');
    expect(rulesText).not.toContain('exists(/databases/$(database)/documents/items/$(itemId))');
  });
});
