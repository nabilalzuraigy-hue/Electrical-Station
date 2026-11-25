import React, { useMemo, useState } from 'react';
import {
  Download,
  RefreshCw,
  Search,
  Upload,
  Users,
  Zap,
} from 'lucide-react';
import {
  exportStationReportExcel,
  refreshStationState,
  updateCollectorInCloud,
  type StationLocalState,
} from '../lib/offlineDb';
import { formatCompactYer, formatKwh, formatYer } from '../lib/formatters';
import type {
  CollectorPermissions,
  CollectorProfile,
  SyncProgress,
} from '../types/station';

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
  const [tariffSaved, setTariffSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [collectorError, setCollectorError] = useState<string | null>(null);

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
          <h1 className="text-2xl font-bold text-slate-900">
            لوحة مدير المحطة · {state.station.stationName}
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
              {filteredSubscribers.slice(0, 200).map((sub) => (
                <tr key={sub.id} className="hover:bg-slate-50/70 transition-colors">
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
                  <td className="py-3 px-4 text-slate-700">{sub.zoneStreet}</td>
                  <td className="py-3 px-4 font-mono-nums text-slate-700">
                    {sub.previousReading}
                  </td>
                  <td className="py-3 px-4 font-mono-nums text-slate-900 font-medium">
                    {sub.currentReading}
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
              ))}
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
    </div>
  );
};
