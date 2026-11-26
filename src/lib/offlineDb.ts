import * as XLSX from 'xlsx';
import { idbGet, idbSet } from './indexedDbCache';
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
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `خطأ في الاتصال بالخادم (${res.status})`);
  }
  return data;
}

// ============================================================
// Developer Admin API (Server-verified scrypt / env passcode)
// ============================================================

export async function getAdminStatus(): Promise<{ configured: boolean }> {
  return apiRequest<{ configured: boolean }>('/api/admin/status');
}

export async function claimAdminPasscode(
  passcode: string,
): Promise<{ token: string; name: string }> {
  return apiRequest<{ token: string; name: string }>('/api/admin/claim', {
    method: 'POST',
    body: JSON.stringify({ passcode }),
  });
}

export async function loginAdminPasscode(
  passcode: string,
): Promise<{ token: string; name: string }> {
  return apiRequest<{ token: string; name: string }>('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ passcode }),
  });
}

export async function fetchAdminOverview(adminToken: string): Promise<{
  stations: StationConfig[];
  codes: AccessCodeRecord[];
}> {
  return apiRequest<{
    stations: StationConfig[];
    codes: AccessCodeRecord[];
  }>('/api/admin/overview', {}, adminToken);
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
  return apiRequest<{ station: StationConfig }>(
    '/api/admin/stations',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    adminToken,
  );
}

