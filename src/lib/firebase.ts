import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';

import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

function createFirestoreClient(): Firestore {
  try {
    return initializeFirestore(
      app,
      {
        experimentalForceLongPolling: true,
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      },
      firebaseConfig.firestoreDatabaseId,
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
}

export const db = createFirestoreClient();
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;
export const FIREBASE_DATABASE_ID = firebaseConfig.firestoreDatabaseId;

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
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
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
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const msg = error instanceof Error ? error.message : String(error);
    if (
      code === 'unavailable' ||
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
    return 'صلاحيات Firebase مقصورة على حساب الأدمن المطور المعتمد (nabilalzuraigy@gmail.com). يرجى ربط الحساب الصحيح.';
  }
  if (lower.includes('quota exceeded')) {
    return 'تم تجاوز حصة الاستخدام المجانية اليومية في Firebase Firestore.';
  }
  return inner || fallback;
}

export function formatAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const msg = error instanceof Error ? error.message : String(error);

  if (code === 'auth/operation-not-allowed' || msg.includes('operation-not-allowed')) {
    return `مزود تسجيل الدخول عبر Google غير مفعل في مشروع Firebase (${firebaseConfig.projectId}).`;
  }
  if (code === 'auth/unauthorized-domain' || msg.includes('unauthorized-domain')) {
    return 'هذا النطاق غير مضاف في قائمة النطاقات المصرح بها (Authorized domains) في Firebase Authentication.';
  }
  if (code === 'auth/popup-blocked' || msg.includes('popup-blocked')) {
    return 'تم حظر نافذة تسجيل الدخول من المتصفح. يرجى السماح بالنوافذ المنبثقة لهذا الموقع والمحاولة مجدداً.';
  }
  if (code === 'auth/popup-closed-by-user' || msg.includes('popup-closed-by-user')) {
    return 'تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.';
  }
  return msg || 'تعذر إتمام تسجيل الدخول بحساب Google.';
}

export async function signInWithGooglePopup(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export function subscribeToAuth(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

export async function computeSubscriberPortalHash(
  meterNumber: string,
  phone: string,
): Promise<string> {
  const normalizedMeter = meterNumber.trim();
  const normalizedPhone = phone.replace(/\s+/g, '').trim();
  const data = new TextEncoder().encode(`${normalizedMeter}:${normalizedPhone}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
