import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:crypto/crypto.dart';
import 'package:firebase_storage/firebase_storage.dart';

import '../models/meter_reading.dart';
import '../models/payment_receipt.dart';
import '../models/station_config.dart';
import '../models/subscriber.dart';
import 'database_helper.dart';

class SyncReport {
  final int readingsSynced;
  final int receiptsSynced;
  final int subscribersSynced;

  const SyncReport({
    required this.readingsSynced,
    required this.receiptsSynced,
    required this.subscribersSynced,
  });
}

class FirestoreSyncService {
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  final FirebaseStorage _storage = FirebaseStorage.instance;
  final DatabaseHelper _db = DatabaseHelper.instance;

  static String computeSubscriberPortalHash(String meterNumber, String phone) {
    final normalizedMeter = meterNumber.trim();
    final normalizedPhone = phone.replaceAll(RegExp(r'\s+'), '').trim();
    final bytes = utf8.encode('$normalizedMeter:$normalizedPhone');
    return sha256.convert(bytes).toString();
  }

  Future<StationConfig?> fetchStationConfigFromCloud(String stationId) async {
    final doc = await _firestore.collection('stations').doc(stationId).get();
    if (!doc.exists) return null;
    final d = doc.data()!;
    return StationConfig(
      stationId: doc.id,
      stationName: (d['stationName'] as String?) ?? '',
      kwhPriceYer: ((d['kwhPriceYer'] as num?) ?? 450).toDouble(),
      minimumFeeYer: ((d['minimumFeeYer'] as num?) ?? 0).toDouble(),
      mainGeneratorKwh: ((d['mainGeneratorKwh'] as num?) ?? 0).toDouble(),
      licenseCode: (d['licenseCode'] as String?) ?? '',
      licenseStatus: (d['licenseStatus'] as String?) ?? 'active',
      maxCollectors: (d['maxCollectors'] as num?)?.toInt() ?? 5,
      maxSubscribers: (d['maxSubscribers'] as num?)?.toInt() ?? 1500,
      ownerUid: (d['ownerUid'] as String?) ?? '',
    );
  }

  Future<void> syncStationConfigToCloud(StationConfig config) async {
    await _firestore.collection('stations').doc(config.stationId).update({
      'stationName': config.stationName,
      'kwhPriceYer': config.kwhPriceYer,
      'minimumFeeYer': config.minimumFeeYer,
      'mainGeneratorKwh': config.mainGeneratorKwh,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  Future<void> batchUploadSubscribers({
    required String stationId,
    required List<Subscriber> subscribers,
  }) async {
    const chunkSize = 400;
    for (var i = 0; i < subscribers.length; i += chunkSize) {
      final chunk = subscribers.sublist(
        i,
        i + chunkSize > subscribers.length ? subscribers.length : i + chunkSize,
      );
      final batch = _firestore.batch();
      for (final sub in chunk) {
        final ref = _firestore
            .collection('stations')
            .doc(stationId)
            .collection('subscribers')
            .doc(sub.id);
        batch.set(ref, sub.toFirestoreMap(FieldValue.serverTimestamp()));
      }
      await batch.commit();
    }
  }

  Future<SyncReport> pushOfflineChanges({
    required String stationId,
    required String stationName,
  }) async {
    final pendingReadings = await _db.getPendingReadings();
    final pendingReceipts = await _db.getPendingReceipts();
    final pendingSubscribers = await _db.getPendingSubscribers();

    int readingsCount = 0;
    int receiptsCount = 0;
    int subscribersCount = 0;

    for (final sub in pendingSubscribers) {
      await _firestore
          .collection('stations')
          .doc(stationId)
          .collection('subscribers')
          .doc(sub.id)
          .set(sub.toFirestoreMap(FieldValue.serverTimestamp()),
              SetOptions(merge: true));
      await _db.markSubscriberSynced(sub.id);
      subscribersCount++;
    }

    for (final reading in pendingReadings) {
      String photoUrl = reading.photoCloudUrl ?? '';
      if (photoUrl.isEmpty && reading.photoLocalPath.isNotEmpty) {
        final file = File(reading.photoLocalPath);
        if (await file.exists()) {
          final storageRef = _storage.ref(
              'stations/$stationId/meter_proofs/${reading.meterNumber}_${reading.id}.jpg');
          await storageRef.putFile(
            file,
            SettableMetadata(contentType: 'image/jpeg'),
          );
          photoUrl = await storageRef.getDownloadURL();
        }
      }

      await _firestore
          .collection('stations')
          .doc(stationId)
          .collection('readings')
          .doc(reading.id)
          .set(
            reading.toFirestoreMap(
              Timestamp.fromDate(reading.recordedAt),
              FieldValue.serverTimestamp(),
              photoUrl,
            ),
          );

      // Update subscriber portal lookup hash for dispute-free subscriber access
      final subs = await _db.getRouteSubscribers(query: reading.meterNumber);
      final matchedSub = subs.where((s) => s.id == reading.subscriberId).firstOrNull;
      if (matchedSub != null) {
        final portalHash = computeSubscriberPortalHash(
          matchedSub.meterNumber,
          matchedSub.phone,
        );
        await _firestore.collection('subscriberPortals').doc(portalHash).set({
          'stationId': stationId,
          'stationName': stationName,
          'meterNumber': matchedSub.meterNumber,
          'subscriberName': matchedSub.subscriberName,
          'zoneStreet': matchedSub.zoneStreet,
          'previousReading': reading.previousReading,
          'currentReading': reading.currentReading,
          'consumptionKwh': reading.consumptionKwh,
          'currentBillYer': reading.currentBillYer,
          'previousDebtYer': matchedSub.previousDebtYer,
          'totalDueYer': reading.totalDueYer,
          'lastReadingPhotoUrl': photoUrl,
          'lastPaymentYer': 0,
          'updatedAt': FieldValue.serverTimestamp(),
        }, SetOptions(merge: true));
      }

      await _db.markReadingSynced(reading.id, photoUrl);
      readingsCount++;
    }

    for (final receipt in pendingReceipts) {
      await _firestore
          .collection('stations')
          .doc(stationId)
          .collection('receipts')
          .doc(receipt.id)
          .set(
            receipt.toFirestoreMap(
              Timestamp.fromDate(receipt.paidAt),
              FieldValue.serverTimestamp(),
            ),
          );
      await _db.markReceiptSynced(receipt.id);
      receiptsCount++;
    }

    return SyncReport(
      readingsSynced: readingsCount,
      receiptsSynced: receiptsCount,
      subscribersSynced: subscribersCount,
    );
  }

  Future<Map<String, dynamic>?> fetchSubscriberPortal({
    required String meterNumber,
    required String phone,
  }) async {
    final lookupHash = computeSubscriberPortalHash(meterNumber, phone);
    final doc =
        await _firestore.collection('subscriberPortals').doc(lookupHash).get();
    if (!doc.exists) return null;
    return doc.data();
  }
}
