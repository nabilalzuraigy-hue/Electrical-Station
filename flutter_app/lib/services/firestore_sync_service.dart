import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:crypto/crypto.dart';

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
  final DatabaseHelper _db = DatabaseHelper.instance;

  static String computeSubscriberPortalHash(String meterNumber, String phone) {
    final normalizedMeter = meterNumber.trim();
    final normalizedPhone = phone.replaceAll(RegExp(r'\s+'), '').trim();
    final bytes = utf8.encode('$normalizedMeter:$normalizedPhone');
    return sha256.convert(bytes).toString();
  }

  static String computeSubscriberNamePortalHash(
    String subscriberName,
    String phone,
  ) {
    final normalizedName = subscriberName
        .trim()
        .replaceAll(RegExp(r'\s+'), ' ')
        .replaceAll(RegExp(r'[أإآ]'), 'ا')
        .replaceAll('ى', 'ي')
        .replaceAll('ة', 'ه')
        .toLowerCase();
    final normalizedPhone = phone.replaceAll(RegExp(r'\s+'), '').trim();
    final bytes = utf8.encode('name:$normalizedName:$normalizedPhone');
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
    void Function(int done, int total)? onProgress,
  }) async {
    final pendingReadings = await _db.getPendingReadings();
    final pendingReceipts = await _db.getPendingReceipts();
    final pendingSubscribers = await _db.getPendingSubscribers();

    final totalItems =
        pendingSubscribers.length + pendingReadings.length + pendingReceipts.length;
    int doneItems = 0;
    int readingsCount = 0;
    int receiptsCount = 0;
    int subscribersCount = 0;

    // Upload subscriber updates in chunks of 300
    const subChunkSize = 300;
    for (var i = 0; i < pendingSubscribers.length; i += subChunkSize) {
      final chunk = pendingSubscribers.sublist(
        i,
        i + subChunkSize > pendingSubscribers.length
            ? pendingSubscribers.length
            : i + subChunkSize,
      );
      final batch = _firestore.batch();
      for (final sub in chunk) {
        final ref = _firestore
            .collection('stations')
            .doc(stationId)
            .collection('subscribers')
            .doc(sub.id);
        batch.set(ref, sub.toFirestoreMap(FieldValue.serverTimestamp()),
            SetOptions(merge: true));
      }
      await batch.commit();
      for (final sub in chunk) {
        await _db.markSubscriberSynced(sub.id);
        subscribersCount++;
        doneItems++;
      }
      onProgress?.(doneItems, totalItems);
    }

    // Upload readings + compressed photos in safe chunks of 20
    const readingChunkSize = 20;
    for (var i = 0; i < pendingReadings.length; i += readingChunkSize) {
      final chunk = pendingReadings.sublist(
        i,
        i + readingChunkSize > pendingReadings.length
            ? pendingReadings.length
            : i + readingChunkSize,
      );
      for (final reading in chunk) {
        // Keep compressed meter proof photos stored locally on the collector device
        // to prioritize ultra-fast text reading synchronization (< 2 MB total).
        const String photoUrl = '';

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

        final subs = await _db.getRouteSubscribers(query: reading.meterNumber);
        final matchedSub =
            subs.where((s) => s.id == reading.subscriberId).firstOrNull;
        if (matchedSub != null) {
          final portalPayload = {
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
          };

          final meterHash = computeSubscriberPortalHash(
            matchedSub.meterNumber,
            matchedSub.phone,
          );
          final nameHash = computeSubscriberNamePortalHash(
            matchedSub.subscriberName,
            matchedSub.phone,
          );

          await _firestore
              .collection('subscriberPortals')
              .doc(meterHash)
              .set(portalPayload, SetOptions(merge: true));
          await _firestore
              .collection('subscriberPortals')
              .doc(nameHash)
              .set(portalPayload, SetOptions(merge: true));
        }

        await _db.markReadingSynced(reading.id, photoUrl);
        readingsCount++;
        doneItems++;
        onProgress?.(doneItems, totalItems);
      }
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
      doneItems++;
      onProgress?.(doneItems, totalItems);
    }

    return SyncReport(
      readingsSynced: readingsCount,
      receiptsSynced: receiptsCount,
      subscribersSynced: subscribersCount,
    );
  }

  Future<Map<String, dynamic>?> fetchSubscriberPortal({
    required String identifier,
    required String phone,
  }) async {
    final nameHash = computeSubscriberNamePortalHash(identifier, phone);
    final nameDoc =
        await _firestore.collection('subscriberPortals').doc(nameHash).get();
    if (nameDoc.exists) return nameDoc.data();

    final meterHash = computeSubscriberPortalHash(identifier, phone);
    final meterDoc =
        await _firestore.collection('subscriberPortals').doc(meterHash).get();
    if (!meterDoc.exists) return null;
    return meterDoc.data();
  }
}
