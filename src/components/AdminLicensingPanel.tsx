import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Cloud,
  CloudDownload,
  CloudUpload,
  Copy,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  KeyRound,
  Lock,
  LogOut,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';
import {
  claimAdminPasscode,
  createManualSubscriberAdmin,
  deleteAccessCodeAdmin,
  deleteExpenseAdmin,
  deleteReadingAdmin,
  deleteReceiptAdmin,
  deleteStationAdmin,
  deleteSubscriberAdmin,
  downloadExcelTemplate,
  fetchAdminBackup,
  fetchAdminOverview,
  fetchStationDetailsAdmin,
  fetchStationSubscribersAdmin,
  generateAccessCodeAdmin,
  getAdminStatus,
  loginAdminPasscode,
  parseSubscribersExcelFile,
  resetCodePinAdmin,
  restoreAdminBackup,
  toggleAccessCodeAdmin,
  toggleStationAiVerificationAdmin,
  toggleStationStatusAdmin,
  uploadSubscribersChunkedAdmin,
} from '../lib/offlineDb';
import {
  FIREBASE_DATABASE_ID,
  FIREBASE_PROJECT_ID,
  formatFirestoreUserMessage,
} from '../lib/firebase';
import {
  isCloudAdminToken,
} from '../lib/cloudAdminStore';
import { saveDeveloperSession } from '../lib/devicePinAuth';
import {
  loadAdminStoreFromFirestore,
  saveAdminStoreToFirestore,
  type AdminStoreBackupPayload,
} from '../lib/firestoreBackup';
import { StationOwnerBrochureModal } from './StationOwnerBrochureModal';
import type {
  AccessCodeRecord,
  DieselExpenseEntry,
  MeterReading,
  PaymentReceipt,
  StationConfig,
  Subscriber,
} from '../types/station';

interface AdminLicensingPanelProps {
  adminToken: string | null;
  onAdminAuthenticated: (token: string) => void;
  onLogoutAdmin: () => void;
}

