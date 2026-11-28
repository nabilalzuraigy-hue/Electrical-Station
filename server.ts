import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';
import express, { type NextFunction, type Request, type Response } from 'express';

interface CollectorPermissions {
  canRecordReadings: boolean;
  canCollectCash: boolean;
  canSendInvoices: boolean;
  canViewDebts: boolean;
}

interface AccessCodeRecord {
  code: string;
  role: 'manager' | 'collector';
  name: string;
  phone: string;
  stationId: string;
  stationName: string;
  assignedZones: string[];
  permissions: CollectorPermissions;
  active: boolean;
  createdBy?: string;
  pinResetAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StationRecord {
  stationId: string;
  stationName: string;
  kwhPriceYer: number;
  minimumFeeYer: number;
  mainGeneratorKwh: number;
  licenseStatus: 'active' | 'suspended';
  maxCollectors: number;
  maxSubscribers: number;
  zoneGeneratorKwh?: Record<string, number>;
  aiPhotoVerificationEnabled?: boolean;
  aiPhotoVerificationSealed?: string;
  aiPhotoVerificationSealedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface SubscriberRecord {
  id: string;
  meterNumber: string;
  subscriberName: string;
  phone: string;
  previousReading: number;
  currentReading: number;
  previousDebtYer: number;
  last3MonthsAvgKwh?: number;
  zoneStreet: string;
  sequenceOrder: number;
  updatedAt: string;
}

interface MeterReadingRecord {
  id: string;
  subscriberId: string;
  meterNumber: string;
  subscriberName: string;
  previousReading: number;
  currentReading: number;
  consumptionKwh: number;
  kwhPriceYer: number;
  currentBillYer: number;
  previousDebtYer: number;
  totalDueYer: number;
  photoUrl: string;
  photoSizeKb: number;
  hasLocalPhoto?: boolean;
  readingSource?: 'camera_ocr' | 'manual_override';
  ocrConfidence?: number;
  ocrOriginalReading?: number;
  wasManuallyEdited?: boolean;
  editedAt?: string;
  approvalStatus?: 'approved' | 'pending_manager' | 'rejected';
  lowerReadingReason?: 'meter_replaced' | 'meter_reset' | 'previous_error';
  newMeterNumber?: string;
  openingReading?: number;
  isClosedHouseZero?: boolean;
  zeroConsumptionNote?: string;
  highConsumptionWarning?: boolean;
  aiVerificationStatus?: 'matched' | 'mismatch' | 'pending_offline' | 'skipped';
  aiDetectedReading?: number;
  aiConfidence?: number;
  aiVerificationReason?: string;
  gpsLat?: number;
  gpsLng?: number;
  gpsAccuracy?: number;
  collectorCode: string;
  collectorName: string;
  recordedAt: string;
}

interface ManagerAlertRecord {
  id: string;
  stationId: string;
  alertType: 'photo_mismatch' | 'manual_edit' | 'high_consumption' | 'lower_reading';
  severity: 'critical' | 'warning';
  status: 'pending' | 'approved' | 'rejected';
  readingId: string;
  subscriberId: string;
  subscriberName: string;
  meterNumber: string;
  collectorName: string;
  collectorCode?: string;
  ocrOriginalReading?: number;
  editedReading: number;
  previousReading: number;
  difference?: number;
  consumptionKwh?: number;
  avg3MonthsKwh?: number;
  lowerReadingReason?: 'meter_replaced' | 'meter_reset' | 'previous_error';
  newMeterNumber?: string;
  openingReading?: number;
  aiDetectedReading?: number;
  aiConfidence?: number;
  aiVerificationReason?: string;
  photoUrl: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  managerNote?: string;
}

interface PaymentReceiptRecord {
  id: string;
  subscriberId: string;
  meterNumber: string;
  subscriberName: string;
  readingId: string;
  amountPaidYer: number;
  remainingBalanceYer: number;
  collectorCode: string;
  collectorName: string;
  paidAt: string;
}

interface DieselExpenseRecord {
  id: string;
  stationId: string;
  date: string;
  category: 'diesel' | 'oil_maintenance' | 'salaries' | 'other';
  liters?: number;
  pricePerLiterYer?: number;
  amountYer: number;
  note: string;
  createdBy?: string;
  createdAt: string;
}

interface CollectorLocationRecord {
  collectorCode: string;
  collectorName: string;
  lat: number;
  lng: number;
  accuracy?: number;
  lastSubscriberName?: string;
  lastMeterNumber?: string;
  zoneStreet?: string;
  updatedAt: string;
}

interface StationDataBucket {
  subscribers: Record<string, SubscriberRecord>;
  readings: Record<string, MeterReadingRecord>;
  receipts: Record<string, PaymentReceiptRecord>;
  alerts: Record<string, ManagerAlertRecord>;
  expenses?: Record<string, DieselExpenseRecord>;
  collectorLocations?: Record<string, CollectorLocationRecord>;
}

interface PersistentStore {
  adminPasscodeHash: string | null;
  sessionSecret?: string;
  stations: Record<string, StationRecord>;
  codes: Record<string, AccessCodeRecord>;
  stationData: Record<string, StationDataBucket>;
}

interface SessionPayload {
  role: 'admin' | 'manager' | 'collector';
  name: string;
  code?: string;
  stationId?: string;
  exp: number;
}

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'station_store.json');
const BACKUP_STORE_FILE = path.join(DATA_DIR, 'station_store.backup.json');
const SECRET_FILE = path.join(DATA_DIR, '.session_secret');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const geminiAi = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function tryReadStoreFile(filePath: string): PersistentStore | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistentStore>;
    return {
      adminPasscodeHash: parsed.adminPasscodeHash ?? null,
      ...(typeof parsed.sessionSecret === 'string' && parsed.sessionSecret
        ? { sessionSecret: parsed.sessionSecret }
        : {}),
      stations: parsed.stations ?? {},
      codes: parsed.codes ?? {},
      stationData: parsed.stationData ?? {},
    };
  } catch {
    return null;
  }
}

function loadStore(): PersistentStore {
  ensureDataDir();
  const primary = tryReadStoreFile(STORE_FILE);
  if (primary) return primary;
  const backup = tryReadStoreFile(BACKUP_STORE_FILE);
  if (backup) return backup;
  return {
    adminPasscodeHash: null,
    stations: {},
    codes: {},
    stationData: {},
  };
}

