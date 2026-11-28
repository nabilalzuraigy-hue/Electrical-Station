import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  CloudUpload,
  Copy,
  Download,
  Eye,
  FileSpreadsheet,
  Lock,
  MapPin,
  MessageCircle,
  MessageSquare,
  RotateCcw,
  ScanLine,
  Search,
  Send,
  Share2,
  ShieldAlert,
  User,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  computeSubscriber3MonthAvgKwh,
  dispatchReadingToCloudBackground,
  dispatchReceiptToCloudBackground,
  exportCollectorReadingsExcel,
  getSubscriberPreviousBaseline,
  parseSubscribersExcelFile,
  refreshStationState,
  sanitizeFirestoreId,
  saveStationLocalState,
  sendCollectorLocationInCloud,
  sendInstantManagerAlert,
  verifyMeterPhotoWithGemini,
  type StationLocalState,
} from '../lib/offlineDb';
import {
  extractMeterReadingFromImage,
  type MeterOcrResult,
} from '../lib/meterOcr';
import {
  loadLocalMeterPhotos,
  markLocalMeterPhotosSent,
  saveLocalMeterPhoto,
  updateLocalMeterPhotoReading,
  type LocalMeterPhotoEntry,
} from '../lib/localMeterPhotos';
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
  AccessCodeRecord,
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
  onSyncNow: (options?: { silent?: boolean }) => Promise<void>;
  isSyncing: boolean;
  syncProgress: import('../types/station').SyncProgress | null;
  activeCollector?: CollectorProfile;
  collectorAccess?: AccessCodeRecord;
  isManagerPreview?: boolean;
}

const LOWER_REASON_LABELS: Record<LowerReadingReason, string> = {
  meter_replaced: 'تم تغيير العداد بعداد جديد',
  meter_reset: 'تم تصفير العداد',
  previous_error: 'خطأ في القراءة السابقة',
};

const WILDCARD_ZONES = new Set([
  'جميع الحارات',
  'جميع المناطق',
  'كل الحارات',
  'كل المناطق',
  'الكل',
  'عام',
  'all',
  '*',
]);

function normalizeArabicZone(zone: string | undefined | null): string {
  return String(zone ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s+/g, ' ');
}

function subscriberMatchesAssignedZones(
  subZone: string | undefined | null,
  assignedZones: string[],
  importedLocally?: boolean,
): boolean {
  if (importedLocally || assignedZones.length === 0) return true;
  const effectiveAssigned = assignedZones
    .map((z) => normalizeArabicZone(z))
    .filter((z) => z.length > 0 && !WILDCARD_ZONES.has(z));
  if (effectiveAssigned.length === 0) return true;
  const normalizedSub = normalizeArabicZone(subZone);
  if (!normalizedSub) return false;
  return effectiveAssigned.some(
    (z) =>
      normalizedSub === z ||
      normalizedSub.includes(z) ||
      z.includes(normalizedSub),
  );
}

