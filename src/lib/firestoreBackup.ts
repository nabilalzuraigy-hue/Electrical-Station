import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import {
  ADMIN_GOOGLE_EMAIL,
  auth,
  computeStaffAccessHash,
  computeSubscriberPortalHash,
  db,
  handleFirestoreError,
  isAuthorizedAdminUser,
  normalizeCodeForHash,
  OperationType,
} from './firebase';
import type {
  AccessCodeRecord,
  CollectorLocationRecord,
  DieselExpenseEntry,
  ManagerAlert,
  MeterReading,
  PaymentReceipt,
  StationConfig,
  Subscriber,
  SubscriberLookupResult,
} from '../types/station';

export interface AdminStoreBackupPayload {
  stations: Record<string, StationConfig>;
  codes: Record<string, AccessCodeRecord>;
  stationData: Record<string, unknown>;
  exportedAt?: string;
}

export interface FirestoreVaultSnapshot {
  backup: AdminStoreBackupPayload;
  stationCount: number;
  codeCount: number;
  subscriberCount: number;
  updatedByEmail: string;
  updatedAtIso: string;
}

export interface StaffVaultPayload {
  access: AccessCodeRecord;
  station: StationConfig;
  collectors: AccessCodeRecord[];
  subscribers: Subscriber[];
  readings: MeterReading[];
  receipts: PaymentReceipt[];
  alerts: ManagerAlert[];
  expenses: DieselExpenseEntry[];
  collectorLocations: CollectorLocationRecord[];
}

const MAX_CHUNK_CHARS = 380000;
const MAX_STAFF_VAULT_JSON_CHARS = 760000;

function isOfflineFirestoreError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err ?? '').toLowerCase();
  return (
    code === 'unavailable' ||
    msg.includes('unavailable') ||
    msg.includes('offline') ||
    msg.includes('could not reach')
  );
}

function getAuthenticatedAdminEmail(): string {
  const user = auth.currentUser;
  if (!isAuthorizedAdminUser(user)) {
    throw new Error(
      `يجب تسجيل الدخول بحساب المطور في Google (${ADMIN_GOOGLE_EMAIL}) أولاً للوصول إلى قاعدة بيانات Firestore.`,
    );
  }
  return user!.email!;
}

function sanitizeVaultDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function splitIntoChunks(str: string, size: number): string[] {
  if (!str) return ['{}'];
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

function countSubscribersInStationData(
  stationData: Record<string, unknown>,
): number {
  let total = 0;
  for (const bucket of Object.values(stationData)) {
    if (
      bucket &&
      typeof bucket === 'object' &&
      'subscribers' in bucket &&
      bucket.subscribers &&
      typeof bucket.subscribers === 'object'
    ) {
      total += Object.keys(bucket.subscribers as Record<string, unknown>).length;
    }
  }
  return total;
}

interface RawStationBucket {
  subscribers?: Record<string, Subscriber>;
  readings?: Record<string, MeterReading>;
  receipts?: Record<string, PaymentReceipt>;
  alerts?: Record<string, ManagerAlert>;
  expenses?: Record<string, DieselExpenseEntry>;
  collectorLocations?: Record<string, CollectorLocationRecord>;
}

function stripPhotosFromStationBucket(bucket: unknown): RawStationBucket {
  if (!bucket || typeof bucket !== 'object') return {};
  const b = bucket as Record<string, unknown>;
  const next: Record<string, unknown> = { ...b };

  if (b.readings && typeof b.readings === 'object' && !Array.isArray(b.readings)) {
    const cleanReadings: Record<string, unknown> = {};
    for (const [k, rawRd] of Object.entries(b.readings as Record<string, unknown>)) {
      if (rawRd && typeof rawRd === 'object') {
        const rd = rawRd as Record<string, unknown>;
        cleanReadings[k] = {
          ...rd,
          photoUrl: '',
          hasLocalPhoto: Boolean(rd.hasLocalPhoto || rd.photoUrl),
        };
      }
    }
    next.readings = cleanReadings;
  }

  if (b.alerts && typeof b.alerts === 'object' && !Array.isArray(b.alerts)) {
    const cleanAlerts: Record<string, unknown> = {};
    for (const [k, rawAl] of Object.entries(b.alerts as Record<string, unknown>)) {
      if (rawAl && typeof rawAl === 'object') {
        const al = rawAl as Record<string, unknown>;
        cleanAlerts[k] = {
          ...al,
          photoUrl: '',
        };
      }
    }
    next.alerts = cleanAlerts;
  }

  return next as RawStationBucket;
}

function buildCompactStaffBucketJson(bucket: RawStationBucket): string {
  const full = JSON.stringify(bucket);
  if (full.length <= MAX_STAFF_VAULT_JSON_CHARS) return full;

  const sortedReadings = Object.entries(bucket.readings ?? {}).sort(([, a], [, b]) =>
    String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? '')),
  );
  const sortedReceipts = Object.entries(bucket.receipts ?? {}).sort(([, a], [, b]) =>
    String(b.paidAt ?? '').localeCompare(String(a.paidAt ?? '')),
  );
  const trimmed: RawStationBucket = {
    ...bucket,
    readings: Object.fromEntries(sortedReadings.slice(0, 300)),
    receipts: Object.fromEntries(sortedReceipts.slice(0, 300)),
  };
  let json = JSON.stringify(trimmed);
  if (json.length <= MAX_STAFF_VAULT_JSON_CHARS) return json;

  trimmed.readings = Object.fromEntries(sortedReadings.slice(0, 80));
  trimmed.receipts = Object.fromEntries(sortedReceipts.slice(0, 80));
  json = JSON.stringify(trimmed);
  return json.slice(0, MAX_STAFF_VAULT_JSON_CHARS);
}

