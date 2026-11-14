import { useState } from 'react';
import { motion } from 'motion/react';
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
      <div className="min-h-screen overflow-x-hidden bg-stone-50 text-stone-900 flex flex-col">
        <header className="px-4 sm:px-6 py-4 bg-white border-b border-stone-200 flex items-center justify-between">
          <BrandLogo />
        </header>

        <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-md bg-white border border-stone-200 rounded-2xl p-6 sm:p-8 space-y-6 shadow-sm"
          >
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 text-xs font-semibold text-orange-600">
                <QrCode className="w-4 h-4 shrink-0" />
                <span>Ingreso directo a tu puesto</span>
              </div>
              <h1 className="font-display text-2xl sm:text-3xl font-bold text-stone-900">
                {pendingLink?.stationName ?? 'Tu Puesto de Trabajo'}
              </h1>
              {pendingLink?.workerName ? (
                <p className="text-sm text-stone-600">
                  ¡Hola,{' '}
                  <span className="font-semibold text-stone-900">{pendingLink.workerName}</span>!
                  Entra con Google para contar el inventario al terminar tu turno.
                </p>
              ) : (
                <p className="text-sm text-stone-600">
                  Inicia sesión con tu cuenta de Google para abrir directamente tu planilla asignada.
                </p>
              )}
            </div>

            <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl text-sm text-stone-700 space-y-1.5">
              <p className="font-semibold text-stone-900">Así de fácil en 3 pasos:</p>
              <p>1. Entra con tu cuenta de Google desde tu celular.</p>
              <p>2. Toca + o − para anotar cuánto quedó al cerrar.</p>
              <p>3. Presiona &ldquo;Enviar cierre al jefe&rdquo; y listo.</p>
            </div>

            {errorMessage && (
              <div
                role="alert"
                className="p-3.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl"
              >
                {errorMessage}
              </div>
            )}

            <button
              type="button"
              onClick={onSignIn}
              disabled={loading}
              className="w-full min-h-[48px] inline-flex items-center justify-center gap-2.5 px-5 py-3 text-base font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-60 transition-all cursor-pointer"
            >
              <Store className="w-5 h-5 shrink-0" />
              {loading ? 'Ingresando...' : 'Entrar a hacer mi cierre con Google'}
            </button>
          </motion.div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-stone-50 text-stone-900 flex flex-col">
      <header className="flex items-center justify-between gap-3 sm:gap-8 px-4 sm:px-6 lg:px-10 py-3.5 sm:py-4 bg-white border-b border-stone-200">
        <BrandLogo />
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-stone-600">
          <a href="#estaciones" className="hover:text-stone-900 transition-colors whitespace-nowrap shrink-0">
            Puestos
          </a>
          <a href="#flujo" className="hover:text-stone-900 transition-colors whitespace-nowrap shrink-0">
            Acceso QR
          </a>
          <a href="#compras" className="hover:text-stone-900 transition-colors whitespace-nowrap shrink-0">
            Compras
          </a>
        </nav>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onSignIn}
            disabled={loading}
            className="min-h-[40px] px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.98] disabled:opacity-60 transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            {loading ? (
              'Ingresando...'
            ) : (
              <>
                <span className="sm:hidden">Ingresar</span>
                <span className="hidden sm:inline">Ingresar con Google</span>
              </>
            )}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-10 py-8 lg:py-16 flex flex-col justify-center gap-10 lg:gap-12">
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-6 flex flex-col justify-center gap-5 sm:gap-6 min-w-0"
          >
            <p className="text-xs font-semibold text-orange-600 tracking-wide">
              The Fire · Puestos de trabajo · Enlace QR · Alertas de compra
            </p>
            <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-stone-900 leading-[1.12] [text-wrap:balance]">
              Control diario de inventario para cada puesto de tu restaurante
            </h1>
            <p className="text-base text-stone-600 leading-relaxed max-w-xl">
              Organiza tus secciones, asigna a cada trabajadora su código QR y recibe cada noche o mañana el reporte claro de qué falta por comprar.
            </p>

            {errorMessage && (
              <div
                role="alert"
                className="p-3.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl"
              >
                {errorMessage}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <button
                type="button"
                onClick={onSignIn}
                disabled={loading}
                className="min-h-[48px] inline-flex items-center justify-center gap-3 px-6 py-3 text-sm font-semibold text-white bg-stone-950 rounded-xl hover:bg-stone-800 active:scale-[0.98] disabled:opacity-60 transition-all cursor-pointer"
              >
                <Store className="w-4 h-4 text-orange-400" />
                {loading ? 'Conectando...' : 'Entrar al sistema con Google'}
              </button>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-6 min-w-0"
          >
            <div className="h-full min-h-[260px] lg:min-h-[420px] rounded-2xl overflow-hidden border border-stone-200 bg-stone-950 relative shadow-sm">
              {!imgFailed ? (
                <img
                  src={heroPhoto}
                  alt="Estación de preparación y nevera de bebidas en restaurante The Fire"
                  referrerPolicy="no-referrer"
                  onError={() => setImgFailed(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-stone-800 to-stone-950 text-stone-200">
                  <UtensilsCrossed className="w-10 h-10 mb-3 text-orange-400" />
                  <p className="font-display text-lg font-semibold">The Fire Inventario</p>
                  <p className="text-sm text-stone-400 mt-1">
                    Apertura, cierre y reposición diaria por puesto
                  </p>
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-stone-950/85 via-stone-950/20 to-transparent pointer-events-none" />
              <div className="absolute bottom-0 left-0 right-0 p-5 sm:p-6 text-white">
                <p className="text-xs font-semibold text-orange-400">
                  Sincronizado en tiempo real
                </p>
                <p className="font-display text-base sm:text-lg font-semibold mt-1">
                  Cada puesto reporta su cierre; el jefe recibe alertas de compra al instante.
                </p>
              </div>
            </div>
          </motion.div>
        </section>

        <motion.section
          id="estaciones"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.14, ease: [0.22, 1, 0.36, 1] }}
          className="grid grid-cols-1 md:grid-cols-3 gap-px bg-stone-200 border border-stone-200 rounded-2xl overflow-hidden"
        >
          <div id="flujo" className="bg-white p-6 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-orange-600 font-semibold text-sm">
              <QrCode className="w-4 h-4 shrink-0" />
              <span>1. Enlace o código QR por puesto</span>
            </div>
            <p className="text-sm text-stone-600 leading-relaxed">
              Crea cualquier sección, asigna trabajadora e insumos, y comparte el QR para que entre desde su celular.
            </p>
          </div>
          <div className="bg-white p-6 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-orange-600 font-semibold text-sm">
              <ClipboardCheck className="w-4 h-4 shrink-0" />
              <span>2. Cierre rápido de jornada</span>
            </div>
            <p className="text-sm text-stone-600 leading-relaxed">
              Las trabajadoras registran cuánto quedó al terminar el día en segundos con botones grandes y claros.
            </p>
          </div>
          <div id="compras" className="bg-white p-6 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-orange-600 font-semibold text-sm">
              <ShoppingCart className="w-4 h-4 shrink-0" />
              <span>3. Alertas y lista de compras</span>
            </div>
            <p className="text-sm text-stone-600 leading-relaxed">
              Detecta automáticamente qué está agotado o pronto a acabarse y copia el pedido por WhatsApp.
            </p>
          </div>
        </motion.section>
      </main>
    </div>
  );
}
