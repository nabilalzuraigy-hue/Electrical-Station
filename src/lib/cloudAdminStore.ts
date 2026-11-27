import { auth, isAuthorizedAdminUser } from './firebase';
import {
  loadAdminStoreFromFirestore,
  saveAdminStoreToFirestore,
  type AdminStoreBackupPayload,
} from './firestoreBackup';
import { idbGet, idbSet } from './indexedDbCache';
import type {
  AccessCodeRecord,
  CollectorLocationRecord,
  CollectorPermissions,
  DieselExpenseEntry,
  ManagerAlert,
  MeterReading,
  PaymentReceipt,
  StationConfig,
  Subscriber,
} from '../types/station';

export const CLOUD_ADMIN_TOKEN = 'firebase_admin_cloud';
const CLOUD_VAULT_CACHE_KEY = 'cloud_admin_vault_cache_v1';

export interface CloudStationBucket {
  subscribers: Record<string, Subscriber>;
  readings: Record<string, MeterReading>;
  receipts: Record<string, PaymentReceipt>;
  alerts: Record<string, ManagerAlert>;
  expenses: Record<string, DieselExpenseEntry>;
  collectorLocations: Record<string, CollectorLocationRecord>;
}

export interface CloudAdminVault {
  stations: Record<string, StationConfig>;
  codes: Record<string, AccessCodeRecord>;
  stationData: Record<string, CloudStationBucket>;
}

export function isCloudAdminToken(token?: string | null): boolean {
  return token === CLOUD_ADMIN_TOKEN;
}

export function canUseCloudAdminFallback(): boolean {
  return isAuthorizedAdminUser(auth.currentUser);
}

function emptyBucket(): CloudStationBucket {
  return {
    subscribers: {},
    readings: {},
    receipts: {},
    alerts: {},
    expenses: {},
    collectorLocations: {},
  };
}

function normalizeBucket(raw: unknown): CloudStationBucket {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Partial<CloudStationBucket>;
  return {
    subscribers: b.subscribers && typeof b.subscribers === 'object' ? { ...b.subscribers } : {},
    readings: b.readings && typeof b.readings === 'object' ? { ...b.readings } : {},
    receipts: b.receipts && typeof b.receipts === 'object' ? { ...b.receipts } : {},
    alerts: b.alerts && typeof b.alerts === 'object' ? { ...b.alerts } : {},
    expenses: b.expenses && typeof b.expenses === 'object' ? { ...b.expenses } : {},
    collectorLocations:
      b.collectorLocations && typeof b.collectorLocations === 'object'
        ? { ...b.collectorLocations }
        : {},
  };
}

function normalizeVault(payload?: AdminStoreBackupPayload | null): CloudAdminVault {
  const stations = { ...(payload?.stations ?? {}) };
  const codes = { ...(payload?.codes ?? {}) };
  const rawData = payload?.stationData ?? {};
  const stationData: Record<string, CloudStationBucket> = {};
  for (const [sid, bucket] of Object.entries(rawData)) {
    stationData[sid] = normalizeBucket(bucket);
  }
  for (const sid of Object.keys(stations)) {
    if (!stationData[sid]) {
      stationData[sid] = emptyBucket();
    }
  }
  return { stations, codes, stationData };
}

async function loadCloudVault(): Promise<CloudAdminVault> {
  if (!isAuthorizedAdminUser(auth.currentUser)) {
    throw new Error('يجب تسجيل الدخول بحساب الأدمن المطور في Google أولاً.');
  }
  try {
    const snap = await loadAdminStoreFromFirestore();
    if (snap) {
      const vault = normalizeVault(snap.backup);
      await idbSet(CLOUD_VAULT_CACHE_KEY, vault);
      return vault;
    }
  } catch (err) {
    const cached = await idbGet<CloudAdminVault>(CLOUD_VAULT_CACHE_KEY);
    if (cached) {
      return normalizeVault(cached);
    }
    throw err;
  }
  const empty = normalizeVault(null);
  await idbSet(CLOUD_VAULT_CACHE_KEY, empty);
  return empty;
}

