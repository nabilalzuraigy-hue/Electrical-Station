import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  type Timestamp,
} from 'firebase/firestore';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
} from './firebase';
import type { AccessCodeRecord, StationConfig } from '../types/station';

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

const MAX_CHUNK_CHARS = 380000;

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

function stripPhotosFromStationBucket(bucket: unknown): unknown {
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

  return next;
}

export async function saveAdminStoreToFirestore(
  backup: AdminStoreBackupPayload,
): Promise<{
  stationCount: number;
  codeCount: number;
  subscriberCount: number;
  updatedAtIso: string;
}> {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('يجب تسجيل الدخول بحساب الأدمن المطور في Google أولاً.');
  }

  const stationIds = Object.keys(backup.stations ?? {});
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

  const stationCount = stationIds.length;
  const codeCount = Object.keys(backup.codes ?? {}).length;
  const subscriberCount = countSubscribersInStationData(backup.stationData ?? {});
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
