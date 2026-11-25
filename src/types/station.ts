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

export interface LicenseRecord {
  code: string;
  stationId: string;
  stationName: string;
  maxCollectors: number;
  maxSubscribers: number;
  status: LicenseStatus;
  activatedByUid?: string;
  activatedByEmail?: string;
  activatedAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectorInvite {
  inviteCode: string;
  stationId: string;
  stationName: string;
  ownerUid: string;
  collectorName: string;
  phone: string;
  assignedZones: string[];
  permissions: CollectorPermissions;
  status: 'unused' | 'claimed' | 'revoked';
  claimedByUid?: string;
  createdAt: string;
}

export interface UserRoleBinding {
  role: 'manager' | 'collector';
  stationId: string;
  stationName: string;
  codeUsed: string;
  active: boolean;
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
}

export interface CollectorProfile {
  id: string;
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

export interface SubscriberPortalRecord {
  stationId: string;
  stationName: string;
  meterNumber: string;
  subscriberName: string;
  zoneStreet: string;
  previousReading: number;
  currentReading: number;
  consumptionKwh: number;
  currentBillYer: number;
  previousDebtYer: number;
  totalDueYer: number;
  lastReadingPhotoUrl: string;
  lastPaymentYer: number;
  updatedAt: string;
}
