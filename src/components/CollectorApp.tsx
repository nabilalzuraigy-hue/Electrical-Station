import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  CloudUpload,
  Copy,
  Download,
  Edit3,
  Eye,
  FileSpreadsheet,
  Flashlight,
  Lock,
  MessageCircle,
  MessageSquare,
  RotateCcw,
  ScanLine,
  Search,
  ShieldAlert,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  computeSubscriber3MonthAvgKwh,
  exportCollectorReadingsExcel,
  parseSubscribersExcelFile,
  sanitizeFirestoreId,
  sendInstantManagerAlert,
  type StationLocalState,
} from '../lib/offlineDb';
import {
  extractMeterReadingFromImage,
  measureVideoLuminance,
  type MeterOcrResult,
} from '../lib/meterOcr';
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
  LowerReadingReason,
  ManagerAlert,
  MeterReading,
  PaymentReceipt,
  Subscriber,
} from '../types/station';

interface CollectorAppProps {
  state: StationLocalState;
  staffToken: string;
  onUpdateState: (next: StationLocalState) => void;
  onSyncNow: () => Promise<void>;
  isSyncing: boolean;
  syncProgress: import('../types/station').SyncProgress | null;
  activeCollector?: CollectorProfile;
  isManagerPreview?: boolean;
}

const LOWER_REASON_LABELS: Record<LowerReadingReason, string> = {
  meter_replaced: 'تم تغيير العداد بعداد جديد',
  meter_reset: 'تم تصفير العداد',
  previous_error: 'خطأ في القراءة السابقة',
};

