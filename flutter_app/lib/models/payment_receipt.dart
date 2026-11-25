class PaymentReceipt {
  final String id;
  final String subscriberId;
  final String meterNumber;
  final String subscriberName;
  final String readingId;
  final double amountPaidYer;
  final double remainingBalanceYer;
  final String collectorUid;
  final String collectorName;
  final DateTime paidAt;
  final String syncStatus; // 'pending' | 'synced'

  const PaymentReceipt({
    required this.id,
    required this.subscriberId,
    required this.meterNumber,
    required this.subscriberName,
    required this.readingId,
    required this.amountPaidYer,
    required this.remainingBalanceYer,
    required this.collectorUid,
    required this.collectorName,
    required this.paidAt,
    this.syncStatus = 'pending',
  });

  PaymentReceipt copyWith({String? syncStatus}) {
    return PaymentReceipt(
      id: id,
      subscriberId: subscriberId,
      meterNumber: meterNumber,
      subscriberName: subscriberName,
      readingId: readingId,
      amountPaidYer: amountPaidYer,
      remainingBalanceYer: remainingBalanceYer,
      collectorUid: collectorUid,
      collectorName: collectorName,
      paidAt: paidAt,
      syncStatus: syncStatus ?? this.syncStatus,
    );
  }

  Map<String, dynamic> toSqliteMap() {
    return {
      'id': id,
      'subscriber_id': subscriberId,
      'meter_number': meterNumber,
      'subscriber_name': subscriberName,
      'reading_id': readingId,
      'amount_paid_yer': amountPaidYer,
      'remaining_balance_yer': remainingBalanceYer,
      'collector_uid': collectorUid,
      'collector_name': collectorName,
      'paid_at': paidAt.toIso8601String(),
      'sync_status': syncStatus,
    };
  }

  factory PaymentReceipt.fromSqliteMap(Map<String, dynamic> map) {
    return PaymentReceipt(
      id: map['id'] as String,
      subscriberId: map['subscriber_id'] as String,
      meterNumber: map['meter_number'] as String,
      subscriberName: map['subscriber_name'] as String,
      readingId: map['reading_id'] as String,
      amountPaidYer: (map['amount_paid_yer'] as num).toDouble(),
      remainingBalanceYer: (map['remaining_balance_yer'] as num).toDouble(),
      collectorUid: map['collector_uid'] as String,
      collectorName: map['collector_name'] as String,
      paidAt: DateTime.parse(map['paid_at'] as String),
      syncStatus: (map['sync_status'] as String?) ?? 'pending',
    );
  }

  Map<String, dynamic> toFirestoreMap(
    dynamic paidAtTimestamp,
    dynamic createdAtTimestamp,
  ) {
    return {
      'subscriberId': subscriberId,
      'meterNumber': meterNumber,
      'subscriberName': subscriberName,
      'readingId': readingId,
      'amountPaidYer': amountPaidYer,
      'remainingBalanceYer': remainingBalanceYer,
      'collectorUid': collectorUid,
      'collectorName': collectorName,
      'paidAt': paidAtTimestamp,
      'createdAt': createdAtTimestamp,
    };
  }
}