export async function toggleStationStatusAdmin(
  adminToken: string,
  stationId: string,
  licenseStatus: 'active' | 'suspended',
): Promise<{ station: StationConfig }> {
  return apiRequest<{ station: StationConfig }>(
    `/api/admin/stations/${encodeURIComponent(stationId)}/status`,
    {
      method: 'POST',
      body: JSON.stringify({ licenseStatus }),
    },
    adminToken,
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
  return apiRequest<{ codeRecord: AccessCodeRecord; station: StationConfig }>(
    '/api/admin/codes',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    adminToken,
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
  return apiRequest<{ codeRecord: AccessCodeRecord }>(
    `/api/admin/codes/${encodeURIComponent(code)}/toggle`,
    {
      method: 'POST',
      body: JSON.stringify(updates),
    },
    adminToken,
  );
}

export async function deleteAccessCodeAdmin(
  adminToken: string,
  code: string,
): Promise<{ deleted: boolean; code: string }> {
  return apiRequest<{ deleted: boolean; code: string }>(
    `/api/admin/codes/${encodeURIComponent(code)}`,
    {
      method: 'DELETE',
    },
    adminToken,
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
}

export async function fetchStationSubscribersAdmin(
  adminToken: string,
  stationId: string,
): Promise<Subscriber[]> {
  const res = await apiRequest<{ subscribers: Array<Omit<Subscriber, 'syncStatus'>> }>(
    `/api/admin/stations/${encodeURIComponent(stationId)}/subscribers`,
    {},
    adminToken,
  );
  return (res.subscribers ?? []).map((s) => ({
    ...s,
    syncStatus: 'synced' as const,
  }));
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
}

export async function deleteSubscriberAdmin(
  adminToken: string,
  stationId: string,
  subscriberId: string,
): Promise<{ deleted: boolean; totalSubscribers: number }> {
  return apiRequest<{ deleted: boolean; totalSubscribers: number }>(
    `/api/admin/stations/${encodeURIComponent(stationId)}/subscribers/${encodeURIComponent(subscriberId)}`,
    {
      method: 'DELETE',
    },
    adminToken,
  );
}

export async function fetchAdminBackup(adminToken: string): Promise<{
  stations: Record<string, StationConfig>;
  codes: Record<string, AccessCodeRecord>;
  stationData: Record<string, unknown>;
  exportedAt: string;
}> {
  return apiRequest<{
    stations: Record<string, StationConfig>;
    codes: Record<string, AccessCodeRecord>;
    stationData: Record<string, unknown>;
    exportedAt: string;
  }>('/api/admin/backup', {}, adminToken);
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
  return apiRequest<{
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
  return apiRequest<{
    station: StationConfig;
    readings: MeterReading[];
    receipts: PaymentReceipt[];
    expenses: DieselExpenseEntry[];
    alerts: ManagerAlert[];
  }>(`/api/admin/stations/${encodeURIComponent(stationId)}/details`, {}, adminToken);
}

export async function deleteStationAdmin(
  adminToken: string,
  stationId: string,
): Promise<{ deleted: boolean; stationId: string }> {
  return apiRequest<{ deleted: boolean; stationId: string }>(
    `/api/admin/stations/${encodeURIComponent(stationId)}`,
    { method: 'DELETE' },
    adminToken,
  );
}

export async function deleteReadingAdmin(
  adminToken: string,
  stationId: string,
  readingId: string,
): Promise<{ deleted: boolean; id: string }> {
  return apiRequest<{ deleted: boolean; id: string }>(
    `/api/admin/stations/${encodeURIComponent(stationId)}/readings/${encodeURIComponent(readingId)}`,
    { method: 'DELETE' },
    adminToken,
  );
}

export async function deleteReceiptAdmin(
  adminToken: string,
  stationId: string,
  receiptId: string,
): Promise<{ deleted: boolean; id: string }> {
  return apiRequest<{ deleted: boolean; id: string }>(
    `/api/admin/stations/${encodeURIComponent(stationId)}/receipts/${encodeURIComponent(receiptId)}`,
    { method: 'DELETE' },
    adminToken,
  );
}

export async function deleteExpenseAdmin(
  adminToken: string,
  stationId: string,
  expenseId: string,
): Promise<{ deleted: boolean; id: string }> {
  return apiRequest<{ deleted: boolean; id: string }>(
    `/api/admin/stations/${encodeURIComponent(stationId)}/expenses/${encodeURIComponent(expenseId)}`,
    { method: 'DELETE' },
    adminToken,
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

  const pendingAlerts = (local.alerts ?? []).filter(
    (al) => al.syncStatus === 'pending',
  );
  const alIds = new Set((cloud.alerts ?? []).map((al) => al.id));
  const mergedAlerts = [
    ...pendingAlerts.filter((al) => !alIds.has(al.id)),
    ...(cloud.alerts ?? []),
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
}

export async function loginWithAccessCode(codeInput: string): Promise<{
  token: string;
  access: AccessCodeRecord;
  state: StationLocalState;
}> {
  const code = normalizeActivationCode(codeInput);
  if (!code || code.length < 4) {
    throw new Error('يرجى إدخال كود الدخول الصحيح.');
  }

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

  const cloudState = mapServerState(res.state);
  const local = await loadStationLocalState(cloudState.station.stationId);
  const merged = mergeLocalPendingWithCloud(local, cloudState);
  await saveStationLocalState(merged);

  return {
    token: res.token,
    access: res.access,
    state: merged,
  };
}

export async function refreshStationState(
  stationId: string,
  staffToken: string,
): Promise<StationLocalState> {
  const res = await apiRequest<{
    station: StationConfig;
    collectors?: AccessCodeRecord[];
    subscribers?: Subscriber[];
    readings?: MeterReading[];
    receipts?: PaymentReceipt[];
    alerts?: ManagerAlert[];
    expenses?: DieselExpenseEntry[];
    collectorLocations?: CollectorLocationRecord[];
  }>(`/api/stations/${encodeURIComponent(stationId)}/state`, {}, staffToken);

  const cloudState = mapServerState(res);
  const local = await loadStationLocalState(stationId);
  const merged = mergeLocalPendingWithCloud(local, cloudState);
  await saveStationLocalState(merged);
  return merged;
}

export async function saveStationTariffInCloud(
  staffToken: string,
  station: StationConfig,
): Promise<void> {
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
  return res.location;
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

export async function sendInstantManagerAlert(params: {
  staffToken: string;
  stationId: string;
  alert: ManagerAlert;
  reading?: MeterReading;
}): Promise<{ alert: ManagerAlert }> {
  return apiRequest<{ alert: ManagerAlert }>(
    `/api/stations/${encodeURIComponent(params.stationId)}/alerts`,
    {
      method: 'POST',
      body: JSON.stringify({
        alert: params.alert,
        ...(params.reading ? { reading: params.reading } : {}),
      }),
    },
    params.staffToken,
  );
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
  return apiRequest<{
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

  if (params.role === 'manager') {
    await saveStationTariffInCloud(params.staffToken, working.station);
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
    await apiRequest(
      `/api/stations/${encodeURIComponent(stationId)}/sync-batch`,
      {
        method: 'POST',
        body: JSON.stringify({ subscribers: batch, readings: [], receipts: [] }),
      },
      params.staffToken,
    );
    const ids = new Set(batch.map((b) => b.id));
    await commitLocalProgress(ids, new Set(), new Set(), new Set());
    completed += batch.length;
    syncedCount += batch.length;
    params.onProgress?.({ completed, total: totalItems, currentBatch, totalBatches });
  }

  for (const batch of readingBatches) {
    currentBatch++;
    const payloadReadings = batch.map((r) => ({
      ...r,
      // Keep proof photo for manager review when flagged/edited/lower; otherwise store locally for ultra-fast sync
      photoUrl: r.approvalStatus === 'pending_manager' ? r.photoUrl : '',
      hasLocalPhoto: Boolean(r.photoUrl || r.hasLocalPhoto),
    }));
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
    const ids = new Set(batch.map((b) => b.id));
    await commitLocalProgress(new Set(), ids, new Set(), new Set());
    completed += batch.length;
    syncedCount += batch.length;
    params.onProgress?.({ completed, total: totalItems, currentBatch, totalBatches });
  }

  for (const batch of receiptBatches) {
    currentBatch++;
    await apiRequest(
      `/api/stations/${encodeURIComponent(stationId)}/sync-batch`,
      {
        method: 'POST',
        body: JSON.stringify({ subscribers: [], readings: [], receipts: batch }),
      },
      params.staffToken,
    );
    const ids = new Set(batch.map((b) => b.id));
    await commitLocalProgress(new Set(), new Set(), ids, new Set());
    completed += batch.length;
    syncedCount += batch.length;
    params.onProgress?.({ completed, total: totalItems, currentBatch, totalBatches });
  }

  for (const batch of alertBatches) {
    currentBatch++;
    await apiRequest(
      `/api/stations/${encodeURIComponent(stationId)}/sync-batch`,
      {
        method: 'POST',
        body: JSON.stringify({
          subscribers: [],
          readings: [],
          receipts: [],
          alerts: batch,
        }),
      },
      params.staffToken,
    );
    const ids = new Set(batch.map((b) => b.id));
    await commitLocalProgress(new Set(), new Set(), new Set(), ids);
    completed += batch.length;
    syncedCount += batch.length;
    params.onProgress?.({ completed, total: totalItems, currentBatch, totalBatches });
  }

  return { updatedState: working, syncedCount };
}

// ============================================================
// Public Subscriber Portal Lookup (Name + Phone)
// ============================================================

export async function lookupSubscriberPublic(params: {
  subscriberName: string;
  phone: string;
}): Promise<SubscriberLookupResult> {
  return apiRequest<SubscriberLookupResult>('/api/subscriber/lookup', {
    method: 'POST',
    body: JSON.stringify(params),
  });
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