// ============================================================
// Top-level Firestore `codes` Collection Operations
// Fields: code, role ('manager'|'collector'), stationId, active, createdBy, ...
// ============================================================

function mapDocToAccessCodeRecord(
  docId: string,
  raw: Record<string, unknown>,
): AccessCodeRecord | null {
  const code = normalizeCodeForHash(String(raw.code ?? docId));
  const role = raw.role === 'collector' ? 'collector' : raw.role === 'manager' ? 'manager' : null;
  const stationId = String(raw.stationId ?? '').trim();
  if (!code || !role || !stationId) return null;

  const rawPerms = (raw.permissions ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();

  return {
    code,
    role,
    stationId,
    active: raw.active !== false,
    createdBy: String(raw.createdBy ?? ADMIN_GOOGLE_EMAIL),
    name: String(raw.name ?? (role === 'manager' ? 'مدير المحطة' : 'المحصّل')),
    phone: String(raw.phone ?? ''),
    stationName: String(raw.stationName ?? stationId),
    assignedZones: Array.isArray(raw.assignedZones)
      ? raw.assignedZones.map((z) => String(z)).filter(Boolean)
      : [],
    permissions:
      role === 'manager'
        ? {
            canRecordReadings: true,
            canCollectCash: true,
            canSendInvoices: true,
            canViewDebts: true,
          }
        : {
            canRecordReadings: rawPerms.canRecordReadings !== false,
            canCollectCash: rawPerms.canCollectCash !== false,
            canSendInvoices: rawPerms.canSendInvoices !== false,
            canViewDebts: rawPerms.canViewDebts !== false,
          },
    pinResetAt:
      typeof raw.pinResetAt === 'string' && raw.pinResetAt
        ? raw.pinResetAt
        : null,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now,
  };
}

export async function saveAccessCodeToFirestore(
  codeRec: AccessCodeRecord,
): Promise<void> {
  const adminEmail = getAuthenticatedAdminEmail();
  const code = normalizeCodeForHash(codeRec.code);
  if (!code) return;
  const payload = {
    code,
    role: codeRec.role,
    stationId: codeRec.stationId,
    active: Boolean(codeRec.active),
    createdBy: codeRec.createdBy || adminEmail,
    name: (codeRec.name || '').slice(0, 120),
    phone: (codeRec.phone || '').slice(0, 30),
    stationName: (codeRec.stationName || '').slice(0, 120),
    assignedZones: (codeRec.assignedZones ?? []).slice(0, 30),
    permissions:
      codeRec.role === 'manager'
        ? {
            canRecordReadings: true,
            canCollectCash: true,
            canSendInvoices: true,
            canViewDebts: true,
          }
        : {
            canRecordReadings: codeRec.permissions?.canRecordReadings !== false,
            canCollectCash: codeRec.permissions?.canCollectCash !== false,
            canSendInvoices: codeRec.permissions?.canSendInvoices !== false,
            canViewDebts: codeRec.permissions?.canViewDebts !== false,
          },
    pinResetAt: codeRec.pinResetAt ?? null,
    createdAt: codeRec.createdAt || new Date().toISOString(),
    updatedAt: codeRec.updatedAt || new Date().toISOString(),
  };

  try {
    await setDoc(doc(db, 'codes', code), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `codes/${code}`);
  }
}

export async function loadAccessCodeFromFirestore(
  codeInput: string,
  preferServer = true,
): Promise<AccessCodeRecord | null> {
  const code = normalizeCodeForHash(codeInput);
  if (code.length < 4) return null;
  try {
    const ref = doc(db, 'codes', code);
    const snap = preferServer
      ? await getDocFromServer(ref).catch(() => getDoc(ref))
      : await getDoc(ref);
    if (!snap.exists()) return null;
    return mapDocToAccessCodeRecord(
      snap.id,
      snap.data() as Record<string, unknown>,
    );
  } catch {
    return null;
  }
}

export async function listAccessCodesFromFirestore(
  preferServer = true,
): Promise<AccessCodeRecord[]> {
  getAuthenticatedAdminEmail();
  const colRef = collection(db, 'codes');
  let snap;
  try {
    snap = preferServer
      ? await getDocsFromServer(colRef).catch((err) => {
          if (isOfflineFirestoreError(err)) return getDocs(colRef);
          throw err;
        })
      : await getDocs(colRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'codes');
  }
  const list: AccessCodeRecord[] = [];
  snap.forEach((d) => {
    const mapped = mapDocToAccessCodeRecord(
      d.id,
      d.data() as Record<string, unknown>,
    );
    if (mapped) list.push(mapped);
  });
  return list;
}

export async function deleteAccessCodeFromFirestore(
  codeInput: string,
): Promise<void> {
  getAuthenticatedAdminEmail();
  const code = normalizeCodeForHash(codeInput);
  if (!code) return;
  try {
    await deleteDoc(doc(db, 'codes', code));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `codes/${code}`);
  }
}

