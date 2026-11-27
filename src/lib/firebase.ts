import { initializeApp } from 'firebase/app';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD4VX6i8bI67lfp8pXfNtAS3suXPolBVjY',
  authDomain: 'electricity-station-f5a90.firebaseapp.com',
  projectId: 'electricity-station-f5a90',
  storageBucket: 'electricity-station-f5a90.firebasestorage.app',
  messagingSenderId: '479970825408',
  appId: '1:479970825408:web:ac783bf0eaad05bdeb4925',
} as const;

export const FIREBASE_PROJECT_ID = FIREBASE_CONFIG.projectId;
export const FIREBASE_DATABASE_ID = '(default)';

const app = initializeApp(FIREBASE_CONFIG);

function createFirestoreClient(): Firestore {
  try {
    return initializeFirestore(app, {
      experimentalAutoDetectLongPolling: true,
      ignoreUndefinedProperties: true,
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    return getFirestore(app);
  }
}

export const db = createFirestoreClient();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  try {
    const check = getDocFromServer(doc(db, 'test', 'connection'));
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 4000),
    );
    await Promise.race([check, timeout]);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const msg = error instanceof Error ? error.message : String(error);
    if (
      code === 'unavailable' ||
      msg.includes('timeout') ||
      msg.includes('the client is offline') ||
      msg.includes('Could not reach Cloud Firestore backend')
    ) {
      return false;
    }
    return true;
  }
}

export function formatFirestoreUserMessage(
  error: unknown,
  fallback: string,
): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  let inner = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (parsed && typeof parsed.error === 'string') {
      inner = parsed.error;
    }
  } catch {
    // plain message
  }

  const lower = inner.toLowerCase();
  if (
    lower.includes('unavailable') ||
    lower.includes('offline') ||
    lower.includes('could not reach')
  ) {
    return 'تعذر الوصول إلى خادم Firebase Firestore حالياً. تحقق من اتصال الإنترنت أو حاول مجدداً بعد لحظة (البيانات المحلية محفوظة بأمان).';
  }
  if (
    lower.includes('permission-denied') ||
    lower.includes('insufficient permissions')
  ) {
    return 'تعذر تنفيذ العملية بسبب قواعد صلاحيات Firebase Firestore. يرجى نشر ملف firestore.rules المحدّث على المشروع.';
  }
  if (lower.includes('quota exceeded')) {
    return 'تم تجاوز حصة الاستخدام المجانية اليومية في Firebase Firestore.';
  }
  return inner || fallback;
}

async function sha256Hex(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeCodeForHash(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

export function normalizeArabicIdentifierForHash(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

export function normalizePhoneForHash(raw: string): string {
  const digits = raw
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\D/g, '');
  if (digits.startsWith('00967')) return digits.slice(5);
  if (digits.startsWith('967') && digits.length >= 11) return digits.slice(3);
  if (digits.startsWith('0') && digits.length === 10) return digits.slice(1);
  return digits;
}

export async function computeStaffAccessHash(code: string): Promise<string> {
  return sha256Hex(`staff:${normalizeCodeForHash(code)}`);
}

export async function computeSubscriberPortalHash(
  identifier: string,
  phone: string,
  kind: 'name' | 'meter' = 'name',
): Promise<string> {
  const normPhone = normalizePhoneForHash(phone);
  if (kind === 'meter') {
    return sha256Hex(`sub_meter:${identifier.trim().toLowerCase()}:${normPhone}`);
  }
  return sha256Hex(
    `sub_name:${normalizeArabicIdentifierForHash(identifier)}:${normPhone}`,
  );
}
