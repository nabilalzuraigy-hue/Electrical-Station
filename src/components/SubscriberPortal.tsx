import React, { useState } from 'react';
import { Bell, Eye, FileText, KeyRound, Receipt, X } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { computeSubscriberPortalHash, db } from '../lib/firebase';
import type { StationLocalState } from '../lib/offlineDb';
import { formatKwh, formatYer } from '../lib/formatters';
import type {
  MeterReading,
  PaymentReceipt,
  Subscriber,
  SubscriberPortalRecord,
} from '../types/station';

interface SubscriberPortalProps {
  state?: StationLocalState | null;
}

export const SubscriberPortal: React.FC<SubscriberPortalProps> = ({
  state,
}) => {
  const [meterNumber, setMeterNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fcmEnabled, setFcmEnabled] = useState(false);
  const [zoomPhotoUrl, setZoomPhotoUrl] = useState<string | null>(null);

  const [matchedLocal, setMatchedLocal] = useState<{
    subscriber: Subscriber;
    readings: MeterReading[];
    receipts: PaymentReceipt[];
  } | null>(null);

  const [cloudRecord, setCloudRecord] =
    useState<SubscriberPortalRecord | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanMeter = meterNumber.trim();
    const cleanPhone = phone.replace(/\s+/g, '').trim();
    if (!cleanMeter || !cleanPhone) {
      setError('يرجى إدخال رقم العداد ورقم الهاتف المسجل.');
      return;
    }

    setLoading(true);
    setError(null);
    setCloudRecord(null);
    setMatchedLocal(null);

    try {
      // Check hashed Firestore subscriberPortals record first
      const hash = await computeSubscriberPortalHash(cleanMeter, cleanPhone);
      const snap = await getDoc(doc(db, 'subscriberPortals', hash));
      if (snap.exists()) {
        setCloudRecord(snap.data() as SubscriberPortalRecord);
        setLoading(false);
        return;
      }

      // Fallback to active local station cache if available
      const localSub = state?.subscribers.find(
        (s) =>
          s.meterNumber === cleanMeter &&
          s.phone.replace(/\s+/g, '').trim() === cleanPhone,
      );

      if (localSub && state) {
        setMatchedLocal({
          subscriber: localSub,
          readings: state.readings.filter(
            (r) =>
              r.subscriberId === localSub.id || r.meterNumber === cleanMeter,
          ),
          receipts: state.receipts.filter(
            (rc) =>
              rc.subscriberId === localSub.id || rc.meterNumber === cleanMeter,
          ),
        });
      } else {
        setError(
          'لم يتم العثور على سجل مطابق لرقم العداد والهاتف. تأكد من رفع القراءة من قِبل محصّل المحطة.',
        );
      }
    } catch {
      setError('تعذر التحقق من البيانات حالياً. تأكد من الاتصال بالإنترنت.');
    } finally {
      setLoading(false);
    }
  };

  const latestPhoto =
    matchedLocal?.readings[0]?.photoUrl ||
    cloudRecord?.lastReadingPhotoUrl ||
    '';

  return (
    <div className="space-y-8">
      <div className="border-b border-slate-200 pb-6">
        <h1 className="text-2xl font-bold text-slate-900">
          بوابة المشترك · الشفافية وإثبات القراءة بالصورة
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          سجّل الدخول برقم العداد ورقم الهاتف فقط لمتابعة فواتيرك ومشاهدة صورة العداد الملتقطة وقت القراءة.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-teal-700" />
            دخول المشترك المبسط
          </h2>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                رقم العداد (meter_number)
              </label>
              <input
                type="text"
                value={meterNumber}
                onChange={(e) => setMeterNumber(e.target.value)}
                placeholder="أدخل رقم العداد"
                className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                رقم الهاتف المسجل (phone)
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="أدخل رقم الهاتف"
                className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
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
          {matchedLocal || cloudRecord ? (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    {matchedLocal?.subscriber.subscriberName ||
                      cloudRecord?.subscriberName}
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">
                    {cloudRecord?.stationName || state?.station.stationName} ·{' '}
                    {matchedLocal?.subscriber.zoneStreet ||
                      cloudRecord?.zoneStreet}{' '}
                    · عداد رقم{' '}
                    <span className="font-mono-nums font-semibold">
                      {matchedLocal?.subscriber.meterNumber ||
                        cloudRecord?.meterNumber}
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
                    ? 'إشعارات الفواتير (FCM) مفعّلة'
                    : 'تفعيل إشعارات الفاتورة والسداد'}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                <div className="md:col-span-6 space-y-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-teal-700" />
                    ملخص الفاتورة الحالية
                  </h3>
                  {matchedLocal ? (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-600">القراءة السابقة</span>
                        <span className="font-mono-nums font-medium">
                          {matchedLocal.readings[0]?.previousReading ??
                            matchedLocal.subscriber.previousReading}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-600">القراءة الحالية</span>
                        <span className="font-mono-nums font-medium">
                          {matchedLocal.readings[0]?.currentReading ??
                            matchedLocal.subscriber.currentReading}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-600">الاستهلاك</span>
                        <span className="font-mono-nums font-semibold">
                          {formatKwh(
                            matchedLocal.readings[0]?.consumptionKwh ?? 0,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-600">مبلغ الاستهلاك</span>
                        <span className="font-mono-nums">
                          {formatYer(
                            matchedLocal.readings[0]?.currentBillYer ?? 0,
                          )}
                        </span>
                      </div>
                      <div className="border-t border-slate-200 pt-2 flex justify-between text-base font-bold">
                        <span>الرصيد المتبقي المستحق</span>
                        <span className="font-mono-nums text-rose-700">
                          {formatYer(matchedLocal.subscriber.previousDebtYer)}
                        </span>
                      </div>
                    </>
                  ) : (
                    cloudRecord && (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-600">القراءة السابقة</span>
                          <span className="font-mono-nums font-medium">
                            {cloudRecord.previousReading}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-600">القراءة الحالية</span>
                          <span className="font-mono-nums font-medium">
                            {cloudRecord.currentReading}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-600">الاستهلاك</span>
                          <span className="font-mono-nums font-semibold">
                            {formatKwh(cloudRecord.consumptionKwh)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-600">مبلغ الاستهلاك</span>
                          <span className="font-mono-nums">
                            {formatYer(cloudRecord.currentBillYer)}
                          </span>
                        </div>
                        <div className="border-t border-slate-200 pt-2 flex justify-between text-base font-bold">
                          <span>الإجمالي المستحق</span>
                          <span className="font-mono-nums text-rose-700">
                            {formatYer(cloudRecord.totalDueYer)}
                          </span>
                        </div>
                      </>
                    )
                  )}
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
                    <div className="aspect-[4/3] rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center text-xs text-slate-500 p-4 text-center">
                      لم تُرفق صورة عداد لهذه القراءة بعد.
                    </div>
                  )}
                </div>
              </div>

              {matchedLocal && (
                <div className="space-y-3 border-t border-slate-200 pt-5">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Receipt className="w-4 h-4 text-teal-700" />
                    سجل سندات القبض والمدفوعات
                  </h3>
                  {matchedLocal.receipts.length > 0 ? (
                    <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                      {matchedLocal.receipts.map((rc) => (
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
                      لا توجد سندات دفع مسجلة حتى الآن لهذا العداد.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="py-16 text-center space-y-2">
              <p className="text-sm font-medium text-slate-700">
                أدخل رقم العداد ورقم الهاتف المسجل لعرض الفاتورة وصورة العداد.
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
