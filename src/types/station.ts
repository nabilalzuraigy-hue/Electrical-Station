export type AppRoleTab =
  | 'activation'
  | 'admin'
  | 'manager'
  | 'collector'
  | 'subscriber'
  | 'flutter';

export type SyncStatus = 'synced' | 'pending';

export type LicenseStatus = 'unused' | 'active' | 'suspended' | 'expired';

export interface CollectorPermissions {
  canRecordReadings: boolean;
  canCollectCash: boolean;
  canSendInvoices: boolean;
  canViewDebts: boolean;
}

export interface AccessCodeRecord {
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

export interface StationConfig {
  stationId: string;
  stationName: string;
  kwhPriceYer: number;
  minimumFeeYer: number;
  mainGeneratorKwh: number;
  licenseCode: string;
  licenseStatus: 'active' | 'suspended';
  maxCollectors: number;
  maxSubscribers: number;
  ownerUid: string;
  updatedAt: string;
  subscriberCount?: number;
  readingCount?: number;
  receiptCount?: number;
}

export interface CollectorProfile {
  id: string;
  code?: string;
  name: string;
  email: string;
  phone: string;
  assignedZones: string[];
  permissions: CollectorPermissions;
  active: boolean;
  inviteCode?: string;
  createdAt: string;
}

export interface Subscriber {
  id: string;
  meterNumber: string;
  subscriberName: string;
  phone: string;
  previousReading: number;
  currentReading: number;
  previousDebtYer: number;
  zoneStreet: string;
  sequenceOrder: number;
  assignedCollectorId?: string;
  importedLocally?: boolean;
  syncStatus: SyncStatus;
  updatedAt: string;
}

export interface MeterReading {
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
  collectorUid: string;
  collectorName: string;
  recordedAt: string;
  syncStatus: SyncStatus;
}

export interface PaymentReceipt {
  id: string;
  subscriberId: string;
  meterNumber: string;
  subscriberName: string;
  readingId: string;
  amountPaidYer: number;
  remainingBalanceYer: number;
  collectorUid: string;
  collectorName: string;
  paidAt: string;
  syncStatus: SyncStatus;
}

export interface SubscriberLookupResult {
  stationName: string;
  subscriber: Subscriber;
  readings: MeterReading[];
  receipts: PaymentReceipt[];
}

export interface SyncProgress {
  completed: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
}
