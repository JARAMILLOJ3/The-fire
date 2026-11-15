import { Component, lazy, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';

export function lazyWithRetry<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  retries = 2,
) {
  return lazy(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await loader();
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  });
}

interface LazyViewBoundaryProps {
  resetKey?: string;
  children: ReactNode;
}

interface LazyViewBoundaryState {
  hasError: boolean;
}

export class LazyViewBoundary extends Component<LazyViewBoundaryProps, LazyViewBoundaryState> {
  state: LazyViewBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LazyViewBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: LazyViewBoundaryProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Error cargando vista dinámica:', error, info);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-8 text-center space-y-4 max-w-md mx-auto my-6">
        <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 text-amber-700 flex items-center justify-center mx-auto">
          <WifiOff className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h2 className="font-display text-lg font-bold text-stone-900">
            No se pudo cargar esta pantalla
          </h2>
          <p className="text-sm text-stone-600">
            Hubo una interrupción temporal de conexión o una actualización pendiente. Recarga para continuar.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 cursor-pointer"
        >
          <RefreshCw className="w-4 h-4" />
          Recargar vista
        </button>
      </div>
    );
  }
}
