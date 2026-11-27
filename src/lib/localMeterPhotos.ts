import { idbGet, idbSet } from './indexedDbCache';

export interface LocalMeterPhotoEntry {
  id: string;
  stationId: string;
  subscriberId: string;
  subscriberName: string;
  meterNumber: string;
  readingValue?: number;
  collectorName: string;
  capturedAt: string;
  dataUrl: string;
  sizeKb: number;
  sentToManager: boolean;
  sentAt?: string;
}

const PHOTOS_KEY_PREFIX = 'local_meter_photos_v1_';

function photosKey(stationId: string): string {
  return `${PHOTOS_KEY_PREFIX}${stationId}`;
}

export async function loadLocalMeterPhotos(
  stationId: string,
): Promise<LocalMeterPhotoEntry[]> {
  if (!stationId) return [];
  const stored = await idbGet<LocalMeterPhotoEntry[]>(photosKey(stationId));
  if (!Array.isArray(stored)) return [];
  return [...stored].sort((a, b) =>
    String(b.capturedAt ?? '').localeCompare(String(a.capturedAt ?? '')),
  );
}

export async function saveLocalMeterPhoto(
  entry: LocalMeterPhotoEntry,
): Promise<LocalMeterPhotoEntry[]> {
  const existing = await loadLocalMeterPhotos(entry.stationId);
  const filtered = existing.filter((item) => item.id !== entry.id);
  const next = [entry, ...filtered];
  await idbSet(photosKey(entry.stationId), next);
  return next;
}

export async function updateLocalMeterPhotoReading(
  stationId: string,
  photoId: string,
  readingValue: number,
): Promise<LocalMeterPhotoEntry[]> {
  const existing = await loadLocalMeterPhotos(stationId);
  const next = existing.map((item) =>
    item.id === photoId ? { ...item, readingValue } : item,
  );
  await idbSet(photosKey(stationId), next);
  return next;
}

export async function markLocalMeterPhotosSent(
  stationId: string,
  photoIds: string[],
): Promise<LocalMeterPhotoEntry[]> {
  const idSet = new Set(photoIds);
  const now = new Date().toISOString();
  const existing = await loadLocalMeterPhotos(stationId);
  const next = existing.map((item) =>
    idSet.has(item.id)
      ? {
          ...item,
          sentToManager: true,
          sentAt: item.sentAt || now,
        }
      : item,
  );
  await idbSet(photosKey(stationId), next);
  return next;
}
