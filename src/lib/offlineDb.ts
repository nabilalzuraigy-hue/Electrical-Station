import * as XLSX from 'xlsx';
import { idbGet, idbSet } from './indexedDbCache';
import {
  loadAccessCodeFromFirestore,
  loadStaffVaultFromFirestore,
  loadStationCloudActivityFromFirestore,
  loadSubscriberPortalFromFirestore,
  resolveManagerAlertInFirestore,
  saveAccessCodeToFirestore,
  saveCollectorAlertTextToFirestore,
  saveCollectorLocationToFirestore,
  saveCollectorReadingTextToFirestore,
  saveCollectorReceiptTextToFirestore,
  type AdminStoreBackupPayload,
} from './firestoreBackup';
import {
  verifyDeveloperPasscodeStatic,
} from './devicePinAuth';
import {
  clearCloudVaultLocalCache,
  CLOUD_ADMIN_TOKEN,
  canUseCloudAdminFallback,
  cloudAdminCreateManualSubscriber,
  cloudAdminCreateStation,
  cloudAdminDeleteAccessCode,
  cloudAdminDeleteRecord,
  cloudAdminDeleteStation,
  cloudAdminDeleteSubscriber,
  cloudAdminFetchBackup,
  cloudAdminFetchStationDetails,
  cloudAdminFetchStationSubscribers,
  cloudAdminGenerateAccessCode,
  cloudAdminOverview,
  cloudAdminResetCodePin,
  cloudAdminRestoreBackup,
  cloudAdminToggleAccessCode,
  cloudAdminToggleAiVerification,
  cloudAdminToggleStationStatus,
  cloudAdminUploadSubscribersChunked,
  isCloudAdminToken,
} from './cloudAdminStore';
import { loadAdminStoreFromFirestore } from './firestoreBackup';
export { CLOUD_ADMIN_TOKEN, isCloudAdminToken };
import type {
  AccessCodeRecord,
  CollectorLocationRecord,
  CollectorPermissions,
  CollectorProfile,
  DieselExpenseEntry,
  ExpenseCategory,
  ManagerAlert,
  MeterReading,
  PaymentReceipt,
  StationConfig,
  Subscriber,
  SubscriberLookupResult,
  SyncProgress,
} from '../types/station';

const IDB_KEY_PREFIX = 'station_state_v3_';

export interface StationLocalState {
  station: StationConfig;
  collectors: CollectorProfile[];
  subscribers: Subscriber[];
  readings: MeterReading[];
  receipts: PaymentReceipt[];
  alerts?: ManagerAlert[];
  expenses?: DieselExpenseEntry[];
  collectorLocations?: CollectorLocationRecord[];
}

export function sanitizeFirestoreId(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean.slice(0, 120) || `id_${Date.now()}`;
}

export function normalizeActivationCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export async function loadStationLocalState(
  stationId: string,
): Promise<StationLocalState | null> {
  return idbGet<StationLocalState>(`${IDB_KEY_PREFIX}${stationId}`);
}

export async function saveStationLocalState(
  state: StationLocalState,
): Promise<void> {
  await idbSet(`${IDB_KEY_PREFIX}${state.station.stationId}`, state);
}

export class StaticHostingNoBackendError extends Error {
  constructor() {
    super('لا يوجد خادم API خلفي متاح على هذه الاستضافة الثابتة.');
    this.name = 'StaticHostingNoBackendError';
  }
}

async function apiRequest<T>(
  url: string,
  options: RequestInit = {},
  bearerToken?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new StaticHostingNoBackendError();
  }
  let data: T & { error?: string };
  try {
    data = (await res.json()) as T & { error?: string };
  } catch {
    throw new StaticHostingNoBackendError();
  }
  if (!res.ok) {
    throw new Error(data.error || `خطأ في الاتصال بالخادم (${res.status})`);
  }
  return data;
}

async function withCloudAdmin<T>(
  adminToken: string | null | undefined,
  cloudFn: () => Promise<T>,
  apiFn: () => Promise<T>,
): Promise<T> {
  if (isCloudAdminToken(adminToken)) {
    return cloudFn();
  }
  try {
    return await apiFn();
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError && canUseCloudAdminFallback()) {
      return cloudFn();
    }
    throw err;
  }
}

// ============================================================
// Developer Admin API (Server-verified scrypt / Cloud Firestore Admin)
// ============================================================

export async function getAdminStatus(): Promise<{ configured: boolean }> {
  try {
    return await apiRequest<{ configured: boolean }>('/api/admin/status');
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError) {
      return { configured: true };
    }
    throw err;
  }
}

export async function claimAdminPasscode(
  passcode: string,
): Promise<{ token: string; name: string }> {
  try {
    return await apiRequest<{ token: string; name: string }>('/api/admin/claim', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    });
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError) {
      const ok = await verifyDeveloperPasscodeStatic(passcode);
      if (ok) {
        return { token: CLOUD_ADMIN_TOKEN, name: 'الأدمن المطور' };
      }
      throw new Error('كلمة مرور المطور غير صحيحة.');
    }
    throw err;
  }
}

export async function loginAdminPasscode(
  passcode: string,
): Promise<{ token: string; name: string }> {
  try {
    return await apiRequest<{ token: string; name: string }>('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    });
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError) {
      const ok = await verifyDeveloperPasscodeStatic(passcode);
      if (ok) {
        return { token: CLOUD_ADMIN_TOKEN, name: 'الأدمن المطور' };
      }
      throw new Error('كلمة مرور المطور غير صحيحة.');
    }
    throw err;
  }
}

export async function loginAdminWithGoogle(
  idToken: string,
): Promise<{ token: string; name: string }> {
  try {
    return await apiRequest<{ token: string; name: string }>(
      '/api/admin/firebase-google',
      {
        method: 'POST',
        body: JSON.stringify({ idToken }),
      },
    );
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError) {
      return { token: CLOUD_ADMIN_TOKEN, name: 'نبيل الزريقي' };
    }
    throw err;
  }
}

export async function fetchAdminOverview(adminToken: string): Promise<{
  stations: StationConfig[];
  codes: AccessCodeRecord[];
}> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminOverview(false),
    () =>
      apiRequest<{
        stations: StationConfig[];
        codes: AccessCodeRecord[];
      }>('/api/admin/overview', {}, adminToken),
  );
}

export async function refreshOverviewFromFirestoreAdmin(
  adminToken: string,
): Promise<{
  stations: StationConfig[];
  codes: AccessCodeRecord[];
  subscriberCount: number;
  updatedAtIso: string | null;
}> {
  await clearCloudVaultLocalCache();

  if (isCloudAdminToken(adminToken)) {
    const overview = await cloudAdminOverview(true);
    const subscriberCount = overview.stations.reduce(
      (sum, st) => sum + (st.subscriberCount ?? 0),
      0,
    );
    return {
      stations: overview.stations,
      codes: overview.codes,
      subscriberCount,
      updatedAtIso: new Date().toISOString(),
    };
  }

  const snap = await loadAdminStoreFromFirestore(true);
  if (snap && (snap.stationCount > 0 || snap.codeCount > 0)) {
    await restoreAdminBackup(adminToken, snap.backup, 'merge');
  }
  const overview = await fetchAdminOverview(adminToken);
  const subscriberCount = overview.stations.reduce(
    (sum, st) => sum + (st.subscriberCount ?? 0),
    0,
  );
  return {
    stations: overview.stations,
    codes: overview.codes,
    subscriberCount,
    updatedAtIso: snap?.updatedAtIso ?? null,
  };
}

export async function createStationAdmin(
  adminToken: string,
  params: {
    stationName: string;
    kwhPriceYer?: number;
    maxCollectors?: number;
    maxSubscribers?: number;
  },
): Promise<{ station: StationConfig }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminCreateStation(params),
    () =>
      apiRequest<{ station: StationConfig }>(
        '/api/admin/stations',
        {
          method: 'POST',
          body: JSON.stringify(params),
        },
        adminToken,
      ),
  );
}

export async function toggleStationStatusAdmin(
  adminToken: string,
  stationId: string,
  licenseStatus: 'active' | 'suspended',
): Promise<{ station: StationConfig }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminToggleStationStatus(stationId, licenseStatus),
    () =>
      apiRequest<{ station: StationConfig }>(
        `/api/admin/stations/${encodeURIComponent(stationId)}/status`,
        {
          method: 'POST',
          body: JSON.stringify({ licenseStatus }),
        },
        adminToken,
      ),
  );
}

export async function toggleStationAiVerificationAdmin(
  adminToken: string,
  stationId: string,
  enabled: boolean,
): Promise<{ station: StationConfig }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminToggleAiVerification(stationId, enabled),
    () =>
      apiRequest<{ station: StationConfig }>(
        `/api/admin/stations/${encodeURIComponent(stationId)}/ai-verification`,
        {
          method: 'POST',
          body: JSON.stringify({ enabled }),
        },
        adminToken,
      ),
  );
}

export async function generateAccessCodeAdmin(
  adminToken: string,
  params: {
    name: string;
    role: 'manager' | 'collector';
    stationId?: string;
    newStationName?: string;
    phone?: string;
    assignedZones?: string[];
    permissions?: CollectorPermissions;
    customCode?: string;
  },
): Promise<{ codeRecord: AccessCodeRecord; station: StationConfig }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminGenerateAccessCode(params),
    async () => {
      const res = await apiRequest<{
        codeRecord: AccessCodeRecord;
        station: StationConfig;
      }>(
        '/api/admin/codes',
        {
          method: 'POST',
          body: JSON.stringify(params),
        },
        adminToken,
      );
      void saveAccessCodeToFirestore(res.codeRecord).catch(() => {});
      return res;
    },
  );
}

export async function toggleAccessCodeAdmin(
  adminToken: string,
  code: string,
  updates: {
    active?: boolean;
    permissions?: CollectorPermissions;
    assignedZones?: string[];
  },
): Promise<{ codeRecord: AccessCodeRecord }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminToggleAccessCode(code, updates),
    async () => {
      const res = await apiRequest<{ codeRecord: AccessCodeRecord }>(
        `/api/admin/codes/${encodeURIComponent(code)}/toggle`,
        {
          method: 'POST',
          body: JSON.stringify(updates),
        },
        adminToken,
      );
      void saveAccessCodeToFirestore(res.codeRecord).catch(() => {});
      return res;
    },
  );
}

