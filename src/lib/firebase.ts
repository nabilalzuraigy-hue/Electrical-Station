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
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyD4VX6i8bI67lfp8pXfNtAS3suXPolBVjY',
  authDomain: 'electricity-station-f5a90.firebaseapp.com',
  projectId: 'electricity-station-f5a90',
  storageBucket: 'electricity-station-f5a90.firebasestorage.app',
  messagingSenderId: '479970825408',
  appId: '1:479970825408:web:ac783bf0eaad05bdeb4925',
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

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
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return false;
    }
    return true;
  }
}

export function formatAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const msg = error instanceof Error ? error.message : String(error);

  if (code === 'auth/operation-not-allowed' || msg.includes('operation-not-allowed')) {
    return 'مزود تسجيل الدخول عبر Google غير مفعل بعد في مشروع Firebase (electricity-station-f5a90). يرجى تفعيل Google من Authentication -> Sign-in method ثم إعادة المحاولة.';
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