export const CollectorApp: React.FC<CollectorAppProps> = ({
  state,
  staffToken,
  onUpdateState,
  onSyncNow,
  isSyncing,
  syncProgress,
  activeCollector,
  collectorAccess,
  isManagerPreview = false,
}) => {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const newMeterCameraInputRef = useRef<HTMLInputElement>(null);
  const localExcelInputRef = useRef<HTMLInputElement>(null);

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedZone, setSelectedZone] = useState('all');
  const [selectedSubscriberId, setSelectedSubscriberId] = useState<string>(
    state.subscribers[0]?.id ?? '',
  );

  // OCR & Native Camera Capture State
  const [ocrResult, setOcrResult] = useState<MeterOcrResult | null>(null);
  const [extractingReading, setExtractingReading] = useState(false);
  const [finalReadingInput, setFinalReadingInput] = useState('');
  const [showEnhancedPreview, setShowEnhancedPreview] = useState(false);

  // Proof photo (IndexedDB local memory) & Billing
  const [proofPhotoUrl, setProofPhotoUrl] = useState<string>('');
  const [proofSizeKb, setProofSizeKb] = useState<number>(0);
  const [currentPhotoEntryId, setCurrentPhotoEntryId] = useState<string | null>(
    null,
  );
  const [localPhotos, setLocalPhotos] = useState<LocalMeterPhotoEntry[]>([]);
  const [photoStatus, setPhotoStatus] = useState<string | null>(null);
  const [cashPaidInput, setCashPaidInput] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<string | null>(
    null,
  );
  const [aiRedAlertNotice, setAiRedAlertNotice] = useState<string | null>(null);
  const [verifyingWithAi, setVerifyingWithAi] = useState(false);
  const [savedInvoiceText, setSavedInvoiceText] = useState<string | null>(null);
  const [copiedInvoice, setCopiedInvoice] = useState(false);
  const [localExcelNotice, setLocalExcelNotice] = useState<string | null>(null);
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [gpsPosition, setGpsPosition] = useState<{
    lat: number;
    lng: number;
    accuracy?: number;
  } | null>(null);
  const [gpsStatusText, setGpsStatusText] = useState<string | null>(null);

  const onUpdateStateRef = useRef(onUpdateState);
  onUpdateStateRef.current = onUpdateState;
  const stateRef = useRef(state);
  stateRef.current = state;
  const autoReconnectSyncTriggeredRef = useRef(false);

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
    const handleOnline = () => {
      setIsOnline(true);
      autoReconnectSyncTriggeredRef.current = false;
    };
    const handleOffline = () => {
      setIsOnline(false);
      autoReconnectSyncTriggeredRef.current = false;
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load saved local meter photos from IndexedDB on station mount
  useEffect(() => {
    let active = true;
    void loadLocalMeterPhotos(state.station.stationId).then((entries) => {
      if (active) setLocalPhotos(entries);
    });
    return () => {
      active = false;
    };
  }, [state.station.stationId]);

  // Auto-refresh subscribers, readings, and collector assignment silently on mount, focus, reconnect & every 15s
  useEffect(() => {
    if (!isOnline || isManagerPreview || !staffToken || !state.station.stationId) {
      return;
    }
    let cancelled = false;
    const pullLatest = async () => {
      try {
        const latest = await refreshStationState(
          state.station.stationId,
          staffToken,
        );
        if (!cancelled) {
          onUpdateStateRef.current(latest);
        }
      } catch {
        // Offline / transient network errors keep cached local state intact
      }
    };
    void pullLatest();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void pullLatest();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    const timer = window.setInterval(() => {
      void pullLatest();
    }, 15000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(timer);
    };
  }, [isOnline, isManagerPreview, staffToken, state.station.stationId]);


  const resolvedCollectorName =
    activeCollector?.name ||
    collectorAccess?.name ||
    (isManagerPreview ? 'مدير المحطة' : 'المحصّل الميداني');
  const resolvedCollectorCode =
    collectorAccess?.code || activeCollector?.code || activeCollector?.id || '';

  useEffect(() => {
    if (!gpsEnabled || isManagerPreview) {
      if (!gpsEnabled) setGpsStatusText(null);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatusText('المتصفح أو الجهاز لا يدعم تحديد الموقع GPS.');
      return;
    }
    setGpsStatusText('جاري تحديد موقعك الحالي عبر GPS...');
    let lastSentAt = 0;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const coords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy || 0),
        };
        setGpsPosition(coords);
        setGpsStatusText(
          `مشاركة الموقع نشطة (${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)} · دقة ±${coords.accuracy} م)`,
        );
        const nowMs = Date.now();
        if (isOnline && staffToken && nowMs - lastSentAt > 20000) {
          lastSentAt = nowMs;
          void sendCollectorLocationInCloud({
            staffToken,
            stationId: state.station.stationId,
            collectorCode: resolvedCollectorCode || undefined,
            collectorName: resolvedCollectorName,
            lat: coords.lat,
            lng: coords.lng,
            accuracy: coords.accuracy,
          }).catch(() => {});
        }
      },
      () => {
        setGpsStatusText('تعذر الوصول إلى GPS — تأكد من تفعيل الموقع ومنح الإذن للمتصفح.');
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [
    gpsEnabled,
    isManagerPreview,
    isOnline,
    staffToken,
    state.station.stationId,
    resolvedCollectorCode,
    resolvedCollectorName,
  ]);

  const permissions: CollectorPermissions = isManagerPreview
    ? {
        canRecordReadings: true,
        canCollectCash: true,
        canSendInvoices: true,
        canViewDebts: true,
      }
    : (activeCollector?.permissions ??
        collectorAccess?.permissions ?? {
          canRecordReadings: false,
          canCollectCash: false,
          canSendInvoices: false,
          canViewDebts: false,
        });

  const collectorActive = isManagerPreview
    ? true
    : Boolean(
        activeCollector ? activeCollector.active : collectorAccess?.active,
      );
  const assignedZones = isManagerPreview
    ? []
    : (activeCollector?.assignedZones ?? collectorAccess?.assignedZones ?? []);

  const zones = useMemo(() => {
    const s = new Set<string>();
    state.subscribers.forEach((sub) => {
      if (
        subscriberMatchesAssignedZones(
          sub.zoneStreet,
          assignedZones,
          sub.importedLocally,
        )
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
          !subscriberMatchesAssignedZones(
            sub.zoneStreet,
            assignedZones,
            sub.importedLocally,
          )
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

  // Auto-sync offline pending readings/receipts silently in batches as soon as internet connectivity returns
  useEffect(() => {
    if (!isOnline || pendingCount === 0 || isManagerPreview || !staffToken) {
      if (pendingCount === 0) {
        autoReconnectSyncTriggeredRef.current = false;
      }
      return;
    }

    if (!isSyncing && !autoReconnectSyncTriggeredRef.current) {
      autoReconnectSyncTriggeredRef.current = true;
      void onSyncNow({ silent: true }).catch(() => {
        autoReconnectSyncTriggeredRef.current = false;
      });
    }

    const retryTimer = window.setInterval(() => {
      if (!isSyncing) {
        void onSyncNow({ silent: true }).catch(() => {});
      }
    }, 20000);

    return () => window.clearInterval(retryTimer);
  }, [isOnline, pendingCount, isSyncing, isManagerPreview, staffToken, onSyncNow]);

  const currentLocalPhotoEntry = useMemo(() => {
    if (currentPhotoEntryId) {
      return localPhotos.find((p) => p.id === currentPhotoEntryId) ?? null;
    }
    return null;
  }, [currentPhotoEntryId, localPhotos]);

  const subscriberSavedPhotos = useMemo(() => {
    if (!selectedSubscriber) return [];
    return localPhotos.filter(
      (p) =>
        p.subscriberId === selectedSubscriber.id ||
        p.meterNumber === selectedSubscriber.meterNumber,
    );
  }, [localPhotos, selectedSubscriber]);

  const latestSubscriberLocalPhoto = subscriberSavedPhotos[0] ?? null;

  const latestSubscriberLocalPhotoReading = useMemo(() => {
    if (!selectedSubscriber) return null;
    return (
      state.readings
        .filter(
          (r) =>
            (r.subscriberId === selectedSubscriber.id ||
              r.meterNumber === selectedSubscriber.meterNumber) &&
            Boolean(r.photoUrl),
        )
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0] ?? null
    );
  }, [selectedSubscriber, state.readings]);

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
    setFinalReadingInput('');
    setShowEnhancedPreview(false);
    setCashPaidInput('');
    setProofPhotoUrl('');
    setProofSizeKb(0);
    setCurrentPhotoEntryId(null);
    setPhotoStatus(null);
    setValidationError(null);
    setSaveSuccessNotice(null);
    setAiRedAlertNotice(null);
    setVerifyingWithAi(false);
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

  const handleRecapture = () => {
    setOcrResult(null);
    setExtractingReading(false);
    setFinalReadingInput('');
    setShowEnhancedPreview(false);
    setProofPhotoUrl('');
    setProofSizeKb(0);
    setCurrentPhotoEntryId(null);
    setPhotoStatus(null);
    setValidationError(null);
    setSaveSuccessNotice(null);
    cameraInputRef.current?.click();
  };

  const avg3MonthsKwh = selectedSubscriber
    ? computeSubscriber3MonthAvgKwh(selectedSubscriber, state.readings)
    : 0;

  const runAutoMeterExtraction = async (
    dataUrl: string,
    _sizeKb: number,
    prevVal: number,
  ) => {
    setExtractingReading(true);
    setOcrResult(null);
    setFinalReadingInput('');
    setValidationError(null);
    setSaveSuccessNotice(null);
    setPhotoStatus('جاري قص شاشة العداد وتحسين التباين وقراءة الأرقام...');

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
      setFinalReadingInput('');
      setPhotoStatus(null);
      setValidationError('تعذرت القراءة الدقيقة، اكتب القراءة يدوياً');
      return;
    }

    setFinalReadingInput(String(result.reading));
    setPhotoStatus(
      `تمت قراءة الأرقام المقترحة: ${result.reading} (نسبة الثقة ${result.confidence}%) — يمكنك التعديل أو الضغط على اعتماد القراءة`,
    );
  };

  const handlePhotoUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file || !selectedSubscriber) return;
    setPhotoStatus('جاري حفظ الصورة محلياً وقص منطقة العداد...');
    setShowEnhancedPreview(false);
    try {
      const compressed = await compressImageUnder150Kb(file);
      setProofPhotoUrl(compressed.dataUrl);
      setProofSizeKb(compressed.sizeKb);

      const photoId = `ph_${Date.now()}_${selectedSubscriber.meterNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const updatedPhotos = await saveLocalMeterPhoto({
        id: photoId,
        stationId: state.station.stationId,
        subscriberId: selectedSubscriber.id,
        subscriberName: selectedSubscriber.subscriberName,
        meterNumber: selectedSubscriber.meterNumber,
        collectorName: resolvedCollectorName,
        capturedAt: new Date().toISOString(),
        dataUrl: compressed.dataUrl,
        sizeKb: compressed.sizeKb,
        sentToManager: false,
      });
      setLocalPhotos(updatedPhotos);
      setCurrentPhotoEntryId(photoId);

      const currentBaseline = getSubscriberPreviousBaseline(
        selectedSubscriber,
        state.readings,
      );
      await runAutoMeterExtraction(
        compressed.dataUrl,
        compressed.sizeKb,
        currentBaseline,
      );
    } catch {
      setPhotoStatus('تعذرت القراءة الدقيقة، اكتب القراءة يدوياً');
    } finally {
      event.target.value = '';
    }
  };

  const shareMeterPhotoToManager = async (
    photoDataUrl: string,
    readingValue?: number,
    photoEntryId?: string | null,
    meterNumOverride?: string,
    subNameOverride?: string,
  ) => {
    const targetMeter = meterNumOverride || selectedSubscriber?.meterNumber || 'photo';
    const targetName = subNameOverride || selectedSubscriber?.subscriberName || 'مشترك';
    if (!photoDataUrl) return;
    const safeMeter = targetMeter.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `meter_${safeMeter || 'photo'}.jpg`;
    const caption = [
      `صورة عداد المشترك: ${targetName}`,
      `رقم العداد: ${targetMeter}`,
      readingValue !== undefined ? `القراءة: ${readingValue}` : null,
      `المحصّل: ${resolvedCollectorName}`,
    ]
      .filter(Boolean)
      .join(' — ');

    try {
      const response = await fetch(photoDataUrl);
      const blob = await response.blob();
      const file = new File([blob], filename, {
        type: blob.type || 'image/jpeg',
      });

      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.share === 'function' &&
        (!navigator.canShare || navigator.canShare({ files: [file] }))
      ) {
        try {
          await navigator.share({
            files: [file],
            title: 'صورة عداد الكهرباء',
            text: caption,
          });
          if (photoEntryId) {
            const updated = await markLocalMeterPhotosSent(
              state.station.stationId,
              [photoEntryId],
            );
            setLocalPhotos(updated);
          }
          setPhotoStatus('تم إرسال هذه الصورة لمدير المحطة.');
          return;
        } catch (shareErr) {
          if (
            shareErr instanceof Error &&
            shareErr.name === 'AbortError'
          ) {
            return;
          }
        }
      }
    } catch {
      // Fallback cleanly to local file download + clipboard caption
    }

    const link = document.createElement('a');
    link.href = photoDataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(caption);
      } catch {
        // Clipboard access optional
      }
    }

    if (photoEntryId) {
      const updated = await markLocalMeterPhotosSent(state.station.stationId, [
        photoEntryId,
      ]);
      setLocalPhotos(updated);
    }

    setPhotoStatus(
      'تم تجهيز الصورة ونسخ بيانات المشترك لإرسالها للمدير عبر واتساب أو تيليجرام.',
    );
  };

  const shareAllSavedPhotosToManager = async () => {
    const unsent = localPhotos.filter((p) => !p.sentToManager);
    const targets = unsent.length > 0 ? unsent : localPhotos;
    if (targets.length === 0) {
      setPhotoStatus('لا توجد صور محفوظة في الهاتف حالياً.');
      return;
    }

    const files: File[] = [];
    for (const item of targets) {
      try {
        const res = await fetch(item.dataUrl);
        const blob = await res.blob();
        const safeMeter = item.meterNumber.replace(/[^a-zA-Z0-9_-]/g, '_');
        files.push(
          new File([blob], `meter_${safeMeter}_${item.id.slice(-4)}.jpg`, {
            type: blob.type || 'image/jpeg',
          }),
        );
      } catch {
        // Skip unreadable entry
      }
    }

    const summaryLines = targets
      .map(
        (t) =>
          `• ${t.subscriberName} (عداد ${t.meterNumber})${t.readingValue !== undefined ? `: ${t.readingValue}` : ''}`,
      )
      .join('\n');
    const summaryText = `صور العدادات المحفوظة (${targets.length} صورة) — المحصّل: ${resolvedCollectorName}\n${summaryLines}`;

    if (
      files.length > 0 &&
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      (!navigator.canShare || navigator.canShare({ files }))
    ) {
      try {
        await navigator.share({
          files,
          title: `صور العدادات (${files.length})`,
          text: summaryText,
        });
        const updated = await markLocalMeterPhotosSent(
          state.station.stationId,
          targets.map((t) => t.id),
        );
        setLocalPhotos(updated);
        setPhotoStatus(`تم إرسال ${targets.length} صورة محفوظة للمدير دفعة واحدة.`);
        return;
      } catch (shareErr) {
        if (shareErr instanceof Error && shareErr.name === 'AbortError') {
          return;
        }
      }
    }

    // Fallback: download each saved photo & copy batch summary
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      const safeMeter = item.meterNumber.replace(/[^a-zA-Z0-9_-]/g, '_');
      const link = document.createElement('a');
      link.href = item.dataUrl;
      link.download = `meter_${safeMeter}_${i + 1}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(summaryText);
      } catch {
        // Clipboard optional
      }
    }

    const updated = await markLocalMeterPhotosSent(
      state.station.stationId,
      targets.map((t) => t.id),
    );
    setLocalPhotos(updated);
    setPhotoStatus(
      `تم تجهيز ${targets.length} صورة محفوظة ونسخ الكشف لإرسالها للمدير دفعة واحدة.`,
    );
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

  const prevReading = selectedSubscriber
    ? getSubscriberPreviousBaseline(selectedSubscriber, state.readings)
    : 0;
  const ocrOriginalReading = ocrResult?.accepted ? ocrResult.reading : null;
  const parsedFinalInput = Number(finalReadingInput);

  const activeFinalReading: number | null =
    finalReadingInput.trim() !== '' &&
    Number.isFinite(parsedFinalInput) &&
    parsedFinalInput >= 0
      ? Math.round(parsedFinalInput * 100) / 100
      : null;

  const isManuallyEdited =
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

  const persistCashReceiptOnly = async () => {
    if (
      isManagerPreview ||
      !selectedSubscriber ||
      !permissions.canCollectCash ||
      cashPaidYer <= 0
    ) {
      return;
    }
    const now = new Date().toISOString();
    const collectorName = resolvedCollectorName;
    const collectorUid =
      (collectorAccess?.code || activeCollector?.code || resolvedCollectorCode || '')
        .trim()
        .toUpperCase() ||
      activeCollector?.id ||
      state.station.ownerUid;
    const nextBalance = Math.max(0, previousDebtYer - cashPaidYer);

    const newReceipt: PaymentReceipt = {
      id: sanitizeFirestoreId(`rc_${Date.now()}`),
      subscriberId: selectedSubscriber.id,
      meterNumber: selectedSubscriber.meterNumber,
      subscriberName: selectedSubscriber.subscriberName,
      readingId: `cash_${Date.now()}`,
      amountPaidYer: cashPaidYer,
      remainingBalanceYer: nextBalance,
      collectorUid,
      collectorName,
      paidAt: now,
      syncStatus: 'pending',
    };

    if (gpsEnabled && gpsPosition && isOnline && staffToken && !isManagerPreview) {
      void sendCollectorLocationInCloud({
        staffToken,
        stationId: state.station.stationId,
        collectorCode: resolvedCollectorCode || undefined,
        collectorName,
        lat: gpsPosition.lat,
        lng: gpsPosition.lng,
        accuracy: gpsPosition.accuracy,
        lastSubscriberName: selectedSubscriber.subscriberName,
        lastMeterNumber: selectedSubscriber.meterNumber,
        zoneStreet: selectedSubscriber.zoneStreet,
      }).catch(() => {});
    }

    const updatedSubscribers = state.subscribers.map((s) =>
      s.id === selectedSubscriber.id
        ? {
            ...s,
            previousDebtYer: nextBalance,
            syncStatus: 'pending' as const,
            updatedAt: now,
          }
        : s,
    );

    const updatedSubRecord = updatedSubscribers.find(
      (s) => s.id === selectedSubscriber.id,
    );

    const nextLocalState: StationLocalState = {
      ...state,
      subscribers: updatedSubscribers,
      receipts: [newReceipt, ...state.receipts],
    };

    onUpdateState(nextLocalState);
    await saveStationLocalState(nextLocalState);

    setCashPaidInput('');
    setValidationError(null);
    setSaveSuccessNotice(
      `تم تسجيل سند قبض بمبلغ ${formatYer(cashPaidYer)} وخصمه من المستحق. المتبقي على المشترك: ${formatYer(nextBalance)}.`,
    );

    if (permissions.canSendInvoices) {
      setSavedInvoiceText(
        `سند قبض فوري — المشترك ${selectedSubscriber.subscriberName} (عداد ${selectedSubscriber.meterNumber}): ` +
          `المستحق السابق ${Math.round(previousDebtYer)} ريال، ` +
          `المدفوع نقداً ${Math.round(cashPaidYer)} ريال، ` +
          `المتبقي المستحق: ${Math.round(nextBalance)} ريال. ` +
          `محطة ${state.station.stationName}`,
      );
    }

    const didSync = await dispatchReceiptToCloudBackground({
      stationId: state.station.stationId,
      staffToken,
      receipt: newReceipt,
      subscriber: updatedSubRecord,
    }).catch(() => false);

    if (didSync) {
      const latest = stateRef.current;
      const syncedState: StationLocalState = {
        ...latest,
        subscribers: latest.subscribers.map((s) =>
          s.id === selectedSubscriber.id
            ? { ...s, syncStatus: 'synced' as const }
            : s,
        ),
        receipts: latest.receipts.map((rc) =>
          rc.id === newReceipt.id ? { ...rc, syncStatus: 'synced' as const } : rc,
        ),
      };
      onUpdateStateRef.current(syncedState);
      await saveStationLocalState(syncedState);
    }
  };

  const persistAndDispatchReading = async (options?: {
    lowerReason?: LowerReadingReason;
    newMeterNumber?: string;
    openingReading?: number;
    overridePhotoUrl?: string;
    overridePhotoKb?: number;
  }) => {
    if (isManagerPreview || !selectedSubscriber || activeFinalReading === null) {
      return;
    }

    const now = new Date().toISOString();
    const readingId = sanitizeFirestoreId(`rd_${Date.now()}`);
    const collectorName = resolvedCollectorName;
    const collectorUid =
      (collectorAccess?.code || activeCollector?.code || resolvedCollectorCode || '')
        .trim()
        .toUpperCase() ||
      activeCollector?.id ||
      state.station.ownerUid;

    const isManualWithoutOcr =
      ocrOriginalReading === null && activeFinalReading !== null;
    const effectivePhoto = options?.overridePhotoUrl || proofPhotoUrl;
    const effectiveKb = options?.overridePhotoKb || proofSizeKb;

    // 1. Run Gemini Vision-AI photo-vs-reading verification when Admin-enabled
    let aiVerificationStatus: MeterReading['aiVerificationStatus'] =
      state.station.aiPhotoVerificationEnabled ? 'pending_offline' : 'skipped';
    let aiDetectedReading: number | undefined;
    let aiConfidence: number | undefined;
    let aiVerificationReason: string | undefined;
    let aiMismatchTriggered = false;
    let aiServerAlert: ManagerAlert | null = null;

    setAiRedAlertNotice(null);
    if (
      state.station.aiPhotoVerificationEnabled &&
      effectivePhoto &&
      isOnline &&
      staffToken &&
      !isManagerPreview
    ) {
      setVerifyingWithAi(true);
      try {
        const aiRes = await verifyMeterPhotoWithGemini({
          staffToken,
          stationId: state.station.stationId,
          imageBase64: effectivePhoto,
          claimedReading: activeFinalReading,
          previousReading: prevReading,
          subscriberId: selectedSubscriber.id,
          subscriberName: selectedSubscriber.subscriberName,
          meterNumber: selectedSubscriber.meterNumber,
          readingId,
          collectorName,
        });
        aiConfidence = aiRes.confidence;
        if (aiRes.detectedReading !== null) {
          aiDetectedReading = aiRes.detectedReading;
        }
        if (aiRes.matched) {
          aiVerificationStatus = 'matched';
        } else {
          aiVerificationStatus = 'mismatch';
          aiVerificationReason = aiRes.discrepancyReason;
          aiMismatchTriggered = true;
          if (aiRes.alert) {
            aiServerAlert = { ...aiRes.alert, syncStatus: 'synced' };
          }
          setAiRedAlertNotice(
            `تنبيه أحمر فوري: ${aiRes.discrepancyReason || `صورة العداد (${aiRes.detectedReading ?? 'غير مقروءة'}) لا تطابق القراءة المدخلة (${activeFinalReading})`}`,
          );
        }
      } catch {
        aiVerificationStatus = 'pending_offline';
      } finally {
        setVerifyingWithAi(false);
      }
    }

    // Manual edit by collector NO LONGER sends a manual_edit alert or blocks approval;
    // only lower-than-previous readings or Gemini Vision-AI photo mismatch require manager review.
    const requiresManagerApproval =
      Boolean(options?.lowerReason) || aiMismatchTriggered;

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
      // Kept strictly on collector's phone local memory (stripped before Firestore/cloud upload)
      photoUrl: effectivePhoto,
      photoSizeKb: effectiveKb,
      hasLocalPhoto: Boolean(effectivePhoto),
      readingSource:
        isManuallyEdited || isManualWithoutOcr ? 'manual_override' : 'camera_ocr',
      ocrConfidence: ocrResult?.confidence ?? 0,
      ...(ocrOriginalReading !== null ? { ocrOriginalReading } : {}),
      wasManuallyEdited: isManuallyEdited || isManualWithoutOcr,
      ...(isManuallyEdited || isManualWithoutOcr ? { editedAt: now } : {}),
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
      aiVerificationStatus,
      ...(typeof aiDetectedReading === 'number' ? { aiDetectedReading } : {}),
      ...(typeof aiConfidence === 'number' ? { aiConfidence } : {}),
      ...(aiVerificationReason ? { aiVerificationReason } : {}),
      ...(gpsPosition
        ? {
            gpsLat: gpsPosition.lat,
            gpsLng: gpsPosition.lng,
            ...(typeof gpsPosition.accuracy === 'number'
              ? { gpsAccuracy: Math.round(gpsPosition.accuracy) }
              : {}),
          }
        : {}),
      collectorUid,
      collectorName,
      recordedAt: now,
      syncStatus: 'pending',
    };

    if (gpsEnabled && gpsPosition && isOnline && staffToken && !isManagerPreview) {
      void sendCollectorLocationInCloud({
        staffToken,
        stationId: state.station.stationId,
        collectorCode: resolvedCollectorCode || undefined,
        collectorName,
        lat: gpsPosition.lat,
        lng: gpsPosition.lng,
        accuracy: gpsPosition.accuracy,
        lastSubscriberName: selectedSubscriber.subscriberName,
        lastMeterNumber: selectedSubscriber.meterNumber,
        zoneStreet: selectedSubscriber.zoneStreet,
      }).catch(() => {});
    }

    const alertsToQueue: ManagerAlert[] = [];

    // 1) Immediate alert ONLY when reading is lower than previous (manual_edit alert removed)
    if (options?.lowerReason) {
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
        collectorCode: resolvedCollectorCode || undefined,
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
        photoUrl: '',
        createdAt: now,
        syncStatus: 'pending',
      });
    }

    // 2) Yellow alert if consumption > 3x last-3-months average
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
        collectorCode: resolvedCollectorCode || undefined,
        editedReading: activeFinalReading,
        previousReading: prevReading,
        consumptionKwh,
        avg3MonthsKwh,
        photoUrl: '',
        createdAt: now,
        syncStatus: 'pending',
      });
    }

    // Instant dispatch when online so manager gets notified right away (text-only)
    let syncedAlerts: ManagerAlert[] = aiServerAlert ? [aiServerAlert] : [];
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
      syncedAlerts = [...syncedAlerts, ...updatedAlerts];
    } else if (alertsToQueue.length > 0) {
      syncedAlerts = [...syncedAlerts, ...alertsToQueue];
    }

    const nextReceipts = [...state.receipts];
    const debtAfterCashOnly = Math.max(0, previousDebtYer - cashPaidYer);
    const effectiveRemainingAfterSave = requiresManagerApproval
      ? debtAfterCashOnly
      : remainingBalanceYer;

    let createdReceipt: PaymentReceipt | undefined;
    if (cashPaidYer > 0 && permissions.canCollectCash) {
      createdReceipt = {
        id: sanitizeFirestoreId(`rc_${Date.now()}`),
        subscriberId: selectedSubscriber.id,
        meterNumber: selectedSubscriber.meterNumber,
        subscriberName: selectedSubscriber.subscriberName,
        readingId,
        amountPaidYer: cashPaidYer,
        remainingBalanceYer: effectiveRemainingAfterSave,
        collectorUid,
        collectorName,
        paidAt: now,
        syncStatus: 'pending',
      };
      nextReceipts.unshift(createdReceipt);
    }

    const updatedSubscribers = state.subscribers.map((s) => {
      if (s.id !== selectedSubscriber.id) return s;
      if (requiresManagerApproval) {
        if (cashPaidYer > 0 && permissions.canCollectCash) {
          return {
            ...s,
            previousDebtYer: debtAfterCashOnly,
            syncStatus: 'pending' as const,
            updatedAt: now,
          };
        }
        return s;
      }
      return {
        ...s,
        previousReading: prevReading,
        currentReading: activeFinalReading,
        previousDebtYer: remainingBalanceYer,
        syncStatus: 'pending' as const,
        updatedAt: now,
      };
    });

    const updatedSubRecord = updatedSubscribers.find(
      (s) => s.id === selectedSubscriber.id,
    );

    const nextLocalState: StationLocalState = {
      ...state,
      subscribers: updatedSubscribers,
      readings: [newReading, ...state.readings],
      receipts: nextReceipts,
      alerts: [...syncedAlerts, ...(state.alerts ?? [])],
    };

    onUpdateState(nextLocalState);

    // Keep meter photo permanently in IndexedDB and attach the approved reading value
    if (currentPhotoEntryId) {
      void updateLocalMeterPhotoReading(
        state.station.stationId,
        currentPhotoEntryId,
        activeFinalReading,
      ).then(setLocalPhotos);
    }

    // Immediate non-blocking background dispatch (number + meterNumber + recordedAt ONLY, zero photo)
    void dispatchReadingToCloudBackground({
      stationId: state.station.stationId,
      staffToken,
      reading: newReading,
      subscriber: updatedSubRecord,
      receipt: createdReceipt,
      alerts: syncedAlerts,
    }).then((didSync) => {
      if (!didSync) return;
      const latest = stateRef.current;
      onUpdateStateRef.current({
        ...latest,
        readings: latest.readings.map((r) =>
          r.id === readingId ? { ...r, syncStatus: 'synced' as const } : r,
        ),
        subscribers: latest.subscribers.map((s) =>
          s.id === selectedSubscriber.id
            ? { ...s, syncStatus: 'synced' as const }
            : s,
        ),
        receipts: createdReceipt
          ? latest.receipts.map((rc) =>
              rc.id === createdReceipt.id
                ? { ...rc, syncStatus: 'synced' as const }
                : rc,
            )
          : latest.receipts,
      });
    });

    setFinalReadingInput('');
    setOcrResult(null);
    setProofPhotoUrl('');
    setProofSizeKb(0);
    setCurrentPhotoEntryId(null);
    setPhotoStatus(null);
    setShowEnhancedPreview(false);
    setValidationError(null);
    setCashPaidInput('');

    if (aiMismatchTriggered) {
      const cashNote =
        cashPaidYer > 0
          ? ` وتم تسجيل وخصم سند القبض (${formatYer(cashPaidYer)}).`
          : '';
      setSaveSuccessNotice(
        'تم اعتماد القراءة محلياً وإرسال تنبيه أحمر فوري لمدير المحطة لعدم تطابق الصورة مع الرقم.' +
          cashNote,
      );
      setSavedInvoiceText(null);
      return;
    }

    if (requiresManagerApproval) {
      const cashNote =
        cashPaidYer > 0
          ? ` وتم تسجيل وخصم سند القبض (${formatYer(cashPaidYer)}).`
          : '';
      setSaveSuccessNotice(
        (isOnline
          ? 'تم إرسال قراءة العداد الأقل من السابقة لمراجعة مدير المحطة.'
          : 'تم حفظ القراءة المعلقة محلياً.') + cashNote,
      );
      setSavedInvoiceText(null);
      return;
    }

    setSaveSuccessNotice(
      isOnline
        ? isClosedHouseZero
          ? 'تم اعتماد القراءة (بيت مغلق) وإرسال الأرقام في الخلفية — الصورة محفوظة بهاتفك.'
          : isHighConsumptionWarning
            ? 'تم اعتماد القراءة وإرسال الأرقام وتنبيه ارتفاع الاستهلاك للمدير.'
            : cashPaidYer > 0
              ? `تم اعتماد القراءة وسند القبض (${formatYer(cashPaidYer)}) وإرسال الأرقام في الخلفية. المتبقي: ${formatYer(remainingBalanceYer)}.`
              : 'تم اعتماد القراءة وإرسالها إلى السحابة في الخلفية — الصورة محفوظة في هاتفك.'
        : 'تم حفظ القراءة والصورة محلياً في الهاتف — ستُرسل القراءة تلقائياً فور عودة الإنترنت.',
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
        ...(cashPaidYer > 0
          ? { paidYer: cashPaidYer, remainingBalanceYer }
          : {}),
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
    if (!selectedSubscriber) return;

    // Allow cash-only receipt submission without taking a meter reading
    if (
      permissions.canCollectCash &&
      cashPaidYer > 0 &&
      !proofPhotoUrl &&
      activeFinalReading === null
    ) {
      await persistCashReceiptOnly();
      return;
    }

    if (!permissions.canRecordReadings) return;

    if (!proofPhotoUrl) {
      setValidationError('يرجى التقاط صورة العداد أولاً.');
      return;
    }
    if (extractingReading) {
      setValidationError('يرجى الانتظار حتى تكتمل قراءة العداد.');
      return;
    }
    if (activeFinalReading === null) {
      setValidationError('تعذرت القراءة الدقيقة، اكتب القراءة يدوياً');
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
      {/* Real Connectivity, Collector Identity & One-Tap Sync Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-teal-50 border border-teal-200 text-teal-900 text-sm font-extrabold">
                <User className="w-4 h-4 text-teal-700 shrink-0" />
                <span>المحصّل: {resolvedCollectorName}</span>
              </span>
              {resolvedCollectorCode && (
                <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200 text-slate-700 text-xs font-bold font-mono-nums">
                  كود: {resolvedCollectorCode}
                </span>
              )}
              <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold">
                المشتركين: {routeSubscribers.length}
              </span>
            </div>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900">
              تطبيق المحصّل الميداني · {state.station.stationName}
            </h1>
            <p className="text-xs text-slate-600 flex flex-wrap items-center gap-2">
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
            {!isManagerPreview && (
              <button
                type="button"
                onClick={() => setGpsEnabled((prev) => !prev)}
                className={`min-h-[44px] px-3.5 py-2 text-xs font-bold rounded-lg border transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer ${
                  gpsEnabled
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-900 hover:bg-emerald-100'
                    : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
                }`}
              >
                <MapPin
                  className={`w-4 h-4 ${gpsEnabled ? 'text-emerald-700' : 'text-slate-600'}`}
                />
                {gpsEnabled ? 'إيقاف مشاركة GPS' : 'تفعيل تتبع GPS'}
              </button>
            )}

            <button
              type="button"
              onClick={() =>
                exportCollectorReadingsExcel(state, resolvedCollectorName)
              }
              className="min-h-[44px] px-3.5 py-2 text-xs font-medium rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-4 h-4 text-teal-700" />
              حفظ القراءات للكمبيوتر (USB)
            </button>

            <button
              type="button"
              disabled={!isOnline || isSyncing || pendingCount === 0}
              onClick={() => void onSyncNow({ silent: true })}
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

        {state.station.aiPhotoVerificationEnabled && (
          <div className="text-xs font-bold text-slate-900 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
              مطابقة صورة العداد مع رقم القراءة مفعّلة ومشفّرة — أي اختلاف يطلق تنبيهاً أحمر فورياً للمدير.
            </span>
            <span className="text-[11px] font-medium text-emerald-800">
              الصور محفوظة بهاتفك محلياً فقط (النصوص في السحابة)
            </span>
          </div>
        )}
        {gpsStatusText && (
          <div className="text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
            <span>{gpsStatusText}</span>
          </div>
        )}
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
                className="w-full min-h-[48px] pr-9 pl-3 py-2 text-base sm:text-lg font-bold placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <select
              value={selectedZone}
              onChange={(e) => setSelectedZone(e.target.value)}
              className="w-full min-h-[48px] px-3 py-2 text-base font-bold border border-slate-300 rounded-lg bg-white"
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
              const subBaseline = getSubscriberPreviousBaseline(
                sub,
                state.readings,
              );
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => selectSubscriber(sub)}
                  className={`w-full text-right p-4 flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                    active ? 'bg-teal-50/80' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex-1 flex items-center gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold font-mono-nums shrink-0 ${
                        active
                          ? 'bg-teal-700 text-white'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {sub.sequenceOrder}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-slate-900 truncate">
                        {sub.subscriberName}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 truncate">
                        عداد{' '}
                        <span className="font-mono-nums">{sub.meterNumber}</span>{' '}
                        · {sub.zoneStreet} · السابقة{' '}
                        <span className="font-mono-nums">
                          {subBaseline}
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
              <div className="p-8 text-center space-y-3">
                <p className="text-sm font-bold text-slate-700">
                  لا يوجد مشتركين في نطاق حاراتك المخصصة حالياً.
                </p>
                <p className="text-xs text-slate-500">
                  {assignedZones.length > 0
                    ? `النطاق المخصص: ${assignedZones.join('، ')}`
                    : 'يتم جلب وتحديث كشف المشتركين تلقائياً فور توفر الاتصال.'}
                </p>
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
                      {prevReading}
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

              {!permissions.canRecordReadings && !permissions.canCollectCash ? (
                <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                  صلاحيات تسجيل القراءات والتحصيل غير مفعّلة لك حالياً من قِبل مدير المحطة.
                </div>
              ) : (
                <>
                  {permissions.canRecordReadings && (
                    <div className="space-y-3">
                      <div className="relative h-56 rounded-xl bg-slate-900 overflow-hidden flex items-center justify-center border border-slate-800">
                        {showEnhancedPreview &&
                        (ocrResult?.enhancedPreviewUrl ||
                          ocrResult?.zoomedBwPreviewUrl) ? (
                          <img
                            src={
                              ocrResult.enhancedPreviewUrl ||
                              ocrResult.zoomedBwPreviewUrl
                            }
                            alt="منطقة شاشة العداد المقصوصة والمحسّنة"
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-contain bg-white"
                          />
                        ) : proofPhotoUrl ? (
                          <img
                            src={proofPhotoUrl}
                            alt={`صورة العداد ${selectedSubscriber.meterNumber}`}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="text-center px-4 space-y-2">
                            <ScanLine className="w-8 h-8 text-teal-400 mx-auto" />
                            <p className="text-xs text-slate-200 font-medium">
                              التقط صورة العداد كاملة كما هي لقراءة الأرقام تلقائياً
                            </p>
                          </div>
                        )}

                        {proofPhotoUrl && (
                          <div
                            className={`absolute top-2.5 right-2.5 px-2.5 py-1 rounded-md text-[11px] font-bold shadow-sm ${
                              currentLocalPhotoEntry?.sentToManager
                                ? 'bg-emerald-600 text-white'
                                : 'bg-amber-400 text-slate-950'
                            }`}
                          >
                            {currentLocalPhotoEntry?.sentToManager
                              ? 'تم إرسالها للمدير'
                              : 'محفوظة في الهاتف'}
                          </div>
                        )}

                        {proofPhotoUrl &&
                          (ocrResult?.enhancedPreviewUrl ||
                            ocrResult?.zoomedBwPreviewUrl) && (
                            <button
                              type="button"
                              onClick={() => setShowEnhancedPreview((v) => !v)}
                              className="absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded-md bg-slate-950/80 hover:bg-slate-900 text-white text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5 text-teal-300" />
                              {showEnhancedPreview
                                ? 'الصورة الأصلية'
                                : 'المنطقة المقصوصة'}
                            </button>
                          )}
                      </div>

                      <input
                        ref={cameraInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handlePhotoUpload}
                        className="hidden"
                      />

                      {!proofPhotoUrl ? (
                        <button
                          type="button"
                          onClick={() => cameraInputRef.current?.click()}
                          className="w-full min-h-[46px] px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg inline-flex items-center justify-center gap-2 cursor-pointer"
                        >
                          <Camera className="w-4 h-4" />
                          التقط صورة العداد
                        </button>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <button
                            type="button"
                            onClick={() =>
                              void shareMeterPhotoToManager(
                                proofPhotoUrl,
                                activeFinalReading ?? undefined,
                                currentPhotoEntryId,
                              )
                            }
                            className="min-h-[44px] px-3.5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <Share2 className="w-4 h-4 shrink-0" />
                            إرسال هذه الصورة للمدير
                          </button>
                          <button
                            type="button"
                            onClick={() => void shareAllSavedPhotosToManager()}
                            className="min-h-[44px] px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <Send className="w-4 h-4 shrink-0" />
                            إرسال كل الصور المحفوظة دفعة واحدة
                          </button>
                        </div>
                      )}

                      {photoStatus && (
                        <p className="text-xs text-teal-900 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 font-medium">
                          {photoStatus}
                        </p>
                      )}

                      {!proofPhotoUrl && latestSubscriberLocalPhoto && (
                        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2.5">
                          <div className="flex items-center gap-3">
                            <img
                              src={latestSubscriberLocalPhoto.dataUrl}
                              alt={`آخر صورة محفوظة للعداد ${selectedSubscriber.meterNumber}`}
                              className="w-14 h-14 rounded-lg object-cover border border-slate-300 shrink-0"
                            />
                            <div className="space-y-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                                    latestSubscriberLocalPhoto.sentToManager
                                      ? 'bg-emerald-100 text-emerald-900'
                                      : 'bg-amber-100 text-amber-900'
                                  }`}
                                >
                                  {latestSubscriberLocalPhoto.sentToManager
                                    ? 'تم إرسالها للمدير'
                                    : 'محفوظة في الهاتف'}
                                </span>
                                {latestSubscriberLocalPhoto.readingValue !==
                                  undefined && (
                                  <span className="text-xs font-mono-nums font-bold text-slate-800">
                                    القراءة:{' '}
                                    {latestSubscriberLocalPhoto.readingValue}
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {new Date(
                                  latestSubscriberLocalPhoto.capturedAt,
                                ).toLocaleString('ar-YE')}{' '}
                                · {latestSubscriberLocalPhoto.collectorName}
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                void shareMeterPhotoToManager(
                                  latestSubscriberLocalPhoto.dataUrl,
                                  latestSubscriberLocalPhoto.readingValue,
                                  latestSubscriberLocalPhoto.id,
                                  latestSubscriberLocalPhoto.meterNumber,
                                  latestSubscriberLocalPhoto.subscriberName,
                                )
                              }
                              className="min-h-[40px] px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              <Share2 className="w-3.5 h-3.5 shrink-0" />
                              إرسال هذه الصورة للمدير
                            </button>
                            <button
                              type="button"
                              onClick={() => void shareAllSavedPhotosToManager()}
                              className="min-h-[40px] px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              <Send className="w-3.5 h-3.5 shrink-0" />
                              إرسال كل الصور المحفوظة دفعة واحدة
                            </button>
                          </div>
                        </div>
                      )}

                      {!proofPhotoUrl &&
                        !latestSubscriberLocalPhoto &&
                        latestSubscriberLocalPhotoReading?.photoUrl && (
                          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2.5">
                            <div className="flex items-center gap-3">
                              <img
                                src={latestSubscriberLocalPhotoReading.photoUrl}
                                alt={`آخر صورة محفوظة للعداد ${selectedSubscriber.meterNumber}`}
                                className="w-14 h-14 rounded-lg object-cover border border-slate-300 shrink-0"
                              />
                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[11px] font-bold bg-amber-100 text-amber-900 px-2 py-0.5 rounded">
                                    محفوظة في الهاتف
                                  </span>
                                  <span className="text-xs font-mono-nums font-bold text-slate-800">
                                    القراءة:{' '}
                                    {
                                      latestSubscriberLocalPhotoReading.currentReading
                                    }
                                  </span>
                                </div>
                                <div className="text-[11px] text-slate-500">
                                  {new Date(
                                    latestSubscriberLocalPhotoReading.recordedAt,
                                  ).toLocaleString('ar-YE')}
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void shareMeterPhotoToManager(
                                    latestSubscriberLocalPhotoReading.photoUrl,
                                    latestSubscriberLocalPhotoReading.currentReading,
                                  )
                                }
                                className="min-h-[40px] px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
                              >
                                <Share2 className="w-3.5 h-3.5 shrink-0" />
                                إرسال هذه الصورة للمدير
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void shareAllSavedPhotosToManager()
                                }
                                className="min-h-[40px] px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
                              >
                                <Send className="w-3.5 h-3.5 shrink-0" />
                                إرسال كل الصور المحفوظة دفعة واحدة
                              </button>
                            </div>
                          </div>
                        )}

                      {ocrResult && !ocrResult.accepted && (
                        <div className="bg-rose-50 border border-rose-200 rounded-lg px-3.5 py-2.5 text-xs text-rose-800 font-bold">
                          تعذرت القراءة الدقيقة، اكتب القراءة يدوياً
                        </div>
                      )}
                    </div>
                  )}

                  {/* Editable Final Reading + Cash Receipt Form */}
                  <form onSubmit={handleSaveFormSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {permissions.canRecordReadings && (
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            القراءة النهائية المعتمدة
                          </label>
                          <input
                            type="number"
                            inputMode="numeric"
                            step="any"
                            min={0}
                            value={finalReadingInput}
                            onChange={(e) =>
                              setFinalReadingInput(e.target.value)
                            }
                            disabled={extractingReading}
                            placeholder={
                              extractingReading
                                ? 'جاري قراءة العداد...'
                                : 'اكتب أو عدّل القراءة يدوياً'
                            }
                            className="w-full min-h-[48px] px-3.5 py-2.5 text-lg sm:text-xl font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:bg-slate-100"
                          />
                          {isManuallyEdited && activeFinalReading !== null && (
                            <p className="text-[11px] text-slate-600 font-medium mt-1">
                              المقروء آلياً ({ocrOriginalReading}) ← المعتمد حالياً ({activeFinalReading})
                            </p>
                          )}
                        </div>
                      )}

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
                            className="w-full min-h-[48px] px-3.5 py-2.5 text-lg sm:text-xl font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                          />
                          {cashPaidYer > 0 && !proofPhotoUrl && (
                            <button
                              type="button"
                              onClick={() => void persistCashReceiptOnly()}
                              className="mt-2 w-full min-h-[38px] px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer"
                            >
                              {`حفظ سند القبض الآن وخصمه (${formatCompactYer(cashPaidYer)})`}
                            </button>
                          )}
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
                          القراءة ({activeFinalReading}) أقل من السابقة ({prevReading}) — عند الحفظ سيُطلب تحديد السبب لموافقة المدير.
                        </span>
                      </div>
                    )}

                    {/* High Consumption Yellow Alert Preview */}
                    {isHighConsumptionWarning && (
                      <div className="bg-amber-50 border border-amber-300 rounded-lg px-3.5 py-2.5 text-xs text-amber-950 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        <span>
                          تنبيه: الاستهلاك ({consumptionKwh} ك.و.س) أعلى من 3 أضعاف متوسط آخر 3 أشهر ({avg3MonthsKwh} ك.و.س).
                        </span>
                      </div>
                    )}

                    {aiRedAlertNotice && (
                      <div className="flex items-start gap-2.5 text-xs font-bold text-rose-900 bg-rose-100 border-2 border-rose-500 rounded-lg px-3.5 py-3">
                        <ShieldAlert className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                        <span>{aiRedAlertNotice}</span>
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
                      {(permissions.canViewDebts || cashPaidYer > 0) && (
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
                          {permissions.canCollectCash && cashPaidYer > 0 && (
                            <>
                              <div className="flex justify-between text-sm font-bold text-emerald-700">
                                <span>سند قبض فوري (المدفوع نقداً)</span>
                                <span className="font-mono-nums" dir="ltr">
                                  - {formatYer(cashPaidYer)}
                                </span>
                              </div>
                              <div className="border-t border-slate-200 pt-2.5 flex justify-between text-base font-extrabold">
                                <span className="text-slate-900">
                                  المتبقي بعد السداد
                                </span>
                                <span className="font-mono-nums text-slate-950">
                                  {formatYer(remainingBalanceYer)}
                                </span>
                              </div>
                              {cashPaidYer > totalDueYer && (
                                <p className="text-[11px] font-medium text-amber-800">
                                  تنبيه: المبلغ المدفوع ({formatYer(cashPaidYer)}) أكبر من الإجمالي المستحق ({formatYer(totalDueYer)}).
                                </p>
                              )}
                            </>
                          )}
                        </>
                      )}
                    </div>

                    {permissions.canCollectCash &&
                    cashPaidYer > 0 &&
                    !proofPhotoUrl &&
                    activeFinalReading === null ? (
                      <button
                        type="submit"
                        disabled={extractingReading || verifyingWithAi}
                        className="w-full min-h-[48px] py-3 px-4 bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-600 text-white text-sm font-bold rounded-lg transition-colors cursor-pointer"
                      >
                        {`حفظ سند القبض وخصمه (${formatCompactYer(cashPaidYer)})`}
                      </button>
                    ) : (
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={handleRecapture}
                          disabled={extractingReading || verifyingWithAi}
                          className="min-h-[48px] py-3 px-4 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-sm font-bold rounded-lg transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                        >
                          <RotateCcw className="w-4 h-4" />
                          إعادة التقاط
                        </button>
                        <button
                          type="submit"
                          disabled={
                            extractingReading ||
                            verifyingWithAi ||
                            !permissions.canRecordReadings ||
                            !proofPhotoUrl ||
                            activeFinalReading === null
                          }
                          className="min-h-[48px] py-3 px-4 bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-600 text-white text-sm font-bold rounded-lg transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                        >
                          {extractingReading
                            ? 'جاري القراءة...'
                            : verifyingWithAi
                              ? 'جاري المطابقة...'
                              : 'اعتماد القراءة'}
                        </button>
                      </div>
                    )}
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
                        className="w-full min-h-[46px] px-3 py-2 text-base sm:text-lg font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg bg-white"
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
                        className="w-full min-h-[46px] px-3 py-2 text-base sm:text-lg font-bold font-mono-nums border border-slate-300 rounded-lg bg-white"
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
