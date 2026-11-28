import { idbDel, idbGet, idbSet } from './indexedDbCache';
import type { AccessCodeRecord } from '../types/station';

// SHA-256 digest of the developer passcode (never stored in plaintext)
const DEVELOPER_PASSCODE_SHA256 =
  'f70bac98e825ee6f6e13931b4306ce8f4f33d99fd96851e1649d8bf03f5c9c36';

const DEVICE_BINDING_IDB_KEY = 'elec_device_binding_v1';
const DEVICE_BINDING_LS_KEY = 'elec_device_binding_v1';
const DEV_SESSION_IDB_KEY = 'elec_developer_session_v1';
const DEV_SESSION_LS_KEY = 'elec_developer_session_v1';

export interface DeviceCodeBinding {
  boundCode: string;
  role: 'manager' | 'collector';
  stationId: string;
  stationName: string;
  name: string;
  pinHash: string;
  boundAt: string;
  cachedAccess: AccessCodeRecord;
}

export interface DeveloperSession {
  token: string;
  name: string;
  savedAt: string;
  expiresAt: number;
}

export function normalizePinDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\D/g, '')
    .slice(0, 4);
}

export function isValidFourDigitPin(raw: string): boolean {
  return /^\d{4}$/.test(normalizePinDigits(raw));
}

async function sha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyDeveloperPasscodeStatic(
  passcode: string,
): Promise<boolean> {
  const normalized = passcode.trim();
  if (!normalized) return false;
  const hash = await sha256Hex(normalized);
  return hash === DEVELOPER_PASSCODE_SHA256;
}

async function hashLocalPin(boundCode: string, pin4: string): Promise<string> {
  const code = boundCode.trim().toUpperCase();
  const digits = normalizePinDigits(pin4);
  return sha256Hex(`local_device_pin_v1:${code}:${digits}`);
}

export async function saveDeveloperSession(params: {
  token: string;
  name?: string;
}): Promise<DeveloperSession> {
  const session: DeveloperSession = {
    token: params.token,
    name: params.name || 'الأدمن المطور',
    savedAt: new Date().toISOString(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  await idbSet(DEV_SESSION_IDB_KEY, session);
  try {
    localStorage.setItem(DEV_SESSION_LS_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage quota errors
  }
  return session;
}

export async function loadDeveloperSession(): Promise<DeveloperSession | null> {
  try {
    const idbVal = await idbGet<DeveloperSession>(DEV_SESSION_IDB_KEY);
    if (idbVal && idbVal.token && idbVal.expiresAt > Date.now()) {
      return idbVal;
    }
  } catch {
    // Fall back to localStorage
  }

  try {
    const raw = localStorage.getItem(DEV_SESSION_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeveloperSession;
    if (parsed && parsed.token && parsed.expiresAt > Date.now()) {
      await idbSet(DEV_SESSION_IDB_KEY, parsed);
      return parsed;
    }
  } catch {
    // Ignore invalid JSON
  }
  return null;
}

export async function clearDeveloperSession(): Promise<void> {
  await idbDel(DEV_SESSION_IDB_KEY);
  try {
    localStorage.removeItem(DEV_SESSION_LS_KEY);
  } catch {
    // Ignore
  }
}

export async function getDeviceBinding(): Promise<DeviceCodeBinding | null> {
  try {
    const idbVal = await idbGet<DeviceCodeBinding>(DEVICE_BINDING_IDB_KEY);
    if (idbVal && idbVal.boundCode && idbVal.cachedAccess) {
      return idbVal;
    }
  } catch {
    // Fall back to localStorage
  }

  try {
    const raw = localStorage.getItem(DEVICE_BINDING_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeviceCodeBinding;
    if (parsed && parsed.boundCode && parsed.cachedAccess) {
      await idbSet(DEVICE_BINDING_IDB_KEY, parsed);
      return parsed;
    }
  } catch {
    // Ignore
  }
  return null;
}

async function persistDeviceBinding(binding: DeviceCodeBinding): Promise<void> {
  await idbSet(DEVICE_BINDING_IDB_KEY, binding);
  try {
    localStorage.setItem(DEVICE_BINDING_LS_KEY, JSON.stringify(binding));
  } catch {
    // Ignore storage errors
  }
}

export async function saveDeviceBinding(params: {
  access: AccessCodeRecord;
  pin4: string;
}): Promise<DeviceCodeBinding> {
  const digits = normalizePinDigits(params.pin4);
  if (!isValidFourDigitPin(digits)) {
    throw new Error('يجب أن يتكون رمز PIN من 4 أرقام فقط.');
  }
  const boundCode = params.access.code.trim().toUpperCase();
  const pinHash = await hashLocalPin(boundCode, digits);
  const binding: DeviceCodeBinding = {
    boundCode,
    role: params.access.role,
    stationId: params.access.stationId,
    stationName: params.access.stationName,
    name: params.access.name,
    pinHash,
    boundAt: new Date().toISOString(),
    cachedAccess: params.access,
  };
  await persistDeviceBinding(binding);
  return binding;
}

export async function verifyDevicePin(
  binding: DeviceCodeBinding,
  pin4: string,
): Promise<boolean> {
  if (!binding.pinHash) return false;
  const digits = normalizePinDigits(pin4);
  if (!isValidFourDigitPin(digits)) return false;
  const computed = await hashLocalPin(binding.boundCode, digits);
  return computed === binding.pinHash;
}

export async function updateDeviceBindingAccess(
  access: AccessCodeRecord,
): Promise<DeviceCodeBinding | null> {
  const current = await getDeviceBinding();
  if (!current || current.boundCode !== access.code.trim().toUpperCase()) {
    return current;
  }
  const next: DeviceCodeBinding = {
    ...current,
    role: access.role,
    stationId: access.stationId,
    stationName: access.stationName,
    name: access.name,
    cachedAccess: access,
  };
  await persistDeviceBinding(next);
  return next;
}

export async function clearDevicePinForReset(): Promise<DeviceCodeBinding | null> {
  const current = await getDeviceBinding();
  if (!current) return null;
  const next: DeviceCodeBinding = {
    ...current,
    pinHash: '',
  };
  await persistDeviceBinding(next);
  return next;
}

export async function clearDeviceBinding(): Promise<void> {
  try {
    localStorage.removeItem(DEVICE_BINDING_LS_KEY);
  } catch {
    // Ignore
  }
  await idbDel(DEVICE_BINDING_IDB_KEY);
}
