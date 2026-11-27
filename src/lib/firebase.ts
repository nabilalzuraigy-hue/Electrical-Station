import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  setPersistence,
  signInWithEmailAndPassword,
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
export const ADMIN_GOOGLE_EMAIL = 'nabilalzuraigy@gmail.com';

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
export const auth = getAuth(app);
void setPersistence(auth, browserLocalPersistence).catch(() => {
  // Fallback to default browser persistence in restricted environments
});
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

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
    return `صلاحيات Firebase مقصورة على حساب الأدمن المطور المعتمد (${ADMIN_GOOGLE_EMAIL}). يرجى ربط الحساب الصحيح ونشر قواعد Firestore المحدّثة.`;
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

  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found' ||
    msg.includes('invalid-credential') ||
    msg.includes('wrong-password') ||
    msg.includes('user-not-found')
  ) {
    return `كلمة المرور غير صحيحة أو أن حساب ${ADMIN_GOOGLE_EMAIL} غير مضاف بمزود Email/Password في Firebase Authentication.`;
  }
  if (code === 'auth/invalid-email' || msg.includes('invalid-email')) {
    return 'صيغة البريد الإلكتروني غير صحيحة.';
  }
  if (code === 'auth/too-many-requests' || msg.includes('too-many-requests')) {
    return 'تم حظر المحاولات مؤقتاً لكثرة الإدخال الخاطئ. انتظر قليلاً ثم حاول مجدداً.';
  }
  if (code === 'auth/user-disabled' || msg.includes('user-disabled')) {
    return 'تم تعطيل حساب المطور في Firebase Authentication.';
  }
  if (code === 'auth/operation-not-allowed' || msg.includes('operation-not-allowed')) {
    return `مزود تسجيل الدخول (Google أو Email/Password) غير مفعل في مشروع Firebase (${FIREBASE_PROJECT_ID}).`;
  }
  if (code === 'auth/unauthorized-domain' || msg.includes('unauthorized-domain')) {
    return `هذا النطاق غير مضاف في قائمة النطاقات المصرح بها (Authorized domains) في Firebase Authentication للمشروع ${FIREBASE_PROJECT_ID}.`;
  }
  if (code === 'auth/popup-blocked' || msg.includes('popup-blocked')) {
    return 'تم حظر نافذة تسجيل الدخول من المتصفح. يرجى السماح بالنوافذ المنبثقة لهذا الموقع والمحاولة مجدداً.';
  }
  if (code === 'auth/popup-closed-by-user' || msg.includes('popup-closed-by-user')) {
    return 'تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.';
  }
  return msg || 'تعذر إتمام تسجيل الدخول بحساب Firebase.';
}

export function resolveDeveloperAdminEmail(identifier: string): string | null {
  const trimmed = identifier.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === ADMIN_GOOGLE_EMAIL.toLowerCase()) {
    return ADMIN_GOOGLE_EMAIL;
  }
  if (
    normalizeArabicIdentifierForHash(trimmed) ===
    normalizeArabicIdentifierForHash('نبيل الزريقي')
  ) {
    return ADMIN_GOOGLE_EMAIL;
  }
  return null;
}

export async function signInDeveloperWithEmailPassword(
  email: string,
  password: string,
): Promise<User> {
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  const result = await signInWithEmailAndPassword(auth, email.trim(), password);
  return result.user;
}

export async function sendDeveloperVerificationEmail(): Promise<void> {
  if (!auth.currentUser) {
    throw new Error('لا يوجد مستخدم مسجل حالياً.');
  }
  await sendEmailVerification(auth.currentUser);
}

export async function signInWithGooglePopup(): Promise<User> {
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export function subscribeToAuth(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

export function isAuthorizedAdminUser(user: User | null): boolean {
  return Boolean(
    user?.email &&
      user.email.trim().toLowerCase() === ADMIN_GOOGLE_EMAIL.toLowerCase(),
  );
}

export async function getFirebaseAdminIdToken(
  user: User | null = auth.currentUser,
): Promise<string | null> {
  if (!user || !isAuthorizedAdminUser(user)) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
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
  const digits = raw.replace(/[٠-٩]/g, (d) =>
    String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)),
  ).replace(/\D/g, '');
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
