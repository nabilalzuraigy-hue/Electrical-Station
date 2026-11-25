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
  collectorCode: string;
  collectorName: string;
  recordedAt: string;
}

interface ManagerAlertRecord {
  id: string;
  stationId: string;
  alertType: 'manual_edit' | 'high_consumption' | 'lower_reading';
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

interface StationDataBucket {
  subscribers: Record<string, SubscriberRecord>;
  readings: Record<string, MeterReadingRecord>;
  receipts: Record<string, PaymentReceiptRecord>;
  alerts: Record<string, ManagerAlertRecord>;
}

interface PersistentStore {
  adminPasscodeHash: string | null;
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
const SESSION_SECRET =
  process.env.SESSION_SECRET?.trim() || crypto.randomBytes(32).toString('hex');
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

function loadStore(): PersistentStore {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return {
      adminPasscodeHash: null,
      stations: {},
      codes: {},
      stationData: {},
    };
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistentStore>;
    return {
      adminPasscodeHash: parsed.adminPasscodeHash ?? null,
      stations: parsed.stations ?? {},
      codes: parsed.codes ?? {},
      stationData: parsed.stationData ?? {},
    };
  } catch {
    return {
      adminPasscodeHash: null,
      stations: {},
      codes: {},
      stationData: {},
    };
  }
}

function saveStore(store: PersistentStore): void {
  ensureDataDir();
  const tmpPath = `${STORE_FILE}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store), 'utf8');
  fs.renameSync(tmpPath, STORE_FILE);
}

let store: PersistentStore = loadStore();

function getBucket(stationId: string): StationDataBucket {
  if (!store.stationData[stationId]) {
    store.stationData[stationId] = {
      subscribers: {},
      readings: {},
      receipts: {},
      alerts: {},
    };
  } else if (!store.stationData[stationId].alerts) {
    store.stationData[stationId].alerts = {};
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

function verifyEnvPasscode(passcode: string, envPasscode: string): boolean {
  const a = crypto.createHash('sha256').update(passcode).digest();
  const b = crypto.createHash('sha256').update(envPasscode).digest();
  return crypto.timingSafeEqual(a, b);
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

function extractBearer(req: Request): SessionPayload | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return verifySessionToken(authHeader.slice(7).trim());
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = extractBearer(req);
  if (!session || session.role !== 'admin') {
    res.status(401).json({ error: 'صلاحية الأدمن المطور مطلوبة.' });
    return;
  }
  (req as Request & { session: SessionPayload }).session = session;
  next();
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
    const filteredSubscribers =
      zones.length > 0
        ? allSubscribers.filter((s) => zones.includes(s.zoneStreet))
        : allSubscribers;
    const subIds = new Set(filteredSubscribers.map((s) => s.id));
    return {
      station,
      collectors: colRecord ? [colRecord] : [],
      subscribers: filteredSubscribers,
      readings: allReadings.filter((r) => subIds.has(r.subscriberId)),
      receipts: allReceipts.filter((rc) => subIds.has(rc.subscriberId)),
      alerts: [],
    };
  }

  return {
    station,
    collectors: stationCodes.filter((c) => c.role === 'collector'),
    managers: stationCodes.filter((c) => c.role === 'manager'),
    subscribers: allSubscribers,
    readings: allReadings,
    receipts: allReceipts,
    alerts: allAlerts,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // ============================================================
  // Admin Passcode Auth (env ADMIN_PASSCODE or one-time claim)
  // ============================================================

  app.get('/api/admin/status', (_req, res) => {
    const envConfigured = Boolean(process.env.ADMIN_PASSCODE?.trim());
    const configured = envConfigured || Boolean(store.adminPasscodeHash);
    res.json({ configured });
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
    if (passcode.length < 6 || passcode.length > 128) {
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

    const envPasscode = process.env.ADMIN_PASSCODE?.trim();
    let valid = false;
    if (envPasscode) {
      valid = verifyEnvPasscode(passcode, envPasscode);
    } else if (store.adminPasscodeHash) {
      valid = verifyScryptHash(passcode, store.adminPasscodeHash);
    } else {
      res.status(400).json({
        error: 'لم يتم تعيين كلمة مرور الأدمن بعد. يرجى تعيينها أولاً.',
      });
      return;
    }

    if (!valid) {
      res.status(401).json({ error: 'كلمة مرور الأدمن غير صحيحة.' });
      return;
    }

    const token = signSessionToken({
      role: 'admin',
      name: 'الأدمن المطور',
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ token, name: 'الأدمن المطور' });
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

  // ============================================================
  // Unified Public Login (Admin Passcode / Manager or Collector Code / Subscriber Name+Phone)
  // ============================================================

  app.post('/api/auth/unified', (req, res) => {
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
    const envPasscode = process.env.ADMIN_PASSCODE?.trim();
    const isAdminPass = candidates.some((cand) =>
      envPasscode
        ? verifyEnvPasscode(cand, envPasscode)
        : store.adminPasscodeHash
          ? verifyScryptHash(cand, store.adminPasscodeHash)
          : false,
    );

    if (isAdminPass) {
      const token = signSessionToken({
        role: 'admin',
        name: 'الأدمن المطور',
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      res.json({ kind: 'admin', token, name: 'الأدمن المطور' });
      return;
    }

    // 2. Check Manager / Collector Code
    for (const cand of candidates) {
      const normalizedCode = normalizeCode(cand);
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
    }

    res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
  });

  // ============================================================
  // Public Code Login (Manager or Collector Code)
  // ============================================================

  app.post('/api/auth/code', (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!code || code.length < 4) {
      res.status(400).json({ error: 'يرجى إدخال كود الدخول الصحيح.' });
      return;
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
    station.updatedAt = new Date().toISOString();
    saveStore(store);
    res.json({ station });
  });

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
Extract the exact cumulative kWh meter reading shown on the main digital LCD or mechanical digit drums.
Preserve the decimal fraction only if a clear decimal separator or distinct red tenths drum is part of the kWh register; do not guess or invent digits. Ignore meter serial numbers, barcodes, voltage/ampere ratings (e.g. 220V, 50Hz, 10(40)A), or timestamps.
Be conservative with confidence: only report confidence >= 85 when every single digit is crisp and unambiguous.
If no clear electric meter kWh reading is visible in the image, set isClearMeter to false, detectedReading to -1, and confidence to 0.`,
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

  // Instant Manager Alert Endpoint (Manual OCR Edit / High Consumption >3x / Lower Reading)
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
    const alertId = normalizeId(alertInput?.id || `al_${Date.now()}`);
    const subscriberId = normalizeId(alertInput?.subscriberId);
    const sub = bucket.subscribers[subscriberId];

    const alertType: ManagerAlertRecord['alertType'] =
      alertInput?.alertType === 'high_consumption'
        ? 'high_consumption'
        : alertInput?.alertType === 'lower_reading'
          ? 'lower_reading'
          : 'manual_edit';

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
      photoUrl: String(alertInput?.photoUrl ?? '').slice(0, 260000),
      createdAt: String(alertInput?.createdAt ?? new Date().toISOString()),
    };

