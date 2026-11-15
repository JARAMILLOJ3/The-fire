import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import {
  collectWorkspaceResetTasks,
  fetchWorkspaceBackupData,
  runWorkspaceResetTasks,
} from '../services/inventoryService';
import type { Workspace } from '../types';
import {
  countResetTasksByCategory,
  downloadRestaurantBackupCsv,
  isResetConfirmationValid,
  PartialResetError,
  RESET_CATEGORY_LABELS,
  RESET_CATEGORY_ORDER,
  RESET_CONFIRMATION_WORD,
  type ResetExecutionProgress,
  type ResetScope,
  type ResetTaskItem,
  type ResetTargetCategory,
} from '../utils/reset';

interface RestaurantResetModalProps {
  open: boolean;
  workspace: Workspace;
  callerUid: string;
  todayStr: string;
  onClose: () => void;
  onResetComplete: (scope: ResetScope) => void;
}

type ModalPhase = 'configure' | 'collecting' | 'running' | 'partial_error' | 'done';

export function RestaurantResetModal({
  open,
  workspace,
  callerUid,
  todayStr,
  onClose,
  onResetComplete,
}: RestaurantResetModalProps) {
  const [phase, setPhase] = useState<ModalPhase>('configure');
  const [scope, setScope] = useState<ResetScope>('reports_only');
  const [confirmText, setConfirmText] = useState('');

  const [backupLoading, setBackupLoading] = useState(false);
  const [backupInfo, setBackupInfo] = useState<{
    stationsCount: number;
    itemsCount: number;
    reportsCount: number;
  } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const [progress, setProgress] = useState<ResetExecutionProgress>({
    totalCount: 0,
    deletedCount: 0,
    completedBatches: 0,
    totalBatches: 0,
    currentCategory: null,
    currentStepLabel: '',
  });

  const [initialTotalCount, setInitialTotalCount] = useState(0);
  const [alreadyDeletedBeforeRetry, setAlreadyDeletedBeforeRetry] = useState(0);
  const [pendingTasks, setPendingTasks] = useState<ResetTaskItem[]>([]);
  const [pendingByCategory, setPendingByCategory] = useState<
    Record<ResetTargetCategory, number> | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('configure');
    setScope('reports_only');
    setConfirmText('');
    setBackupLoading(false);
    setBackupInfo(null);
    setBackupError(null);
    setInitialTotalCount(0);
    setAlreadyDeletedBeforeRetry(0);
    setPendingTasks([]);
    setPendingByCategory(null);
    setErrorMessage(null);
    setProgress({
      totalCount: 0,
      deletedCount: 0,
      completedBatches: 0,
      totalBatches: 0,
      currentCategory: null,
      currentStepLabel: '',
    });
  }, [open]);

  const isBusy = phase === 'collecting' || phase === 'running';
  const confirmationReady = isResetConfirmationValid(confirmText);
  const isOwner = workspace.ownerUid === callerUid;

  const handleDownloadBackup = async () => {
    if (!isOwner) {
      setBackupError('Solo el dueño del restaurante puede descargar el respaldo completo.');
      return;
    }
    setBackupLoading(true);
    setBackupError(null);
    try {
      const payload = await fetchWorkspaceBackupData(workspace, callerUid);
      downloadRestaurantBackupCsv(payload, todayStr);
      setBackupInfo({
        stationsCount: payload.stations.length,
        itemsCount: payload.items.length,
        reportsCount: payload.reports.length,
      });
    } catch (err) {
      console.error('Error descargando respaldo CSV:', err);
      setBackupError(
        'No se pudo descargar el respaldo completo desde el servidor. Revisa tu conexión e intenta de nuevo.',
      );
    } finally {
      setBackupLoading(false);
    }
  };

  const executeTasks = async (tasksToRun: ResetTaskItem[], baseDeleted: number, grandTotal: number) => {
    setPhase('running');
    setErrorMessage(null);
    try {
      await runWorkspaceResetTasks({
        workspace,
        callerUid,
        scope,
        tasks: tasksToRun,
        onProgress: (step) => {
          setProgress({
            ...step,
            totalCount: grandTotal,
            deletedCount: baseDeleted + step.deletedCount,
          });
        },
      });
      setPendingTasks([]);
      setPendingByCategory(null);
      setPhase('done');
    } catch (err) {
      if (err instanceof PartialResetError) {
        const nextBase = baseDeleted + err.deletedCount;
        setAlreadyDeletedBeforeRetry(nextBase);
        setPendingTasks(err.pendingTasks);
        setPendingByCategory(err.pendingByCategory);
        setErrorMessage(err.message);
        setProgress((prev) => ({
          ...prev,
          totalCount: grandTotal,
          deletedCount: nextBase,
        }));
        setPhase('partial_error');
      } else {
        const fallbackRemaining = tasksToRun;
        setPendingTasks(fallbackRemaining);
        setPendingByCategory(countResetTasksByCategory(fallbackRemaining));
        setErrorMessage(
          err instanceof Error && err.message
            ? err.message
            : 'No se pudo completar el reinicio. Puedes reintentar los pendientes.',
        );
        setPhase('partial_error');
      }
    }
  };

  const handleStartReset = async () => {
    if (!isOwner || !confirmationReady) return;
    setPhase('collecting');
    setErrorMessage(null);
    try {
      const tasks = await collectWorkspaceResetTasks(workspace, scope, callerUid);
      setInitialTotalCount(tasks.length);
      setAlreadyDeletedBeforeRetry(0);
      setPendingTasks(tasks);
      await executeTasks(tasks, 0, tasks.length);
    } catch (err) {
      setErrorMessage(
        err instanceof Error && err.message
          ? err.message
          : 'No se pudo preparar la lista de datos a eliminar. Revisa tu conexión e intenta de nuevo.',
      );
      setPhase('configure');
    }
  };

  const handleRetryPending = async () => {
    if (!isOwner || pendingTasks.length === 0) return;
    await executeTasks(
      pendingTasks,
      alreadyDeletedBeforeRetry,
      initialTotalCount || alreadyDeletedBeforeRetry + pendingTasks.length,
    );
  };

  const handleFinishClose = () => {
    if (isBusy) return;
    if (phase === 'done') {
      onResetComplete(scope);
    }
    onClose();
  };

  const percent =
    progress.totalCount > 0
      ? Math.min(100, Math.round((progress.deletedCount / progress.totalCount) * 100))
      : 100;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-modal-title"
            className="bg-white border border-red-200 rounded-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-5 sm:p-6 space-y-5 shadow-2xl my-6"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="p-2 rounded-xl bg-red-50 text-red-700 border border-red-200 shrink-0">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-red-700">
                    Zona de peligro · Solo dueño
                  </p>
                  <h2
                    id="reset-modal-title"
                    className="font-display text-lg font-bold text-stone-900"
                  >
                    Reiniciar datos del restaurante
                  </h2>
                </div>
              </div>
              {!isBusy && (
                <button
                  type="button"
                  onClick={handleFinishClose}
                  aria-label="Cerrar ventana"
                  className="p-1.5 text-stone-400 hover:text-stone-700 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {!isOwner ? (
              <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-800">
                Solo el propietario principal del restaurante ({workspace.ownerEmail}) puede reiniciar los datos.
              </div>
            ) : phase === 'configure' ? (
              <div className="space-y-5">
                {errorMessage && (
                  <div
                    role="alert"
                    className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800"
                  >
                    {errorMessage}
                  </div>
                )}

                {/* Step 1: CSV Backup */}
                <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-bold text-stone-900">
                        1. Descarga un respaldo antes de borrar
                      </p>
                      <p className="text-xs text-stone-600 mt-0.5">
                        Exporta un CSV con todos tus puestos, insumos (activos y archivados) e historial completo de reportes.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleDownloadBackup}
                    disabled={backupLoading}
                    className="min-h-[40px] w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-semibold text-stone-900 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 disabled:opacity-60 transition-colors cursor-pointer"
                  >
                    {backupLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4 text-orange-600" />
                    )}
                    {backupLoading ? 'Preparando respaldo CSV...' : 'Descargar respaldo CSV completo'}
                  </button>
                  {backupInfo && (
                    <p className="text-xs font-medium text-emerald-700 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Respaldo descargado ({backupInfo.stationsCount} puestos,{' '}
                        {backupInfo.itemsCount} insumos, {backupInfo.reportsCount} reportes).
                      </span>
                    </p>
                  )}
                  {backupError && <p className="text-xs text-red-700">{backupError}</p>}
                </div>

                {/* Step 2: Scope Choice */}
                <div className="space-y-2">
                  <p className="text-xs font-bold text-stone-900">2. Elige qué deseas borrar</p>

                  <label
                    className={`block p-3.5 rounded-xl border transition-colors cursor-pointer ${
                      scope === 'reports_only'
                        ? 'border-red-500 bg-red-50/50'
                        : 'border-stone-200 bg-white hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="radio"
                        name="reset-scope"
                        value="reports_only"
                        checked={scope === 'reports_only'}
                        onChange={() => setScope('reports_only')}
                        className="mt-1 accent-red-600"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-stone-900">
                          Solo historial de reportes y alertas
                        </p>
                        <p className="text-xs text-stone-600 mt-0.5 leading-relaxed">
                          Borra todos los reportes diarios, conteos, notas y alertas pasadas. Conserva intactos tus puestos de trabajo, códigos QR, equipo e insumos del catálogo.
                        </p>
                      </div>
                    </div>
                  </label>

                  <label
                    className={`block p-3.5 rounded-xl border transition-colors cursor-pointer ${
                      scope === 'all'
                        ? 'border-red-500 bg-red-50/50'
                        : 'border-stone-200 bg-white hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="radio"
                        name="reset-scope"
                        value="all"
                        checked={scope === 'all'}
                        onChange={() => setScope('all')}
                        className="mt-1 accent-red-600"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-stone-900">
                          Todo — dejar el restaurante vacío
                        </p>
                        <p className="text-xs text-stone-600 mt-0.5 leading-relaxed">
                          Borra reportes, alertas, insumos, puestos de trabajo, códigos QR e invitaciones/accesos de trabajadoras. El panel quedará vacío, sin datos de ejemplo.
                        </p>
                      </div>
                    </div>
                  </label>
                </div>

                {/* Step 3: Confirmation Word */}
                <div className="p-4 rounded-2xl bg-red-50/60 border border-red-200 space-y-2">
                  <label
                    htmlFor="reset-confirm-input"
                    className="block text-xs font-bold text-red-950"
                  >
                    3. Escribe la palabra{' '}
                    <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-red-200">
                      {RESET_CONFIRMATION_WORD}
                    </span>{' '}
                    para habilitar el reinicio
                  </label>
                  <input
                    id="reset-confirm-input"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={RESET_CONFIRMATION_WORD}
                    className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-white border border-red-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-600"
                  />
                  <p className="text-[11px] text-red-800">
                    Esta acción elimina los datos seleccionados en el servidor y no se puede revertir.
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleFinishClose}
                    className="min-h-[42px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={!confirmationReady}
                    onClick={handleStartReset}
                    className="min-h-[42px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                    Reiniciar ahora
                  </button>
                </div>
              </div>
            ) : phase === 'collecting' || phase === 'running' ? (
              <div className="py-4 space-y-4">
                <div className="flex items-center gap-3">
                  <Loader2 className="w-5 h-5 text-red-600 animate-spin shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-stone-900">
                      {phase === 'collecting'
                        ? 'Analizando registros del restaurante...'
                        : progress.currentStepLabel || 'Eliminando datos por lotes...'}
                    </p>
                    {phase === 'running' && (
                      <p className="text-xs font-mono tabular-nums text-stone-600 mt-0.5">
                        {progress.deletedCount} de {progress.totalCount} registros eliminados (
                        {percent}%)
                      </p>
                    )}
                  </div>
                </div>

                <div className="w-full h-3 bg-stone-100 rounded-full overflow-hidden border border-stone-200">
                  <div
                    className="h-full bg-red-600 transition-all duration-300"
                    style={{ width: `${phase === 'collecting' ? 8 : percent}%` }}
                  />
                </div>

                <p className="text-xs text-stone-500">
                  No cierres esta ventana hasta que termine el proceso.
                </p>
              </div>
            ) : phase === 'partial_error' ? (
              <div className="space-y-4">
                <div
                  role="alert"
                  className="p-4 rounded-2xl bg-red-50 border border-red-200 space-y-2"
                >
                  <div className="flex items-start gap-2.5 text-red-900">
                    <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-bold">
                        El reinicio se detuvo a la mitad
                      </p>
                      <p className="text-xs text-red-800 leading-relaxed">
                        {errorMessage}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200 space-y-2">
                  <p className="text-xs font-semibold text-stone-900 font-mono tabular-nums">
                    Avance guardado: {alreadyDeletedBeforeRetry} eliminados ·{' '}
                    {pendingTasks.length} pendientes
                  </p>
                  {pendingByCategory && (
                    <ul className="text-xs text-stone-700 space-y-1">
                      {RESET_CATEGORY_ORDER.map((cat) => {
                        const count = pendingByCategory[cat] ?? 0;
                        if (count <= 0) return null;
                        return (
                          <li key={cat} className="flex items-center justify-between">
                            <span>{RESET_CATEGORY_LABELS[cat]}</span>
                            <span className="font-mono font-semibold text-red-700">
                              {count} pend.
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleFinishClose}
                    className="min-h-[42px] px-4 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 cursor-pointer"
                  >
                    Cerrar por ahora
                  </button>
                  <button
                    type="button"
                    onClick={handleRetryPending}
                    className="min-h-[42px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Reintentar pendientes ({pendingTasks.length})
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-emerald-950">
                      Reinicio completado
                    </p>
                    <p className="text-xs text-emerald-900 leading-relaxed">
                      {initialTotalCount === 0
                        ? 'No había registros acumulados por eliminar.'
                        : `Se eliminaron ${initialTotalCount} registros correctamente.`}{' '}
                      {scope === 'all'
                        ? 'El restaurante quedó vacío, sin alertas ni datos de ejemplo. Ahora puedes crear tu primer puesto de trabajo y primer insumo.'
                        : 'El historial de reportes y alertas fue limpiado. Tus puestos e insumos siguen disponibles.'}
                    </p>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleFinishClose}
                    className="min-h-[42px] px-5 py-2 text-sm font-semibold text-white bg-stone-950 rounded-xl hover:bg-stone-800 cursor-pointer"
                  >
                    Volver al panel
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
