import 'package:flutter/material.dart';

import '../../core/currency_formatter.dart';
import '../../models/station_config.dart';
import '../../models/subscriber.dart';
import '../../services/database_helper.dart';
import '../../services/firestore_sync_service.dart';
import 'meter_ocr_reading_screen.dart';

class CollectorRouteScreen extends StatefulWidget {
  final String stationId;
  final CollectorProfile? collectorProfile;
  const CollectorRouteScreen({
    super.key,
    required this.stationId,
    this.collectorProfile,
  });

  @override
  State<CollectorRouteScreen> createState() => _CollectorRouteScreenState();
}

class _CollectorRouteScreenState extends State<CollectorRouteScreen> {
  final DatabaseHelper _db = DatabaseHelper.instance;
  final FirestoreSyncService _syncService = FirestoreSyncService();
  final TextEditingController _searchController = TextEditingController();

  List<Subscriber> _subscribers = [];
  int _pendingSyncCount = 0;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    _refreshRoute();
  }

  Future<void> _refreshRoute() async {
    final list = await _db.getRouteSubscribers(query: _searchController.text);
    final allowedZones = widget.collectorProfile?.assignedZones ?? const [];
    final filtered = allowedZones.isEmpty
        ? list
        : list.where((s) => allowedZones.contains(s.zoneStreet)).toList();

    final pending = await _db.getPendingSyncCount();
    if (!mounted) return;
    setState(() {
      _subscribers = filtered;
      _pendingSyncCount = pending;
    });
  }

  Future<void> _syncNow() async {
    setState(() => _syncing = true);
    try {
      final cfg = await _db.getStationConfig();
      final report = await _syncService.pushOfflineChanges(
        stationId: widget.stationId,
        stationName: cfg?.stationName ?? 'المحطة',
      );
      await _refreshRoute();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'تمت المزامنة: ${report.readingsSynced} قراءة · ${report.receiptsSynced} سند قبض',
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isActive = widget.collectorProfile?.active ?? true;
    final perms =
        widget.collectorProfile?.permissions ?? const CollectorPermissions();

    if (!isActive) {
      return Scaffold(
        appBar: AppBar(title: const Text('حساب المحصّل موقوف')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'تم إيقاف تفعيل حسابك من قِبل مدير المحطة. يرجى التواصل مع الإدارة.',
              textAlign: TextAlign.center,
            ),
          ),
        ),
      );
    }

    final isSynced = _pendingSyncCount == 0;
    return Scaffold(
      appBar: AppBar(
        title: const Text('خط السير الميداني (أوفلاين)'),
        actions: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: TextButton.icon(
              onPressed: _syncing ? null : _syncNow,
              icon: Icon(
                isSynced ? Icons.cloud_done_rounded : Icons.cloud_upload_rounded,
                color: isSynced ? Colors.teal : Colors.amber.shade800,
              ),
              label: Text(
                isSynced
                    ? 'تمت المزامنة'
                    : 'مزامنة ($_pendingSyncCount معلق)',
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              controller: _searchController,
              onChanged: (_) => _refreshRoute(),
              decoration: InputDecoration(
                hintText: 'ابحث بآخر 3-4 أرقام من العداد أو اسم المشترك...',
                prefixIcon: const Icon(Icons.search_rounded),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
          ),
          Expanded(
            child: _subscribers.isEmpty
                ? const Center(
                    child: Text('لا يوجد مشتركين في خط السير المخصص لك'),
                  )
                : ListView.separated(
                    itemCount: _subscribers.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final sub = _subscribers[index];
                      return ListTile(
                        minVerticalPadding: 14,
                        leading: CircleAvatar(
                          backgroundColor: const Color(0xFFE6FFFA),
                          child: Text('${sub.sequenceOrder}'),
                        ),
                        title: Text(
                          sub.subscriberName,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        subtitle: Text(
                          '${sub.zoneStreet} · عداد ${sub.meterNumber} · السابقة ${sub.previousReading.toStringAsFixed(0)}',
                        ),
                        trailing: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            if (perms.canViewDebts)
                              Text(
                                YerCurrencyFormatter.formatCompactYer(
                                    sub.previousDebtYer),
                                style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            Text(
                              sub.syncStatus == 'pending'
                                  ? 'بانتظار المزامنة'
                                  : 'متزامن',
                              style: TextStyle(
                                fontSize: 11,
                                color: sub.syncStatus == 'pending'
                                    ? Colors.amber.shade800
                                    : Colors.teal.shade700,
                              ),
                            ),
                          ],
                        ),
                        onTap: () async {
                          await Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (_) => MeterOcrReadingScreen(
                                subscriber: sub,
                                permissions: perms,
                              ),
                            ),
                          );
                          await _refreshRoute();
                        },
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