async function syncStaffAndPortalCachesToFirestore(
  backup: AdminStoreBackupPayload,
  adminEmail: string,
): Promise<void> {
  const stations = backup.stations ?? {};
  const codes = Object.values(backup.codes ?? {});
  const stationData = backup.stationData ?? {};

  // 1. Sync per-code `codes/{code}` and `staffVault/{accessHash}` docs
  for (const codeRec of codes) {
    try {
      await saveAccessCodeToFirestore(codeRec);
    } catch {
      // Non-blocking
    }

    const station = stations[codeRec.stationId];
    if (!station) continue;
    try {
      const accessHash = await computeStaffAccessHash(codeRec.code);
      const bucket = stripPhotosFromStationBucket(stationData[codeRec.stationId] ?? {});
      const stationCollectors =
        codeRec.role === 'manager'
          ? codes.filter(
              (c) => c.stationId === codeRec.stationId && c.role === 'collector',
            )
          : [codeRec];

      await setDoc(doc(db, 'staffVault', accessHash), {
        kind: 'staff_vault',
        stationId: codeRec.stationId,
        accessJson: JSON.stringify(codeRec),
        stationJson: JSON.stringify(station),
        collectorsJson: JSON.stringify(stationCollectors),
        stationDataJson: buildCompactStaffBucketJson(bucket),
        updatedByEmail: adminEmail,
        updatedAt: serverTimestamp(),
      });
    } catch {
      // Non-blocking
    }
  }

  // 2. Sync subscriberPortals/{lookupHash} docs (text-only, no meter photos)
  for (const [stationId, station] of Object.entries(stations)) {
    if (!station) continue;
    const bucket = stripPhotosFromStationBucket(stationData[stationId] ?? {});
    const subs = Object.values(bucket.subscribers ?? {});
    if (subs.length === 0 || subs.length > 500) continue;

    const allReadings = Object.values(bucket.readings ?? {});
    const allReceipts = Object.values(bucket.receipts ?? {});

    for (const sub of subs) {
      if (!sub?.subscriberName || !sub?.meterNumber || !sub?.phone) continue;
      const subReadings = allReadings
        .filter((r) => r.subscriberId === sub.id || r.meterNumber === sub.meterNumber)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      const subReceipts = allReceipts
        .filter((rc) => rc.subscriberId === sub.id || rc.meterNumber === sub.meterNumber)
        .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
      const latestRd = subReadings[0];
      const latestRc = subReceipts[0];

      const portalDoc = {
        stationId: station.stationId,
        stationName: station.stationName,
        meterNumber: sub.meterNumber,
        subscriberName: sub.subscriberName,
        zoneStreet: sub.zoneStreet || 'عام',
        previousReading: latestRd?.previousReading ?? sub.previousReading ?? 0,
        currentReading: latestRd?.currentReading ?? sub.currentReading ?? 0,
        consumptionKwh: latestRd?.consumptionKwh ?? 0,
        currentBillYer: latestRd?.currentBillYer ?? 0,
        previousDebtYer: sub.previousDebtYer ?? 0,
        totalDueYer: latestRd?.totalDueYer ?? sub.previousDebtYer ?? 0,
        lastReadingPhotoUrl: '',
        lastPaymentYer: latestRc?.amountPaidYer ?? 0,
        readingsJson: JSON.stringify(subReadings.slice(0, 12)),
        receiptsJson: JSON.stringify(subReceipts.slice(0, 12)),
        updatedAt: serverTimestamp(),
      };

      try {
        const nameHash = await computeSubscriberPortalHash(
          sub.subscriberName,
          sub.phone,
          'name',
        );
        const meterHash = await computeSubscriberPortalHash(
          sub.meterNumber,
          sub.phone,
          'meter',
        );
        await setDoc(doc(db, 'subscriberPortals', nameHash), portalDoc);
        await setDoc(doc(db, 'subscriberPortals', meterHash), portalDoc);
      } catch {
        // Non-blocking
      }
    }
  }
}