async function saveCloudVault(
  vault: CloudAdminVault,
  options?: { allowEmptyOverwrite?: boolean },
): Promise<void> {
  await idbSet(CLOUD_VAULT_CACHE_KEY, vault);
  await saveAdminStoreToFirestore(vault, options);
}

function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function normalizeId(raw: string): string {
  const clean = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
  return clean || `id_${Date.now()}`;
}

function generateSecureCode(
  role: 'manager' | 'collector',
  existingCodes: Record<string, AccessCodeRecord>,
): string {
  const prefix = role === 'manager' ? 'MGR' : 'COL';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  };
  let candidate = `${prefix}-${block()}-${block()}`;
  while (existingCodes[candidate]) {
    candidate = `${prefix}-${block()}-${block()}`;
  }
  return candidate;
}

function enrichStationCounts(
  station: StationConfig,
  bucket?: CloudStationBucket,
): StationConfig {
  return {
    ...station,
    subscriberCount: Object.keys(bucket?.subscribers ?? {}).length,
    readingCount: Object.keys(bucket?.readings ?? {}).length,
    receiptCount: Object.keys(bucket?.receipts ?? {}).length,
  };
}

export async function cloudAdminOverview(): Promise<{
  stations: StationConfig[];
  codes: AccessCodeRecord[];
}> {
  const vault = await loadCloudVault();
  const stations = Object.values(vault.stations).map((st) =>
    enrichStationCounts(st, vault.stationData[st.stationId]),
  );
  const codes = Object.values(vault.codes).sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  );
  return { stations, codes };
}

export async function cloudAdminCreateStation(params: {
  stationName: string;
  kwhPriceYer?: number;
  maxCollectors?: number;
  maxSubscribers?: number;
}): Promise<{ station: StationConfig }> {
  const vault = await loadCloudVault();
  const now = new Date().toISOString();
  const stationId = `st_${Date.now().toString(36)}_${Math.floor(Math.random() * 900 + 100)}`;
  const station: StationConfig = {
    stationId,
    stationName: params.stationName.trim(),
    kwhPriceYer: Number(params.kwhPriceYer ?? 450) || 450,
    minimumFeeYer: 1000,
    mainGeneratorKwh: 0,
    licenseCode: '',
    licenseStatus: 'active',
    maxCollectors: Number(params.maxCollectors ?? 25) || 25,
    maxSubscribers: Number(params.maxSubscribers ?? 10000) || 10000,
    ownerUid: auth.currentUser?.uid || 'cloud_admin',
    updatedAt: now,
  };
  vault.stations[stationId] = station;
  vault.stationData[stationId] = emptyBucket();
  await saveCloudVault(vault);
  return { station: enrichStationCounts(station, vault.stationData[stationId]) };
}

export async function cloudAdminToggleStationStatus(
  stationId: string,
  licenseStatus: 'active' | 'suspended',
): Promise<{ station: StationConfig }> {
  const vault = await loadCloudVault();
  const st = vault.stations[stationId];
  if (!st) throw new Error('المحطة غير موجودة.');
  const updated: StationConfig = {
    ...st,
    licenseStatus,
    updatedAt: new Date().toISOString(),
  };
  vault.stations[stationId] = updated;
  await saveCloudVault(vault);
  return { station: enrichStationCounts(updated, vault.stationData[stationId]) };
}

export async function cloudAdminToggleAiVerification(
  stationId: string,
  enabled: boolean,
): Promise<{ station: StationConfig }> {
  const vault = await loadCloudVault();
  const st = vault.stations[stationId];
  if (!st) throw new Error('المحطة غير موجودة.');
  const now = new Date().toISOString();
  const updated: StationConfig = {
    ...st,
    aiPhotoVerificationEnabled: enabled,
    aiPhotoVerificationSealed: enabled ? `CLOUD-ADMIN-SEAL:${stationId}` : undefined,
    aiPhotoVerificationSealedAt: enabled ? now : undefined,
    updatedAt: now,
  };
  vault.stations[stationId] = updated;
  await saveCloudVault(vault);
  return { station: enrichStationCounts(updated, vault.stationData[stationId]) };
}

