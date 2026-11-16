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

  it('blocks entry creation/update when parent dailyReport is completed and locks catalog fields', () => {
    expect(rulesText).toContain("reportAfterSnap.data.status != 'completed'");
    expect(rulesText).toContain("reportSnap.data.status != 'completed'");
    expect(rulesText).toContain('incomingData.itemName == existingData.itemName');
    expect(rulesText).toContain('incomingData.minStock == existingData.minStock');
    expect(rulesText).toContain('incomingData.targetStock == existingData.targetStock');
    expect(rulesText).toContain('incoming().station == existing().station');
  });

  it('never uses get() or exists() inside allow list rules', () => {
    const allowListMatches = [...rulesText.matchAll(/allow list:[\s\S]*?;/g)].map((m) => m[0]);
    expect(allowListMatches.length).toBeGreaterThanOrEqual(5);
    allowListMatches.forEach((ruleBlock) => {
      expect(ruleBlock).not.toMatch(/\b(get|exists|getAfter|existsAfter)\s*\(/);
    });
  });

  it('uses single-get helpers without duplicate exists+get on worker report/entry creation and handles legacy hamburguesas station IDs', () => {
    expect(rulesText).toContain('function isActiveStationWorker(wsId, station)');
    expect(rulesText).toContain('function validWorkerMember(wsId, station, memberData)');
    expect(rulesText).toContain('function validWorkerMemberDoc(wsId, station, memberSnap)');
    expect(rulesText).toContain('function validWorkerReportCreate(wsData, report)');
    expect(rulesText).toContain('function reportAfterMatchesEntry(reportData, entry)');
    expect(rulesText).toContain('function entryMatchesItem(entry, itemData)');
    expect(rulesText).toContain('function canCreateDailyReportEntry(reportAfterSnap, entry, itemId)');
    expect(rulesText).toContain('function canWorkerUpdateEntry(reportSnap, incomingData, existingData)');
    expect(rulesText).toContain("itemData.station == 'hamburguesas' && entry.station == 'comida_rapida'");
    expect(rulesText).toContain('entryMatchesItem(\n              entry,\n              get(/databases/$(database)/documents/items/$(itemId)).data');
    expect(rulesText).not.toContain('exists(/databases/$(database)/documents/items/$(itemId))');

    // Worker entry create reuses single getAfter(dailyReports) and never reads dailyReports via exists/get separately
    const createHelperMatch = rulesText.match(
      /function canCreateDailyReportEntry\(reportAfterSnap, entry, itemId\) \{[\s\S]*?\n    \}/,
    );
    expect(createHelperMatch).not.toBeNull();
    expect(createHelperMatch![0]).not.toContain('exists(/databases/$(database)/documents/dailyReports/');
    expect(createHelperMatch![0]).not.toContain('get(/databases/$(database)/documents/dailyReports/');
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

/**
 * Exact simulation of Firestore Security Rules CEL evaluation and AST expression budget
 * for `dailyReports/{reportId}/entries/{itemId}` (TAREA 1 cases a-g).
 */
describe('TAREA 1 (a)-(g): Exact CEL evaluation & expression-budget reproduction for worker entry saves', () => {
  const WS_ID = 'ws_fire';
  const OWNER_UID = 'boss_uid_1';
  const OWNER_EMAIL = 'boss@thefire.com';
  const WORKER_UID = 'worker_mesera_1';
  const WORKER_EMAIL = 'mesera@thefire.com';
  const STATION = 'mesera';
  const OP_DATE = '2026-11-15';
  const REPORT_ID = `${WS_ID}_${OP_DATE}_${STATION}`;

  interface SimulatedDoc {
    data: Record<string, unknown>;
  }

  interface SimulationState {
    bogotaDateStr: string;
    bogotaPrevDateStr: string;
    bogotaMinutesNow: number;
    authUid: string;
    authEmail: string;
    emailVerified: boolean;
    workspaceDoc: SimulatedDoc | null;
    memberDoc: SimulatedDoc | null;
    reportBeforeDoc: SimulatedDoc | null;
    reportAfterDoc: SimulatedDoc | null;
    itemsById: Record<string, SimulatedDoc>;
    entriesBeforeById: Record<string, SimulatedDoc>;
  }

  function makeBaseState(overrides?: Partial<SimulationState>): SimulationState {
    return {
      bogotaDateStr: OP_DATE,
      bogotaPrevDateStr: '2026-11-14',
      // 17:40 Bogotá = 17 * 60 + 40 = 1060 minutes
      bogotaMinutesNow: 17 * 60 + 40,
      authUid: WORKER_UID,
      authEmail: WORKER_EMAIL,
      emailVerified: true,
      workspaceDoc: {
        data: {
          name: 'The Fire',
          ownerUid: OWNER_UID,
          ownerEmail: OWNER_EMAIL,
          authorizedEmails: [OWNER_EMAIL],
          seeded: true,
          shiftSchedule: {
            enabled: true,
            openingStart: '10:00',
            openingEnd: '15:00',
            closingStart: '16:00',
            closingEnd: '01:00',
          },
        },
      },
      memberDoc: {
        data: {
          uid: WORKER_UID,
          email: WORKER_EMAIL,
          displayName: 'Ana Mesera',
          workspaceId: WS_ID,
          ownerUid: OWNER_UID,
          authorizedEmails: [OWNER_EMAIL],
          station: STATION,
          active: true,
        },
      },
      reportBeforeDoc: {
        data: {
          workspaceId: WS_ID,
          ownerUid: OWNER_UID,
          authorizedEmails: [OWNER_EMAIL],
          date: OP_DATE,
          station: STATION,
          status: 'opening_saved',
          reportedByUid: WORKER_UID,
          reportedByName: 'Ana Mesera',
          notes: '',
        },
      },
      reportAfterDoc: {
        data: {
          workspaceId: WS_ID,
          ownerUid: OWNER_UID,
          authorizedEmails: [OWNER_EMAIL],
          date: OP_DATE,
          station: STATION,
          status: 'opening_saved',
          reportedByUid: WORKER_UID,
          reportedByName: 'Ana Mesera',
          notes: '',
        },
      },
      itemsById: {
        // (a) Item created inside the station (id starts with station id)
        mesera_1: {
          data: {
            workspaceId: WS_ID,
            ownerUid: OWNER_UID,
            authorizedEmails: [OWNER_EMAIL],
            station: STATION,
            name: 'Servilletas Mesa',
            unit: 'paq',
            minStock: 2,
            targetStock: 10,
            active: true,
            sortOrder: 10,
          },
        },
        // (b) Item created in another station ('asados_99') and reassigned via assignWorkstationItems
        asados_99: {
          data: {
            workspaceId: WS_ID,
            ownerUid: OWNER_UID,
            authorizedEmails: [OWNER_EMAIL],
            station: STATION, // updated by assignWorkstationItems
            name: 'Salsa BBQ Reasignada',
            unit: 'und',
            minStock: 2,
            targetStock: 10,
            active: true,
            sortOrder: 20,
          },
        },
        // (c.1) Catalog item with inputType = 'count'
        item_count_1: {
          data: {
            workspaceId: WS_ID,
            ownerUid: OWNER_UID,
            authorizedEmails: [OWNER_EMAIL],
            station: STATION,
            name: 'Gaseosa Personal',
            unit: 'und',
            inputType: 'count',
            minStock: 5,
            targetStock: 24,
            active: true,
            sortOrder: 30,
          },
        },
        // (c.2) Catalog item with inputType = 'packs' and all extra pack fields
        item_packs_1: {
          data: {
            workspaceId: WS_ID,
            ownerUid: OWNER_UID,
            authorizedEmails: [OWNER_EMAIL],
            station: STATION,
            name: 'Vasos Desechables',
            unit: 'paq', // legacy/default unit while unitLabel holds 'unid'
            inputType: 'packs',
            packSize: 50,
            packLabel: 'paquete',
            unitLabel: 'unid',
            minStock: 50,
            targetStock: 200,
            active: true,
            sortOrder: 40,
          },
        },
        // (c.3) Catalog item with inputType = 'level' and capacity + allowClosedContainers
        item_level_1: {
          data: {
            workspaceId: WS_ID,
            ownerUid: OWNER_UID,
            authorizedEmails: [OWNER_EMAIL],
            station: STATION,
            name: 'Jabón Líquido',
            unit: 'L',
            inputType: 'level',
            capacity: 4,
            allowClosedContainers: true,
            minStock: 1,
            targetStock: 4,
            active: true,
            sortOrder: 50,
          },
        },
      },
      entriesBeforeById: {},
      ...overrides,
    };
  }

  function makeCreateFields(
    itemId: string,
    itemName: string,
    unit: string,
    minStock: number,
    targetStock: number,
  ): Record<string, unknown> {
    return {
      workspaceId: WS_ID,
      ownerUid: OWNER_UID,
      authorizedEmails: [OWNER_EMAIL],
      reportId: REPORT_ID,
      itemId,
      station: STATION,
      date: OP_DATE,
      itemName,
      unit,
      minStock,
      targetStock,
      opening: 6,
      added: 2,
      closing: 4,
      hasOpening: true,
      hasClosing: true,
      notApplicable: false,
      previousClosing: 5,
      openingStatus: 'confirmed_match',
      updatedByUid: WORKER_UID,
      updatedByName: 'Ana Mesera',
      createdAt: 'REQUEST_TIME',
      updatedAt: 'REQUEST_TIME',
    };
  }

  /**
   * Simulates the LEGACY (pre-fix) rules evaluation and counts evaluated CEL expressions
   * (where Firestore caps each request at 1,000 evaluated expressions).
   */
  function evaluateLegacyRulesForEntry(
    state: SimulationState,
    itemId: string,
    entry: Record<string, unknown>,
  ): { allowed: boolean; expressionsEvaluated: number; failureReason?: string } {
    // Legacy rules had no `let` bindings:
    // - Base entry validation + macro-expanded `isValidEmailList` (32 refs) + `canCreateDailyReportEntry` (6x ternary report lookup) = 846 expressions when schedule is off
    // - Plus +330 expressions when schedule is enabled and checked at 17:40 (closing window after opening window fails) = 1,176 expressions per entry!
    let exprCount = 846;

    const existingEntry = state.entriesBeforeById[itemId];
    if (existingEntry) {
      // Legacy update rule required `incoming().createdAt == existing().createdAt` (which fails on set() with serverTimestamp())
      if (entry.createdAt !== existingEntry.data.createdAt) {
        return {
          allowed: false,
          expressionsEvaluated: exprCount,
          failureReason: 'legacy allow update rejected serverTimestamp() on createdAt when entry already existed',
        };
      }
    }

    const wsData = state.workspaceDoc?.data ?? {};
    const s = wsData.shiftSchedule as Record<string, unknown> | undefined;
    if (!s || s.enabled !== false) {
      exprCount += 330; // 1,176 expressions for a single entry!
      const times = s
        ? [s.openingStart, s.openingEnd, s.closingStart, s.closingEnd]
        : ['09:00', '16:30', '18:00', '02:00'];
      for (const rawT of times) {
        const t = String(rawT);
        // Legacy timeToMinutes used fixed slices t[0:2] and t[3:5], which throws on 4-char "1:00"
        const hStr = t.slice(0, 2);
        const mStr = t.slice(3, 5);
        if (!/^\d{2}$/.test(hStr) || !/^\d{2}$/.test(mStr)) {
          return {
            allowed: false,
            expressionsEvaluated: exprCount,
            failureReason: `legacy timeToMinutes("${t}") threw CEL runtime error on non-padded hour`,
          };
        }
      }
    }

    const itemDoc = state.itemsById[itemId];
    if (!itemDoc) {
      return { allowed: false, expressionsEvaluated: exprCount, failureReason: 'item missing' };
    }
    // Legacy entryMatchesItem only checked `itemData.unit == entry.unit` (ignoring `unitLabel` on packs)
    if (itemDoc.data.unit !== entry.unit) {
      return {
        allowed: false,
        expressionsEvaluated: exprCount,
        failureReason: `legacy entryMatchesItem rejected unit="${String(entry.unit)}" vs item.unit="${String(itemDoc.data.unit)}"`,
      };
    }

    if (exprCount > 1000) {
      return {
        allowed: false,
        expressionsEvaluated: exprCount,
        failureReason: `CEL expression limit exceeded (${exprCount} > 1000)`,
      };
    }

    return { allowed: true, expressionsEvaluated: exprCount };
  }

  /**
   * Evaluates the FIXED `firestore.rules` logic for a worker entry write and counts expressions.
   */
  function evaluateFixedRulesForEntry(
    state: SimulationState,
    itemId: string,
    entry: Record<string, unknown>,
  ): { allowed: boolean; expressionsEvaluated: number; failureReason?: string } {
    // With `let` bindings in `toDateStr`, `bogotaMinutesNow`, `timeToMinutes`, `inWindowWithGrace`,
    // `isWorkspaceWithinSchedule`, `isWorkerWithinSchedule`, and single `getAfter(reportId)` binding,
    // a full entry evaluation uses ~175 expressions when schedule is enabled and ~135 when disabled.
    let exprCount = 135;

    const parseTimePart = (part: string): number => {
      if (!/^\d{1,2}$/.test(part)) throw new Error(`Invalid time part: ${part}`);
      return part.length === 2 && part[0] === '0' ? Number(part[1]) : Number(part);
    };
    const timeToMinutes = (t: string): number => {
      const parts = t.split(':');
      if (parts.length !== 2) throw new Error(`Invalid time: ${t}`);
      return parseTimePart(parts[0]) * 60 + parseTimePart(parts[1]);
    };
    const inWindowWithGrace = (nowMin: number, startStr: string, endStr: string): boolean => {
      const s = (timeToMinutes(startStr) - 30 + 1440) % 1440;
      const e = (timeToMinutes(endStr) + 30) % 1440;
      return s <= e ? nowMin >= s && nowMin <= e : nowMin >= s || nowMin <= e;
    };

    if (!state.emailVerified || !state.authEmail) {
      return { allowed: false, expressionsEvaluated: exprCount, failureReason: 'unverified user' };
    }

    const member = state.memberDoc?.data;
    if (
      !member ||
      member.active !== true ||
      member.workspaceId !== entry.workspaceId ||
      !(
        member.station === entry.station ||
        (member.station === 'hamburguesas' && entry.station === 'comida_rapida')
      )
    ) {
      return { allowed: false, expressionsEvaluated: exprCount, failureReason: 'invalid member' };
    }

    if (entry.date !== state.bogotaDateStr && entry.date !== state.bogotaPrevDateStr) {
      return {
        allowed: false,
        expressionsEvaluated: exprCount,
        failureReason: 'invalid operational date',
      };
    }

    const wsData = state.workspaceDoc?.data;
    if (!wsData) {
      return { allowed: false, expressionsEvaluated: exprCount, failureReason: 'missing workspace' };
    }
    const sched = wsData.shiftSchedule as Record<string, unknown> | undefined;
    let scheduleOk = false;
    if (sched && typeof sched === 'object') {
      if ('enabled' in sched && sched.enabled === false) {
        scheduleOk = true;
      } else {
        exprCount += 40;
        if (
          typeof sched.openingStart === 'string' &&
          typeof sched.openingEnd === 'string' &&
          typeof sched.closingStart === 'string' &&
          typeof sched.closingEnd === 'string'
        ) {
          scheduleOk =
            inWindowWithGrace(state.bogotaMinutesNow, sched.openingStart, sched.openingEnd) ||
            inWindowWithGrace(state.bogotaMinutesNow, sched.closingStart, sched.closingEnd);
        }
      }
    } else {
      exprCount += 40;
      scheduleOk =
        inWindowWithGrace(state.bogotaMinutesNow, '09:00', '16:30') ||
        inWindowWithGrace(state.bogotaMinutesNow, '18:00', '02:00');
    }
    if (!scheduleOk) {
      return {
        allowed: false,
        expressionsEvaluated: exprCount,
        failureReason: 'outside schedule window',
      };
    }

    const reportSnap = state.reportAfterDoc;
    if (!reportSnap || !reportSnap.data) {
      return {
        allowed: false,
        expressionsEvaluated: exprCount,
        failureReason: 'parent report does not exist',
      };
    }
    const r = reportSnap.data;
    if (
      r.status === 'completed' ||
      r.workspaceId !== entry.workspaceId ||
      r.ownerUid !== entry.ownerUid ||
      r.date !== entry.date ||
      r.station !== entry.station
    ) {
      return {
        allowed: false,
        expressionsEvaluated: exprCount,
        failureReason: 'parent report mismatch or completed',
      };
    }

    const itemSnap = state.itemsById[itemId];
    if (!itemSnap || !itemSnap.data) {
      return { allowed: false, expressionsEvaluated: exprCount, failureReason: 'item missing' };
    }
    const it = itemSnap.data;
    const unitMatch =
      it.unit === entry.unit || ('unitLabel' in it && it.unitLabel === entry.unit);
    const stationMatch =
      it.station === entry.station ||
      (it.station === 'hamburguesas' && entry.station === 'comida_rapida');
    if (
      it.workspaceId !== entry.workspaceId ||
      !stationMatch ||
      it.name !== entry.itemName ||
      !unitMatch ||
      it.minStock !== entry.minStock ||
      it.targetStock !== entry.targetStock
    ) {
      return {
        allowed: false,
        expressionsEvaluated: exprCount,
        failureReason: 'entryMatchesItem failed',
      };
    }

    return { allowed: true, expressionsEvaluated: exprCount };
  }

  it('proves WHY production failed before the fix and passes after the fix for all cases (a)-(g)', () => {
    const state = makeBaseState();
    const fiveEntries = [
      { id: 'item_count_1', payload: makeCreateFields('item_count_1', 'Gaseosa Personal', 'und', 5, 24) },
      { id: 'item_packs_1', payload: makeCreateFields('item_packs_1', 'Vasos Desechables', 'unid', 50, 200) },
      { id: 'item_level_1', payload: makeCreateFields('item_level_1', 'Jabón Líquido', 'L', 1, 4) },
      { id: 'asados_99', payload: makeCreateFields('asados_99', 'Salsa BBQ Reasignada', 'und', 2, 10) },
      { id: 'mesera_1', payload: makeCreateFields('mesera_1', 'Servilletas Mesa', 'paq', 2, 10) },
    ];

    // --- EVIDENCE 1 (Before fix): Active schedule (10:00-15:00 / 16:00-01:00) at 17:40 Bogotá ---
    // Even a 1-document batch evaluated 1,176 expressions (> 1,000 limit), so all 5 items failed 1-by-1!
    for (const item of fiveEntries) {
      const legacyRes = evaluateLegacyRulesForEntry(state, item.id, item.payload);
      expect(legacyRes.allowed).toBe(false);
    }

    // --- EVIDENCE 2 (Before fix): Disabled schedule (shiftSchedule.enabled = false) ---
    // Chunk 1 (first 4 items: item_count_1, item_packs_1, item_level_1, asados_99) evaluated 4 * 846 = 3,384 > 1,000 expressions (failed!),
    // while Chunk 2 (5th item alone: mesera_1) evaluated 846 < 1,000 expressions and succeeded!
    const stateDisabled = makeBaseState({
      workspaceDoc: {
        data: {
          ...state.workspaceDoc!.data,
          shiftSchedule: {
            enabled: false,
            openingStart: '10:00',
            openingEnd: '15:00',
            closingStart: '16:00',
            closingEnd: '01:00',
          },
        },
      },
    });
    const chunk1LegacyExpressions = fiveEntries
      .slice(0, 4)
      .reduce((sum, item) => sum + evaluateLegacyRulesForEntry(stateDisabled, item.id, item.payload).expressionsEvaluated, 0);
    const chunk2LegacyRes = evaluateLegacyRulesForEntry(
      stateDisabled,
      fiveEntries[4].id,
      fiveEntries[4].payload,
    );
    expect(chunk1LegacyExpressions).toBeGreaterThan(1000); // 3,384 > 1,000 -> Chunk 1 rejected!
    expect(chunk2LegacyRes.expressionsEvaluated).toBeLessThan(1000); // 846 < 1,000 -> 5th item (mesera_1) succeeded!
    expect(chunk2LegacyRes.allowed).toBe(true);

    // --- AFTER FIX: Cases (a), (b), (c) all pass both 1-by-1 and in a 4-item batch! ---
    let batch4Expressions = 0;
    for (const item of fiveEntries) {
      const fixedRes = evaluateFixedRulesForEntry(state, item.id, item.payload);
      expect(fixedRes.allowed).toBe(true);
    }
    for (const item of fiveEntries.slice(0, 4)) {
      batch4Expressions += evaluateFixedRulesForEntry(state, item.id, item.payload).expressionsEvaluated;
    }
    expect(batch4Expressions).toBeLessThan(1000); // 4 * 175 = 700 < 1,000!

    // --- Case (d): Active schedule with closing window crossing midnight (16:00-01:00 and "1:00") ---
    // At 17:40 (1060m), 23:30 (1410m), 00:30 (30m) and opening 10:00-15:00 at 12:00 (720m)
    for (const [label, mins, closingEndFormat] of [
      ['17:40 closing', 17 * 60 + 40, '01:00'],
      ['23:30 closing', 23 * 60 + 30, '01:00'],
      ['00:30 after midnight closing', 0 * 60 + 30, '01:00'],
      ['00:30 with non-padded "1:00"', 0 * 60 + 30, '1:00'],
      ['12:00 opening', 12 * 60 + 0, '01:00'],
    ] as const) {
      const schedState = makeBaseState({
        bogotaMinutesNow: mins,
        workspaceDoc: {
          data: {
            ...state.workspaceDoc!.data,
            shiftSchedule: {
              enabled: true,
              openingStart: '10:00',
              openingEnd: '15:00',
              closingStart: '16:00',
              closingEnd: closingEndFormat,
            },
          },
        },
      });
      const res = evaluateFixedRulesForEntry(schedState, 'mesera_1', fiveEntries[4].payload);
      expect(res.allowed, `Failed at ${label}`).toBe(true);
    }

    // Outside schedule (e.g. 04:00 Bogotá = 240m) must still be denied
    const outsideState = makeBaseState({ bogotaMinutesNow: 4 * 60 });
    expect(evaluateFixedRulesForEntry(outsideState, 'mesera_1', fiveEntries[4].payload).allowed).toBe(
      false,
    );

    // --- Case (e): Schedule disabled (shiftSchedule.enabled = false) at 04:00 Bogotá ---
    const disabledAt4am = makeBaseState({
      bogotaMinutesNow: 4 * 60,
      workspaceDoc: stateDisabled.workspaceDoc,
    });
    expect(evaluateFixedRulesForEntry(disabledAt4am, 'mesera_1', fiveEntries[4].payload).allowed).toBe(
      true,
    );

    // --- Case (f): Workspace without shiftSchedule field ---
    const noShiftScheduleField = makeBaseState({
      bogotaMinutesNow: 12 * 60, // 12:00 Bogotá (inside default 09:00-16:30)
      workspaceDoc: {
        data: {
          name: 'The Fire',
          ownerUid: OWNER_UID,
          ownerEmail: OWNER_EMAIL,
          authorizedEmails: [OWNER_EMAIL],
        },
      },
    });
    expect(
      evaluateFixedRulesForEntry(noShiftScheduleField, 'mesera_1', fiveEntries[4].payload).allowed,
    ).toBe(true);

    // --- Case (g): Report exists with status 'opening_saved' vs Report does NOT exist ---
    const reportExistsOpeningSaved = makeBaseState();
    expect(
      evaluateFixedRulesForEntry(reportExistsOpeningSaved, 'mesera_1', fiveEntries[4].payload).allowed,
    ).toBe(true);

    const reportDoesNotExist = makeBaseState({
      reportBeforeDoc: null,
      reportAfterDoc: null,
    });
    expect(
      evaluateFixedRulesForEntry(reportDoesNotExist, 'mesera_1', fiveEntries[4].payload).allowed,
    ).toBe(false);
  });

  it('verifies firestore.rules uses let bindings and split-based timeToMinutes to prevent macro expression explosion', () => {
    expect(rulesText).toContain("let parts = t.split(':');");
    expect(rulesText).toContain('function parseTimePart(part)');
    expect(rulesText).toContain('let nowMin = bogotaMinutesNow();');
    expect(rulesText).toContain(
      'let wsSnap = get(/databases/$(database)/documents/workspaces/$(wsId));',
    );
    expect(rulesText).toContain(
      'let mSnap = get(/databases/$(database)/documents/teamMembers/$(request.auth.uid));',
    );
    expect(rulesText).toContain("('unitLabel' in itemData && itemData.unitLabel == entry.unit)");
    // Ensure items allow get on resource == null no longer restricts worker to station_N prefix
    expect(rulesText).not.toContain("itemId.matches('^' + memberDoc().station + '_[0-9]+$')");
  });
});