export async function resetCodePinAdmin(
  adminToken: string,
  code: string,
): Promise<{ codeRecord: AccessCodeRecord }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminResetCodePin(code),
    async () => {
      const res = await apiRequest<{ codeRecord: AccessCodeRecord }>(
        `/api/admin/codes/${encodeURIComponent(code)}/reset-pin`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
        adminToken,
      );
      void saveAccessCodeToFirestore(res.codeRecord).catch(() => {});
      return res;
    },
  );
}

export async function deleteAccessCodeAdmin(
  adminToken: string,
  code: string,
): Promise<{ deleted: boolean; code: string }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminDeleteAccessCode(code),
    () =>
      apiRequest<{ deleted: boolean; code: string }>(
        `/api/admin/codes/${encodeURIComponent(code)}`,
        {
          method: 'DELETE',
        },
        adminToken,
      ),
  );
}

export async function uploadSubscribersChunkedAdmin(
  adminToken: string,
  params: {
    stationId: string;
    subscribers: Subscriber[];
    replaceAll?: boolean;
    onProgress?: (uploaded: number, total: number) => void;
  },
): Promise<{ totalSubscribers: number }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminUploadSubscribersChunked(params),
    async () => {
      const chunkSize = 400;
      let uploaded = 0;
      let totalSubscribers = 0;

      for (let i = 0; i < params.subscribers.length; i += chunkSize) {
        const chunk = params.subscribers.slice(i, i + chunkSize);
        const res = await apiRequest<{
          importedCount: number;
          totalSubscribers: number;
        }>(
          `/api/admin/stations/${encodeURIComponent(params.stationId)}/subscribers/upload-chunk`,
          {
            method: 'POST',
            body: JSON.stringify({
              subscribers: chunk,
              replaceAll: Boolean(params.replaceAll && i === 0),
            }),
          },
          adminToken,
        );
        uploaded += chunk.length;
        totalSubscribers = res.totalSubscribers;
        params.onProgress?.(uploaded, params.subscribers.length);
      }

      return { totalSubscribers };
    },
  );
}

export async function fetchStationSubscribersAdmin(
  adminToken: string,
  stationId: string,
): Promise<Subscriber[]> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminFetchStationSubscribers(stationId),
    async () => {
      const res = await apiRequest<{ subscribers: Array<Omit<Subscriber, 'syncStatus'>> }>(
        `/api/admin/stations/${encodeURIComponent(stationId)}/subscribers`,
        {},
        adminToken,
      );
      return (res.subscribers ?? []).map((s) => ({
        ...s,
        syncStatus: 'synced' as const,
      }));
    },
  );
}

export async function createManualSubscriberAdmin(
  adminToken: string,
  params: {
    stationId: string;
    subscriberName: string;
    meterNumber: string;
    phone: string;
    previousReading: number;
    previousDebtYer: number;
    last3MonthsAvgKwh?: number;
    zoneStreet: string;
    sequenceOrder?: number;
  },
): Promise<{ subscriber: Subscriber; totalSubscribers: number }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminCreateManualSubscriber(params),
    async () => {
      const res = await apiRequest<{
        subscriber: Omit<Subscriber, 'syncStatus'>;
        totalSubscribers: number;
      }>(
        `/api/admin/stations/${encodeURIComponent(params.stationId)}/subscribers`,
        {
          method: 'POST',
          body: JSON.stringify(params),
        },
        adminToken,
      );
      return {
        subscriber: { ...res.subscriber, syncStatus: 'synced' },
        totalSubscribers: res.totalSubscribers,
      };
    },
  );
}

export async function deleteSubscriberAdmin(
  adminToken: string,
  stationId: string,
  subscriberId: string,
): Promise<{ deleted: boolean; totalSubscribers: number }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminDeleteSubscriber(stationId, subscriberId),
    () =>
      apiRequest<{ deleted: boolean; totalSubscribers: number }>(
        `/api/admin/stations/${encodeURIComponent(stationId)}/subscribers/${encodeURIComponent(subscriberId)}`,
        {
          method: 'DELETE',
        },
        adminToken,
      ),
  );
}

export async function fetchAdminBackup(adminToken: string): Promise<{
  stations: Record<string, StationConfig>;
  codes: Record<string, AccessCodeRecord>;
  stationData: Record<string, unknown>;
  exportedAt: string;
}> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminFetchBackup(),
    () =>
      apiRequest<{
        stations: Record<string, StationConfig>;
        codes: Record<string, AccessCodeRecord>;
        stationData: Record<string, unknown>;
        exportedAt: string;
      }>('/api/admin/backup', {}, adminToken),
  );
}

export async function restoreAdminBackup(
  adminToken: string,
  backup: {
    stations: Record<string, StationConfig>;
    codes: Record<string, AccessCodeRecord>;
    stationData: Record<string, unknown>;
  },
  mode: 'merge' | 'replace' = 'merge',
): Promise<{
  ok: boolean;
  stationCount: number;
  codeCount: number;
  subscriberCount: number;
}> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminRestoreBackup(backup as AdminStoreBackupPayload, mode),
    () =>
      apiRequest<{
        ok: boolean;
        stationCount: number;
        codeCount: number;
        subscriberCount: number;
      }>(
        '/api/admin/restore',
        {
          method: 'POST',
          body: JSON.stringify({ ...backup, mode }),
        },
        adminToken,
      ),
  );
}

export async function fetchCloudAutoBackup(params: {
  adminToken?: string | null;
  firebaseIdToken?: string | null;
}): Promise<
  AdminStoreBackupPayload & {
    counts: { stationCount: number; codeCount: number; subscriberCount: number };
    hasData: boolean;
  }
> {
  const headers: Record<string, string> = {};
  if (params.firebaseIdToken) {
    headers['X-Firebase-Id-Token'] = params.firebaseIdToken;
  }
  return apiRequest<
    AdminStoreBackupPayload & {
      counts: { stationCount: number; codeCount: number; subscriberCount: number };
      hasData: boolean;
    }
  >('/api/admin/cloud-auto-backup', { headers }, params.adminToken);
}

export async function restoreCloudAutoBackup(params: {
  adminToken?: string | null;
  firebaseIdToken?: string | null;
  backup: AdminStoreBackupPayload;
  mode?: 'merge' | 'replace';
}): Promise<{
  ok: boolean;
  stationCount: number;
  codeCount: number;
  subscriberCount: number;
}> {
  const headers: Record<string, string> = {};
  if (params.firebaseIdToken) {
    headers['X-Firebase-Id-Token'] = params.firebaseIdToken;
  }
  return apiRequest<{
    ok: boolean;
    stationCount: number;
    codeCount: number;
    subscriberCount: number;
  }>(
    '/api/admin/cloud-auto-restore',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...params.backup, mode: params.mode ?? 'merge' }),
    },
    params.adminToken,
  );
}

export async function fetchStationDetailsAdmin(
  adminToken: string,
  stationId: string,
): Promise<{
  station: StationConfig;
  readings: MeterReading[];
  receipts: PaymentReceipt[];
  expenses: DieselExpenseEntry[];
  alerts: ManagerAlert[];
}> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminFetchStationDetails(stationId),
    () =>
      apiRequest<{
        station: StationConfig;
        readings: MeterReading[];
        receipts: PaymentReceipt[];
        expenses: DieselExpenseEntry[];
        alerts: ManagerAlert[];
      }>(`/api/admin/stations/${encodeURIComponent(stationId)}/details`, {}, adminToken),
  );
}

export async function deleteStationAdmin(
  adminToken: string,
  stationId: string,
): Promise<{ deleted: boolean; stationId: string }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminDeleteStation(stationId),
    () =>
      apiRequest<{ deleted: boolean; stationId: string }>(
        `/api/admin/stations/${encodeURIComponent(stationId)}`,
        { method: 'DELETE' },
        adminToken,
      ),
  );
}

export async function deleteReadingAdmin(
  adminToken: string,
  stationId: string,
  readingId: string,
): Promise<{ deleted: boolean; id: string }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminDeleteRecord(stationId, 'readings', readingId),
    () =>
      apiRequest<{ deleted: boolean; id: string }>(
        `/api/admin/stations/${encodeURIComponent(stationId)}/readings/${encodeURIComponent(readingId)}`,
        { method: 'DELETE' },
        adminToken,
      ),
  );
}

export async function deleteReceiptAdmin(
  adminToken: string,
  stationId: string,
  receiptId: string,
): Promise<{ deleted: boolean; id: string }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminDeleteRecord(stationId, 'receipts', receiptId),
    () =>
      apiRequest<{ deleted: boolean; id: string }>(
        `/api/admin/stations/${encodeURIComponent(stationId)}/receipts/${encodeURIComponent(receiptId)}`,
        { method: 'DELETE' },
        adminToken,
      ),
  );
}

export async function deleteExpenseAdmin(
  adminToken: string,
  stationId: string,
  expenseId: string,
): Promise<{ deleted: boolean; id: string }> {
  return withCloudAdmin(
    adminToken,
    () => cloudAdminDeleteRecord(stationId, 'expenses', expenseId),
    () =>
      apiRequest<{ deleted: boolean; id: string }>(
        `/api/admin/stations/${encodeURIComponent(stationId)}/expenses/${encodeURIComponent(expenseId)}`,
        { method: 'DELETE' },
        adminToken,
      ),
  );
}

// ============================================================
// Public Code Entry & Staff Session Operations
// ============================================================

