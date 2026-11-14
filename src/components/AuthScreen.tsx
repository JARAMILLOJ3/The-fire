import { useState } from 'react';
import { ClipboardCheck, QrCode, ShoppingCart, Store, UtensilsCrossed } from 'lucide-react';
import heroPhoto from '../assets/images/restaurant_prep_hero_1794616390901.jpg';
import type { StationLink } from '../types';
import { BrandLogo } from './BrandLogo';

interface AuthScreenProps {
  onSignIn: () => Promise<void>;
  loading: boolean;
  errorMessage: string | null;
  pendingLink?: StationLink | null;
  hasLinkParams?: boolean;
}

export function AuthScreen({
  onSignIn,
  loading,
  errorMessage,
  pendingLink,
  hasLinkParams = false,
}: AuthScreenProps) {
  const [imgFailed, setImgFailed] = useState(false);

  if (pendingLink || hasLinkParams) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
        <header className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between">
          <BrandLogo />
        </header>

        <main className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 text-xs font-semibold text-teal-700">
                <QrCode className="w-4 h-4" />
                <span>Ingreso directo a puesto de trabajo</span>
              </div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                {pendingLink?.stationName ?? 'Tu Puesto de Trabajo'}
              </h1>
              {pendingLink?.workerName ? (
                <p className="text-sm text-slate-600">
                  Responsable asignada:{' '}
                  <span className="font-semibold text-slate-900">{pendingLink.workerName}</span>
                </p>
              ) : (
                <p className="text-sm text-slate-600">
                  Inicia sesión con tu cuenta de Google para abrir directamente la planilla de inventario asignada.
                </p>
              )}
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 space-y-1.5">
              <p className="font-semibold text-slate-900">¿Cómo funciona al terminar tu turno?</p>
              <p>1. Entra con tu cuenta de Google desde tu celular.</p>
              <p>2. Anota cuánto quedó de cada insumo al cerrar el día.</p>
              <p>3. Toca &ldquo;Enviar cierre al jefe&rdquo; y listo.</p>
            </div>

            {errorMessage && (
              <div
                role="alert"
                className="p-3.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg"
              >
                {errorMessage}
              </div>
            )}

            <button
              type="button"
              onClick={onSignIn}
              disabled={loading}
              className="w-full min-h-[48px] inline-flex items-center justify-center gap-2.5 px-5 py-3 text-base font-semibold text-white bg-teal-700 rounded-xl hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              <Store className="w-5 h-5" />
              {loading ? 'Ingresando...' : 'Entrar a hacer mi cierre con Google'}
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <header className="flex items-center justify-between gap-8 px-6 lg:px-10 py-4 bg-white border-b border-slate-200">
        <BrandLogo />
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a href="#estaciones" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Puestos
          </a>
          <a href="#flujo" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Acceso QR
          </a>
          <a href="#compras" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Compras
          </a>
        </nav>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onSignIn}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {loading ? 'Ingresando...' : 'Ingresar con Google'}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 lg:px-10 py-10 lg:py-16 flex flex-col justify-center gap-12">
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center gap-6">
            <p className="text-xs font-medium text-teal-700 tracking-wide">
              The Fire · Puestos de trabajo · Enlace QR para empleadas · Alertas de compra
            </p>
            <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-slate-900 leading-[1.12] [text-wrap:balance]">
              Control de inventario por puesto de trabajo con acceso QR desde el celular
            </h1>
            <p className="text-base text-slate-600 leading-relaxed max-w-xl">
              El jefe crea los puestos de trabajo, asigna insumos y trabajadora, y comparte un código QR o enlace. Cada empleada entra directo a su espacio para reportar inicio y fin de jornada.
            </p>

            {errorMessage && (
              <div
                role="alert"
                className="p-3.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg"
              >
                {errorMessage}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <button
                type="button"
                onClick={onSignIn}
                disabled={loading}
                className="inline-flex items-center justify-center gap-3 px-6 py-3 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 transition-colors cursor-pointer"
              >
                <Store className="w-4 h-4" />
                {loading ? 'Conectando...' : 'Entrar al sistema con Google'}
              </button>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="h-full min-h-[280px] lg:min-h-[420px] rounded-xl overflow-hidden border border-slate-200 bg-slate-900 relative">
              {!imgFailed ? (
                <img
                  src={heroPhoto}
                  alt="Estación de preparación y nevera de bebidas en restaurante The Fire"
                  referrerPolicy="no-referrer"
                  onError={() => setImgFailed(true)}
                  className="w-full h-full object-cover lg:h-full"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-slate-800 to-slate-900 text-slate-200">
                  <UtensilsCrossed className="w-10 h-10 mb-3 text-teal-400" />
                  <p className="font-display text-lg font-semibold">The Fire Inventario</p>
                  <p className="text-sm text-slate-400 mt-1">
                    Apertura, cierre y reposición diaria por puesto
                  </p>
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-slate-950/20 to-transparent pointer-events-none" />
              <div className="absolute bottom-0 left-0 right-0 p-6 text-white">
                <p className="text-xs font-medium text-teal-300">
                  Sincronizado en tiempo real
                </p>
                <p className="font-display text-lg font-semibold mt-1">
                  Cada puesto reporta apertura y cierre; el jefe recibe alertas de compra al instante.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section
          id="estaciones"
          className="grid grid-cols-1 md:grid-cols-3 bg-white border border-slate-200 rounded-xl divide-y md:divide-y-0 md:divide-x divide-slate-200"
        >
          <div id="flujo" className="p-6 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-teal-700 font-medium text-sm">
              <QrCode className="w-4 h-4 shrink-0" />
              <span>1. Enlace o código QR por puesto</span>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Crea cualquier sección, asigna trabajadora e insumos, y comparte el QR para que entre desde su celular.
            </p>
          </div>
          <div className="p-6 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-teal-700 font-medium text-sm">
              <ClipboardCheck className="w-4 h-4 shrink-0" />
              <span>2. Inicio y cierre de jornada</span>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Anota con cuánto abre y cierra el turno con marca de hora exacta y carga rápida del día anterior.
            </p>
          </div>
          <div id="compras" className="p-6 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-teal-700 font-medium text-sm">
              <ShoppingCart className="w-4 h-4 shrink-0" />
              <span>3. Alertas y lista de compras</span>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Detecta automáticamente qué está agotado o pronto a acabarse y copia el pedido por WhatsApp.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
