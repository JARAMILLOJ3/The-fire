import { useState, type FormEvent } from 'react';
import { ArrowRight, Flame } from 'lucide-react';
import { MAX_NAME_LENGTH } from '../constants';
import { updateWorkspaceProfile } from '../services/bossService';
import type { Workspace } from '../types';

interface BossWelcomeModalProps {
  workspace: Workspace;
  suggestedName?: string | null;
}

export function BossWelcomeModal({ workspace, suggestedName }: BossWelcomeModalProps) {
  const [ownerName, setOwnerName] = useState(suggestedName?.trim() || '');
  const [businessName, setBusinessName] = useState(workspace.name || 'The Fire');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanOwner = ownerName.trim();
    if (!cleanOwner) {
      setErrorMsg('Escribe tu nombre para personalizar tu bienvenida.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      await updateWorkspaceProfile(workspace.id, {
        ownerName: cleanOwner,
        name: businessName.trim().length >= 2 ? businessName.trim() : workspace.name,
      });
    } catch {
      setErrorMsg('No se pudo guardar tu nombre. Intenta nuevamente.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="boss-welcome-title"
    >
      <div className="bg-white border border-stone-200 rounded-2xl w-full max-w-md max-h-[90dvh] overflow-y-auto shadow-2xl animate-tf-fade-up">
        <div className="bg-stone-950 px-6 py-5 text-white flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-white p-0.5 overflow-hidden flex items-center justify-center shrink-0">
            {!logoFailed ? (
              <img
                src="/assets/aistudio/IMG_1518_bd74972f.jpeg"
                alt="Logo The Fire"
                referrerPolicy="no-referrer"
                onError={() => setLogoFailed(true)}
                className="w-full h-full object-contain"
              />
            ) : (
              <Flame className="w-6 h-6 text-orange-600" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-orange-400">Primer ingreso</p>
            <h2 id="boss-welcome-title" className="font-display text-xl font-bold truncate">
              ¡Bienvenido a The Fire!
            </h2>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-stone-600 leading-relaxed">
            Dinos cómo te llamas para recibirte por tu nombre cada vez que entres a revisar el inventario de tu negocio.
          </p>

          {errorMsg && (
            <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl">
              {errorMsg}
            </div>
          )}

          <div>
            <label
              htmlFor="boss-owner-name"
              className="block text-xs font-semibold text-stone-700 mb-1.5"
            >
              ¿Cuál es tu nombre?
            </label>
            <input
              id="boss-owner-name"
              type="text"
              autoFocus
              required
              maxLength={MAX_NAME_LENGTH}
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              placeholder="Ej: Carlos, Juan, Andrés..."
              className="w-full min-h-[44px] px-3.5 py-2.5 text-base sm:text-sm bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div>
            <label
              htmlFor="boss-business-name"
              className="block text-xs font-semibold text-stone-700 mb-1.5"
            >
              Nombre del restaurante
            </label>
            <input
              id="boss-business-name"
              type="text"
              required
              minLength={2}
              maxLength={MAX_NAME_LENGTH}
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="The Fire"
              className="w-full min-h-[44px] px-3.5 py-2.5 text-base sm:text-sm bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-[46px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 disabled:opacity-60 transition-colors cursor-pointer"
          >
            {submitting ? 'Guardando...' : 'Entrar a mi panel'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