function mapServerState(raw: {
  station: StationConfig;
  collectors?: AccessCodeRecord[];
  subscribers?: Subscriber[];
  readings?: MeterReading[];
  receipts?: PaymentReceipt[];
  alerts?: ManagerAlert[];
  expenses?: DieselExpenseEntry[];
  collectorLocations?: CollectorLocationRecord[];
}): StationLocalState {
  const collectors: CollectorProfile[] = (raw.collectors ?? []).map((c) => ({
    id: c.code,
    code: c.code,
    name: c.name,
    email: '',
    phone: c.phone,
    assignedZones: c.assignedZones ?? [],
    permissions: c.permissions,
    active: c.active,
    inviteCode: c.code,
    createdAt: c.createdAt,
  }));

  return {
    station: raw.station,
    collectors,
    subscribers: (raw.subscribers ?? []).map((s) => ({
      ...s,
      syncStatus: 'synced',
    })),
    readings: (raw.readings ?? []).map((r) => ({
      ...r,
      syncStatus: 'synced',
    })),
    receipts: (raw.receipts ?? []).map((rc) => ({
      ...rc,
      syncStatus: 'synced',
    })),
    alerts: (raw.alerts ?? []).map((al) => ({
      ...al,
      syncStatus: 'synced',
    })),
    expenses: raw.expenses ?? [],
    collectorLocations: raw.collectorLocations ?? [],
  };
}

function mergeCloudActivityIntoState(
  state: StationLocalState,
  activity: {
    readings: MeterReading[];
    receipts: PaymentReceipt[];
    alerts: ManagerAlert[];
    collectorLocations: CollectorLocationRecord[];
  },
): StationLocalState {
  const rdMap = new Map<string, MeterReading>();
  activity.readings.forEach((r) => rdMap.set(r.id, { ...r, syncStatus: 'synced' }));
  state.readings.forEach((r) => {
    const existing = rdMap.get(r.id);
    if (!existing) {
      rdMap.set(r.id, r);
    } else {
      rdMap.set(r.id, {
        ...existing,
        ...r,
        photoUrl: r.photoUrl || existing.photoUrl || '',
        hasLocalPhoto: Boolean(r.photoUrl || r.hasLocalPhoto || existing.hasLocalPhoto),
        syncStatus: r.syncStatus === 'pending' ? 'pending' : 'synced',
      });
    }
  });
  const readings = Array.from(rdMap.values()).sort((a, b) =>
    String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? '')),
  );

  const rcMap = new Map<string, PaymentReceipt>();
  activity.receipts.forEach((rc) => rcMap.set(rc.id, { ...rc, syncStatus: 'synced' }));
  state.receipts.forEach((rc) => {
    const existing = rcMap.get(rc.id);
    if (!existing || rc.syncStatus === 'pending') {
      rcMap.set(rc.id, rc);
    }
  });
  const receipts = Array.from(rcMap.values()).sort((a, b) =>
    String(b.paidAt ?? '').localeCompare(String(a.paidAt ?? '')),
  );

  const alMap = new Map<string, ManagerAlert>();
  activity.alerts.forEach((al) => alMap.set(al.id, { ...al, syncStatus: 'synced' }));
  (state.alerts ?? []).forEach((al) => {
    const existing = alMap.get(al.id);
    if (!existing || al.syncStatus === 'pending') {
      alMap.set(al.id, al);
    } else if (existing.status === 'pending' && al.status !== 'pending') {
      alMap.set(al.id, al);
    }
  });
  const alerts = Array.from(alMap.values()).sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  );

  const locMap = new Map<string, CollectorLocationRecord>();
  (state.collectorLocations ?? []).forEach((l) => locMap.set(l.collectorCode, l));
  activity.collectorLocations.forEach((l) => {
    const cur = locMap.get(l.collectorCode);
    if (!cur || String(l.updatedAt).localeCompare(String(cur.updatedAt)) >= 0) {
      locMap.set(l.collectorCode, l);
    }
  });
  const collectorLocations = Array.from(locMap.values()).sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
  );

  // Reconcile subscriber balances & readings from newer synced cloud readings/receipts
  const latestReadingBySubId = new Map<string, MeterReading>();
  const latestReadingByMeter = new Map<string, MeterReading>();
  for (const r of readings) {
    if (r.approvalStatus === 'rejected' || r.approvalStatus === 'pending_manager') continue;
    if (r.subscriberId && !latestReadingBySubId.has(r.subscriberId)) {
      latestReadingBySubId.set(r.subscriberId, r);
    }
    if (r.meterNumber && !latestReadingByMeter.has(r.meterNumber)) {
      latestReadingByMeter.set(r.meterNumber, r);
    }
  }

  const latestReceiptBySubId = new Map<string, PaymentReceipt>();
  const latestReceiptByMeter = new Map<string, PaymentReceipt>();
  for (const rc of receipts) {
    if (rc.subscriberId && !latestReceiptBySubId.has(rc.subscriberId)) {
      latestReceiptBySubId.set(rc.subscriberId, rc);
    }
    if (rc.meterNumber && !latestReceiptByMeter.has(rc.meterNumber)) {
      latestReceiptByMeter.set(rc.meterNumber, rc);
    }
  }

  const subscribers = state.subscribers.map((sub) => {
    if (sub.syncStatus === 'pending') return sub;
    const latestRd =
      latestReadingBySubId.get(sub.id) ?? latestReadingByMeter.get(sub.meterNumber);
    const latestRc =
      latestReceiptBySubId.get(sub.id) ?? latestReceiptByMeter.get(sub.meterNumber);

    const subTs = String(sub.updatedAt ?? '');
    const rdTs = latestRd ? String(latestRd.recordedAt ?? '') : '';
    const rcTs = latestRc ? String(latestRc.paidAt ?? '') : '';

    let nextPrev = sub.previousReading;
    let nextCurr = sub.currentReading;
    let nextDebt = sub.previousDebtYer;
    let nextUpdatedAt = subTs;

    if (latestRd && rdTs > subTs) {
      nextPrev = latestRd.previousReading;
      nextCurr = latestRd.currentReading;
      nextDebt = latestRd.totalDueYer;
      nextUpdatedAt = rdTs;
    }

    if (latestRc && rcTs >= nextUpdatedAt && rcTs > subTs) {
      nextDebt = latestRc.remainingBalanceYer;
      nextUpdatedAt = rcTs;
    }

    if (nextUpdatedAt !== subTs) {
      return {
        ...sub,
        previousReading: nextPrev,
        currentReading: nextCurr,
        previousDebtYer: nextDebt,
        updatedAt: nextUpdatedAt,
      };
    }
    return sub;
  });

  return {
    ...state,
    subscribers,
    readings,
    receipts,
    alerts,
    collectorLocations,
  };
}

function mergeLocalPendingWithCloud(
  local: StationLocalState | null,
  cloud: StationLocalState,
): StationLocalState {
  if (!local || local.station.stationId !== cloud.station.stationId) {
    return cloud;
  }
  const subMap = new Map<string, Subscriber>();
  // Guard: never wipe cached subscribers if cloud returned an empty list unexpectedly
  if (cloud.subscribers.length === 0 && local.subscribers.length > 0) {
    local.subscribers.forEach((s) => subMap.set(s.id, s));
  } else {
    cloud.subscribers.forEach((s) => subMap.set(s.id, s));
    local.subscribers.forEach((s) => {
      if (s.syncStatus === 'pending' || (s.importedLocally && !subMap.has(s.id))) {
        subMap.set(s.id, s);
      }
    });
  }

  // Preserve meter photos stored locally in the collector's phone IndexedDB memory
  const localPhotoByReadingId = new Map<string, string>();
  local.readings.forEach((r) => {
    if (r.photoUrl) localPhotoByReadingId.set(r.id, r.photoUrl);
  });
  const localPhotoByAlertId = new Map<string, string>();
  (local.alerts ?? []).forEach((al) => {
    if (al.photoUrl) localPhotoByAlertId.set(al.id, al.photoUrl);
  });

  const pendingReadings = local.readings.filter((r) => r.syncStatus === 'pending');
  const rdIds = new Set(cloud.readings.map((r) => r.id));
  const mergedCloudReadings = cloud.readings.map((r) => {
    const localPhoto = localPhotoByReadingId.get(r.id);
    return localPhoto
      ? { ...r, photoUrl: localPhoto, hasLocalPhoto: true }
      : r;
  });
  const mergedReadings = [
    ...pendingReadings.filter((r) => !rdIds.has(r.id)),
    ...mergedCloudReadings,
  ];

  const pendingReceipts = local.receipts.filter((rc) => rc.syncStatus === 'pending');
  const rcIds = new Set(cloud.receipts.map((rc) => rc.id));
  const mergedReceipts = [
    ...pendingReceipts.filter((rc) => !rcIds.has(rc.id)),
    ...cloud.receipts,
  ];

  const pendingAlerts = (local.alerts ?? []).filter(
    (al) => al.syncStatus === 'pending',
  );
  const alIds = new Set((cloud.alerts ?? []).map((al) => al.id));
  const mergedCloudAlerts = (cloud.alerts ?? []).map((al) => {
    const localPhoto = localPhotoByAlertId.get(al.id);
    return localPhoto ? { ...al, photoUrl: localPhoto } : al;
  });
  const mergedAlerts = [
    ...pendingAlerts.filter((al) => !alIds.has(al.id)),
    ...mergedCloudAlerts,
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    ...cloud,
    subscribers: Array.from(subMap.values()),
    readings: mergedReadings,
    receipts: mergedReceipts,
    alerts: mergedAlerts,
  };
}

export type UnifiedLoginResult =
  | { kind: 'admin'; token: string; name: string }
  | {
      kind: 'staff';
      token: string;
      access: AccessCodeRecord;
      state: StationLocalState;
    }
  | { kind: 'subscriber'; result: SubscriberLookupResult };

