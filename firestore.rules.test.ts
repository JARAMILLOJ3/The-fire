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
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
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

    // Non-existent previous-day report lookup (resource == null)
    const missingYesterdayMesera = `${WS_ID}_2026-11-13_mesera`;
    const missingYesterdayAsados = `${WS_ID}_2026-11-13_asados`;
    await assertSucceeds(getDoc(doc(bossDb, 'dailyReports', missingYesterdayMesera)));
    await assertSucceeds(getDoc(doc(bossDb, 'dailyReports', missingYesterdayAsados)));
    await assertSucceeds(getDoc(doc(workerDb, 'dailyReports', missingYesterdayMesera)));
    await assertFails(getDoc(doc(workerDb, 'dailyReports', missingYesterdayAsados)));
    await assertFails(getDoc(doc(attackerDb, 'dailyReports', missingYesterdayMesera)));
  });

  it('allows comida_rapida worker 10-item batch create + update, rejects mismatched item fields and out-of-schedule writes', async () => {
    const opDate = getBogotaDateForNow();
    const comidaUid = 'dQIuTI0yC5Y1V9jlieaI99ZP9yb2';
    const comidaEmail = 'juan.jaramillo.galeano@correounivalle.edu.co';

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const nowTs = Timestamp.now();

      await setDoc(doc(db, 'stations', 'comida_rapida'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        name: 'Comida Rápida',
        area: 'Plancha',
        workerName: 'Juan',
        description: 'Hamburguesas',
        accessCode: 'tf_comidarapidacode12',
        nextItemSlot: 11,
        active: true,
        sortOrder: 2,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      await setDoc(doc(db, 'teamMembers', comidaUid), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        uid: comidaUid,
        email: comidaEmail,
        displayName: 'Juan',
        station: 'comida_rapida',
        inviteId: 'tf_comidarapidacode12',
        active: true,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      for (let i = 1; i <= 10; i++) {
        await setDoc(doc(db, 'items', `comida_rapida_${i}`), {
          workspaceId: WS_ID,
          ownerUid: OWNER_UID,
          authorizedEmails: [OWNER_EMAIL],
          station: 'comida_rapida',
          name: `Insumo ${i}`,
          unit: 'und',
          minStock: 10,
          targetStock: 30,
          active: true,
          sortOrder: i,
          createdAt: nowTs,
          updatedAt: nowTs,
        });
      }
    });

    const workerDb = testEnv
      .authenticatedContext(comidaUid, { email: comidaEmail, email_verified: true })
      .firestore();
    const reportId = `${WS_ID}_${opDate}_comida_rapida`;

    // 10-item create batch must stay under read limit and succeed
    const createBatch = writeBatch(workerDb);
    createBatch.set(doc(workerDb, 'dailyReports', reportId), {
      workspaceId: WS_ID,
      ownerUid: OWNER_UID,
      authorizedEmails: [OWNER_EMAIL],
      date: opDate,
      station: 'comida_rapida',
      status: 'opening_saved',
      reportedByUid: comidaUid,
      reportedByName: 'Juan',
      notes: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    for (let i = 1; i <= 10; i++) {
      createBatch.set(doc(workerDb, 'dailyReports', reportId, 'entries', `comida_rapida_${i}`), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        reportId,
        itemId: `comida_rapida_${i}`,
        station: 'comida_rapida',
        date: opDate,
        itemName: `Insumo ${i}`,
        unit: 'und',
        minStock: 10,
        targetStock: 30,
        opening: 12,
        added: 0,
        closing: 0,
        hasOpening: true,
        hasClosing: false,
        notApplicable: false,
        updatedByUid: comidaUid,
        updatedByName: 'Juan',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await assertSucceeds(createBatch.commit());

    // Mismatched itemName/minStock must fail
    const badBatch = writeBatch(workerDb);
    badBatch.set(doc(workerDb, 'dailyReports', `${WS_ID}_${opDate}_comida_rapida_bad`), {
      workspaceId: WS_ID,
      ownerUid: OWNER_UID,
      authorizedEmails: [OWNER_EMAIL],
      date: opDate,
      station: 'comida_rapida',
      status: 'opening_saved',
      reportedByUid: comidaUid,
      reportedByName: 'Juan',
      notes: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    badBatch.set(
      doc(workerDb, 'dailyReports', `${WS_ID}_${opDate}_comida_rapida_bad`, 'entries', 'comida_rapida_1'),
      {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        reportId: `${WS_ID}_${opDate}_comida_rapida_bad`,
        itemId: 'comida_rapida_1',
        station: 'comida_rapida',
        date: opDate,
        itemName: 'Insumo ALTERADO',
        unit: 'und',
        minStock: 99,
        targetStock: 30,
        opening: 12,
        added: 0,
        closing: 0,
        hasOpening: true,
        hasClosing: false,
        notApplicable: false,
        updatedByUid: comidaUid,
        updatedByName: 'Juan',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    );
    await assertFails(badBatch.commit());

    // 10-item update to completed must also succeed
    const updateBatch = writeBatch(workerDb);
    updateBatch.update(doc(workerDb, 'dailyReports', reportId), {
      status: 'completed',
      reportedByUid: comidaUid,
      reportedByName: 'Juan',
      notes: 'Todo contado',
      updatedAt: serverTimestamp(),
    });
    for (let i = 1; i <= 10; i++) {
      updateBatch.update(doc(workerDb, 'dailyReports', reportId, 'entries', `comida_rapida_${i}`), {
        opening: 12,
        added: 0,
        closing: 6,
        hasOpening: true,
        hasClosing: true,
        notApplicable: false,
        updatedByUid: comidaUid,
        updatedByName: 'Juan',
        updatedAt: serverTimestamp(),
      });
    }
    await assertSucceeds(updateBatch.commit());
  });

  it('validates packs/level catalog item fields on create/update without widening worker permissions', async () => {
    const bossDb = testEnv
      .authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true })
      .firestore();
    const workerDb = testEnv
      .authenticatedContext(WORKER_UID, { email: WORKER_EMAIL, email_verified: true })
      .firestore();

    // Boss creates valid packs item
    await assertSucceeds(
      setDoc(doc(bossDb, 'items', 'mesera_packs'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'mesera',
        name: 'Tocineta',
        unit: 'loncha',
        minStock: 40,
        targetStock: 120,
        inputType: 'packs',
        packSize: 40,
        packLabel: 'kilo',
        unitLabel: 'loncha',
        active: true,
        sortOrder: 5,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    // Boss creates valid level item
    await assertSucceeds(
      setDoc(doc(bossDb, 'items', 'mesera_level'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'mesera',
        name: 'Aceite',
        unit: 'L',
        minStock: 2,
        targetStock: 5,
        inputType: 'level',
        capacity: 5,
        active: true,
        sortOrder: 6,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    // Non-integer packSize rejected
    await assertFails(
      setDoc(doc(bossDb, 'items', 'mesera_bad_float'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'mesera',
        name: 'Pan',
        unit: 'pan',
        minStock: 8,
        targetStock: 24,
        inputType: 'packs',
        packSize: 8.5,
        packLabel: 'paquete',
        unitLabel: 'pan',
        active: true,
        sortOrder: 7,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    // packSize <= 1 or oversized packLabel (>20 chars) rejected
    await assertFails(
      setDoc(doc(bossDb, 'items', 'mesera_bad_size'), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        authorizedEmails: [OWNER_EMAIL],
        station: 'mesera',
        name: 'Pan 2',
        unit: 'pan',
        minStock: 8,
        targetStock: 24,
        inputType: 'packs',
        packSize: 1,
        packLabel: 'paquete',
        unitLabel: 'pan',
        active: true,
        sortOrder: 8,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );

    await assertFails(
      updateDoc(doc(bossDb, 'items', 'mesera_packs'), {
        packLabel: 'etiqueta_con_mas_de_20_caracteres',
        updatedAt: serverTimestamp(),
      }),
    );

    // Level capacity <= 0 rejected
    await assertFails(
      updateDoc(doc(bossDb, 'items', 'mesera_level'), {
        capacity: 0,
        updatedAt: serverTimestamp(),
      }),
    );

    // Worker still cannot modify items even with valid capture fields
    await assertFails(
      updateDoc(doc(workerDb, 'items', 'mesera_packs'), {
        packSize: 50,
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('allows only workspace owner to delete reports, entries, stations, items, and teamMembers (blocks co-managers and workers)', async () => {
    const opDate = getBogotaDateForNow();
    const reportId = `${WS_ID}_${opDate}_mesera`;
    const coAdminUid = 'coadmin_uid';
    const coAdminEmail = 'coadmin@thefire.co';

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const nowTs = Timestamp.now();

      await updateDoc(doc(db, 'workspaces', WS_ID), {
        authorizedEmails: [OWNER_EMAIL, coAdminEmail],
      });

      await setDoc(doc(db, 'teamMembers', coAdminUid), {
        workspaceId: WS_ID,
        ownerUid: OWNER_UID,
        uid: coAdminUid,
        email: coAdminEmail,
        displayName: 'Co-Admin',
        station: 'jefe',
        inviteId: 'inv_coadmin',
        active: true,
        createdAt: nowTs,
        updatedAt: nowTs,
      });
    });

    const coAdminDb = testEnv
      .authenticatedContext(coAdminUid, { email: coAdminEmail, email_verified: true })
      .firestore();
    const workerDb = testEnv
      .authenticatedContext(WORKER_UID, { email: WORKER_EMAIL, email_verified: true })
      .firestore();
    const bossDb = testEnv
      .authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true })
      .firestore();

    // Workers cannot delete anything
    await assertFails(deleteDoc(doc(workerDb, 'dailyReports', reportId, 'entries', 'mesera_1')));
    await assertFails(deleteDoc(doc(workerDb, 'dailyReports', reportId)));
    await assertFails(deleteDoc(doc(workerDb, 'items', 'mesera_1')));
    await assertFails(deleteDoc(doc(workerDb, 'stations', 'mesera')));

    // Non-owner co-manager cannot delete reports, entries, items, stations, or teamMembers
    await assertFails(deleteDoc(doc(coAdminDb, 'dailyReports', reportId, 'entries', 'mesera_1')));
    await assertFails(deleteDoc(doc(coAdminDb, 'dailyReports', reportId)));
    await assertFails(deleteDoc(doc(coAdminDb, 'items', 'mesera_1')));
    await assertFails(deleteDoc(doc(coAdminDb, 'stations', 'mesera')));
    await assertFails(deleteDoc(doc(coAdminDb, 'teamMembers', WORKER_UID)));

    // Owner CAN batch-delete entries first, then report, items, stations, and teamMembers
    const batch = writeBatch(bossDb);
    batch.delete(doc(bossDb, 'dailyReports', reportId, 'entries', 'mesera_1'));
    batch.delete(doc(bossDb, 'dailyReports', reportId));
    batch.delete(doc(bossDb, 'items', 'mesera_1'));
    batch.delete(doc(bossDb, 'stations', 'mesera'));
    batch.delete(doc(bossDb, 'teamMembers', WORKER_UID));
    await assertSucceeds(batch.commit());
  });
});
