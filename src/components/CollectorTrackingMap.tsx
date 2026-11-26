import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  APILoadingStatus,
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useAdvancedMarkerRef,
  useApiLoadingStatus,
  useMap,
} from '@vis.gl/react-google-maps';
import { MapPin, Navigation, RefreshCw, Users } from 'lucide-react';
import type {
  CollectorLocationRecord,
  CollectorProfile,
  MeterReading,
} from '../types/station';

interface CollectorTrackingMapProps {
  collectors: CollectorProfile[];
  collectorLocations: CollectorLocationRecord[];
  readings: MeterReading[];
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}

interface MapFocusTarget {
  lat: number;
  lng: number;
  zoom: number;
  id: string;
}

const DEFAULT_CENTER = { lat: 15.3694, lng: 44.191 };

function MapViewportController({ target }: { target: MapFocusTarget | null }) {
  const map = useMap();

  useEffect(() => {
    if (!map || !target) return;
    map.panTo({ lat: target.lat, lng: target.lng });
    map.setZoom(target.zoom);
  }, [map, target]);

  return null;
}

function CollectorPinMarker({
  location,
  isSelected,
  onSelect,
  onClose,
}: {
  location: CollectorLocationRecord;
  isSelected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: location.lat, lng: location.lng }}
        onClick={onSelect}
        title={`المحصّل: ${location.collectorName}`}
      >
        <Pin
          background={isSelected ? '#0f766e' : '#0284c7'}
          borderColor="#ffffff"
          glyphColor="#ffffff"
          scale={isSelected ? 1.25 : 1.05}
        />
      </AdvancedMarker>

      {isSelected && marker && (
        <InfoWindow anchor={marker} maxWidth={260} onCloseClick={onClose}>
          <div dir="rtl" className="text-right space-y-1 text-slate-900 p-0.5">
            <div className="text-sm font-bold text-teal-900">
              المحصّل: {location.collectorName}
            </div>
            <div className="text-xs text-slate-600 font-mono-nums">
              كود: {location.collectorCode}
              {typeof location.accuracy === 'number'
                ? ` · دقة ±${location.accuracy} م`
                : ''}
            </div>
            {location.lastSubscriberName && (
              <div className="text-xs text-slate-800">
                آخر مشترك: {location.lastSubscriberName}
                {location.lastMeterNumber
                  ? ` (عداد ${location.lastMeterNumber})`
                  : ''}
              </div>
            )}
            {location.zoneStreet && (
              <div className="text-xs text-slate-600">
                الحارة: {location.zoneStreet}
              </div>
            )}
            <div className="text-[11px] text-slate-500 font-mono-nums">
              آخر تحديث: {new Date(location.updatedAt).toLocaleString('ar-YE')}
            </div>
          </div>
        </InfoWindow>
      )}
    </>
  );
}

function ReadingPinMarker({
  reading,
  isSelected,
  onSelect,
  onClose,
}: {
  reading: MeterReading;
  isSelected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  if (
    typeof reading.gpsLat !== 'number' ||
    typeof reading.gpsLng !== 'number'
  ) {
    return null;
  }

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: reading.gpsLat, lng: reading.gpsLng }}
        onClick={onSelect}
        title={`${reading.subscriberName} — ${reading.collectorName}`}
      >
        <Pin
          background="#d97706"
          borderColor="#ffffff"
          glyphColor="#ffffff"
          scale={0.85}
        />
      </AdvancedMarker>

      {isSelected && marker && (
        <InfoWindow anchor={marker} maxWidth={250} onCloseClick={onClose}>
          <div dir="rtl" className="text-right space-y-1 text-slate-900 p-0.5">
            <div className="text-xs font-bold text-slate-900">
              قراءة عداد: {reading.subscriberName}
            </div>
            <div className="text-xs text-slate-600 font-mono-nums">
              عداد {reading.meterNumber} · القراءة {reading.currentReading}
            </div>
            <div className="text-xs text-slate-700">
              المحصّل: {reading.collectorName}
            </div>
            <div className="text-[11px] text-slate-500 font-mono-nums">
              {new Date(reading.recordedAt).toLocaleString('ar-YE')}
            </div>
          </div>
        </InfoWindow>
      )}
    </>
  );
}