export async function loginUnified(
  input: string | { username: string; password: string },
): Promise<UnifiedLoginResult> {
  const payload =
    typeof input === 'string'
      ? { credential: input.trim() }
      : {
          username: input.username.trim(),
          password: input.password.trim(),
          credential: input.password.trim() || input.username.trim(),
        };

  if (!payload.credential && !('username' in payload && payload.username)) {
    throw new Error('يرجى إدخال اسم المستخدم أو كلمة المرور.');
  }

  try {
    const res = await apiRequest<
      | { kind: 'admin'; token: string; name: string }
      | {
          kind: 'staff';
          token: string;
          access: AccessCodeRecord;
          state: {
            station: StationConfig;
            collectors?: AccessCodeRecord[];
            subscribers?: Subscriber[];
            readings?: MeterReading[];
            receipts?: PaymentReceipt[];
            alerts?: ManagerAlert[];
            expenses?: DieselExpenseEntry[];
            collectorLocations?: CollectorLocationRecord[];
          };
        }
      | { kind: 'subscriber'; result: SubscriberLookupResult }
    >('/api/auth/unified', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (res.kind === 'staff') {
      const cloudState = mapServerState(res.state);
      const local = await loadStationLocalState(cloudState.station.stationId);
      const merged = mergeLocalPendingWithCloud(local, cloudState);
      await saveStationLocalState(merged);
      return {
        kind: 'staff',
        token: res.token,
        access: res.access,
        state: merged,
      };
    }

    return res;
  } catch (primaryErr) {
    // Cloud Firestore SDK fallback (supports multi-device restore & static Firebase Hosting)
    const candidates = Array.from(
      new Set(
        [
          'password' in payload ? payload.password : '',
          payload.credential ?? '',
          'username' in payload ? payload.username : '',
        ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0),
      ),
    );

    for (const cand of candidates) {
      const codeCand = normalizeActivationCode(cand);
      if (codeCand.length < 4) continue;
      const staffVault = await loadStaffVaultFromFirestore(codeCand);
      if (staffVault) {
        if (!staffVault.access.active) {
          throw new Error('هذا الكود موقوف حالياً من الإدارة.');
        }
        if (staffVault.station.licenseStatus !== 'active') {
          throw new Error('تم إيقاف ترخيص هذه المحطة من قِبل الإدارة.');
        }
        let cloudState = mapServerState({
          station: staffVault.station,
          collectors: staffVault.collectors,
          subscribers: staffVault.subscribers,
          readings: staffVault.readings,
          receipts: staffVault.receipts,
          alerts: staffVault.alerts,
          expenses: staffVault.expenses,
          collectorLocations: staffVault.collectorLocations,
        });
        const activity = await loadStationCloudActivityFromFirestore(
          cloudState.station.stationId,
        ).catch(() => null);
        if (activity) {
          cloudState = mergeCloudActivityIntoState(cloudState, activity);
        }
        const local = await loadStationLocalState(cloudState.station.stationId);
        const merged = mergeLocalPendingWithCloud(local, cloudState);
        await saveStationLocalState(merged);
        return {
          kind: 'staff',
          token: `cloud_${codeCand}`,
          access: staffVault.access,
          state: merged,
        };
      }
    }

    if ('username' in payload && payload.username && payload.password) {
      const portalRes = await loadSubscriberPortalFromFirestore(
        payload.username,
        payload.password,
      );
      if (portalRes) {
        return { kind: 'subscriber', result: portalRes };
      }
    }

    if (primaryErr instanceof StaticHostingNoBackendError) {
      throw new Error('كود التفعيل غير صحيح أو موقوف حالياً.');
    }

    throw primaryErr;
  }
}

export async function loginWithAccessCode(codeInput: string): Promise<{
  token: string;
  access: AccessCodeRecord;
  state: StationLocalState;
}> {
  const code = normalizeActivationCode(codeInput);
  if (!code || code.length < 4) {
    throw new Error('يرجى إدخال كود التفعيل الصحيح.');
  }

  // Always check Firestore `codes/{code}` first when online so `active` & `pinResetAt` are authoritative
  const cloudCodeDoc =
    typeof navigator === 'undefined' || navigator.onLine !== false
      ? await loadAccessCodeFromFirestore(code, true)
      : null;

  if (cloudCodeDoc && !cloudCodeDoc.active) {
    throw new Error('تم إلغاء تفعيل هذا الكود من الإدارة.');
  }

  try {
    const res = await apiRequest<{
      token: string;
      access: AccessCodeRecord;
      state: {
        station: StationConfig;
        collectors?: AccessCodeRecord[];
        subscribers?: Subscriber[];
        readings?: MeterReading[];
        receipts?: PaymentReceipt[];
        alerts?: ManagerAlert[];
        expenses?: DieselExpenseEntry[];
        collectorLocations?: CollectorLocationRecord[];
      };
    }>('/api/auth/code', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    const mergedAccess: AccessCodeRecord = cloudCodeDoc
      ? {
          ...res.access,
          active: cloudCodeDoc.active,
          pinResetAt: cloudCodeDoc.pinResetAt ?? res.access.pinResetAt ?? null,
        }
      : res.access;

    if (!mergedAccess.active) {
      throw new Error('تم إلغاء تفعيل هذا الكود من الإدارة.');
    }

    let cloudState = mapServerState(res.state);
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      const activity = await loadStationCloudActivityFromFirestore(
        cloudState.station.stationId,
      ).catch(() => null);
      if (activity) {
        cloudState = mergeCloudActivityIntoState(cloudState, activity);
      }
    }
    const local = await loadStationLocalState(cloudState.station.stationId);
    const merged = mergeLocalPendingWithCloud(local, cloudState);
    await saveStationLocalState(merged);

    return {
      token: res.token,
      access: mergedAccess,
      state: merged,
    };
  } catch (err) {
    const staffVault = await loadStaffVaultFromFirestore(code);
    if (staffVault) {
      const effectiveActive = cloudCodeDoc ? cloudCodeDoc.active : staffVault.access.active;
      if (!effectiveActive) {
        throw new Error('تم إلغاء تفعيل هذا الكود من الإدارة.');
      }
      if (staffVault.station.licenseStatus !== 'active') {
        throw new Error('تم إيقاف ترخيص هذه المحطة من قِبل الإدارة.');
      }
      let cloudState = mapServerState({
        station: staffVault.station,
        collectors: staffVault.collectors,
        subscribers: staffVault.subscribers,
        readings: staffVault.readings,
        receipts: staffVault.receipts,
        alerts: staffVault.alerts,
        expenses: staffVault.expenses,
        collectorLocations: staffVault.collectorLocations,
      });
      const activity = await loadStationCloudActivityFromFirestore(
        cloudState.station.stationId,
      ).catch(() => null);
      if (activity) {
        cloudState = mergeCloudActivityIntoState(cloudState, activity);
      }
      const local = await loadStationLocalState(cloudState.station.stationId);
      const merged = mergeLocalPendingWithCloud(local, cloudState);
      await saveStationLocalState(merged);
      return {
        token: `cloud_${code}`,
        access: {
          ...staffVault.access,
          active: effectiveActive,
          pinResetAt: cloudCodeDoc?.pinResetAt ?? staffVault.access.pinResetAt ?? null,
        },
        state: merged,
      };
    }
    if (err instanceof StaticHostingNoBackendError) {
      throw new Error('كود التفعيل غير صحيح أو غير محفوظ بعد في السحابة.');
    }
    throw err;
  }
}

export async function checkBoundCodeStatus(
  boundCode: string,
  localBoundAt: string,
): Promise<
  | { status: 'offline' }
  | { status: 'deactivated' }
  | { status: 'pin_reset'; access: AccessCodeRecord }
  | { status: 'ok'; token: string; access: AccessCodeRecord; state: StationLocalState }
> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'offline' };
  }

  const code = normalizeActivationCode(boundCode);
  try {
    const cloudCodeDoc = await loadAccessCodeFromFirestore(code, true);
    if (cloudCodeDoc) {
      if (!cloudCodeDoc.active) {
        return { status: 'deactivated' };
      }
      if (
        cloudCodeDoc.pinResetAt &&
        new Date(cloudCodeDoc.pinResetAt).getTime() >
          new Date(localBoundAt).getTime()
      ) {
        return { status: 'pin_reset', access: cloudCodeDoc };
      }
    }

    const res = await loginWithAccessCode(code);
    if (!res.access.active) {
      return { status: 'deactivated' };
    }
    if (
      res.access.pinResetAt &&
      new Date(res.access.pinResetAt).getTime() >
        new Date(localBoundAt).getTime()
    ) {
      return { status: 'pin_reset', access: res.access };
    }
    return { status: 'ok', token: res.token, access: res.access, state: res.state };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('إلغاء تفعيل') || msg.includes('موقوف')) {
      return { status: 'deactivated' };
    }
    return { status: 'offline' };
  }
}

export async function refreshStationState(
  stationId: string,
  staffToken: string,
): Promise<StationLocalState> {
  const local = await loadStationLocalState(stationId);

  if (staffToken.startsWith('cloud_')) {
    const code = normalizeActivationCode(staffToken.slice('cloud_'.length));
    const [staffVault, activity] = await Promise.all([
      code ? loadStaffVaultFromFirestore(code) : Promise.resolve(null),
      loadStationCloudActivityFromFirestore(stationId).catch(() => null),
    ]);

    if (staffVault) {
      let cloudState = mapServerState({
        station: staffVault.station,
        collectors: staffVault.collectors,
        subscribers: staffVault.subscribers,
        readings: staffVault.readings,
        receipts: staffVault.receipts,
        alerts: staffVault.alerts,
        expenses: staffVault.expenses,
        collectorLocations: staffVault.collectorLocations,
      });
      if (activity) {
        cloudState = mergeCloudActivityIntoState(cloudState, activity);
      }
      const freshestLocal = (await loadStationLocalState(stationId)) ?? local;
      const merged = mergeLocalPendingWithCloud(freshestLocal, cloudState);
      await saveStationLocalState(merged);
      return merged;
    }

    const freshestLocal = (await loadStationLocalState(stationId)) ?? local;
    if (freshestLocal) {
      const mergedLocal = activity
        ? mergeCloudActivityIntoState(freshestLocal, activity)
        : freshestLocal;
      await saveStationLocalState(mergedLocal);
      return mergedLocal;
    }
    throw new StaticHostingNoBackendError();
  }

  try {
    const [res, activity] = await Promise.all([
      apiRequest<{
        station: StationConfig;
        collectors?: AccessCodeRecord[];
        subscribers?: Subscriber[];
        readings?: MeterReading[];
        receipts?: PaymentReceipt[];
        alerts?: ManagerAlert[];
        expenses?: DieselExpenseEntry[];
        collectorLocations?: CollectorLocationRecord[];
      }>(`/api/stations/${encodeURIComponent(stationId)}/state`, {}, staffToken),
      loadStationCloudActivityFromFirestore(stationId).catch(() => null),
    ]);

    let cloudState = mapServerState(res);
    if (activity) {
      cloudState = mergeCloudActivityIntoState(cloudState, activity);
    }
    const freshestLocal = (await loadStationLocalState(stationId)) ?? local;
    const merged = mergeLocalPendingWithCloud(freshestLocal, cloudState);
    await saveStationLocalState(merged);
    return merged;
  } catch (err) {
    const freshestLocal = (await loadStationLocalState(stationId)) ?? local;
    if (err instanceof StaticHostingNoBackendError && freshestLocal) {
      const activity = await loadStationCloudActivityFromFirestore(stationId).catch(
        () => null,
      );
      const mergedLocal = activity
        ? mergeCloudActivityIntoState(freshestLocal, activity)
        : freshestLocal;
      await saveStationLocalState(mergedLocal);
      return mergedLocal;
    }
    throw err;
  }
}

