import React, { useEffect, useState } from 'react';
import { Bell, Eye, FileText, KeyRound, Receipt, X } from 'lucide-react';
import { lookupSubscriberPublic, type StationLocalState } from '../lib/offlineDb';
import { formatKwh, formatYer } from '../lib/formatters';
import type {
  MeterReading,
  PaymentReceipt,
  Subscriber,
  SubscriberLookupResult,
} from '../types/station';

interface SubscriberPortalProps {
  state?: StationLocalState | null;
  initialResult?: SubscriberLookupResult | null;
}

function normalizeArabicText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

function normalizePhoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00967')) return digits.slice(5);
  if (digits.startsWith('967') && digits.length >= 11) return digits.slice(3);
  if (digits.startsWith('0') && digits.length === 10) return digits.slice(1);
  return digits;
}

export const SubscriberPortal: React.FC<SubscriberPortalProps> = ({
  state,
  initialResult,
}) => {
  const [subscriberName, setSubscriberName] = useState(
    initialResult?.subscriber.subscriberName ?? '',
  );
  const [phone, setPhone] = useState(initialResult?.subscriber.phone ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fcmEnabled, setFcmEnabled] = useState(false);
  const [zoomPhotoUrl, setZoomPhotoUrl] = useState<string | null>(null);

  const [matchedResult, setMatchedResult] = useState<{
    stationName: string;
    subscriber: Subscriber;
    readings: MeterReading[];
    receipts: PaymentReceipt[];
  } | null>(initialResult ?? null);

  useEffect(() => {
    if (initialResult) {
      setMatchedResult(initialResult);
      setSubscriberName(initialResult.subscriber.subscriberName);
      setPhone(initialResult.subscriber.phone);
      setError(null);
    }
  }, [initialResult]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = subscriberName.trim();
    const cleanPhone = phone.trim();
    if (!cleanName || !cleanPhone) {
      setError('يرجى إدخال اسم المشترك الكامل ورقم الهاتف المسجل.');
      return;
    }

    setLoading(true);
    setError(null);
    setMatchedResult(null);

    try {
      const serverResult = await lookupSubscriberPublic({
        subscriberName: cleanName,
        phone: cleanPhone,
      });
      setMatchedResult(serverResult);
      setLoading(false);
      return;
    } catch (err) {
      // Fallback to active local cache when offline
      if (state) {
        const targetName = normalizeArabicText(cleanName);
        const targetPhone = normalizePhoneDigits(cleanPhone);
        const localSub = state.subscribers.find((s) => {
          if (normalizePhoneDigits(s.phone) !== targetPhone) return false;
          return (
            normalizeArabicText(s.subscriberName) === targetName ||
            s.meterNumber.trim().toLowerCase() === cleanName.toLowerCase()
          );
        });
        if (localSub) {
          setMatchedResult({
            stationName: state.station.stationName,
            subscriber: localSub,
            readings: state.readings.filter(
              (r) =>
                r.subscriberId === localSub.id ||
                r.meterNumber === localSub.meterNumber,
            ),
            receipts: state.receipts.filter(
              (rc) =>
                rc.subscriberId === localSub.id ||
                rc.meterNumber === localSub.meterNumber,
            ),
          });
          setLoading(false);
          return;
        }
      }

      setError(
        err instanceof Error
          ? err.message
          : 'لم يتم العثور على مشترك مطابق للاسم ورقم الهاتف.',
      );
    } finally {
      setLoading(false);
    }
  };

  const latestReading =
    matchedResult?.readings.find((r) => r.approvalStatus !== 'rejected' && r.approvalStatus !== 'pending_manager') ??
    matchedResult?.readings[0];
  const latestPhoto = latestReading?.photoUrl || '';

  return (
    <div className="space-y-8">
      <div className="border-b border-slate-200 pb-6">
        <h1 className="text-2xl font-bold text-slate-900">
          تفاصيل الفاتورة والاستهلاك
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          استعلم بالاسم المسجل في كشف المحطة ورقم الهاتف لمتابعة الاستهلاك والفواتير وسجل السداد.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-teal-700" />
            بيانات المشترك
          </h2>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                اسم المشترك الكامل (كما في كشف Excel)
              </label>
              <input
                type="text"
                value={subscriberName}
                onChange={(e) => setSubscriberName(e.target.value)}
                placeholder="أدخل الاسم الكامل"
                className="w-full min-h-[48px] px-3.5 py-2.5 text-base sm:text-lg font-bold placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                رقم الهاتف المسجل
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="أدخل رقم الهاتف"
                className="w-full min-h-[48px] px-3.5 py-2.5 text-base sm:text-lg font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[46px] py-2.5 px-4 bg-teal-700 hover:bg-teal-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
            >
              {loading ? 'جاري البحث...' : 'عرض الفاتورة وصورة العداد'}
            </button>
          </form>

          {error && (
            <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">
              {error}
            </p>
          )}
        </section>

        <section className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6">
          {matchedResult ? (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    {matchedResult.subscriber.subscriberName}
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">
                    {matchedResult.stationName} ·{' '}
                    {matchedResult.subscriber.zoneStreet} · عداد رقم{' '}
                    <span className="font-mono-nums font-semibold">
                      {matchedResult.subscriber.meterNumber}
                    </span>
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setFcmEnabled((v) => !v)}
                  className={`min-h-[40px] px-3.5 py-2 text-xs font-medium rounded-lg border inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    fcmEnabled
                      ? 'border-teal-300 bg-teal-50 text-teal-800'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Bell className="w-4 h-4" />
                  {fcmEnabled
                    ? 'إشعارات الفواتير مفعّلة'
                    : 'تفعيل إشعارات الفاتورة والسداد'}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                <div className="md:col-span-6 space-y-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-teal-700" />
                    ملخص الفاتورة الحالية
                  </h3>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">القراءة السابقة</span>
                    <span className="font-mono-nums font-medium">
                      {latestReading?.previousReading ??
                        matchedResult.subscriber.previousReading}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">القراءة الحالية</span>
                    <span className="font-mono-nums font-medium">
                      {latestReading?.currentReading ??
                        matchedResult.subscriber.currentReading}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">الاستهلاك</span>
                    <span className="font-mono-nums font-semibold">
                      {latestReading?.isClosedHouseZero
                        ? 'استهلاك صفر - بيت مغلق'
                        : formatKwh(latestReading?.consumptionKwh ?? 0)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">مبلغ الاستهلاك</span>
                    <span className="font-mono-nums">
                      {formatYer(latestReading?.currentBillYer ?? 0)}
                    </span>
                  </div>
                  <div className="border-t border-slate-200 pt-2 flex justify-between text-base font-bold">
                    <span>الرصيد المتبقي المستحق</span>
                    <span className="font-mono-nums text-rose-700">
                      {formatYer(matchedResult.subscriber.previousDebtYer)}
                    </span>
                  </div>
                </div>

                <div className="md:col-span-6 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">
                      صورة العداد الفعلية (إثبات القراءة)
                    </span>
                    {latestPhoto && (
                      <button
                        type="button"
                        onClick={() => setZoomPhotoUrl(latestPhoto)}
                        className="text-xs text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        تكبير الصورة
                      </button>
                    )}
                  </div>
                  {latestPhoto ? (
                    <div className="aspect-[4/3] rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
                      <img
                        src={latestPhoto}
                        alt="صورة إثبات قراءة العداد"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ) : (
                    <div className="aspect-[4/3] rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center text-xs text-slate-600 p-4 text-center leading-relaxed">
                      {latestReading?.hasLocalPhoto
                        ? 'تم توثيق قراءة العداد بصورة محفوظة محلياً في جهاز المحصّل لتسريع المزامنة وتوفير البيانات.'
                        : 'لم تُرفق صورة عداد لهذه القراءة بعد.'}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-3 border-t border-slate-200 pt-5">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-teal-700" />
                  سجل سندات القبض والمدفوعات
                </h3>
                {matchedResult.receipts.length > 0 ? (
                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                    {matchedResult.receipts.map((rc) => (
                      <div
                        key={rc.id}
                        className="p-3.5 flex items-center justify-between text-sm bg-white"
                      >
                        <div>
                          <div className="font-semibold text-slate-900 font-mono-nums">
                            {formatYer(rc.amountPaidYer)}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            بواسطة {rc.collectorName} ·{' '}
                            {new Date(rc.paidAt).toLocaleDateString('ar-YE')}
                          </div>
                        </div>
                        <div className="text-xs text-slate-600 font-mono-nums">
                          المتبقي: {formatYer(rc.remainingBalanceYer)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    لا توجد سندات دفع مسجلة حتى الآن لهذا المشترك.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="py-16 text-center space-y-2">
              <p className="text-sm font-medium text-slate-700">
                أدخل الاسم الكامل ورقم الهاتف المسجل في كشف المحطة لعرض الفاتورة وصورة العداد.
              </p>
              <p className="text-xs text-slate-500">
                تتيح هذه البوابة للمشترك التأكد من قراءة عداده بالصورة الحقيقية لمنع أي خلافات.
              </p>
            </div>
          )}
        </section>
      </div>

      {zoomPhotoUrl && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
          onClick={() => setZoomPhotoUrl(null)}
        >
          <div
            className="max-w-2xl w-full bg-white rounded-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <span className="text-sm font-bold text-slate-900">
                معاينة صورة العداد بدقة كاملة
              </span>
              <button
                type="button"
                onClick={() => setZoomPhotoUrl(null)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <img
              src={zoomPhotoUrl}
              alt="صورة العداد المكبّرة"
              referrerPolicy="no-referrer"
              className="w-full max-h-[75vh] object-contain bg-slate-900"
            />
          </div>
        </div>
      )}
    </div>
  );
};