function writeAtomicJson(targetPath: string, data: unknown): void {
  const tmpPath = `${targetPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

function saveStore(nextStore: PersistentStore): void {
  ensureDataDir();
  writeAtomicJson(STORE_FILE, nextStore);
  const hasRealData =
    Object.keys(nextStore.stations).length > 0 ||
    Object.keys(nextStore.codes).length > 0 ||
    Boolean(nextStore.adminPasscodeHash);
  if (hasRealData) {
    writeAtomicJson(BACKUP_STORE_FILE, nextStore);
  }
}

let store: PersistentStore = loadStore();

function resolvePersistentSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (store.sessionSecret && store.sessionSecret.length >= 32) {
    return store.sessionSecret;
  }
  ensureDataDir();
  if (fs.existsSync(SECRET_FILE)) {
    try {
      const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) {
        store.sessionSecret = existing;
        return existing;
      }
    } catch {
      // fall through to generate once
    }
  }
  const generated = crypto.randomBytes(32).toString('hex');
  store.sessionSecret = generated;
  try {
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  } catch {
    // ignore fs permission edge cases
  }
  return generated;
}

const SESSION_SECRET = resolvePersistentSessionSecret();

function getBucket(stationId: string): StationDataBucket {
  if (!store.stationData[stationId]) {
    store.stationData[stationId] = {
      subscribers: {},
      readings: {},
      receipts: {},
      alerts: {},
      expenses: {},
      collectorLocations: {},
    };
  } else {
    if (!store.stationData[stationId].alerts) {
      store.stationData[stationId].alerts = {};
    }
    if (!store.stationData[stationId].expenses) {
      store.stationData[stationId].expenses = {};
    }
    if (!store.stationData[stationId].collectorLocations) {
      store.stationData[stationId].collectorLocations = {};
    }
  }
  return store.stationData[stationId];
}

function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyScryptHash(passcode: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, hexHash] = parts;
  const derived = crypto.scryptSync(passcode, salt, 64);
  const expected = Buffer.from(hexHash, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

const DEVELOPER_PASSCODE_SHA256 =
  'f70bac98e825ee6f6e13931b4306ce8f4f33d99fd96851e1649d8bf03f5c9c36';

function verifyEnvPasscode(passcode: string, envPasscode: string): boolean {
  const a = crypto.createHash('sha256').update(passcode).digest();
  const b = crypto.createHash('sha256').update(envPasscode).digest();
  return crypto.timingSafeEqual(a, b);
}

function verifyDeveloperPasscode(passcode: string): boolean {
  const envPasscode = process.env.ADMIN_PASSCODE?.trim();
  if (envPasscode && verifyEnvPasscode(passcode, envPasscode)) {
    return true;
  }
  if (store.adminPasscodeHash && verifyScryptHash(passcode, store.adminPasscodeHash)) {
    return true;
  }
  const actual = crypto.createHash('sha256').update(passcode, 'utf8').digest();
  const expected = Buffer.from(DEVELOPER_PASSCODE_SHA256, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signSessionToken(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as SessionPayload;
    if (!parsed || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sealAiPhotoVerification(
  stationId: string,
  enabled: boolean,
  sealedAt: string,
): string {
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`ai_verify:${stationId}:${enabled ? '1' : '0'}:${sealedAt}`)
    .digest('hex');
  return `AES-HMAC-v1:${sig.slice(0, 32)}`;
}

function verifyAiPhotoSeal(station: StationRecord): boolean {
  if (!station.aiPhotoVerificationEnabled) return false;
  if (!station.aiPhotoVerificationSealed || !station.aiPhotoVerificationSealedAt) {
    return false;
  }
  const expected = sealAiPhotoVerification(
    station.stationId,
    true,
    station.aiPhotoVerificationSealedAt,
  );
  const a = Buffer.from(station.aiPhotoVerificationSealed);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function stripPhotosFromBucket(bucket: StationDataBucket): StationDataBucket {
  const cleanReadings: Record<string, MeterReadingRecord> = {};
  for (const [k, rd] of Object.entries(bucket.readings ?? {})) {
    cleanReadings[k] = {
      ...rd,
      photoUrl: '',
      hasLocalPhoto: Boolean(rd.hasLocalPhoto || rd.photoUrl),
    };
  }
  const cleanAlerts: Record<string, ManagerAlertRecord> = {};
  for (const [k, al] of Object.entries(bucket.alerts ?? {})) {
    cleanAlerts[k] = {
      ...al,
      photoUrl: '',
    };
  }
  return {
    ...bucket,
    readings: cleanReadings,
    alerts: cleanAlerts,
  };
}

const FIREBASE_PROJECT_ID = 'electricity-station-f5a90';
const ADMIN_GOOGLE_EMAIL = 'nabilalzuraigy@gmail.com';
const FIREBASE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedFirebaseCerts: { certs: Record<string, string>; expiresAt: number } | null = null;

async function getFirebasePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedFirebaseCerts && now < cachedFirebaseCerts.expiresAt) {
    return cachedFirebaseCerts.certs;
  }
  const resp = await fetch(FIREBASE_CERTS_URL);
  if (!resp.ok) {
    throw new Error('Failed to fetch Firebase public certificates');
  }
  const certs = (await resp.json()) as Record<string, string>;
  const cacheControl = resp.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const ttlMs = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) * 1000 : 3600 * 1000;
  cachedFirebaseCerts = { certs, expiresAt: now + ttlMs };
  return certs;
}

async function verifyFirebaseAdminToken(
  idToken: string,
): Promise<{ uid: string; email: string } | null> {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(
      Buffer.from(headerB64, 'base64url').toString('utf8'),
    ) as { alg?: string; kid?: string };
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as {
      aud?: string;
      iss?: string;
      sub?: string;
      exp?: number;
      iat?: number;
      auth_time?: number;
      email?: string;
      email_verified?: boolean;
    };

    if (header.alg !== 'RS256' || !header.kid) return null;
    const certs = await getFirebasePublicCerts();
    const cert = certs[header.kid];
    if (!cert) return null;

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const sigValid = verifier.verify(cert, Buffer.from(sigB64, 'base64url'));
    if (!sigValid) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (
      payload.aud !== FIREBASE_PROJECT_ID ||
      payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.exp !== 'number' ||
      payload.exp <= nowSec ||
      typeof payload.iat !== 'number' ||
      payload.iat > nowSec + 300
    ) {
      return null;
    }

    if (
      !payload.email ||
      payload.email.trim().toLowerCase() !== ADMIN_GOOGLE_EMAIL.toLowerCase() ||
      payload.email_verified !== true
    ) {
      return null;
    }

    return { uid: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function extractBearer(req: Request): SessionPayload | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return verifySessionToken(authHeader.slice(7).trim());
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = extractBearer(req);
  if (!session) {
    res.status(401).json({ error: 'جلسة الأدمن المطور مطلوبة.' });
    return;
  }
  if (session.role !== 'admin') {
    res.status(403).json({
      error: 'صلاحية المسح والإدارة العليا مقتصرة على الأدمن المطور فقط.',
    });
    return;
  }
  (req as Request & { session: SessionPayload }).session = session;
  next();
}

async function requireAdminOrFirebaseAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const session = extractBearer(req);
  if (session?.role === 'admin') {
    (req as Request & { session: SessionPayload }).session = session;
    next();
    return;
  }

  const fbHeader = req.headers['x-firebase-id-token'];
  const idToken = typeof fbHeader === 'string' ? fbHeader.trim() : '';
  if (idToken) {
    const verified = await verifyFirebaseAdminToken(idToken);
    if (verified) {
      (req as Request & { session: SessionPayload }).session = {
        role: 'admin',
        name: 'الأدمن المطور',
        exp: Date.now() + 60 * 60 * 1000,
      };
      next();
      return;
    }
  }

  res.status(401).json({ error: 'جلسة الأدمن المطور مطلوبة.' });
}

function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const session = extractBearer(req);
  if (!session) {
    res.status(401).json({ error: 'جلسة الدخول منتهية أو غير صالحة.' });
    return;
  }
  const stationId = req.params.stationId;
  if (
    session.role !== 'admin' &&
    (!session.stationId || session.stationId !== stationId)
  ) {
    res.status(403).json({ error: 'غير مصرح بالوصول إلى بيانات محطة أخرى.' });
    return;
  }
  if (session.role !== 'admin' && session.code) {
    const codeRec = store.codes[session.code];
    if (!codeRec || !codeRec.active) {
      res.status(403).json({ error: 'تم إيقاف هذا الكود من قِبل الإدارة.' });
      return;
    }
  }
  (req as Request & { session: SessionPayload }).session = session;
  next();
}

function normalizeCode(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function normalizeId(raw: unknown): string {
  const clean = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
  return clean || `id_${Date.now()}`;
}

function generateAccessCode(role: 'manager' | 'collector'): string {
  const prefix = role === 'manager' ? 'MGR' : 'COL';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () =>
    Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(
      '',
    );
  let candidate = `${prefix}-${block()}-${block()}`;
  while (store.codes[candidate]) {
    candidate = `${prefix}-${block()}-${block()}`;
  }
  return candidate;
}

function normalizeArabicName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00967')) return digits.slice(5);
  if (digits.startsWith('967') && digits.length >= 11) return digits.slice(3);
  if (digits.startsWith('0') && digits.length === 10) return digits.slice(1);
  return digits;
}

function normalizeArabicZone(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .toLowerCase();
}

const WILDCARD_ZONES = new Set([
  'جميع الحارات',
  'جميع المناطق',
  'كل الحارات',
  'كل المناطق',
  'الكل',
  'عام',
  'all',
  '*',
]);

function filterSubscribersByZones<T extends { zoneStreet: string }>(
  subscribers: T[],
  assignedZones: string[],
): T[] {
  const effective = assignedZones
    .map(normalizeArabicZone)
    .filter((z) => z.length > 0 && !WILDCARD_ZONES.has(z));
  if (effective.length === 0) return subscribers;
  return subscribers.filter((sub) => {
    const subZone = normalizeArabicZone(sub.zoneStreet);
    if (!subZone) return false;
    return effective.some(
      (z) => subZone === z || subZone.includes(z) || z.includes(subZone),
    );
  });
}

function buildStationStatePayload(
  stationId: string,
  role: 'admin' | 'manager' | 'collector',
  collectorCode?: string,
) {
  const station = store.stations[stationId];
  const bucket = getBucket(stationId);
  const allSubscribers = Object.values(bucket.subscribers);
  const allReadings = Object.values(bucket.readings).sort((a, b) =>
    b.recordedAt.localeCompare(a.recordedAt),
  );
  const allReceipts = Object.values(bucket.receipts).sort((a, b) =>
    b.paidAt.localeCompare(a.paidAt),
  );
  const allAlerts = Object.values(bucket.alerts ?? {}).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  const stationCodes = Object.values(store.codes).filter(
    (c) => c.stationId === stationId,
  );

  if (role === 'collector' && collectorCode) {
    const colRecord = store.codes[collectorCode];
    const zones = colRecord?.assignedZones ?? [];
    const filteredSubscribers = filterSubscribersByZones(allSubscribers, zones);
    const subIds = new Set(filteredSubscribers.map((s) => s.id));
    return {
      station,
      collectors: colRecord ? [colRecord] : [],
      subscribers: filteredSubscribers,
      readings: allReadings.filter((r) => subIds.has(r.subscriberId)),
      receipts: allReceipts.filter((rc) => subIds.has(rc.subscriberId)),
      alerts: [],
      expenses: [],
      collectorLocations: [],
    };
  }

  const allExpenses = Object.values(bucket.expenses ?? {}).sort((a, b) =>
    (b.date || b.createdAt).localeCompare(a.date || a.createdAt),
  );
  const allLocations = Object.values(bucket.collectorLocations ?? {}).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  return {
    station,
    collectors: stationCodes.filter((c) => c.role === 'collector'),
    managers: stationCodes.filter((c) => c.role === 'manager'),
    subscribers: allSubscribers,
    readings: allReadings,
    receipts: allReceipts,
    alerts: allAlerts,
    expenses: allExpenses,
    collectorLocations: allLocations,
  };
}

interface FirestoreRestValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
}

function mergeBucketDataIntoStore(
  stationId: string,
  bucketIn: Partial<StationDataBucket>,
): void {
  const cleanBucket = stripPhotosFromBucket({
    subscribers: bucketIn.subscribers ?? {},
    readings: bucketIn.readings ?? {},
    receipts: bucketIn.receipts ?? {},
    alerts: bucketIn.alerts ?? {},
    expenses: bucketIn.expenses ?? {},
    collectorLocations: bucketIn.collectorLocations ?? {},
  });
  const target = getBucket(stationId);
  Object.assign(target.subscribers, cleanBucket.subscribers);
  Object.assign(target.readings, cleanBucket.readings);
  Object.assign(target.receipts, cleanBucket.receipts);
  Object.assign(target.alerts, cleanBucket.alerts);
  Object.assign(target.expenses ?? {}, cleanBucket.expenses ?? {});
  Object.assign(
    target.collectorLocations ?? {},
    cleanBucket.collectorLocations ?? {},
  );
}

async function tryHydrateStaffCodeFromFirestore(
  rawCode: string,
): Promise<boolean> {
  const normalized = normalizeCode(rawCode);
  if (normalized.length < 4) return false;
  try {
    const accessHash = sha256Hex(`staff:${normalized}`);
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/staffVault/${accessHash}`;
    const resp = await fetch(url);
    if (!resp.ok) return false;
    const docData = (await resp.json()) as {
      fields?: Record<string, FirestoreRestValue>;
    };
    const fields = docData.fields;
    if (!fields?.accessJson?.stringValue || !fields?.stationJson?.stringValue) {
      return false;
    }

    const access = JSON.parse(
      fields.accessJson.stringValue,
    ) as AccessCodeRecord;
    const station = JSON.parse(
      fields.stationJson.stringValue,
    ) as StationRecord;
    if (
      !access?.code ||
      normalizeCode(access.code) !== normalized ||
      !station?.stationId ||
      access.stationId !== station.stationId
    ) {
      return false;
    }

    if (!store.stations[station.stationId]) {
      store.stations[station.stationId] = station;
    }

    // Check top-level `codes/{normalized}` document for freshest `active` and `pinResetAt`
    try {
      const codeUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/codes/${encodeURIComponent(normalized)}`;
      const codeResp = await fetch(codeUrl);
      if (codeResp.ok) {
        const codeDoc = (await codeResp.json()) as {
          fields?: Record<string, FirestoreRestValue>;
        };
        if (codeDoc.fields) {
          if (typeof codeDoc.fields.active?.booleanValue === 'boolean') {
            access.active = codeDoc.fields.active.booleanValue;
          }
          if (typeof codeDoc.fields.pinResetAt?.stringValue === 'string') {
            access.pinResetAt = codeDoc.fields.pinResetAt.stringValue;
          }
        }
      }
    } catch {
      // Keep staffVault access record if top-level code doc unavailable
    }

    store.codes[normalized] = access;

    if (fields.collectorsJson?.stringValue) {
      const collectors = JSON.parse(
        fields.collectorsJson.stringValue,
      ) as AccessCodeRecord[];
      if (Array.isArray(collectors)) {
        for (const col of collectors) {
          if (col?.code && col.stationId === station.stationId) {
            const cKey = normalizeCode(col.code);
            if (!store.codes[cKey]) {
              store.codes[cKey] = col;
            }
          }
        }
      }
    }

    if (fields.stationDataJson?.stringValue) {
      const bucketIn = JSON.parse(
        fields.stationDataJson.stringValue,
      ) as Partial<StationDataBucket>;
      mergeBucketDataIntoStore(station.stationId, bucketIn);
    } else {
      getBucket(station.stationId);
    }

    saveStore(store);
    return true;
  } catch {
    return false;
  }
}

async function tryLookupSubscriberPortalFromFirestore(
  rawIdentifier: string,
  rawPhone: string,
): Promise<{
  stationName: string;
  subscriber: SubscriberRecord;
  readings: MeterReadingRecord[];
  receipts: PaymentReceiptRecord[];
} | null> {
  try {
    const normPhone = normalizePhone(
      rawPhone.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))),
    );
    const normName = normalizeArabicName(rawIdentifier);
    if (!normPhone || !normName) return null;

    const hashes = [
      sha256Hex(`sub_name:${normName}:${normPhone}`),
      sha256Hex(`sub_meter:${rawIdentifier.trim().toLowerCase()}:${normPhone}`),
    ];

    for (const h of hashes) {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/subscriberPortals/${h}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const docData = (await resp.json()) as {
        fields?: Record<string, FirestoreRestValue>;
      };
      const f = docData.fields;
      if (!f?.meterNumber?.stringValue || !f?.subscriberName?.stringValue) {
        continue;
      }

      const numVal = (v?: FirestoreRestValue): number =>
        v?.doubleValue !== undefined
          ? Number(v.doubleValue)
          : v?.integerValue !== undefined
            ? Number(v.integerValue)
            : 0;

      const meterNumber = f.meterNumber.stringValue;
      const subscriberName = f.subscriberName.stringValue;
      const stationName = f.stationName?.stringValue || 'المحطة';
      const updatedAt = f.updatedAt?.timestampValue || new Date().toISOString();

      const readings: MeterReadingRecord[] = f.readingsJson?.stringValue
        ? (JSON.parse(f.readingsJson.stringValue) as MeterReadingRecord[])
        : [];
      const receipts: PaymentReceiptRecord[] = f.receiptsJson?.stringValue
        ? (JSON.parse(f.receiptsJson.stringValue) as PaymentReceiptRecord[])
        : [];

      const subscriber: SubscriberRecord = {
        id: `sub_${meterNumber}`,
        meterNumber,
        subscriberName,
        phone: rawPhone,
        previousReading: numVal(f.previousReading),
        currentReading: numVal(f.currentReading),
        previousDebtYer: numVal(f.previousDebtYer),
        zoneStreet: f.zoneStreet?.stringValue || 'عام',
        sequenceOrder: 1,
        updatedAt,
      };

      return { stationName, subscriber, readings, receipts };
    }
    return null;
  } catch {
    return null;
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // ============================================================
  // Admin Passcode Auth (env ADMIN_PASSCODE or one-time claim)
  // ============================================================

  app.get('/api/admin/status', (_req, res) => {
    res.json({ configured: true });
  });

  app.get('/api/maps/config', (_req, res) => {
    const apiKey =
      process.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ||
      process.env.GOOGLE_MAPS_API_KEY?.trim() ||
      '';
    res.json({ apiKey });
  });

  app.post('/api/admin/claim', (req, res) => {
    const envPasscode = process.env.ADMIN_PASSCODE?.trim();
    if (envPasscode || store.adminPasscodeHash) {
      res.status(409).json({
        error: 'كلمة مرور الأدمن مضبوطة مسبقاً. استخدم تسجيل الدخول.',
      });
      return;
    }
    const passcode = String(req.body?.passcode ?? '').trim();
    if (!verifyDeveloperPasscode(passcode) && (passcode.length < 6 || passcode.length > 128)) {
      res.status(400).json({
        error: 'يجب أن تكون كلمة مرور الأدمن 6 أحرف على الأقل.',
      });
      return;
    }

    store.adminPasscodeHash = hashPasscode(passcode);
    saveStore(store);

    const token = signSessionToken({
      role: 'admin',
      name: 'الأدمن المطور',
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ token, name: 'الأدمن المطور' });
  });

  app.post('/api/admin/login', (req, res) => {
    const passcode = String(req.body?.passcode ?? '').trim();
    if (!passcode) {
      res.status(400).json({ error: 'يرجى إدخال كلمة مرور الأدمن.' });
      return;
    }

    if (!verifyDeveloperPasscode(passcode)) {
      res.status(401).json({ error: 'كلمة مرور الأدمن غير صحيحة.' });
      return;
    }

    const token = signSessionToken({
      role: 'admin',
      name: 'الأدمن المطور',
      exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ token, name: 'الأدمن المطور' });
  });

  app.post('/api/admin/firebase-google', async (req, res) => {
    const idToken = String(
      req.body?.idToken ?? req.headers['x-firebase-id-token'] ?? '',
    ).trim();
    if (!idToken) {
      res.status(400).json({ error: 'رمز تحقق Google غير مرفق.' });
      return;
    }
    const verified = await verifyFirebaseAdminToken(idToken);
    if (!verified) {
      res.status(403).json({
        error: `الدخول مقتصر على حساب المطور المعتمد (${ADMIN_GOOGLE_EMAIL}).`,
      });
      return;
    }
    const token = signSessionToken({
      role: 'admin',
      name: 'نبيل الزريقي',
      exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ token, name: 'نبيل الزريقي', email: verified.email });
  });

  // ============================================================
  // Developer Admin Protected Endpoints
  // ============================================================

  app.get('/api/admin/overview', requireAdmin, (_req, res) => {
    const stations = Object.values(store.stations)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((st) => {
        const bucket = getBucket(st.stationId);
        return {
          ...st,
          subscriberCount: Object.keys(bucket.subscribers).length,
          readingCount: Object.keys(bucket.readings).length,
          receiptCount: Object.keys(bucket.receipts).length,
        };
      });

    const codes = Object.values(store.codes).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );

    res.json({ stations, codes });
  });

  app.post('/api/admin/stations', requireAdmin, (req, res) => {
    const stationName = String(req.body?.stationName ?? '').trim();
    if (stationName.length < 2 || stationName.length > 120) {
      res.status(400).json({ error: 'يرجى إدخال اسم محطة صالح.' });
      return;
    }
    const maxCollectors = Math.max(1, Math.min(500, Number(req.body?.maxCollectors) || 10));
    const maxSubscribers = Math.max(
      50,
      Math.min(100000, Number(req.body?.maxSubscribers) || 5000),
    );
    const kwhPriceYer = Math.max(0, Number(req.body?.kwhPriceYer) || 450);

    const stationId = normalizeId(
      `st_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
    );
    const now = new Date().toISOString();
    const record: StationRecord = {
      stationId,
      stationName,
      kwhPriceYer,
      minimumFeeYer: 0,
      mainGeneratorKwh: 0,
      licenseStatus: 'active',
      maxCollectors,
      maxSubscribers,
      createdAt: now,
      updatedAt: now,
    };

    store.stations[stationId] = record;
    getBucket(stationId);
    saveStore(store);

    res.json({ station: record });
  });

  app.post('/api/admin/stations/:stationId/status', requireAdmin, (req, res) => {
    const station = store.stations[req.params.stationId];
    if (!station) {
      res.status(404).json({ error: 'المحطة غير موجودة.' });
      return;
    }
    const nextStatus =
      req.body?.licenseStatus === 'suspended' ? 'suspended' : 'active';
    station.licenseStatus = nextStatus;
    station.updatedAt = new Date().toISOString();
    saveStore(store);
    res.json({ station });
  });

  app.post(
    '/api/admin/stations/:stationId/ai-verification',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const enabled =
        typeof req.body?.enabled === 'boolean'
          ? req.body.enabled
          : !Boolean(station.aiPhotoVerificationEnabled);
      const now = new Date().toISOString();
      station.aiPhotoVerificationEnabled = enabled;
      station.aiPhotoVerificationSealedAt = now;
      station.aiPhotoVerificationSealed = sealAiPhotoVerification(
        station.stationId,
        enabled,
        now,
      );
      station.updatedAt = now;
      saveStore(store);
      res.json({ station });
    },
  );

  app.post('/api/admin/codes', requireAdmin, (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const role = req.body?.role === 'collector' ? 'collector' : 'manager';
    const phone = String(req.body?.phone ?? '').trim();
    let stationId = String(req.body?.stationId ?? '').trim();
    const newStationName = String(req.body?.newStationName ?? '').trim();

    if (name.length < 2 || name.length > 100) {
      res.status(400).json({ error: 'يرجى إدخال الاسم الكامل (حرفان على الأقل).' });
      return;
    }

    const now = new Date().toISOString();
    if (!stationId && newStationName.length >= 2) {
      stationId = normalizeId(
        `st_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
      );
      store.stations[stationId] = {
        stationId,
        stationName: newStationName,
        kwhPriceYer: 450,
        minimumFeeYer: 0,
        mainGeneratorKwh: 0,
        licenseStatus: 'active',
        maxCollectors: 10,
        maxSubscribers: 5000,
        createdAt: now,
        updatedAt: now,
      };
      getBucket(stationId);
    }

    const station = store.stations[stationId];
    if (!station) {
      res.status(400).json({ error: 'يرجى اختيار محطة قائمة أو إنشاء محطة جديدة.' });
      return;
    }

    const assignedZones = Array.isArray(req.body?.assignedZones)
      ? req.body.assignedZones.map((z: unknown) => String(z).trim()).filter(Boolean)
      : [];

    const rawPerms = req.body?.permissions ?? {};
    const permissions: CollectorPermissions =
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
          };

    const customCode = normalizeCode(req.body?.customCode);
    const code =
      customCode && customCode.length >= 4 && !store.codes[customCode]
        ? customCode
        : generateAccessCode(role);

    const record: AccessCodeRecord = {
      code,
      role,
      name,
      phone,
      stationId: station.stationId,
      stationName: station.stationName,
      assignedZones,
      permissions,
      active: true,
      createdBy: 'developer_admin',
      pinResetAt: null,
      createdAt: now,
      updatedAt: now,
    };

    store.codes[code] = record;
    saveStore(store);

    res.json({ codeRecord: record, station });
  });

  app.post('/api/admin/codes/:code/toggle', requireAdmin, (req, res) => {
    const codeKey = normalizeCode(req.params.code);
    const rec = store.codes[codeKey];
    if (!rec) {
      res.status(404).json({ error: 'الكود غير موجود.' });
      return;
    }
    if (typeof req.body?.active === 'boolean') {
      rec.active = req.body.active;
    } else {
      rec.active = !rec.active;
    }
    if (req.body?.permissions && typeof req.body.permissions === 'object') {
      rec.permissions = {
        canRecordReadings: Boolean(req.body.permissions.canRecordReadings),
        canCollectCash: Boolean(req.body.permissions.canCollectCash),
        canSendInvoices: Boolean(req.body.permissions.canSendInvoices),
        canViewDebts: Boolean(req.body.permissions.canViewDebts),
      };
    }
    if (Array.isArray(req.body?.assignedZones)) {
      rec.assignedZones = req.body.assignedZones
        .map((z: unknown) => String(z).trim())
        .filter(Boolean);
    }
    rec.updatedAt = new Date().toISOString();
    saveStore(store);
    res.json({ codeRecord: rec });
  });

  app.post('/api/admin/codes/:code/reset-pin', requireAdmin, (req, res) => {
    const codeKey = normalizeCode(req.params.code);
    const rec = store.codes[codeKey];
    if (!rec) {
      res.status(404).json({ error: 'الكود غير موجود.' });
      return;
    }
    const now = new Date().toISOString();
    rec.pinResetAt = now;
    rec.updatedAt = now;
    saveStore(store);
    res.json({ codeRecord: rec });
  });

  app.delete('/api/admin/codes/:code', requireAdmin, (req, res) => {
    const codeKey = normalizeCode(req.params.code);
    if (!store.codes[codeKey]) {
      res.status(404).json({ error: 'الكود غير موجود.' });
      return;
    }
    delete store.codes[codeKey];
    saveStore(store);
    res.json({ deleted: true, code: codeKey });
  });

  app.post(
    '/api/admin/stations/:stationId/subscribers/upload-chunk',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const rows = Array.isArray(req.body?.subscribers) ? req.body.subscribers : [];
      const replaceAll = Boolean(req.body?.replaceAll);
      const bucket = getBucket(station.stationId);
      if (replaceAll) {
        bucket.subscribers = {};
      }

      const now = new Date().toISOString();
      let importedCount = 0;

      for (const row of rows) {
        const meterNumber = String(row?.meterNumber ?? '').trim();
        const subscriberName = String(row?.subscriberName ?? '').trim();
        if (!meterNumber || !subscriberName) continue;

        const id = normalizeId(row?.id || `sub_${meterNumber}`);
        const prev = Math.max(0, Number(row?.previousReading) || 0);
        const cur = Math.max(prev, Number(row?.currentReading) || prev);

        bucket.subscribers[id] = {
          id,
          meterNumber,
          subscriberName,
          phone: String(row?.phone ?? '').trim() || '770000000',
          previousReading: prev,
          currentReading: cur,
          previousDebtYer: Math.max(0, Number(row?.previousDebtYer) || 0),
          zoneStreet: String(row?.zoneStreet ?? '').trim() || 'شارع عام',
          sequenceOrder: Math.max(1, Math.round(Number(row?.sequenceOrder) || 1)),
          updatedAt: now,
        };
        importedCount++;
      }

      saveStore(store);
      res.json({
        importedCount,
        totalSubscribers: Object.keys(bucket.subscribers).length,
      });
    },
  );

  app.get(
    '/api/admin/stations/:stationId/subscribers',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const bucket = getBucket(station.stationId);
      const subscribers = Object.values(bucket.subscribers).sort(
        (a, b) => a.sequenceOrder - b.sequenceOrder,
      );
      res.json({ subscribers });
    },
  );

  app.post(
    '/api/admin/stations/:stationId/subscribers',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }

      const subscriberName = String(req.body?.subscriberName ?? '').trim();
      const meterNumber = String(req.body?.meterNumber ?? '').trim();
      const phone = String(req.body?.phone ?? '').trim() || '770000000';
      const zoneStreet = String(req.body?.zoneStreet ?? '').trim() || 'شارع عام';

      if (subscriberName.length < 2) {
        res
          .status(400)
          .json({ error: 'يرجى إدخال اسم المشترك الكامل (حرفان على الأقل).' });
        return;
      }
      if (!meterNumber) {
        res.status(400).json({ error: 'يرجى إدخال رقم العداد.' });
        return;
      }

      const bucket = getBucket(station.stationId);
      const id = normalizeId(`sub_${meterNumber}`);
      const duplicateMeter = Object.values(bucket.subscribers).some(
        (s) =>
          s.id === id ||
          s.meterNumber.trim().toLowerCase() === meterNumber.toLowerCase(),
      );
      if (duplicateMeter) {
        res
          .status(409)
          .json({ error: 'رقم العداد مسجل مسبقاً في هذه المحطة.' });
        return;
      }

      const rawPrev = Number(req.body?.previousReading ?? 0);
      const previousReading =
        Number.isFinite(rawPrev) && rawPrev >= 0 ? rawPrev : 0;
      const rawDebt = Number(req.body?.previousDebtYer ?? 0);
      const previousDebtYer =
        Number.isFinite(rawDebt) && rawDebt >= 0 ? rawDebt : 0;

      const maxSeq = Object.values(bucket.subscribers).reduce(
        (max, s) => Math.max(max, s.sequenceOrder || 0),
        0,
      );
      const rawSeq = Number(req.body?.sequenceOrder ?? 0);
      const sequenceOrder =
        Number.isFinite(rawSeq) && rawSeq >= 1
          ? Math.round(rawSeq)
          : maxSeq + 1;

      const rawAvg = req.body?.last3MonthsAvgKwh;
      const avgNum =
        rawAvg !== undefined && rawAvg !== null && String(rawAvg).trim() !== ''
          ? Number(rawAvg)
          : undefined;
      const last3MonthsAvgKwh =
        avgNum !== undefined && Number.isFinite(avgNum) && avgNum >= 0
          ? avgNum
          : undefined;

      const subscriber: SubscriberRecord = {
        id,
        meterNumber,
        subscriberName,
        phone,
        previousReading,
        currentReading: previousReading,
        previousDebtYer,
        ...(last3MonthsAvgKwh !== undefined ? { last3MonthsAvgKwh } : {}),
        zoneStreet,
        sequenceOrder,
        updatedAt: new Date().toISOString(),
      };

      bucket.subscribers[id] = subscriber;
      saveStore(store);
      res.status(201).json({
        subscriber,
        totalSubscribers: Object.keys(bucket.subscribers).length,
      });
    },
  );

  app.delete(
    '/api/admin/stations/:stationId/subscribers/:subscriberId',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const bucket = getBucket(station.stationId);
      const subId = String(req.params.subscriberId ?? '').trim();
      if (!bucket.subscribers[subId]) {
        res.status(404).json({ error: 'المشترك غير موجود.' });
        return;
      }
      delete bucket.subscribers[subId];
      saveStore(store);
      res.json({
        deleted: true,
        totalSubscribers: Object.keys(bucket.subscribers).length,
      });
    },
  );

  // ============================================================
  // Developer Admin Exclusive Backup, Restore & Record Deletion
  // ============================================================

  app.get('/api/admin/backup', requireAdmin, (_req, res) => {
    const textOnlyStationData: Record<string, StationDataBucket> = {};
    for (const [stId, bucket] of Object.entries(store.stationData)) {
      textOnlyStationData[stId] = stripPhotosFromBucket(bucket);
    }
    res.json({
      stations: store.stations,
      codes: store.codes,
      stationData: textOnlyStationData,
      exportedAt: new Date().toISOString(),
    });
  });

  app.get(
    '/api/admin/cloud-auto-backup',
    requireAdminOrFirebaseAdmin,
    (_req, res) => {
      const textOnlyStationData: Record<string, StationDataBucket> = {};
      for (const [stId, bucket] of Object.entries(store.stationData)) {
        textOnlyStationData[stId] = stripPhotosFromBucket(bucket);
      }
      const stationCount = Object.keys(store.stations).length;
      const codeCount = Object.keys(store.codes).length;
      const subscriberCount = Object.values(store.stationData).reduce(
        (sum, b) => sum + Object.keys(b?.subscribers ?? {}).length,
        0,
      );
      res.json({
        stations: store.stations,
        codes: store.codes,
        stationData: textOnlyStationData,
        counts: { stationCount, codeCount, subscriberCount },
        hasData: stationCount > 0 || codeCount > 0,
        exportedAt: new Date().toISOString(),
      });
    },
  );

  function applyRestorePayload(
    body: Record<string, unknown>,
  ): { ok: true; stationCount: number; codeCount: number; subscriberCount: number } | { error: string; status: number } {
    const incomingStations =
      body?.stations &&
      typeof body.stations === 'object' &&
      !Array.isArray(body.stations)
        ? (body.stations as Record<string, StationRecord>)
        : null;
    const incomingCodes =
      body?.codes &&
      typeof body.codes === 'object' &&
      !Array.isArray(body.codes)
        ? (body.codes as Record<string, AccessCodeRecord>)
        : null;
    const incomingStationData =
      body?.stationData &&
      typeof body.stationData === 'object' &&
      !Array.isArray(body.stationData)
        ? (body.stationData as Record<string, StationDataBucket>)
        : null;

    if (!incomingStations && !incomingCodes && !incomingStationData) {
      return { error: 'ملف أو نسخة الاستعادة غير صالحة.', status: 400 };
    }

    const mode = body?.mode === 'replace' ? 'replace' : 'merge';
    const incomingEmpty =
      Object.keys(incomingStations ?? {}).length === 0 &&
      Object.keys(incomingCodes ?? {}).length === 0;
    const currentNonEmpty =
      Object.keys(store.stations).length > 0 ||
      Object.keys(store.codes).length > 0;

    if (mode === 'replace' && incomingEmpty && currentNonEmpty) {
      return {
        error: 'لا يمكن استبدال بيانات المحطات والأكواد الحالية بنسخة فارغة.',
        status: 400,
      };
    }

    if (mode === 'replace') {
      store.stations = incomingStations ?? {};
      store.codes = incomingCodes ?? {};
      store.stationData = {};
      if (incomingStationData) {
        for (const [stId, bucketIn] of Object.entries(incomingStationData)) {
          if (bucketIn && typeof bucketIn === 'object') {
            store.stationData[stId] = stripPhotosFromBucket(bucketIn);
          }
        }
      }
    } else {
      if (incomingStations) {
        for (const [k, v] of Object.entries(incomingStations)) {
          if (v && typeof v === 'object' && v.stationId) {
            store.stations[k] = v;
          }
        }
      }
      if (incomingCodes) {
        for (const [k, v] of Object.entries(incomingCodes)) {
          if (v && typeof v === 'object' && v.code) {
            store.codes[normalizeCode(k)] = v;
          }
        }
      }
      if (incomingStationData) {
        for (const [stId, bucketIn] of Object.entries(incomingStationData)) {
          if (!bucketIn || typeof bucketIn !== 'object') continue;
          mergeBucketDataIntoStore(stId, bucketIn);
        }
      }
    }

    for (const stId of Object.keys(store.stations)) {
      getBucket(stId);
    }
    saveStore(store);

    const subscriberCount = Object.values(store.stationData).reduce(
      (sum, b) => sum + Object.keys(b?.subscribers ?? {}).length,
      0,
    );
    return {
      ok: true,
      stationCount: Object.keys(store.stations).length,
      codeCount: Object.keys(store.codes).length,
      subscriberCount,
    };
  }

  app.post(
    '/api/admin/cloud-auto-restore',
    requireAdminOrFirebaseAdmin,
    (req, res) => {
      const result = applyRestorePayload(
        (req.body ?? {}) as Record<string, unknown>,
      );
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result);
    },
  );

  app.post('/api/admin/restore', requireAdmin, (req, res) => {
    const result = applyRestorePayload(
      (req.body ?? {}) as Record<string, unknown>,
    );
    if ('error' in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  app.get('/api/admin/stations/:stationId/details', requireAdmin, (req, res) => {
    const station = store.stations[req.params.stationId];
    if (!station) {
      res.status(404).json({ error: 'المحطة غير موجودة.' });
      return;
    }
    const bucket = getBucket(station.stationId);
    res.json({
      station,
      readings: Object.values(bucket.readings).sort((a, b) =>
        b.recordedAt.localeCompare(a.recordedAt),
      ),
      receipts: Object.values(bucket.receipts).sort((a, b) =>
        b.paidAt.localeCompare(a.paidAt),
      ),
      expenses: Object.values(bucket.expenses ?? {}).sort((a, b) =>
        (b.date || b.createdAt).localeCompare(a.date || a.createdAt),
      ),
      alerts: Object.values(bucket.alerts ?? {}).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    });
  });

  app.delete('/api/admin/stations/:stationId', requireAdmin, (req, res) => {
    const stationId = req.params.stationId;
    if (!store.stations[stationId]) {
      res.status(404).json({ error: 'المحطة غير موجودة.' });
      return;
    }
    delete store.stations[stationId];
    delete store.stationData[stationId];
    for (const [codeKey, codeRec] of Object.entries(store.codes)) {
      if (codeRec.stationId === stationId) {
        delete store.codes[codeKey];
      }
    }
    saveStore(store);
    res.json({ deleted: true, stationId });
  });

  app.delete(
    '/api/admin/stations/:stationId/readings/:readingId',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const bucket = getBucket(station.stationId);
      const readingId = normalizeId(req.params.readingId);
      if (!bucket.readings[readingId]) {
        res.status(404).json({ error: 'القراءة غير موجودة.' });
        return;
      }
      delete bucket.readings[readingId];
      saveStore(store);
      res.json({ deleted: true, id: readingId });
    },
  );

  app.delete(
    '/api/admin/stations/:stationId/receipts/:receiptId',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const bucket = getBucket(station.stationId);
      const receiptId = normalizeId(req.params.receiptId);
      if (!bucket.receipts[receiptId]) {
        res.status(404).json({ error: 'سند القبض غير موجود.' });
        return;
      }
      delete bucket.receipts[receiptId];
      saveStore(store);
      res.json({ deleted: true, id: receiptId });
    },
  );

  app.delete(
    '/api/admin/stations/:stationId/expenses/:expenseId',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const bucket = getBucket(station.stationId);
      const expenseId = normalizeId(req.params.expenseId);
      if (!bucket.expenses || !bucket.expenses[expenseId]) {
        res.status(404).json({ error: 'المصروف غير موجود.' });
        return;
      }
      delete bucket.expenses[expenseId];
      saveStore(store);
      res.json({ deleted: true, id: expenseId });
    },
  );

  app.delete(
    '/api/admin/stations/:stationId/alerts/:alertId',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const bucket = getBucket(station.stationId);
      const alertId = normalizeId(req.params.alertId);
      if (!bucket.alerts[alertId]) {
        res.status(404).json({ error: 'التنبيه غير موجود.' });
        return;
      }
      delete bucket.alerts[alertId];
      saveStore(store);
      res.json({ deleted: true, id: alertId });
    },
  );

  // ============================================================
  // Unified Public Login (Admin Passcode / Manager or Collector Code / Subscriber Name+Phone)
  // ============================================================

  app.post('/api/auth/hydrate-from-cloud', async (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!code || code.length < 4) {
      res.status(400).json({ error: 'كود التفعيل غير صالح.' });
      return;
    }
    const hydrated = await tryHydrateStaffCodeFromFirestore(code);
    res.json({ ok: true, hydrated });
  });

  app.post('/api/auth/unified', async (req, res) => {
    const rawUsername = String(req.body?.username ?? '').trim();
    const rawPassword = String(req.body?.password ?? '').trim();
    const rawCredential = String(
      req.body?.credential ?? (rawPassword || rawUsername),
    ).trim();

    if (!rawCredential && !rawUsername && !rawPassword) {
      res.status(400).json({ error: 'يرجى إدخال بيانات الدخول.' });
      return;
    }

    const candidates = Array.from(
      new Set([rawPassword, rawCredential, rawUsername].filter(Boolean)),
    );

    // 1. Check Admin Passcode
    const isAdminPass = candidates.some((cand) => verifyDeveloperPasscode(cand));

    if (isAdminPass) {
      const token = signSessionToken({
        role: 'admin',
        name: 'الأدمن المطور',
        exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });
      res.json({ kind: 'admin', token, name: 'الأدمن المطور' });
      return;
    }

    // 2. Check Manager / Collector Code (with automatic Firestore staffVault hydration if missing)
    for (const cand of candidates) {
      const normalizedCode = normalizeCode(cand);
      if (normalizedCode.length >= 4 && !store.codes[normalizedCode]) {
        await tryHydrateStaffCodeFromFirestore(normalizedCode);
      }
      if (normalizedCode.length >= 4 && store.codes[normalizedCode]) {
        const rec = store.codes[normalizedCode];
        if (!rec.active) {
          res.status(403).json({ error: 'هذا الكود موقوف حالياً من الإدارة.' });
          return;
        }
        const station = store.stations[rec.stationId];
        if (!station) {
          res.status(404).json({ error: 'بيانات المحطة المرتبطة غير موجودة.' });
          return;
        }
        if (station.licenseStatus !== 'active') {
          res.status(403).json({
            error: 'تم إيقاف ترخيص هذه المحطة من قِبل الإدارة.',
          });
          return;
        }

        const token = signSessionToken({
          role: rec.role,
          name: rec.name,
          code: rec.code,
          stationId: rec.stationId,
          exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });

        res.json({
          kind: 'staff',
          token,
          access: rec,
          state: buildStationStatePayload(rec.stationId, rec.role, rec.code),
        });
        return;
      }
    }

    // 3. Check Subscriber Name + Phone (either separate username+password or combined credential)
    let subTargetName = '';
    let subTargetPhone = '';
    let subRawNamePart = '';

    if (rawUsername && rawPassword) {
      const normalizedPass = rawPassword.replace(/[٠-٩]/g, (d) =>
        String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)),
      );
      const pDigits = normalizePhone(normalizedPass);
      if (pDigits.length >= 7) {
        subTargetPhone = pDigits;
        subRawNamePart = rawUsername;
        subTargetName = normalizeArabicName(rawUsername);
      }
    }

    if (!subTargetPhone) {
      const normalizedDigitsCredential = rawCredential.replace(/[٠-٩]/g, (d) =>
        String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)),
      );
      const phoneMatch = normalizedDigitsCredential.match(
        /(?:\+?967|00967)?\s*\d[\d\s-]{6,14}\d/,
      );
      if (phoneMatch) {
        subTargetPhone = normalizePhone(phoneMatch[0]);
        subRawNamePart = normalizedDigitsCredential
          .replace(phoneMatch[0], ' ')
          .replace(/[-/|،,]+/g, ' ')
          .trim();
        subTargetName = normalizeArabicName(subRawNamePart);
      }
    }

    if (subTargetPhone.length >= 7 && subTargetName.length >= 2) {
      for (const station of Object.values(store.stations)) {
        const bucket = getBucket(station.stationId);
        const matchedSub = Object.values(bucket.subscribers).find((sub) => {
          if (normalizePhone(sub.phone) !== subTargetPhone) return false;
          return (
            normalizeArabicName(sub.subscriberName) === subTargetName ||
            sub.meterNumber.trim().toLowerCase() ===
              subRawNamePart.toLowerCase()
          );
        });

        if (matchedSub) {
          const readings = Object.values(bucket.readings)
            .filter(
              (r) =>
                r.subscriberId === matchedSub.id ||
                r.meterNumber === matchedSub.meterNumber,
            )
            .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

          const receipts = Object.values(bucket.receipts)
            .filter(
              (rc) =>
                rc.subscriberId === matchedSub.id ||
                rc.meterNumber === matchedSub.meterNumber,
            )
            .sort((a, b) => b.paidAt.localeCompare(a.paidAt));

          res.json({
            kind: 'subscriber',
            result: {
              stationName: station.stationName,
              subscriber: matchedSub,
              readings,
              receipts,
            },
          });
          return;
        }
      }

      const cloudPortal = await tryLookupSubscriberPortalFromFirestore(
        subRawNamePart || rawUsername,
        subTargetPhone,
      );
      if (cloudPortal) {
        res.json({ kind: 'subscriber', result: cloudPortal });
        return;
      }
    }

    res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
  });

  // ============================================================
  // Public Code Login (Manager or Collector Code)
  // ============================================================

  app.post('/api/auth/code', async (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!code || code.length < 4) {
      res.status(400).json({ error: 'يرجى إدخال كود الدخول الصحيح.' });
      return;
    }

    if (!store.codes[code]) {
      await tryHydrateStaffCodeFromFirestore(code);
    }

    const rec = store.codes[code];
    if (!rec) {
      res.status(404).json({
        error: 'الكود غير موجود. تأكد من الكود الصادر من الأدمن المطور.',
      });
      return;
    }
    if (!rec.active) {
      res.status(403).json({ error: 'هذا الكود موقوف حالياً من الإدارة.' });
      return;
    }

    const station = store.stations[rec.stationId];
    if (!station) {
      res.status(404).json({ error: 'بيانات المحطة المرتبطة غير موجودة.' });
      return;
    }
    if (station.licenseStatus !== 'active') {
      res.status(403).json({
        error: 'تم إيقاف ترخيص هذه المحطة من قِبل الأدمن المطور.',
      });
      return;
    }

    const token = signSessionToken({
      role: rec.role,
      name: rec.name,
      code: rec.code,
      stationId: rec.stationId,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    const state = buildStationStatePayload(rec.stationId, rec.role, rec.code);
    res.json({
      token,
      access: rec,
      state,
    });
  });

  // ============================================================
  // Station Staff Endpoints (Manager & Collector)
  // ============================================================

  app.get('/api/stations/:stationId/state', requireStaff, (req, res) => {
    const session = (req as Request & { session: SessionPayload }).session;
    const station = store.stations[req.params.stationId];
    if (!station) {
      res.status(404).json({ error: 'المحطة غير موجودة.' });
      return;
    }
    res.json(
      buildStationStatePayload(
        station.stationId,
        session.role,
        session.code,
      ),
    );
  });

  app.patch('/api/stations/:stationId/config', requireStaff, (req, res) => {
    const session = (req as Request & { session: SessionPayload }).session;
    if (session.role === 'collector') {
      res.status(403).json({ error: 'تعديل التعرفة مخصص لمدير المحطة أو الأدمن.' });
      return;
    }
    if (
      session.role !== 'admin' &&
      ('aiPhotoVerificationEnabled' in (req.body ?? {}) ||
        'aiPhotoVerificationSealed' in (req.body ?? {}) ||
        'aiPhotoVerificationSealedAt' in (req.body ?? {}))
    ) {
      res.status(403).json({
        error:
          'حقل مطابقة صورة العداد (Gemini Vision-AI) مشفّر ومقتصر التعديل على الأدمن المطور فقط.',
      });
      return;
    }
    const station = store.stations[req.params.stationId];
    if (!station) {
      res.status(404).json({ error: 'المحطة غير موجودة.' });
      return;
    }
    if (typeof req.body?.stationName === 'string' && req.body.stationName.trim().length >= 2) {
      station.stationName = req.body.stationName.trim();
    }
    if (typeof req.body?.kwhPriceYer === 'number') {
      station.kwhPriceYer = Math.max(0, req.body.kwhPriceYer);
    }
    if (typeof req.body?.minimumFeeYer === 'number') {
      station.minimumFeeYer = Math.max(0, req.body.minimumFeeYer);
    }
    if (typeof req.body?.mainGeneratorKwh === 'number') {
      station.mainGeneratorKwh = Math.max(0, req.body.mainGeneratorKwh);
    }
    if (
      req.body?.zoneGeneratorKwh &&
      typeof req.body.zoneGeneratorKwh === 'object' &&
      !Array.isArray(req.body.zoneGeneratorKwh)
    ) {
      const sanitized: Record<string, number> = {};
      for (const [k, v] of Object.entries(req.body.zoneGeneratorKwh)) {
        const zoneName = String(k ?? '').trim().slice(0, 120);
        const val = Number(v);
        if (zoneName && Number.isFinite(val) && val >= 0) {
          sanitized[zoneName] = val;
        }
      }
      station.zoneGeneratorKwh = sanitized;
    }
    station.updatedAt = new Date().toISOString();
    saveStore(store);
    res.json({ station });
  });

  // Diesel & Operating Expenses (Profit & Loss Ledger)
  app.post('/api/stations/:stationId/expenses', requireStaff, (req, res) => {
    const session = (req as Request & { session: SessionPayload }).session;
    if (session.role === 'collector') {
      res.status(403).json({
        error: 'تسجيل مصاريف الديزل والربح والخسارة مخصص لمدير المحطة فقط.',
      });
      return;
    }
    const station = store.stations[req.params.stationId];
    if (!station) {
      res.status(404).json({ error: 'المحطة غير موجودة.' });
      return;
    }
    const bucket = getBucket(station.stationId);
    const categoryRaw = String(req.body?.category ?? 'diesel');
    const category: DieselExpenseRecord['category'] =
      categoryRaw === 'oil_maintenance' ||
      categoryRaw === 'salaries' ||
      categoryRaw === 'other'
        ? categoryRaw
        : 'diesel';

    const liters =
      typeof req.body?.liters === 'number' && Number.isFinite(req.body.liters)
        ? Math.max(0, req.body.liters)
        : undefined;
    const pricePerLiterYer =
      typeof req.body?.pricePerLiterYer === 'number' &&
      Number.isFinite(req.body.pricePerLiterYer)
        ? Math.max(0, req.body.pricePerLiterYer)
        : undefined;
    const amountYer = Math.max(0, Number(req.body?.amountYer) || 0);
    if (amountYer <= 0) {
      res.status(400).json({ error: 'يرجى إدخال مبلغ صحيح أكبر من الصفر.' });
      return;
    }

    const id = normalizeId(req.body?.id || `exp_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`);
    const now = new Date().toISOString();
    const date =
      typeof req.body?.date === 'string' && req.body.date.trim()
        ? req.body.date.trim().slice(0, 20)
        : now.slice(0, 10);

    const record: DieselExpenseRecord = {
      id,
      stationId: station.stationId,
      date,
      category,
      ...(typeof liters === 'number' && liters > 0 ? { liters } : {}),
      ...(typeof pricePerLiterYer === 'number' && pricePerLiterYer > 0
        ? { pricePerLiterYer }
        : {}),
      amountYer,
      note: String(req.body?.note ?? '').trim().slice(0, 240),
      createdBy: session.name,
      createdAt: now,
    };

    if (!bucket.expenses) bucket.expenses = {};
    bucket.expenses[id] = record;
    saveStore(store);
    res.json({ expense: record });
  });

  // Deletion of expenses is strictly restricted to Developer Admin only
  app.delete(
    '/api/stations/:stationId/expenses/:expenseId',
    requireAdmin,
    (req, res) => {
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const bucket = getBucket(station.stationId);
      const expenseId = normalizeId(req.params.expenseId);
      if (bucket.expenses && bucket.expenses[expenseId]) {
        delete bucket.expenses[expenseId];
        saveStore(store);
      }
      res.json({ deleted: true, id: expenseId });
    },
  );

  // Live Collector GPS Tracking Heartbeat
  app.post(
    '/api/stations/:stationId/collector-location',
    requireStaff,
    (req, res) => {
      const session = (req as Request & { session: SessionPayload }).session;
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        res.status(400).json({ error: 'إحداثيات الموقع غير صالحة.' });
        return;
      }
      const bucket = getBucket(station.stationId);
      if (!bucket.collectorLocations) bucket.collectorLocations = {};
      const collectorCode = normalizeCode(
        String(req.body?.collectorCode ?? session.code ?? session.name),
      );
      const loc: CollectorLocationRecord = {
        collectorCode,
        collectorName: String(req.body?.collectorName ?? session.name).slice(0, 100),
        lat,
        lng,
        ...(typeof req.body?.accuracy === 'number' &&
        Number.isFinite(req.body.accuracy)
          ? { accuracy: Math.round(req.body.accuracy) }
          : {}),
        ...(req.body?.lastSubscriberName
          ? { lastSubscriberName: String(req.body.lastSubscriberName).slice(0, 120) }
          : {}),
        ...(req.body?.lastMeterNumber
          ? { lastMeterNumber: String(req.body.lastMeterNumber).slice(0, 60) }
          : {}),
        ...(req.body?.zoneStreet
          ? { zoneStreet: String(req.body.zoneStreet).slice(0, 120) }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      bucket.collectorLocations[collectorCode] = loc;
      saveStore(store);
      res.json({ ok: true, location: loc });
    },
  );

  app.patch(
    '/api/stations/:stationId/collectors/:code',
    requireStaff,
    (req, res) => {
      const session = (req as Request & { session: SessionPayload }).session;
      if (session.role === 'collector') {
        res.status(403).json({ error: 'إدارة صلاحيات المحصلين مخصصة للمدير أو الأدمن.' });
        return;
      }
      const codeKey = normalizeCode(req.params.code);
      const rec = store.codes[codeKey];
      if (!rec || rec.stationId !== req.params.stationId || rec.role !== 'collector') {
        res.status(404).json({ error: 'المحصّل غير موجود في هذه المحطة.' });
        return;
      }
      if (typeof req.body?.active === 'boolean') {
        rec.active = req.body.active;
      }
      if (req.body?.permissions && typeof req.body.permissions === 'object') {
        rec.permissions = {
          canRecordReadings: Boolean(req.body.permissions.canRecordReadings),
          canCollectCash: Boolean(req.body.permissions.canCollectCash),
          canSendInvoices: Boolean(req.body.permissions.canSendInvoices),
          canViewDebts: Boolean(req.body.permissions.canViewDebts),
        };
      }
      rec.updatedAt = new Date().toISOString();
      saveStore(store);
      res.json({ collector: rec });
    },
  );

  app.post(
    '/api/stations/:stationId/ocr-meter',
    requireStaff,
    async (req, res) => {
      const session = (req as Request & { session: SessionPayload }).session;
      const codeRec = session.code ? store.codes[session.code] : undefined;
      if (
        session.role === 'collector' &&
        codeRec &&
        !codeRec.permissions.canRecordReadings
      ) {
        res.status(403).json({ error: 'ليست لديك صلاحية قراءة العدادات.' });
        return;
      }

      if (!geminiAi) {
        res.status(503).json({
          error: 'محرك القراءة السحابي غير مفعّل؛ استخدم القراءة المحلية من الجهاز.',
        });
        return;
      }

      const rawImage = String(req.body?.imageBase64 ?? '').trim();
      const rawZoomedBw = String(req.body?.zoomedBwBase64 ?? '').trim();
      const previousReading = Number(req.body?.previousReading) || 0;
      if (!rawImage || rawImage.length > 450000 || rawZoomedBw.length > 450000) {
        res.status(400).json({ error: 'صورة العداد غير صالحة أو حجمها كبير.' });
        return;
      }

      const parseDataUrl = (input: string) => {
        const m = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        return {
          mimeType: m?.[1] || String(req.body?.mimeType || 'image/jpeg'),
          data: m?.[2] || input,
        };
      };

      const runVisionPass = async (
        imageInput: string,
        engineLabel: string,
        focusHint: string,
      ) => {
        const { mimeType, data } = parseDataUrl(imageInput);
        const response = await geminiAi.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data,
                },
              },
              {
                text: `You are reading an electric kilowatt-hour (kWh) meter display under difficult field conditions (shadows, dust, glare, low contrast).
${focusHint}
Previous recorded reading for context: ${previousReading}.
Extract ONLY the numeric integer digits (0-9) shown on the main cumulative kWh meter display.
Ignore all words, letters, units like "kWh", manufacturer/company names, serial numbers, barcodes, voltage/ampere ratings (e.g. 220V, 50Hz, 10(40)A), or timestamps.
Be conservative with confidence: only report confidence >= 85 when every single digit is crisp and unambiguous.
If no clear electric meter reading is visible in the image, set isClearMeter to false, detectedReading to -1, and confidence to 0.`,
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                isClearMeter: {
                  type: Type.BOOLEAN,
                  description:
                    'True only if an electric meter kWh register is clearly visible and readable.',
                },
                detectedReading: {
                  type: Type.NUMBER,
                  description:
                    'The exact kWh numeric reading shown on the meter display, or -1 if unreadable.',
                },
                rawDigits: {
                  type: Type.STRING,
                  description:
                    'The exact characters/digits read from the main kWh display.',
                },
                confidence: {
                  type: Type.NUMBER,
                  description: 'Confidence score between 0 and 100.',
                },
              },
              required: [
                'isClearMeter',
                'detectedReading',
                'rawDigits',
                'confidence',
              ],
            },
          },
        });

        const rawJson = (response.text ?? '{}').trim();
        const parsed = JSON.parse(rawJson) as {
          isClearMeter?: boolean;
          detectedReading?: number;
          rawDigits?: string;
          confidence?: number;
        };
        const reading =
          typeof parsed.detectedReading === 'number' &&
          Number.isFinite(parsed.detectedReading) &&
          parsed.detectedReading >= 0
            ? Math.round(parsed.detectedReading * 100) / 100
            : null;
        return {
          engine: engineLabel,
          isClearMeter: Boolean(parsed.isClearMeter) && reading !== null,
          reading,
          rawDigits: String(parsed.rawDigits ?? ''),
          confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))),
        };
      };

      try {
        const tasks = [
          runVisionPass(
            rawImage,
            'gemini-enhanced-full',
            'Image 1 is contrast-enhanced with shadow removal.',
          ),
        ];
        if (rawZoomedBw) {
          tasks.push(
            runVisionPass(
              rawZoomedBw,
              'gemini-zoomed-bw',
              'Image 2 is a zoomed, despeckled black-and-white crop focused tightly on the digit window.',
            ),
          );
        }
        const passes = await Promise.all(tasks);
        const primary = passes[0];
        res.json({
          passes,
          isClearMeter: passes.some((p) => p.isClearMeter),
          reading: primary.reading,
          rawDigits: primary.rawDigits,
          confidence: primary.confidence,
        });
      } catch (err) {
        res.status(502).json({
          error:
            err instanceof Error
              ? err.message
              : 'تعذر تحليل صورة العداد عبر الخادم.',
        });
      }
    },
  );

  // Gemini Vision-AI Meter Photo vs Claimed Reading Verification (Admin-Sealed Feature)
  // Photo stays transient in server RAM for Gemini verification and is NEVER saved to Firestore/cloud
  app.post(
    '/api/stations/:stationId/verify-meter-photo',
    requireStaff,
    async (req, res) => {
      const session = (req as Request & { session: SessionPayload }).session;
      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }

      if (!verifyAiPhotoSeal(station)) {
        res.status(403).json({
          error:
            'ميزة "مطابقة صورة العداد مع رقم القراءة المحصل" معطلة أو غير مفعّلة من الأدمن المطور.',
        });
        return;
      }

      if (!geminiAi) {
        res.status(503).json({
          error: 'محرك Gemini Vision-AI غير مفعّل على الخادم حالياً.',
        });
        return;
      }

      const rawImage = String(req.body?.imageBase64 ?? '').trim();
      const claimedReading = Number(req.body?.claimedReading);
      const previousReading = Math.max(0, Number(req.body?.previousReading) || 0);
      const subscriberId = normalizeId(req.body?.subscriberId);
      const readingId = normalizeId(req.body?.readingId || `rd_${Date.now()}`);

      if (!rawImage || rawImage.length > 450000) {
        res.status(400).json({ error: 'صورة العداد غير صالحة أو حجمها كبير.' });
        return;
      }
      if (!Number.isFinite(claimedReading) || claimedReading < 0) {
        res.status(400).json({ error: 'رقم القراءة المحصل غير صالح للمطابقة.' });
        return;
      }

      const m = rawImage.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      const mimeType = m?.[1] || 'image/jpeg';
      const data = m?.[2] || rawImage;

      try {
        const response = await geminiAi.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data,
                },
              },
              {
                text: `You are an anti-fraud utility meter auditor using Gemini Vision-AI.
A field collector submitted the reading: ${claimedReading} kWh (previous recorded reading: ${previousReading} kWh).
Inspect the attached electric meter photo carefully:
1. Determine whether an electric meter kWh register is clearly visible in the photo (meterVisible: true/false).
2. Read the exact numeric kWh value printed on the main LCD or mechanical digit drums (detectedReading: number, or -1 if no clear electric meter reading is visible).
3. Compare detectedReading against the collector's claimedReading (${claimedReading}). Set matched=true ONLY if meterVisible is true AND detectedReading matches claimedReading within 0.1 kWh.
4. Provide a concise Arabic discrepancyReason if matched is false (for example: "الرقم الظاهر في الصورة (X) يختلف عن القراءة المدخلة (Y)" or "الصورة لا تُظهر أرقام عداد كهرباء واضحة"). If matched is true, set discrepancyReason to "".`,
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                meterVisible: { type: Type.BOOLEAN },
                detectedReading: { type: Type.NUMBER },
                rawDigits: { type: Type.STRING },
                confidence: { type: Type.NUMBER },
                matched: { type: Type.BOOLEAN },
                discrepancyReason: { type: Type.STRING },
              },
              required: [
                'meterVisible',
                'detectedReading',
                'rawDigits',
                'confidence',
                'matched',
                'discrepancyReason',
              ],
            },
          },
        });

        const parsed = JSON.parse((response.text ?? '{}').trim()) as {
          meterVisible?: boolean;
          detectedReading?: number;
          rawDigits?: string;
          confidence?: number;
          matched?: boolean;
          discrepancyReason?: string;
        };

        const detectedReading =
          typeof parsed.detectedReading === 'number' &&
          Number.isFinite(parsed.detectedReading) &&
          parsed.detectedReading >= 0
            ? Math.round(parsed.detectedReading * 100) / 100
            : -1;
        const confidence = Math.max(
          0,
          Math.min(100, Math.round(Number(parsed.confidence) || 0)),
        );
        const numericMatch =
          Boolean(parsed.meterVisible) &&
          detectedReading >= 0 &&
          Math.abs(detectedReading - claimedReading) <= 0.1;
        const matched = Boolean(parsed.matched) && numericMatch;

        const bucket = getBucket(station.stationId);
        const sub = bucket.subscribers[subscriberId];
        const existingRd = bucket.readings[readingId];
        const now = new Date().toISOString();

        if (!matched) {
          const discrepancyReason =
            String(parsed.discrepancyReason ?? '').trim() ||
            (detectedReading >= 0
              ? `عدم تطابق صورة العداد (${detectedReading}) مع القراءة المدخلة (${claimedReading}).`
              : `الصورة المرفقة لا تُظهر عداداً واضحاً يطابق القراءة المدخلة (${claimedReading}).`);

          const alertId = normalizeId(`al_ai_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`);
          const alertRecord: ManagerAlertRecord = {
            id: alertId,
            stationId: station.stationId,
            alertType: 'photo_mismatch',
            severity: 'critical',
            status: 'pending',
            readingId,
            subscriberId,
            subscriberName: String(
              req.body?.subscriberName ?? sub?.subscriberName ?? 'مشترك',
            ).slice(0, 120),
            meterNumber: String(
              req.body?.meterNumber ?? sub?.meterNumber ?? '',
            ).slice(0, 60),
            collectorName: String(req.body?.collectorName ?? session.name).slice(
              0,
              100,
            ),
            collectorCode: session.code || session.role,
            ...(detectedReading >= 0
              ? { ocrOriginalReading: detectedReading, aiDetectedReading: detectedReading }
              : {}),
            editedReading: claimedReading,
            previousReading,
            difference:
              detectedReading >= 0
                ? Math.round((claimedReading - detectedReading) * 100) / 100
                : Math.round((claimedReading - previousReading) * 100) / 100,
            aiConfidence: confidence,
            aiVerificationReason: discrepancyReason,
            photoUrl: '',
            createdAt: now,
          };

          bucket.alerts[alertId] = alertRecord;
          if (existingRd) {
            existingRd.approvalStatus = 'pending_manager';
            existingRd.aiVerificationStatus = 'mismatch';
            if (detectedReading >= 0) existingRd.aiDetectedReading = detectedReading;
            existingRd.aiConfidence = confidence;
            existingRd.aiVerificationReason = discrepancyReason;
            existingRd.photoUrl = '';
            existingRd.hasLocalPhoto = true;
          }
          saveStore(store);

          res.json({
            enabled: true,
            matched: false,
            detectedReading: detectedReading >= 0 ? detectedReading : null,
            rawDigits: String(parsed.rawDigits ?? ''),
            confidence,
            discrepancyReason,
            alert: alertRecord,
          });
          return;
        }

        if (existingRd) {
          existingRd.aiVerificationStatus = 'matched';
          existingRd.aiDetectedReading = detectedReading;
          existingRd.aiConfidence = confidence;
          existingRd.aiVerificationReason = '';
          existingRd.photoUrl = '';
          existingRd.hasLocalPhoto = true;
          saveStore(store);
        }

        res.json({
          enabled: true,
          matched: true,
          detectedReading,
          rawDigits: String(parsed.rawDigits ?? ''),
          confidence,
          discrepancyReason: '',
        });
      } catch (err) {
        res.status(502).json({
          error:
            err instanceof Error
              ? err.message
              : 'تعذر إتمام مطابقة صورة العداد عبر Gemini Vision-AI.',
        });
      }
    },
  );

  // Instant Manager Alert Endpoint (Gemini Vision-AI Mismatch / High Consumption >3x / Lower Reading)
  // Collector manual_edit alerts are explicitly disabled per policy; photos remain local on collector device.
  app.post('/api/stations/:stationId/alerts', requireStaff, (req, res) => {
    const session = (req as Request & { session: SessionPayload }).session;
    const station = store.stations[req.params.stationId];
    if (!station) {
      res.status(404).json({ error: 'المحطة غير موجودة.' });
      return;
    }

    const codeRec = session.code ? store.codes[session.code] : undefined;
    if (
      session.role === 'collector' &&
      codeRec &&
      !codeRec.permissions.canRecordReadings
    ) {
      res.status(403).json({ error: 'ليست لديك صلاحية إرسال تنبيهات القراءات.' });
      return;
    }

    const bucket = getBucket(station.stationId);
    const alertInput = req.body?.alert ?? req.body;
    if (alertInput?.alertType === 'manual_edit') {
      res.status(400).json({
        error:
          'تم إلغاء تنبيه التعديل اليدوي من المحصّل؛ يتم الاعتماد على مطابقة Gemini Vision-AI أو نقص القراءة.',
      });
      return;
    }

    const alertId = normalizeId(alertInput?.id || `al_${Date.now()}`);
    const subscriberId = normalizeId(alertInput?.subscriberId);
    const sub = bucket.subscribers[subscriberId];

    const alertType: ManagerAlertRecord['alertType'] =
      alertInput?.alertType === 'high_consumption'
        ? 'high_consumption'
        : alertInput?.alertType === 'photo_mismatch'
          ? 'photo_mismatch'
          : 'lower_reading';

    const severity: ManagerAlertRecord['severity'] =
      alertInput?.severity === 'warning' ? 'warning' : 'critical';

    const lowerReason =
      alertInput?.lowerReadingReason === 'meter_replaced' ||
      alertInput?.lowerReadingReason === 'meter_reset' ||
      alertInput?.lowerReadingReason === 'previous_error'
        ? alertInput.lowerReadingReason
        : undefined;

    const record: ManagerAlertRecord = {
      id: alertId,
      stationId: station.stationId,
      alertType,
      severity,
      status: 'pending',
      readingId: normalizeId(alertInput?.readingId),
      subscriberId,
      subscriberName: String(
        alertInput?.subscriberName ?? sub?.subscriberName ?? 'مشترك',
      ).slice(0, 120),
      meterNumber: String(
        alertInput?.meterNumber ?? sub?.meterNumber ?? '',
      ).slice(0, 60),
      collectorName: String(alertInput?.collectorName ?? session.name).slice(0, 100),
      collectorCode: session.code || session.role,
      ...(typeof alertInput?.ocrOriginalReading === 'number'
        ? { ocrOriginalReading: Number(alertInput.ocrOriginalReading) }
        : {}),
      editedReading: Math.max(0, Number(alertInput?.editedReading) || 0),
      previousReading: Math.max(0, Number(alertInput?.previousReading) || 0),
      ...(typeof alertInput?.difference === 'number'
        ? { difference: Number(alertInput.difference) }
        : {}),
      ...(typeof alertInput?.consumptionKwh === 'number'
        ? { consumptionKwh: Math.max(0, Number(alertInput.consumptionKwh)) }
        : {}),
      ...(typeof alertInput?.avg3MonthsKwh === 'number'
        ? { avg3MonthsKwh: Math.max(0, Number(alertInput.avg3MonthsKwh)) }
        : {}),
      ...(lowerReason ? { lowerReadingReason: lowerReason } : {}),
      ...(alertInput?.newMeterNumber
        ? { newMeterNumber: String(alertInput.newMeterNumber).trim().slice(0, 60) }
        : {}),
      ...(typeof alertInput?.openingReading === 'number'
        ? { openingReading: Math.max(0, Number(alertInput.openingReading)) }
        : {}),
      ...(typeof alertInput?.aiDetectedReading === 'number'
        ? { aiDetectedReading: Number(alertInput.aiDetectedReading) }
        : {}),
      ...(typeof alertInput?.aiConfidence === 'number'
        ? { aiConfidence: Number(alertInput.aiConfidence) }
        : {}),
      ...(alertInput?.aiVerificationReason
        ? { aiVerificationReason: String(alertInput.aiVerificationReason).slice(0, 300) }
        : {}),
      // Meter photos stay strictly on the collector's phone local memory, never stored in cloud/Firestore
      photoUrl: '',
      createdAt: String(alertInput?.createdAt ?? new Date().toISOString()),
    };

    bucket.alerts[alertId] = record;

    // Optionally store the linked pending reading (text/numbers only) so the manager can approve/reject right away
    const linkedReading = req.body?.reading;
    if (linkedReading && sub) {
      const rdId = normalizeId(linkedReading.id || record.readingId);
      const prev = Math.max(0, Number(linkedReading.previousReading) || 0);
      const cur = Math.max(0, Number(linkedReading.currentReading) || 0);
      bucket.readings[rdId] = {
        id: rdId,
        subscriberId,
        meterNumber: String(linkedReading.meterNumber ?? sub.meterNumber),
        subscriberName: String(linkedReading.subscriberName ?? sub.subscriberName),
        previousReading: prev,
        currentReading: cur,
        consumptionKwh: Math.max(0, Number(linkedReading.consumptionKwh) || 0),
        kwhPriceYer: Math.max(0, Number(linkedReading.kwhPriceYer) || station.kwhPriceYer),
        currentBillYer: Math.max(0, Number(linkedReading.currentBillYer) || 0),
        previousDebtYer: Math.max(0, Number(linkedReading.previousDebtYer) || 0),
        totalDueYer: Math.max(0, Number(linkedReading.totalDueYer) || 0),
        photoUrl: '',
        photoSizeKb: Math.min(250, Math.max(0, Number(linkedReading.photoSizeKb) || 0)),
        hasLocalPhoto: Boolean(linkedReading.hasLocalPhoto || linkedReading.photoUrl),
        readingSource: linkedReading.wasManuallyEdited ? 'manual_override' : 'camera_ocr',
        ocrConfidence: Math.max(0, Math.min(100, Number(linkedReading.ocrConfidence) || 0)),
        ...(typeof linkedReading.ocrOriginalReading === 'number'
          ? { ocrOriginalReading: Number(linkedReading.ocrOriginalReading) }
          : {}),
        wasManuallyEdited: Boolean(linkedReading.wasManuallyEdited),
        ...(linkedReading.editedAt ? { editedAt: String(linkedReading.editedAt) } : {}),
        approvalStatus:
          alertType === 'high_consumption' ? 'approved' : 'pending_manager',
        ...(lowerReason ? { lowerReadingReason: lowerReason } : {}),
        ...(record.newMeterNumber ? { newMeterNumber: record.newMeterNumber } : {}),
        ...(typeof record.openingReading === 'number'
          ? { openingReading: record.openingReading }
          : {}),
        isClosedHouseZero: Boolean(linkedReading.isClosedHouseZero),
        ...(linkedReading.zeroConsumptionNote
          ? { zeroConsumptionNote: String(linkedReading.zeroConsumptionNote) }
          : {}),
        highConsumptionWarning: alertType === 'high_consumption',
        ...(linkedReading.aiVerificationStatus
          ? { aiVerificationStatus: linkedReading.aiVerificationStatus }
          : {}),
        ...(typeof linkedReading.aiDetectedReading === 'number'
          ? { aiDetectedReading: Number(linkedReading.aiDetectedReading) }
          : {}),
        ...(typeof linkedReading.aiConfidence === 'number'
          ? { aiConfidence: Number(linkedReading.aiConfidence) }
          : {}),
        ...(linkedReading.aiVerificationReason
          ? { aiVerificationReason: String(linkedReading.aiVerificationReason).slice(0, 300) }
          : {}),
        collectorCode: session.code || session.role,
        collectorName: String(linkedReading.collectorName ?? session.name),
        recordedAt: String(linkedReading.recordedAt ?? record.createdAt),
      };
    }

    saveStore(store);
    res.json({ ok: true, alert: record });
  });

  // Manager Decision: Approve or Reject Suspicious / Edited / Lower Reading
  app.post(
    '/api/stations/:stationId/alerts/:alertId/resolve',
    requireStaff,
    (req, res) => {
      const session = (req as Request & { session: SessionPayload }).session;
      if (session.role === 'collector') {
        res.status(403).json({
          error: 'اعتماد أو رفض التعديلات مخصص لمدير المحطة أو الأدمن فقط.',
        });
        return;
      }

      const station = store.stations[req.params.stationId];
      if (!station) {
        res.status(404).json({ error: 'المحطة غير موجودة.' });
        return;
      }

      const bucket = getBucket(station.stationId);
      const alertId = normalizeId(req.params.alertId);
      const alert = bucket.alerts[alertId];
      if (!alert) {
        res.status(404).json({ error: 'الإشعار غير موجود.' });
        return;
      }

      const decision: 'approved' | 'rejected' =
        req.body?.decision === 'rejected' ? 'rejected' : 'approved';
      const now = new Date().toISOString();

      alert.status = decision;
      alert.resolvedAt = now;
      alert.resolvedBy = session.name;
      if (typeof req.body?.managerNote === 'string' && req.body.managerNote.trim()) {
        alert.managerNote = req.body.managerNote.trim().slice(0, 300);
      }

      const reading = bucket.readings[alert.readingId];
      if (reading) {
        reading.approvalStatus = decision;
      }

      const sub = bucket.subscribers[alert.subscriberId];
      if (sub && alert.alertType !== 'high_consumption' && decision === 'approved') {
        if (alert.lowerReadingReason === 'meter_replaced' && alert.newMeterNumber) {
          sub.meterNumber = alert.newMeterNumber;
          const openVal = alert.openingReading ?? alert.editedReading;
          sub.previousReading = openVal <= alert.editedReading ? openVal : alert.editedReading;
          sub.currentReading = alert.editedReading;
        } else {
          const prevCandidate = reading?.previousReading ?? alert.editedReading;
          sub.previousReading =
            prevCandidate <= alert.editedReading ? prevCandidate : alert.editedReading;
          sub.currentReading = alert.editedReading;
        }
        if (reading) {
          const paidForReading = Object.values(bucket.receipts)
            .filter((rc) => rc.readingId === reading.id)
            .reduce((sum, rc) => sum + rc.amountPaidYer, 0);
          sub.previousDebtYer = Math.max(0, reading.totalDueYer - paidForReading);
        }
        sub.updatedAt = now;
      }

      saveStore(store);
      res.json({ ok: true, alert, reading: reading ?? null, subscriber: sub ?? null });
    },
  );

  // Chunked Offline Sync Batch (recommended 20-25 readings+photos per request)
  app.post('/api/stations/:stationId/sync-batch', requireStaff, (req, res) => {
    const session = (req as Request & { session: SessionPayload }).session;
    const station = store.stations[req.params.stationId];
    if (!station) {
      res.status(404).json({ error: 'المحطة غير موجودة.' });
      return;
    }
    if (station.licenseStatus !== 'active') {
      res.status(403).json({ error: 'ترخيص هذه المحطة موقوف من الإدارة.' });
      return;
    }

    const codeRec = session.code ? store.codes[session.code] : undefined;
    const perms: CollectorPermissions =
      session.role === 'collector' && codeRec
        ? codeRec.permissions
        : {
            canRecordReadings: true,
            canCollectCash: true,
            canSendInvoices: true,
            canViewDebts: true,
          };

    const bucket = getBucket(station.stationId);
    const subscribers = Array.isArray(req.body?.subscribers)
      ? req.body.subscribers
      : [];
    const readings = Array.isArray(req.body?.readings) ? req.body.readings : [];
    const receipts = Array.isArray(req.body?.receipts) ? req.body.receipts : [];
    const alerts = Array.isArray(req.body?.alerts) ? req.body.alerts : [];

    if (readings.length > 50 || receipts.length > 50 || alerts.length > 50) {
      res.status(400).json({
        error: 'حجم الدفعة كبير جداً؛ الحد الأقصى 50 سجلاً في الدفعة الواحدة.',
      });
      return;
    }

    let syncedCount = 0;

    for (const sub of subscribers) {
      const subId = normalizeId(sub?.id);
      const existing = bucket.subscribers[subId];
      if (existing) {
        const incomingPrev =
          typeof sub?.previousReading === 'number' && Number.isFinite(sub.previousReading)
            ? Math.max(0, sub.previousReading)
            : existing.previousReading;
        const incomingCurr =
          typeof sub?.currentReading === 'number' && Number.isFinite(sub.currentReading)
            ? Math.max(0, sub.currentReading)
            : existing.currentReading;
        existing.previousReading = incomingPrev;
        existing.currentReading = Math.max(existing.previousReading, incomingCurr);
        existing.previousDebtYer = Math.max(0, Number(sub?.previousDebtYer) || 0);
        existing.updatedAt =
          typeof sub?.updatedAt === 'string' && sub.updatedAt
            ? sub.updatedAt
            : new Date().toISOString();
        syncedCount++;
      }
    }

    if (readings.length > 0) {
      if (!perms.canRecordReadings) {
        res.status(403).json({ error: 'ليست لديك صلاحية رفع القراءات.' });
        return;
      }
      for (const rd of readings) {
        const rdId = normalizeId(rd?.id);
        const subId = normalizeId(rd?.subscriberId);
        const sub = bucket.subscribers[subId];
        if (!sub) continue;

        const prev = Math.max(0, Number(rd?.previousReading) || 0);
        const lowerReason =
          rd?.lowerReadingReason === 'meter_replaced' ||
          rd?.lowerReadingReason === 'meter_reset' ||
          rd?.lowerReadingReason === 'previous_error'
            ? rd.lowerReadingReason
            : undefined;
        const rawCur = Math.max(0, Number(rd?.currentReading) || 0);
        const cur = lowerReason ? rawCur : Math.max(prev, rawCur);
        const wasManuallyEdited = Boolean(rd?.wasManuallyEdited);
        const aiMismatch = rd?.aiVerificationStatus === 'mismatch';
        const requiresManagerApproval = Boolean(lowerReason) || aiMismatch;
        const existingRd = bucket.readings[rdId];
        const approvalStatus: MeterReadingRecord['approvalStatus'] =
          existingRd?.approvalStatus === 'approved' ||
          existingRd?.approvalStatus === 'rejected'
            ? existingRd.approvalStatus
            : requiresManagerApproval
              ? 'pending_manager'
              : 'approved';

        bucket.readings[rdId] = {
          id: rdId,
          subscriberId: subId,
          meterNumber: String(rd?.meterNumber ?? sub.meterNumber),
          subscriberName: String(rd?.subscriberName ?? sub.subscriberName),
          previousReading: prev,
          currentReading: cur,
          consumptionKwh: Math.max(0, Number(rd?.consumptionKwh) || Math.max(0, cur - prev)),
          kwhPriceYer: Math.max(0, Number(rd?.kwhPriceYer) || station.kwhPriceYer),
          currentBillYer: Math.max(0, Number(rd?.currentBillYer) || 0),
          previousDebtYer: Math.max(0, Number(rd?.previousDebtYer) || 0),
          totalDueYer: Math.max(0, Number(rd?.totalDueYer) || 0),
          // Never store meter photos on cloud/Firestore — phone-local storage only
          photoUrl: '',
          photoSizeKb: Math.min(200, Math.max(0, Number(rd?.photoSizeKb) || 0)),
          hasLocalPhoto: Boolean(rd?.hasLocalPhoto || rd?.photoUrl),
          readingSource: wasManuallyEdited ? 'manual_override' : 'camera_ocr',
          ocrConfidence: Math.max(0, Math.min(100, Number(rd?.ocrConfidence) || 0)),
          ...(typeof rd?.ocrOriginalReading === 'number'
            ? { ocrOriginalReading: Number(rd.ocrOriginalReading) }
            : {}),
          wasManuallyEdited,
          ...(rd?.editedAt ? { editedAt: String(rd.editedAt) } : {}),
          approvalStatus,
          ...(lowerReason ? { lowerReadingReason: lowerReason } : {}),
          ...(rd?.newMeterNumber ? { newMeterNumber: String(rd.newMeterNumber).slice(0, 60) } : {}),
          ...(typeof rd?.openingReading === 'number'
            ? { openingReading: Math.max(0, Number(rd.openingReading)) }
            : {}),
          isClosedHouseZero: Boolean(rd?.isClosedHouseZero),
          ...(rd?.zeroConsumptionNote
            ? { zeroConsumptionNote: String(rd.zeroConsumptionNote).slice(0, 120) }
            : {}),
          highConsumptionWarning: Boolean(rd?.highConsumptionWarning),
          ...(rd?.aiVerificationStatus
            ? { aiVerificationStatus: rd.aiVerificationStatus }
            : {}),
          ...(typeof rd?.aiDetectedReading === 'number'
            ? { aiDetectedReading: Number(rd.aiDetectedReading) }
            : {}),
          ...(typeof rd?.aiConfidence === 'number'
            ? { aiConfidence: Number(rd.aiConfidence) }
            : {}),
          ...(rd?.aiVerificationReason
            ? { aiVerificationReason: String(rd.aiVerificationReason).slice(0, 300) }
            : {}),
          ...(typeof rd?.gpsLat === 'number' && Number.isFinite(rd.gpsLat)
            ? { gpsLat: rd.gpsLat }
            : {}),
          ...(typeof rd?.gpsLng === 'number' && Number.isFinite(rd.gpsLng)
            ? { gpsLng: rd.gpsLng }
            : {}),
          ...(typeof rd?.gpsAccuracy === 'number' && Number.isFinite(rd.gpsAccuracy)
            ? { gpsAccuracy: Math.round(rd.gpsAccuracy) }
            : {}),
          collectorCode: session.code || session.role,
          collectorName: String(rd?.collectorName ?? session.name),
          recordedAt: String(rd?.recordedAt ?? new Date().toISOString()),
        };

        const rdRecordedAt = String(rd?.recordedAt ?? '');
        if (
          approvalStatus === 'approved' &&
          (!sub.updatedAt || rdRecordedAt >= sub.updatedAt)
        ) {
          sub.previousReading = prev;
          sub.currentReading = cur;
          if (rdRecordedAt) {
            sub.updatedAt = rdRecordedAt;
          }
        }

        if (
          typeof rd?.gpsLat === 'number' &&
          Number.isFinite(rd.gpsLat) &&
          typeof rd?.gpsLng === 'number' &&
          Number.isFinite(rd.gpsLng)
        ) {
          if (!bucket.collectorLocations) bucket.collectorLocations = {};
          const colKey = normalizeCode(session.code || session.name);
          bucket.collectorLocations[colKey] = {
            collectorCode: colKey,
            collectorName: String(rd?.collectorName ?? session.name),
            lat: rd.gpsLat,
            lng: rd.gpsLng,
            ...(typeof rd?.gpsAccuracy === 'number'
              ? { accuracy: Math.round(rd.gpsAccuracy) }
              : {}),
            lastSubscriberName: sub.subscriberName,
            lastMeterNumber: sub.meterNumber,
            zoneStreet: sub.zoneStreet,
            updatedAt: String(rd?.recordedAt ?? new Date().toISOString()),
          };
        }
        syncedCount++;
      }
    }

    if (alerts.length > 0) {
      if (!perms.canRecordReadings) {
        res.status(403).json({ error: 'ليست لديك صلاحية رفع التنبيهات.' });
        return;
      }
      for (const al of alerts) {
        if (al?.alertType === 'manual_edit') continue;
        const alId = normalizeId(al?.id);
        const subId = normalizeId(al?.subscriberId);
        const existingAl = bucket.alerts[alId];
        if (existingAl && existingAl.status !== 'pending') continue;
        bucket.alerts[alId] = {
          id: alId,
          stationId: station.stationId,
          alertType:
            al?.alertType === 'high_consumption'
              ? 'high_consumption'
              : al?.alertType === 'photo_mismatch'
                ? 'photo_mismatch'
                : 'lower_reading',
          severity: al?.severity === 'warning' ? 'warning' : 'critical',
          status: 'pending',
          readingId: normalizeId(al?.readingId),
          subscriberId: subId,
          subscriberName: String(al?.subscriberName ?? ''),
          meterNumber: String(al?.meterNumber ?? ''),
          collectorName: String(al?.collectorName ?? session.name),
          collectorCode: session.code || session.role,
          ...(typeof al?.ocrOriginalReading === 'number'
            ? { ocrOriginalReading: Number(al.ocrOriginalReading) }
            : {}),
          editedReading: Math.max(0, Number(al?.editedReading) || 0),
          previousReading: Math.max(0, Number(al?.previousReading) || 0),
          ...(typeof al?.difference === 'number'
            ? { difference: Number(al.difference) }
            : {}),
          ...(typeof al?.consumptionKwh === 'number'
            ? { consumptionKwh: Math.max(0, Number(al.consumptionKwh)) }
            : {}),
          ...(typeof al?.avg3MonthsKwh === 'number'
            ? { avg3MonthsKwh: Math.max(0, Number(al.avg3MonthsKwh)) }
            : {}),
          ...(al?.lowerReadingReason ? { lowerReadingReason: al.lowerReadingReason } : {}),
          ...(al?.newMeterNumber ? { newMeterNumber: String(al.newMeterNumber).slice(0, 60) } : {}),
          ...(typeof al?.openingReading === 'number'
            ? { openingReading: Math.max(0, Number(al.openingReading)) }
            : {}),
          ...(typeof al?.aiDetectedReading === 'number'
            ? { aiDetectedReading: Number(al.aiDetectedReading) }
            : {}),
          ...(typeof al?.aiConfidence === 'number'
            ? { aiConfidence: Number(al.aiConfidence) }
            : {}),
          ...(al?.aiVerificationReason
            ? { aiVerificationReason: String(al.aiVerificationReason).slice(0, 300) }
            : {}),
          photoUrl: '',
          createdAt: String(al?.createdAt ?? new Date().toISOString()),
        };
        syncedCount++;
      }
    }

    if (receipts.length > 0) {
      if (!perms.canCollectCash) {
        res.status(403).json({ error: 'ليست لديك صلاحية تحصيل النقد.' });
        return;
      }
      for (const rc of receipts) {
        const rcId = normalizeId(rc?.id);
        const subId = normalizeId(rc?.subscriberId);
        if (!bucket.subscribers[subId]) continue;

        bucket.receipts[rcId] = {
          id: rcId,
          subscriberId: subId,
          meterNumber: String(rc?.meterNumber ?? ''),
          subscriberName: String(rc?.subscriberName ?? ''),
          readingId: normalizeId(rc?.readingId),
          amountPaidYer: Math.max(1, Number(rc?.amountPaidYer) || 0),
          remainingBalanceYer: Math.max(0, Number(rc?.remainingBalanceYer) || 0),
          collectorCode: session.code || session.role,
          collectorName: String(rc?.collectorName ?? session.name),
          paidAt: String(rc?.paidAt ?? new Date().toISOString()),
        };
        syncedCount++;
      }
    }

    saveStore(store);
    res.json({ ok: true, syncedCount });
  });

  // ============================================================
  // Public Subscriber Lookup (Name + Phone from uploaded Excel)
  // ============================================================

  app.post('/api/subscriber/lookup', async (req, res) => {
    const rawIdentifier = String(
      req.body?.subscriberName ?? req.body?.meterNumber ?? '',
    ).trim();
    const rawPhone = String(req.body?.phone ?? '').trim();

    if (!rawIdentifier || !rawPhone) {
      res.status(400).json({
        error: 'يرجى إدخال اسم المشترك الكامل (أو رقم العداد) ورقم الهاتف المسجل.',
      });
      return;
    }

    const targetName = normalizeArabicName(rawIdentifier);
    const targetPhone = normalizePhone(rawPhone);

    for (const station of Object.values(store.stations)) {
      const bucket = getBucket(station.stationId);
      const matchedSub = Object.values(bucket.subscribers).find((sub) => {
        const subPhone = normalizePhone(sub.phone);
        if (subPhone !== targetPhone) return false;
        const nameMatch = normalizeArabicName(sub.subscriberName) === targetName;
        const meterMatch = sub.meterNumber.trim().toLowerCase() === rawIdentifier.toLowerCase();
        return nameMatch || meterMatch;
      });

      if (matchedSub) {
        const readings = Object.values(bucket.readings)
          .filter(
            (r) =>
              r.subscriberId === matchedSub.id ||
              r.meterNumber === matchedSub.meterNumber,
          )
          .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

        const receipts = Object.values(bucket.receipts)
          .filter(
            (rc) =>
              rc.subscriberId === matchedSub.id ||
              rc.meterNumber === matchedSub.meterNumber,
          )
          .sort((a, b) => b.paidAt.localeCompare(a.paidAt));

        res.json({
          stationName: station.stationName,
          subscriber: matchedSub,
          readings,
          receipts,
        });
        return;
      }
    }

    const cloudPortal = await tryLookupSubscriberPortalFromFirestore(
      rawIdentifier,
      rawPhone,
    );
    if (cloudPortal) {
      res.json(cloudPortal);
      return;
    }

    res.status(404).json({
      error:
        'لم يتم العثور على مشترك مطابق للاسم ورقم الهاتف في كشوفات المحطة المرفوعة.',
    });
  });

  // ============================================================
  // Vite Middleware (Dev) or Static Assets (Production)
  // ============================================================

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
      plugins: [
        {
          name: 'ai-studio-disable-hmr-ws',
          enforce: 'post',
          transform(code, id) {
            if (id.includes('vite/dist/client/client.mjs')) {
              return code
                .replace(
                  'transport.connect(createHMRHandler(handleMessage));',
                  '/* HMR disabled */',
                )
                .replace(
                  'else throw new SendBeforeConnectError("send was called before connect");',
                  'else return;',
                );
            }
          },
        },
      ],
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