    bucket.alerts[alertId] = record;

    // Optionally store the linked pending reading immediately so the manager can approve/reject it right away
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
        photoUrl: String(linkedReading.photoUrl ?? record.photoUrl).slice(0, 260000),
        photoSizeKb: Math.min(250, Math.max(0, Number(linkedReading.photoSizeKb) || 0)),
        hasLocalPhoto: true,
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
          const nextVal = alert.openingReading ?? alert.editedReading;
          sub.previousReading = nextVal;
          sub.currentReading = nextVal;
        } else {
          sub.previousReading = alert.editedReading;
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
        existing.previousReading = Math.max(0, Number(sub?.previousReading) || existing.previousReading);
        existing.currentReading = Math.max(
          existing.previousReading,
          Number(sub?.currentReading) || existing.currentReading,
        );
        existing.previousDebtYer = Math.max(0, Number(sub?.previousDebtYer) || 0);
        existing.updatedAt = new Date().toISOString();
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
        const requiresManagerApproval = wasManuallyEdited || Boolean(lowerReason);
        const existingRd = bucket.readings[rdId];
        const approvalStatus: MeterReadingRecord['approvalStatus'] =
          existingRd?.approvalStatus === 'approved' ||
          existingRd?.approvalStatus === 'rejected'
            ? existingRd.approvalStatus
            : requiresManagerApproval
              ? 'pending_manager'
              : 'approved';

        const photoUrl = String(rd?.photoUrl ?? '').slice(0, 220000);

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
          photoUrl,
          photoSizeKb: Math.min(200, Math.max(0, Number(rd?.photoSizeKb) || 0)),
          hasLocalPhoto: Boolean(rd?.hasLocalPhoto || photoUrl),
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
          collectorCode: session.code || session.role,
          collectorName: String(rd?.collectorName ?? session.name),
          recordedAt: String(rd?.recordedAt ?? new Date().toISOString()),
        };
        syncedCount++;
      }
    }

    if (alerts.length > 0) {
      if (!perms.canRecordReadings) {
        res.status(403).json({ error: 'ليست لديك صلاحية رفع التنبيهات.' });
        return;
      }
      for (const al of alerts) {
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
              : al?.alertType === 'lower_reading'
                ? 'lower_reading'
                : 'manual_edit',
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
          photoUrl: String(al?.photoUrl ?? '').slice(0, 260000),
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

  app.post('/api/subscriber/lookup', (req, res) => {
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
      server: { middlewareMode: true },
      appType: 'spa',
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