export async function saveAdminStoreToFirestore(
  backup: AdminStoreBackupPayload,
  options?: { allowEmptyOverwrite?: boolean },
): Promise<{
  stationCount: number;
  codeCount: number;
  subscriberCount: number;
  updatedAtIso: string;
  skippedEmptyOverwrite?: boolean;
}> {
  const adminEmail = getAuthenticatedAdminEmail();
  const stationIds = Object.keys(backup.stations ?? {});
  const stationCount = stationIds.length;
  const codeCount = Object.keys(backup.codes ?? {}).length;
  const subscriberCount = countSubscribersInStationData(backup.stationData ?? {});

  // Guard: NEVER wipe a non-empty cloud vault with an empty local/restarted store
  if (stationCount === 0 && codeCount === 0 && !options?.allowEmptyOverwrite) {
    try {
      const existingSnap = await getDocFromServer(doc(db, 'adminVault', 'meta')).catch(() =>
        getDoc(doc(db, 'adminVault', 'meta')),
      );
      if (existingSnap.exists()) {
        const meta = existingSnap.data() as {
          stationCount?: number;
          codeCount?: number;
          subscriberCount?: number;
          clientUpdatedAt?: string;
          updatedAt?: Timestamp;
        };
        if ((meta.stationCount ?? 0) > 0 || (meta.codeCount ?? 0) > 0) {
          return {
            stationCount: meta.stationCount ?? 0,
            codeCount: meta.codeCount ?? 0,
            subscriberCount: meta.subscriberCount ?? 0,
            updatedAtIso:
              meta.updatedAt?.toDate?.()?.toISOString?.() ||
              meta.clientUpdatedAt ||
              new Date().toISOString(),
            skippedEmptyOverwrite: true,
          };
        }
      }
    } catch {
      // fall through
    }
    return {
      stationCount: 0,
      codeCount: 0,
      subscriberCount: 0,
      updatedAtIso: new Date().toISOString(),
      skippedEmptyOverwrite: true,
    };
  }

  const partDocs: string[] = [];

  for (const stationId of stationIds) {
    const bucket = stripPhotosFromStationBucket(backup.stationData?.[stationId] ?? {});
    const serialized = JSON.stringify(bucket);
    const parts = splitIntoChunks(serialized, MAX_CHUNK_CHARS);

    for (let i = 0; i < parts.length; i++) {
      const partDocId = sanitizeVaultDocId(`station_${stationId}_p${i}`);
      partDocs.push(partDocId);
      const path = `adminVault/${partDocId}`;
      try {
        await setDoc(doc(db, 'adminVault', partDocId), {
          kind: 'station_part',
          stationId,
          partIndex: i,
          totalParts: parts.length,
          payloadChunk: parts[i],
          updatedByEmail: adminEmail,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, path);
      }
    }
  }

  const nowIso = new Date().toISOString();

  const metaDoc = {
    kind: 'meta',
    version: 2,
    stationIds,
    partDocs,
    stationsJson: JSON.stringify(backup.stations ?? {}),
    codesJson: JSON.stringify(backup.codes ?? {}),
    stationCount,
    codeCount,
    subscriberCount,
    updatedByEmail: adminEmail,
    clientUpdatedAt: nowIso,
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'adminVault', 'meta'), metaDoc);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'adminVault/meta');
  }

  // Sync top-level `codes` collection, `staffVault`, and `subscriberPortals`
  await syncStaffAndPortalCachesToFirestore(backup, adminEmail);

  return {
    stationCount,
    codeCount,
    subscriberCount,
    updatedAtIso: nowIso,
  };
}

export async function loadAdminStoreFromFirestore(
  preferServer = true,
): Promise<FirestoreVaultSnapshot | null> {
  const adminEmail = getAuthenticatedAdminEmail();
  const metaRef = doc(db, 'adminVault', 'meta');

  let metaSnap;
  try {
    metaSnap = preferServer
      ? await getDocFromServer(metaRef).catch((err) => {
          if (isOfflineFirestoreError(err)) return getDoc(metaRef);
          throw err;
        })
      : await getDoc(metaRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'adminVault/meta');
  }

  const cloudCodes = await listAccessCodesFromFirestore(preferServer);

  if (!metaSnap.exists()) {
    if (cloudCodes.length === 0) return null;
    const codesMap: Record<string, AccessCodeRecord> = {};
    cloudCodes.forEach((c) => {
      codesMap[c.code] = c;
    });
    return {
      backup: {
        stations: {},
        codes: codesMap,
        stationData: {},
        exportedAt: new Date().toISOString(),
      },
      stationCount: 0,
      codeCount: cloudCodes.length,
      subscriberCount: 0,
      updatedByEmail: adminEmail,
      updatedAtIso: new Date().toISOString(),
    };
  }

  const meta = metaSnap.data() as {
    stationIds?: string[];
    partDocs?: string[];
    stationsJson?: string;
    codesJson?: string;
    stationCount?: number;
    codeCount?: number;
    subscriberCount?: number;
    updatedByEmail?: string;
    clientUpdatedAt?: string;
    updatedAt?: Timestamp;
  };

  const stations = JSON.parse(meta.stationsJson || '{}') as Record<
    string,
    StationConfig
  >;
  const codes = JSON.parse(meta.codesJson || '{}') as Record<
    string,
    AccessCodeRecord
  >;

  // Merge newer fields (e.g., active / pinResetAt) from top-level `codes` collection
  for (const cc of cloudCodes) {
    const existing = codes[cc.code];
    if (!existing || String(cc.updatedAt) >= String(existing.updatedAt)) {
      codes[cc.code] = cc;
    }
  }

  const partsByStation = new Map<
    string,
    Array<{ partIndex: number; payloadChunk: string }>
  >();

  for (const partDocId of meta.partDocs ?? []) {
    const path = `adminVault/${partDocId}`;
    const partRef = doc(db, 'adminVault', partDocId);
    let snap;
    try {
      snap = preferServer
        ? await getDocFromServer(partRef).catch((err) => {
            if (isOfflineFirestoreError(err)) return getDoc(partRef);
            throw err;
          })
        : await getDoc(partRef);
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, path);
    }
    if (!snap.exists()) continue;
    const data = snap.data() as {
      stationId?: string;
      partIndex?: number;
      payloadChunk?: string;
    };
    if (!data.stationId || typeof data.payloadChunk !== 'string') continue;
    const list = partsByStation.get(data.stationId) ?? [];
    list.push({
      partIndex: Number(data.partIndex) || 0,
      payloadChunk: data.payloadChunk,
    });
    partsByStation.set(data.stationId, list);
  }

  const stationData: Record<string, unknown> = {};
  for (const [stationId, list] of partsByStation.entries()) {
    list.sort((a, b) => a.partIndex - b.partIndex);
    const joined = list.map((p) => p.payloadChunk).join('');
    try {
      stationData[stationId] = JSON.parse(joined);
    } catch {
      stationData[stationId] = {};
    }
  }

  const updatedAtIso =
    meta.updatedAt?.toDate?.()?.toISOString?.() ||
    meta.clientUpdatedAt ||
    new Date().toISOString();

  return {
    backup: {
      stations,
      codes,
      stationData,
      exportedAt: updatedAtIso,
    },
    stationCount: Object.keys(stations).length,
    codeCount: Object.keys(codes).length,
    subscriberCount:
      meta.subscriberCount ?? countSubscribersInStationData(stationData),
    updatedByEmail: meta.updatedByEmail || adminEmail,
    updatedAtIso,
  };
}