function MapLoadGuard({ children }: { children: React.ReactNode }) {
  const status = useApiLoadingStatus();

  if (
    status === APILoadingStatus.FAILED ||
    status === APILoadingStatus.AUTH_FAILURE
  ) {
    return (
      <div className="h-[420px] w-full flex flex-col items-center justify-center bg-slate-50 border border-slate-200 rounded-xl p-6 text-center space-y-2">
        <MapPin className="w-8 h-8 text-rose-600" />
        <p className="text-sm font-bold text-slate-900">
          تعذر تحميل خرائط Google حالياً
        </p>
        <p className="text-xs text-slate-600 max-w-md">
          يرجى التحقق من اتصال الإنترنت أو إعدادات مفتاح خرائط Google في الخادم.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

export const CollectorTrackingMap: React.FC<CollectorTrackingMapProps> = ({
  collectors,
  collectorLocations,
  readings,
  onRefresh,
  refreshing,
}) => {
  const envApiKey =
    (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() ||
    '';
  const [resolvedApiKey, setResolvedApiKey] = useState<string>(envApiKey);
  const [selectedCollectorFilter, setSelectedCollectorFilter] =
    useState<string>('all');
  const [selectedMarkerKey, setSelectedMarkerKey] = useState<string | null>(
    null,
  );
  const [focusTarget, setFocusTarget] = useState<MapFocusTarget | null>(null);

  useEffect(() => {
    if (envApiKey) {
      setResolvedApiKey(envApiKey);
      return;
    }
    let cancelled = false;
    fetch('/api/maps/config')
      .then((r) => r.json())
      .then((data: { apiKey?: string }) => {
        if (!cancelled && data.apiKey) {
          setResolvedApiKey(data.apiKey);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [envApiKey]);

  const visibleLocations = useMemo(() => {
    if (selectedCollectorFilter === 'all') return collectorLocations;
    return collectorLocations.filter(
      (loc) =>
        loc.collectorCode === selectedCollectorFilter ||
        loc.collectorName === selectedCollectorFilter,
    );
  }, [collectorLocations, selectedCollectorFilter]);

  const gpsReadings = useMemo(() => {
    return readings
      .filter(
        (r) =>
          typeof r.gpsLat === 'number' &&
          typeof r.gpsLng === 'number' &&
          (selectedCollectorFilter === 'all' ||
            r.collectorUid === selectedCollectorFilter ||
            r.collectorName === selectedCollectorFilter),
      )
      .slice(0, 40);
  }, [readings, selectedCollectorFilter]);

  const initialCenter = useMemo(() => {
    if (visibleLocations[0]) {
      return { lat: visibleLocations[0].lat, lng: visibleLocations[0].lng };
    }
    if (
      gpsReadings[0] &&
      typeof gpsReadings[0].gpsLat === 'number' &&
      typeof gpsReadings[0].gpsLng === 'number'
    ) {
      return { lat: gpsReadings[0].gpsLat, lng: gpsReadings[0].gpsLng };
    }
    return DEFAULT_CENTER;
  }, [visibleLocations, gpsReadings]);

  const handleFocusCollector = useCallback((loc: CollectorLocationRecord) => {
    const id = `col_${loc.collectorCode}`;
    setSelectedMarkerKey(id);
    setFocusTarget({ lat: loc.lat, lng: loc.lng, zoom: 16, id: `${id}_${Date.now()}` });
  }, []);

  const locationByCollector = useMemo(() => {
    const dict: Record<string, CollectorLocationRecord> = {};
    collectorLocations.forEach((loc) => {
      dict[loc.collectorCode] = loc;
    });
    return dict;
  }, [collectorLocations]);

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Navigation className="w-5 h-5 text-teal-700" />
            خريطة تتبع المحصّل الميداني (GPS)
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            متابعة مواقع المحصّلين الميدانيين ونقاط القراءات الملتقطة عبر نظام تحديد المواقع لحظة بلحظة
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedCollectorFilter}
            onChange={(e) => setSelectedCollectorFilter(e.target.value)}
            className="min-h-[44px] px-3 py-2 text-sm font-bold border border-slate-300 rounded-lg bg-white"
          >
            <option value="all">جميع المحصّلين ({collectors.length})</option>
            {collectors.map((c) => {
              const code = c.code || c.id;
              return (
                <option key={code} value={code}>
                  {c.name} ({code})
                </option>
              );
            })}
          </select>

          <button
            type="button"
            disabled={refreshing}
            onClick={() => void onRefresh()}
            className="min-h-[44px] px-4 py-2 text-xs font-bold rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-4 h-4 text-teal-700 ${refreshing ? 'animate-spin' : ''}`}
            />
            تحديث المواقع الآن
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Collector Telemetry List */}
        <div className="lg:col-span-4 border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
          {collectors.map((col) => {
            const code = col.code || col.id;
            const loc = locationByCollector[code];
            return (
              <div
                key={code}
                className="p-4 flex items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
              >
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Users className="w-4 h-4 text-teal-700 shrink-0" />
                    <span className="truncate">{col.name}</span>
                  </div>
                  <div className="text-xs text-slate-500 font-mono-nums">
                    كود: {code} ·{' '}
                    {col.assignedZones.length > 0
                      ? col.assignedZones.join('، ')
                      : 'جميع الحارات'}
                  </div>
                  {loc ? (
                    <div className="text-xs text-emerald-700 font-medium">
                      متصل GPS · آخر تحديث{' '}
                      <span className="font-mono-nums">
                        {new Date(loc.updatedAt).toLocaleTimeString('ar-YE')}
                      </span>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">
                      بانتظار تفعيل زر مشاركة GPS من هاتف المحصّل
                    </div>
                  )}
                </div>

                {loc && (
                  <button
                    type="button"
                    onClick={() => handleFocusCollector(loc)}
                    className="px-3 py-2 text-xs font-bold bg-teal-50 border border-teal-200 text-teal-900 hover:bg-teal-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    تحديد على الخريطة
                  </button>
                )}
              </div>
            );
          })}

          {collectors.length === 0 && (
            <div className="p-6 text-center text-xs text-slate-500">
              لا يوجد محصّلون مضافون لهذه المحطة حتى الآن.
            </div>
          )}
        </div>

        {/* Google Map Viewport */}
        <div className="lg:col-span-8">
          {resolvedApiKey ? (
            <APIProvider
              apiKey={resolvedApiKey}
              libraries={['marker']}
              language="ar"
              region="YE"
            >
              <MapLoadGuard>
                <div className="h-[420px] w-full rounded-xl overflow-hidden border border-slate-200 relative">
                  <GoogleMap
                    mapId="DEMO_MAP_ID"
                    defaultCenter={initialCenter}
                    defaultZoom={visibleLocations.length > 0 ? 14 : 12}
                    gestureHandling="greedy"
                    internalUsageAttributionIds={[
                      'gmp_mcp_codeassist_v1_aistudio',
                    ]}
                    style={{ width: '100%', height: '100%' }}
                  >
                    <MapViewportController target={focusTarget} />

                    {visibleLocations.map((loc) => {
                      const key = `col_${loc.collectorCode}`;
                      return (
                        <CollectorPinMarker
                          key={key}
                          location={loc}
                          isSelected={selectedMarkerKey === key}
                          onSelect={() => setSelectedMarkerKey(key)}
                          onClose={() => setSelectedMarkerKey(null)}
                        />
                      );
                    })}

                    {gpsReadings.map((rd) => {
                      const key = `rd_${rd.id}`;
                      return (
                        <ReadingPinMarker
                          key={key}
                          reading={rd}
                          isSelected={selectedMarkerKey === key}
                          onSelect={() => setSelectedMarkerKey(key)}
                          onClose={() => setSelectedMarkerKey(null)}
                        />
                      );
                    })}
                  </GoogleMap>
                </div>
              </MapLoadGuard>
            </APIProvider>
          ) : (
            <div className="h-[420px] w-full flex flex-col items-center justify-center bg-slate-50 border border-slate-200 rounded-xl p-6 text-center space-y-2">
              <MapPin className="w-8 h-8 text-teal-700" />
              <p className="text-sm font-bold text-slate-900">
                جاري تهيئة خدمة خرائط Google
              </p>
              <p className="text-xs text-slate-600 max-w-md">
                بمجرد تفعيل مفتاح الخرائط في بيئة التشغيل ستظهر هنا مواقع المحصّلين الميدانيين ونقاط قراءات العدادات مباشرة.
              </p>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              الدبابيس الزرقاء/الخضراء: الموقع الحي للمحصّل · الدبابيس الكهرمانية: مواقع قراءات العدادات
            </span>
            <span className="font-mono-nums">
              {visibleLocations.length} موقع حي · {gpsReadings.length} قراءة بإحداثيات GPS
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
