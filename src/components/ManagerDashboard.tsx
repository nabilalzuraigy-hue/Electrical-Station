import React, { useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  KeyRound,
  Search,
  Upload,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react';
import {
  createCollectorInvite,
  downloadExcelTemplate,
  exportStationReportExcel,
  parseSubscribersExcelFile,
  updateCollectorInCloud,
  type StationLocalState,
} from '../lib/offlineDb';
import { formatCompactYer, formatKwh, formatYer } from '../lib/formatters';
import type {
  CollectorPermissions,
  CollectorProfile,
  Subscriber,
} from '../types/station';

interface ManagerDashboardProps {
  state: StationLocalState;
  onUpdateState: (next: StationLocalState) => void;
  onSyncNow: () => Promise<void>;
  isSyncing: boolean;
}

export const ManagerDashboard: React.FC<ManagerDashboardProps> = ({
  state,
  onUpdateState,
  onSyncNow,
  isSyncing,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [zoneFilter, setZoneFilter] = useState<string>('all');
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [tariffSaved, setTariffSaved] = useState(false);

  const [stationName, setStationName] = useState(state.station.stationName);
  const [kwhPrice, setKwhPrice] = useState(String(state.station.kwhPriceYer));
  const [minFee, setMinFee] = useState(String(state.station.minimumFeeYer));
  const [mainGenKwh, setMainGenKwh] = useState(
    String(state.station.mainGeneratorKwh),
  );

  // Collector invite creation with granular permissions
  const [collectorName, setCollectorName] = useState('');
  const [collectorPhone, setCollectorPhone] = useState('');
  const [collectorZones, setCollectorZones] = useState('');
  const [permReadings, setPermReadings] = useState(true);
  const [permCash, setPermCash] = useState(true);
  const [permInvoices, setPermInvoices] = useState(true);
  const [permDebts, setPermDebts] = useState(true);
  const [collectorError, setCollectorError] = useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

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

  const handleExcelUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = await parseSubscribersExcelFile(file);
      if (imported.length === 0) {
        setImportFeedback(
          'لم يتم العثور على صفوف صالحة. تأكد من أعمدة meter_number و subscriber_name.',
        );
        return;
      }

      const byMeter = new Map<string, Subscriber>();
      state.subscribers.forEach((s) => byMeter.set(s.meterNumber, s));
      imported.forEach((s) => byMeter.set(s.meterNumber, s));

      const mergedList = Array.from(byMeter.values());
      if (mergedList.length > state.station.maxSubscribers) {
        setImportFeedback(
          `يتجاوز العدد السعة المرخصة للنسخة (${state.station.maxSubscribers} مشترك).`,
        );
        return;
      }

      onUpdateState({
        ...state,
        subscribers: mergedList,
      });
      setImportFeedback(
        `تم استيراد ${imported.length} مشترك محلياً. اضغط "حفظ ومزامنة السحابة" لرفعهم لقاعدة المحطة.`,
      );
    } catch {
      setImportFeedback('تعذر قراءة ملف Excel. يرجى استخدام ملف .xlsx قياسي.');
    } finally {
      event.target.value = '';
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

  const handleCreateCollectorInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!collectorName.trim() || !collectorPhone.trim()) {
      setCollectorError('يرجى إدخال اسم المحصّل ورقم الهاتف.');
      return;
    }
    if (
      state.collectors.length +
        state.invites.filter((i) => i.status === 'unused').length >=
      state.station.maxCollectors
    ) {
      setCollectorError(
        `تم بلوغ الحد الأقصى للمحصّلين المرخصين في هذه النسخة (${state.station.maxCollectors}).`,
      );
      return;
    }

    setCollectorError(null);
    setCreatingInvite(true);
    try {
      const assignedZones = collectorZones
        .split(/[،,]/)
        .map((z) => z.trim())
        .filter(Boolean);

      const invite = await createCollectorInvite({
        station: state.station,
        collectorName,
        phone: collectorPhone,
        assignedZones,
        permissions: {
          canRecordReadings: permReadings,
          canCollectCash: permCash,
          canSendInvoices: permInvoices,
          canViewDebts: permDebts,
        },
      });

      onUpdateState({
        ...state,
        invites: [invite, ...state.invites],
      });
      setCollectorName('');
      setCollectorPhone('');
      setCollectorZones('');
    } catch (err) {
      setCollectorError(
        err instanceof Error ? err.message : 'تعذر إصدار كود المحصّل.',
      );
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleToggleCollectorActive = async (collector: CollectorProfile) => {
    const updated: CollectorProfile = {
      ...collector,
      active: !collector.active,
    };
    await updateCollectorInCloud({
      stationId: state.station.stationId,
      collector: updated,
    });
    onUpdateState({
      ...state,
      collectors: state.collectors.map((c) =>
        c.id === collector.id ? updated : c,
      ),
    });
  };

  const handleToggleCollectorPermission = async (
    collector: CollectorProfile,
    permKey: keyof CollectorPermissions,
  ) => {
    const updated: CollectorProfile = {
      ...collector,
      permissions: {
        ...collector.permissions,
        [permKey]: !collector.permissions[permKey],
      },
    };
    await updateCollectorInCloud({
      stationId: state.station.stationId,
      collector: updated,
    });
    onUpdateState({
      ...state,
      collectors: state.collectors.map((c) =>
        c.id === collector.id ? updated : c,
      ),
    });
  };

  const handleCopyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
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
            نسخة مستقلة مرخصة ({state.station.licenseCode}) ·{' '}
            {state.station.licenseStatus === 'active'
              ? 'الترخيص نشط'
              : 'الترخيص موقوف من الأدمن'}{' '}
            · السعة القصوى: {state.station.maxSubscribers} مشترك /{' '}
            {state.station.maxCollectors} محصّل
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            disabled={isSyncing}
            onClick={() => void onSyncNow()}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            {isSyncing
              ? 'جاري الحفظ السحابي...'
              : metrics.pendingSyncCount > 0
                ? `حفظ ومزامنة السحابة (${metrics.pendingSyncCount})`
                : 'مزامنة مع السحابة'}
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
            إجمالي المشتركين النشطين
          </span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold text-slate-900 font-mono-nums">
              {metrics.activeSubscribers}
            </span>
            <span className="text-xs text-slate-500">عداد مسجل</span>
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

      {/* Main Grid: Excel Rapid Setup + Tariff Settings */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between gap-5">
          <div>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-teal-700" />
                التأسيس السريع عبر ملف Excel (.xlsx)
              </h2>
              <button
                type="button"
                onClick={downloadExcelTemplate}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 underline underline-offset-4 whitespace-nowrap shrink-0 cursor-pointer"
              >
                تحميل نموذج Excel فارغ
              </button>
            </div>
            <p className="text-sm text-slate-600 mt-2 leading-relaxed">
              ارفع كشف المشتركين ليتم استيرادهم إلى محطتك المعزولة فوراً. الأعمدة المدعومة:
            </p>
            <div className="mt-3 text-xs text-slate-500 font-mono-nums bg-slate-50 border border-slate-200 rounded-lg p-3 leading-relaxed">
              meter_number · subscriber_name · phone · previous_reading · previous_debt · zone_street · sequence_order
            </div>
          </div>

          <div className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleExcelUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              اختيار ملف Excel واستيراد المشتركين
            </button>
            {importFeedback && (
              <p className="text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                {importFeedback}
              </p>
            )}
          </div>
        </section>

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
              {tariffSaved ? 'تم الحفظ محلياً (اضغط مزامنة للرفع)' : 'حفظ التعرفة وإعدادات المولد'}
            </button>
          </form>
        </section>
      </div>

      {/* Collectors Activation & Granular Permissions */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Users className="w-5 h-5 text-teal-700" />
              إدارة المحصّلين وتحديد الصلاحيات والتفعيل
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              أصدر كود تفعيل لكل محصّل وحدد صلاحياته بدقة (القراءة، القبض النقدي، إرسال الفواتير، عرض المتأخرات) أو أوقف حسابه فوراً.
            </p>
          </div>
          <span className="text-xs text-slate-500 font-mono-nums">
            {state.collectors.length} / {state.station.maxCollectors} محصّل
          </span>
        </div>

        <form onSubmit={handleCreateCollectorInvite} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <input
              type="text"
              placeholder="اسم المحصّل الميداني"
              value={collectorName}
              onChange={(e) => setCollectorName(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <input
              type="tel"
              placeholder="رقم الهاتف (77xxxxxxx)"
              value={collectorPhone}
              onChange={(e) => setCollectorPhone(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-nums"
            />
            <input
              type="text"
              placeholder="الحارات المخصصة (مفصولة بفاصلة)"
              value={collectorZones}
              onChange={(e) => setCollectorZones(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <button
              type="submit"
              disabled={creatingInvite}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <UserPlus className="w-4 h-4" />
              {creatingInvite ? 'جاري التوليد...' : 'إصدار كود تفعيل محصّل'}
            </button>
          </div>

          {/* Granular Permissions Selection */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3">
            <span className="font-semibold text-slate-900">صلاحيات المحصّل:</span>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={permReadings}
                onChange={(e) => setPermReadings(e.target.checked)}
                className="accent-teal-700"
              />
              تسجيل القراءات وتصوير العداد
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={permCash}
                onChange={(e) => setPermCash(e.target.checked)}
                className="accent-teal-700"
              />
              إصدار سند قبض نقدي
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={permInvoices}
                onChange={(e) => setPermInvoices(e.target.checked)}
                className="accent-teal-700"
              />
              إرسال فواتير واتساب / SMS
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={permDebts}
                onChange={(e) => setPermDebts(e.target.checked)}
                className="accent-teal-700"
              />
              الاطلاع على المتأخرات
            </label>
          </div>
        </form>

        {collectorError && (
          <p className="text-xs text-rose-700">{collectorError}</p>
        )}

        {/* Active Collector Invites */}
        {state.invites.filter((i) => i.status === 'unused').length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-teal-700" />
              أكواد محصّلين بانتظار التفعيل:
            </div>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {state.invites
                .filter((i) => i.status === 'unused')
                .map((inv) => (
                  <div
                    key={inv.inviteCode}
                    className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                  >
                    <div>
                      <span className="font-bold text-slate-900">
                        {inv.collectorName}
                      </span>{' '}
                      · <span className="font-mono-nums">{inv.phone}</span> ·
                      المناطق:{' '}
                      {inv.assignedZones.length > 0
                        ? inv.assignedZones.join('، ')
                        : 'جميع الشوارع'}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        dir="ltr"
                        className="font-mono-nums font-bold text-teal-800 bg-teal-50 border border-teal-200 px-2.5 py-1 rounded"
                      >
                        {inv.inviteCode}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopyCode(inv.inviteCode)}
                        className="p-1.5 text-slate-600 hover:text-teal-700 cursor-pointer"
                        title="نسخ كود المحصّل"
                      >
                        {copiedCode === inv.inviteCode ? (
                          <Check className="w-4 h-4 text-teal-700" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Activated Collectors List with Live Permission Toggles */}
        <div className="divide-y divide-slate-100 border-t border-slate-100">
          {state.collectors.map((col) => (
            <div
              key={col.id}
              className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
            >
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  {col.name}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {col.phone} · {col.email} · المناطق:{' '}
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
              لم يفعّل أي محصّل حسابه بعد. أصدر كود تفعيل من النموذج أعلاه وأرسله للمحصّل.
            </div>
          )}
        </div>
      </section>

      {/* Subscribers Ledger Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              سجل المشتركين والعدادات
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              مرتّب حسب ترتيب البيت الميداني (sequence_order)
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
              {filteredSubscribers.map((sub) => (
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
                    لا يوجد مشتركين مسجلين في هذه المحطة بعد. قم برفع ملف Excel أعلاه لتأسيس المشتركين.
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
