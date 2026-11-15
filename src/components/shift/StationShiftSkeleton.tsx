interface StationShiftSkeletonProps {
  stationName?: string;
  workerName?: string;
}

export function StationShiftSkeleton({
  stationName,
  workerName,
}: StationShiftSkeletonProps) {
  return (
    <div
      className="space-y-4 sm:space-y-5 animate-tf-fade-in"
      aria-busy="true"
      aria-label="Cargando planilla del puesto"
    >
      <div className="bg-white border border-stone-200 rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-2">
            {stationName ? (
              <h1 className="font-display text-xl sm:text-2xl font-bold text-stone-900">
                {stationName}
              </h1>
            ) : (
              <div className="h-7 w-48 bg-stone-200 rounded-lg animate-pulse" />
            )}
            {workerName ? (
              <p className="text-sm text-stone-600">
                Preparando la planilla de <span className="font-semibold">{workerName}</span>...
              </p>
            ) : (
              <div className="h-4 w-56 bg-stone-100 rounded-lg animate-pulse" />
            )}
          </div>
          <div className="h-9 w-36 bg-stone-100 rounded-xl animate-pulse" />
        </div>
        <div className="h-2.5 w-full bg-stone-100 rounded-full overflow-hidden">
          <div className="h-full w-1/3 bg-orange-200 rounded-full animate-pulse" />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2.5">
        <div className="h-11 flex-1 bg-white border border-stone-200 rounded-xl animate-pulse" />
        <div className="h-11 w-full sm:w-52 bg-white border border-stone-200 rounded-xl animate-pulse" />
      </div>

      <div className="space-y-3">
        {[1, 2, 3, 4].map((row) => (
          <div
            key={row}
            className="bg-white border border-stone-200 rounded-2xl p-4 space-y-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1.5">
                <div className="h-5 w-40 bg-stone-200 rounded-lg animate-pulse" />
                <div className="h-3.5 w-28 bg-stone-100 rounded-lg animate-pulse" />
              </div>
              <div className="h-7 w-20 bg-stone-100 rounded-lg animate-pulse" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              <div className="h-12 bg-stone-100 rounded-xl animate-pulse" />
              <div className="h-12 bg-stone-100 rounded-xl animate-pulse" />
              <div className="h-12 bg-stone-100 rounded-xl animate-pulse col-span-2 sm:col-span-1" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
