import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

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
    description: 'Unverified email spoofing admin workspace creation',
    collectionPath: 'workspaces/restaurante_principal',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-02',
    description: 'Shadow field injection (ghost key isVerified) on items create',
    collectionPath: 'items/mesera_99',
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
    description: 'Cross-station report write by mesera into asados',
    collectionPath: 'dailyReports/restaurante_principal_2026-11-13_asados',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-05',
    description: 'Orphaned entry injection without parent dailyReport',
    collectionPath: 'dailyReports/nonexistent_report/entries/mesera_1',
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
    collectionPath: 'dailyReports/restaurante_principal_2026-11-13_mesera/entries/mesera_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-08',
    description: 'Client timestamp forgery bypassing request.time',
    collectionPath: 'items/mesera_forged',
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
    collectionPath: 'items/mesera_1',
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

let testEnv: RulesTestEnvironment;

const WS_ID = 'restaurante_principal';
const OWNER_UID = 'boss_uid';
const OWNER_EMAIL = 'jefe@thefire.co';
const WORKER_UID = 'worker_mesera_uid';
const WORKER_EMAIL = 'mesera@thefire.co';
const ATTACKER_UID = 'attacker_uid';

function getBogotaDateForNow(): string {
  const shifted = new Date(Date.now() - 11 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

describe('Firestore Security Rules (Emulator Suite)', () => {
  beforeAll(async () => {
    const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8');
    testEnv = await initializeTestEnvironment({
      projectId: 'thefire-rules-test',
      firestore: { rules },
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const opDate = getBogotaDateForNow();
      const nowTs = Timestamp.now();

      await setDoc(doc(db, 'admins', OWNER_UID), { uid: OWNER_UID });

      await setDoc(doc(db, 'workspaces', WS_ID), {
        name: 'The Fire',
        ownerUid: OWNER_UID,
        ownerEmail: OWNER_EMAIL,
        ownerName: 'Jefe',
        authorizedEmails: [OWNER_EMAIL],
        shiftSchedule: {
          enabled: false, // Enabled/disabled tested explicitly below
          openingStart: '16:00',
          openingEnd: '18:00',
          closingStart: '23:00',
          closingEnd: '02:00',
        },
        seeded: true,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      await setDoc(doc(db, 'stations', 'mesera'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        name: 'Mesera',
        area: 'Barra',
        workerName: 'Ana',
        description: 'Bebidas',
        accessCode: 'tf_validcode12345678',
        nextItemSlot: 2,
        active: true,
        sortOrder: 0,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      await setDoc(doc(db, 'stations', 'asados'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        name: 'Asados',
        area: 'Parrilla',
        workerName: 'Carlos',
        description: 'Carnes',
        accessCode: 'tf_asadoscode123456',
        nextItemSlot: 2,
        active: true,
        sortOrder: 1,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      await setDoc(doc(db, 'stationLinks', 'tf_validcode12345678'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        stationId: 'mesera',
        stationName: 'Mesera',
        workerName: 'Ana',
        active: true,
        createdAt: nowTs,
      });

      await setDoc(doc(db, 'items', 'mesera_1'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'mesera',
        name: 'Coca-Cola 400ml',
        unit: 'und',
        minStock: 10,
        targetStock: 30,
        active: true,
        sortOrder: 1,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      await setDoc(doc(db, 'items', 'asados_1'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'asados',
        name: 'Churrasco',
        unit: 'porción',
        minStock: 8,
        targetStock: 24,
        active: true,
        sortOrder: 1,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      await setDoc(doc(db, 'teamMembers', WORKER_UID), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        uid: WORKER_UID,
        email: WORKER_EMAIL,
        displayName: 'Ana',
        station: 'mesera',
        inviteId: 'tf_validcode12345678',
        active: true,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      const reportId = `${WS_ID}_${opDate}_mesera`;
      await setDoc(doc(db, 'dailyReports', reportId), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        date: opDate,
        station: 'mesera',
        status: 'completed',
        reportedByUid: WORKER_UID,
        reportedByName: 'Ana',
        notes: '',
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      await setDoc(doc(db, 'dailyReports', reportId, 'entries', 'mesera_1'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        reportId,
        itemId: 'mesera_1',
        station: 'mesera',
        date: opDate,
        itemName: 'Coca-Cola 400ml',
        unit: 'und',
        minStock: 10,
        targetStock: 30,
        opening: 20,
        added: 0,
        closing: 5,
        hasOpening: true,
        hasClosing: true,
        notApplicable: false,
        updatedByUid: WORKER_UID,
        updatedByName: 'Ana',
        createdAt: nowTs,
        updatedAt: nowTs,
      });
    });
  });

  it('DD-01 to DD-03: blocks spoofed admin workspace, shadow fields, and worker role escalation', async () => {
    const unverifiedCtx = testEnv.authenticatedContext(ATTACKER_UID, {
      email: OWNER_EMAIL,
      email_verified: false,
    });
    await assertFails(
      setDoc(doc(unverifiedCtx.firestore(), 'workspaces', 'ws_attacker'), {
        name: 'Fake',
        ownerUid: ATTACKER_UID,
        ownerEmail: OWNER_EMAIL,
        authorizedEmails: [OWNER_EMAIL],
        seeded: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    const bossDb = testEnv
      .authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true })
      .firestore();
    await assertFails(
      setDoc(doc(bossDb, 'items', 'mesera_99'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'mesera',
        name: 'Ghost',
        unit: 'und',
        minStock: 1,
        targetStock: 5,
        active: true,
        sortOrder: 99,
        isVerified: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    const attackerDb = testEnv
      .authenticatedContext(ATTACKER_UID, { email: 'evil@thefire.co', email_verified: true })
      .firestore();
    await assertFails(
      setDoc(doc(attackerDb, 'teamMembers', ATTACKER_UID), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        uid: ATTACKER_UID,
        email: 'evil@thefire.co',
        displayName: 'Evil',
        station: 'jefe',
        inviteId: 'fake_invite',
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DD-04 to DD-08: blocks cross-station writes, orphaned entries, ID poisoning, negatives, and forged timestamps', async () => {
    const opDate = getBogotaDateForNow();
    const workerDb = testEnv
      .authenticatedContext(WORKER_UID, { email: WORKER_EMAIL, email_verified: true })
      .firestore();

    // Cross-station write
    await assertFails(
      setDoc(doc(workerDb, 'dailyReports', `${WS_ID}_${opDate}_asados`), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        date: opDate,
        station: 'asados',
        status: 'opening_saved',
        reportedByUid: WORKER_UID,
        reportedByName: 'Ana',
        notes: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    // Orphan entry without parent
    await assertFails(
      setDoc(doc(workerDb, 'dailyReports', 'nonexistent_report', 'entries', 'mesera_1'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        reportId: 'nonexistent_report',
        itemId: 'mesera_1',
        station: 'mesera',
        date: opDate,
        itemName: 'Coca-Cola 400ml',
        unit: 'und',
        minStock: 10,
        targetStock: 30,
        opening: 10,
        added: 0,
        closing: 5,
        hasOpening: true,
        hasClosing: true,
        updatedByUid: WORKER_UID,
        updatedByName: 'Ana',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    // Invalid ID & forged timestamp by boss
    const bossDb = testEnv
      .authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true })
      .firestore();
    await assertFails(
      setDoc(doc(bossDb, 'items', 'invalid$id!'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'mesera',
        name: 'Bad',
        unit: 'und',
        minStock: 1,
        targetStock: 2,
        active: true,
        sortOrder: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      setDoc(doc(bossDb, 'items', 'mesera_forged'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'mesera',
        name: 'Forged',
        unit: 'und',
        minStock: 1,
        targetStock: 2,
        active: true,
        sortOrder: 2,
        createdAt: Timestamp.fromMillis(1000000),
        updatedAt: serverTimestamp(),
      }),
    );

    // Negative stock value on entry
    await assertFails(
      updateDoc(doc(workerDb, 'dailyReports', `${WS_ID}_${opDate}_mesera`, 'entries', 'mesera_1'), {
        closing: -1,
        updatedByUid: WORKER_UID,
        updatedByName: 'Ana',
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DD-09 to DD-12: enforces completed lock, worker isolation, catalog immutability, and owner immutability', async () => {
    const opDate = getBogotaDateForNow();
    const workerDb = testEnv
      .authenticatedContext(WORKER_UID, { email: WORKER_EMAIL, email_verified: true })
      .firestore();
    const bossDb = testEnv
      .authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true })
      .firestore();
    const attackerDb = testEnv
      .authenticatedContext(ATTACKER_UID, { email: 'evil@thefire.co', email_verified: true })
      .firestore();

    // DD-09: worker cannot update completed report or create entry inside completed report
    await assertFails(
      updateDoc(doc(workerDb, 'dailyReports', `${WS_ID}_${opDate}_mesera`), {
        status: 'opening_saved',
        reportedByUid: WORKER_UID,
        reportedByName: 'Ana',
        notes: 'reopen',
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      setDoc(doc(workerDb, 'dailyReports', `${WS_ID}_${opDate}_mesera`, 'entries', 'mesera_2'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        reportId: `${WS_ID}_${opDate}_mesera`,
        itemId: 'mesera_2',
        station: 'mesera',
        date: opDate,
        itemName: 'Agua',
        unit: 'und',
        minStock: 5,
        targetStock: 10,
        opening: 5,
        added: 0,
        closing: 5,
        hasOpening: true,
        hasClosing: true,
        updatedByUid: WORKER_UID,
        updatedByName: 'Ana',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    // Worker cannot read another station's items or switch station via QR update
    await assertSucceeds(getDoc(doc(workerDb, 'items', 'mesera_1')));
    await assertFails(getDoc(doc(workerDb, 'items', 'asados_1')));
    await assertFails(
      updateDoc(doc(workerDb, 'teamMembers', WORKER_UID), {
        station: 'asados',
        updatedAt: serverTimestamp(),
      }),
    );

    // DD-10: worker cannot mutate items catalog
    await assertFails(
      updateDoc(doc(workerDb, 'items', 'mesera_1'), {
        minStock: 0,
        updatedAt: serverTimestamp(),
      }),
    );

    // DD-11: external attacker cannot list items
    await assertFails(
      getDocs(query(collection(attackerDb, 'items'), where('workspaceId', '==', WS_ID))),
    );

    // DD-12: ownerUid cannot be reassigned
    await assertFails(
      updateDoc(doc(bossDb, 'workspaces', WS_ID), {
        ownerUid: ATTACKER_UID,
        updatedAt: serverTimestamp(),
      }),
    );

    // Opening audit metadata on an open report: valid values succeed, tampered/invalid values fail
    await assertSucceeds(
      updateDoc(doc(bossDb, 'dailyReports', `${WS_ID}_${opDate}_mesera`), {
        status: 'opening_saved',
        reportedByUid: OWNER_UID,
        reportedByName: 'Jefe',
        notes: 'reabierto',
        updatedAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(
      updateDoc(doc(workerDb, 'dailyReports', `${WS_ID}_${opDate}_mesera`, 'entries', 'mesera_1'), {
        opening: 5,
        hasOpening: true,
        previousClosing: 5,
        openingStatus: 'confirmed_match',
        updatedByUid: WORKER_UID,
        updatedByName: 'Ana',
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(workerDb, 'dailyReports', `${WS_ID}_${opDate}_mesera`, 'entries', 'mesera_1'), {
        openingStatus: 'hacked',
        updatedByUid: WORKER_UID,
        updatedByName: 'Ana',
        updatedAt: serverTimestamp(),
      }),
    );
  });
});
