import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  CloudUpload,
  Copy,
  Download,
  FileSpreadsheet,
  MessageCircle,
  MessageSquare,
  ScanLine,
  Search,
  ShieldAlert,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  exportCollectorReadingsExcel,
  parseSubscribersExcelFile,
  sanitizeFirestoreId,
  type StationLocalState,
} from '../lib/offlineDb';
import {
  buildArabicInvoiceMessage,
  compressImageUnder150Kb,
  formatCompactYer,
  formatKwh,
  formatYer,
  getSmsInvoiceUrl,
  getWhatsAppInvoiceUrl,
} from '../lib/formatters';
import type {
  CollectorPermissions,
  CollectorProfile,
  MeterReading,
  PaymentReceipt,
  Subscriber,
} from '../types/station';

interface CollectorAppProps {
  state: StationLocalState;
  onUpdateState: (next: StationLocalState) => void;
  onSyncNow: () => Promise<void>;
  isSyncing: boolean;
  syncProgress: import('../types/station').SyncProgress | null;
  activeCollector?: CollectorProfile;
  isManagerPreview?: boolean;
}

export const CollectorApp: React.FC<CollectorAppProps> = ({
  state,
  onUpdateState,
  onSyncNow,
  isSyncing,
  syncProgress,
  activeCollector,
  isManagerPreview = false,
}) => {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const localExcelInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedZone, setSelectedZone] = useState('all');
  const [selectedSubscriberId, setSelectedSubscriberId] = useState<string>(
    state.subscribers[0]?.id ?? '',
  );

  // Reading & meter photo workspace state
  const [readingInput, setReadingInput] = useState('');
  const [cashPaidInput, setCashPaidInput] = useState('');
  const [proofPhotoUrl, setProofPhotoUrl] = useState<string>('');
  const [proofSizeKb, setProofSizeKb] = useState<number>(0);
  const [photoStatus, setPhotoStatus] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [savedInvoiceText, setSavedInvoiceText] = useState<string | null>(null);
  const [copiedInvoice, setCopiedInvoice] = useState(false);
  const [cameraStreamActive, setCameraStreamActive] = useState(false);
  const [localExcelNotice, setLocalExcelNotice] = useState<string | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const permissions: CollectorPermissions = isManagerPreview
    ? {
        canRecordReadings: true,
        canCollectCash: true,
        canSendInvoices: true,
        canViewDebts: true,
      }
    : (activeCollector?.permissions ?? {
        canRecordReadings: false,
        canCollectCash: false,
        canSendInvoices: false,
        canViewDebts: false,
      });

  const collectorActive = isManagerPreview ? true : Boolean(activeCollector?.active);
  const assignedZones = isManagerPreview
    ? []
    : (activeCollector?.assignedZones ?? []);

  const zones = useMemo(() => {
    const s = new Set<string>();
    state.subscribers.forEach((sub) => {
      if (
        sub.importedLocally ||
        assignedZones.length === 0 ||
        assignedZones.includes(sub.zoneStreet)
      ) {
        s.add(sub.zoneStreet);
      }
    });
    return Array.from(s);
  }, [state.subscribers, assignedZones]);

  const routeSubscribers = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return [...state.subscribers]
      .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
      .filter((sub) => {
        if (
          !sub.importedLocally &&
          assignedZones.length > 0 &&
          !assignedZones.includes(sub.zoneStreet)
        ) {
          return false;
        }
        if (selectedZone !== 'all' && sub.zoneStreet !== selectedZone)
          return false;
        if (!q) return true;
        return (
          sub.meterNumber.toLowerCase().includes(q) ||
          sub.meterNumber.slice(-4).toLowerCase().includes(q) ||
          sub.subscriberName.toLowerCase().includes(q) ||
          sub.phone.includes(q)
        );
      });
  }, [state.subscribers, searchTerm, selectedZone, assignedZones]);

  const selectedSubscriber: Subscriber | undefined = useMemo(
    () =>
      routeSubscribers.find((s) => s.id === selectedSubscriberId) ??
      routeSubscribers[0],
    [routeSubscribers, selectedSubscriberId],
  );

  const pendingCount = useMemo(() => {
    const r = state.readings.filter((x) => x.syncStatus === 'pending').length;
    const rc = state.receipts.filter((x) => x.syncStatus === 'pending').length;
    const s = state.subscribers.filter((x) => x.syncStatus === 'pending').length;
    return r + rc + s;
  }, [state]);

  if (!collectorActive) {
    return (
      <div className="bg-white border border-rose-200 rounded-xl p-8 text-center space-y-3">
        <ShieldAlert className="w-10 h-10 text-rose-700 mx-auto" />
        <h2 className="text-lg font-bold text-slate-900">
          تم إيقاف صلاحية حساب المحصّل مؤقتاً
        </h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          قام مدير المحطة ({state.station.stationName}) بتعطيل حسابك. تواصل مع مدير المحطة لإعادة التفعيل.
        </p>
      </div>
    );
  }

  const selectSubscriber = (sub: Subscriber) => {
    setSelectedSubscriberId(sub.id);
    setReadingInput(String(sub.currentReading || sub.previousReading));
    setCashPaidInput('');
    setProofPhotoUrl('');
    setProofSizeKb(0);
    setPhotoStatus(null);
    setValidationError(null);
    setSavedInvoiceText(null);
  };

  const startLiveCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      setCameraStreamActive(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      }, 60);
    } catch {
      setPhotoStatus(
        'تعذر فتح الكاميرا المباشرة في المتصفح — استخدم زر "التقاط / رفع صورة عداد" من الكاميرا.',
      );
    }
  };

  const stopLiveCamera = () => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    setCameraStreamActive(false);
  };

  const captureFromLiveCamera = async () => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth || 960;
    canvas.height = videoRef.current.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.8),
    );
    if (!blob) return;

    const compressed = await compressImageUnder150Kb(blob);
    setProofPhotoUrl(compressed.dataUrl);
    setProofSizeKb(compressed.sizeKb);
    stopLiveCamera();
    setPhotoStatus(
      `تم التقاط وضغط صورة العداد (${compressed.sizeKb} KB) وحفظها محلياً في جهازك. أدخل أرقام القراءة الظاهرة في الصورة.`,
    );
  };

  const handlePhotoUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPhotoStatus('جاري ضغط صورة العداد...');
    try {
      const compressed = await compressImageUnder150Kb(file);
      setProofPhotoUrl(compressed.dataUrl);
      setProofSizeKb(compressed.sizeKb);
      setPhotoStatus(
        `تم حفظ وضغط صورة إثبات العداد محلياً في جهازك بحجم ${compressed.sizeKb} كيلوبايت (ترتفع القراءة النصية فقط عند المزامنة).`,
      );
    } catch {
      setPhotoStatus('تعذر معالجة الصورة المختارة.');
    } finally {
      event.target.value = '';
    }
  };

  const handleCollectorLocalExcelImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setLocalExcelNotice(null);
    try {
      const parsed = await parseSubscribersExcelFile(file, {
        importedLocally: true,
      });
      if (parsed.length === 0) {
        setLocalExcelNotice(
          'لم يتم التعرف على أسماء مشتركين في الملف. تأكد من وجود عمود باسم "اسم المشترك" أو "الاسم".',
        );
        return;
      }

      const mergedMap = new Map<string, Subscriber>();
      state.subscribers.forEach((existing) => mergedMap.set(existing.id, existing));
      parsed.forEach((item) => {
        const existing = mergedMap.get(item.id);
        if (existing) {
          mergedMap.set(item.id, {
            ...existing,
            subscriberName: item.subscriberName || existing.subscriberName,
            phone:
              item.phone && item.phone !== '770000000'
                ? item.phone
                : existing.phone,
            importedLocally: true,
          });
        } else {
          mergedMap.set(item.id, item);
        }
      });

      const mergedList = Array.from(mergedMap.values());
      onUpdateState({
        ...state,
        subscribers: mergedList,
      });
      if (!selectedSubscriberId && parsed[0]) {
        setSelectedSubscriberId(parsed[0].id);
      }
      setLocalExcelNotice(
        `تم استيراد ${parsed.length} اسم مشترك من ذاكرة هاتفك وحفظهم محلياً للعمل أوفلاين.`,
      );
    } catch {
      setLocalExcelNotice('تعذر قراءة ملف Excel من ذاكرة الهاتف.');
    } finally {
      event.target.value = '';
    }
  };

  const parsedCurrent = Number(readingInput);
  const validNumericReading =
    readingInput.trim() !== '' && Number.isFinite(parsedCurrent);
  const prevReading = selectedSubscriber?.previousReading ?? 0;
  const consumptionKwh = validNumericReading
    ? Math.max(0, parsedCurrent - prevReading)
    : 0;
  const rawBillYer = consumptionKwh * state.station.kwhPriceYer;
  const currentBillYer =
    consumptionKwh > 0
      ? Math.max(rawBillYer, state.station.minimumFeeYer)
      : 0;
  const previousDebtYer = selectedSubscriber?.previousDebtYer ?? 0;
  const totalDueYer = currentBillYer + previousDebtYer;
  const cashPaidYer = permissions.canCollectCash
    ? Math.max(0, Number(cashPaidInput) || 0)
    : 0;
  const remainingBalanceYer = Math.max(0, totalDueYer - cashPaidYer);

  const handleSaveOffline = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSubscriber || !permissions.canRecordReadings) return;

    if (!validNumericReading || parsedCurrent < prevReading) {
      setValidationError(
        `خطأ في التحقق: القراءة الحالية (${readingInput || 0}) يجب أن تكون أكبر من أو تساوي القراءة السابقة (${prevReading}).`,
      );
      return;
    }
    if (!proofPhotoUrl) {
      setValidationError(
        'يرجى تصوير العداد أو إرفاق صورة إثبات للقراءة قبل الحفظ.',
      );
      return;
    }
    setValidationError(null);

    const now = new Date().toISOString();
    const readingId = sanitizeFirestoreId(`rd_${Date.now()}`);
    const collectorName = activeCollector?.name ?? 'مدير المحطة';
    const collectorUid = activeCollector?.id ?? state.station.ownerUid;

    const newReading: MeterReading = {
      id: readingId,
      subscriberId: selectedSubscriber.id,
      meterNumber: selectedSubscriber.meterNumber,
      subscriberName: selectedSubscriber.subscriberName,
      previousReading: prevReading,
      currentReading: parsedCurrent,
      consumptionKwh,
      kwhPriceYer: state.station.kwhPriceYer,
      currentBillYer,
      previousDebtYer,
      totalDueYer,
      photoUrl: proofPhotoUrl,
      photoSizeKb: proofSizeKb,
      hasLocalPhoto: true,
      collectorUid,
      collectorName,
      recordedAt: now,
      syncStatus: 'pending',
    };

    const nextReceipts = [...state.receipts];
    if (cashPaidYer > 0 && permissions.canCollectCash) {
      const newReceipt: PaymentReceipt = {
        id: sanitizeFirestoreId(`rc_${Date.now()}`),
        subscriberId: selectedSubscriber.id,
        meterNumber: selectedSubscriber.meterNumber,
        subscriberName: selectedSubscriber.subscriberName,
        readingId,
        amountPaidYer: cashPaidYer,
        remainingBalanceYer,
        collectorUid,
        collectorName,
        paidAt: now,
        syncStatus: 'pending',
      };
      nextReceipts.unshift(newReceipt);
    }

    const updatedSubscribers = state.subscribers.map((s) =>
      s.id === selectedSubscriber.id
        ? {
            ...s,
            previousReading: parsedCurrent,
            currentReading: parsedCurrent,
            previousDebtYer: remainingBalanceYer,
            syncStatus: 'pending' as const,
            updatedAt: now,
          }
        : s,
    );

    onUpdateState({
      ...state,
      subscribers: updatedSubscribers,
      readings: [newReading, ...state.readings],
      receipts: nextReceipts,
    });

    if (permissions.canSendInvoices) {
      const invoiceMsg = buildArabicInvoiceMessage({
        subscriberName: selectedSubscriber.subscriberName,
        meterNumber: selectedSubscriber.meterNumber,
        previousReading: prevReading,
        currentReading: parsedCurrent,
        consumptionKwh,
        currentBillYer,
        previousDebtYer,
        totalDueYer,
        stationName: state.station.stationName,
      });
      setSavedInvoiceText(invoiceMsg);
    }
  };

  const copyInvoice = async () => {
    if (!savedInvoiceText) return;
    await navigator.clipboard.writeText(savedInvoiceText);
    setCopiedInvoice(true);
    setTimeout(() => setCopiedInvoice(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Real Connectivity & One-Tap Sync Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            تطبيق المحصّل الميداني · {state.station.stationName}
          </h1>
          <p className="text-xs text-slate-600 mt-1 flex items-center gap-2">
            {isOnline ? (
              <span className="inline-flex items-center gap-1 text-teal-700 font-medium">
                <Wifi className="w-3.5 h-3.5" /> متصل بالإنترنت
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-800 font-medium">
                <WifiOff className="w-3.5 h-3.5" /> وضع أوفلاين (يتم الحفظ محلياً)
              </span>
            )}
            <span>·</span>
            <span>
              {pendingCount > 0
                ? `${pendingCount} عملية بانتظار المزامنة`
                : 'جميع السجلات متزامنة'}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() =>
              exportCollectorReadingsExcel(state, activeCollector?.name)
            }
            className="min-h-[44px] px-3.5 py-2 text-xs font-medium rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
          >
            <Download className="w-4 h-4 text-teal-700" />
            حفظ القراءات للكمبيوتر (USB)
          </button>

          <button
            type="button"
            disabled={!isOnline || isSyncing || pendingCount === 0}
            onClick={() => void onSyncNow()}
            className="min-h-[44px] px-4 py-2 text-xs font-medium rounded-lg bg-teal-700 hover:bg-teal-800 disabled:bg-slate-200 disabled:text-slate-500 text-white transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
          >
            {pendingCount === 0 ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <CloudUpload className="w-4 h-4" />
            )}
            {isSyncing
              ? syncProgress
                ? `دفعة ${syncProgress.currentBatch} / ${syncProgress.totalBatches} (${syncProgress.completed} / ${syncProgress.total})`
                : 'جاري المزامنة...'
              : !isOnline
                ? 'بانتظار توفر الإنترنت'
                : pendingCount > 0
                  ? `مزامنة آمنة على دفعات (${pendingCount} معلق)`
                  : 'تمت المزامنة السحابية'}
          </button>
          {isSyncing && syncProgress && syncProgress.total > 0 && (
            <div className="w-full min-w-[200px] bg-slate-200 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-teal-700 h-full transition-all"
                style={{
                  width: `${Math.round((syncProgress.completed / syncProgress.total) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Main 2-Column Field Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Route List */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-slate-900">
                خط السير الميداني ({assignedZones.length > 0 ? assignedZones.join('، ') : 'جميع الحارات'})
              </h2>
              <span className="text-xs text-slate-500 font-mono-nums shrink-0">
                {routeSubscribers.length} عداد
              </span>
            </div>

            <input
              ref={localExcelInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleCollectorLocalExcelImport}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => localExcelInputRef.current?.click()}
              className="w-full min-h-[40px] px-3 py-2 text-xs font-medium bg-slate-50 hover:bg-slate-100 border border-slate-300 text-slate-800 rounded-lg inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <FileSpreadsheet className="w-4 h-4 text-teal-700" />
              خيار إضافي: رفع ملف Excel قديم من ذاكرة الهاتف
            </button>

            {localExcelNotice && (
              <p className="text-xs text-teal-800 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                {localExcelNotice}
              </p>
            )}

            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="بحث بآخر 3-4 أرقام من العداد أو الاسم..."
                className="w-full min-h-[44px] pr-9 pl-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <select
              value={selectedZone}
              onChange={(e) => setSelectedZone(e.target.value)}
              className="w-full min-h-[44px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="all">جميع الشوارع المخصصة</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>

          <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
            {routeSubscribers.map((sub) => {
              const active = selectedSubscriber?.id === sub.id;
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => selectSubscriber(sub)}
                  className={`w-full text-right p-4 flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                    active ? 'bg-teal-50/80' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold font-mono-nums shrink-0 ${
                        active
                          ? 'bg-teal-700 text-white'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {sub.sequenceOrder}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate">
                        {sub.subscriberName}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 truncate">
                        عداد{' '}
                        <span className="font-mono-nums">{sub.meterNumber}</span>{' '}
                        · {sub.zoneStreet} · السابقة{' '}
                        <span className="font-mono-nums">
                          {sub.previousReading}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="text-left shrink-0">
                    {permissions.canViewDebts && (
                      <div className="text-xs font-bold text-slate-900 font-mono-nums">
                        {formatCompactYer(sub.previousDebtYer)}
                      </div>
                    )}
                    <div
                      className={`text-[11px] mt-0.5 ${
                        sub.syncStatus === 'pending'
                          ? 'text-amber-700 font-medium'
                          : 'text-teal-700'
                      }`}
                    >
                      {sub.syncStatus === 'pending' ? 'بانتظار المزامنة' : 'متزامن'}
                    </div>
                  </div>
                </button>
              );
            })}
            {routeSubscribers.length === 0 && (
              <div className="p-8 text-center text-xs text-slate-500">
                لا يوجد مشتركين في نطاق حاراتك المخصصة.
              </div>
            )}
          </div>
        </section>

        {/* Camera Capture + Billing + Receipt */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          {selectedSubscriber ? (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    {selectedSubscriber.subscriberName}
                  </h2>
                  <p className="text-xs text-slate-600 mt-1">
                    رقم العداد{' '}
                    <span className="font-mono-nums font-semibold">
                      {selectedSubscriber.meterNumber}
                    </span>{' '}
                    · {selectedSubscriber.zoneStreet} · القراءة السابقة{' '}
                    <span className="font-mono-nums font-semibold">
                      {selectedSubscriber.previousReading}
                    </span>
                  </p>
                </div>
                {permissions.canViewDebts && (
                  <div className="text-sm font-bold text-rose-700 font-mono-nums">
                    المتأخرات: {formatYer(selectedSubscriber.previousDebtYer)}
                  </div>
                )}
              </div>

              {!permissions.canRecordReadings ? (
                <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                  صلاحية تسجيل القراءات وتصوير العداد غير مفعّلة لك حالياً من قِبل مدير المحطة.
                </div>
              ) : (
                <>
                  {/* Camera Viewfinder */}
                  <div className="space-y-3">
                    <div className="relative h-56 rounded-xl bg-slate-900 overflow-hidden flex items-center justify-center border border-slate-800">
                      {cameraStreamActive ? (
                        <video
                          ref={videoRef}
                          playsInline
                          muted
                          className="w-full h-full object-cover"
                        />
                      ) : proofPhotoUrl ? (
                        <img
                          src={proofPhotoUrl}
                          alt={`صورة إثبات العداد ${selectedSubscriber.meterNumber}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="text-center px-4 space-y-1">
                          <ScanLine className="w-8 h-8 text-teal-400 mx-auto" />
                          <p className="text-xs text-slate-300">
                            صوّر شاشة العداد بوضوح؛ تُضغط الصورة وتُحفظ محلياً في جهازك وتُرفع القراءة النصية بسرعة فائقة
                          </p>
                        </div>
                      )}

                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <div className="w-60 h-20 border-2 border-teal-400 rounded-lg shadow-[0_0_0_9999px_rgba(15,23,42,0.35)] flex items-end justify-center pb-1">
                          <span className="text-[10px] font-medium text-teal-200 bg-slate-900/75 px-2 rounded">
                            إطار تصوير أرقام العداد
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      {!cameraStreamActive ? (
                        <button
                          type="button"
                          onClick={startLiveCamera}
                          className="min-h-[44px] px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-2 cursor-pointer"
                        >
                          <Camera className="w-4 h-4" />
                          فتح الكاميرا المباشرة
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={captureFromLiveCamera}
                          className="min-h-[44px] px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-2 cursor-pointer"
                        >
                          <Camera className="w-4 h-4" />
                          التقاط وضغط الصورة (&lt;150KB)
                        </button>
                      )}

                      <input
                        ref={cameraInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handlePhotoUpload}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => cameraInputRef.current?.click()}
                        className="min-h-[44px] px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-medium rounded-lg inline-flex items-center gap-2 cursor-pointer"
                      >
                        <Upload className="w-4 h-4" />
                        التقاط / اختيار صورة عداد
                      </button>
                    </div>

                    {photoStatus && (
                      <p className="text-xs text-teal-800 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                        {photoStatus}
                      </p>
                    )}
                  </div>

                  {/* Reading & Receipt Form */}
                  <form onSubmit={handleSaveOffline} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          القراءة الحالية للعداد (ك.و.س)
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          value={readingInput}
                          onChange={(e) => {
                            setReadingInput(e.target.value);
                            setValidationError(null);
                          }}
                          placeholder={`أكبر من أو يساوي ${prevReading}`}
                          className="w-full min-h-[46px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                      </div>

                      {permissions.canCollectCash && (
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            سند قبض فوري — المدفوع نقداً (ر.ي)
                          </label>
                          <input
                            type="number"
                            min={0}
                            value={cashPaidInput}
                            onChange={(e) => setCashPaidInput(e.target.value)}
                            placeholder="0 (اختياري)"
                            className="w-full min-h-[46px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                          />
                        </div>
                      )}
                    </div>

                    {validationError && (
                      <p className="text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                        {validationError}
                      </p>
                    )}

                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-slate-600">الاستهلاك المحسوب</span>
                        <span className="font-mono-nums font-semibold text-slate-900">
                          {formatKwh(consumptionKwh)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">
                          مبلغ الاستهلاك ({formatCompactYer(state.station.kwhPriceYer)} / ك.و.س)
                        </span>
                        <span className="font-mono-nums font-semibold text-slate-900">
                          {formatYer(currentBillYer)}
                        </span>
                      </div>
                      {permissions.canViewDebts && (
                        <>
                          <div className="flex justify-between">
                            <span className="text-slate-600">المتأخرات السابقة</span>
                            <span className="font-mono-nums text-slate-800">
                              {formatYer(previousDebtYer)}
                            </span>
                          </div>
                          <div className="border-t border-slate-200 pt-2.5 flex justify-between text-base font-bold">
                            <span className="text-slate-900">الإجمالي المستحق</span>
                            <span className="font-mono-nums text-teal-800">
                              {formatYer(totalDueYer)}
                            </span>
                          </div>
                        </>
                      )}
                    </div>

                    <button
                      type="submit"
                      className="w-full min-h-[48px] py-3 px-4 bg-teal-700 hover:bg-teal-800 text-white text-sm font-bold rounded-lg transition-colors cursor-pointer"
                    >
                      حفظ القراءة {permissions.canCollectCash ? 'وسند القبض ' : ''}أوفلاين
                    </button>
                  </form>

                  {savedInvoiceText && permissions.canSendInvoices && (
                    <div className="border border-teal-200 bg-teal-50/70 rounded-xl p-4 space-y-3">
                      <div className="text-xs font-bold text-teal-900">
                        تم الحفظ — نص الفاتورة الجاهز للإرسال:
                      </div>
                      <p className="text-xs text-slate-800 leading-relaxed bg-white border border-teal-100 rounded-lg p-3">
                        {savedInvoiceText}
                      </p>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <a
                          href={getWhatsAppInvoiceUrl(
                            selectedSubscriber.phone,
                            savedInvoiceText,
                          )}
                          target="_blank"
                          rel="noreferrer"
                          className="min-h-[44px] px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-2"
                        >
                          <MessageCircle className="w-4 h-4" />
                          إرسال عبر واتساب
                        </a>
                        <a
                          href={getSmsInvoiceUrl(
                            selectedSubscriber.phone,
                            savedInvoiceText,
                          )}
                          className="min-h-[44px] px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-2"
                        >
                          <MessageSquare className="w-4 h-4" />
                          إرسال رسالة SMS
                        </a>
                        <button
                          type="button"
                          onClick={copyInvoice}
                          className="min-h-[44px] px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-medium rounded-lg inline-flex items-center gap-2 cursor-pointer"
                        >
                          <Copy className="w-4 h-4" />
                          {copiedInvoice ? 'تم النسخ' : 'نسخ نص الفاتورة'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="py-12 text-center text-slate-500 text-sm">
              لا يوجد مشتركين في خط السير حالياً.
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
