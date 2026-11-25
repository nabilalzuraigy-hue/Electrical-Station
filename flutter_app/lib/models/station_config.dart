class CollectorPermissions {
  final bool canRecordReadings;
  final bool canCollectCash;
  final bool canSendInvoices;
  final bool canViewDebts;

  const CollectorPermissions({
    this.canRecordReadings = true,
    this.canCollectCash = true,
    this.canSendInvoices = true,
    this.canViewDebts = true,
  });

  factory CollectorPermissions.fromMap(Map<String, dynamic>? map) {
    if (map == null) return const CollectorPermissions();
    return CollectorPermissions(
      canRecordReadings: map['canRecordReadings'] == true,
      canCollectCash: map['canCollectCash'] == true,
      canSendInvoices: map['canSendInvoices'] == true,
      canViewDebts: map['canViewDebts'] == true,
    );
  }

  Map<String, dynamic> toMap() => {
        'canRecordReadings': canRecordReadings,
        'canCollectCash': canCollectCash,
        'canSendInvoices': canSendInvoices,
        'canViewDebts': canViewDebts,
      };
}

class StationConfig {
  final String stationId;
  final String stationName;
  final double kwhPriceYer;
  final double minimumFeeYer;
  final double mainGeneratorKwh;
  final String licenseCode;
  final String licenseStatus;
  final int maxCollectors;
  final int maxSubscribers;
  final String ownerUid;

  const StationConfig({
    required this.stationId,
    required this.stationName,
    required this.kwhPriceYer,
    required this.minimumFeeYer,
    required this.mainGeneratorKwh,
    required this.licenseCode,
    required this.licenseStatus,
    required this.maxCollectors,
    required this.maxSubscribers,
    required this.ownerUid,
  });

  Map<String, dynamic> toSqliteMap() {
    return {
      'station_id': stationId,
      'station_name': stationName,
      'kwh_price_yer': kwhPriceYer,
      'minimum_fee_yer': minimumFeeYer,
      'main_generator_kwh': mainGeneratorKwh,
      'license_code': licenseCode,
      'license_status': licenseStatus,
      'max_collectors': maxCollectors,
      'max_subscribers': maxSubscribers,
      'owner_uid': ownerUid,
    };
  }

  factory StationConfig.fromSqliteMap(Map<String, dynamic> map) {
    return StationConfig(
      stationId: map['station_id'] as String,
      stationName: map['station_name'] as String,
      kwhPriceYer: (map['kwh_price_yer'] as num).toDouble(),
      minimumFeeYer: (map['minimum_fee_yer'] as num).toDouble(),
      mainGeneratorKwh: (map['main_generator_kwh'] as num).toDouble(),
      licenseCode: (map['license_code'] as String?) ?? '',
      licenseStatus: (map['license_status'] as String?) ?? 'active',
      maxCollectors: (map['max_collectors'] as int?) ?? 5,
      maxSubscribers: (map['max_subscribers'] as int?) ?? 1500,
      ownerUid: map['owner_uid'] as String,
    );
  }
}

class CollectorProfile {
  final String id;
  final String name;
  final String email;
  final String phone;
  final List<String> assignedZones;
  final CollectorPermissions permissions;
  final bool active;

  const CollectorProfile({
    required this.id,
    required this.name,
    required this.email,
    required this.phone,
    required this.assignedZones,
    required this.permissions,
    this.active = true,
  });
}