export const CollectorApp: React.FC<CollectorAppProps> = ({
  state,
  staffToken,
  onUpdateState,
  onSyncNow,
  isSyncing,
  syncProgress,
  activeCollector,
  isManagerPreview = false,
}) => {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const newMeterCameraInputRef = useRef<HTMLInputElement>(null);
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

  // Ultra-sensitive OCR & Camera State
  const [ocrResult, setOcrResult] = useState<MeterOcrResult | null>(null);
  const [extractingReading, setExtractingReading] = useState(false);
  const [reviewChoice, setReviewChoice] = useState<
    'pending' | 'confirmed' | 'manual_edit'
  >('pending');
  const [manualEditInput, setManualEditInput] = useState('');
  const [showEnhancedPreview, setShowEnhancedPreview] = useState(false);

  // Auto-Flash & Low-Light Telemetry
  const [cameraStreamActive, setCameraStreamActive] = useState(false);
  const [torchActive, setTorchActive] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [liveLowLight, setLiveLowLight] = useState(false);

  // Proof photo & Billing
  const [proofPhotoUrl, setProofPhotoUrl] = useState<string>('');
  const [proofSizeKb, setProofSizeKb] = useState<number>(0);
  const [photoStatus, setPhotoStatus] = useState<string | null>(null);
  const [cashPaidInput, setCashPaidInput] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<string | null>(
    null,
  );
  const [savedInvoiceText, setSavedInvoiceText] = useState<string | null>(null);
  const [copiedInvoice, setCopiedInvoice] = useState(false);
  const [localExcelNotice, setLocalExcelNotice] = useState<string | null>(null);

  // Lower-than-previous modal state
  const [lowerModalOpen, setLowerModalOpen] = useState(false);
  const [lowerReason, setLowerReason] =
    useState<LowerReadingReason>('meter_replaced');
  const [newMeterNumberInput, setNewMeterNumberInput] = useState('');
  const [openingReadingInput, setOpeningReadingInput] = useState('');
  const [newMeterPhotoUrl, setNewMeterPhotoUrl] = useState('');
  const [newMeterPhotoKb, setNewMeterPhotoKb] = useState(0);
  const [lowerModalError, setLowerModalError] = useState<string | null>(null);

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

  // Monitor live video brightness and auto-enable torch in dim environments
  useEffect(() => {
    if (!cameraStreamActive) return;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const luma = measureVideoLuminance(video);
      const isDim = luma < 80;
      setLiveLowLight(isDim);

      const stream = video.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()?.[0];
      if (!track) return;
      const caps = track.getCapabilities?.() as
        | (MediaTrackCapabilities & { torch?: boolean })
        | undefined;
      if (caps?.torch) {
        setTorchSupported(true);
        if (isDim && !torchActive) {
          void track
            .applyConstraints({
              advanced: [{ torch: true } as MediaTrackConstraintSet],
            })
            .then(() => setTorchActive(true))
            .catch(() => {});
        }
      }
    }, 700);
    return () => window.clearInterval(interval);
  }, [cameraStreamActive, torchActive]);

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

  const collectorActive = isManagerPreview
    ? true
    : Boolean(activeCollector?.active);
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
    const al = (state.alerts ?? []).filter(
      (x) => x.syncStatus === 'pending',
    ).length;
    return r + rc + s + al;
  }, [state]);

  if (!collectorActive) {
    return (
      <div className="bg-white border border-rose-200 rounded-xl p-8 text-center space-y-3">
        <ShieldAlert className="w-10 h-10 text-rose-700 mx-auto" />
        <h2 className="text-lg font-bold text-slate-900">
          تم إيقاف صلاحية حساب المحصّل مؤقتاً
        </h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          قام مدير المحطة ({state.station.stationName}) بتعطيل حسابك. تواصل مع
          مدير المحطة لإعادة التفعيل.
        </p>
      </div>
    );
  }

  const resetReadingWorkspace = () => {
    setOcrResult(null);
    setExtractingReading(false);
    setReviewChoice('pending');
    setManualEditInput('');
    setShowEnhancedPreview(false);
    setCashPaidInput('');
    setProofPhotoUrl('');
    setProofSizeKb(0);
    setPhotoStatus(null);
    setValidationError(null);
    setSaveSuccessNotice(null);
    setSavedInvoiceText(null);
    setLowerModalOpen(false);
    setNewMeterNumberInput('');
    setOpeningReadingInput('');
    setNewMeterPhotoUrl('');
    setNewMeterPhotoKb(0);
    setLowerModalError(null);
  };

  const selectSubscriber = (sub: Subscriber) => {
    setSelectedSubscriberId(sub.id);
    resetReadingWorkspace();
  };

  const avg3MonthsKwh = selectedSubscriber
    ? computeSubscriber3MonthAvgKwh(selectedSubscriber, state.readings)
    : 0;

  const runAutoMeterExtraction = async (
    dataUrl: string,
    sizeKb: number,
    prevVal: number,
  ) => {
    setExtractingReading(true);
    setOcrResult(null);
    setReviewChoice('pending');
    setManualEditInput('');
    setValidationError(null);
    setSaveSuccessNotice(null);
    setPhotoStatus(
      `تم ضغط الصورة (${sizeKb} KB) · جاري تحسين التباين وإزالة الظل وقراءة العداد 3 مرات...`,
    );

    const result = await extractMeterReadingFromImage({
      imageDataUrl: dataUrl,
      stationId: state.station.stationId,
      staffToken,
      previousReading: prevVal,
      avg3MonthsKwh,
    });

    setExtractingReading(false);
    setOcrResult(result);

    if (!result.accepted || result.reading === null) {
      setPhotoStatus(
        `تم الفحص عبر ${result.totalPasses} قراءات · الثقة ${result.confidence}% (مطلوب ≥ 85% وتطابق مرتين على الأقل).`,
      );
      setValidationError(
        result.message ||
          'تعذر اعتماد القراءة من الصورة — يرجى إعادة تصوير شاشة العداد بوضوح.',
      );
      return;
    }

    setManualEditInput(String(result.reading));
    setPhotoStatus(
      `تمت قراءة العداد عبر OCR بنجاح (${result.reading}) · تطابق ${result.agreementCount}/${result.totalPasses} · نسبة الثقة ${result.confidence}%.`,
    );
  };

  const startLiveCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      setCameraStreamActive(true);
      setTorchActive(false);
      setLiveLowLight(false);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
        const track = stream.getVideoTracks()?.[0];
        const caps = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & { torch?: boolean })
          | undefined;
        setTorchSupported(Boolean(caps?.torch));
      }, 80);
    } catch {
      setPhotoStatus(
        'تعذر فتح الكاميرا المباشرة في المتصفح — استخدم زر "التقاط / اختيار صورة عداد".',
      );
    }
  };

  const toggleManualTorch = async () => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    const track = stream?.getVideoTracks()?.[0];
    if (!track || !torchSupported) return;
    const next = !torchActive;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchActive(next);
    } catch {
      // ignore unsupported constraint failures
    }
  };

  const stopLiveCamera = () => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    setCameraStreamActive(false);
    setTorchActive(false);
  };

  const captureFromLiveCamera = async () => {
    if (!videoRef.current || !selectedSubscriber) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth || 1280;
    canvas.height = videoRef.current.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    if (!blob) return;

    const compressed = await compressImageUnder150Kb(blob);
    setProofPhotoUrl(compressed.dataUrl);
    setProofSizeKb(compressed.sizeKb);
    stopLiveCamera();
    await runAutoMeterExtraction(
      compressed.dataUrl,
      compressed.sizeKb,
      selectedSubscriber.previousReading,
    );
  };

  const handlePhotoUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file || !selectedSubscriber) return;
    setPhotoStatus('جاري تحسين جودة صورة العداد وقراءتها عبر OCR...');
    try {
      const compressed = await compressImageUnder150Kb(file);
      setProofPhotoUrl(compressed.dataUrl);
      setProofSizeKb(compressed.sizeKb);
      await runAutoMeterExtraction(
        compressed.dataUrl,
        compressed.sizeKb,
        selectedSubscriber.previousReading,
      );
    } catch {
      setPhotoStatus('تعذر معالجة الصورة المختارة.');
    } finally {
      event.target.value = '';
    }
  };

  const handleNewMeterPhotoUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImageUnder150Kb(file);
      setNewMeterPhotoUrl(compressed.dataUrl);
      setNewMeterPhotoKb(compressed.sizeKb);
      setLowerModalError(null);
    } catch {
      setLowerModalError('تعذر ضغط صورة العداد الجديد.');
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

  const prevReading = selectedSubscriber?.previousReading ?? 0;
  const ocrOriginalReading = ocrResult?.accepted ? ocrResult.reading : null;
  const parsedManualEdit = Number(manualEditInput);

  const activeFinalReading: number | null =
    reviewChoice === 'confirmed'
      ? ocrOriginalReading
      : reviewChoice === 'manual_edit' &&
          manualEditInput.trim() !== '' &&
          Number.isFinite(parsedManualEdit) &&
          parsedManualEdit >= 0
        ? Math.round(parsedManualEdit * 100) / 100
        : null;

  const isManuallyEdited =
    reviewChoice === 'manual_edit' &&
    ocrOriginalReading !== null &&
    activeFinalReading !== null &&
    activeFinalReading !== ocrOriginalReading;

  const isClosedHouseZero =
    activeFinalReading !== null && activeFinalReading === prevReading;
  const isLowerThanPrev =
    activeFinalReading !== null && activeFinalReading < prevReading;

  const consumptionKwh =
    activeFinalReading !== null && activeFinalReading >= prevReading
      ? Math.max(0, Math.round((activeFinalReading - prevReading) * 100) / 100)
      : 0;
  const isHighConsumptionWarning =
    avg3MonthsKwh > 0 && consumptionKwh > avg3MonthsKwh * 3;

  const rawBillYer = Math.round(consumptionKwh * state.station.kwhPriceYer);
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

  const persistAndDispatchReading = async (options?: {
    lowerReason?: LowerReadingReason;
    newMeterNumber?: string;
    openingReading?: number;
    overridePhotoUrl?: string;
    overridePhotoKb?: number;
  }) => {
    if (!selectedSubscriber || activeFinalReading === null) return;

    const now = new Date().toISOString();
    const readingId = sanitizeFirestoreId(`rd_${Date.now()}`);
    const collectorName = activeCollector?.name ?? 'مدير المحطة';
    const collectorUid = activeCollector?.id ?? state.station.ownerUid;

    const requiresManagerApproval =
      isManuallyEdited || Boolean(options?.lowerReason);
    const effectivePhoto = options?.overridePhotoUrl || proofPhotoUrl;
    const effectiveKb = options?.overridePhotoKb || proofSizeKb;

    const newReading: MeterReading = {
      id: readingId,
      subscriberId: selectedSubscriber.id,
      meterNumber: selectedSubscriber.meterNumber,
      subscriberName: selectedSubscriber.subscriberName,
      previousReading: prevReading,
      currentReading: activeFinalReading,
      consumptionKwh,
      kwhPriceYer: state.station.kwhPriceYer,
      currentBillYer,
      previousDebtYer,
      totalDueYer,
      photoUrl: effectivePhoto,
      photoSizeKb: effectiveKb,
      hasLocalPhoto: true,
      readingSource: isManuallyEdited ? 'manual_override' : 'camera_ocr',
      ocrConfidence: ocrResult?.confidence ?? 0,
      ...(ocrOriginalReading !== null ? { ocrOriginalReading } : {}),
      wasManuallyEdited: isManuallyEdited,
      ...(isManuallyEdited ? { editedAt: now } : {}),
      approvalStatus: requiresManagerApproval ? 'pending_manager' : 'approved',
      ...(options?.lowerReason ? { lowerReadingReason: options.lowerReason } : {}),
      ...(options?.newMeterNumber
        ? { newMeterNumber: options.newMeterNumber }
        : {}),
      ...(typeof options?.openingReading === 'number'
        ? { openingReading: options.openingReading }
        : {}),
      isClosedHouseZero,
      ...(isClosedHouseZero
        ? { zeroConsumptionNote: 'استهلاك صفر - بيت مغلق' }
        : {}),
      highConsumptionWarning: isHighConsumptionWarning,
      collectorUid,
      collectorName,
      recordedAt: now,
      syncStatus: 'pending',
    };

    const alertsToQueue: ManagerAlert[] = [];

    // 1) Immediate alert when collector manually modified OCR reading
    if (isManuallyEdited && ocrOriginalReading !== null) {
      alertsToQueue.push({
        id: sanitizeFirestoreId(`al_edit_${Date.now()}`),
        stationId: state.station.stationId,
        alertType: 'manual_edit',
        severity: 'critical',
        status: 'pending',
        readingId,
        subscriberId: selectedSubscriber.id,
        subscriberName: selectedSubscriber.subscriberName,
        meterNumber: selectedSubscriber.meterNumber,
        collectorName,
        collectorCode: activeCollector?.code,
        ocrOriginalReading,
        editedReading: activeFinalReading,
        previousReading: prevReading,
        difference:
          Math.round((activeFinalReading - ocrOriginalReading) * 100) / 100,
        ...(options?.lowerReason
          ? { lowerReadingReason: options.lowerReason }
          : {}),
        ...(options?.newMeterNumber
          ? { newMeterNumber: options.newMeterNumber }
          : {}),
        ...(typeof options?.openingReading === 'number'
          ? { openingReading: options.openingReading }
          : {}),
        photoUrl: effectivePhoto,
        createdAt: now,
        syncStatus: 'pending',
      });
    } else if (options?.lowerReason) {
      // 2) Immediate alert when reading is lower than previous (reason + photo)
      alertsToQueue.push({
        id: sanitizeFirestoreId(`al_low_${Date.now()}`),
        stationId: state.station.stationId,
        alertType: 'lower_reading',
        severity: 'critical',
        status: 'pending',
        readingId,
        subscriberId: selectedSubscriber.id,
        subscriberName: selectedSubscriber.subscriberName,
        meterNumber: selectedSubscriber.meterNumber,
        collectorName,
        collectorCode: activeCollector?.code,
        ...(ocrOriginalReading !== null ? { ocrOriginalReading } : {}),
        editedReading: activeFinalReading,
        previousReading: prevReading,
        difference: Math.round((activeFinalReading - prevReading) * 100) / 100,
        lowerReadingReason: options.lowerReason,
        ...(options.newMeterNumber
          ? { newMeterNumber: options.newMeterNumber }
          : {}),
        ...(typeof options.openingReading === 'number'
          ? { openingReading: options.openingReading }
          : {}),
        photoUrl: effectivePhoto,
        createdAt: now,
        syncStatus: 'pending',
      });
    }

    // 3) Yellow alert if consumption > 3x last-3-months average
    if (isHighConsumptionWarning) {
      alertsToQueue.push({
        id: sanitizeFirestoreId(`al_high_${Date.now() + 1}`),
        stationId: state.station.stationId,
        alertType: 'high_consumption',
        severity: 'warning',
        status: 'pending',
        readingId,
        subscriberId: selectedSubscriber.id,
        subscriberName: selectedSubscriber.subscriberName,
        meterNumber: selectedSubscriber.meterNumber,
        collectorName,
        collectorCode: activeCollector?.code,
        editedReading: activeFinalReading,
        previousReading: prevReading,
        consumptionKwh,
        avg3MonthsKwh,
        photoUrl: effectivePhoto,
        createdAt: now,
        syncStatus: 'pending',
      });
    }

    // Instant dispatch when online so manager gets notified right away
    let syncedAlerts: ManagerAlert[] = alertsToQueue;
    if (isOnline && staffToken && alertsToQueue.length > 0) {
      const updatedAlerts: ManagerAlert[] = [];
      for (const al of alertsToQueue) {
        try {
          await sendInstantManagerAlert({
            staffToken,
            stationId: state.station.stationId,
            alert: al,
            reading: newReading,
          });
          updatedAlerts.push({ ...al, syncStatus: 'synced' });
        } catch {
          updatedAlerts.push(al);
        }
      }
      syncedAlerts = updatedAlerts;
    }

    const nextReceipts = [...state.receipts];
    if (
      !requiresManagerApproval &&
      cashPaidYer > 0 &&
      permissions.canCollectCash
    ) {
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

    // Only advance subscriber's official previousReading / balance immediately if NO manager approval is needed
    const updatedSubscribers = requiresManagerApproval
      ? state.subscribers
      : state.subscribers.map((s) =>
          s.id === selectedSubscriber.id
            ? {
                ...s,
                previousReading: activeFinalReading,
                currentReading: activeFinalReading,
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
      alerts: [...syncedAlerts, ...(state.alerts ?? [])],
    });

    if (requiresManagerApproval) {
      setSaveSuccessNotice(
        isOnline
          ? 'تم إرسال القراءة والصورة وإشعار فوري إلى مدير المحطة — لن تُعتمد القراءة في حساب المشترك إلا بعد موافقة المدير.'
          : 'تم حفظ القراءة المعلقة وإشعار المدير محلياً — سيُرفع الإشعار تلقائياً عند توفر الإنترنت ولن تُعتمد إلا بموافقة المدير.',
      );
      setSavedInvoiceText(null);
      return;
    }

    setSaveSuccessNotice(
      isClosedHouseZero
        ? 'تم حفظ القراءة بنجاح بحالة: استهلاك صفر - بيت مغلق.'
        : isHighConsumptionWarning
          ? 'تم حفظ القراءة وإرسال تنبيه أصفر للمدير بسبب ارتفاع الاستهلاك عن 3 أضعاف المتوسط.'
          : 'تم حفظ القراءة المعتمدة أوفلاين بنجاح.',
    );

    if (permissions.canSendInvoices) {
      const invoiceMsg = buildArabicInvoiceMessage({
        subscriberName: selectedSubscriber.subscriberName,
        meterNumber: selectedSubscriber.meterNumber,
        previousReading: prevReading,
        currentReading: activeFinalReading,
        consumptionKwh,
        currentBillYer,
        previousDebtYer,
        totalDueYer,
        stationName: state.station.stationName,
      });
      setSavedInvoiceText(
        isClosedHouseZero
          ? `${invoiceMsg}\nملاحظة الحالة: استهلاك صفر - بيت مغلق.`
          : invoiceMsg,
      );
    }
  };

  const handleSaveFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSubscriber || !permissions.canRecordReadings) return;

    if (!proofPhotoUrl) {
      setValidationError('يرجى تصوير العداد أو إرفاق صورة العداد أولاً.');
      return;
    }
    if (extractingReading) {
      setValidationError('يرجى الانتظار حتى يكتمل فحص القراءة من الصورة.');
      return;
    }
    if (!ocrResult?.accepted || ocrOriginalReading === null) {
      setValidationError(
        ocrResult?.message ||
          'لم تُعتمد قراءة صالحة من OCR (يجب ≥ 85% ثقة وتطابق مرتين) — يرجى إعادة تصوير العداد.',
      );
      return;
    }
    if (reviewChoice === 'pending') {
      setValidationError(
        'يرجى الضغط على زر "تأكيد القراءة" أو "تعديل يدوي" للمراجعة قبل الحفظ.',
      );
      return;
    }
    if (activeFinalReading === null) {
      setValidationError('يرجى إدخال قيمة رقمية صحيحة في خانة التعديل اليدوي.');
      return;
    }
    setValidationError(null);

    // If new reading < previous reading: pause and ask reason instead of rejecting permanently
    if (activeFinalReading < prevReading) {
      setOpeningReadingInput(String(activeFinalReading));
      setLowerModalError(null);
      setLowerModalOpen(true);
      return;
    }

    await persistAndDispatchReading();
  };

  const handleConfirmLowerReadingModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lowerReason === 'meter_replaced') {
      if (!newMeterNumberInput.trim()) {
        setLowerModalError('يرجى إدخال رقم العداد الجديد.');
        return;
      }
      const openVal = Number(openingReadingInput);
      if (openingReadingInput.trim() === '' || !Number.isFinite(openVal) || openVal < 0) {
        setLowerModalError('يرجى إدخال القراءة الافتتاحية للعداد الجديد.');
        return;
      }
      if (!newMeterPhotoUrl) {
        setLowerModalError('يرجى تصوير العداد الجديد وإرفاق صورته.');
        return;
      }
      setLowerModalError(null);
      setLowerModalOpen(false);
      await persistAndDispatchReading({
        lowerReason,
        newMeterNumber: newMeterNumberInput.trim(),
        openingReading: openVal,
        overridePhotoUrl: newMeterPhotoUrl,
        overridePhotoKb: newMeterPhotoKb,
      });
      return;
    }

    setLowerModalError(null);
    setLowerModalOpen(false);
    await persistAndDispatchReading({
      lowerReason,
    });
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
                خط السير الميداني (
                {assignedZones.length > 0
                  ? assignedZones.join('، ')
                  : 'جميع الحارات'}
                )
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

        {/* Camera Capture + Ultra-Sensitive OCR Review + Billing */}
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
                    {avg3MonthsKwh > 0 && (
                      <>
                        {' '}
                        · متوسط 3 أشهر{' '}
                        <span className="font-mono-nums font-semibold">
                          {avg3MonthsKwh} ك.و.س
                        </span>
                      </>
                    )}
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
                  صلاحية تسجيل القراءات وتصوير العداد غير مفعّلة لك حالياً من
                  قِبل مدير المحطة.
                </div>
              ) : (
                <>
                  {/* Camera Viewfinder with Auto-Flash & Zoom ROI */}
                  <div className="space-y-3">
                    <div className="relative h-60 rounded-xl bg-slate-900 overflow-hidden flex items-center justify-center border border-slate-800">
                      {cameraStreamActive ? (
                        <video
                          ref={videoRef}
                          playsInline
                          muted
                          className="w-full h-full object-cover"
                        />
                      ) : showEnhancedPreview && ocrResult?.zoomedBwPreviewUrl ? (
                        <img
                          src={ocrResult.zoomedBwPreviewUrl}
                          alt="معالجة الصورة المكبّرة بالأبيض والأسود"
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-contain bg-white"
                        />
                      ) : proofPhotoUrl ? (
                        <img
                          src={proofPhotoUrl}
                          alt={`صورة إثبات العداد ${selectedSubscriber.meterNumber}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="text-center px-4 space-y-1.5">
                          <ScanLine className="w-8 h-8 text-teal-400 mx-auto" />
                          <p className="text-xs text-slate-200 font-medium">
                            محرك OCR فائق الحساسية: إزالة الظل والغبار + فلاش تلقائي للإضاءة الضعيفة
                          </p>
                          <p className="text-[11px] text-slate-400">
                            ضع أرقام العداد داخل الإطار ليقرأها النظام 3 مرات بدقة ≥ 85%
                          </p>
                        </div>
                      )}

                      {(cameraStreamActive || !proofPhotoUrl) && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                          <div className="w-64 h-24 border-2 border-teal-400 rounded-lg shadow-[0_0_0_9999px_rgba(15,23,42,0.38)] flex items-end justify-center pb-1">
                            <span className="text-[10px] font-medium text-teal-100 bg-slate-900/80 px-2 rounded">
                              إطار تكبير أرقام العداد
                            </span>
                          </div>
                        </div>
                      )}

                      {cameraStreamActive && liveLowLight && (
                        <div className="absolute top-3 right-3 bg-amber-500/95 text-slate-950 text-[11px] font-bold px-2.5 py-1 rounded-md inline-flex items-center gap-1.5">
                          <Flashlight className="w-3.5 h-3.5" />
                          {torchActive
                            ? 'إضاءة ضعيفة — الفلاش مُفعّل تلقائياً'
                            : 'إضاءة ضعيفة — شغّل الفلاش'}
                        </div>
                      )}
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
                        <>
                          <button
                            type="button"
                            onClick={captureFromLiveCamera}
                            className="min-h-[44px] px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-2 cursor-pointer"
                          >
                            <Camera className="w-4 h-4" />
                            التقاط وتحليل الصورة (OCR)
                          </button>
                          {torchSupported && (
                            <button
                              type="button"
                              onClick={() => void toggleManualTorch()}
                              className={`min-h-[44px] px-3.5 py-2 text-xs font-medium rounded-lg border inline-flex items-center gap-1.5 cursor-pointer ${
                                torchActive
                                  ? 'bg-amber-100 border-amber-400 text-amber-900'
                                  : 'bg-white border-slate-300 text-slate-700'
                              }`}
                            >
                              <Flashlight className="w-4 h-4" />
                              {torchActive ? 'إطفاء الفلاش' : 'تشغيل الفلاش'}
                            </button>
                          )}
                        </>
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

                      {ocrResult?.zoomedBwPreviewUrl && (
                        <button
                          type="button"
                          onClick={() => setShowEnhancedPreview((v) => !v)}
                          className="min-h-[44px] px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Eye className="w-4 h-4 text-teal-700" />
                          {showEnhancedPreview
                            ? 'عرض الصورة الأصلية'
                            : 'عرض المعالجة المكبّرة'}
                        </button>
                      )}
                    </div>

                    {photoStatus && (
                      <p className="text-xs text-teal-900 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                        {photoStatus}
                      </p>
                    )}

                    {/* Multi-Engine 3-Pass Diagnostic Strip */}
                    {ocrResult && (
                      <div className="border border-slate-200 rounded-xl p-3.5 bg-slate-50 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-bold text-slate-800">
                            نتائج القراءة المتعددة ({ocrResult.totalPasses}{' '}
                            قراءات بأكثر من محرك OCR)
                          </span>
                          <span
                            className={`font-mono-nums font-bold ${
                              ocrResult.accepted
                                ? 'text-teal-700'
                                : 'text-rose-700'
                            }`}
                          >
                            الثقة: {ocrResult.confidence}% · التطابق:{' '}
                            {ocrResult.agreementCount}/{ocrResult.totalPasses}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          {ocrResult.passes.map((p, idx) => (
                            <div
                              key={`${p.engine}_${idx}`}
                              className="bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-[11px]"
                            >
                              <div className="text-slate-500 truncate">
                                {p.label}
                              </div>
                              <div className="flex items-center justify-between mt-1 font-mono-nums">
                                <span className="font-bold text-slate-900">
                                  {p.reading !== null ? p.reading : 'غير مقروء'}
                                </span>
                                <span className="text-slate-600">
                                  {p.confidence}%
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                        {!ocrResult.accepted && (
                          <div className="flex items-center justify-between gap-3 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                            <span className="text-xs text-rose-800 font-medium">
                              {ocrResult.message}
                            </span>
                            <button
                              type="button"
                              onClick={() => cameraInputRef.current?.click()}
                              className="px-3 py-1.5 text-xs font-bold bg-rose-700 hover:bg-rose-800 text-white rounded-md inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              إعادة التصوير
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* OCR Review, Confirm or Manual Edit + Cash Receipt Form */}
                  <form onSubmit={handleSaveFormSubmit} className="space-y-4">
                    {ocrResult?.accepted && ocrOriginalReading !== null && (
                      <div className="border border-teal-200 bg-teal-50/50 rounded-xl p-4 space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <div>
                            <div className="text-xs font-medium text-slate-600">
                              الرقم المقروء والمعتمد من OCR (تطابق{' '}
                              {ocrResult.agreementCount}/
                              {ocrResult.totalPasses})
                            </div>
                            <div className="text-2xl font-bold font-mono-nums text-slate-900 mt-0.5">
                              {ocrOriginalReading}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setReviewChoice('confirmed');
                                setValidationError(null);
                              }}
                              className={`min-h-[42px] px-4 py-2 text-xs font-bold rounded-lg inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                                reviewChoice === 'confirmed'
                                  ? 'bg-teal-700 text-white'
                                  : 'bg-white border border-teal-300 text-teal-900 hover:bg-teal-50'
                              }`}
                            >
                              <Check className="w-4 h-4" />
                              تأكيد القراءة
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setReviewChoice('manual_edit');
                                setManualEditInput(String(ocrOriginalReading));
                                setValidationError(null);
                              }}
                              className={`min-h-[42px] px-4 py-2 text-xs font-bold rounded-lg inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                                reviewChoice === 'manual_edit'
                                  ? 'bg-amber-600 text-white'
                                  : 'bg-white border border-amber-300 text-amber-900 hover:bg-amber-50'
                              }`}
                            >
                              <Edit3 className="w-4 h-4" />
                              تعديل يدوي
                            </button>
                          </div>
                        </div>

                        {reviewChoice === 'manual_edit' && (
                          <div className="bg-white border border-amber-300 rounded-lg p-3 space-y-2">
                            <label className="block text-xs font-bold text-amber-900">
                              أدخل القراءة المعدلة يدوياً (سيُرسل إشعار فوري
                              للمدير ولن تُعتمد إلا بموافقته):
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min={0}
                              value={manualEditInput}
                              onChange={(e) =>
                                setManualEditInput(e.target.value)
                              }
                              className="w-full min-h-[44px] px-3 py-2 text-base font-bold font-mono-nums border border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500"
                            />
                            {isManuallyEdited && activeFinalReading !== null && (
                              <p className="text-[11px] text-rose-700 font-medium">
                                سجل التدقيق: الأصلي من OCR ({ocrOriginalReading})
                                ← الجديد ({activeFinalReading}) · الفارق (
                                {Math.round(
                                  (activeFinalReading - ocrOriginalReading) *
                                    100,
                                ) / 100}
                                ) · المحصّل:{' '}
                                {activeCollector?.name ?? 'مدير المحطة'}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 mb-1">
                          <Lock className="w-3.5 h-3.5 text-teal-700" />
                          القراءة النهائية للمراجعة
                        </label>
                        <div className="w-full min-h-[46px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 bg-slate-100 text-slate-900 rounded-lg flex items-center justify-between">
                          <span>
                            {extractingReading
                              ? 'جاري المسح 3 مرات...'
                              : activeFinalReading !== null
                                ? activeFinalReading
                                : ocrResult?.accepted
                                  ? 'اختر تأكيد أو تعديل أعلاه'
                                  : 'بانتظار صورة واضحة ≥ 85%'}
                          </span>
                          <span className="text-[11px] font-sans font-medium text-teal-800">
                            {isManuallyEdited
                              ? 'معدّلة (بانتظار المدير)'
                              : reviewChoice === 'confirmed'
                                ? 'مؤكدة من OCR'
                                : 'قراءة OCR'}
                          </span>
                        </div>
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

                    {/* Zero Consumption Closed House Badge */}
                    {isClosedHouseZero && (
                      <div className="bg-sky-50 border border-sky-200 rounded-lg px-3.5 py-2.5 flex items-center justify-between text-xs text-sky-900">
                        <span className="font-bold">
                          حالة القراءة: استهلاك صفر - بيت مغلق
                        </span>
                        <span>القراءة الجديدة تساوي السابقة تماماً ({prevReading})</span>
                      </div>
                    )}

                    {/* Lower Reading Info Notice */}
                    {isLowerThanPrev && (
                      <div className="bg-amber-50 border border-amber-300 rounded-lg px-3.5 py-2.5 text-xs text-amber-950 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                        <span>
                          القراءة ({activeFinalReading}) أقل من السابقة ({prevReading}) — عند الحفظ سيُطلب تحديد السبب وإرسال إشعار لموافقة المدير.
                        </span>
                      </div>
                    )}

                    {/* High Consumption Yellow Alert Preview */}
                    {isHighConsumptionWarning && (
                      <div className="bg-amber-50 border border-amber-300 rounded-lg px-3.5 py-2.5 text-xs text-amber-950 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        <span>
                          تنبيه أصفر: الاستهلاك ({consumptionKwh} ك.و.س) أعلى من 3 أضعاف متوسط آخر 3 أشهر ({avg3MonthsKwh} ك.و.س) — سيُرسل تنبيه للمدير.
                        </span>
                      </div>
                    )}

                    {validationError && (
                      <p className="text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                        {validationError}
                      </p>
                    )}

                    {saveSuccessNotice && (
                      <p className="text-xs font-medium text-teal-900 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                        {saveSuccessNotice}
                      </p>
                    )}

                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-slate-600">الاستهلاك المحسوب</span>
                        <span className="font-mono-nums font-semibold text-slate-900">
                          {isClosedHouseZero
                            ? '0 ك.و.س (بيت مغلق)'
                            : formatKwh(consumptionKwh)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">
                          مبلغ الاستهلاك (
                          {formatCompactYer(state.station.kwhPriceYer)} / ك.و.س)
                        </span>
                        <span className="font-mono-nums font-semibold text-slate-900">
                          {formatYer(currentBillYer)}
                        </span>
                      </div>
                      {permissions.canViewDebts && (
                        <>
                          <div className="flex justify-between">
                            <span className="text-slate-600">
                              المتأخرات السابقة
                            </span>
                            <span className="font-mono-nums text-slate-800">
                              {formatYer(previousDebtYer)}
                            </span>
                          </div>
                          <div className="border-t border-slate-200 pt-2.5 flex justify-between text-base font-bold">
                            <span className="text-slate-900">
                              الإجمالي المستحق
                            </span>
                            <span className="font-mono-nums text-teal-800">
                              {formatYer(totalDueYer)}
                            </span>
                          </div>
                        </>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={
                        extractingReading ||
                        !proofPhotoUrl ||
                        !ocrResult?.accepted ||
                        reviewChoice === 'pending' ||
                        activeFinalReading === null
                      }
                      className="w-full min-h-[48px] py-3 px-4 bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-600 text-white text-sm font-bold rounded-lg transition-colors cursor-pointer"
                    >
                      {extractingReading
                        ? 'جاري قراءة العداد 3 مرات وتحسين الصورة...'
                        : isLowerThanPrev
                          ? 'متابعة وتحديد سبب نقص القراءة'
                          : isManuallyEdited
                            ? 'حفظ وإرسال إشعار التعديل لموافقة المدير'
                            : `حفظ القراءة المؤكدة ${permissions.canCollectCash ? 'وسند القبض ' : ''}أوفلاين`}
                    </button>
                  </form>

                  {savedInvoiceText && permissions.canSendInvoices && (
                    <div className="border border-teal-200 bg-teal-50/70 rounded-xl p-4 space-y-3">
                      <div className="text-xs font-bold text-teal-900">
                        تم الحفظ — نص الفاتورة الجاهز للإرسال:
                      </div>
                      <p className="text-xs text-slate-800 leading-relaxed bg-white border border-teal-100 rounded-lg p-3 whitespace-pre-line">
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

      {/* Lower-Than-Previous Reading Modal */}
      {lowerModalOpen && selectedSubscriber && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  القراءة أقل من السابقة، اختر السبب:
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  السابقة:{' '}
                  <span className="font-mono-nums font-bold">
                    {prevReading}
                  </span>{' '}
                  ← الجديدة:{' '}
                  <span className="font-mono-nums font-bold">
                    {activeFinalReading}
                  </span>{' '}
                  · لن تُعتمد إلا بعد موافقة مدير المحطة
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLowerModalOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-800 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={handleConfirmLowerReadingModal}
              className="space-y-4"
            >
              <div className="space-y-2">
                {(
                  [
                    'meter_replaced',
                    'meter_reset',
                    'previous_error',
                  ] as LowerReadingReason[]
                ).map((key) => (
                  <label
                    key={key}
                    className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                      lowerReason === key
                        ? 'border-teal-600 bg-teal-50/70'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="lowerReason"
                      checked={lowerReason === key}
                      onChange={() => setLowerReason(key)}
                      className="accent-teal-700"
                    />
                    <span className="text-sm font-medium text-slate-900">
                      {LOWER_REASON_LABELS[key]}
                    </span>
                  </label>
                ))}
              </div>

              {lowerReason === 'meter_replaced' && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        رقم العداد الجديد
                      </label>
                      <input
                        type="text"
                        value={newMeterNumberInput}
                        onChange={(e) => setNewMeterNumberInput(e.target.value)}
                        placeholder="أدخل رقم العداد الجديد"
                        className="w-full px-3 py-2 text-sm font-mono-nums border border-slate-300 rounded-lg bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        القراءة الافتتاحية للعداد الجديد
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        value={openingReadingInput}
                        onChange={(e) => setOpeningReadingInput(e.target.value)}
                        className="w-full px-3 py-2 text-sm font-mono-nums border border-slate-300 rounded-lg bg-white"
                      />
                    </div>
                  </div>

                  <div>
                    <input
                      ref={newMeterCameraInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handleNewMeterPhotoUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => newMeterCameraInputRef.current?.click()}
                      className="w-full min-h-[42px] px-3 py-2 text-xs font-bold bg-slate-900 hover:bg-slate-800 text-white rounded-lg inline-flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Camera className="w-4 h-4" />
                      {newMeterPhotoUrl
                        ? `تم تصوير العداد الجديد (${newMeterPhotoKb} KB) — تغيير`
                        : 'تصوير العداد الجديد (إلزامي)'}
                    </button>
                    {newMeterPhotoUrl && (
                      <img
                        src={newMeterPhotoUrl}
                        alt="صورة العداد الجديد"
                        referrerPolicy="no-referrer"
                        className="mt-2 h-28 w-full object-cover rounded-lg border border-slate-300"
                      />
                    )}
                  </div>
                </div>
              )}

              {lowerModalError && (
                <p className="text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                  {lowerModalError}
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setLowerModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-xs font-bold text-white bg-teal-700 hover:bg-teal-800 rounded-lg cursor-pointer"
                >
                  إرسال للمدير وانتظار الموافقة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
