class MeterReading {
  final String id;
  final String subscriberId;
  final String meterNumber;
  final String subscriberName;
  final double previousReading;
  final double currentReading;
  final double consumptionKwh;
  final double kwhPriceYer;
  final double currentBillYer;
  final double previousDebtYer;
  final double totalDueYer;
  final String photoLocalPath;
  final String? photoCloudUrl;
  final double photoSizeKb;
  final String collectorUid;
  final String collectorName;
  final DateTime recordedAt;
  final String syncStatus; // 'pending' | 'synced'

  const MeterReading({
    required this.id,
    required this.subscriberId,
    required this.meterNumber,
    required this.subscriberName,
    required this.previousReading,
    required this.currentReading,
    required this.consumptionKwh,
    required this.kwhPriceYer,
    required this.currentBillYer,
    required this.previousDebtYer,
    required this.totalDueYer,
    required this.photoLocalPath,
    this.photoCloudUrl,
    required this.photoSizeKb,
    required this.collectorUid,
    required this.collectorName,
    required this.recordedAt,
    this.syncStatus = 'pending',
  });

  MeterReading copyWith({
    String? photoCloudUrl,
    String? syncStatus,
  }) {
    return MeterReading(
      id: id,
      subscriberId: subscriberId,
      meterNumber: meterNumber,
      subscriberName: subscriberName,
      previousReading: previousReading,
      currentReading: currentReading,
      consumptionKwh: consumptionKwh,
      kwhPriceYer: kwhPriceYer,
      currentBillYer: currentBillYer,
      previousDebtYer: previousDebtYer,
      totalDueYer: totalDueYer,
      photoLocalPath: photoLocalPath,
      photoCloudUrl: photoCloudUrl ?? this.photoCloudUrl,
      photoSizeKb: photoSizeKb,
      collectorUid: collectorUid,
      collectorName: collectorName,
      recordedAt: recordedAt,
      syncStatus: syncStatus ?? this.syncStatus,
    );
  }

  Map<String, dynamic> toSqliteMap() {
    return {
      'id': id,
      'subscriber_id': subscriberId,
      'meter_number': meterNumber,
      'subscriber_name': subscriberName,
      'previous_reading': previousReading,
      'current_reading': currentReading,
      'consumption_kwh': consumptionKwh,
      'kwh_price_yer': kwhPriceYer,
      'current_bill_yer': currentBillYer,
      'previous_debt_yer': previousDebtYer,
      'total_due_yer': totalDueYer,
      'photo_local_path': photoLocalPath,
      'photo_cloud_url': photoCloudUrl,
      'photo_size_kb': photoSizeKb,
      'collector_uid': collectorUid,
      'collector_name': collectorName,
      'recorded_at': recordedAt.toIso8601String(),
      'sync_status': syncStatus,
    };
  }

  factory MeterReading.fromSqliteMap(Map<String, dynamic> map) {
    return MeterReading(
      id: map['id'] as String,
      subscriberId: map['subscriber_id'] as String,
      meterNumber: map['meter_number'] as String,
      subscriberName: map['subscriber_name'] as String,
      previousReading: (map['previous_reading'] as num).toDouble(),
      currentReading: (map['current_reading'] as num).toDouble(),
      consumptionKwh: (map['consumption_kwh'] as num).toDouble(),
      kwhPriceYer: (map['kwh_price_yer'] as num).toDouble(),
      currentBillYer: (map['current_bill_yer'] as num).toDouble(),
      previousDebtYer: (map['previous_debt_yer'] as num).toDouble(),
      totalDueYer: (map['total_due_yer'] as num).toDouble(),
      photoLocalPath: (map['photo_local_path'] as String?) ?? '',
      photoCloudUrl: map['photo_cloud_url'] as String?,
      photoSizeKb: (map['photo_size_kb'] as num).toDouble(),
      collectorUid: map['collector_uid'] as String,
      collectorName: map['collector_name'] as String,
      recordedAt: DateTime.parse(map['recorded_at'] as String),
      syncStatus: (map['sync_status'] as String?) ?? 'pending',
    );
  }

  Map<String, dynamic> toFirestoreMap(
    dynamic recordedAtTimestamp,
    dynamic createdAtTimestamp,
    String uploadedPhotoUrl,
  ) {
    return {
      'subscriberId': subscriberId,
      'meterNumber': meterNumber,
      'subscriberName': subscriberName,
      'previousReading': previousReading,
      'currentReading': currentReading,
      'consumptionKwh': consumptionKwh,
      'kwhPriceYer': kwhPriceYer,
      'currentBillYer': currentBillYer,
      'previousDebtYer': previousDebtYer,
      'totalDueYer': totalDueYer,
      'photoUrl': uploadedPhotoUrl,
      'photoSizeKb': photoSizeKb,
      'collectorUid': collectorUid,
      'collectorName': collectorName,
      'recordedAt': recordedAtTimestamp,
      'createdAt': createdAtTimestamp,
    };
  }
}
