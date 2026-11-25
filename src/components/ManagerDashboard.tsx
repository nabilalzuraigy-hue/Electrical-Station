import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Check,
  Download,
  RefreshCw,
  Search,
  ShieldAlert,
  Upload,
  Users,
  X,
  Zap,
} from 'lucide-react';
import {
  exportStationReportExcel,
  refreshStationState,
  resolveManagerAlert,
  saveStationLocalState,
  updateCollectorInCloud,
  type StationLocalState,
} from '../lib/offlineDb';
import { formatCompactYer, formatKwh, formatYer } from '../lib/formatters';
import type {
  CollectorPermissions,
  CollectorProfile,
  LowerReadingReason,
  ManagerAlert,
  SyncProgress,
} from '../types/station';

const LOWER_REASON_AR: Record<LowerReadingReason, string> = {
  meter_replaced: 'تم تغيير العداد بعداد جديد',
  meter_reset: 'تم تصفير العداد',
  previous_error: 'خطأ في القراءة السابقة',
};

interface ManagerDashboardProps {
  state: StationLocalState;
  staffToken: string;
  onUpdateState: (next: StationLocalState) => void;
  onSyncNow: () => Promise<void>;
  isSyncing: boolean;
  syncProgress: SyncProgress | null;
}

export const ManagerDashboard: React.FC<ManagerDashboardProps> = ({
  state,
  staffToken,
  onUpdateState,
  onSyncNow,
  isSyncing,
  syncProgress,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [zoneFilter, setZoneFilter] = useState<string>('all');
  const [alertFilter, setAlertFilter] = useState<'pending' | 'all'>('pending');
  const [tariffSaved, setTariffSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [collectorError, setCollectorError] = useState<string | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [previewAlertPhoto, setPreviewAlertPhoto] = useState<{
    title: string;
    url: string;
  } | null>(null);

  const [stationName, setStationName] = useState(state.station.stationName);
  const [kwhPrice, setKwhPrice] = useState(String(state.station.kwhPriceYer));
  const [minFee, setMinFee] = useState(String(state.station.minimumFeeYer));
  const [mainGenKwh, setMainGenKwh] = useState(
    String(state.station.mainGeneratorKwh),
  );

  const metrics = useMemo(() => {
    const activeSubscribers = state.subscribers.length;
    const totalKwhSold = state.readings.reduce(
      (sum, r) => sum + r.consumptionKwh,
      0,
    );
    const mainGen = state.station.mainGeneratorKwh;
    const powerLossKwh = Math.max(0, mainGen - totalKwhSold);
    const lossPercent = mainGen > 0 ? (powerLossKwh / mainGen) * 100 : 0;
    const totalCollectedCash = state.receipts.reduce(
      (sum, rc) => sum + rc.amountPaidYer,
      0,
    );
    const totalUnpaidDebts = state.subscribers.reduce(
      (sum, s) => sum + s.previousDebtYer,
      0,
    );
    const pendingSyncCount =
      state.subscribers.filter((s) => s.syncStatus === 'pending').length +
      state.readings.filter((r) => r.syncStatus === 'pending').length +
      state.receipts.filter((rc) => rc.syncStatus === 'pending').length;

    return {
      activeSubscribers,
      totalKwhSold,
      mainGen,
      powerLossKwh,
      lossPercent,
      totalCollectedCash,
      totalUnpaidDebts,
      pendingSyncCount,
    };
  }, [state]);

  const zones = useMemo(() => {
    const set = new Set<string>();
    state.subscribers.forEach((s) => set.add(s.zoneStreet));
    return Array.from(set);
  }, [state.subscribers]);

  const filteredSubscribers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...state.subscribers]
      .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
      .filter((sub) => {
        if (zoneFilter !== 'all' && sub.zoneStreet !== zoneFilter) return false;
        if (!q) return true;
        return (
          sub.meterNumber.toLowerCase().includes(q) ||
          sub.subscriberName.toLowerCase().includes(q) ||
          sub.zoneStreet.toLowerCase().includes(q)
        );
      });
  }, [state.subscribers, searchQuery, zoneFilter]);

  // Auto-poll server every 15s for real-time instant manager notifications
  useEffect(() => {
    if (!staffToken || typeof navigator !== 'undefined' && !navigator.onLine) return;
    const timer = window.setInterval(async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      try {
        const updated = await refreshStationState(
          state.station.stationId,
          staffToken,
        );
        onUpdateState(updated);
      } catch {
        // silent background poll
      }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [state.station.stationId, staffToken, onUpdateState]);

  const sortedAlerts = useMemo(() => {
    const all = [...(state.alerts ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    if (alertFilter === 'pending') {
      return all.filter((al) => al.status === 'pending');
    }
    return all;
  }, [state.alerts, alertFilter]);

  const pendingAlertsCount = useMemo(
    () => (state.alerts ?? []).filter((al) => al.status === 'pending').length,
    [state.alerts],
  );

  const latestReadingBySubscriber = useMemo(() => {
    const map = new Map<string, (typeof state.readings)[number]>();
    for (const r of state.readings) {
      if (!map.has(r.subscriberId)) {
        map.set(r.subscriberId, r);
      }
    }
    return map;
  }, [state.readings]);

  const handleResolveAlert = async (
    alert: ManagerAlert,
    decision: 'approved' | 'rejected',
  ) => {
    setAlertError(null);
    setResolvingId(alert.id);
    try {
      const res = await resolveManagerAlert({
        staffToken,
        stationId: state.station.stationId,
        alertId: alert.id,
        decision,
      });
      const nextState: StationLocalState = {
        ...state,
        alerts: (state.alerts ?? []).map((a) =>
          a.id === alert.id ? { ...res.alert, syncStatus: 'synced' } : a,
        ),
        readings: res.reading
          ? state.readings.map((r) =>
              r.id === res.reading!.id
                ? { ...res.reading!, syncStatus: 'synced' }
                : r,
            )
          : state.readings,
        subscribers: res.subscriber
          ? state.subscribers.map((s) =>
              s.id === res.subscriber!.id
                ? { ...res.subscriber!, syncStatus: 'synced' }
                : s,
            )
          : state.subscribers,
      };
      await saveStationLocalState(nextState);
      onUpdateState(nextState);
    } catch (err) {
      setAlertError(
        err instanceof Error
          ? err.message
          : 'تعذر معالجة القرار في الخادم؛ تأكد من توفر الاتصال.',
      );
    } finally {
      setResolvingId(null);
    }
  };

  const handleRefreshFromServer = async () => {
    setRefreshing(true);
    try {
      const updated = await refreshStationState(
        state.station.stationId,
        staffToken,
      );
      onUpdateState(updated);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveTariff = (e: React.FormEvent) => {
    e.preventDefault();
    const nextPrice = Math.max(0, Number(kwhPrice) || 0);
    const nextMin = Math.max(0, Number(minFee) || 0);
    const nextGen = Math.max(0, Number(mainGenKwh) || 0);
    onUpdateState({
      ...state,
      station: {
        ...state.station,
        stationName: stationName.trim() || state.station.stationName,
        kwhPriceYer: nextPrice,
        minimumFeeYer: nextMin,
        mainGeneratorKwh: nextGen,
        updatedAt: new Date().toISOString(),
      },
    });
    setTariffSaved(true);
    setTimeout(() => setTariffSaved(false), 2500);
  };

  const handleToggleCollectorActive = async (collector: CollectorProfile) => {
    setCollectorError(null);
    const updated: CollectorProfile = {
      ...collector,
      active: !collector.active,
    };
    try {
      await updateCollectorInCloud({
        staffToken,
        stationId: state.station.stationId,
        collector: updated,
      });
      onUpdateState({
        ...state,
        collectors: state.collectors.map((c) =>
          c.id === collector.id ? updated : c,
        ),
      });
    } catch (err) {
      setCollectorError(
        err instanceof Error ? err.message : 'تعذر تحديث حالة المحصّل.',
      );
    }
  };

  const handleToggleCollectorPermission = async (
    collector: CollectorProfile,
    permKey: keyof CollectorPermissions,
  ) => {
    setCollectorError(null);
    const updated: CollectorProfile = {
      ...collector,
      permissions: {
        ...collector.permissions,
        [permKey]: !collector.permissions[permKey],
      },
    };
    try {
      await updateCollectorInCloud({
        staffToken,
        stationId: state.station.stationId,
        collector: updated,
      });
      onUpdateState({
        ...state,
        collectors: state.collectors.map((c) =>
          c.id === collector.id ? updated : c,
        ),
      });
    } catch (err) {
      setCollectorError(
        err instanceof Error ? err.message : 'تعذر تحديث صلاحية المحصّل.',
      );
    }
  };

  return (
    <div className="space-y-8">
      {/* Header & Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex flex-wrap items-center gap-3">
            <span>لوحة مدير المحطة · {state.station.stationName}</span>
            {pendingAlertsCount > 0 && (
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-rose-800 bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-lg">
                <BellRing className="w-3.5 h-3.5" />
                {pendingAlertsCount} إشعار بانتظار المراجعة
              </span>
            )}
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            {state.station.licenseStatus === 'active'
              ? 'النسخة نشطة ومستقلة'
              : 'النسخة موقوفة من الأدمن المطور'}{' '}
            · رفع كشوفات Excel وتوليد الأكواد يتم حصراً عبر الأدمن المطور
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void handleRefreshFromServer()}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-slate-700" />
            تحديث البيانات
          </button>

          <button
            type="button"
            disabled={isSyncing}
            onClick={() => void onSyncNow()}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            {isSyncing
              ? syncProgress
                ? `دفعة ${syncProgress.currentBatch}/${syncProgress.totalBatches}...`
                : 'جاري الحفظ...'
              : metrics.pendingSyncCount > 0
                ? `حفظ ومزامنة (${metrics.pendingSyncCount})`
                : 'حفظ التعرفة والمزامنة'}
          </button>

          <button
            type="button"
            onClick={() => exportStationReportExcel(state)}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4 text-teal-700" />
            تصدير التقرير المالي (Excel)
          </button>
        </div>
      </div>

      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3">
          <span className="text-xs font-medium text-slate-500">
            إجمالي المشتركين المسجلين
          </span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold text-slate-900 font-mono-nums">
              {metrics.activeSubscribers}
            </span>
            <span className="text-xs text-slate-500">مشترك</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3">
          <span className="text-xs font-medium text-slate-500">
            المباع مقابل المولد (كشف الفاقد)
          </span>
          <div>
            <div className="text-2xl font-bold text-slate-900 font-mono-nums">
              {formatKwh(metrics.totalKwhSold)}
            </div>
            <div
              className={`text-xs mt-1 font-medium ${
                metrics.lossPercent > 15 ? 'text-amber-700' : 'text-teal-700'
              }`}
            >
              عداد المولد: {formatKwh(metrics.mainGen)} · الفاقد{' '}
              {metrics.lossPercent.toFixed(1)}%
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3">
          <span className="text-xs font-medium text-slate-500">
            إجمالي النقد المحصّل
          </span>
          <div className="text-2xl font-bold text-teal-700 font-mono-nums">
            {formatCompactYer(metrics.totalCollectedCash)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3">
          <span className="text-xs font-medium text-slate-500">
            المتأخرات غير المسددة
          </span>
          <div className="text-2xl font-bold text-rose-700 font-mono-nums">
            {formatCompactYer(metrics.totalUnpaidDebts)}
          </div>
        </div>
      </div>

      {/* Suspicious Edits & Instant Notifications Queue */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-rose-700" />
              التعديلات المشبوهة والتنبيهات الفورية ({sortedAlerts.length})
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              مرتبة حسب الوقت — لا تُعتمد أي قراءة معدلة يدوياً أو أقل من السابقة إلا بعد موافقتك
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setAlertFilter('pending')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                alertFilter === 'pending'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              بانتظار القرار ({pendingAlertsCount})
            </button>
            <button
              type="button"
              onClick={() => setAlertFilter('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                alertFilter === 'all'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              كل السجل ({(state.alerts ?? []).length})
            </button>
          </div>
        </div>

        {alertError && (
          <p className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg p-3">
            {alertError}
          </p>
        )}

        {sortedAlerts.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500">
            {alertFilter === 'pending'
              ? 'لا توجد تعديلات مشبوهة أو تنبيهات معلقة حالياً.'
              : 'لا توجد تنبيهات مسجلة حتى الآن.'}
          </div>
        ) : (
          <div className="space-y-4">
            {sortedAlerts.map((al) => {
              const isYellow = al.severity === 'warning' || al.alertType === 'high_consumption';
              const isResolved = al.status !== 'pending';
              return (
                <div
                  key={al.id}
                  className={`rounded-xl border p-4 flex flex-col lg:flex-row gap-4 justify-between ${
                    isYellow
                      ? 'bg-amber-50/90 border-amber-300'
                      : 'bg-rose-50/50 border-rose-200'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row gap-4 min-w-0">
                    {al.photoUrl ? (
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewAlertPhoto({
                            title: `${al.subscriberName} — عداد ${al.meterNumber}`,
                            url: al.photoUrl,
                          })
                        }
                        className="w-full sm:w-32 h-24 rounded-lg overflow-hidden border border-slate-300 bg-slate-900 shrink-0 cursor-pointer relative group"
                      >
                        <img
                          src={al.photoUrl}
                          alt={`صورة العداد ${al.meterNumber}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute bottom-1 right-1 bg-slate-900/80 text-white text-[10px] px-1.5 py-0.5 rounded">
                          تكبير الصورة
                        </span>
                      </button>
                    ) : (
                      <div className="w-full sm:w-32 h-24 rounded-lg border border-slate-200 bg-white flex items-center justify-center text-[11px] text-slate-400 shrink-0">
                        بدون صورة
                      </div>
                    )}

                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {isYellow ? (
                          <span className="inline-flex items-center gap-1 font-bold text-amber-900">
                            <AlertTriangle className="w-4 h-4 text-amber-600" />
                            تنبيه أصفر: استهلاك يتجاوز 3 أضعاف المتوسط
                          </span>
                        ) : al.alertType === 'lower_reading' ? (
                          <span className="inline-flex items-center gap-1 font-bold text-rose-900">
                            <ShieldAlert className="w-4 h-4 text-rose-700" />
                            قراءة أقل من السابقة —{' '}
                            {al.lowerReadingReason
                              ? LOWER_REASON_AR[al.lowerReadingReason]
                              : 'بحاجة مراجعة'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-bold text-rose-900">
                            <ShieldAlert className="w-4 h-4 text-rose-700" />
                            تعديل يدوي مشبوه لقراءة OCR
                          </span>
                        )}
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-600 font-mono-nums">
                          {new Date(al.createdAt).toLocaleString('ar-YE')}
                        </span>
                      </div>

                      <div className="text-sm font-bold text-slate-900">
                        المشترك: {al.subscriberName} (عداد{' '}
                        <span className="font-mono-nums">{al.meterNumber}</span>
                        ) · المحصّل: {al.collectorName}
                      </div>

                      {isYellow ? (
                        <div className="text-xs text-amber-950 font-mono-nums flex flex-wrap gap-3">
                          <span>
                            الاستهلاك الحالي:{' '}
                            <strong>{al.consumptionKwh ?? 0} ك.و.س</strong>
                          </span>
                          <span>·</span>
                          <span>
                            متوسط آخر 3 أشهر:{' '}
                            <strong>{al.avg3MonthsKwh ?? 0} ك.و.س</strong>
                          </span>
                          <span>·</span>
                          <span>
                            القراءة: {al.previousReading} ← {al.editedReading}
                          </span>
                        </div>
                      ) : (
                        <div className="text-xs text-slate-800 font-mono-nums flex flex-wrap gap-3">
                          {typeof al.ocrOriginalReading === 'number' && (
                            <span>
                              الأصلي من OCR:{' '}
                              <strong className="text-slate-900">
                                {al.ocrOriginalReading}
                              </strong>
                            </span>
                          )}
                          <span>
                            السابقة:{' '}
                            <strong>{al.previousReading}</strong>
                          </span>
                          <span>
                            الجديد:{' '}
                            <strong className="text-rose-800">
                              {al.editedReading}
                            </strong>
                          </span>
                          {typeof al.difference === 'number' && (
                            <span>
                              الفرق:{' '}
                              <strong dir="ltr">
                                {al.difference >= 0
                                  ? `+${al.difference}`
                                  : al.difference}
                              </strong>
                            </span>
                          )}
                          {al.newMeterNumber && (
                            <span>
                              العداد الجديد: <strong>{al.newMeterNumber}</strong>{' '}
                              (افتتاحية {al.openingReading ?? 0})
                            </span>
                          )}
                        </div>
                      )}

                      {isResolved && (
                        <div
                          className={`text-xs font-bold ${
                            al.status === 'approved'
                              ? 'text-teal-800'
                              : 'text-rose-800'
                          }`}
                        >
                          {al.status === 'approved'
                            ? `تم قبول واعتماد القراءة بواسطة ${al.resolvedBy || 'المدير'}`
                            : `تم رفض التعديل بواسطة ${al.resolvedBy || 'المدير'}`}
                        </div>
                      )}
                    </div>
                  </div>

                  {!isResolved && (
                    <div className="flex sm:flex-row lg:flex-col items-stretch sm:items-center lg:items-end justify-end gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={resolvingId === al.id}
                        onClick={() => void handleResolveAlert(al, 'approved')}
                        className="min-h-[40px] px-4 py-2 text-xs font-bold bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Check className="w-4 h-4" />
                        {isYellow ? 'إقرار المراجعة' : 'قبول التعديل'}
                      </button>
                      {!isYellow && (
                        <button
                          type="button"
                          disabled={resolvingId === al.id}
                          onClick={() =>
                            void handleResolveAlert(al, 'rejected')
                          }
                          className="min-h-[40px] px-4 py-2 text-xs font-bold bg-white border border-rose-300 text-rose-800 hover:bg-rose-100 disabled:opacity-50 rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                          رفض التعديل
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Main Grid: Tariff Settings + Collectors Supervision */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 mb-4">
            <Zap className="w-5 h-5 text-teal-700" />
            إعدادات التعرفة والمولد الرئيسي
          </h2>
          <form onSubmit={handleSaveTariff} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                اسم المحطة التجارية
              </label>
              <input
                type="text"
                value={stationName}
                onChange={(e) => setStationName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  سعر الكيلووات (ريال يمني)
                </label>
                <input
                  type="number"
                  min={0}
                  value={kwhPrice}
                  onChange={(e) => setKwhPrice(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  الحد الأدنى للاشتراك (ر.ي)
                </label>
                <input
                  type="number"
                  min={0}
                  value={minFee}
                  onChange={(e) => setMinFee(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                إجمالي توليد المولد الرئيسي لهذا الشهر (ك.و.س)
              </label>
              <input
                type="number"
                min={0}
                value={mainGenKwh}
                onChange={(e) => setMainGenKwh(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
            >
              {tariffSaved
                ? 'تم الحفظ محلياً (اضغط حفظ التعرفة والمزامنة)'
                : 'حفظ التعرفة وإعدادات المولد'}
            </button>
          </form>
        </section>

        {/* Collectors Permissions & Activation Supervision */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Users className="w-5 h-5 text-teal-700" />
              متابعة وتفعيل المحصّلين التابعين للمحطة
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              يُصدر الأدمن المطور أكواد المحصّلين، ويمكنك هنا التحكم بتفعيل المحصّل وصلاحياته الميدانية.
            </p>
          </div>

          {collectorError && (
            <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
              {collectorError}
            </p>
          )}

          <div className="divide-y divide-slate-100 border-t border-slate-100">
            {state.collectors.map((col) => (
              <div
                key={col.id}
                className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div>
                  <div className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <span>{col.name}</span>
                    {col.code && (
                      <span
                        dir="ltr"
                        className="text-[11px] font-mono-nums text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded"
                      >
                        {col.code}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {col.phone || 'بدون هاتف'} · المناطق:{' '}
                    {col.assignedZones.length > 0
                      ? col.assignedZones.join('، ')
                      : 'جميع المناطق'}
                  </div>
                  <div className="flex flex-wrap gap-3 mt-2.5 text-xs">
                    {(
                      [
                        ['canRecordReadings', 'تسجيل القراءات'],
                        ['canCollectCash', 'تحصيل نقدي'],
                        ['canSendInvoices', 'إرسال فواتير'],
                        ['canViewDebts', 'عرض المتأخرات'],
                      ] as const
                    ).map(([permKey, label]) => (
                      <label
                        key={permKey}
                        className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700"
                      >
                        <input
                          type="checkbox"
                          checked={col.permissions[permKey]}
                          onChange={() =>
                            void handleToggleCollectorPermission(col, permKey)
                          }
                          className="accent-teal-700"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleToggleCollectorActive(col)}
                  className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    col.active
                      ? 'border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100'
                      : 'border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100'
                  }`}
                >
                  {col.active ? 'حساب مفعّل (إيقاف)' : 'حساب موقوف (تفعيل)'}
                </button>
              </div>
            ))}
            {state.collectors.length === 0 && (
              <div className="py-6 text-center text-xs text-slate-500">
                لا يوجد محصّلون مرتبطون بهذه المحطة بعد. يولّد الأدمن المطور أكواد المحصّلين من لوحة الأدمن.
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Subscribers Ledger Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              سجل المشتركين والعدادات ({filteredSubscribers.length})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              مرتّب حسب تسلسل خط السير الميداني
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث برقم العداد أو الاسم..."
                className="pr-9 pl-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <select
              value={zoneFilter}
              onChange={(e) => setZoneFilter(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="all">كل الحارات والشوارع</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-right">
            <thead className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-medium">الترتيب</th>
                <th className="py-3 px-4 font-medium">رقم العداد</th>
                <th className="py-3 px-4 font-medium">اسم المشترك</th>
                <th className="py-3 px-4 font-medium">الحارة / الشارع</th>
                <th className="py-3 px-4 font-medium">القراءة السابقة</th>
                <th className="py-3 px-4 font-medium">القراءة الحالية</th>
                <th className="py-3 px-4 font-medium">المتأخرات</th>
                <th className="py-3 px-4 font-medium">المزامنة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredSubscribers.slice(0, 200).map((sub) => {
                const latestRd = latestReadingBySubscriber.get(sub.id);
                return (
                  <tr
                    key={sub.id}
                    className="hover:bg-slate-50/70 transition-colors"
                  >
                    <td className="py-3 px-4 font-mono-nums text-slate-500">
                      {sub.sequenceOrder}
                    </td>
                    <td className="py-3 px-4 font-mono-nums font-semibold text-slate-900">
                      {sub.meterNumber}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">
                        {sub.subscriberName}
                      </div>
                      <div className="text-xs text-slate-500 font-mono-nums">
                        {sub.phone}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-700">
                      {sub.zoneStreet}
                    </td>
                    <td className="py-3 px-4 font-mono-nums text-slate-700">
                      {sub.previousReading}
                    </td>
                    <td className="py-3 px-4 font-mono-nums text-slate-900 font-medium">
                      <div>{sub.currentReading}</div>
                      {latestRd?.isClosedHouseZero && (
                        <div className="text-[11px] font-sans text-sky-800 font-medium">
                          استهلاك صفر - بيت مغلق
                        </div>
                      )}
                      {latestRd?.approvalStatus === 'pending_manager' && (
                        <div className="text-[11px] font-sans text-rose-700 font-medium">
                          بانتظار موافقة المدير ({latestRd.currentReading})
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono-nums font-medium text-slate-900">
                      {formatYer(sub.previousDebtYer)}
                    </td>
                    <td className="py-3 px-4 text-xs">
                      <span
                        className={
                          sub.syncStatus === 'synced'
                            ? 'text-teal-700 font-medium'
                            : 'text-amber-700 font-medium'
                        }
                      >
                        {sub.syncStatus === 'synced' ? 'متزامن' : 'معلق'}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {filteredSubscribers.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-500">
                    لا يوجد مشتركين في هذه المحطة بعد. يرفع الأدمن المطور كشف Excel للمحطة.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Alert Proof Photo Zoom Modal */}
      {previewAlertPhoto && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
          onClick={() => setPreviewAlertPhoto(null)}
        >
          <div
            className="bg-white rounded-2xl max-w-2xl w-full overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <span className="text-sm font-bold text-slate-900">
                صورة العداد · {previewAlertPhoto.title}
              </span>
              <button
                type="button"
                onClick={() => setPreviewAlertPhoto(null)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="bg-slate-900 max-h-[75vh] flex items-center justify-center">
              <img
                src={previewAlertPhoto.url}
                alt={previewAlertPhoto.title}
                referrerPolicy="no-referrer"
                className="max-h-[75vh] w-auto object-contain"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
