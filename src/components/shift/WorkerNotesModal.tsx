import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { Check, Clock, Pencil, StickyNote, Trash2, X } from 'lucide-react';
import { MAX_WORKER_NOTE_LENGTH, WORKER_NOTE_SHORTCUTS } from '../../constants';
import {
  createWorkerNote,
  deleteWorkerNote,
  updateWorkerNote,
} from '../../services/workerService';
import type { InventoryItem, WorkerNote, Workspace, Workstation } from '../../types';
import { getOperationalDateStr } from '../../utils/date';
import { formatDateHuman, getEffectiveItemUnit } from '../../utils/inventory';
import {
  applyWorkerNoteShortcut,
  canWorkerModifyNote,
  formatWorkerNoteContextLabel,
  sortWorkerNotesNewestFirst,
  validateWorkerNoteInput,
} from '../../utils/workerNotes';

interface WorkerNotesModalProps {
  open: boolean;
  onClose: () => void;
  workspace: Workspace;
  user: User;
  station: Workstation;
  operationalDate: string;
  stationItems: InventoryItem[];
  notes: WorkerNote[];
}

export function WorkerNotesModal({
  open,
  onClose,
  workspace,
  user,
  station,
  operationalDate,
  stationItems,
  notes,
}: WorkerNotesModalProps) {
  const [text, setText] = useState('');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [quantityInput, setQuantityInput] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const resetForm = () => {
    setText('');
    setSelectedItemId('');
    setQuantityInput('');
    setEditingNoteId(null);
    setFormError(null);
  };

  useEffect(() => {
    if (!open) {
      resetForm();
      setConfirmDeleteId(null);
      setFeedback(null);
    }
  }, [open]);

  const sortedNotes = useMemo(() => sortWorkerNotesNewestFirst(notes), [notes]);
  const liveOperationalDate = getOperationalDateStr();

  const selectedItem = useMemo(
    () => stationItems.find((it) => it.id === selectedItemId),
    [stationItems, selectedItemId],
  );

  if (!open) return null;

  const handleShortcutClick = (shortcut: string) => {
    setText((prev) => applyWorkerNoteShortcut(prev, shortcut));
    setFormError(null);
  };

  const handleStartEdit = (note: WorkerNote) => {
    setEditingNoteId(note.id);
    setText(note.text);
    setSelectedItemId(note.itemId ?? '');
    setQuantityInput(typeof note.quantity === 'number' ? String(note.quantity) : '');
    setConfirmDeleteId(null);
    setFormError(null);
    setFeedback(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFeedback(null);

    const check = validateWorkerNoteInput({ text, quantityInput });
    if (!check.valid) {
      setFormError(check.error ?? 'Revisa el contenido de la nota.');
      return;
    }

    setSaving(true);
    try {
      if (editingNoteId) {
        await updateWorkerNote({
          noteId: editingNoteId,
          text: check.text,
          item: selectedItem,
          quantity: check.quantity,
        });
        setFeedback('Nota actualizada.');
      } else {
        await createWorkerNote({
          workspace,
          user,
          station,
          text: check.text,
          item: selectedItem,
          quantity: check.quantity,
        });
        setFeedback('Nota guardada.');
      }
      resetForm();
    } catch (err) {
      console.error('Error al guardar nota:', err);
      setFormError(
        err instanceof Error && err.message
          ? 'No se pudo guardar la nota. Verifica tu conexión o intenta de nuevo.'
          : 'No se pudo guardar la nota.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async (noteId: string) => {
    setFormError(null);
    setFeedback(null);
    setDeletingId(noteId);
    try {
      await deleteWorkerNote(noteId);
      if (editingNoteId === noteId) {
        resetForm();
      }
      setConfirmDeleteId(null);
      setFeedback('Nota eliminada.');
    } catch (err) {
      console.error('Error al eliminar nota:', err);
      setFormError('No se pudo eliminar la nota. Intenta de nuevo.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worker-notes-title"
    >
      <div
        className="fixed inset-0 bg-stone-950/60 backdrop-blur-xs animate-tf-fade-in"
        onClick={onClose}
      />

      <div className="relative z-10 w-full sm:max-w-lg max-h-[90dvh] bg-white rounded-t-2xl sm:rounded-2xl border border-stone-200 shadow-2xl flex flex-col overflow-hidden animate-tf-fade-up pb-[env(safe-area-inset-bottom)]">
        {/* Sticky Header */}
        <div className="px-4 sm:px-5 py-3.5 border-b border-stone-200 flex items-center justify-between gap-3 shrink-0 bg-white">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-orange-50 border border-orange-200 text-orange-600 flex items-center justify-center shrink-0">
              <StickyNote className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="worker-notes-title"
                className="font-display text-base sm:text-lg font-bold text-stone-900 truncate"
              >
                Mis notas
              </h2>
              <p className="text-xs text-stone-500 truncate">
                {station.name} · {formatDateHuman(operationalDate)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ventana de notas"
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-xl shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-5">
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {/* Optional Quick Shortcuts */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-stone-600">Atajos rápidos (opcional):</p>
              <div className="flex flex-wrap gap-1.5">
                {WORKER_NOTE_SHORTCUTS.map((shortcut) => (
                  <button
                    key={shortcut}
                    type="button"
                    onClick={() => handleShortcutClick(shortcut)}
                    className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-stone-800 bg-stone-100 border border-stone-200 rounded-xl hover:bg-orange-50 hover:border-orange-300 hover:text-orange-800 active:scale-[0.98] transition-colors cursor-pointer"
                  >
                    {shortcut}
                  </button>
                ))}
              </div>
            </div>

            {/* Required Free Text */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="worker-note-text"
                  className="text-xs font-semibold text-stone-800"
                >
                  {editingNoteId ? 'Editando nota' : '¿Qué novedad quieres anotar?'}
                </label>
                <span className="font-mono tabular-nums text-[11px] text-stone-500">
                  {text.length}/{MAX_WORKER_NOTE_LENGTH}
                </span>
              </div>
              <textarea
                id="worker-note-text"
                rows={3}
                maxLength={MAX_WORKER_NOTE_LENGTH}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (formError) setFormError(null);
                }}
                placeholder="Ej: Jefe sacó 2 gaseosas para reunión, o se dañó 1 pan..."
                className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white resize-none"
              />
            </div>

            {/* Optional Item + Optional Quantity */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div className="space-y-1 min-w-0">
                <label
                  htmlFor="worker-note-item"
                  className="block text-xs font-medium text-stone-600"
                >
                  Insumo (opcional)
                </label>
                <select
                  id="worker-note-item"
                  value={selectedItemId}
                  onChange={(e) => setSelectedItemId(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white"
                >
                  <option value="">Sin insumo específico</option>
                  {stationItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name} ({getEffectiveItemUnit(it)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1 min-w-0">
                <label
                  htmlFor="worker-note-qty"
                  className="block text-xs font-medium text-stone-600"
                >
                  Cantidad (opcional)
                  {selectedItem ? ` · ${getEffectiveItemUnit(selectedItem)}` : ''}
                </label>
                <input
                  id="worker-note-qty"
                  type="text"
                  inputMode="decimal"
                  value={quantityInput}
                  onChange={(e) => {
                    setQuantityInput(e.target.value);
                    if (formError) setFormError(null);
                  }}
                  placeholder="Ej: 2"
                  className="w-full min-h-[44px] px-3 py-2 text-base sm:text-sm font-mono tabular-nums bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white"
                />
              </div>
            </div>

            {formError && (
              <p
                role="alert"
                className="text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-xl px-3 py-2"
              >
                {formError}
              </p>
            )}

            {feedback && (
              <p
                role="status"
                className="text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5 shrink-0" />
                {feedback}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 cursor-pointer"
              >
                {saving
                  ? 'Guardando...'
                  : editingNoteId
                    ? 'Guardar cambios'
                    : 'Guardar nota'}
              </button>
              {editingNoteId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="min-h-[46px] px-4 py-2.5 text-sm font-semibold text-stone-700 bg-stone-100 border border-stone-200 rounded-xl hover:bg-stone-200 cursor-pointer"
                >
                  Cancelar
                </button>
              )}
            </div>

            <p className="text-[11px] text-stone-500 leading-relaxed">
              Las notas se muestran al jefe en su reporte y en el CSV. No modifican las cantidades del inventario.
            </p>
          </form>

          {/* Daily Station Notes History */}
          <div className="border-t border-stone-200 pt-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-stone-600">
                Notas de hoy ({sortedNotes.length})
              </h3>
            </div>

            {sortedNotes.length === 0 ? (
              <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 text-center text-xs text-stone-500">
                Aún no has guardado notas hoy para {station.name}.
              </div>
            ) : (
              <div className="space-y-2.5">
                {sortedNotes.map((note) => {
                  const contextLabel = formatWorkerNoteContextLabel(note);
                  const canModify = canWorkerModifyNote(note, {
                    userUid: user.uid,
                    operationalDate: liveOperationalDate,
                    stationId: station.id,
                    workspaceId: workspace.id,
                  });
                  const isConfirmingDelete = confirmDeleteId === note.id;

                  return (
                    <div
                      key={note.id}
                      className={`p-3.5 rounded-xl border space-y-2 ${
                        editingNoteId === note.id
                          ? 'bg-orange-50/60 border-orange-300'
                          : 'bg-stone-50 border-stone-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-xs text-stone-500 font-mono tabular-nums">
                          <Clock className="w-3.5 h-3.5 text-stone-400 shrink-0" />
                          <span>{note.timeLabel}</span>
                          <span>·</span>
                          <span className="font-sans font-medium text-stone-700 truncate">
                            {note.authorName}
                          </span>
                        </div>
                        {contextLabel && (
                          <span className="text-[11px] font-semibold text-orange-800 bg-orange-50 border border-orange-200 rounded-lg px-2 py-0.5 max-w-[55%] truncate">
                            {contextLabel}
                          </span>
                        )}
                      </div>

                      <p className="text-sm text-stone-900 leading-relaxed break-words">
                        {note.text}
                      </p>

                      {canModify && (
                        <div className="pt-1 flex flex-wrap items-center justify-end gap-1.5">
                          {isConfirmingDelete ? (
                            <>
                              <span className="text-xs font-medium text-red-800 mr-auto">
                                ¿Eliminar esta nota?
                              </span>
                              <button
                                type="button"
                                disabled={deletingId === note.id}
                                onClick={() => handleConfirmDelete(note.id)}
                                className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                              >
                                {deletingId === note.id ? 'Borrando...' : 'Sí, borrar'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-stone-700 bg-white border border-stone-200 rounded-lg hover:bg-stone-100 cursor-pointer"
                              >
                                Cancelar
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => handleStartEdit(note)}
                                className="min-h-[38px] inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-stone-700 bg-white border border-stone-200 rounded-lg hover:bg-stone-100 cursor-pointer"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                                Editar
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(note.id)}
                                className="min-h-[38px] inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Borrar
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
