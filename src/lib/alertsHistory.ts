import { idbGet, idbSet } from './indexedDbCache';

export const ALERTS_HISTORY_STORAGE_KEY = 'alerts_history';

export interface AlertHistoryEntry {
  id: string;
  stationId: string;
  sourceType: 'zone_loss' | 'field_alert';
  severity: 'critical' | 'warning';
  zoneName: string;
  valueSummary: string;
  message: string;
  createdAt: string;
  statusLabel?: string;
}

function readLocalStorageHistory(): AlertHistoryEntry[] {
  try {
    const raw = localStorage.getItem(ALERTS_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AlertHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeLocalStorageHistory(entries: AlertHistoryEntry[]): void {
  try {
    localStorage.setItem(
      ALERTS_HISTORY_STORAGE_KEY,
      JSON.stringify(entries.slice(0, 500)),
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function loadAlertsHistorySync(stationId: string): AlertHistoryEntry[] {
  return readLocalStorageHistory()
    .filter((entry) => entry && entry.stationId === stationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadAlertsHistory(
  stationId: string,
): Promise<AlertHistoryEntry[]> {
  const lsEntries = readLocalStorageHistory();
  let idbEntries: AlertHistoryEntry[] = [];
  try {
    const val = await idbGet<AlertHistoryEntry[]>(ALERTS_HISTORY_STORAGE_KEY);
    if (Array.isArray(val)) idbEntries = val;
  } catch {
    // Fallback to localStorage only
  }

  const mergedMap = new Map<string, AlertHistoryEntry>();
  for (const item of [...idbEntries, ...lsEntries]) {
    if (item && item.id && item.stationId) {
      const prev = mergedMap.get(item.id);
      if (!prev || item.createdAt >= prev.createdAt) {
        mergedMap.set(item.id, item);
      }
    }
  }

  const allMerged = Array.from(mergedMap.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  if (allMerged.length > 0) {
    writeLocalStorageHistory(allMerged);
    void idbSet(ALERTS_HISTORY_STORAGE_KEY, allMerged.slice(0, 500)).catch(
      () => {},
    );
  }

  return allMerged.filter((e) => e.stationId === stationId);
}

export async function appendAlertsHistory(
  stationId: string,
  incoming: AlertHistoryEntry[],
): Promise<AlertHistoryEntry[]> {
  if (incoming.length === 0) {
    return loadAlertsHistory(stationId);
  }

  const existingAll = readLocalStorageHistory();
  let idbExisting: AlertHistoryEntry[] = [];
  try {
    const val = await idbGet<AlertHistoryEntry[]>(ALERTS_HISTORY_STORAGE_KEY);
    if (Array.isArray(val)) idbExisting = val;
  } catch {
    // Fallback to localStorage
  }

  const map = new Map<string, AlertHistoryEntry>();
  for (const item of [...idbExisting, ...existingAll]) {
    if (item && item.id && item.stationId) {
      map.set(item.id, item);
    }
  }

  let changed = false;
  for (const entry of incoming) {
    if (!entry || !entry.id || entry.stationId !== stationId) continue;
    const prev = map.get(entry.id);
    if (!prev) {
      map.set(entry.id, entry);
      changed = true;
    } else if (
      prev.statusLabel !== entry.statusLabel ||
      prev.valueSummary !== entry.valueSummary ||
      prev.message !== entry.message
    ) {
      // Preserve original timestamp when updating status label
      map.set(entry.id, { ...entry, createdAt: prev.createdAt });
      changed = true;
    }
  }

  const allSorted = Array.from(map.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 500);

  if (changed) {
    writeLocalStorageHistory(allSorted);
    await idbSet(ALERTS_HISTORY_STORAGE_KEY, allSorted).catch(() => {});
  }

  return allSorted.filter((e) => e.stationId === stationId);
}