export const AdminLicensingPanel: React.FC<AdminLicensingPanelProps> = ({
  adminToken,
  onAdminAuthenticated,
  onLogoutAdmin,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonBackupInputRef = useRef<HTMLInputElement>(null);

  const [checkingStatus, setCheckingStatus] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [stations, setStations] = useState<StationConfig[]>([]);
  const [codes, setCodes] = useState<AccessCodeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [confirmDeleteCode, setConfirmDeleteCode] = useState<string | null>(null);
  const [deletingCode, setDeletingCode] = useState<string | null>(null);
  const [resettingPinCode, setResettingPinCode] = useState<string | null>(null);
  const [confirmDeleteStationId, setConfirmDeleteStationId] = useState<string | null>(null);
  const [deletingStationId, setDeletingStationId] = useState<string | null>(null);
  const [togglingAiStationId, setTogglingAiStationId] = useState<string | null>(null);
  const [brochureOpen, setBrochureOpen] = useState(false);

  // Cloud Firestore Vault State
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<string | null>(null);
  const [cloudLastSyncAt, setCloudLastSyncAt] = useState<string | null>(null);
  const autoRestoredRef = useRef(false);

  // Manual code generation state
  const [personName, setPersonName] = useState('');
  const [personRole, setPersonRole] = useState<'manager' | 'collector'>('manager');
  const [targetStationId, setTargetStationId] = useState('');
  const [newStationName, setNewStationName] = useState('');
  const [personPhone, setPersonPhone] = useState('');
  const [assignedZones, setAssignedZones] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [permReadings, setPermReadings] = useState(true);
  const [permCash, setPermCash] = useState(true);
  const [permInvoices, setPermInvoices] = useState(true);
  const [permDebts, setPermDebts] = useState(true);
  const [issuing, setIssuing] = useState(false);

  // Admin-exclusive Excel upload state
  const [excelStationId, setExcelStationId] = useState('');
  const [replaceAllSubs, setReplaceAllSubs] = useState(false);
  const [uploadingExcel, setUploadingExcel] = useState(false);
  const [excelProgress, setExcelProgress] = useState<{
    uploaded: number;
    total: number;
  } | null>(null);

  // Manual subscriber creation state (real simulation)
  const [manualSubStationId, setManualSubStationId] = useState('');
  const [stationSubscribers, setStationSubscribers] = useState<Subscriber[]>([]);
  const [loadingSubscribers, setLoadingSubscribers] = useState(false);
  const [subName, setSubName] = useState('');
  const [subMeter, setSubMeter] = useState('');
  const [subPhone, setSubPhone] = useState('');
  const [subZone, setSubZone] = useState('حارة النصر');
  const [subPrevReading, setSubPrevReading] = useState('1200');
  const [subPrevDebt, setSubPrevDebt] = useState('0');
  const [subAvg3Months, setSubAvg3Months] = useState('');
  const [subSeqOrder, setSubSeqOrder] = useState('');
  const [creatingSub, setCreatingSub] = useState(false);
  const [confirmDeleteSubId, setConfirmDeleteSubId] = useState<string | null>(null);
  const [deletingSubId, setDeletingSubId] = useState<string | null>(null);

  // Developer-Admin-exclusive Station Records Inspector & Delete Console
  const [inspectStationId, setInspectStationId] = useState('');
  const [inspectReadings, setInspectReadings] = useState<MeterReading[]>([]);
  const [inspectReceipts, setInspectReceipts] = useState<PaymentReceipt[]>([]);
  const [inspectExpenses, setInspectExpenses] = useState<DieselExpenseEntry[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [deletingRecordKey, setDeletingRecordKey] = useState<string | null>(null);

  useEffect(() => {
    if (adminToken) {
      setCheckingStatus(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await getAdminStatus();
        if (!cancelled) {
          setConfigured(res.configured);
        }
      } catch {
        if (!cancelled) setConfigured(true);
      } finally {
        if (!cancelled) setCheckingStatus(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adminToken]);

  const syncBackupToFirestoreSilently = useCallback(async () => {
    if (!adminToken) return;
    if (isCloudAdminToken(adminToken)) {
      setCloudLastSyncAt(new Date().toISOString());
      setCloudStatus(
        `المزامنة السحابية التلقائية فعّالة مباشرة في مشروع ${FIREBASE_PROJECT_ID}.`,
      );
      return;
    }
    try {
      const backup = await fetchAdminBackup(adminToken);
      const res = await saveAdminStoreToFirestore(backup);
      if (res.skippedEmptyOverwrite) return;
      setCloudLastSyncAt(res.updatedAtIso);
      setCloudStatus(
        `المزامنة السحابية التلقائية فعّالة في مشروع ${FIREBASE_PROJECT_ID} (${res.stationCount} محطة · ${res.codeCount} كود · ${res.subscriberCount} مشترك).`,
      );
    } catch {
      // ignore silent background errors; manual button surfaces details
    }
  }, [adminToken]);

  const loadAdminData = useCallback(async () => {
    if (!adminToken) return;
    setLoading(true);
    try {
      const data = await fetchAdminOverview(adminToken);
      setStations(data.stations);
      setCodes(data.codes);
      if (data.stations.length > 0) {
        setTargetStationId((prev) => prev || data.stations[0].stationId);
        setExcelStationId((prev) => prev || data.stations[0].stationId);
        setManualSubStationId((prev) => prev || data.stations[0].stationId);
        setInspectStationId((prev) => prev || data.stations[0].stationId);
      }
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر تحميل بيانات الإدارة.',
      );
    } finally {
      setLoading(false);
    }
  }, [adminToken]);

  const loadStationSubscribers = useCallback(
    async (stationId: string) => {
      if (!adminToken || !stationId) {
        setStationSubscribers([]);
        return;
      }
      setLoadingSubscribers(true);
      try {
        const list = await fetchStationSubscribersAdmin(adminToken, stationId);
        setStationSubscribers(list);
      } catch {
        setStationSubscribers([]);
      } finally {
        setLoadingSubscribers(false);
      }
    },
    [adminToken],
  );

  const loadStationDetails = useCallback(
    async (stationId: string) => {
      if (!adminToken || !stationId) {
        setInspectReadings([]);
        setInspectReceipts([]);
        setInspectExpenses([]);
        return;
      }
      setLoadingDetails(true);
      try {
        const details = await fetchStationDetailsAdmin(adminToken, stationId);
        setInspectReadings(details.readings);
        setInspectReceipts(details.receipts);
        setInspectExpenses(details.expenses);
      } catch {
        setInspectReadings([]);
        setInspectReceipts([]);
        setInspectExpenses([]);
      } finally {
        setLoadingDetails(false);
      }
    },
    [adminToken],
  );

  useEffect(() => {
    if (adminToken) {
      void loadAdminData();
    }
  }, [adminToken, loadAdminData]);

  useEffect(() => {
    if (adminToken && manualSubStationId) {
      void loadStationSubscribers(manualSubStationId);
    }
  }, [adminToken, manualSubStationId, loadStationSubscribers]);

  useEffect(() => {
    if (adminToken && inspectStationId) {
      void loadStationDetails(inspectStationId);
    }
  }, [adminToken, inspectStationId, loadStationDetails]);

  // Auto-restore from Firestore Vault once on mount if server store is empty
  useEffect(() => {
    if (
      !adminToken ||
      isCloudAdminToken(adminToken) ||
      loading ||
      autoRestoredRef.current ||
      stations.length > 0 ||
      codes.length > 0
    ) {
      return;
    }
    autoRestoredRef.current = true;
    (async () => {
      try {
        const snap = await loadAdminStoreFromFirestore();
        if (snap && (snap.stationCount > 0 || snap.codeCount > 0)) {
          const restored = await restoreAdminBackup(
            adminToken,
            snap.backup,
            'merge',
          );
          setCloudLastSyncAt(snap.updatedAtIso);
          setCloudStatus(
            `تمت الاستعادة التلقائية من سحابة Firebase (${restored.stationCount} محطة · ${restored.codeCount} كود · ${restored.subscriberCount} مشترك).`,
          );
          await loadAdminData();
        }
      } catch {
        // non-blocking auto-restore check
      }
    })();
  }, [adminToken, loading, stations.length, codes.length, loadAdminData]);

  const handlePasscodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcodeInput.trim()) return;
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const res = configured
        ? await loginAdminPasscode(passcodeInput.trim())
        : await claimAdminPasscode(passcodeInput.trim());
      await saveDeveloperSession({ token: res.token, name: res.name });
      setPasscodeInput('');
      onAdminAuthenticated(res.token);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'تعذر التحقق من كلمة مرور الأدمن.',
      );
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleGenerateCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;
    if (personName.trim().length < 2) {
      setFeedback('يرجى إدخال اسم الشخص (حرفان على الأقل).');
      return;
    }
    if (!targetStationId && newStationName.trim().length < 2) {
      setFeedback('يرجى اختيار محطة قائمة أو كتابة اسم محطة جديدة.');
      return;
    }

    setIssuing(true);
    setFeedback(null);
    try {
      const zonesList = assignedZones
        .split(/[،,]/)
        .map((z) => z.trim())
        .filter(Boolean);

      const res = await generateAccessCodeAdmin(adminToken, {
        name: personName.trim(),
        role: personRole,
        stationId: targetStationId || undefined,
        newStationName: !targetStationId ? newStationName.trim() : undefined,
        phone: personPhone.trim(),
        assignedZones: zonesList,
        customCode: customCode.trim() || undefined,
        permissions: {
          canRecordReadings: permReadings,
          canCollectCash: permCash,
          canSendInvoices: permInvoices,
          canViewDebts: permDebts,
        },
      });

      setPersonName('');
      setPersonPhone('');
      setAssignedZones('');
      setCustomCode('');
      setNewStationName('');
      setTargetStationId(res.station.stationId);
      setExcelStationId(res.station.stationId);
      setFeedback(
        `تم توليد كود ${res.codeRecord.role === 'manager' ? 'مدير المحطة' : 'المحصّل'} (${res.codeRecord.name}): ${res.codeRecord.code}`,
      );
      await loadAdminData();
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر توليد الكود.',
      );
    } finally {
      setIssuing(false);
    }
  };

  const handleExcelUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file || !adminToken) return;
    if (!excelStationId) {
      setFeedback('يرجى اختيار المحطة المستهدفة لرفع كشف المشتركين إليها.');
      event.target.value = '';
      return;
    }

    setUploadingExcel(true);
    setFeedback(null);
    setExcelProgress(null);

    try {
      const parsed = await parseSubscribersExcelFile(file);
      if (parsed.length === 0) {
        setFeedback(
          'لم يتم العثور على صفوف صالحة. تأكد من وجود عمود الاسم (subscriber_name / اسم المشترك) ورقم الهاتف (phone / رقم الهاتف).',
        );
        return;
      }

      const res = await uploadSubscribersChunkedAdmin(adminToken, {
        stationId: excelStationId,
        subscribers: parsed,
        replaceAll: replaceAllSubs,
        onProgress: (uploaded, total) => setExcelProgress({ uploaded, total }),
      });

      setFeedback(
        `تم رفع ${parsed.length} مشترك بنجاح إلى المحطة (إجمالي المشتركين الآن: ${res.totalSubscribers}).`,
      );
      await loadAdminData();
      void syncBackupToFirestoreSilently();
      if (excelStationId === manualSubStationId) {
        await loadStationSubscribers(excelStationId);
      }
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر قراءة أو رفع ملف Excel.',
      );
    } finally {
      setUploadingExcel(false);
      setExcelProgress(null);
      event.target.value = '';
    }
  };

  const handleToggleCode = async (rec: AccessCodeRecord) => {
    if (!adminToken) return;
    try {
      await toggleAccessCodeAdmin(adminToken, rec.code, { active: !rec.active });
      setFeedback(
        rec.active
          ? `تم إلغاء تفعيل الكود ${rec.code} (${rec.name}).`
          : `تم إعادة تفعيل الكود ${rec.code} (${rec.name}).`,
      );
      await loadAdminData();
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'تعذر تحديث حالة الكود.');
    }
  };

  const handleResetCodePin = async (rec: AccessCodeRecord) => {
    if (!adminToken) return;
    setResettingPinCode(rec.code);
    setFeedback(null);
    try {
      await resetCodePinAdmin(adminToken, rec.code);
      setFeedback(
        `تمت إعادة تعيين رمز PIN للكود ${rec.code} (${rec.name}). سيُطلب منه إنشاء PIN جديد من 4 أرقام عند فتح التطبيق.`,
      );
      await loadAdminData();
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر إعادة تعيين رمز PIN.',
      );
    } finally {
      setResettingPinCode(null);
    }
  };

  const handleDeleteCode = async (rec: AccessCodeRecord) => {
    if (!adminToken) return;
    setDeletingCode(rec.code);
    try {
      await deleteAccessCodeAdmin(adminToken, rec.code);
      setConfirmDeleteCode(null);
      setFeedback(`تم مسح الكود ${rec.code} (${rec.name}) بنجاح.`);
      await loadAdminData();
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'تعذر مسح الكود.');
    } finally {
      setDeletingCode(null);
    }
  };

  const handleToggleStation = async (st: StationConfig) => {
    if (!adminToken) return;
    try {
      await toggleStationStatusAdmin(
        adminToken,
        st.stationId,
        st.licenseStatus === 'active' ? 'suspended' : 'active',
      );
      await loadAdminData();
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر تحديث حالة المحطة.',
      );
    }
  };

  const handleToggleAiVerification = async (st: StationConfig) => {
    if (!adminToken) return;
    const nextEnabled = !st.aiPhotoVerificationEnabled;
    setTogglingAiStationId(st.stationId);
    setFeedback(null);
    try {
      const updated = await toggleStationAiVerificationAdmin(
        adminToken,
        st.stationId,
        nextEnabled,
      );
      setFeedback(
        updated.station.aiPhotoVerificationEnabled
          ? `تم تفعيل وتشفير ميزة «مطابقة صورة العداد مع رقم القراءة المحصل» عبر Gemini Vision-AI لمحطة «${st.stationName}».`
          : `تم تعطيل ميزة مطابقة الصور بالذكاء الاصطناعي لمحطة «${st.stationName}».`,
      );
      await loadAdminData();
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(
        err instanceof Error
          ? err.message
          : 'تعذر تحديث إعداد مطابقة صورة العداد عبر Gemini Vision-AI.',
      );
    } finally {
      setTogglingAiStationId(null);
    }
  };

  const handleCopyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleCreateManualSubscriber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;
    if (!manualSubStationId) {
      setFeedback('يرجى اختيار المحطة المستهدفة لإضافة المشترك.');
      return;
    }
    if (subName.trim().length < 2) {
      setFeedback('يرجى إدخال اسم المشترك الكامل (حرفان على الأقل).');
      return;
    }
    if (!subMeter.trim()) {
      setFeedback('يرجى إدخال رقم العداد.');
      return;
    }

    setCreatingSub(true);
    setFeedback(null);
    try {
      const avgVal =
        subAvg3Months.trim() !== '' ? Number(subAvg3Months) : undefined;
      const seqVal =
        subSeqOrder.trim() !== '' ? Number(subSeqOrder) : undefined;
      const res = await createManualSubscriberAdmin(adminToken, {
        stationId: manualSubStationId,
        subscriberName: subName.trim(),
        meterNumber: subMeter.trim(),
        phone: subPhone.trim() || '770000000',
        previousReading: Math.max(0, Number(subPrevReading) || 0),
        previousDebtYer: Math.max(0, Number(subPrevDebt) || 0),
        ...(avgVal !== undefined && Number.isFinite(avgVal) && avgVal >= 0
          ? { last3MonthsAvgKwh: avgVal }
          : {}),
        zoneStreet: subZone.trim() || 'شارع عام',
        ...(seqVal !== undefined && Number.isFinite(seqVal) && seqVal >= 1
          ? { sequenceOrder: seqVal }
          : {}),
      });
      setFeedback(
        `تم إنشاء المشترك «${res.subscriber.subscriberName}» (عداد ${res.subscriber.meterNumber}) للمحاكاة بنجاح — إجمالي مشتركي المحطة: ${res.totalSubscribers}.`,
      );
      setSubName('');
      setSubMeter('');
      setSubPhone('');
      setSubPrevDebt('0');
      setSubAvg3Months('');
      setSubSeqOrder('');
      await Promise.all([
        loadAdminData(),
        loadStationSubscribers(manualSubStationId),
      ]);
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر إنشاء المشترك يدوياً.',
      );
    } finally {
      setCreatingSub(false);
    }
  };

  const handleDeleteManualSubscriber = async (sub: Subscriber) => {
    if (!adminToken || !manualSubStationId) return;
    setDeletingSubId(sub.id);
    try {
      await deleteSubscriberAdmin(adminToken, manualSubStationId, sub.id);
      setConfirmDeleteSubId(null);
      setFeedback(`تم حذف المشترك «${sub.subscriberName}» بنجاح.`);
      await Promise.all([
        loadAdminData(),
        loadStationSubscribers(manualSubStationId),
      ]);
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'تعذر حذف المشترك.',
      );
    } finally {
      setDeletingSubId(null);
    }
  };

  const handleDeleteStation = async (st: StationConfig) => {
    if (!adminToken) return;
    setDeletingStationId(st.stationId);
    try {
      await deleteStationAdmin(adminToken, st.stationId);
      setConfirmDeleteStationId(null);
      setFeedback(`تم مسح المحطة «${st.stationName}» وكل بياناتها حصراً بصلاحية المطور.`);
      await loadAdminData();
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'تعذر مسح المحطة.');
    } finally {
      setDeletingStationId(null);
    }
  };

  const handleDeleteReading = async (readingId: string) => {
    if (!adminToken || !inspectStationId) return;
    setDeletingRecordKey(`rd_${readingId}`);
    try {
      await deleteReadingAdmin(adminToken, inspectStationId, readingId);
      setFeedback('تم مسح القراءة بنجاح بصلاحية الأدمن المطور.');
      await Promise.all([loadAdminData(), loadStationDetails(inspectStationId)]);
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'تعذر مسح القراءة.');
    } finally {
      setDeletingRecordKey(null);
    }
  };

  const handleDeleteReceipt = async (receiptId: string) => {
    if (!adminToken || !inspectStationId) return;
    setDeletingRecordKey(`rc_${receiptId}`);
    try {
      await deleteReceiptAdmin(adminToken, inspectStationId, receiptId);
      setFeedback('تم مسح سند القبض بنجاح بصلاحية الأدمن المطور.');
      await Promise.all([loadAdminData(), loadStationDetails(inspectStationId)]);
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'تعذر مسح سند القبض.');
    } finally {
      setDeletingRecordKey(null);
    }
  };

  const handleDeleteExpense = async (expenseId: string) => {
    if (!adminToken || !inspectStationId) return;
    setDeletingRecordKey(`exp_${expenseId}`);
    try {
      await deleteExpenseAdmin(adminToken, inspectStationId, expenseId);
      setFeedback('تم مسح المصروف بنجاح بصلاحية الأدمن المطور.');
      await Promise.all([loadAdminData(), loadStationDetails(inspectStationId)]);
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'تعذر مسح المصروف.');
    } finally {
      setDeletingRecordKey(null);
    }
  };



  const handleCloudBackupNow = async () => {
    if (!adminToken) return;
    setCloudBusy(true);
    setCloudStatus(null);
    try {
      const backup = await fetchAdminBackup(adminToken);
      const res = await saveAdminStoreToFirestore(backup);
      if (res.skippedEmptyOverwrite) {
        if (res.stationCount > 0 || res.codeCount > 0) {
          const snap = await loadAdminStoreFromFirestore();
          if (snap) {
            const restored = await restoreAdminBackup(adminToken, snap.backup, 'merge');
            setCloudLastSyncAt(snap.updatedAtIso);
            setCloudStatus(
              `تمت حماية بيانات السحابة واستعادتها تلقائياً (${restored.stationCount} محطة · ${restored.codeCount} كود · ${restored.subscriberCount} مشترك).`,
            );
            await loadAdminData();
            if (manualSubStationId) await loadStationSubscribers(manualSubStationId);
            if (inspectStationId) await loadStationDetails(inspectStationId);
            return;
          }
        }
        setCloudStatus('لا توجد محطات أو أكواد مسجلة حالياً للحفظ في السحابة.');
        return;
      }
      setCloudLastSyncAt(res.updatedAtIso);
      setCloudStatus(
        `تمت المزامنة الفورية مع ${FIREBASE_PROJECT_ID} بنجاح (${res.stationCount} محطة، ${res.codeCount} كود، ${res.subscriberCount} مشترك).`,
      );
    } catch (err) {
      setCloudStatus(
        formatFirestoreUserMessage(err, 'تعذر حفظ النسخة في سحابة Firebase.'),
      );
    } finally {
      setCloudBusy(false);
    }
  };

  const handleCloudRestoreNow = async () => {
    if (!adminToken) return;
    setCloudBusy(true);
    setCloudStatus(null);
    try {
      const snap = await loadAdminStoreFromFirestore();
      if (!snap) {
        setCloudStatus('لا توجد نسخة احتياطية محفوظة في سحابة Firebase حتى الآن.');
        return;
      }
      const res = await restoreAdminBackup(adminToken, snap.backup, 'merge');
      setCloudLastSyncAt(snap.updatedAtIso);
      setCloudStatus(
        `تمت استعادة البيانات من سحابة Firebase بنجاح (${res.stationCount} محطة، ${res.codeCount} كود، ${res.subscriberCount} مشترك).`,
      );
      await loadAdminData();
      if (manualSubStationId) await loadStationSubscribers(manualSubStationId);
      if (inspectStationId) await loadStationDetails(inspectStationId);
    } catch (err) {
      setCloudStatus(
        formatFirestoreUserMessage(err, 'تعذر الاستعادة من سحابة Firebase.'),
      );
    } finally {
      setCloudBusy(false);
    }
  };

  const handleDownloadJsonBackup = async () => {
    if (!adminToken) return;
    try {
      const backup = await fetchAdminBackup(adminToken);
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `electricity-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setCloudStatus('تم تنزيل ملف النسخة الاحتياطية (JSON) على جهازك.');
    } catch (err) {
      setCloudStatus(
        err instanceof Error ? err.message : 'تعذر تنزيل النسخة الاحتياطية.',
      );
    }
  };

  const handleImportJsonBackup = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file || !adminToken) return;
    setCloudBusy(true);
    setCloudStatus(null);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as AdminStoreBackupPayload;
      const res = await restoreAdminBackup(adminToken, parsed, 'merge');
      setCloudStatus(
        `تمت استعادة النسخة من ملف JSON (${res.stationCount} محطة، ${res.codeCount} كود، ${res.subscriberCount} مشترك).`,
      );
      await loadAdminData();
      if (manualSubStationId) await loadStationSubscribers(manualSubStationId);
      if (inspectStationId) await loadStationDetails(inspectStationId);
      void syncBackupToFirestoreSilently();
    } catch (err) {
      setCloudStatus(
        err instanceof Error ? err.message : 'ملف JSON غير صالح للاستعادة.',
      );
    } finally {
      setCloudBusy(false);
      event.target.value = '';
    }
  };

  if (!adminToken) {
    return (
      <div className="max-w-md mx-auto py-10">
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5">
          <div className="space-y-1.5">
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Lock className="w-5 h-5 text-teal-700" />
              {checkingStatus
                ? 'جاري التحقق من لوحة المطور...'
                : 'دخول المطور'}
            </h1>
            <p className="text-xs text-slate-600 leading-relaxed">
              أدخل كلمة مرور المطور لإدارة المحطات والمشتركين والأكواد.
            </p>
          </div>

          <form onSubmit={handlePasscodeSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                كلمة مرور المطور
              </label>
              <input
                type="password"
                dir="ltr"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                placeholder="••••••••"
                className="w-full min-h-[48px] px-3.5 py-2.5 text-lg font-bold font-mono-nums placeholder:font-medium border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            {authError && (
              <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">
                {authError}
              </p>
            )}

            <button
              type="submit"
              disabled={authSubmitting || checkingStatus}
              className="w-full min-h-[46px] py-2.5 px-4 bg-teal-700 hover:bg-teal-800 text-white text-sm font-bold rounded-lg transition-colors cursor-pointer"
            >
              {authSubmitting ? 'جاري التحقق...' : 'دخول لوحة المطور'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-teal-700" />
            لوحة الأدمن المطور · الصلاحية المطلقة
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            توليد أكواد مديري المحطات والمحصّلين يدوياً، ورفع كشوفات Excel للمشتركين لكل محطة معزولة.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setBrochureOpen(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-bold bg-teal-700 hover:bg-teal-800 text-white rounded-lg cursor-pointer"
          >
            <FileText className="w-4 h-4" />
            دليل أصحاب المحطات (PDF بالصور)
          </button>
          <button
            type="button"
            onClick={() => void loadAdminData()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            تحديث
          </button>
          <button
            type="button"
            onClick={onLogoutAdmin}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            قفل لوحة الأدمن
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">المحطات المستقلة</div>
          <div className="text-2xl font-bold text-slate-900 font-mono-nums mt-2">
            {stations.length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">أكواد مديري المحطات</div>
          <div className="text-2xl font-bold text-teal-700 font-mono-nums mt-2">
            {codes.filter((c) => c.role === 'manager').length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">أكواد المحصّلين</div>
          <div className="text-2xl font-bold text-slate-900 font-mono-nums mt-2">
            {codes.filter((c) => c.role === 'collector').length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">إجمالي المشتركين المرفوعين</div>
          <div className="text-2xl font-bold text-slate-900 font-mono-nums mt-2">
            {stations.reduce((sum, s) => sum + (s.subscriberCount ?? 0), 0)}
          </div>
        </div>
      </div>

      {feedback && (
        <div className="text-xs font-medium text-teal-900 bg-teal-50 border border-teal-200 rounded-lg px-4 py-3">
          {feedback}
        </div>
      )}

      {/* Automatic Live Cloud Firestore Sync Vault (electricity-station-f5a90) */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Database className="w-5 h-5 text-teal-700" />
              المزامنة السحابية التلقائية الدائمة (Firebase Firestore)
            </h2>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed">
              مشروع Firebase المرتبط:{' '}
              <span dir="ltr" className="font-mono-nums font-bold text-teal-800">
                {FIREBASE_PROJECT_ID} / {FIREBASE_DATABASE_ID}
              </span>{' '}
              — جميع النصوص (المحطات، الأكواد المفعّلة، المشتركين، القراءات، المتأخرات، وسندات القبض) تتزامن تلقائياً وتُستعاد فوراً من أي جهاز بدون تذكير أو نسخ يدوي. صور العدادات تبقى محلياً في هاتف المحصّل مع إمكانية مشاركتها لمدير المحطة.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-teal-900 bg-teal-50 border border-teal-200 px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5">
              <Cloud className="w-4 h-4 text-teal-700" />
              <span className="text-[11px] font-bold text-emerald-700">مزامنة Firestore نشطة</span>
            </span>
            <button
              type="button"
              disabled={cloudBusy}
              onClick={() => void handleCloudBackupNow()}
              className="min-h-[40px] px-3.5 py-2 text-xs font-bold bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <CloudUpload className="w-4 h-4" />
              مزامنة فورية
            </button>
            <button
              type="button"
              disabled={cloudBusy}
              onClick={() => void handleCloudRestoreNow()}
              className="min-h-[40px] px-3.5 py-2 text-xs font-bold bg-white border border-teal-300 text-teal-900 hover:bg-teal-50 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <CloudDownload className="w-4 h-4" />
              جلب من السحابة
            </button>

            <button
              type="button"
              onClick={() => void handleDownloadJsonBackup()}
              className="min-h-[40px] px-3.5 py-2 text-xs font-medium bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-4 h-4 text-teal-700" />
              تصدير JSON
            </button>
            <input
              ref={jsonBackupInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportJsonBackup}
              className="hidden"
            />
            <button
              type="button"
              disabled={cloudBusy}
              onClick={() => jsonBackupInputRef.current?.click()}
              className="min-h-[40px] px-3.5 py-2 text-xs font-medium bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Upload className="w-4 h-4 text-teal-700" />
              استيراد JSON
            </button>
          </div>
        </div>

        {(cloudStatus || cloudLastSyncAt) && (
          <div className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <span>{cloudStatus || 'المزامنة السحابية التلقائية متصلة بالسحابة.'}</span>
            {cloudLastSyncAt && (
              <span className="font-mono-nums text-[11px] text-slate-500">
                آخر مزامنة تلقائية: {new Date(cloudLastSyncAt).toLocaleString('ar-YE')}
              </span>
            )}
          </div>
        )}
      </section>

      {/* Main Grid: Manual Code Generator + Admin-Exclusive Excel Upload */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Manual Manager/Collector Code Generator */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-teal-700" />
            توليد كود يدوي (مدير محطة / محصّل)
          </h2>

          <form onSubmit={handleGenerateCode} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  الاسم الكامل
                </label>
                <input
                  type="text"
                  value={personName}
                  onChange={(e) => setPersonName(e.target.value)}
                  placeholder="أدخل اسم المدير أو المحصّل"
                  className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  الصفة الوظيفية
                </label>
                <select
                  value={personRole}
                  onChange={(e) =>
                    setPersonRole(
                      e.target.value === 'collector' ? 'collector' : 'manager',
                    )
                  }
                  className="w-full min-h-[46px] px-3 py-2 text-base font-bold border border-slate-300 rounded-lg bg-white"
                >
                  <option value="manager">مدير محطة</option>
                  <option value="collector">محصّل ميداني</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  المحطة المرتبطة
                </label>
                <select
                  value={targetStationId}
                  onChange={(e) => setTargetStationId(e.target.value)}
                  className="w-full min-h-[46px] px-3 py-2 text-base font-bold border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">+ إنشاء محطة جديدة</option>
                  {stations.map((st) => (
                    <option key={st.stationId} value={st.stationId}>
                      {st.stationName} ({st.subscriberCount ?? 0} مشترك)
                    </option>
                  ))}
                </select>
              </div>

              {!targetStationId ? (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    اسم المحطة الجديدة
                  </label>
                  <input
                    type="text"
                    value={newStationName}
                    onChange={(e) => setNewStationName(e.target.value)}
                    placeholder="اكتب اسم المحطة الجديدة"
                    className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    رقم الهاتف (اختياري)
                  </label>
                  <input
                    type="tel"
                    value={personPhone}
                    onChange={(e) => setPersonPhone(e.target.value)}
                    placeholder="77xxxxxxx"
                    className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  كود مخصص (اختياري — يُولّد تلقائياً إذا تُرك فارغاً)
                </label>
                <input
                  type="text"
                  dir="ltr"
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
                  placeholder={
                    personRole === 'manager' ? 'MGR-XXXX-XXXX' : 'COL-XXXX-XXXX'
                  }
                  className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg"
                />
              </div>

              {personRole === 'collector' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    الحارات / الشوارع المخصصة (مفصولة بفاصلة)
                  </label>
                  <input
                    type="text"
                    value={assignedZones}
                    onChange={(e) => setAssignedZones(e.target.value)}
                    placeholder="اتركه فارغاً لجميع الحارات"
                    className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              )}
            </div>

            {personRole === 'collector' && (
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3">
                <span className="font-semibold text-slate-900">صلاحيات المحصّل:</span>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={permReadings}
                    onChange={(e) => setPermReadings(e.target.checked)}
                    className="accent-teal-700"
                  />
                  تسجيل القراءات والتصوير
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={permCash}
                    onChange={(e) => setPermCash(e.target.checked)}
                    className="accent-teal-700"
                  />
                  تحصيل النقد والسندات
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
            )}

            <button
              type="submit"
              disabled={issuing}
              className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 bg-teal-700 hover:bg-teal-800 text-white text-sm font-medium rounded-lg inline-flex items-center justify-center gap-2 cursor-pointer"
            >
              <PlusCircle className="w-4 h-4" />
              {issuing ? 'جاري التوليد...' : 'توليد الكود الآن'}
            </button>
          </form>
        </section>

        {/* Admin-Exclusive Excel Upload (supports 3,000 - 5,000+ subscribers in chunks) */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-teal-700" />
              رفع كشف Excel المشتركين
            </h2>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            صلاحية حصرية للأدمن المطور. يدعم رفع كشوفات كبيرة (3,000 إلى 5,000+ مشترك) عبر دفعات آمنة. يدخل المشترك لاحقاً بالاسم الكامل ورقم الهاتف المرفوع في الكشف.
          </p>

          <button
            type="button"
            onClick={downloadExcelTemplate}
            className="w-full min-h-[42px] px-4 py-2 bg-teal-50 hover:bg-teal-100 border border-teal-200 text-teal-900 text-xs font-bold rounded-lg inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Download className="w-4 h-4 text-teal-700" />
            تنزيل ملف Excel نموذجي يوضح رؤوس الأعمدة المطلوبة
          </button>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              اختر المحطة المستهدفة
            </label>
            <select
              value={excelStationId}
              onChange={(e) => setExcelStationId(e.target.value)}
              className="w-full min-h-[46px] px-3 py-2 text-base font-bold border border-slate-300 rounded-lg bg-white"
            >
              <option value="">-- اختر محطة --</option>
              {stations.map((st) => (
                <option key={st.stationId} value={st.stationId}>
                  {st.stationName} ({st.subscriberCount ?? 0} مشترك)
                </option>
              ))}
            </select>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={replaceAllSubs}
              onChange={(e) => setReplaceAllSubs(e.target.checked)}
              className="accent-teal-700"
            />
            استبدال الكشف السابق للمحطة بالكامل عند الرفع
          </label>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleExcelUpload}
            className="hidden"
          />

          <button
            type="button"
            disabled={uploadingExcel || !excelStationId}
            onClick={() => fileInputRef.current?.click()}
            className="w-full min-h-[46px] py-2.5 px-4 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-medium rounded-lg inline-flex items-center justify-center gap-2 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            {uploadingExcel
              ? excelProgress
                ? `جاري الرفع (${excelProgress.uploaded} / ${excelProgress.total})...`
                : 'جاري قراءة الملف...'
              : 'اختيار ملف Excel ورفع الكشف للمحطة'}
          </button>

          <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 leading-relaxed space-y-1">
            <div className="font-semibold text-slate-800">رؤوس الأعمدة المطلوبة (بالعربية أو الإنجليزية):</div>
            <div>رقم العداد · اسم المشترك · رقم الهاتف · القراءة السابقة · المتأخرات · الحارة/الشارع · ترتيب البيت</div>
          </div>
        </section>
      </div>

      {/* Manual Subscriber Creation (for Real Simulation) */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-teal-700" />
              إنشاء مشترك يدوي (لعمل محاكاة حقيقية)
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              أضف مشتركين يدوياً لأي محطة لاختبار تطبيق المحصّل، لوحة المدير، وبوابة المشترك فوراً بدون الحاجة لملف Excel.
            </p>
          </div>
          <div className="w-full sm:w-64">
            <select
              value={manualSubStationId}
              onChange={(e) => setManualSubStationId(e.target.value)}
              className="w-full min-h-[46px] px-3 py-2 text-base font-bold border border-slate-300 rounded-lg bg-white"
            >
              <option value="">-- اختر المحطة --</option>
              {stations.map((st) => (
                <option key={st.stationId} value={st.stationId}>
                  {st.stationName} ({st.subscriberCount ?? 0} مشترك)
                </option>
              ))}
            </select>
          </div>
        </div>

        <form onSubmit={handleCreateManualSubscriber} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                اسم المشترك الكامل
              </label>
              <input
                type="text"
                value={subName}
                onChange={(e) => setSubName(e.target.value)}
                placeholder="مثال: أحمد محمد علي"
                className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                رقم العداد
              </label>
              <input
                type="text"
                dir="ltr"
                value={subMeter}
                onChange={(e) => setSubMeter(e.target.value)}
                placeholder="104501"
                className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                رقم الهاتف
              </label>
              <input
                type="tel"
                dir="ltr"
                value={subPhone}
                onChange={(e) => setSubPhone(e.target.value)}
                placeholder="771234567"
                className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                الحارة / الشارع
              </label>
              <input
                type="text"
                value={subZone}
                onChange={(e) => setSubZone(e.target.value)}
                placeholder="حارة النصر"
                className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                القراءة السابقة (ك.و.س)
              </label>
              <input
                type="number"
                step="0.01"
                min={0}
                value={subPrevReading}
                onChange={(e) => setSubPrevReading(e.target.value)}
                className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                المتأخرات السابقة (ر.ي)
              </label>
              <input
                type="number"
                min={0}
                value={subPrevDebt}
                onChange={(e) => setSubPrevDebt(e.target.value)}
                className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold font-mono-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                متوسط آخر 3 أشهر (ك.و.س - اختياري)
              </label>
              <input
                type="number"
                min={0}
                value={subAvg3Months}
                onChange={(e) => setSubAvg3Months(e.target.value)}
                placeholder="اختياري لاختبار التنبيه الأصفر"
                className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                ترتيب خط السير (تلقائي إذا تُرك فارغاً)
              </label>
              <input
                type="number"
                min={1}
                value={subSeqOrder}
                onChange={(e) => setSubSeqOrder(e.target.value)}
                placeholder="تلقائي"
                className="w-full min-h-[46px] px-3.5 py-2 text-base sm:text-lg font-bold font-mono-nums placeholder:font-medium placeholder:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={creatingSub || !manualSubStationId}
            className="w-full sm:w-auto min-h-[46px] px-6 py-2.5 bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white text-sm font-bold rounded-lg inline-flex items-center justify-center gap-2 cursor-pointer"
          >
            <UserPlus className="w-4 h-4" />
            {creatingSub ? 'جاري الإضافة...' : 'إضافة المشترك للمحطة'}
          </button>
        </form>

        {/* Live list of subscribers in selected station */}
        {manualSubStationId && (
          <div className="border-t border-slate-200 pt-4 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
              <span>
                المشتركون المسجلون في المحطة المختارة ({stationSubscribers.length})
              </span>
              {loadingSubscribers && (
                <span className="text-teal-700">جاري التحديث...</span>
              )}
            </div>
            {stationSubscribers.length > 0 ? (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-xs sm:text-sm text-right">
                  <thead className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3 font-medium">الترتيب</th>
                      <th className="py-2.5 px-3 font-medium">اسم المشترك</th>
                      <th className="py-2.5 px-3 font-medium">رقم العداد</th>
                      <th className="py-2.5 px-3 font-medium">الهاتف</th>
                      <th className="py-2.5 px-3 font-medium">الحارة</th>
                      <th className="py-2.5 px-3 font-medium">القراءة السابقة</th>
                      <th className="py-2.5 px-3 font-medium">المتأخرات</th>
                      <th className="py-2.5 px-3 font-medium">إجراء</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {stationSubscribers.slice(0, 50).map((sub) => (
                      <tr key={sub.id}>
                        <td className="py-2.5 px-3 font-mono-nums text-slate-500">
                          {sub.sequenceOrder}
                        </td>
                        <td className="py-2.5 px-3 font-bold text-slate-900">
                          {sub.subscriberName}
                        </td>
                        <td className="py-2.5 px-3 font-mono-nums font-bold text-teal-800">
                          {sub.meterNumber}
                        </td>
                        <td className="py-2.5 px-3 font-mono-nums text-slate-700">
                          {sub.phone}
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {sub.zoneStreet}
                        </td>
                        <td className="py-2.5 px-3 font-mono-nums text-slate-800">
                          {sub.previousReading}
                        </td>
                        <td className="py-2.5 px-3 font-mono-nums text-slate-800">
                          {sub.previousDebtYer} ر.ي
                        </td>
                        <td className="py-2.5 px-3">
                          {confirmDeleteSubId === sub.id ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={deletingSubId === sub.id}
                                onClick={() => void handleDeleteManualSubscriber(sub)}
                                className="px-2.5 py-1 text-xs font-bold rounded bg-rose-700 hover:bg-rose-800 text-white cursor-pointer"
                              >
                                {deletingSubId === sub.id ? 'جاري...' : 'تأكيد'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteSubId(null)}
                                className="px-2 py-1 text-xs rounded border border-slate-300 bg-white text-slate-700 cursor-pointer"
                              >
                                إلغاء
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteSubId(sub.id)}
                              className="px-2.5 py-1 text-xs font-medium rounded border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              حذف
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-2">
                لا يوجد مشتركون في هذه المحطة بعد. أضف أول مشترك من النموذج أعلاه لبدء المحاكاة.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Stations Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-bold text-slate-900">
            المحطات المعزولة المسجلة ({stations.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-right">
            <thead className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-medium">اسم المحطة</th>
                <th className="py-3 px-4 font-medium">المشتركين</th>
                <th className="py-3 px-4 font-medium">القراءات</th>
                <th className="py-3 px-4 font-medium">التعرفة</th>
                <th className="py-3 px-4 font-medium">الحالة</th>
                <th className="py-3 px-4 font-medium">
                  مطابقة صورة العداد مع رقم القراءة (Gemini Vision-AI)
                </th>
                <th className="py-3 px-4 font-medium">إجراء (المطور فقط)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stations.map((st) => (
                <tr key={st.stationId}>
                  <td className="py-3 px-4 font-semibold text-slate-900">
                    {st.stationName}
                  </td>
                  <td className="py-3 px-4 font-mono-nums">
                    {st.subscriberCount ?? 0}
                  </td>
                  <td className="py-3 px-4 font-mono-nums">
                    {st.readingCount ?? 0}
                  </td>
                  <td className="py-3 px-4 font-mono-nums">
                    {st.kwhPriceYer} ر.ي
                  </td>
                  <td className="py-3 px-4 text-xs font-semibold">
                    {st.licenseStatus === 'active' ? (
                      <span className="text-teal-700">نشطة</span>
                    ) : (
                      <span className="text-rose-700">موقوفة</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-col items-start gap-1">
                      <button
                        type="button"
                        disabled={togglingAiStationId === st.stationId}
                        onClick={() => void handleToggleAiVerification(st)}
                        className={`px-3 py-1.5 text-xs font-bold rounded-lg border inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
                          st.aiPhotoVerificationEnabled
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100'
                            : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <Lock className="w-3.5 h-3.5" />
                        <Sparkles className="w-3.5 h-3.5" />
                        {togglingAiStationId === st.stationId
                          ? 'جاري التشفير...'
                          : st.aiPhotoVerificationEnabled
                            ? 'مفعّل ومشفّر (AI Vision)'
                            : 'معطّل (تفعيل AI Vision)'}
                      </button>
                      {st.aiPhotoVerificationEnabled &&
                        typeof st.aiPhotoVerificationSealed === 'string' &&
                        st.aiPhotoVerificationSealed.length > 0 && (
                        <span
                          dir="ltr"
                          className="text-[10px] font-mono-nums text-emerald-700 truncate max-w-[190px]"
                        >
                          {st.aiPhotoVerificationSealed.slice(0, 22)}...
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleToggleStation(st)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer ${
                          st.licenseStatus === 'active'
                            ? 'border-rose-200 bg-rose-50 text-rose-800'
                            : 'border-teal-200 bg-teal-50 text-teal-800'
                        }`}
                      >
                        {st.licenseStatus === 'active' ? 'إيقاف' : 'تفعيل'}
                      </button>

                      {confirmDeleteStationId === st.stationId ? (
                        <>
                          <button
                            type="button"
                            disabled={deletingStationId === st.stationId}
                            onClick={() => void handleDeleteStation(st)}
                            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-rose-700 hover:bg-rose-800 text-white cursor-pointer"
                          >
                            {deletingStationId === st.stationId
                              ? 'جاري المسح...'
                              : 'تأكيد مسح المحطة'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteStationId(null)}
                            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700 cursor-pointer"
                          >
                            إلغاء
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteStationId(st.stationId)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          مسح المحطة
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {stations.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500 text-xs">
                    لا توجد محطات بعد. ولّد أول كود مدير محطة من النموذج أعلاه ليتم إنشاء المحطة تلقائياً.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Generated Access Codes Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-bold text-slate-900">
            سجل أكواد مديري المحطات والمحصّلين ({codes.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-right">
            <thead className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-medium">الكود</th>
                <th className="py-3 px-4 font-medium">الاسم</th>
                <th className="py-3 px-4 font-medium">الصفة</th>
                <th className="py-3 px-4 font-medium">المحطة</th>
                <th className="py-3 px-4 font-medium">الحالة</th>
                <th className="py-3 px-4 font-medium">تحكم</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {codes.map((rec) => (
                <tr key={rec.code}>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span
                        dir="ltr"
                        className="font-mono-nums font-bold text-slate-900"
                      >
                        {rec.code}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopyCode(rec.code)}
                        className="p-1 text-slate-500 hover:text-teal-700 cursor-pointer"
                      >
                        {copiedCode === rec.code ? (
                          <Check className="w-3.5 h-3.5 text-teal-700" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="py-3 px-4 font-medium text-slate-900">
                    {rec.name}
                  </td>
                  <td className="py-3 px-4 text-xs font-semibold">
                    {rec.role === 'manager' ? (
                      <span className="text-teal-800">مدير محطة</span>
                    ) : (
                      <span className="text-slate-700">محصّل ميداني</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-600">
                    {rec.stationName}
                  </td>
                  <td className="py-3 px-4 text-xs font-semibold">
                    {rec.active ? (
                      <span className="text-teal-700">مفعّل</span>
                    ) : (
                      <span className="text-rose-700">موقوف</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleToggleCode(rec)}
                        className={`px-3 py-1.5 text-xs font-bold rounded-lg border cursor-pointer ${
                          rec.active
                            ? 'border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-900'
                            : 'border-teal-200 bg-teal-50 hover:bg-teal-100 text-teal-800'
                        }`}
                      >
                        {rec.active ? 'إلغاء تفعيل كود' : 'تفعيل الكود'}
                      </button>

                      <button
                        type="button"
                        disabled={resettingPinCode === rec.code}
                        onClick={() => void handleResetCodePin(rec)}
                        className="px-3 py-1.5 text-xs font-bold rounded-lg border border-sky-200 bg-sky-50 hover:bg-sky-100 text-sky-900 inline-flex items-center gap-1 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        {resettingPinCode === rec.code
                          ? 'جاري...'
                          : 'إعادة تعيين PIN'}
                      </button>

                      {confirmDeleteCode === rec.code ? (
                        <>
                          <button
                            type="button"
                            disabled={deletingCode === rec.code}
                            onClick={() => void handleDeleteCode(rec)}
                            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-rose-700 hover:bg-rose-800 text-white cursor-pointer"
                          >
                            {deletingCode === rec.code
                              ? 'جاري المسح...'
                              : 'تأكيد المسح'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteCode(null)}
                            className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-700 cursor-pointer"
                          >
                            إلغاء
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteCode(rec.code)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          مسح
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {codes.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500 text-xs">
                    لم يتم توليد أي أكواد بعد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Developer-Admin Exclusive Deletion Console for Readings, Receipts & Expenses */}
      {stations.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Lock className="w-4 h-4 text-rose-700" />
                إدارة ومسح القراءات وسندات القبض والمصاريف (صلاحية الأدمن المطور فقط)
              </h2>
              <p className="text-xs text-slate-600 mt-1">
                لا يمتلك مدير المحطة أو المحصّل أي صلاحية لحذف أي قراءة أو سند أو مصروف. المسح يتم من هنا حصراً.
              </p>
            </div>
            <select
              value={inspectStationId}
              onChange={(e) => setInspectStationId(e.target.value)}
              className="min-h-[42px] px-3 py-2 text-sm font-bold border border-slate-300 rounded-lg bg-white"
            >
              {stations.map((st) => (
                <option key={st.stationId} value={st.stationId}>
                  {st.stationName}
                </option>
              ))}
            </select>
          </div>

          {loadingDetails ? (
            <p className="text-xs text-slate-500">جاري تحميل سجلات المحطة...</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Readings */}
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <div className="text-xs font-bold text-slate-800">
                  القراءات ({inspectReadings.length})
                </div>
                <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
                  {inspectReadings.slice(0, 30).map((rd) => (
                    <div
                      key={rd.id}
                      className="py-2 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 truncate">
                          {rd.subscriberName}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono-nums">
                          {rd.previousReading} ← {rd.currentReading} ({rd.consumptionKwh} ك.و.س)
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={deletingRecordKey === `rd_${rd.id}`}
                        onClick={() => void handleDeleteReading(rd.id)}
                        className="px-2 py-1 text-[11px] font-bold rounded border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 shrink-0 cursor-pointer"
                      >
                        مسح
                      </button>
                    </div>
                  ))}
                  {inspectReadings.length === 0 && (
                    <div className="py-4 text-center text-[11px] text-slate-400">
                      لا توجد قراءات
                    </div>
                  )}
                </div>
              </div>

              {/* Receipts */}
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <div className="text-xs font-bold text-slate-800">
                  سندات القبض ({inspectReceipts.length})
                </div>
                <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
                  {inspectReceipts.slice(0, 30).map((rc) => (
                    <div
                      key={rc.id}
                      className="py-2 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 truncate">
                          {rc.subscriberName}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono-nums">
                          {rc.amountPaidYer} ر.ي · {rc.collectorName}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={deletingRecordKey === `rc_${rc.id}`}
                        onClick={() => void handleDeleteReceipt(rc.id)}
                        className="px-2 py-1 text-[11px] font-bold rounded border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 shrink-0 cursor-pointer"
                      >
                        مسح
                      </button>
                    </div>
                  ))}
                  {inspectReceipts.length === 0 && (
                    <div className="py-4 text-center text-[11px] text-slate-400">
                      لا توجد سندات
                    </div>
                  )}
                </div>
              </div>

              {/* Diesel & Expenses */}
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <div className="text-xs font-bold text-slate-800">
                  مصاريف الديزل والتشغيل ({inspectExpenses.length})
                </div>
                <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
                  {inspectExpenses.slice(0, 30).map((exp) => (
                    <div
                      key={exp.id}
                      className="py-2 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 truncate">
                          {exp.date} — {exp.amountYer} ر.ي
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {exp.note || exp.category}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={deletingRecordKey === `exp_${exp.id}`}
                        onClick={() => void handleDeleteExpense(exp.id)}
                        className="px-2 py-1 text-[11px] font-bold rounded border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 shrink-0 cursor-pointer"
                      >
                        مسح
                      </button>
                    </div>
                  ))}
                  {inspectExpenses.length === 0 && (
                    <div className="py-4 text-center text-[11px] text-slate-400">
                      لا توجد مصاريف
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      <StationOwnerBrochureModal
        open={brochureOpen}
        onClose={() => setBrochureOpen(false)}
      />
    </div>
  );
};
