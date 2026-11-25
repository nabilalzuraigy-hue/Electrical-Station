import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  collectorCode: string;
  collectorName: string;
  recordedAt: string;
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
    };
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
    };
  }

  return {
    station,
    collectors: stationCodes.filter((c) => c.role === 'collector'),
    managers: stationCodes.filter((c) => c.role === 'manager'),
    subscribers: allSubscribers,
    readings: allReadings,
    receipts: allReceipts,
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
    const rawCredential = String(req.body?.credential ?? '').trim();
    if (!rawCredential) {
      res.status(400).json({ error: 'يرجى إدخال بيانات الدخول.' });
      return;
    }

    // 1. Check Admin Passcode
    const envPasscode = process.env.ADMIN_PASSCODE?.trim();
    const isAdminPass = envPasscode
      ? verifyEnvPasscode(rawCredential, envPasscode)
      : store.adminPasscodeHash
        ? verifyScryptHash(rawCredential, store.adminPasscodeHash)
        : false;

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
    const normalizedCode = normalizeCode(rawCredential);
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

    // 3. Check Subscriber Name + Phone (e.g. "الاسم 77xxxxxxx" or "الاسم - 77xxxxxxx")
    const normalizedDigitsCredential = rawCredential.replace(/[٠-٩]/g, (d) =>
      String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)),
    );
    const phoneMatch = normalizedDigitsCredential.match(
      /(?:\+?967|00967)?\s*\d[\d\s-]{6,14}\d/,
    );
    if (phoneMatch) {
      const targetPhone = normalizePhone(phoneMatch[0]);
      const namePart = normalizedDigitsCredential
        .replace(phoneMatch[0], ' ')
        .replace(/[-/|،,]+/g, ' ')
        .trim();
      const targetName = normalizeArabicName(namePart);

      if (targetPhone.length >= 7 && targetName.length >= 2) {
        for (const station of Object.values(store.stations)) {
          const bucket = getBucket(station.stationId);
          const matchedSub = Object.values(bucket.subscribers).find((sub) => {
            if (normalizePhone(sub.phone) !== targetPhone) return false;
            return (
              normalizeArabicName(sub.subscriberName) === targetName ||
              sub.meterNumber.trim().toLowerCase() === namePart.toLowerCase()
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

    if (readings.length > 50 || receipts.length > 50) {
      res.status(400).json({
        error: 'حجم الدفعة كبير جداً؛ الحد الأقصى 50 قراءة في الدفعة الواحدة.',
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
        const cur = Math.max(prev, Number(rd?.currentReading) || prev);
        const photoUrl = String(rd?.photoUrl ?? '').slice(0, 220000);

        bucket.readings[rdId] = {
          id: rdId,
          subscriberId: subId,
          meterNumber: String(rd?.meterNumber ?? sub.meterNumber),
          subscriberName: String(rd?.subscriberName ?? sub.subscriberName),
          previousReading: prev,
          currentReading: cur,
          consumptionKwh: Math.max(0, Number(rd?.consumptionKwh) || cur - prev),
          kwhPriceYer: Math.max(0, Number(rd?.kwhPriceYer) || station.kwhPriceYer),
          currentBillYer: Math.max(0, Number(rd?.currentBillYer) || 0),
          previousDebtYer: Math.max(0, Number(rd?.previousDebtYer) || 0),
          totalDueYer: Math.max(0, Number(rd?.totalDueYer) || 0),
          photoUrl,
          photoSizeKb: Math.min(200, Math.max(0, Number(rd?.photoSizeKb) || 0)),
          hasLocalPhoto: Boolean(rd?.hasLocalPhoto || photoUrl),
          collectorCode: session.code || session.role,
          collectorName: String(rd?.collectorName ?? session.name),
          recordedAt: String(rd?.recordedAt ?? new Date().toISOString()),
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