export async function cloudAdminGenerateAccessCode(params: {
  name: string;
  role: 'manager' | 'collector';
  stationId?: string;
  newStationName?: string;
  phone?: string;
  assignedZones?: string[];
  permissions?: CollectorPermissions;
  customCode?: string;
}): Promise<{ codeRecord: AccessCodeRecord; station: StationConfig }> {
  const vault = await loadCloudVault();
  const now = new Date().toISOString();

  let stationId = params.stationId?.trim() || '';
  let station = stationId ? vault.stations[stationId] : undefined;

  if (!station) {
    const newName = (params.newStationName || '').trim();
    if (newName.length < 2) {
      throw new Error('يرجى اختيار محطة قائمة أو كتابة اسم محطة جديدة.');
    }
    stationId = `st_${Date.now().toString(36)}_${Math.floor(Math.random() * 900 + 100)}`;
    station = {
      stationId,
      stationName: newName,
      kwhPriceYer: 450,
      minimumFeeYer: 1000,
      mainGeneratorKwh: 0,
      licenseCode: '',
      licenseStatus: 'active',
      maxCollectors: 25,
      maxSubscribers: 10000,
      ownerUid: auth.currentUser?.uid || 'cloud_admin',
      updatedAt: now,
    };
    vault.stations[stationId] = station;
    vault.stationData[stationId] = emptyBucket();
  }

  const code = params.customCode?.trim()
    ? normalizeCode(params.customCode)
    : generateSecureCode(params.role, vault.codes);

  if (code.length < 4) {
    throw new Error('الكود المخصص يجب أن لا يقل عن 4 أحرف/أرقام.');
  }
  if (vault.codes[code]) {
    throw new Error(`الكود (${code}) مستخدم بالفعل، اختر كوداً آخر.`);
  }

  if (params.role === 'manager' && !station.licenseCode) {
    station.licenseCode = code;
    vault.stations[stationId] = { ...station, updatedAt: now };
  }

  const codeRecord: AccessCodeRecord = {
    code,
    role: params.role,
    name: params.name.trim(),
    phone: (params.phone || '').trim() || '770000000',
    stationId,
    stationName: station.stationName,
    assignedZones: params.assignedZones ?? [],
    permissions:
      params.role === 'manager'
        ? {
            canRecordReadings: true,
            canCollectCash: true,
            canSendInvoices: true,
            canViewDebts: true,
          }
        : params.permissions ?? {
            canRecordReadings: true,
            canCollectCash: true,
            canSendInvoices: true,
            canViewDebts: true,
          },
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  vault.codes[code] = codeRecord;
  await saveCloudVault(vault);
  return {
    codeRecord,
    station: enrichStationCounts(vault.stations[stationId], vault.stationData[stationId]),
  };
}

export async function cloudAdminToggleAccessCode(
  codeInput: string,
  updates: {
    active?: boolean;
    permissions?: CollectorPermissions;
    assignedZones?: string[];
  },
): Promise<{ codeRecord: AccessCodeRecord }> {
  const vault = await loadCloudVault();
  const code = normalizeCode(codeInput);
  const existing = vault.codes[code];
  if (!existing) throw new Error('كود التفعيل غير موجود.');

  const updated: AccessCodeRecord = {
    ...existing,
    ...(typeof updates.active === 'boolean' ? { active: updates.active } : {}),
    ...(updates.permissions ? { permissions: updates.permissions } : {}),
    ...(Array.isArray(updates.assignedZones)
      ? { assignedZones: updates.assignedZones }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  vault.codes[code] = updated;
  await saveCloudVault(vault);
  return { codeRecord: updated };
}

export async function cloudAdminDeleteAccessCode(
  codeInput: string,
): Promise<{ deleted: boolean; code: string }> {
  const vault = await loadCloudVault();
  const code = normalizeCode(codeInput);
  if (!vault.codes[code]) throw new Error('كود التفعيل غير موجود.');
  delete vault.codes[code];
  await saveCloudVault(vault, { allowEmptyOverwrite: true });
  return { deleted: true, code };
}

export async function cloudAdminUploadSubscribersChunked(params: {
  stationId: string;
  subscribers: Subscriber[];
  replaceAll?: boolean;
  onProgress?: (uploaded: number, total: number) => void;
}): Promise<{ totalSubscribers: number }> {
  const vault = await loadCloudVault();
  if (!vault.stations[params.stationId]) {
    throw new Error('المحطة غير موجودة.');
  }
  const bucket = vault.stationData[params.stationId] ?? emptyBucket();
  if (params.replaceAll) {
    bucket.subscribers = {};
  }

  const total = params.subscribers.length;
  const now = new Date().toISOString();
  for (let i = 0; i < total; i++) {
    const sub = params.subscribers[i];
    const id = normalizeId(sub.id || `sub_${sub.meterNumber}`);
    bucket.subscribers[id] = {
      ...sub,
      id,
      syncStatus: 'synced',
      updatedAt: sub.updatedAt || now,
    };
  }

  vault.stationData[params.stationId] = bucket;
  await saveCloudVault(vault);
  params.onProgress?.(total, total);
  return { totalSubscribers: Object.keys(bucket.subscribers).length };
}

export async function cloudAdminFetchStationSubscribers(
  stationId: string,
): Promise<Subscriber[]> {
  const vault = await loadCloudVault();
  const bucket = vault.stationData[stationId] ?? emptyBucket();
  return Object.values(bucket.subscribers)
    .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
    .map((s) => ({ ...s, syncStatus: 'synced' as const }));
}

export async function cloudAdminCreateManualSubscriber(params: {
  stationId: string;
  subscriberName: string;
  meterNumber: string;
  phone: string;
  previousReading: number;
  previousDebtYer: number;
  last3MonthsAvgKwh?: number;
  zoneStreet: string;
  sequenceOrder?: number;
}): Promise<{ subscriber: Subscriber; totalSubscribers: number }> {
  const vault = await loadCloudVault();
  if (!vault.stations[params.stationId]) {
    throw new Error('المحطة غير موجودة.');
  }
  const bucket = vault.stationData[params.stationId] ?? emptyBucket();
  const now = new Date().toISOString();
  const id = normalizeId(`sub_${params.meterNumber}`);
  const seq =
    params.sequenceOrder ?? Object.keys(bucket.subscribers).length + 1;

  const subscriber: Subscriber = {
    id,
    meterNumber: params.meterNumber.trim(),
    subscriberName: params.subscriberName.trim(),
    phone: params.phone.trim() || '770000000',
    previousReading: Math.max(0, Number(params.previousReading) || 0),
    currentReading: Math.max(0, Number(params.previousReading) || 0),
    previousDebtYer: Math.max(0, Number(params.previousDebtYer) || 0),
    ...(typeof params.last3MonthsAvgKwh === 'number'
      ? { last3MonthsAvgKwh: params.last3MonthsAvgKwh }
      : {}),
    zoneStreet: params.zoneStreet.trim() || 'شارع عام',
    sequenceOrder: Math.max(1, Math.round(seq)),
    syncStatus: 'synced',
    updatedAt: now,
  };
  bucket.subscribers[id] = subscriber;
  vault.stationData[params.stationId] = bucket;
  await saveCloudVault(vault);
  return {
    subscriber,
    totalSubscribers: Object.keys(bucket.subscribers).length,
  };
}

export async function cloudAdminDeleteSubscriber(
  stationId: string,
  subscriberId: string,
): Promise<{ deleted: boolean; totalSubscribers: number }> {
  const vault = await loadCloudVault();
  const bucket = vault.stationData[stationId];
  if (!bucket || !bucket.subscribers[subscriberId]) {
    throw new Error('المشترك غير موجود.');
  }
  delete bucket.subscribers[subscriberId];
  await saveCloudVault(vault);
  return {
    deleted: true,
    totalSubscribers: Object.keys(bucket.subscribers).length,
  };
}

export async function cloudAdminDeleteStation(
  stationId: string,
): Promise<{ deleted: boolean; stationId: string }> {
  const vault = await loadCloudVault();
  if (!vault.stations[stationId]) {
    throw new Error('المحطة غير موجودة.');
  }
  delete vault.stations[stationId];
  delete vault.stationData[stationId];
  for (const [code, rec] of Object.entries(vault.codes)) {
    if (rec.stationId === stationId) {
      delete vault.codes[code];
    }
  }
  await saveCloudVault(vault, { allowEmptyOverwrite: true });
  return { deleted: true, stationId };
}

export async function cloudAdminFetchStationDetails(stationId: string): Promise<{
  station: StationConfig;
  readings: MeterReading[];
  receipts: PaymentReceipt[];
  expenses: DieselExpenseEntry[];
  alerts: ManagerAlert[];
}> {
  const vault = await loadCloudVault();
  const st = vault.stations[stationId];
  if (!st) throw new Error('المحطة غير موجودة.');
  const bucket = vault.stationData[stationId] ?? emptyBucket();
  return {
    station: enrichStationCounts(st, bucket),
    readings: Object.values(bucket.readings).sort((a, b) =>
      String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? '')),
    ),
    receipts: Object.values(bucket.receipts).sort((a, b) =>
      String(b.paidAt ?? '').localeCompare(String(a.paidAt ?? '')),
    ),
    expenses: Object.values(bucket.expenses).sort((a, b) =>
      String(b.date || b.createdAt || '').localeCompare(
        String(a.date || a.createdAt || ''),
      ),
    ),
    alerts: Object.values(bucket.alerts).sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    ),
  };
}

