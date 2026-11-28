import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BellRing,
  Check,
  Download,
  Flame,
  HardDrive,
  Lock,
  MapPin,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
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
  saveStationTariffInCloud,
  updateCollectorInCloud,
  type StationLocalState,
} from '../lib/offlineDb';
import { CollectorTrackingMap } from './CollectorTrackingMap';
import { DieselProfitLossSection } from './DieselProfitLossSection';
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

type ManagerTab =
  | 'overview_loss'
  | 'alerts'
  | 'collectors_map'
  | 'finance'
  | 'subscribers';

interface ManagerDashboardProps {
  state: StationLocalState;
  staffToken: string;
  onUpdateState: (next: StationLocalState) => void;
  onSyncNow: (options?: { silent?: boolean }) => Promise<void>;
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
  const [activeTab, setActiveTab] = useState<ManagerTab>('overview_loss');
  const [searchQuery, setSearchQuery] = useState('');
  const [zoneFilter, setZoneFilter] = useState<string>('all');
  const [lossZoneFilter, setLossZoneFilter] = useState<string>('all');
  const [zoneShareDrafts, setZoneShareDrafts] = useState<Record<string, string>>(
    () => {
      const init: Record<string, string> = {};
      Object.entries(state.station.zoneGeneratorKwh ?? {}).forEach(([k, v]) => {
        init[k] = String(v);
      });
      return init;
    },
  );
  const [savingZoneShares, setSavingZoneShares] = useState(false);
  const [zoneShareSavedNotice, setZoneShareSavedNotice] = useState<string | null>(
    null,
  );
  const [alertFilter, setAlertFilter] = useState<'pending' | 'all'>('pending');
  const [tariffSaved, setTariffSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
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
    state.subscribers.forEach((s) => set.add(s.zoneStreet || 'عام'));
    return Array.from(set);
  }, [state.subscribers]);

  const zoneLossRows = useMemo(() => {
    const subsByZone = new Map<string, number>();
    const subToZone = new Map<string, string>();

    state.subscribers.forEach((sub) => {
      const z = sub.zoneStreet?.trim() || 'عام';
      subToZone.set(sub.id, z);
      subsByZone.set(z, (subsByZone.get(z) ?? 0) + 1);
    });

    const soldByZone = new Map<string, number>();
    state.readings.forEach((rd) => {
      if (rd.approvalStatus === 'rejected') return;
      const z = subToZone.get(rd.subscriberId) || 'عام';
      soldByZone.set(z, (soldByZone.get(z) ?? 0) + rd.consumptionKwh);
    });

    const customShares = state.station.zoneGeneratorKwh ?? {};
    const allZoneNames = Array.from(
      new Set([...subsByZone.keys(), ...Object.keys(customShares)]),
    );

    let customTotalKwh = 0;
    let autoSubscribersTotal = 0;

    allZoneNames.forEach((z) => {
      const draftStr = zoneShareDrafts[z];
      const hasDraft = draftStr !== undefined && draftStr.trim() !== '';
      const val = hasDraft ? Number(draftStr) : customShares[z];
      if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
        customTotalKwh += val;
      } else {
        autoSubscribersTotal += subsByZone.get(z) ?? 0;
      }
    });

    const remainingPool = Math.max(
      0,
      state.station.mainGeneratorKwh - customTotalKwh,
    );

    const rows = allZoneNames.map((zoneName) => {
      const subscribersCount = subsByZone.get(zoneName) ?? 0;
      const soldKwh =
        Math.round((soldByZone.get(zoneName) ?? 0) * 100) / 100;

      const draftStr = zoneShareDrafts[zoneName];
      const hasDraft = draftStr !== undefined && draftStr.trim() !== '';
      const rawCustom = hasDraft ? Number(draftStr) : customShares[zoneName];
      const isCustomShare =
        typeof rawCustom === 'number' &&
        Number.isFinite(rawCustom) &&
        rawCustom >= 0;

      const generatorShareKwh = isCustomShare
        ? Math.round(rawCustom * 100) / 100
        : autoSubscribersTotal > 0
          ? Math.round(
              remainingPool * (subscribersCount / autoSubscribersTotal) * 100,
            ) / 100
          : 0;

      const lossKwh = Math.max(
        0,
        Math.round((generatorShareKwh - soldKwh) * 100) / 100,
      );
      const lossPercent =
        generatorShareKwh > 0
          ? Math.round((lossKwh / generatorShareKwh) * 100 * 10) / 10
          : 0;

      const severity: 'ok' | 'warn' | 'critical' =
        lossPercent > 20 ? 'critical' : lossPercent >= 10 ? 'warn' : 'ok';

      return {
        zoneName,
        subscribersCount,
        soldKwh,
        generatorShareKwh,
        isCustomShare,
        lossKwh,
        lossPercent,
        severity,
      };
    });

    return rows.sort((a, b) => {
      const aCrit = a.lossPercent > 20 ? 1 : 0;
      const bCrit = b.lossPercent > 20 ? 1 : 0;
      if (aCrit !== bCrit) return bCrit - aCrit;
      return b.lossPercent - a.lossPercent;
    });
  }, [
    state.subscribers,
    state.readings,
    state.station.mainGeneratorKwh,
    state.station.zoneGeneratorKwh,
    zoneShareDrafts,
  ]);

  const filteredZoneLossRows = useMemo(() => {
    if (lossZoneFilter === 'all') return zoneLossRows;
    return zoneLossRows.filter((r) => r.zoneName === lossZoneFilter);
  }, [zoneLossRows, lossZoneFilter]);

  const criticalLossZonesCount = useMemo(
    () => zoneLossRows.filter((r) => r.lossPercent > 20).length,
    [zoneLossRows],
  );

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

  // Auto-poll server & Firestore every 15s (and on reconnect) for seamless silent sync
  useEffect(() => {
    if (!staffToken) return;
    const syncAndPull = async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      try {
        if (metrics.pendingSyncCount > 0 && !isSyncing) {
          await onSyncNow({ silent: true });
        }
        const updated = await refreshStationState(
          state.station.stationId,
          staffToken,
        );
        onUpdateState(updated);
      } catch {
        // silent background poll
      }
    };
    const timer = window.setInterval(() => {
      void syncAndPull();
    }, 15000);
    const onOnline = () => {
      void syncAndPull();
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [
    state.station.stationId,
    staffToken,
    onUpdateState,
    onSyncNow,
    metrics.pendingSyncCount,
    isSyncing,
  ]);

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

  const pendingPhotoMismatchCount = useMemo(
    () =>
      (state.alerts ?? []).filter(
        (al) => al.status === 'pending' && al.alertType === 'photo_mismatch',
      ).length,
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
    setRecoveryNotice(null);
    try {
      const updated = await refreshStationState(
        state.station.stationId,
        staffToken,
      );
      onUpdateState(updated);
      setRecoveryNotice(
        `تمت الاستعادة اللحظية للنصوص والأرقام (${updated.subscribers.length} مشترك، ${updated.readings.length} قراءة، ${updated.receipts.length} سند قبض).`,
      );
      setTimeout(() => setRecoveryNotice(null), 4000);
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

  const handleSaveZoneShares = async () => {
    setSavingZoneShares(true);
    setZoneShareSavedNotice(null);
    const nextMap: Record<string, number> = {};
    Object.entries(zoneShareDrafts).forEach(([zoneName, rawVal]) => {
      if (rawVal.trim() !== '') {
        const parsed = Number(rawVal);
        if (Number.isFinite(parsed) && parsed >= 0) {
          nextMap[zoneName] = parsed;
        }
      }
    });
    const nextStation = {
      ...state.station,
      zoneGeneratorKwh: nextMap,
      updatedAt: new Date().toISOString(),
    };
    const nextState: StationLocalState = {
      ...state,
      station: nextStation,
    };
    onUpdateState(nextState);
    try {
      await saveStationTariffInCloud(staffToken, nextStation);
      setZoneShareSavedNotice('تم حفظ حصص المولد لكل حارة ومزامنتها بنجاح.');
    } catch {
      setZoneShareSavedNotice(
        'تم حفظ حصص المولد محلياً — اضغط مزامنة عند توفر الاتصال.',
      );
    } finally {
      setSavingZoneShares(false);
      setTimeout(() => setZoneShareSavedNotice(null), 3500);
    }
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

  const aiEnabled = Boolean(state.station.aiPhotoVerificationEnabled);

  return (
    <div className="space-y-5">
      {/* Header & Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 flex flex-wrap items-center gap-3">
            <span>لوحة مدير المحطة · {state.station.stationName}</span>
            {pendingAlertsCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('alerts')}
                className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg border cursor-pointer ${
                  pendingPhotoMismatchCount > 0
                    ? 'bg-rose-600 text-white border-rose-700 animate-pulse'
                    : 'text-rose-800 bg-rose-50 border-rose-200'
                }`}
              >
                <BellRing className="w-3.5 h-3.5" />
                {pendingAlertsCount} تنبيه بانتظار المراجعة
              </button>
            )}
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            {state.station.licenseStatus === 'active'
              ? 'النسخة نشطة ومستقلة'
              : 'النسخة موقوفة من الأدمن المطور'}{' '}
            · صور العدادات محفوظة محلياً في هواتف المحصّلين، وبيانات النصوص والأرقام محفوظة للاستعادة اللحظية
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void handleRefreshFromServer()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-4 h-4 text-slate-700 ${refreshing ? 'animate-spin' : ''}`}
            />
            {refreshing ? 'جاري الاستعادة...' : 'استعادة لحظية / تحديث'}
          </button>

          <button
            type="button"
            disabled={isSyncing}
            onClick={() => void onSyncNow()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
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
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4 text-teal-700" />
            تصدير Excel
          </button>
        </div>
      </div>

      {recoveryNotice && (
        <div className="text-xs font-bold text-teal-900 bg-teal-50 border border-teal-200 rounded-lg px-4 py-2.5">
          {recoveryNotice}
        </div>
      )}

      {/* Instant Critical Red Alert Banner for AI Photo-Reading Mismatch */}
      {pendingPhotoMismatchCount > 0 && activeTab !== 'alerts' && (
        <div className="bg-rose-50 border-2 border-rose-500 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-rose-900">
            <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0" />
            <div className="text-xs sm:text-sm font-bold">
              تنبيه أحمر فوري: تم رصد{' '}
              <span className="font-mono-nums underline">
                {pendingPhotoMismatchCount}
              </span>{' '}
              قراءة غير مطابقة لصورة العداد!
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('alerts')}
            className="px-3.5 py-2 text-xs font-bold bg-rose-700 hover:bg-rose-800 text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            مراجعة التنبيه الأحمر فوراً
          </button>
        </div>
      )}

      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-2">
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

        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-2">
          <span className="text-xs font-medium text-slate-500">
            المباع مقابل المولد (كشف الفاقد)
          </span>
          <div>
            <div className="text-2xl font-bold text-slate-900 font-mono-nums">
              {formatKwh(metrics.totalKwhSold)}
            </div>
            <div
              className={`text-xs mt-1 font-medium ${
                metrics.lossPercent > 20
                  ? 'text-rose-700'
                  : metrics.lossPercent >= 10
                    ? 'text-amber-700'
                    : 'text-teal-700'
              }`}
            >
              المولد: {formatKwh(metrics.mainGen)} · الإجمالي{' '}
              {metrics.lossPercent.toFixed(1)}%
              {criticalLossZonesCount > 0
                ? ` · ${criticalLossZonesCount} حارة فوق 20%!`
                : ` · ${zoneLossRows.length} حارة`}
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-2">
          <span className="text-xs font-medium text-slate-500">
            إجمالي النقد المحصّل
          </span>
          <div className="text-2xl font-bold text-teal-700 font-mono-nums">
            {formatCompactYer(metrics.totalCollectedCash)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-2">
          <span className="text-xs font-medium text-slate-500">
            المتأخرات غير المسددة
          </span>
          <div className="text-2xl font-bold text-rose-700 font-mono-nums">
            {formatCompactYer(metrics.totalUnpaidDebts)}
          </div>
        </div>
      </div>

      {/* Centered Workspace Tabs Grid (No Horizontal Scroll) */}
      <nav
        aria-label="تبويبات لوحة مدير المحطة"
        className="grid grid-cols-2 md:grid-cols-6 gap-3 sm:gap-4 max-w-4xl mx-auto justify-center"
      >
        <button
          type="button"
          onClick={() => setActiveTab('overview_loss')}
          className={`col-span-1 md:col-span-2 w-full min-h-[64px] flex flex-col items-center justify-center gap-1.5 text-center px-3 py-2.5 text-xs sm:text-sm font-bold rounded-2xl border transition-colors cursor-pointer ${
            activeTab === 'overview_loss'
              ? 'bg-[#0F766E] border-[#0F766E] text-white shadow-sm'
              : 'bg-white border-gray-200 text-black hover:bg-slate-50'
          }`}
        >
          <BarChart3
            className={`w-5 h-5 shrink-0 ${
              activeTab === 'overview_loss' ? 'text-white' : 'text-[#0F766E]'
            }`}
          />
          <span className="inline-flex items-center justify-center gap-1.5 flex-wrap leading-snug">
            <span>الفاقد والتعرفة</span>
            {criticalLossZonesCount > 0 && (
              <span
                className={`px-1.5 py-0.5 text-[11px] font-mono-nums rounded ${
                  activeTab === 'overview_loss'
                    ? 'bg-rose-500 text-white'
                    : 'bg-rose-100 text-rose-800'
                }`}
              >
                {criticalLossZonesCount}
              </span>
            )}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('alerts')}
          className={`col-span-1 md:col-span-2 w-full min-h-[64px] flex flex-col items-center justify-center gap-1.5 text-center px-3 py-2.5 text-xs sm:text-sm font-bold rounded-2xl border transition-colors cursor-pointer ${
            activeTab === 'alerts'
              ? 'bg-[#0F766E] border-[#0F766E] text-white shadow-sm'
              : 'bg-white border-gray-200 text-black hover:bg-slate-50'
          }`}
        >
          <ShieldAlert
            className={`w-5 h-5 shrink-0 ${
              activeTab === 'alerts' ? 'text-white' : 'text-[#0F766E]'
            }`}
          />
          <span className="inline-flex items-center justify-center gap-1.5 flex-wrap leading-snug">
            <span>التنبيهات الفورية</span>
            {pendingAlertsCount > 0 && (
              <span
                className={`px-1.5 py-0.5 text-[11px] font-mono-nums rounded ${
                  pendingPhotoMismatchCount > 0
                    ? 'bg-rose-600 text-white'
                    : activeTab === 'alerts'
                      ? 'bg-white/20 text-white'
                      : 'bg-amber-100 text-amber-900'
                }`}
              >
                {pendingAlertsCount}
              </span>
            )}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('collectors_map')}
          className={`col-span-1 md:col-span-2 w-full min-h-[64px] flex flex-col items-center justify-center gap-1.5 text-center px-3 py-2.5 text-xs sm:text-sm font-bold rounded-2xl border transition-colors cursor-pointer ${
            activeTab === 'collectors_map'
              ? 'bg-[#0F766E] border-[#0F766E] text-white shadow-sm'
              : 'bg-white border-gray-200 text-black hover:bg-slate-50'
          }`}
        >
          <MapPin
            className={`w-5 h-5 shrink-0 ${
              activeTab === 'collectors_map' ? 'text-white' : 'text-[#0F766E]'
            }`}
          />
          <span className="leading-snug">
            المحصلون والتتبع المباشر ({state.collectors.length})
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('finance')}
          className={`col-span-1 md:col-span-2 md:col-start-2 w-full min-h-[64px] flex flex-col items-center justify-center gap-1.5 text-center px-3 py-2.5 text-xs sm:text-sm font-bold rounded-2xl border transition-colors cursor-pointer ${
            activeTab === 'finance'
              ? 'bg-[#0F766E] border-[#0F766E] text-white shadow-sm'
              : 'bg-white border-gray-200 text-black hover:bg-slate-50'
          }`}
        >
          <Flame
            className={`w-5 h-5 shrink-0 ${
              activeTab === 'finance' ? 'text-white' : 'text-[#0F766E]'
            }`}
          />
          <span className="leading-snug">الديزل والأرباح</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('subscribers')}
          className={`col-span-2 md:col-span-2 md:col-start-4 w-full min-h-[64px] flex flex-col items-center justify-center gap-1.5 text-center px-3 py-2.5 text-xs sm:text-sm font-bold rounded-2xl border transition-colors cursor-pointer ${
            activeTab === 'subscribers'
              ? 'bg-[#0F766E] border-[#0F766E] text-white shadow-sm'
              : 'bg-white border-gray-200 text-black hover:bg-slate-50'
          }`}
        >
          <Users
            className={`w-5 h-5 shrink-0 ${
              activeTab === 'subscribers' ? 'text-white' : 'text-[#0F766E]'
            }`}
          />
          <span className="leading-snug">
            سجل المشتركين ({state.subscribers.length})
          </span>
        </button>
      </nav>

      {/* TAB 1: Side-by-Side Power Loss Table + Tariff & Admin-Encrypted AI Verification Card */}
      {activeTab === 'overview_loss' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Zone-by-Zone Power Loss Breakdown Table */}
          <section className="xl:col-span-8 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-slate-900 flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-teal-700" />
                  الفاقد حسب الحارة / الشارع
                </h2>
                <p className="text-xs text-slate-600 mt-1">
                  تفصيل المباع مقابل حصة المولد لكل حارة (ترتفع الحارات الأعلى من 20% للأعلى تلقائياً)
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <select
                  value={lossZoneFilter}
                  onChange={(e) => setLossZoneFilter(e.target.value)}
                  className="min-h-[42px] px-3 py-1.5 text-xs sm:text-sm font-bold border border-slate-300 rounded-lg bg-white"
                >
                  <option value="all">كل الحارات ({zoneLossRows.length})</option>
                  {zoneLossRows.map((row) => (
                    <option key={row.zoneName} value={row.zoneName}>
                      {row.zoneName}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={savingZoneShares}
                  onClick={() => void handleSaveZoneShares()}
                  className="min-h-[42px] px-4 py-2 text-xs font-bold bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {savingZoneShares ? 'جاري الحفظ...' : 'حفظ حصص الحارات'}
                </button>
              </div>
            </div>

            {zoneShareSavedNotice && (
              <div className="text-xs font-bold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                {zoneShareSavedNotice}
              </div>
            )}

            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-sm text-right">
                <thead className="bg-slate-50 text-slate-700 text-xs border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-3 font-bold">الحارة</th>
                    <th className="py-3 px-3 font-bold">المشتركين</th>
                    <th className="py-3 px-3 font-bold">المباع (ك.و)</th>
                    <th className="py-3 px-3 font-bold">حصة المولد</th>
                    <th className="py-3 px-3 font-bold">الفاقد (ك.و)</th>
                    <th className="py-3 px-3 font-bold">النسبة %</th>
                    <th className="py-3 px-3 font-bold">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredZoneLossRows.map((row) => {
                    const rowHighlight =
                      row.severity === 'critical'
                        ? 'bg-rose-50/70'
                        : row.severity === 'warn'
                          ? 'bg-amber-50/50'
                          : 'hover:bg-slate-50/70';
                    const badgeClass =
                      row.severity === 'critical'
                        ? 'bg-rose-100 text-rose-900 border-rose-300'
                        : row.severity === 'warn'
                          ? 'bg-amber-100 text-amber-900 border-amber-300'
                          : 'bg-emerald-100 text-emerald-900 border-emerald-300';
                    const statusLabel =
                      row.severity === 'critical'
                        ? 'يوجد سرقة محتملة - راجع الحارة'
                        : row.severity === 'warn'
                          ? 'انتبه'
                          : 'سليم';

                    return (
                      <tr key={row.zoneName} className={rowHighlight}>
                        <td className="py-3 px-3 font-bold text-slate-900">
                          {row.zoneName}
                        </td>
                        <td className="py-3 px-3 font-mono-nums font-semibold text-slate-800">
                          {row.subscribersCount}
                        </td>
                        <td className="py-3 px-3 font-mono-nums font-bold text-slate-900">
                          {formatKwh(row.soldKwh)}
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              min={0}
                              step="any"
                              value={zoneShareDrafts[row.zoneName] ?? ''}
                              onChange={(e) =>
                                setZoneShareDrafts((prev) => ({
                                  ...prev,
                                  [row.zoneName]: e.target.value,
                                }))
                              }
                              placeholder={String(row.generatorShareKwh)}
                              className="w-24 min-h-[36px] px-2 py-1 text-xs sm:text-sm font-bold font-mono-nums border border-slate-300 rounded-lg bg-white"
                            />
                            <span className="text-[11px] text-slate-500 whitespace-nowrap">
                              {row.isCustomShare ? 'مخصص' : 'نسبي'}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono-nums font-bold text-slate-900">
                          {formatKwh(row.lossKwh)}
                        </td>
                        <td
                          className={`py-3 px-3 font-mono-nums font-extrabold ${
                            row.severity === 'critical'
                              ? 'text-rose-800'
                              : row.severity === 'warn'
                                ? 'text-amber-800'
                                : 'text-emerald-800'
                          }`}
                        >
                          {row.lossPercent.toFixed(1)}%
                        </td>
                        <td className="py-3 px-3">
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-extrabold whitespace-nowrap ${badgeClass}`}
                          >
                            {statusLabel}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredZoneLossRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="py-8 text-center text-xs text-slate-500"
                      >
                        لا توجد بيانات حارات مسجلة لعرض الفاقد بعد.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Adjacent Right Panel: Tariff Settings + Admin-Encrypted AI Verification Field */}
          <div className="xl:col-span-4 space-y-5">
            {/* Admin-Only Cryptographically Sealed Gemini Vision-AI Field */}
            <section
              className={`rounded-xl border p-5 space-y-3 ${
                aiEnabled
                  ? 'bg-emerald-50/70 border-emerald-300'
                  : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="text-xs font-extrabold text-slate-900 flex items-center gap-1.5">
                    <Lock className="w-4 h-4 text-teal-700 shrink-0" />
                    <span>مطابقة صورة العداد مع رقم القراءة المحصل</span>
                  </div>
                  <div className="text-[11px] text-slate-600 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                    <span>التحقق الآلي من الصورة · حقل مشفر للأدمن فقط</span>
                  </div>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold border whitespace-nowrap shrink-0 ${
                    aiEnabled
                      ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                      : 'bg-white text-slate-600 border-slate-300'
                  }`}
                >
                  {aiEnabled ? 'مفعّل ومشفّر' : 'مقفل (معطّل)'}
                </span>
              </div>

              <p className="text-xs text-slate-700 leading-relaxed">
                {aiEnabled
                  ? 'يتم التحقق آلياً من مطابقة صورة العداد مع الرقم المدخل لمنع أي خطأ يدوي أو تلاعب، مع إطلاق تنبيه أحمر فوري هنا وعند المحصّل فور أي اختلاف.'
                  : 'هذا الحقل مشفر ولا يملك مدير المحطة أو المحصّل صلاحية تعديله؛ يُفعّل حصراً من لوحة الأدمن المطور.'}
              </p>

              {aiEnabled && state.station.aiPhotoVerificationSealed && (
                <div
                  dir="ltr"
                  className="text-[10px] font-mono-nums text-emerald-800 bg-white/80 border border-emerald-200 rounded-lg px-2.5 py-1.5 truncate"
                >
                  {state.station.aiPhotoVerificationSealed}
                </div>
              )}
            </section>

            {/* Tariff & Generator Form */}
            <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
              <h2 className="text-base sm:text-lg font-bold text-slate-900 flex items-center gap-2 mb-4">
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
                    className="w-full min-h-[44px] px-3 py-2 text-base font-bold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      سعر الكيلووات (ر.ي)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={kwhPrice}
                      onChange={(e) => setKwhPrice(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      الحد الأدنى (ر.ي)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={minFee}
                      onChange={(e) => setMinFee(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
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
                    className="w-full min-h-[44px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
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
          </div>
        </div>
      )}

      {/* TAB 2: Instant Red AI Photo-Verification Alerts & Field Alerts Queue */}
      {activeTab === 'alerts' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <section className="xl:col-span-9 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <ShieldAlert className="w-5 h-5 text-rose-700" />
                  التنبيهات الفورية ومطابقة الصور ({sortedAlerts.length})
                </h2>
                <p className="text-xs text-slate-600 mt-1">
                  مرتبة حسب الوقت — يتم إطلاق تنبيه أحمر فوري عند عدم مطابقة صورة العداد مع رقم القراءة أو عند تسجيل قراءة أقل من السابقة
                </p>
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
                <button
                  type="button"
                  onClick={() => setAlertFilter('pending')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
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
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
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
              <div className="py-10 text-center text-xs text-slate-500">
                {alertFilter === 'pending'
                  ? 'لا توجد تنبيهات معلقة بانتظار المراجعة حالياً.'
                  : 'لا توجد تنبيهات مسجلة حتى الآن.'}
              </div>
            ) : (
              <div className="space-y-4">
                {sortedAlerts.map((al) => {
                  const isYellow =
                    al.severity === 'warning' ||
                    al.alertType === 'high_consumption';
                  const isAiMismatch = al.alertType === 'photo_mismatch';
                  const isResolved = al.status !== 'pending';

                  return (
                    <div
                      key={al.id}
                      className={`rounded-xl border p-4 flex flex-col lg:flex-row gap-4 justify-between ${
                        isAiMismatch
                          ? 'bg-rose-50 border-2 border-rose-500'
                          : isYellow
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
                          <div className="w-full sm:w-36 h-24 rounded-lg border border-slate-200 bg-white p-2 flex flex-col items-center justify-center text-center gap-1 text-[11px] text-slate-500 shrink-0">
                            <HardDrive className="w-4 h-4 text-teal-700" />
                            <span>صورة العداد محفوظة في هاتف المحصّل محلياً</span>
                          </div>
                        )}

                        <div className="space-y-1.5 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            {isAiMismatch ? (
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-rose-700 text-white font-extrabold">
                                <Sparkles className="w-3.5 h-3.5" />
                                تنبيه أحمر فوري: عدم مطابقة صورة العداد مع رقم القراءة
                              </span>
                            ) : isYellow ? (
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
                              <span className="inline-flex items-center gap-1 font-bold text-slate-800">
                                <ShieldAlert className="w-4 h-4 text-slate-600" />
                                سجل مراجعة قراءة سابقة
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

                          {isAiMismatch ? (
                            <div className="space-y-1">
                              <div className="text-xs text-rose-950 font-mono-nums flex flex-wrap gap-3">
                                <span>
                                  قراءة الصورة:{' '}
                                  <strong className="text-rose-800">
                                    {al.aiDetectedReading !== undefined &&
                                    al.aiDetectedReading !== null
                                      ? al.aiDetectedReading
                                      : 'غير مقروءة بوضوح'}
                                  </strong>
                                </span>
                                <span>·</span>
                                <span>
                                  القراءة المدخلة من المحصّل:{' '}
                                  <strong className="text-slate-900">
                                    {al.editedReading}
                                  </strong>
                                </span>
                                {typeof al.aiConfidence === 'number' && (
                                  <>
                                    <span>·</span>
                                    <span>
                                      الثقة:{' '}
                                      <strong>
                                        {Math.round(al.aiConfidence * 100)}%
                                      </strong>
                                    </span>
                                  </>
                                )}
                              </div>
                              {al.aiVerificationReason && (
                                <p className="text-xs text-rose-900 font-medium">
                                  تفاصيل المطابقة: {al.aiVerificationReason}
                                </p>
                              )}
                            </div>
                          ) : isYellow ? (
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
                                السابقة: <strong>{al.previousReading}</strong>
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
                                : `تم رفض القراءة بواسطة ${al.resolvedBy || 'المدير'}`}
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
                            className="min-h-[40px] px-4 py-2 text-xs font-bold bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                          >
                            <Check className="w-4 h-4" />
                            {isYellow ? 'إقرار المراجعة' : 'اعتماد القراءة'}
                          </button>
                          {!isYellow && (
                            <button
                              type="button"
                              disabled={resolvingId === al.id}
                              onClick={() =>
                                void handleResolveAlert(al, 'rejected')
                              }
                              className="min-h-[40px] px-4 py-2 text-xs font-bold bg-white border border-rose-300 text-rose-800 hover:bg-rose-100 disabled:opacity-50 rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                            >
                              <X className="w-4 h-4" />
                              رفض القراءة
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

          {/* Adjacent Side Column: Admin-Locked AI Verification Status & Storage Policy */}
          <aside className="xl:col-span-3 space-y-4">
            <div
              className={`rounded-xl border p-5 space-y-3 ${
                aiEnabled
                  ? 'bg-emerald-50/70 border-emerald-300'
                  : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-extrabold text-slate-900">
                <Lock className="w-4 h-4 text-teal-700 shrink-0" />
                <span>مطابقة صورة العداد مع رقم القراءة المحصل</span>
              </div>
              <div
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold ${
                  aiEnabled
                    ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                    : 'bg-white text-slate-700 border-slate-300'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                {aiEnabled
                  ? 'مفعّل ومشفّر للمطابقة التلقائية'
                  : 'معطّل (يُفعّل من الأدمن فقط)'}
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                لا تتاح صلاحية تعديل هذا الحقل لمدير المحطة. عند التفعيل، تُطابق كل صورة عداد مع الرقم المدخل لحظياً مع إظهار تنبيه أحمر فوري عند الاختلاف.
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                <HardDrive className="w-4 h-4 text-teal-700" />
                سياسة حفظ الصور والاستعادة
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                صور العدادات محفوظة في ذاكرة هاتف المحصّل محلياً ولا تُرفع إلى السحابة تلقائياً. تُحفظ النصوص والأرقام والمتأخرات وسندات القبض في السحابة للاستعادة اللحظية.
              </p>
            </div>
          </aside>
        </div>
      )}

      {/* TAB 3: Side-by-Side Collectors Supervision & Live GPS Map */}
      {activeTab === 'collectors_map' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <section className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 flex items-center gap-2">
                <Users className="w-5 h-5 text-teal-700" />
                متابعة وتفعيل المحصّلين ({state.collectors.length})
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
                  className="py-4 flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900 flex flex-wrap items-center gap-2">
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
                        {col.phone || 'بدون هاتف'} · الحارات:{' '}
                        {col.assignedZones.length > 0
                          ? col.assignedZones.join('، ')
                          : 'جميع الحارات'}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleToggleCollectorActive(col)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        col.active
                          ? 'border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100'
                          : 'border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100'
                      }`}
                    >
                      {col.active ? 'مفعّل (إيقاف)' : 'موقوف (تفعيل)'}
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-3 text-xs">
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
              ))}
              {state.collectors.length === 0 && (
                <div className="py-6 text-center text-xs text-slate-500">
                  لا يوجد محصّلون مرتبطون بهذه المحطة بعد. يولّد الأدمن المطور أكواد المحصّلين من لوحة الأدمن.
                </div>
              )}
            </div>
          </section>

          <div className="xl:col-span-7">
            <CollectorTrackingMap
              collectors={state.collectors}
              collectorLocations={state.collectorLocations ?? []}
              readings={state.readings}
              onRefresh={handleRefreshFromServer}
              refreshing={refreshing}
            />
          </div>
        </div>
      )}

      {/* TAB 4: Diesel & Profit/Loss Section */}
      {activeTab === 'finance' && (
        <DieselProfitLossSection
          state={state}
          staffToken={staffToken}
          onUpdateState={onUpdateState}
        />
      )}

      {/* TAB 5: Subscribers Ledger Table */}
      {activeTab === 'subscribers' && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-5 sm:p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                سجل المشتركين والعدادات ({filteredSubscribers.length})
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                مرتّب حسب تسلسل خط السير الميداني · محفوظ كنصوص وأرقام للاستعادة اللحظية
              </p>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full md:w-auto">
              <div className="relative flex-1 sm:flex-initial">
                <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="بحث برقم العداد أو الاسم..."
                  className="w-full sm:w-64 min-h-[44px] pr-9 pl-3 py-2 text-sm sm:text-base font-bold placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
              <select
                value={zoneFilter}
                onChange={(e) => setZoneFilter(e.target.value)}
                className="w-full sm:w-auto min-h-[44px] px-3 py-2 text-sm sm:text-base font-bold border border-slate-300 rounded-lg bg-white"
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
                            بانتظار مراجعة المدير ({latestRd.currentReading})
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
      )}

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
