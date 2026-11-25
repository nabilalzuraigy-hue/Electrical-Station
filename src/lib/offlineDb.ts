import * as XLSX from 'xlsx';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import {
  computeSubscriberPortalHash,
  db,
  handleFirestoreError,
  OperationType,
} from './firebase';
import type {
  CollectorInvite,
  CollectorPermissions,
  CollectorProfile,
  LicenseRecord,
  LicenseStatus,
  MeterReading,
  PaymentReceipt,
  StationConfig,
  Subscriber,
  UserRoleBinding,
} from '../types/station';

export const SUPER_ADMIN_EMAIL = 'nabilalzuraigy@gmail.com';

const STORAGE_PREFIX = 'yemen_power_isolated_v2_';

export interface StationLocalState {
  station: StationConfig;
  collectors: CollectorProfile[];
  invites: CollectorInvite[];
  subscribers: Subscriber[];
  readings: MeterReading[];
  receipts: PaymentReceipt[];
}

export function isSuperAdminUser(user: User | null): boolean {
  return (
    Boolean(user?.emailVerified) &&
    user?.email?.toLowerCase() === SUPER_ADMIN_EMAIL
  );
}

export function sanitizeFirestoreId(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean.slice(0, 120) || `id_${Date.now()}`;
}

export function normalizeActivationCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export function generateRandomCode(prefix: string): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = (len: number) =>
    Array.from({ length: len }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length)),
    ).join('');
  return `${prefix}-${block(4)}-${block(4)}`;
}

export function createEmptyStationState(station: StationConfig): StationLocalState {
  return {
    station,
    collectors: [],
    invites: [],
    subscribers: [],
    readings: [],
    receipts: [],
  };
}