export async function saveStationTariffInCloud(
  staffToken: string,
  station: StationConfig,
): Promise<void> {
  if (!staffToken || staffToken.startsWith('cloud_')) return;
  try {
    await apiRequest(
      `/api/stations/${encodeURIComponent(station.stationId)}/config`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          stationName: station.stationName,
          kwhPriceYer: station.kwhPriceYer,
          minimumFeeYer: station.minimumFeeYer,
          mainGeneratorKwh: station.mainGeneratorKwh,
          ...(station.zoneGeneratorKwh
            ? { zoneGeneratorKwh: station.zoneGeneratorKwh }
            : {}),
        }),
      },
      staffToken,
    );
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError) return;
    throw err;
  }
}

export async function addDieselExpenseInCloud(params: {
  staffToken: string;
  stationId: string;
  date: string;
  category: ExpenseCategory;
  liters?: number;
  pricePerLiterYer?: number;
  amountYer: number;
  note: string;
}): Promise<DieselExpenseEntry> {
  const res = await apiRequest<{ expense: DieselExpenseEntry }>(
    `/api/stations/${encodeURIComponent(params.stationId)}/expenses`,
    {
      method: 'POST',
      body: JSON.stringify({
        date: params.date,
        category: params.category,
        ...(typeof params.liters === 'number' ? { liters: params.liters } : {}),
        ...(typeof params.pricePerLiterYer === 'number'
          ? { pricePerLiterYer: params.pricePerLiterYer }
          : {}),
        amountYer: params.amountYer,
        note: params.note,
      }),
    },
    params.staffToken,
  );
  return res.expense;
}

export async function sendCollectorLocationInCloud(params: {
  staffToken: string;
  stationId: string;
  collectorCode?: string;
  collectorName: string;
  lat: number;
  lng: number;
  accuracy?: number;
  lastSubscriberName?: string;
  lastMeterNumber?: string;
  zoneStreet?: string;
}): Promise<CollectorLocationRecord> {
  const fallbackLoc: CollectorLocationRecord = {
    collectorCode: params.collectorCode || 'collector',
    collectorName: params.collectorName,
    lat: params.lat,
    lng: params.lng,
    ...(typeof params.accuracy === 'number' ? { accuracy: params.accuracy } : {}),
    ...(params.lastSubscriberName ? { lastSubscriberName: params.lastSubscriberName } : {}),
    ...(params.lastMeterNumber ? { lastMeterNumber: params.lastMeterNumber } : {}),
    ...(params.zoneStreet ? { zoneStreet: params.zoneStreet } : {}),
    updatedAt: new Date().toISOString(),
  };

  if (params.staffToken.startsWith('cloud_')) {
    if (params.collectorCode) {
      await saveCollectorLocationToFirestore({
        stationId: params.stationId,
        collectorCode: params.collectorCode,
        collectorName: params.collectorName,
        lat: params.lat,
        lng: params.lng,
        accuracy: params.accuracy,
      });
    }
    return fallbackLoc;
  }

  try {
    const res = await apiRequest<{ location: CollectorLocationRecord }>(
      `/api/stations/${encodeURIComponent(params.stationId)}/collector-location`,
      {
        method: 'POST',
        body: JSON.stringify({
          collectorCode: params.collectorCode,
          collectorName: params.collectorName,
          lat: params.lat,
          lng: params.lng,
          accuracy: params.accuracy,
          lastSubscriberName: params.lastSubscriberName,
          lastMeterNumber: params.lastMeterNumber,
          zoneStreet: params.zoneStreet,
        }),
      },
      params.staffToken,
    );
    if (params.collectorCode) {
      void saveCollectorLocationToFirestore({
        stationId: params.stationId,
        collectorCode: params.collectorCode,
        collectorName: params.collectorName,
        lat: params.lat,
        lng: params.lng,
        accuracy: params.accuracy,
      });
    }
    return res.location;
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError) {
      if (params.collectorCode) {
        await saveCollectorLocationToFirestore({
          stationId: params.stationId,
          collectorCode: params.collectorCode,
          collectorName: params.collectorName,
          lat: params.lat,
          lng: params.lng,
          accuracy: params.accuracy,
        });
      }
      return fallbackLoc;
    }
    throw err;
  }
}

export async function updateCollectorInCloud(params: {
  staffToken: string;
  stationId: string;
  collector: CollectorProfile;
}): Promise<void> {
  const code = params.collector.code || params.collector.id;
  await apiRequest(
    `/api/stations/${encodeURIComponent(params.stationId)}/collectors/${encodeURIComponent(code)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        active: params.collector.active,
        permissions: params.collector.permissions,
      }),
    },
    params.staffToken,
  );
}

export function computeSubscriber3MonthAvgKwh(
  subscriber: Subscriber,
  readings: MeterReading[],
): number {
  const recent = readings
    .filter(
      (r) =>
        r.subscriberId === subscriber.id &&
        r.approvalStatus !== 'rejected' &&
        r.consumptionKwh > 0,
    )
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, 3);

  if (recent.length > 0) {
    const sum = recent.reduce((acc, r) => acc + r.consumptionKwh, 0);
    return Math.round((sum / recent.length) * 100) / 100;
  }
  return subscriber.last3MonthsAvgKwh ?? 0;
}

export function getSubscriberPreviousBaseline(
  subscriber: Subscriber,
  readings: MeterReading[],
): number {
  const latestApproved = readings
    .filter(
      (r) =>
        (r.subscriberId === subscriber.id ||
          (Boolean(subscriber.meterNumber) &&
            r.meterNumber === subscriber.meterNumber)) &&
        r.approvalStatus !== 'rejected' &&
        r.approvalStatus !== 'pending_manager',
    )
    .sort((a, b) =>
      String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? '')),
    )[0];

  if (
    latestApproved &&
    (!subscriber.updatedAt ||
      String(latestApproved.recordedAt ?? '') >= String(subscriber.updatedAt))
  ) {
    return latestApproved.currentReading;
  }
  return subscriber.currentReading ?? subscriber.previousReading ?? 0;
}

export interface GeminiPhotoVerificationResult {
  enabled: boolean;
  matched: boolean;
  detectedReading: number | null;
  rawDigits: string;
  confidence: number;
  discrepancyReason: string;
  alert?: ManagerAlert;
}

export async function verifyMeterPhotoWithGemini(params: {
  staffToken: string;
  stationId: string;
  imageBase64: string;
  claimedReading: number;
  previousReading: number;
  subscriberId: string;
  subscriberName: string;
  meterNumber: string;
  readingId: string;
  collectorName: string;
}): Promise<GeminiPhotoVerificationResult> {
  return apiRequest<GeminiPhotoVerificationResult>(
    `/api/stations/${encodeURIComponent(params.stationId)}/verify-meter-photo`,
    {
      method: 'POST',
      body: JSON.stringify({
        imageBase64: params.imageBase64,
        claimedReading: params.claimedReading,
        previousReading: params.previousReading,
        subscriberId: params.subscriberId,
        subscriberName: params.subscriberName,
        meterNumber: params.meterNumber,
        readingId: params.readingId,
        collectorName: params.collectorName,
      }),
    },
    params.staffToken,
  );
}

export async function sendInstantManagerAlert(params: {
  staffToken: string;
  stationId: string;
  alert: ManagerAlert;
  reading?: MeterReading;
}): Promise<{ alert: ManagerAlert }> {
  // Never upload meter photos to cloud/Firestore; photos remain on collector phone
  const textOnlyAlert: ManagerAlert = { ...params.alert, photoUrl: '' };
  const textOnlyReading: MeterReading | undefined = params.reading
    ? {
        ...params.reading,
        photoUrl: '',
        hasLocalPhoto: Boolean(params.reading.photoUrl || params.reading.hasLocalPhoto),
      }
    : undefined;

  if (params.staffToken.startsWith('cloud_')) {
    const ok = await saveCollectorAlertTextToFirestore({
      stationId: params.stationId,
      alert: textOnlyAlert,
    });
    if (!ok) {
      throw new StaticHostingNoBackendError();
    }
    return { alert: { ...textOnlyAlert, syncStatus: 'synced' } };
  }

  try {
    const res = await apiRequest<{ alert: ManagerAlert }>(
      `/api/stations/${encodeURIComponent(params.stationId)}/alerts`,
      {
        method: 'POST',
        body: JSON.stringify({
          alert: textOnlyAlert,
          ...(textOnlyReading ? { reading: textOnlyReading } : {}),
        }),
      },
      params.staffToken,
    );
    void saveCollectorAlertTextToFirestore({
      stationId: params.stationId,
      alert: textOnlyAlert,
    });
    return res;
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError) {
      const ok = await saveCollectorAlertTextToFirestore({
        stationId: params.stationId,
        alert: textOnlyAlert,
      });
      if (ok) {
        return { alert: { ...textOnlyAlert, syncStatus: 'synced' } };
      }
    }
    throw err;
  }
}

export async function resolveManagerAlert(params: {
  staffToken: string;
  stationId: string;
  alertId: string;
  decision: 'approved' | 'rejected';
  managerNote?: string;
}): Promise<{
  alert: ManagerAlert;
  reading: MeterReading | null;
  subscriber: Subscriber | null;
}> {
  const resolveLocallyAndFirestore = async () => {
    const managerCode = params.staffToken.startsWith('cloud_')
      ? normalizeActivationCode(params.staffToken.slice('cloud_'.length))
      : undefined;
    await resolveManagerAlertInFirestore({
      stationId: params.stationId,
      alertId: params.alertId,
      managerCode,
    });
    const local = await loadStationLocalState(params.stationId);
    const now = new Date().toISOString();
    const existingAlert = (local?.alerts ?? []).find((a) => a.id === params.alertId);
    const updatedAlert: ManagerAlert = existingAlert
      ? {
          ...existingAlert,
          status: params.decision,
          resolvedAt: now,
          ...(params.managerNote ? { managerNote: params.managerNote } : {}),
          syncStatus: 'synced',
        }
      : {
          id: params.alertId,
          stationId: params.stationId,
          alertType: 'lower_reading',
          severity: 'warning',
          status: params.decision,
          readingId: '',
          subscriberId: '',
          subscriberName: '',
          meterNumber: '',
          collectorName: '',
          editedReading: 0,
          previousReading: 0,
          photoUrl: '',
          createdAt: now,
          resolvedAt: now,
          syncStatus: 'synced',
        };
    const existingReading = local?.readings.find((r) => r.id === updatedAlert.readingId);
    const updatedReading: MeterReading | null = existingReading
      ? {
          ...existingReading,
          approvalStatus: params.decision === 'approved' ? 'approved' : 'rejected',
        }
      : null;
    const existingSub = local?.subscribers.find((s) => s.id === updatedAlert.subscriberId);
    const candidatePrev =
      updatedReading && updatedAlert.lowerReadingReason === 'meter_replaced'
        ? (updatedAlert.openingReading ?? updatedReading.currentReading)
        : updatedReading?.previousReading ?? 0;
    const nextPrevOnApprove =
      updatedReading && candidatePrev <= updatedReading.currentReading
        ? candidatePrev
        : updatedReading?.currentReading ?? 0;
    const updatedSubscriber: Subscriber | null =
      existingSub && updatedReading && params.decision === 'approved'
        ? {
            ...existingSub,
            ...(updatedAlert.lowerReadingReason === 'meter_replaced' &&
            updatedAlert.newMeterNumber
              ? { meterNumber: updatedAlert.newMeterNumber }
              : {}),
            previousReading: nextPrevOnApprove,
            currentReading: updatedReading.currentReading,
            previousDebtYer: updatedReading.totalDueYer,
            updatedAt: now,
          }
        : null;
    return {
      alert: updatedAlert,
      reading: updatedReading,
      subscriber: updatedSubscriber,
    };
  };

  if (params.staffToken.startsWith('cloud_')) {
    return resolveLocallyAndFirestore();
  }

  try {
    const res = await apiRequest<{
      alert: ManagerAlert;
      reading: MeterReading | null;
      subscriber: Subscriber | null;
    }>(
      `/api/stations/${encodeURIComponent(params.stationId)}/alerts/${encodeURIComponent(params.alertId)}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision: params.decision,
          ...(params.managerNote ? { managerNote: params.managerNote } : {}),
        }),
      },
      params.staffToken,
    );
    void resolveManagerAlertInFirestore({
      stationId: params.stationId,
      alertId: params.alertId,
    });
    return res;
  } catch (err) {
    if (err instanceof StaticHostingNoBackendError) {
      return resolveLocallyAndFirestore();
    }
    throw err;
  }
}