export async function loadStaffVaultFromFirestore(
  code: string,
): Promise<StaffVaultPayload | null> {
  try {
    const normalized = normalizeCodeForHash(code);
    const accessHash = await computeStaffAccessHash(normalized);
    const staffRef = doc(db, 'staffVault', accessHash);
    const [vaultSnap, codeDoc] = await Promise.all([
      getDocFromServer(staffRef).catch(() => getDoc(staffRef)),
      loadAccessCodeFromFirestore(normalized, true),
    ]);

    if (!vaultSnap.exists()) {
      // Fallback: if code exists in `codes` collection without staffVault yet
      if (!codeDoc) return null;
      return {
        access: codeDoc,
        station: {
          stationId: codeDoc.stationId,
          stationName: codeDoc.stationName || 'المحطة',
          kwhPriceYer: 450,
          minimumFeeYer: 1000,
          mainGeneratorKwh: 0,
          licenseCode: codeDoc.code,
          licenseStatus: 'active',
          maxCollectors: 25,
          maxSubscribers: 10000,
          ownerUid: 'developer_admin',
          updatedAt: codeDoc.updatedAt,
        },
        collectors: codeDoc.role === 'collector' ? [codeDoc] : [],
        subscribers: [],
        readings: [],
        receipts: [],
        alerts: [],
        expenses: [],
        collectorLocations: [],
      };
    }

    const data = vaultSnap.data() as {
      accessJson?: string;
      stationJson?: string;
      collectorsJson?: string;
      stationDataJson?: string;
    };

    if (!data.accessJson || !data.stationJson) return null;

    const vaultAccess = JSON.parse(data.accessJson) as AccessCodeRecord;
    const access: AccessCodeRecord = codeDoc
      ? {
          ...vaultAccess,
          active: codeDoc.active,
          pinResetAt: codeDoc.pinResetAt ?? vaultAccess.pinResetAt ?? null,
          updatedAt: codeDoc.updatedAt || vaultAccess.updatedAt,
        }
      : vaultAccess;

    const station = JSON.parse(data.stationJson) as StationConfig;
    const collectors = JSON.parse(
      data.collectorsJson || '[]',
    ) as AccessCodeRecord[];
    const bucket = JSON.parse(
      data.stationDataJson || '{}',
    ) as RawStationBucket;

    const subscribers = Object.values(bucket.subscribers ?? {}).sort(
      (a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0),
    );
    const readings = Object.values(bucket.readings ?? {}).sort((a, b) =>
      String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? '')),
    );
    const receipts = Object.values(bucket.receipts ?? {}).sort((a, b) =>
      String(b.paidAt ?? '').localeCompare(String(a.paidAt ?? '')),
    );
    const alerts = Object.values(bucket.alerts ?? {}).sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    );
    const expenses = Object.values(bucket.expenses ?? {}).sort((a, b) =>
      String(b.date || b.createdAt || '').localeCompare(
        String(a.date || a.createdAt || ''),
      ),
    );
    const collectorLocations = Object.values(
      bucket.collectorLocations ?? {},
    ).sort((a, b) =>
      String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
    );

    return {
      access,
      station,
      collectors,
      subscribers,
      readings,
      receipts,
      alerts,
      expenses,
      collectorLocations,
    };
  } catch {
    return null;
  }
}

