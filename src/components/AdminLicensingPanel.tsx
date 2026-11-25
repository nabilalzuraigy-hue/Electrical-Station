import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  PlusCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  fetchAllLicenses,
  fetchAllStationsAdmin,
  issueStationLicense,
  setStationLicenseStatus,
} from '../lib/offlineDb';
import type { LicenseRecord, StationConfig } from '../types/station';

export const AdminLicensingPanel: React.FC = () => {
  const [licenses, setLicenses] = useState<LicenseRecord[]>([]);
  const [stations, setStations] = useState<StationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Issue license form
  const [stationName, setStationName] = useState('');
  const [maxCollectors, setMaxCollectors] = useState('5');
  const [maxSubscribers, setMaxSubscribers] = useState('1500');
  const [validityDays, setValidityDays] = useState('365');

  const loadAdminData = async () => {
    setLoading(true);
    try {
      const [lics, sts] = await Promise.all([
        fetchAllLicenses(),
        fetchAllStationsAdmin(),
      ]);
      setLicenses(lics);
      setStations(sts);
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر تحميل التراخيص من Firestore',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAdminData();
  }, []);

  const handleIssueLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stationName.trim()) {
      setFeedback('يرجى كتابة اسم المحطة المشتَرية للنسخة.');
      return;
    }
    setIssuing(true);
    setFeedback(null);
    try {
      const created = await issueStationLicense({
        stationName,
        maxCollectors: Number(maxCollectors) || 5,
        maxSubscribers: Number(maxSubscribers) || 1500,
        validityDays: Number(validityDays) || 365,
      });
      setLicenses((prev) => [created, ...prev]);
      setStationName('');
      setFeedback(`تم إصدار كود التفعيل بنجاح: ${created.code}`);
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر إصدار كود الترخيص.',
      );
    } finally {
      setIssuing(false);
    }
  };

  const handleToggleStatus = async (lic: LicenseRecord) => {
    const nextStatus = lic.status === 'suspended' ? 'active' : 'suspended';
    try {
      await setStationLicenseStatus({
        licenseCode: lic.code,
        stationId: lic.stationId,
        nextStatus,
      });
      await loadAdminData();
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر تحديث حالة الترخيص.',
      );
    }
  };

  const handleCopyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const activeCount = licenses.filter((l) => l.status === 'active').length;
  const unusedCount = licenses.filter((l) => l.status === 'unused').length;
  const suspendedCount = licenses.filter((l) => l.status === 'suspended').length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-teal-700" />
            لوحة الأدمن · إصدار أكواد الترخيص والنسخ المستقلة
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            كل كود ترخيص ينشئ نسخة محطة مستقلة ومعزولة بالكامل عن بقية المحطات في قاعدة البيانات.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAdminData()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw className="w-4 h-4" />
          تحديث السجل
        </button>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">إجمالي التراخيص المصدرة</div>
          <div className="text-2xl font-bold text-slate-900 font-mono-nums mt-2">
            {licenses.length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">محطات نشطة ومعزولة</div>
          <div className="text-2xl font-bold text-teal-700 font-mono-nums mt-2">
            {activeCount}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">أكواد جاهزة للبيع</div>
          <div className="text-2xl font-bold text-slate-900 font-mono-nums mt-2">
            {unusedCount}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">محطات موقوفة</div>
          <div className="text-2xl font-bold text-rose-700 font-mono-nums mt-2">
            {suspendedCount}
          </div>
        </div>
      </div>

      {/* Issue New License Code */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-teal-700" />
          إصدار كود ترخيص جديد لمحطة مستقلة
        </h2>

        <form
          onSubmit={handleIssueLicense}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
        >
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              اسم المحطة التجارية
            </label>
            <input
              type="text"
              value={stationName}
              onChange={(e) => setStationName(e.target.value)}
              placeholder="مثال: محطة الفتح التجارية - تعز"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              الحد الأقصى للمحصّلين
            </label>
            <input
              type="number"
              min={1}
              value={maxCollectors}
              onChange={(e) => setMaxCollectors(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono-nums border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              المدة (بالأيام)
            </label>
            <input
              type="number"
              min={30}
              value={validityDays}
              onChange={(e) => setValidityDays(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono-nums border border-slate-300 rounded-lg"
            />
          </div>
          <button
            type="submit"
            disabled={issuing}
            className="min-h-[42px] px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-sm font-medium rounded-lg inline-flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
          >
            <PlusCircle className="w-4 h-4" />
            {issuing ? 'جاري الإصدار...' : 'توليد كود ترخيص'}
          </button>
        </form>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              سعة المشتركين المسموحة للنسخة
            </label>
            <input
              type="number"
              min={50}
              value={maxSubscribers}
              onChange={(e) => setMaxSubscribers(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono-nums border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        {feedback && (
          <div className="text-xs font-medium text-teal-900 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2.5">
            {feedback}
          </div>
        )}
      </section>

      {/* Licenses & Isolated Stations Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900">
            سجل الأكواد والتراخيص ({stations.length} محطة مفعّلة)
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-right">
            <thead className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-medium">كود التفعيل</th>
                <th className="py-3 px-4 font-medium">اسم المحطة المعزولة</th>
                <th className="py-3 px-4 font-medium">الحساب المفعّل</th>
                <th className="py-3 px-4 font-medium">السعة</th>
                <th className="py-3 px-4 font-medium">تاريخ الانتهاء</th>
                <th className="py-3 px-4 font-medium">الحالة</th>
                <th className="py-3 px-4 font-medium">تحكم الأدمن</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {licenses.map((lic) => (
                <tr key={lic.code} className="hover:bg-slate-50/70">
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono-nums font-bold text-slate-900">
                        {lic.code}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopyCode(lic.code)}
                        className="p-1 text-slate-500 hover:text-teal-700 cursor-pointer"
                        title="نسخ الكود"
                      >
                        {copiedCode === lic.code ? (
                          <Check className="w-3.5 h-3.5 text-teal-700" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900">
                      {lic.stationName}
                    </div>
                    <div className="text-xs text-slate-500 font-mono-nums">
                      {lic.stationId}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-600">
                    {lic.activatedByEmail || 'لم يُفعّل بعد'}
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-600 font-mono-nums">
                    {lic.maxCollectors} محصّل · {lic.maxSubscribers} مشترك
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-600 font-mono-nums">
                    {new Date(lic.expiresAt).toLocaleDateString('ar-YE')}
                  </td>
                  <td className="py-3 px-4 text-xs font-semibold">
                    {lic.status === 'active' && (
                      <span className="text-teal-700">مفعّلة ونشطة</span>
                    )}
                    {lic.status === 'unused' && (
                      <span className="text-slate-700">جاهز للتفعيل</span>
                    )}
                    {lic.status === 'suspended' && (
                      <span className="text-rose-700">موقوفة</span>
                    )}
                    {lic.status === 'expired' && (
                      <span className="text-amber-700">منتهية</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    {lic.status !== 'unused' && (
                      <button
                        type="button"
                        onClick={() => void handleToggleStatus(lic)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border whitespace-nowrap cursor-pointer ${
                          lic.status === 'suspended'
                            ? 'border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100'
                            : 'border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100'
                        }`}
                      >
                        {lic.status === 'suspended'
                          ? 'إعادة تفعيل'
                          : 'إيقاف النسخة'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && licenses.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    لم يتم إصدار أي أكواد ترخيص بعد. أنشئ أول كود ترخيص من النموذج أعلاه.
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