export async function cloudAdminDeleteRecord(
  stationId: string,
  kind: 'readings' | 'receipts' | 'expenses',
  recordId: string,
): Promise<{ deleted: boolean; id: string }> {
  const vault = await loadCloudVault();
  const bucket = vault.stationData[stationId];
  if (!bucket || !bucket[kind]?.[recordId]) {
    throw new Error('السجل غير موجود.');
  }
  delete bucket[kind][recordId];
  await saveCloudVault(vault);
  return { deleted: true, id: recordId };
}

export async function cloudAdminFetchBackup(): Promise<
  AdminStoreBackupPayload & { exportedAt: string }
> {
  const vault = await loadCloudVault();
  return {
    stations: vault.stations,
    codes: vault.codes,
    stationData: vault.stationData,
    exportedAt: new Date().toISOString(),
  };
}

export async function cloudAdminRestoreBackup(
  backup: AdminStoreBackupPayload,
  mode: 'merge' | 'replace' = 'merge',
): Promise<{
  ok: boolean;
  stationCount: number;
  codeCount: number;
  subscriberCount: number;
}> {
  const current = mode === 'replace' ? normalizeVault(null) : await loadCloudVault();
  const incoming = normalizeVault(backup);

  const merged: CloudAdminVault = {
    stations: { ...current.stations, ...incoming.stations },
    codes: { ...current.codes, ...incoming.codes },
    stationData: { ...current.stationData },
  };
  for (const [sid, b] of Object.entries(incoming.stationData)) {
    const cur = merged.stationData[sid] ?? emptyBucket();
    merged.stationData[sid] = {
      subscribers: { ...cur.subscribers, ...b.subscribers },
      readings: { ...cur.readings, ...b.readings },
      receipts: { ...cur.receipts, ...b.receipts },
      alerts: { ...cur.alerts, ...b.alerts },
      expenses: { ...cur.expenses, ...b.expenses },
      collectorLocations: { ...cur.collectorLocations, ...b.collectorLocations },
    };
  }

  await saveCloudVault(merged);
  const subscriberCount = Object.values(merged.stationData).reduce(
    (sum, b) => sum + Object.keys(b.subscribers).length,
    0,
  );
  return {
    ok: true,
    stationCount: Object.keys(merged.stations).length,
    codeCount: Object.keys(merged.codes).length,
    subscriberCount,
  };
}
