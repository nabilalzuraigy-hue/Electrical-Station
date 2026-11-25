import 'package:flutter/material.dart';

import '../../core/currency_formatter.dart';
import '../../services/fcm_service.dart';
import '../../services/firestore_sync_service.dart';

class SubscriberPortalScreen extends StatefulWidget {
  const SubscriberPortalScreen({super.key});

  @override
  State<SubscriberPortalScreen> createState() => _SubscriberPortalScreenState();
}

class _SubscriberPortalScreenState extends State<SubscriberPortalScreen> {
  final FirestoreSyncService _syncService = FirestoreSyncService();
  final FcmService _fcmService = FcmService();

  final TextEditingController _meterController = TextEditingController();
  final TextEditingController _phoneController = TextEditingController();

  Map<String, dynamic>? _portalData;
  String? _error;
  bool _loading = false;

  Future<void> _lookupSubscriber() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await _syncService.fetchSubscriberPortal(
        meterNumber: _meterController.text.trim(),
        phone: _phoneController.text.trim(),
      );
      if (!mounted) return;
      if (data == null) {
        setState(() {
          _portalData = null;
          _error = 'لم يتم العثور على بيانات مطابقة لرقم العداد والهاتف';
        });
      } else {
        await _fcmService.initializeAndSubscribeMeter(
          _meterController.text.trim(),
        );
        setState(() => _portalData = data);
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('بوابة المشترك')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _meterController,
            decoration: const InputDecoration(
              labelText: 'رقم العداد',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _phoneController,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: 'رقم الهاتف المسجل',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 14),
          FilledButton(
            onPressed: _loading ? null : _lookupSubscriber,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: Text(_loading ? 'جاري التحقق...' : 'عرض الفاتورة وصورة العداد'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          if (_portalData != null) ...[
            const SizedBox(height: 20),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: const Color(0xFFE2E8F0)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _portalData!['subscriberName'] ?? '',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                  Text(
                    '${_portalData!['stationName']} · ${_portalData!['zoneStreet']}',
                  ),
                  const Divider(height: 24),
                  Text(
                    'الاستهلاك: ${YerCurrencyFormatter.formatKwh((_portalData!['consumptionKwh'] as num?) ?? 0)}',
                  ),
                  Text(
                    'الإجمالي المستحق: ${YerCurrencyFormatter.formatYer((_portalData!['totalDueYer'] as num?) ?? 0)}',
                    style: const TextStyle(fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'صورة إثبات قراءة العداد الملتقطة ميدانياً:',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),
                  if ((_portalData!['lastReadingPhotoUrl'] as String?)
                          ?.isNotEmpty ==
                      true)
                    ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.network(
                        _portalData!['lastReadingPhotoUrl'],
                        fit: BoxFit.cover,
                      ),
                    )
                  else
                    const Text('لا توجد صورة مرفقة لهذه القراءة بعد'),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
