import { describe, expect, it } from 'vitest';
import { MAX_WORKER_NOTE_LENGTH, WORKER_NOTE_SHORTCUTS } from '../../constants';
import {
  applyWorkerNoteShortcut,
  canWorkerModifyNote,
  formatWorkerNoteContextLabel,
  sortWorkerNotesNewestFirst,
  validateWorkerNoteInput,
} from '../workerNotes';

describe('workerNotes.ts (validación, atajos, permisos diarios y formato)', () => {
  it('validates required note text, 200-char limit, and optional numeric quantity', () => {
    expect(validateWorkerNoteInput({ text: '   ' })).toMatchObject({
      valid: false,
      error: 'Escribe una nota antes de guardar.',
    });

    const tooLong = 'a'.repeat(MAX_WORKER_NOTE_LENGTH + 1);
    expect(validateWorkerNoteInput({ text: tooLong }).valid).toBe(false);

    const exactLimit = 'a'.repeat(MAX_WORKER_NOTE_LENGTH);
    expect(validateWorkerNoteInput({ text: exactLimit })).toEqual({
      valid: true,
      text: exactLimit,
      quantity: undefined,
      error: null,
    });

    expect(
      validateWorkerNoteInput({ text: 'Salida del jefe', quantityInput: '2,5' }),
    ).toEqual({
      valid: true,
      text: 'Salida del jefe',
      quantity: 2.5,
      error: null,
    });

    expect(validateWorkerNoteInput({ text: 'Dañado', quantityInput: '-1' }).valid).toBe(false);
    expect(validateWorkerNoteInput({ text: 'Dañado', quantityInput: 'abc' }).valid).toBe(false);
  });

  it('applies optional shortcuts cleanly and switches preset prefix without losing custom detail', () => {
    expect(WORKER_NOTE_SHORTCUTS).toEqual(['Salida del jefe', 'Cortesía', 'Dañado']);

    expect(applyWorkerNoteShortcut('', 'Salida del jefe')).toBe('Salida del jefe');
    expect(applyWorkerNoteShortcut('Salida del jefe', 'Cortesía')).toBe('Cortesía');
    expect(applyWorkerNoteShortcut('2 panes para mesa 4', 'Cortesía')).toBe(
      'Cortesía: 2 panes para mesa 4',
    );
    expect(applyWorkerNoteShortcut('Cortesía: 2 panes para mesa 4', 'Dañado')).toBe(
      'Dañado: 2 panes para mesa 4',
    );
  });

  it('allows workers to edit/delete only their own notes from the same station, workspace, and current operational day', () => {
    const baseNote = {
      authorUid: 'worker_ana',
      date: '2026-11-14',
      station: 'mesera',
      workspaceId: 'ws_1',
    };

    expect(
      canWorkerModifyNote(baseNote, {
        userUid: 'worker_ana',
        operationalDate: '2026-11-14',
        stationId: 'mesera',
        workspaceId: 'ws_1',
      }),
    ).toBe(true);

    // Another worker on the same station
    expect(
      canWorkerModifyNote(baseNote, {
        userUid: 'worker_luis',
        operationalDate: '2026-11-14',
        stationId: 'mesera',
        workspaceId: 'ws_1',
      }),
    ).toBe(false);

    // Previous operational day
    expect(
      canWorkerModifyNote(baseNote, {
        userUid: 'worker_ana',
        operationalDate: '2026-11-15',
        stationId: 'mesera',
        workspaceId: 'ws_1',
      }),
    ).toBe(false);

    // Another station
    expect(
      canWorkerModifyNote(baseNote, {
        userUid: 'worker_ana',
        operationalDate: '2026-11-14',
        stationId: 'asados',
        workspaceId: 'ws_1',
      }),
    ).toBe(false);
  });

  it('formats optional item and quantity context and sorts notes newest first', () => {
    expect(formatWorkerNoteContextLabel({})).toBeNull();
    expect(formatWorkerNoteContextLabel({ itemName: 'Coca-Cola 400ml' })).toBe('Coca-Cola 400ml');
    expect(
      formatWorkerNoteContextLabel({
        itemName: 'Coca-Cola 400ml',
        itemUnit: 'und',
        quantity: 2,
      }),
    ).toBe('Coca-Cola 400ml · 2 und');
    expect(formatWorkerNoteContextLabel({ quantity: 1.5, itemUnit: 'L' })).toBe(
      'Cantidad: 1,5 L',
    );

    const sorted = sortWorkerNotesNewestFirst([
      {
        id: 'n1',
        workspaceId: 'ws_1',
        ownerUid: 'o1',
        authorizedEmails: ['o@e.co'],
        station: 'mesera',
        authorUid: 'w1',
        authorName: 'Ana',
        date: '2026-11-14',
        timeLabel: '14:05:00',
        text: 'Primera',
      },
      {
        id: 'n2',
        workspaceId: 'ws_1',
        ownerUid: 'o1',
        authorizedEmails: ['o@e.co'],
        station: 'mesera',
        authorUid: 'w1',
        authorName: 'Ana',
        date: '2026-11-14',
        timeLabel: '22:10:05',
        text: 'Más reciente',
      },
    ]);
    expect(sorted.map((n) => n.id)).toEqual(['n2', 'n1']);
  });
});