// ============================================================
// Chunked Batch Offline Sync (20 readings per batch)
// ============================================================

export async function syncStationPendingBatches(params: {
  state: StationLocalState;
  staffToken: string;
  role: 'manager' | 'collector';
  onProgress?: (progress: SyncProgress) => void;
}): Promise<{
  updatedState: StationLocalState;
  syncedCount: number;
}> {
  let working = { ...params.state };
  const stationId = working.station.stationId;

  if (params.role === 'manager' && !params.staffToken.startsWith('cloud_')) {
    await saveStationTariffInCloud(params.staffToken, working.station).catch((err) => {
      if (!(err instanceof StaticHostingNoBackendError)) throw err;
    });
  }

  const pendingSubs = working.subscribers.filter((s) => s.syncStatus === 'pending');
  const pendingReadings = working.readings.filter((r) => r.syncStatus === 'pending');
  const pendingReceipts = working.receipts.filter((rc) => rc.syncStatus === 'pending');
  const pendingAlerts = (working.alerts ?? []).filter(
    (al) => al.syncStatus === 'pending',
  );

  const subChunkSize = 300;
  const readingChunkSize = 20;

  const subBatches: Subscriber[][] = [];
  for (let i = 0; i < pendingSubs.length; i += subChunkSize) {
    subBatches.push(pendingSubs.slice(i, i + subChunkSize));
  }

  const readingBatches: MeterReading[][] = [];
  for (let i = 0; i < pendingReadings.length; i += readingChunkSize) {
    readingBatches.push(pendingReadings.slice(i, i + readingChunkSize));
  }

  const receiptBatches: PaymentReceipt[][] = [];
  for (let i = 0; i < pendingReceipts.length; i += readingChunkSize) {
    receiptBatches.push(pendingReceipts.slice(i, i + readingChunkSize));
  }

  const alertBatches: ManagerAlert[][] = [];
  for (let i = 0; i < pendingAlerts.length; i += 10) {
    alertBatches.push(pendingAlerts.slice(i, i + 10));
  }

  const totalItems =
    pendingSubs.length +
    pendingReadings.length +
    pendingReceipts.length +
    pendingAlerts.length;
  const totalBatches =
    subBatches.length +
    readingBatches.length +
    receiptBatches.length +
    alertBatches.length;

  let completed = 0;
  let currentBatch = 0;
  let syncedCount = 0;

  const commitLocalProgress = async (
    syncedSubIds: Set<string>,
    syncedRdIds: Set<string>,
    syncedRcIds: Set<string>,
    syncedAlIds: Set<string>,
  ) => {
    working = {
      ...working,
      subscribers: working.subscribers.map((s) =>
        syncedSubIds.has(s.id) ? { ...s, syncStatus: 'synced' } : s,
      ),
      readings: working.readings.map((r) =>
        syncedRdIds.has(r.id) ? { ...r, syncStatus: 'synced' } : r,
      ),
      receipts: working.receipts.map((rc) =>
        syncedRcIds.has(rc.id) ? { ...rc, syncStatus: 'synced' } : rc,
      ),
      alerts: (working.alerts ?? []).map((al) =>
        syncedAlIds.has(al.id) ? { ...al, syncStatus: 'synced' } : al,
      ),
    };
    await saveStationLocalState(working);
  };

  for (const batch of subBatches) {
    currentBatch++;
    let subSynced = false;
    if (!params.staffToken.startsWith('cloud_')) {
      try {
        await apiRequest(
          `/api/stations/${encodeURIComponent(stationId)}/sync-batch`,
          {
            method: 'POST',
            body: JSON.stringify({ subscribers: batch, readings: [], receipts: [] }),
          },
          params.staffToken,
        );
        subSynced = true;
      } catch (err) {
        if (!(err instanceof StaticHostingNoBackendError)) {
          throw err;
        }
      }
    }
    const ids = subSynced ? new Set(batch.map((b) => b.id)) : new Set<string>();
    if (subSynced) {
      await commitLocalProgress(ids, new Set(), new Set(), new Set());
      syncedCount += batch.length;
    }
    completed += batch.length;
    params.onProgress?.({ completed, total: totalItems, currentBatch, totalBatches });
  }

  for (const batch of readingBatches) {
    currentBatch++;
    // Run deferred Gemini Vision-AI verification for offline readings if Admin enabled it
    const verifiedBatch: MeterReading[] = [];
    for (const r of batch) {
      if (
        working.station.aiPhotoVerificationEnabled &&
        r.aiVerificationStatus === 'pending_offline' &&
        r.photoUrl &&
        !params.staffToken.startsWith('cloud_')
      ) {
        try {
          const aiRes = await verifyMeterPhotoWithGemini({
            staffToken: params.staffToken,
            stationId,
            imageBase64: r.photoUrl,
            claimedReading: r.currentReading,
            previousReading: r.previousReading,
            subscriberId: r.subscriberId,
            subscriberName: r.subscriberName,
            meterNumber: r.meterNumber,
            readingId: r.id,
            collectorName: r.collectorName,
          });
          const updatedRd: MeterReading = {
            ...r,
            aiVerificationStatus: aiRes.matched ? 'matched' : 'mismatch',
            ...(aiRes.detectedReading !== null
              ? { aiDetectedReading: aiRes.detectedReading }
              : {}),
            aiConfidence: aiRes.confidence,
            ...(aiRes.discrepancyReason
              ? { aiVerificationReason: aiRes.discrepancyReason }
              : {}),
            ...(aiRes.matched ? {} : { approvalStatus: 'pending_manager' as const }),
          };
          verifiedBatch.push(updatedRd);
          if (!aiRes.matched && aiRes.alert) {
            working = {
              ...working,
              alerts: [
                { ...aiRes.alert, syncStatus: 'synced' as const },
                ...(working.alerts ?? []),
              ],
            };
          }
          continue;
        } catch {
          // Keep pending_offline if AI verification endpoint temporarily fails
        }
      }
      verifiedBatch.push(r);
    }

    // Strict text-only cloud sync: meter photos remain stored locally in collector phone memory only
    const payloadReadings = verifiedBatch.map((r) => ({
      ...r,
      photoUrl: '',
      hasLocalPhoto: Boolean(r.photoUrl || r.hasLocalPhoto),
    }));
    let batchSynced = false;
    if (!params.staffToken.startsWith('cloud_')) {
      try {
        await apiRequest(
          `/api/stations/${encodeURIComponent(stationId)}/sync-batch`,
          {
            method: 'POST',
            body: JSON.stringify({
              subscribers: [],
              readings: payloadReadings,
              receipts: [],
            }),
          },
          params.staffToken,
        );
        batchSynced = true;
      } catch (err) {
        if (!(err instanceof StaticHostingNoBackendError)) {
          throw err;
        }
      }
    }

    if (!batchSynced) {
      const firestoreResults = await Promise.all(
        payloadReadings.map((rd) =>
          saveCollectorReadingTextToFirestore({ stationId, reading: rd }),
        ),
      );
      batchSynced = firestoreResults.some(Boolean);
    } else {
      void Promise.all(
        payloadReadings.map((rd) =>
          saveCollectorReadingTextToFirestore({ stationId, reading: rd }),
        ),
      );
    }

    const verifiedById = new Map(verifiedBatch.map((v) => [v.id, v]));
    working = {
      ...working,
      readings: working.readings.map((r) => verifiedById.get(r.id) ?? r),
    };
    const syncedRdIds = batchSynced ? new Set(batch.map((b) => b.id)) : new Set<string>();
    const syncedSubIds = batchSynced
      ? new Set(batch.map((b) => b.subscriberId))
      : new Set<string>();
    await commitLocalProgress(syncedSubIds, syncedRdIds, new Set(), new Set());
    completed += batch.length;
    if (batchSynced) {
      syncedCount += batch.length;
    }
    params.onProgress?.({ completed, total: totalItems, currentBatch, totalBatches });
  }

  for (const batch of receiptBatches) {
    currentBatch++;
    let batchSynced = false;
    if (!params.staffToken.startsWith('cloud_')) {
      try {
        await apiRequest(
          `/api/stations/${encodeURIComponent(stationId)}/sync-batch`,
          {
            method: 'POST',
            body: JSON.stringify({ subscribers: [], readings: [], receipts: batch }),
          },
          params.staffToken,
        );
        batchSynced = true;
      } catch (err) {
        if (!(err instanceof StaticHostingNoBackendError)) {
          throw err;
        }
      }
    }

    if (!batchSynced) {
      const firestoreResults = await Promise.all(
        batch.map((rc) =>
          saveCollectorReceiptTextToFirestore({ stationId, receipt: rc }),
        ),
      );
      batchSynced = firestoreResults.some(Boolean);
    } else {
      void Promise.all(
        batch.map((rc) =>
          saveCollectorReceiptTextToFirestore({ stationId, receipt: rc }),
        ),
      );
    }

    if (batchSynced) {
      const syncedRcIds = new Set(batch.map((b) => b.id));
      const syncedSubIds = new Set(batch.map((b) => b.subscriberId));
      await commitLocalProgress(syncedSubIds, new Set(), syncedRcIds, new Set());
      syncedCount += batch.length;
    }
    completed += batch.length;
    params.onProgress?.({ completed, total: totalItems, currentBatch, totalBatches });
  }

  for (const batch of alertBatches) {
    currentBatch++;
    const textOnlyAlerts = batch
      .filter((al) => al.alertType !== 'manual_edit')
      .map((al) => ({ ...al, photoUrl: '' }));
    let batchSynced = false;

    if (textOnlyAlerts.length > 0 && !params.staffToken.startsWith('cloud_')) {
      try {
        await apiRequest(
          `/api/stations/${encodeURIComponent(stationId)}/sync-batch`,
          {
            method: 'POST',
            body: JSON.stringify({
              subscribers: [],
              readings: [],
              receipts: [],
              alerts: textOnlyAlerts,
            }),
          },
          params.staffToken,
        );
        batchSynced = true;
      } catch (err) {
        if (!(err instanceof StaticHostingNoBackendError)) {
          throw err;
        }
      }
    }

    if (textOnlyAlerts.length > 0 && !batchSynced) {
      const firestoreResults = await Promise.all(
        textOnlyAlerts.map((al) =>
          saveCollectorAlertTextToFirestore({ stationId, alert: al }),
        ),
      );
      batchSynced = firestoreResults.some(Boolean);
    } else if (textOnlyAlerts.length > 0) {
      void Promise.all(
        textOnlyAlerts.map((al) =>
          saveCollectorAlertTextToFirestore({ stationId, alert: al }),
        ),
      );
    }

    if (batchSynced || textOnlyAlerts.length === 0) {
      const ids = new Set(batch.map((b) => b.id));
      await commitLocalProgress(new Set(), new Set(), new Set(), ids);
      syncedCount += batch.length;
    }
    completed += batch.length;
    params.onProgress?.({ completed, total: totalItems, currentBatch, totalBatches });
  }

  return { updatedState: working, syncedCount };
}