export function loadStationLocalState(
  stationId: string,
): StationLocalState | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${stationId}`);
    if (!raw) return null;
    return JSON.parse(raw) as StationLocalState;
  } catch {
    return null;
  }
}

export function saveStationLocalState(state: StationLocalState): void {
  localStorage.setItem(
    `${STORAGE_PREFIX}${state.station.stationId}`,
    JSON.stringify(state),
  );
}

// ============================================================
// Super Admin License Management (nabilalzuraigy@gmail.com)
// ============================================================

export async function fetchAllLicenses(): Promise<LicenseRecord[]> {
  const path = 'licenses';
  try {
    const snap = await getDocs(
      query(collection(db, 'licenses'), orderBy('createdAt', 'desc')),
    );
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        code: data.code as string,
        stationId: data.stationId as string,
        stationName: data.stationName as string,
        maxCollectors: Number(data.maxCollectors ?? 5),
        maxSubscribers: Number(data.maxSubscribers ?? 1000),
        status: data.status as LicenseStatus,
        activatedByUid: data.activatedByUid as string | undefined,
        activatedByEmail: data.activatedByEmail as string | undefined,
        activatedAt:
          data.activatedAt instanceof Timestamp
            ? data.activatedAt.toDate().toISOString()
            : undefined,
        expiresAt:
          data.expiresAt instanceof Timestamp
            ? data.expiresAt.toDate().toISOString()
            : String(data.expiresAt ?? ''),
        createdAt:
          data.createdAt instanceof Timestamp
            ? data.createdAt.toDate().toISOString()
            : new Date().toISOString(),
        updatedAt:
          data.updatedAt instanceof Timestamp
            ? data.updatedAt.toDate().toISOString()
            : new Date().toISOString(),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function fetchAllStationsAdmin(): Promise<StationConfig[]> {
  const path = 'stations';
  try {
    const snap = await getDocs(collection(db, 'stations'));
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        stationId: d.id,
        stationName: String(data.stationName ?? ''),
        kwhPriceYer: Number(data.kwhPriceYer ?? 450),
        minimumFeeYer: Number(data.minimumFeeYer ?? 0),
        mainGeneratorKwh: Number(data.mainGeneratorKwh ?? 0),
        licenseCode: String(data.licenseCode ?? ''),
        licenseStatus: (data.licenseStatus as 'active' | 'suspended') ?? 'active',
        maxCollectors: Number(data.maxCollectors ?? 5),
        maxSubscribers: Number(data.maxSubscribers ?? 1000),
        ownerUid: String(data.ownerUid ?? ''),
        updatedAt:
          data.updatedAt instanceof Timestamp
            ? data.updatedAt.toDate().toISOString()
            : new Date().toISOString(),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function issueStationLicense(params: {
  stationName: string;
  maxCollectors: number;
  maxSubscribers: number;
  validityDays: number;
}): Promise<LicenseRecord> {
  const code = generateRandomCode('YEM');
  const stationId = sanitizeFirestoreId(
    `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  );
  const expiresDate = new Date(
    Date.now() + params.validityDays * 24 * 60 * 60 * 1000,
  );
  const path = `licenses/${code}`;

  try {
    await setDoc(doc(db, 'licenses', code), {
      code,
      stationId,
      stationName: params.stationName.trim(),
      maxCollectors: Math.max(1, params.maxCollectors),
      maxSubscribers: Math.max(1, params.maxSubscribers),
      status: 'unused',
      expiresAt: Timestamp.fromDate(expiresDate),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }

  return {
    code,
    stationId,
    stationName: params.stationName.trim(),
    maxCollectors: Math.max(1, params.maxCollectors),
    maxSubscribers: Math.max(1, params.maxSubscribers),
    status: 'unused',
    expiresAt: expiresDate.toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function setStationLicenseStatus(params: {
  licenseCode: string;
  stationId: string;
  nextStatus: 'active' | 'suspended';
}): Promise<void> {
  try {
    await updateDoc(doc(db, 'licenses', params.licenseCode), {
      status: params.nextStatus,
      updatedAt: serverTimestamp(),
    });
    const stRef = doc(db, 'stations', params.stationId);
    const stSnap = await getDoc(stRef);
    if (stSnap.exists()) {
      await updateDoc(stRef, {
        licenseStatus: params.nextStatus,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.UPDATE,
      `licenses/${params.licenseCode}`,
    );
  }
}

// ============================================================
// User Role Resolution & Code Activation (Manager & Collector)
// ============================================================

export async function resolveUserRoleBinding(
  uid: string,
): Promise<UserRoleBinding | null> {
  const path = `userRoles/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'userRoles', uid));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      role: data.role as 'manager' | 'collector',
      stationId: data.stationId as string,
      stationName: data.stationName as string,
      codeUsed: data.codeUsed as string,
      active: Boolean(data.active),
      updatedAt:
        data.updatedAt instanceof Timestamp
          ? data.updatedAt.toDate().toISOString()
          : new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function redeemStationLicenseCode(params: {
  codeInput: string;
  user: User;
  customStationName?: string;
}): Promise<UserRoleBinding> {
  const code = normalizeActivationCode(params.codeInput);
  if (!code || code.length < 6) {
    throw new Error('يرجى إدخال كود ترخيص صالح.');
  }

  const licRef = doc(db, 'licenses', code);
  const licSnap = await getDoc(licRef);
  if (!licSnap.exists()) {
    throw new Error('كود الترخيص غير موجود. تأكد من الكود الصادر من الأدمن.');
  }

  const lic = licSnap.data();
  if (lic.status !== 'unused') {
    throw new Error('هذا الكود مستخدم مسبقاً أو موقوف.');
  }

  const expiresAt =
    lic.expiresAt instanceof Timestamp ? lic.expiresAt.toDate() : null;
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    throw new Error('انتهت صلاحية كود الترخيص هذا.');
  }

  const stationId = String(lic.stationId);
  const stationName =
    params.customStationName?.trim() || String(lic.stationName);

  const batch = writeBatch(db);
  batch.update(licRef, {
    status: 'active',
    activatedByUid: params.user.uid,
    activatedByEmail: params.user.email ?? '',
    activatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'stations', stationId), {
    stationName,
    kwhPriceYer: 450,
    minimumFeeYer: 0,
    mainGeneratorKwh: 0,
    licenseCode: code,
    licenseStatus: 'active',
    maxCollectors: Number(lic.maxCollectors ?? 5),
    maxSubscribers: Number(lic.maxSubscribers ?? 1000),
    ownerUid: params.user.uid,
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'userRoles', params.user.uid), {
    role: 'manager',
    stationId,
    stationName,
    codeUsed: code,
    active: true,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `licenses/${code}`);
  }

  return {
    role: 'manager',
    stationId,
    stationName,
    codeUsed: code,
    active: true,
    updatedAt: new Date().toISOString(),
  };
}

export async function redeemCollectorInviteCode(params: {
  inviteCodeInput: string;
  user: User;
}): Promise<UserRoleBinding> {
  const inviteCode = normalizeActivationCode(params.inviteCodeInput);
  if (!inviteCode || inviteCode.length < 6) {
    throw new Error('يرجى إدخال كود تفعيل المحصّل بشكل صحيح.');
  }

  const invRef = doc(db, 'collectorInvites', inviteCode);
  const invSnap = await getDoc(invRef);
  if (!invSnap.exists()) {
    throw new Error('كود المحصّل غير موجود. اطلب الكود من مدير محطتك.');
  }

  const inv = invSnap.data();
  if (inv.status !== 'unused') {
    throw new Error('كود المحصّل هذا مستخدم مسبقاً أو ملغى.');
  }

  const stationId = String(inv.stationId);
  const stationName = String(inv.stationName);

  const batch = writeBatch(db);
  batch.update(invRef, {
    status: 'claimed',
    claimedByUid: params.user.uid,
    claimedAt: serverTimestamp(),
  });

  batch.set(
    doc(db, 'stations', stationId, 'collectors', params.user.uid),
    {
      name: String(inv.collectorName),
      email: params.user.email ?? '',
      phone: String(inv.phone),
      assignedZones: (inv.assignedZones as string[]) ?? [],
      permissions: inv.permissions as CollectorPermissions,
      active: true,
      inviteCode,
      createdAt: serverTimestamp(),
    },
  );

  batch.set(doc(db, 'userRoles', params.user.uid), {
    role: 'collector',
    stationId,
    stationName,
    codeUsed: inviteCode,
    active: true,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `collectorInvites/${inviteCode}`,
    );
  }

  return {
    role: 'collector',
    stationId,
    stationName,
    codeUsed: inviteCode,
    active: true,
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================
// Station Manager: Collector Invites, Permissions & Activation
// ============================================================

export async function createCollectorInvite(params: {
  station: StationConfig;
  collectorName: string;
  phone: string;
  assignedZones: string[];
  permissions: CollectorPermissions;
}): Promise<CollectorInvite> {
  const inviteCode = generateRandomCode('COL');
  const path = `collectorInvites/${inviteCode}`;
  try {
    await setDoc(doc(db, 'collectorInvites', inviteCode), {
      inviteCode,
      stationId: params.station.stationId,
      stationName: params.station.stationName,
      ownerUid: params.station.ownerUid,
      collectorName: params.collectorName.trim(),
      phone: params.phone.trim(),
      assignedZones: params.assignedZones,
      permissions: params.permissions,
      status: 'unused',
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }

  return {
    inviteCode,
    stationId: params.station.stationId,
    stationName: params.station.stationName,
    ownerUid: params.station.ownerUid,
    collectorName: params.collectorName.trim(),
    phone: params.phone.trim(),
    assignedZones: params.assignedZones,
    permissions: params.permissions,
    status: 'unused',
    createdAt: new Date().toISOString(),
  };
}

export async function updateCollectorInCloud(params: {
  stationId: string;
  collector: CollectorProfile;
}): Promise<void> {
  const path = `stations/${params.stationId}/collectors/${params.collector.id}`;
  try {
    await updateDoc(
      doc(db, 'stations', params.stationId, 'collectors', params.collector.id),
      {
        name: params.collector.name,
        email: params.collector.email,
        phone: params.collector.phone,
        assignedZones: params.collector.assignedZones,
        permissions: params.collector.permissions,
        active: params.collector.active,
      },
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ============================================================
// Isolated Station Data Loader (Manager & Collector)
// ============================================================

export async function fetchIsolatedStationState(params: {
  stationId: string;
  role: 'manager' | 'collector';
  uid: string;
}): Promise<StationLocalState> {
  const stSnap = await getDoc(doc(db, 'stations', params.stationId));
  if (!stSnap.exists()) {
    throw new Error('لم يتم العثور على بيانات هذه المحطة.');
  }
  const stData = stSnap.data();
  const station: StationConfig = {
    stationId: params.stationId,
    stationName: String(stData.stationName ?? ''),
    kwhPriceYer: Number(stData.kwhPriceYer ?? 450),
    minimumFeeYer: Number(stData.minimumFeeYer ?? 0),
    mainGeneratorKwh: Number(stData.mainGeneratorKwh ?? 0),
    licenseCode: String(stData.licenseCode ?? ''),
    licenseStatus: (stData.licenseStatus as 'active' | 'suspended') ?? 'active',
    maxCollectors: Number(stData.maxCollectors ?? 5),
    maxSubscribers: Number(stData.maxSubscribers ?? 1000),
    ownerUid: String(stData.ownerUid ?? ''),
    updatedAt:
      stData.updatedAt instanceof Timestamp
        ? stData.updatedAt.toDate().toISOString()
        : new Date().toISOString(),
  };

  let collectors: CollectorProfile[] = [];
  let invites: CollectorInvite[] = [];

  if (params.role === 'manager') {
    const colSnap = await getDocs(
      collection(db, 'stations', params.stationId, 'collectors'),
    );
    collectors = colSnap.docs.map((d) => {
      const c = d.data();
      return {
        id: d.id,
        name: String(c.name ?? ''),
        email: String(c.email ?? ''),
        phone: String(c.phone ?? ''),
        assignedZones: (c.assignedZones as string[]) ?? [],
        permissions: (c.permissions as CollectorPermissions) ?? {
          canRecordReadings: true,
          canCollectCash: true,
          canSendInvoices: true,
          canViewDebts: true,
        },
        active: Boolean(c.active),
        inviteCode: c.inviteCode as string | undefined,
        createdAt:
          c.createdAt instanceof Timestamp
            ? c.createdAt.toDate().toISOString()
            : new Date().toISOString(),
      };
    });

    const invSnap = await getDocs(collection(db, 'collectorInvites'));
    invites = invSnap.docs
      .filter((d) => d.data().stationId === params.stationId)
      .map((d) => {
        const iv = d.data();
        return {
          inviteCode: String(iv.inviteCode ?? d.id),
          stationId: String(iv.stationId),
          stationName: String(iv.stationName),
          ownerUid: String(iv.ownerUid),
          collectorName: String(iv.collectorName),
          phone: String(iv.phone),
          assignedZones: (iv.assignedZones as string[]) ?? [],
          permissions: iv.permissions as CollectorPermissions,
          status: iv.status as 'unused' | 'claimed' | 'revoked',
          claimedByUid: iv.claimedByUid as string | undefined,
          createdAt:
            iv.createdAt instanceof Timestamp
              ? iv.createdAt.toDate().toISOString()
              : new Date().toISOString(),
        };
      });
  } else {
    const selfCol = await getDoc(
      doc(db, 'stations', params.stationId, 'collectors', params.uid),
    );
    if (selfCol.exists()) {
      const c = selfCol.data();
      collectors = [
        {
          id: selfCol.id,
          name: String(c.name ?? ''),
          email: String(c.email ?? ''),
          phone: String(c.phone ?? ''),
          assignedZones: (c.assignedZones as string[]) ?? [],
          permissions: (c.permissions as CollectorPermissions) ?? {
            canRecordReadings: false,
            canCollectCash: false,
            canSendInvoices: false,
            canViewDebts: false,
          },
          active: Boolean(c.active),
          inviteCode: c.inviteCode as string | undefined,
          createdAt:
            c.createdAt instanceof Timestamp
              ? c.createdAt.toDate().toISOString()
              : new Date().toISOString(),
        },
      ];
    }
  }

  const subSnap = await getDocs(
    collection(db, 'stations', params.stationId, 'subscribers'),
  );
  const subscribers: Subscriber[] = subSnap.docs.map((d) => {
    const s = d.data();
    return {
      id: d.id,
      meterNumber: String(s.meterNumber ?? ''),
      subscriberName: String(s.subscriberName ?? ''),
      phone: String(s.phone ?? ''),
      previousReading: Number(s.previousReading ?? 0),
      currentReading: Number(s.currentReading ?? 0),
      previousDebtYer: Number(s.previousDebtYer ?? 0),
      zoneStreet: String(s.zoneStreet ?? ''),
      sequenceOrder: Number(s.sequenceOrder ?? 1),
      assignedCollectorId: s.assignedCollectorId as string | undefined,
      syncStatus: 'synced',
      updatedAt:
        s.updatedAt instanceof Timestamp
          ? s.updatedAt.toDate().toISOString()
          : new Date().toISOString(),
    };
  });

  const rdSnap = await getDocs(
    collection(db, 'stations', params.stationId, 'readings'),
  );
  const readings: MeterReading[] = rdSnap.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id,
      subscriberId: String(r.subscriberId ?? ''),
      meterNumber: String(r.meterNumber ?? ''),
      subscriberName: String(r.subscriberName ?? ''),
      previousReading: Number(r.previousReading ?? 0),
      currentReading: Number(r.currentReading ?? 0),
      consumptionKwh: Number(r.consumptionKwh ?? 0),
      kwhPriceYer: Number(r.kwhPriceYer ?? 0),
      currentBillYer: Number(r.currentBillYer ?? 0),
      previousDebtYer: Number(r.previousDebtYer ?? 0),
      totalDueYer: Number(r.totalDueYer ?? 0),
      photoUrl: String(r.photoUrl ?? ''),
      photoSizeKb: Number(r.photoSizeKb ?? 0),
      collectorUid: String(r.collectorUid ?? ''),
      collectorName: String(r.collectorName ?? ''),
      recordedAt:
        r.recordedAt instanceof Timestamp
          ? r.recordedAt.toDate().toISOString()
          : new Date().toISOString(),
      syncStatus: 'synced',
    };
  });

  const rcSnap = await getDocs(
    collection(db, 'stations', params.stationId, 'receipts'),
  );
  const receipts: PaymentReceipt[] = rcSnap.docs.map((d) => {
    const rc = d.data();
    return {
      id: d.id,
      subscriberId: String(rc.subscriberId ?? ''),
      meterNumber: String(rc.meterNumber ?? ''),
      subscriberName: String(rc.subscriberName ?? ''),
      readingId: String(rc.readingId ?? ''),
      amountPaidYer: Number(rc.amountPaidYer ?? 0),
      remainingBalanceYer: Number(rc.remainingBalanceYer ?? 0),
      collectorUid: String(rc.collectorUid ?? ''),
      collectorName: String(rc.collectorName ?? ''),
      paidAt:
        rc.paidAt instanceof Timestamp
          ? rc.paidAt.toDate().toISOString()
          : new Date().toISOString(),
      syncStatus: 'synced',
    };
  });

  const merged = mergeLocalPendingWithCloud(
    loadStationLocalState(params.stationId),
    {
      station,
      collectors,
      invites,
      subscribers,
      readings,
      receipts,
    },
  );
  saveStationLocalState(merged);
  return merged;
}

function mergeLocalPendingWithCloud(
  local: StationLocalState | null,
  cloud: StationLocalState,
): StationLocalState {
  if (!local || local.station.stationId !== cloud.station.stationId) {
    return cloud;
  }
  const pendingSubs = local.subscribers.filter((s) => s.syncStatus === 'pending');
  const subMap = new Map<string, Subscriber>();
  cloud.subscribers.forEach((s) => subMap.set(s.id, s));
  pendingSubs.forEach((s) => subMap.set(s.id, s));

  const pendingReadings = local.readings.filter((r) => r.syncStatus === 'pending');
  const rdIds = new Set(cloud.readings.map((r) => r.id));
  const mergedReadings = [
    ...pendingReadings.filter((r) => !rdIds.has(r.id)),
    ...cloud.readings,
  ];

  const pendingReceipts = local.receipts.filter((rc) => rc.syncStatus === 'pending');
  const rcIds = new Set(cloud.receipts.map((rc) => rc.id));
  const mergedReceipts = [
    ...pendingReceipts.filter((rc) => !rcIds.has(rc.id)),
    ...cloud.receipts,
  ];

  return {
    ...cloud,
    subscribers: Array.from(subMap.values()),
    readings: mergedReadings,
    receipts: mergedReceipts,
  };
}

// ============================================================
// Excel Import & Export
// ============================================================

export async function parseSubscribersExcelFile(
  file: File,
): Promise<Subscriber[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, {
    defval: '',
  });

  const ts = new Date().toISOString();
  const parsed: Subscriber[] = [];

  rows.forEach((row, index) => {
    const normalizeKey = (candidates: string[]): string => {
      for (const key of Object.keys(row)) {
        const lower = key.trim().toLowerCase();
        if (candidates.includes(lower)) {
          return String(row[key] ?? '').trim();
        }
      }
      return '';
    };

    const meterNumber = normalizeKey(['meter_number', 'رقم العداد']);
    const subscriberName = normalizeKey(['subscriber_name', 'اسم المشترك']);
    if (!meterNumber || !subscriberName) return;

    const phone = normalizeKey(['phone', 'رقم الهاتف', 'الهاتف']);
    const prevReading =
      Number(normalizeKey(['previous_reading', 'القراءة السابقة'])) || 0;
    const prevDebt =
      Number(normalizeKey(['previous_debt', 'المتأخرات'])) || 0;
    const zoneStreet =
      normalizeKey(['zone_street', 'الحارة/الشارع', 'الشارع', 'الحارة']) ||
      'شارع عام';
    const seqOrder =
      Number(normalizeKey(['sequence_order', 'ترتيب البيت', 'الترتيب'])) ||
      index + 1;

    parsed.push({
      id: sanitizeFirestoreId(`sub_${meterNumber}`),
      meterNumber,
      subscriberName,
      phone: phone || '770000000',
      previousReading: Math.max(0, prevReading),
      currentReading: Math.max(0, prevReading),
      previousDebtYer: Math.max(0, prevDebt),
      zoneStreet,
      sequenceOrder: Math.max(1, Math.round(seqOrder)),
      syncStatus: 'pending',
      updatedAt: ts,
    });
  });

  return parsed;
}

export function downloadExcelTemplate(): void {
  const sampleRows = [
    {
      meter_number: '50101',
      subscriber_name: 'اسم المشترك الكامل',
      phone: '771112233',
      previous_reading: 1200,
      previous_debt: 0,
      zone_street: 'اسم الحارة أو الشارع',
      sequence_order: 1,
    },
  ];
  const worksheet = XLSX.utils.json_to_sheet(sampleRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'subscribers');
  XLSX.writeFile(workbook, 'نموذج_استيراد_المشتركين.xlsx');
}

export function exportStationReportExcel(state: StationLocalState): void {
  const subscriberRows = state.subscribers.map((sub) => {
    const kwh = Math.max(0, sub.currentReading - sub.previousReading);
    return {
      'ترتيب البيت': sub.sequenceOrder,
      'رقم العداد': sub.meterNumber,
      'اسم المشترك': sub.subscriberName,
      'رقم الهاتف': sub.phone,
      'الحارة / الشارع': sub.zoneStreet,
      'القراءة السابقة': sub.previousReading,
      'القراءة الحالية': sub.currentReading,
      'الاستهلاك (ك.و.س)': kwh,
      'المتأخرات (ريال يمني)': sub.previousDebtYer,
      'حالة المزامنة': sub.syncStatus === 'synced' ? 'متزامن' : 'معلق',
    };
  });

  const receiptRows = state.receipts.map((r) => ({
    'رقم السند': r.id,
    'رقم العداد': r.meterNumber,
    'اسم المشترك': r.subscriberName,
    'المبلغ المدفوع (ريال يمني)': r.amountPaidYer,
    'الرصيد المتبقي (ريال يمني)': r.remainingBalanceYer,
    'المحصّل': r.collectorName,
    'التاريخ': new Date(r.paidAt).toLocaleString('ar-YE'),
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(subscriberRows),
    'كشف_المشتركين',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(receiptRows),
    'سندات_القبض',
  );
  XLSX.writeFile(
    wb,
    `تقرير_${state.station.stationName.replace(/\s+/g, '_')}.xlsx`,
  );
}

// ============================================================
// Sync Pending Offline Changes to Isolated Station in Firestore
// ============================================================

export async function syncStationPendingToFirestore(
  state: StationLocalState,
  user: User,
  role: 'manager' | 'collector',
): Promise<{
  updatedState: StationLocalState;
  syncedCount: number;
}> {
  const stationId = state.station.stationId;
  if (state.station.licenseStatus !== 'active') {
    throw new Error('ترخيص هذه المحطة موقوف من قِبل الإدارة العليا.');
  }

  let syncedCount = 0;

  if (role === 'manager') {
    try {
      await updateDoc(doc(db, 'stations', stationId), {
        stationName: state.station.stationName,
        kwhPriceYer: state.station.kwhPriceYer,
        minimumFeeYer: state.station.minimumFeeYer,
        mainGeneratorKwh: state.station.mainGeneratorKwh,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `stations/${stationId}`);
    }
  }

  const pendingSubs = state.subscribers.filter((s) => s.syncStatus === 'pending');
  if (pendingSubs.length > 0) {
    const chunkSize = 350;
    for (let i = 0; i < pendingSubs.length; i += chunkSize) {
      const chunk = pendingSubs.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const sub of chunk) {
        const subId = sanitizeFirestoreId(sub.id);
        const subRef = doc(db, 'stations', stationId, 'subscribers', subId);
        if (role === 'manager') {
          batch.set(
            subRef,
            {
              meterNumber: sub.meterNumber,
              subscriberName: sub.subscriberName,
              phone: sub.phone,
              previousReading: sub.previousReading,
              currentReading: sub.currentReading,
              previousDebtYer: sub.previousDebtYer,
              zoneStreet: sub.zoneStreet,
              sequenceOrder: sub.sequenceOrder,
              assignedCollectorId: sub.assignedCollectorId || '',
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        } else {
          batch.update(subRef, {
            previousReading: sub.previousReading,
            currentReading: sub.currentReading,
            previousDebtYer: sub.previousDebtYer,
            updatedAt: serverTimestamp(),
          });
        }
        syncedCount++;
      }
      try {
        await batch.commit();
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.WRITE,
          `stations/${stationId}/subscribers`,
        );
      }
    }
  }

  const pendingReadings = state.readings.filter((r) => r.syncStatus === 'pending');
  for (const reading of pendingReadings) {
    const rdId = sanitizeFirestoreId(reading.id);
    const subId = sanitizeFirestoreId(reading.subscriberId);
    const rdPath = `stations/${stationId}/readings/${rdId}`;
    try {
      await setDoc(doc(db, 'stations', stationId, 'readings', rdId), {
        subscriberId: subId,
        meterNumber: reading.meterNumber,
        subscriberName: reading.subscriberName,
        previousReading: reading.previousReading,
        currentReading: reading.currentReading,
        consumptionKwh: reading.consumptionKwh,
        kwhPriceYer: reading.kwhPriceYer,
        currentBillYer: reading.currentBillYer,
        previousDebtYer: reading.previousDebtYer,
        totalDueYer: reading.totalDueYer,
        photoUrl: reading.photoUrl.slice(0, 215000),
        photoSizeKb: Math.min(200, reading.photoSizeKb),
        collectorUid: sanitizeFirestoreId(user.uid),
        collectorName: reading.collectorName,
        recordedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      });

      const sub = state.subscribers.find((s) => s.id === reading.subscriberId);
      if (sub) {
        const portalHash = await computeSubscriberPortalHash(
          sub.meterNumber,
          sub.phone,
        );
        const lastReceipt = state.receipts.find(
          (rc) => rc.readingId === reading.id,
        );
        await setDoc(doc(db, 'subscriberPortals', portalHash), {
          stationId,
          stationName: state.station.stationName,
          meterNumber: sub.meterNumber,
          subscriberName: sub.subscriberName,
          zoneStreet: sub.zoneStreet,
          previousReading: reading.previousReading,
          currentReading: reading.currentReading,
          consumptionKwh: reading.consumptionKwh,
          currentBillYer: reading.currentBillYer,
          previousDebtYer: sub.previousDebtYer,
          totalDueYer: reading.totalDueYer,
          lastReadingPhotoUrl: reading.photoUrl.slice(0, 215000),
          lastPaymentYer: lastReceipt ? lastReceipt.amountPaidYer : 0,
          updatedAt: serverTimestamp(),
        });
      }
      syncedCount++;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, rdPath);
    }
  }

  const pendingReceipts = state.receipts.filter((rc) => rc.syncStatus === 'pending');
  for (const receipt of pendingReceipts) {
    const rcId = sanitizeFirestoreId(receipt.id);
    const rcPath = `stations/${stationId}/receipts/${rcId}`;
    try {
      await setDoc(doc(db, 'stations', stationId, 'receipts', rcId), {
        subscriberId: sanitizeFirestoreId(receipt.subscriberId),
        meterNumber: receipt.meterNumber,
        subscriberName: receipt.subscriberName,
        readingId: sanitizeFirestoreId(receipt.readingId),
        amountPaidYer: Math.max(1, receipt.amountPaidYer),
        remainingBalanceYer: Math.max(0, receipt.remainingBalanceYer),
        collectorUid: sanitizeFirestoreId(user.uid),
        collectorName: receipt.collectorName,
        paidAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      });
      syncedCount++;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, rcPath);
    }
  }

  const updatedState: StationLocalState = {
    ...state,
    subscribers: state.subscribers.map((s) => ({ ...s, syncStatus: 'synced' })),
    readings: state.readings.map((r) => ({ ...r, syncStatus: 'synced' })),
    receipts: state.receipts.map((rc) => ({ ...rc, syncStatus: 'synced' })),
  };
  saveStationLocalState(updatedState);

  return { updatedState, syncedCount };
}