export async function loadSubscriberPortalFromFirestore(
  identifier: string,
  phone: string,
): Promise<SubscriberLookupResult | null> {
  try {
    const nameHash = await computeSubscriberPortalHash(identifier, phone, 'name');
    let snap = await getDoc(doc(db, 'subscriberPortals', nameHash));
    if (!snap.exists()) {
      const meterHash = await computeSubscriberPortalHash(
        identifier,
        phone,
        'meter',
      );
      snap = await getDoc(doc(db, 'subscriberPortals', meterHash));
    }
    if (!snap.exists()) return null;

    const d = snap.data() as {
      stationId?: string;
      stationName?: string;
      meterNumber?: string;
      subscriberName?: string;
      zoneStreet?: string;
      previousReading?: number;
      currentReading?: number;
      consumptionKwh?: number;
      currentBillYer?: number;
      previousDebtYer?: number;
      totalDueYer?: number;
      readingsJson?: string;
      receiptsJson?: string;
      updatedAt?: Timestamp;
    };

    const readings: MeterReading[] = d.readingsJson
      ? (JSON.parse(d.readingsJson) as MeterReading[])
      : [
          {
            id: `rd_cloud_${d.meterNumber ?? '0'}`,
            subscriberId: `sub_${d.meterNumber ?? '0'}`,
            meterNumber: d.meterNumber ?? '',
            subscriberName: d.subscriberName ?? '',
            previousReading: Number(d.previousReading ?? 0),
            currentReading: Number(d.currentReading ?? 0),
            consumptionKwh: Number(d.consumptionKwh ?? 0),
            kwhPriceYer: 0,
            currentBillYer: Number(d.currentBillYer ?? 0),
            previousDebtYer: Number(d.previousDebtYer ?? 0),
            totalDueYer: Number(d.totalDueYer ?? 0),
            photoUrl: '',
            photoSizeKb: 0,
            hasLocalPhoto: false,
            collectorUid: 'cloud',
            collectorName: 'السحابة',
            recordedAt:
              d.updatedAt?.toDate?.()?.toISOString?.() ||
              new Date().toISOString(),
            syncStatus: 'synced',
          },
        ];

    const receipts: PaymentReceipt[] = d.receiptsJson
      ? (JSON.parse(d.receiptsJson) as PaymentReceipt[])
      : [];

    const subscriber: Subscriber = {
      id: `sub_${d.meterNumber ?? '0'}`,
      meterNumber: d.meterNumber ?? '',
      subscriberName: d.subscriberName ?? '',
      phone,
      previousReading: Number(d.previousReading ?? 0),
      currentReading: Number(d.currentReading ?? 0),
      previousDebtYer: Number(d.previousDebtYer ?? 0),
      zoneStreet: d.zoneStreet ?? 'عام',
      sequenceOrder: 1,
      syncStatus: 'synced',
      updatedAt:
        d.updatedAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
    };

    return {
      stationName: d.stationName || 'المحطة',
      subscriber,
      readings,
      receipts,
    };
  } catch {
    return null;
  }
}

function timestampToIso(val: unknown): string {
  if (val && typeof val === 'object' && 'toDate' in val && typeof (val as { toDate?: unknown }).toDate === 'function') {
    return (val as Timestamp).toDate().toISOString();
  }
  if (typeof val === 'string' && val) return val;
  return new Date().toISOString();
}

export async function saveCollectorReadingTextToFirestore(params: {
  stationId: string;
  reading: MeterReading;
}): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  try {
    const { reading, stationId } = params;
    const recordedDate = new Date(reading.recordedAt);
    const recordedAtTs = Timestamp.fromDate(
      Number.isNaN(recordedDate.getTime()) ? new Date() : recordedDate,
    );
    const collectorUid = sanitizeVaultDocId(
      reading.collectorUid || 'collector',
    );
    const aiStatus =
      reading.aiVerificationStatus === 'matched' ||
      reading.aiVerificationStatus === 'mismatch' ||
      reading.aiVerificationStatus === 'pending_offline'
        ? reading.aiVerificationStatus
        : 'not_checked';

    const payload: Record<string, unknown> = {
      subscriberId: sanitizeVaultDocId(reading.subscriberId),
      meterNumber: (reading.meterNumber || '00').slice(0, 40),
      subscriberName: (reading.subscriberName || 'مشترك').slice(0, 120),
      previousReading: Math.max(0, Number(reading.previousReading) || 0),
      currentReading: Math.max(0, Number(reading.currentReading) || 0),
      consumptionKwh: Math.max(0, Number(reading.consumptionKwh) || 0),
      kwhPriceYer: Math.max(0, Number(reading.kwhPriceYer) || 0),
      currentBillYer: Math.max(0, Number(reading.currentBillYer) || 0),
      previousDebtYer: Math.max(0, Number(reading.previousDebtYer) || 0),
      totalDueYer: Math.max(0, Number(reading.totalDueYer) || 0),
      photoUrl: '',
      photoSizeKb: 0,
      hasLocalPhoto: Boolean(reading.hasLocalPhoto || reading.photoUrl),
      aiVerificationStatus: aiStatus,
      collectorUid,
      collectorName: (reading.collectorName || 'المحصّل').slice(0, 120),
      recordedAt: recordedAtTs,
      createdAt: serverTimestamp(),
    };

    if (typeof reading.aiDetectedReading === 'number' && Number.isFinite(reading.aiDetectedReading)) {
      payload.aiDetectedReading = reading.aiDetectedReading;
    }
    if (typeof reading.aiConfidence === 'number' && Number.isFinite(reading.aiConfidence)) {
      const conf = reading.aiConfidence > 1 ? reading.aiConfidence / 100 : reading.aiConfidence;
      payload.aiConfidence = Math.min(1, Math.max(0, conf));
    }
    if (reading.aiVerificationReason) {
      payload.aiVerificationReason = reading.aiVerificationReason.slice(0, 300);
    }

    await setDoc(doc(db, 'stations', stationId, 'readings', sanitizeVaultDocId(reading.id)), payload);
    return true;
  } catch {
    return false;
  }
}