/**
 * Sends an approved reading (number + meterNumber + recordedAt ONLY, zero photo)
 * to Firestore and backend in the background immediately upon collector approval.
 */
export async function dispatchReadingToCloudBackground(params: {
  stationId: string;
  staffToken: string;
  reading: MeterReading;
  subscriber?: Subscriber;
  receipt?: PaymentReceipt;
  alerts?: ManagerAlert[];
}): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  const textOnlyReading: MeterReading = {
    ...params.reading,
    photoUrl: '',
    hasLocalPhoto: Boolean(params.reading.photoUrl || params.reading.hasLocalPhoto),
  };

  let synced = false;

  if (params.staffToken && !params.staffToken.startsWith('cloud_')) {
    try {
      await apiRequest(
        `/api/stations/${encodeURIComponent(params.stationId)}/sync-batch`,
        {
          method: 'POST',
          body: JSON.stringify({
            subscribers: params.subscriber ? [params.subscriber] : [],
            readings: [textOnlyReading],
            receipts: params.receipt ? [params.receipt] : [],
            alerts: (params.alerts ?? []).map((a) => ({ ...a, photoUrl: '' })),
          }),
        },
        params.staffToken,
      );
      synced = true;
    } catch {
      // Keep local pending status if offline or API unreachable
    }
  }

  const [readingOk, receiptOk] = await Promise.all([
    saveCollectorReadingTextToFirestore({
      stationId: params.stationId,
      reading: textOnlyReading,
    }),
    params.receipt
      ? saveCollectorReceiptTextToFirestore({
          stationId: params.stationId,
          receipt: params.receipt,
        })
      : Promise.resolve(true),
    ...(params.alerts ?? []).map((al) =>
      saveCollectorAlertTextToFirestore({
        stationId: params.stationId,
        alert: al,
      }),
    ),
  ]);

  return synced || (readingOk && receiptOk);
}

/**
 * Sends a cash-only receipt in the background immediately when online.
 */
export async function dispatchReceiptToCloudBackground(params: {
  stationId: string;
  staffToken: string;
  receipt: PaymentReceipt;
  subscriber?: Subscriber;
}): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  let synced = false;
  if (params.staffToken && !params.staffToken.startsWith('cloud_')) {
    try {
      await apiRequest(
        `/api/stations/${encodeURIComponent(params.stationId)}/sync-batch`,
        {
          method: 'POST',
          body: JSON.stringify({
            subscribers: params.subscriber ? [params.subscriber] : [],
            readings: [],
            receipts: [params.receipt],
          }),
        },
        params.staffToken,
      );
      synced = true;
    } catch {
      // fallback to Firestore
    }
  }

  const firestoreOk = await saveCollectorReceiptTextToFirestore({
    stationId: params.stationId,
    receipt: params.receipt,
  });

  return synced || firestoreOk;
}

// ============================================================
// Public Subscriber Portal Lookup (Name + Phone)
// ============================================================

