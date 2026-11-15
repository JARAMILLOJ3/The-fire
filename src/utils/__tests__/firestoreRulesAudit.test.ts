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

  it('validates capture type fields on items (inputType, int packSize > 1, labels <= 20, capacity > 0) without widening worker writes', () => {
    expect(rulesText).toContain("data.inputType in ['count', 'packs', 'level']");
    expect(rulesText).toContain('data.packSize is int && data.packSize > 1 && data.packSize <= 10000');
    expect(rulesText).toContain('data.packLabel is string && data.packLabel.size() >= 1 && data.packLabel.size() <= 20');
    expect(rulesText).toContain('data.unitLabel is string && data.unitLabel.size() >= 1 && data.unitLabel.size() <= 20');
    expect(rulesText).toContain('data.capacity is number && data.capacity > 0 && data.capacity <= 100000');
    expect(rulesText).toContain("data.allowClosedContainers is bool && (!data.allowClosedContainers || ('inputType' in data && data.inputType == 'level'))");

    const itemsBlockMatch = rulesText.match(/match \/items\/\{itemId\} \{[\s\S]*?\n    \}/);
    expect(itemsBlockMatch).not.toBeNull();
    const itemsBlock = itemsBlockMatch![0];
    expect(itemsBlock).toContain('allow create:');
    expect(itemsBlock).toContain('canManageWorkspace(');
    expect(itemsBlock).not.toContain('isActiveStationWorker(');
  });

  it('restricts destructive deletes on stations, items, reports, entries, and teamMembers strictly to the workspace owner', () => {
    expect(rulesText).toContain('function isWorkspaceOwnerDoc(docData)');

    const extractDeleteClause = (matchPrefix: RegExp): string => {
      const section = rulesText.match(matchPrefix)?.[0] ?? '';
      const delMatch = section.match(/allow delete:[^;]+;/);
      return delMatch ? delMatch[0] : '';
    };

    const stationsDelete = extractDeleteClause(/match \/stations\/\{stationId\}[\s\S]*?allow delete:[^;]+;/);
    const itemsDelete = extractDeleteClause(/match \/items\/\{itemId\}[\s\S]*?allow delete:[^;]+;/);
    const reportsDelete = extractDeleteClause(/match \/dailyReports\/\{reportId\}[\s\S]*?allow delete:[^;]+;/);
    const entriesDelete = extractDeleteClause(/match \/entries\/\{itemId\}[\s\S]*?allow delete:[^;]+;/);
    const membersDelete = extractDeleteClause(/match \/teamMembers\/\{memberId\}[\s\S]*?allow delete:[^;]+;/);

    [stationsDelete, itemsDelete, reportsDelete, entriesDelete, membersDelete].forEach((block) => {
      expect(block).toContain('isWorkspaceOwnerDoc(existing())');
      expect(block).not.toContain('canManageWorkspace(');
      expect(block).not.toContain('isActiveStationWorker(');
    });

    // Entry delete requires 0 extra get/exists reads so owner batch reset works cleanly across reports
    expect(entriesDelete).not.toMatch(/\b(get|exists)\s*\(/);
  });

  it('bounds assignedItemIds on stations to <= 150 and restricts station updates to managers', () => {
    expect(rulesText).toContain('data.assignedItemIds.size() <= 150');
    const stationsBlockMatch = rulesText.match(/match \/stations\/\{stationId\} \{[\s\S]*?\n    \}/);
    expect(stationsBlockMatch).not.toBeNull();
    const stationsBlock = stationsBlockMatch![0];
    expect(stationsBlock).toContain("'assignedItemIds'");
    expect(stationsBlock).toContain('allow update:');
    expect(stationsBlock).toContain('canManageWorkspace(');
    expect(stationsBlock).not.toContain('isActiveStationWorker(');
  });

  it('secures workerNotes for active workers (own notes, own station, current operational day, <= 200 chars, any hour) and bosses (read/delete)', () => {
    expect(rulesText).toContain('function isCurrentOperationalDate(dateVal)');
    expect(rulesText).toContain('function isValidWorkerNote(data)');
    expect(rulesText).toContain('data.text is string && data.text.size() >= 1 && data.text.size() <= 200 && data.text.trim().size() >= 1');

    const notesBlockMatch = rulesText.match(/match \/workerNotes\/\{noteId\} \{[\s\S]*?\n    \}/);
    expect(notesBlockMatch).not.toBeNull();
    const notesBlock = notesBlockMatch![0];

    expect(notesBlock).toContain('isActiveStationWorker(incoming().workspaceId, incoming().station)');
    expect(notesBlock).toContain('isCurrentOperationalDate(incoming().date)');
    expect(notesBlock).toContain('isCurrentOperationalDate(existing().date)');
    expect(notesBlock).toContain('incoming().authorUid == request.auth.uid');
    expect(notesBlock).toContain('existing().authorUid == request.auth.uid');
    expect(notesBlock).toContain('incoming().station == existing().station');
    expect(notesBlock).toContain('incoming().authorUid == existing().authorUid');
    expect(notesBlock).toContain('incoming().authorName == existing().authorName');
    expect(notesBlock).toContain('incoming().date == existing().date');
    expect(notesBlock).toContain('incoming().createdAt == existing().createdAt');
    // Workers can write notes at any hour without schedule-window blocking
    expect(notesBlock).not.toContain('isWorkerWithinSchedule(');
    // Boss can read and delete
    expect(notesBlock).toContain('canManageWorkspace(existing().workspaceId)');
  });
});
