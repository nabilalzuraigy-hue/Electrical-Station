class Subscriber {
  final String id;
  final String meterNumber;
  final String subscriberName;
  final String phone;
  final double previousReading;
  final double currentReading;
  final double previousDebtYer;
  final String zoneStreet;
  final int sequenceOrder;
  final String? assignedCollectorId;
  final String syncStatus; // 'synced' | 'pending'
  final DateTime updatedAt;

  const Subscriber({
    required this.id,
    required this.meterNumber,
    required this.subscriberName,
    required this.phone,
    required this.previousReading,
    required this.currentReading,
    required this.previousDebtYer,
    required this.zoneStreet,
    required this.sequenceOrder,
    this.assignedCollectorId,
    this.syncStatus = 'synced',
    required this.updatedAt,
  });

  Subscriber copyWith({
    String? id,
    String? meterNumber,
    String? subscriberName,
    String? phone,
    double? previousReading,
    double? currentReading,
    double? previousDebtYer,
    String? zoneStreet,
    int? sequenceOrder,
    String? assignedCollectorId,
    String? syncStatus,
    DateTime? updatedAt,
  }) {
    return Subscriber(
      id: id ?? this.id,
      meterNumber: meterNumber ?? this.meterNumber,
      subscriberName: subscriberName ?? this.subscriberName,
      phone: phone ?? this.phone,
      previousReading: previousReading ?? this.previousReading,
      currentReading: currentReading ?? this.currentReading,
      previousDebtYer: previousDebtYer ?? this.previousDebtYer,
      zoneStreet: zoneStreet ?? this.zoneStreet,
      sequenceOrder: sequenceOrder ?? this.sequenceOrder,
      assignedCollectorId: assignedCollectorId ?? this.assignedCollectorId,
      syncStatus: syncStatus ?? this.syncStatus,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  Map<String, dynamic> toSqliteMap() {
    return {
      'id': id,
      'meter_number': meterNumber,
      'subscriber_name': subscriberName,
      'phone': phone,
      'previous_reading': previousReading,
      'current_reading': currentReading,
      'previous_debt_yer': previousDebtYer,
      'zone_street': zoneStreet,
      'sequence_order': sequenceOrder,
      'assigned_collector_id': assignedCollectorId,
      'sync_status': syncStatus,
      'updated_at': updatedAt.toIso8601String(),
    };
  }

  factory Subscriber.fromSqliteMap(Map<String, dynamic> map) {
    return Subscriber(
      id: map['id'] as String,
      meterNumber: map['meter_number'] as String,
      subscriberName: map['subscriber_name'] as String,
      phone: map['phone'] as String,
      previousReading: (map['previous_reading'] as num).toDouble(),
      currentReading: (map['current_reading'] as num).toDouble(),
      previousDebtYer: (map['previous_debt_yer'] as num).toDouble(),
      zoneStreet: map['zone_street'] as String,
      sequenceOrder: (map['sequence_order'] as num).toInt(),
      assignedCollectorId: map['assigned_collector_id'] as String?,
      syncStatus: (map['sync_status'] as String?) ?? 'synced',
      updatedAt: DateTime.parse(map['updated_at'] as String),
    );
  }

  Map<String, dynamic> toFirestoreMap(dynamic serverTimestamp) {
    return {
      'meterNumber': meterNumber,
      'subscriberName': subscriberName,
      'phone': phone,
      'previousReading': previousReading,
      'currentReading': currentReading,
      'previousDebtYer': previousDebtYer,
      'zoneStreet': zoneStreet,
      'sequenceOrder': sequenceOrder,
      if (assignedCollectorId != null)
        'assignedCollectorId': assignedCollectorId,
      'updatedAt': serverTimestamp,
    };
  }
}