export async function lookupSubscriberPublic(params: {
  subscriberName: string;
  phone: string;
}): Promise<SubscriberLookupResult> {
  try {
    return await apiRequest<SubscriberLookupResult>('/api/subscriber/lookup', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  } catch (err) {
    const cloudPortal = await loadSubscriberPortalFromFirestore(
      params.subscriberName,
      params.phone,
    );
    if (cloudPortal) return cloudPortal;
    throw err;
  }
}

// ============================================================
// Excel Import & Export
// ============================================================

function normalizeArabicDigits(raw: string): string {
  return raw.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function normalizeExcelHeader(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/[_/\\\-:،,.\s()]+/g, '')
    .toLowerCase();
}

function parseExcelNumber(raw: unknown): number {
  const cleaned = normalizeArabicDigits(String(raw ?? ''))
    .replace(/[,،\s]/g, '')
    .replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const EXCEL_HEADER_ALIASES = {
  meterNumber: [
    'meternumber',
    'meter',
    'meterno',
    'رقم العداد'.replace(/\s+/g, ''),
    'العداد',
    'رقمالاشتراك',
    'كودالعداد',
  ],
  subscriberName: [
    'subscribername',
    'name',
    'fullname',
    'customername',
    'اسمالمشترك',
    'الاسم',
    'اسمالعميل',
    'الاسمالكامل',
    'المشترك',
    'اسمالمشتركين',
  ],
  phone: [
    'phone',
    'phonenumber',
    'mobile',
    'tel',
    'رقمهاتف',
    'رقمالهاف',
    'رقمالھاتف',
    'رقمالهاتف',
    'الهاتف',
    'التلفون',
    'رقمتلفون',
    'رقمالجوال',
    'الجوال',
    'رقمالموبايل',
    'الموبايل',
    'جوال',
    'تلفون',
  ],
  previousReading: [
    'previousreading',
    'prevreading',
    'القراءهالسابقه',
    'قراءهسابقه',
    'السابقه',
  ],
  previousDebt: [
    'previousdebt',
    'debt',
    'balance',
    'المتاخرات',
    'متاخرات',
    'الرصيدالسابق',
    'الديون',
    'المتبقي',
    'مديونيه',
  ],
  zoneStreet: [
    'zonestreet',
    'zone',
    'street',
    'area',
    'الحارهالشارع',
    'الحاره',
    'الشارع',
    'المنطقه',
    'المربع',
    'الحي',
  ],
  sequenceOrder: [
    'sequenceorder',
    'sequence',
    'seq',
    'order',
    'ترتيبالبيت',
    'الترتيب',
    'تسلسل',
    'التسلسل',
    'رقمالسلسله',
    'م',
  ],
};

export async function parseSubscribersExcelFile(
  file: File,
  options?: { importedLocally?: boolean },
): Promise<Subscriber[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, {
    header: 1,
    defval: '',
  });

  if (matrix.length === 0) return [];

  // Auto-detect actual header row in first 10 rows (handles title banners in old sheets)
  let headerRowIndex = 0;
  let bestScore = -1;
  const maxScan = Math.min(10, matrix.length);
  const allKnownHeaders = new Set(Object.values(EXCEL_HEADER_ALIASES).flat());

  for (let r = 0; r < maxScan; r++) {
    const row = matrix[r] ?? [];
    let score = 0;
    for (const cell of row) {
      const norm = normalizeExcelHeader(cell);
      if (norm && allKnownHeaders.has(norm)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      headerRowIndex = r;
    }
  }

  const headerCells = (matrix[headerRowIndex] ?? []).map(normalizeExcelHeader);
  const findColIndex = (aliases: string[]): number =>
    headerCells.findIndex((h) => h && aliases.includes(h));

  const idxMeter = findColIndex(EXCEL_HEADER_ALIASES.meterNumber);
  const idxName = findColIndex(EXCEL_HEADER_ALIASES.subscriberName);
  const idxPhone = findColIndex(EXCEL_HEADER_ALIASES.phone);
  const idxPrevReading = findColIndex(EXCEL_HEADER_ALIASES.previousReading);
  const idxPrevDebt = findColIndex(EXCEL_HEADER_ALIASES.previousDebt);
  const idxZone = findColIndex(EXCEL_HEADER_ALIASES.zoneStreet);
  const idxSeq = findColIndex(EXCEL_HEADER_ALIASES.sequenceOrder);

  if (idxName === -1) {
    return [];
  }

  const ts = new Date().toISOString();
  const parsed: Subscriber[] = [];
  const seenIds = new Set<string>();

  for (let r = headerRowIndex + 1; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const subscriberName = String(row[idxName] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!subscriberName) continue;

    const rawMeter =
      idxMeter >= 0 ? normalizeArabicDigits(String(row[idxMeter] ?? '')).trim() : '';
    const meterNumber = rawMeter || String(parsed.length + 1001);

    const rawPhone =
      idxPhone >= 0
        ? normalizeArabicDigits(String(row[idxPhone] ?? ''))
            .replace(/[^\d+]/g, '')
            .trim()
        : '';

    const prevReading =
      idxPrevReading >= 0 ? parseExcelNumber(row[idxPrevReading]) : 0;
    const prevDebt = idxPrevDebt >= 0 ? parseExcelNumber(row[idxPrevDebt]) : 0;
    const zoneStreet =
      (idxZone >= 0 ? String(row[idxZone] ?? '').trim() : '') || 'شارع عام';
    const seqOrder =
      idxSeq >= 0 && parseExcelNumber(row[idxSeq]) > 0
        ? parseExcelNumber(row[idxSeq])
        : parsed.length + 1;

    let subId = sanitizeFirestoreId(`sub_${meterNumber}`);
    if (seenIds.has(subId)) {
      subId = sanitizeFirestoreId(`sub_${meterNumber}_${parsed.length + 1}`);
    }
    seenIds.add(subId);

    parsed.push({
      id: subId,
      meterNumber,
      subscriberName,
      phone: rawPhone || '770000000',
      previousReading: Math.max(0, prevReading),
      currentReading: Math.max(0, prevReading),
      previousDebtYer: Math.max(0, prevDebt),
      zoneStreet,
      sequenceOrder: Math.max(1, Math.round(seqOrder)),
      ...(options?.importedLocally ? { importedLocally: true } : {}),
      syncStatus: 'synced',
      updatedAt: ts,
    });
  }

  return parsed;
}

export function downloadExcelTemplate(): void {
  const sampleRows = [
    {
      'رقم العداد': '50101',
      'اسم المشترك': 'محمد علي صالح الحداد',
      'رقم الهاتف': '771112233',
      'القراءة السابقة': 1250,
      'المتأخرات': 0,
      'الحارة/الشارع': 'شارع تعز - جولة سواد',
      'ترتيب البيت': 1,
    },
    {
      'رقم العداد': '50102',
      'اسم المشترك': 'عبدالله أحمد قاسم',
      'رقم الهاتف': '773334455',
      'القراءة السابقة': 840,
      'المتأخرات': 3500,
      'الحارة/الشارع': 'شارع تعز - جولة سواد',
      'ترتيب البيت': 2,
    },
  ];

  const guideRows = [
    {
      'رأس العمود المطلوب (عربي)': 'اسم المشترك',
      'البديل الإنجليزي المقبول': 'subscriber_name',
      'الحالة': 'إلزامي',
      'التوضيح': 'الاسم الكامل للمشترك كما سيستعلم به المشترك أو يبحث به المحصّل',
    },
    {
      'رأس العمود المطلوب (عربي)': 'رقم الهاتف',
      'البديل الإنجليزي المقبول': 'phone',
      'الحالة': 'إلزامي لدخول المشترك',
      'التوضيح': 'رقم الهاتف المسجل (مثال: 771112233) بدون مسافات',
    },
    {
      'رأس العمود المطلوب (عربي)': 'رقم العداد',
      'البديل الإنجليزي المقبول': 'meter_number',
      'الحالة': 'موصى به جداً',
      'التوضيح': 'رقم العداد الفريد لعدم تكرار أو دمج المشتركين خطأً',
    },
    {
      'رأس العمود المطلوب (عربي)': 'القراءة السابقة',
      'البديل الإنجليزي المقبول': 'previous_reading',
      'الحالة': 'اختياري (الافتراضي 0)',
      'التوضيح': 'آخر قراءة معتمدة للعداد بالكيلوواط ساعة',
    },
    {
      'رأس العمود المطلوب (عربي)': 'المتأخرات',
      'البديل الإنجليزي المقبول': 'previous_debt',
      'الحالة': 'اختياري (الافتراضي 0)',
      'التوضيح': 'الرصيد المتبقي أو المديونية السابقة بالريال اليمني',
    },
    {
      'رأس العمود المطلوب (عربي)': 'الحارة/الشارع',
      'البديل الإنجليزي المقبول': 'zone_street',
      'الحالة': 'اختياري',
      'التوضيح': 'اسم الحارة أو الشارع لتوزيع خط سير المحصّلين',
    },
    {
      'رأس العمود المطلوب (عربي)': 'ترتيب البيت',
      'البديل الإنجليزي المقبول': 'sequence_order',
      'الحالة': 'اختياري',
      'التوضيح': 'رقم تسلسلي لترتيب المنازل في خط السير الميداني',
    },
  ];

  const mainSheet = XLSX.utils.json_to_sheet(sampleRows);
  mainSheet['!cols'] = [
    { wch: 14 },
    { wch: 28 },
    { wch: 15 },
    { wch: 16 },
    { wch: 14 },
    { wch: 26 },
    { wch: 14 },
  ];

  const guideSheet = XLSX.utils.json_to_sheet(guideRows);
  guideSheet['!cols'] = [
    { wch: 26 },
    { wch: 24 },
    { wch: 20 },
    { wch: 52 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, mainSheet, 'كشف_المشتركين');
  XLSX.utils.book_append_sheet(workbook, guideSheet, 'توضيح_الأعمدة');
  XLSX.writeFile(workbook, 'نموذج_كشف_المشتركين_المعتمد.xlsx');
}

export function exportCollectorReadingsExcel(
  state: StationLocalState,
  collectorName?: string,
): void {
  const readingRows = state.readings.map((r) => ({
    'رقم العداد': r.meterNumber,
    'اسم المشترك': r.subscriberName,
    'القراءة السابقة': r.previousReading,
    'القراءة الحالية': r.currentReading,
    'الاستهلاك (ك.و.س)': r.consumptionKwh,
    'سعر الوحدة (ر.ي)': r.kwhPriceYer,
    'مبلغ الاستهلاك (ر.ي)': r.currentBillYer,
    'المتأخرات السابقة (ر.ي)': r.previousDebtYer,
    'الإجمالي المستحق (ر.ي)': r.totalDueYer,
    'صورة محفوظة بالهاتف': r.photoUrl || r.hasLocalPhoto ? 'نعم' : 'لا',
    'المحصّل': r.collectorName,
    'وقت القراءة': new Date(r.recordedAt).toLocaleString('ar-YE'),
    'حالة المزامنة': r.syncStatus === 'synced' ? 'متزامن' : 'محلي غير مرفوع',
  }));

  const receiptRows = state.receipts.map((rc) => ({
    'رقم السند': rc.id,
    'رقم العداد': rc.meterNumber,
    'اسم المشترك': rc.subscriberName,
    'المبلغ المدفوع (ر.ي)': rc.amountPaidYer,
    'الرصيد المتبقي (ر.ي)': rc.remainingBalanceYer,
    'المحصّل': rc.collectorName,
    'التاريخ': new Date(rc.paidAt).toLocaleString('ar-YE'),
    'حالة المزامنة': rc.syncStatus === 'synced' ? 'متزامن' : 'محلي غير مرفوع',
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      readingRows.length > 0
        ? readingRows
        : [{ ملاحظة: 'لا توجد قراءات مسجلة حتى الآن' }],
    ),
    'القراءات_المسجلة',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      receiptRows.length > 0
        ? receiptRows
        : [{ ملاحظة: 'لا توجد سندات قبض مسجلة حتى الآن' }],
    ),
    'سندات_القبض',
  );

  const safeDate = new Date().toISOString().slice(0, 10);
  const safeName = (collectorName || state.station.stationName)
    .trim()
    .replace(/\s+/g, '_');
  XLSX.writeFile(wb, `قراءات_${safeName}_${safeDate}.xlsx`);
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