export async function saveCollectorReceiptTextToFirestore(params: {
  stationId: string;
  receipt: PaymentReceipt;
}): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  if (!(Number(params.receipt.amountPaidYer) > 0)) return false;

  try {
    const { receipt, stationId } = params;
    const paidDate = new Date(receipt.paidAt);
    const paidAtTs = Timestamp.fromDate(
      Number.isNaN(paidDate.getTime()) ? new Date() : paidDate,
    );
    const collectorUid = sanitizeVaultDocId(receipt.collectorUid || 'collector');

    await setDoc(doc(db, 'stations', stationId, 'receipts', sanitizeVaultDocId(receipt.id)), {
      subscriberId: sanitizeVaultDocId(receipt.subscriberId),
      meterNumber: (receipt.meterNumber || '00').slice(0, 40),
      subscriberName: (receipt.subscriberName || 'مشترك').slice(0, 120),
      readingId: sanitizeVaultDocId(receipt.readingId || `cash_${Date.now()}`),
      amountPaidYer: Math.max(1, Number(receipt.amountPaidYer)),
      remainingBalanceYer: Math.max(0, Number(receipt.remainingBalanceYer) || 0),
      collectorUid,
      collectorName: (receipt.collectorName || 'المحصّل').slice(0, 120),
      paidAt: paidAtTs,
      createdAt: serverTimestamp(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function saveCollectorAlertTextToFirestore(params: {
  stationId: string;
  alert: ManagerAlert;
}): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  if (params.alert.alertType === 'manual_edit') {
    return true;
  }

  try {
    const { alert, stationId } = params;
    const msg =
      alert.alertType === 'lower_reading'
        ? `قراءة أقل من السابقة (${alert.editedReading} مقابل ${alert.previousReading})`
        : alert.alertType === 'high_consumption'
          ? `استهلاك مرتفع (${alert.consumptionKwh ?? 0} ك.و.س مقابل متوسط ${alert.avg3MonthsKwh ?? 0})`
          : alert.aiVerificationReason || 'عدم تطابق قراءة العداد مع الصورة';

    const payload: Record<string, unknown> = {
      stationId: sanitizeVaultDocId(stationId),
      subscriberId: sanitizeVaultDocId(alert.subscriberId),
      meterNumber: (alert.meterNumber || '00').slice(0, 40),
      subscriberName: (alert.subscriberName || 'مشترك').slice(0, 120),
      collectorName: (alert.collectorName || 'المحصّل').slice(0, 120),
      alertType:
        alert.alertType === 'photo_mismatch' ||
        alert.alertType === 'lower_reading' ||
        alert.alertType === 'high_consumption'
          ? alert.alertType
          : 'lower_reading',
      editedReading: Number(alert.editedReading) || 0,
      hasLocalPhoto: true,
      message: msg.slice(0, 500),
      severity: alert.severity === 'critical' ? 'critical' : 'warning',
      resolved: alert.status !== 'pending',
      createdAt: serverTimestamp(),
    };

    if (alert.collectorCode) {
      payload.collectorCode = sanitizeVaultDocId(alert.collectorCode).slice(0, 60);
    }
    if (typeof alert.aiDetectedReading === 'number' && Number.isFinite(alert.aiDetectedReading)) {
      payload.aiDetectedReading = alert.aiDetectedReading;
    }
    if (typeof alert.aiConfidence === 'number' && Number.isFinite(alert.aiConfidence)) {
      const conf = alert.aiConfidence > 1 ? alert.aiConfidence / 100 : alert.aiConfidence;
      payload.aiConfidence = Math.min(1, Math.max(0, conf));
    }
    if (alert.aiVerificationReason) {
      payload.aiVerificationReason = alert.aiVerificationReason.slice(0, 300);
    }

    await setDoc(doc(db, 'stations', stationId, 'alerts', sanitizeVaultDocId(alert.id)), payload);
    return true;
  } catch {
    return false;
  }
}

export async function resolveManagerAlertInFirestore(params: {
  stationId: string;
  alertId: string;
  managerCode?: string;
}): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  try {
    const updatePayload: Record<string, unknown> = {
      resolved: true,
    };
    if (params.managerCode) {
      updatePayload.resolvedByCode = normalizeCodeForHash(params.managerCode);
    }
    await setDoc(
      doc(db, 'stations', params.stationId, 'alerts', sanitizeVaultDocId(params.alertId)),
      updatePayload,
      { merge: true },
    );
    return true;
  } catch {
    return false;
  }
}

export async function saveCollectorLocationToFirestore(params: {
  stationId: string;
  collectorCode: string;
  collectorName: string;
  lat: number;
  lng: number;
  accuracy?: number;
}): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  const code = normalizeCodeForHash(params.collectorCode);
  if (!code) return false;
  try {
    const payload: Record<string, unknown> = {
      collectorCode: code,
      collectorName: (params.collectorName || 'المحصّل').slice(0, 120),
      lat: params.lat,
      lng: params.lng,
      updatedAt: serverTimestamp(),
    };
    if (typeof params.accuracy === 'number' && Number.isFinite(params.accuracy) && params.accuracy >= 0) {
      payload.accuracyMeters = Math.round(params.accuracy);
    }
    await setDoc(doc(db, 'stations', params.stationId, 'collectorLocations', code), payload);
    return true;
  } catch {
    return false;
  }
}

export async function loadStationCloudActivityFromFirestore(stationId: string): Promise<{
  readings: MeterReading[];
  receipts: PaymentReceipt[];
  alerts: ManagerAlert[];
  collectorLocations: CollectorLocationRecord[];
}> {
  const safeId = sanitizeVaultDocId(stationId);
  const fetchCol = async (subName: string) => {
    const colRef = collection(db, 'stations', safeId, subName);
    try {
      return await getDocsFromServer(colRef).catch((err) => {
        if (isOfflineFirestoreError(err)) return getDocs(colRef);
        throw err;
      });
    } catch {
      return null;
    }
  };

  const [rdSnap, rcSnap, alSnap, locSnap] = await Promise.all([
    fetchCol('readings'),
    fetchCol('receipts'),
    fetchCol('alerts'),
    fetchCol('collectorLocations'),
  ]);

  const readings: MeterReading[] = [];
  rdSnap?.forEach((d) => {
    const x = d.data() as Record<string, unknown>;
    readings.push({
      id: d.id,
      subscriberId: String(x.subscriberId ?? ''),
      meterNumber: String(x.meterNumber ?? ''),
      subscriberName: String(x.subscriberName ?? ''),
      previousReading: Number(x.previousReading ?? 0),
      currentReading: Number(x.currentReading ?? 0),
      consumptionKwh: Number(x.consumptionKwh ?? 0),
      kwhPriceYer: Number(x.kwhPriceYer ?? 0),
      currentBillYer: Number(x.currentBillYer ?? 0),
      previousDebtYer: Number(x.previousDebtYer ?? 0),
      totalDueYer: Number(x.totalDueYer ?? 0),
      photoUrl: '',
      photoSizeKb: 0,
      hasLocalPhoto: Boolean(x.hasLocalPhoto),
      ...(x.aiVerificationStatus === 'matched' ||
      x.aiVerificationStatus === 'mismatch' ||
      x.aiVerificationStatus === 'pending_offline'
        ? { aiVerificationStatus: x.aiVerificationStatus }
        : {}),
      ...(typeof x.aiDetectedReading === 'number'
        ? { aiDetectedReading: x.aiDetectedReading }
        : {}),
      ...(typeof x.aiConfidence === 'number'
        ? { aiConfidence: x.aiConfidence }
        : {}),
      ...(typeof x.aiVerificationReason === 'string'
        ? { aiVerificationReason: x.aiVerificationReason }
        : {}),
      collectorUid: String(x.collectorUid ?? ''),
      collectorName: String(x.collectorName ?? 'المحصّل'),
      recordedAt: timestampToIso(x.recordedAt ?? x.createdAt),
      syncStatus: 'synced',
    });
  });

  const receipts: PaymentReceipt[] = [];
  rcSnap?.forEach((d) => {
    const x = d.data() as Record<string, unknown>;
    receipts.push({
      id: d.id,
      subscriberId: String(x.subscriberId ?? ''),
      meterNumber: String(x.meterNumber ?? ''),
      subscriberName: String(x.subscriberName ?? ''),
      readingId: String(x.readingId ?? ''),
      amountPaidYer: Number(x.amountPaidYer ?? 0),
      remainingBalanceYer: Number(x.remainingBalanceYer ?? 0),
      collectorUid: String(x.collectorUid ?? ''),
      collectorName: String(x.collectorName ?? 'المحصّل'),
      paidAt: timestampToIso(x.paidAt ?? x.createdAt),
      syncStatus: 'synced',
    });
  });

  const alerts: ManagerAlert[] = [];
  alSnap?.forEach((d) => {
    const x = d.data() as Record<string, unknown>;
    alerts.push({
      id: d.id,
      stationId: String(x.stationId ?? safeId),
      alertType:
        x.alertType === 'photo_mismatch' ||
        x.alertType === 'high_consumption' ||
        x.alertType === 'lower_reading'
          ? x.alertType
          : 'lower_reading',
      severity: x.severity === 'critical' ? 'critical' : 'warning',
      status: x.resolved === true ? 'approved' : 'pending',
      readingId: String(x.readingId ?? d.id),
      subscriberId: String(x.subscriberId ?? ''),
      subscriberName: String(x.subscriberName ?? ''),
      meterNumber: String(x.meterNumber ?? ''),
      collectorName: String(x.collectorName ?? 'المحصّل'),
      ...(typeof x.collectorCode === 'string'
        ? { collectorCode: x.collectorCode }
        : {}),
      editedReading: Number(x.editedReading ?? 0),
      previousReading: Number(x.previousReading ?? 0),
      ...(typeof x.aiDetectedReading === 'number'
        ? { aiDetectedReading: x.aiDetectedReading }
        : {}),
      ...(typeof x.aiConfidence === 'number'
        ? { aiConfidence: x.aiConfidence }
        : {}),
      ...(typeof x.aiVerificationReason === 'string'
        ? { aiVerificationReason: x.aiVerificationReason }
        : {}),
      photoUrl: '',
      createdAt: timestampToIso(x.createdAt),
      syncStatus: 'synced',
    });
  });

  const collectorLocations: CollectorLocationRecord[] = [];
  locSnap?.forEach((d) => {
    const x = d.data() as Record<string, unknown>;
    collectorLocations.push({
      collectorCode: String(x.collectorCode ?? d.id),
      collectorName: String(x.collectorName ?? 'المحصّل'),
      lat: Number(x.lat ?? 0),
      lng: Number(x.lng ?? 0),
      ...(typeof x.accuracyMeters === 'number'
        ? { accuracy: x.accuracyMeters }
        : {}),
      updatedAt: timestampToIso(x.updatedAt),
    });
  });

  readings.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  receipts.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  alerts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  collectorLocations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { readings, receipts, alerts, collectorLocations };
}

