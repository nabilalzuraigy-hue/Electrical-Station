import {
  Timestamp,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import {
  auth,
  computeStaffAccessHash,
  computeSubscriberPortalHash,
  db,
  handleFirestoreError,
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

  // Trim oldest readings/receipts/alerts first while keeping all subscribers intact
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

async function syncStaffAndPortalCachesToFirestore(
  backup: AdminStoreBackupPayload,
  userEmail: string,
): Promise<void> {
  const stations = backup.stations ?? {};
  const codes = Object.values(backup.codes ?? {});
  const stationData = backup.stationData ?? {};

  // 1. Sync per-code staffVault/{accessHash} docs so Managers & Collectors restore on any device
  for (const codeRec of codes) {
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
        updatedByEmail: userEmail,
        updatedAt: serverTimestamp(),
      });
    } catch {
      // Non-blocking: adminVault already succeeded; staffVault awaits rules publish if needed
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
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('يجب تسجيل الدخول بحساب الأدمن المطور في Google أولاً.');
  }

  const stationIds = Object.keys(backup.stations ?? {});
  const stationCount = stationIds.length;
  const codeCount = Object.keys(backup.codes ?? {}).length;
  const subscriberCount = countSubscribersInStationData(backup.stationData ?? {});

  // Guard: NEVER wipe a non-empty cloud vault with an empty local/restarted store
  if (stationCount === 0 && codeCount === 0 && !options?.allowEmptyOverwrite) {
    try {
      const existingSnap = await getDoc(doc(db, 'adminVault', 'meta'));
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
          updatedByEmail: user.email,
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
    updatedByEmail: user.email,
    clientUpdatedAt: nowIso,
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'adminVault', 'meta'), metaDoc);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'adminVault/meta');
  }

  // Also sync per-code staffVault & subscriberPortals in background (non-blocking)
  void syncStaffAndPortalCachesToFirestore(backup, user.email);

  return {
    stationCount,
    codeCount,
    subscriberCount,
    updatedAtIso: nowIso,
  };
}

export async function loadAdminStoreFromFirestore(): Promise<FirestoreVaultSnapshot | null> {
  const user = auth.currentUser;
  if (!user) return null;

  let metaSnap;
  try {
    metaSnap = await getDoc(doc(db, 'adminVault', 'meta'));
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'adminVault/meta');
  }

  if (!metaSnap.exists()) {
    return null;
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

  const partsByStation = new Map<
    string,
    Array<{ partIndex: number; payloadChunk: string }>
  >();

  for (const partDocId of meta.partDocs ?? []) {
    const path = `adminVault/${partDocId}`;
    let snap;
    try {
      snap = await getDoc(doc(db, 'adminVault', partDocId));
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
    stationCount: meta.stationCount ?? Object.keys(stations).length,
    codeCount: meta.codeCount ?? Object.keys(codes).length,
    subscriberCount:
      meta.subscriberCount ?? countSubscribersInStationData(stationData),
    updatedByEmail: meta.updatedByEmail || user.email || '',
    updatedAtIso,
  };
}

export async function loadStaffVaultFromFirestore(
  code: string,
): Promise<StaffVaultPayload | null> {
  try {
    const accessHash = await computeStaffAccessHash(code);
    const snap = await getDoc(doc(db, 'staffVault', accessHash));
    if (!snap.exists()) return null;

    const data = snap.data() as {
      accessJson?: string;
      stationJson?: string;
      collectorsJson?: string;
      stationDataJson?: string;
    };

    if (!data.accessJson || !data.stationJson) return null;

    const access = JSON.parse(data.accessJson) as AccessCodeRecord;
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

export async function saveCollectorReadingTextToFirestore(params: {
  stationId: string;
  reading: MeterReading;
}): Promise<boolean> {
  const user = auth.currentUser;
  if (!user) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  try {
    const { reading, stationId } = params;
    const recordedDate = new Date(reading.recordedAt);
    const recordedAtTs = Timestamp.fromDate(
      Number.isNaN(recordedDate.getTime()) ? new Date() : recordedDate,
    );
    await setDoc(doc(db, 'stations', stationId, 'readings', reading.id), {
      subscriberId: reading.subscriberId,
      meterNumber: reading.meterNumber,
      subscriberName: reading.subscriberName,
      previousReading: reading.previousReading,
      currentReading: Math.max(reading.previousReading, reading.currentReading),
      consumptionKwh: reading.consumptionKwh,
      kwhPriceYer: reading.kwhPriceYer,
      currentBillYer: reading.currentBillYer,
      previousDebtYer: reading.previousDebtYer,
      totalDueYer: reading.totalDueYer,
      photoUrl: '',
      photoSizeKb: 0,
      hasLocalPhoto: Boolean(reading.hasLocalPhoto || reading.photoUrl),
      collectorUid: user.uid,
      collectorName: reading.collectorName,
      recordedAt: recordedAtTs,
      createdAt: serverTimestamp(),
    });
    return true;
  } catch {
    return false;
  }
}

