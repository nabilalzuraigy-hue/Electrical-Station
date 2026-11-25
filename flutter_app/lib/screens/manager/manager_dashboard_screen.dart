import 'dart:math';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/currency_formatter.dart';
import '../../models/meter_reading.dart';
import '../../models/payment_receipt.dart';
import '../../models/station_config.dart';
import '../../models/subscriber.dart';
import '../../services/auth_service.dart';
import '../../services/database_helper.dart';
import '../../services/excel_service.dart';
import '../../services/firestore_sync_service.dart';

class ManagerDashboardScreen extends StatefulWidget {
  final String stationId;
  const ManagerDashboardScreen({super.key, required this.stationId});

  @override
  State<ManagerDashboardScreen> createState() => _ManagerDashboardScreenState();
}

class _ManagerDashboardScreenState extends State<ManagerDashboardScreen> {
  final DatabaseHelper _db = DatabaseHelper.instance;
  final ExcelService _excelService = ExcelService();
  final FirestoreSyncService _syncService = FirestoreSyncService();
  final AuthService _authService = AuthService();

  List<Subscriber> _subscribers = [];
  List<MeterReading> _readings = [];
  List<PaymentReceipt> _receipts = [];
  StationConfig? _config;
  bool _busy = false;
  String? _lastGeneratedInviteCode;

  final _priceController = TextEditingController();
  final _minFeeController = TextEditingController();
  final _generatorKwhController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  @override
  void dispose() {
    _priceController.dispose();
    _minFeeController.dispose();
    _generatorKwhController.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    final subs = await _db.getRouteSubscribers();
    final readings = await _db.getAllReadings();
    final receipts = await _db.getAllReceipts();

    StationConfig? cfg;
    if (_authService.currentUser != null) {
      try {
        cfg = await _syncService.fetchStationConfigFromCloud(widget.stationId);
        if (cfg != null) {
          await _db.saveStationConfig(cfg);
        }
      } catch (_) {
        // Fallback to cached SQLite config when offline
      }
    }
    cfg ??= await _db.getStationConfig();

    if (!mounted) return;
    setState(() {
      _subscribers = subs;
      _readings = readings;
      _receipts = receipts;
      _config = cfg;
      if (cfg != null) {
        _priceController.text = cfg.kwhPriceYer.toStringAsFixed(0);
        _minFeeController.text = cfg.minimumFeeYer.toStringAsFixed(0);
        _generatorKwhController.text = cfg.mainGeneratorKwh.toStringAsFixed(0);
      }
    });
  }

  Future<void> _importExcelSubscribers() async {
    setState(() => _busy = true);
    try {
      final imported = await _excelService.pickAndParseSubscribersExcel();
      if (imported.isEmpty) return;

      await _db.batchUpsertSubscribers(imported);
      if (_authService.currentUser != null) {
        await _syncService.batchUploadSubscribers(
          stationId: widget.stationId,
          subscribers: imported,
        );
      }
      await _loadData();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تم استيراد ${imported.length} مشترك بنجاح')),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _exportReport() async {
    setState(() => _busy = true);
    try {
      final file = await _excelService.exportFinancialReport(
        stationName: _config?.stationName ?? 'المحطة',
        subscribers: _subscribers,
        readings: _readings,
        receipts: _receipts,
      );
      await Share.shareXFiles([XFile(file.path)], text: 'تقرير المحطة المالي');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _saveTariffSettings() async {
    final current = _config;
    final uid = _authService.currentUser?.uid;
    if (current == null || uid == null) return;

    final updated = StationConfig(
      stationId: current.stationId,
      stationName: current.stationName,
      kwhPriceYer: double.tryParse(_priceController.text) ?? current.kwhPriceYer,
      minimumFeeYer:
          double.tryParse(_minFeeController.text) ?? current.minimumFeeYer,
      mainGeneratorKwh: double.tryParse(_generatorKwhController.text) ??
          current.mainGeneratorKwh,
      licenseCode: current.licenseCode,
      licenseStatus: current.licenseStatus,
      maxCollectors: current.maxCollectors,
      maxSubscribers: current.maxSubscribers,
      ownerUid: current.ownerUid.isNotEmpty ? current.ownerUid : uid,
    );

    await _db.saveStationConfig(updated);
    await _syncService.syncStationConfigToCloud(updated);
    await _loadData();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('تم حفظ التعرفة وإعدادات المولد الرئيسي')),
    );
  }

  String _generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    final rand = Random.secure();
    String block() =>
        List.generate(4, (_) => chars[rand.nextInt(chars.length)]).join();
    return 'COL-${block()}-${block()}';
  }

  Future<String> _createCollectorInvite({
    required String name,
    required String phone,
    required String zonesCsv,
    required CollectorPermissions permissions,
  }) async {
    final uid = _authService.currentUser?.uid;
    if (uid == null || _config == null) {
      throw Exception('يجب تسجيل الدخول كمدير محطة مفعل');
    }

    final inviteCode = _generateInviteCode();
    final zones = zonesCsv
        .split(',')
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toList();

    await FirebaseFirestore.instance
        .collection('collectorInvites')
        .doc(inviteCode)
        .set({
      'inviteCode': inviteCode,
      'stationId': widget.stationId,
      'stationName': _config!.stationName,
      'ownerUid': uid,
      'collectorName': name,
      'phone': phone,
      'assignedZones': zones,
      'permissions': permissions.toMap(),
      'status': 'unused',
      'createdAt': FieldValue.serverTimestamp(),
    });

    return inviteCode;
  }

  Future<void> _toggleCollectorActive(String collectorId, bool nextActive) async {
    await FirebaseFirestore.instance
        .collection('stations')
        .doc(widget.stationId)
        .collection('collectors')
        .doc(collectorId)
        .update({'active': nextActive});
  }

  Future<void> _updateCollectorPermissions(
    String collectorId,
    CollectorPermissions nextPermissions,
  ) async {
    await FirebaseFirestore.instance
        .collection('stations')
        .doc(widget.stationId)
        .collection('collectors')
        .doc(collectorId)
        .update({'permissions': nextPermissions.toMap()});
  }

  @override
  Widget build(BuildContext context) {
    final totalKwhSold =
        _readings.fold<double>(0, (sum, r) => sum + r.consumptionKwh);
    final mainGenKwh = _config?.mainGeneratorKwh ?? 0;
    final powerLossKwh = (mainGenKwh - totalKwhSold).clamp(0, double.infinity);
    final lossPercent = mainGenKwh > 0 ? (powerLossKwh / mainGenKwh) * 100 : 0;
    final totalCollected =
        _receipts.fold<double>(0, (sum, r) => sum + r.amountPaidYer);
    final totalDebts =
        _subscribers.fold<double>(0, (sum, s) => sum + s.previousDebtYer);

    return Scaffold(
      appBar: AppBar(
        title: Text(_config?.stationName ?? 'لوحة مدير المحطة'),
        actions: [
          IconButton(
            onPressed: _busy ? null : _exportReport,
            icon: const Icon(Icons.download_rounded),
            tooltip: 'تصدير تقرير Excel',
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _loadData,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (_config != null)
              Container(
                margin: const EdgeInsets.only(bottom: 16),
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: _config!.licenseStatus == 'active'
                      ? const Color(0xFFF0FDFA)
                      : const Color(0xFFFEF2F2),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: _config!.licenseStatus == 'active'
                        ? const Color(0xFF99F6E4)
                        : const Color(0xFFFECACA),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          _config!.stationName,
                          style: const TextStyle(fontWeight: FontWeight.bold),
                        ),
                        Text(
                          _config!.licenseStatus == 'active'
                              ? 'ترخيص مفعل'
                              : 'ترخيص موقوف',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: _config!.licenseStatus == 'active'
                                ? const Color(0xFF0F766E)
                                : Colors.red.shade700,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'كود الترخيص: ${_config!.licenseCode} · حد المحصلين: ${_config!.maxCollectors} · حد المشتركين: ${_config!.maxSubscribers}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
              childAspectRatio: 1.45,
              children: [
                _KpiCard(
                  title: 'المشتركين النشطين',
                  value: '${_subscribers.length} مشترك',
                ),
                _KpiCard(
                  title: 'نسبة الفاقد / السحب غير المشروع',
                  value:
                      '${YerCurrencyFormatter.formatKwh(powerLossKwh)} (${lossPercent.toStringAsFixed(1)}%)',
                ),
                _KpiCard(
                  title: 'إجمالي التحصيل النقدي',
                  value: YerCurrencyFormatter.formatCompactYer(totalCollected),
                ),
                _KpiCard(
                  title: 'إجمالي المتأخرات غير المسددة',
                  value: YerCurrencyFormatter.formatCompactYer(totalDebts),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'التأسيس السريع عبر Excel (.xlsx)',
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'الأعمدة المطلوبة: meter_number, subscriber_name, phone, previous_reading, previous_debt, zone_street, sequence_order',
                    ),
                    const SizedBox(height: 12),
                    FilledButton.icon(
                      onPressed: _busy ? null : _importExcelSubscribers,
                      icon: const Icon(Icons.upload_file_rounded),
                      label: const Text('استيراد ملف المشتركين وحفظه فوراً'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'إعدادات التعرفة والمولد الرئيسي',
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _priceController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'سعر الكيلووات (ريال يمني)',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _minFeeController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'الحد الأدنى للاشتراك (اختياري)',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _generatorKwhController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'قراءة عداد المولد الرئيسي (ك.و.س)',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton(
                      onPressed: _config == null ? null : _saveTariffSettings,
                      child: const Text('حفظ التعرفة'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          'إدارة المحصلين وصلاحياتهم',
                          style:
                              Theme.of(context).textTheme.titleMedium?.copyWith(
                                    fontWeight: FontWeight.bold,
                                  ),
                        ),
                        FilledButton.icon(
                          onPressed: () => _showCreateInviteDialog(context),
                          icon: const Icon(Icons.key_rounded, size: 18),
                          label: const Text('إصدار كود محصّل'),
                        ),
                      ],
                    ),
                    if (_lastGeneratedInviteCode != null) ...[
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF0FDFA),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: const Color(0xFF99F6E4)),
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text(
                                    'كود تفعيل المحصّل الجديد:',
                                    style: TextStyle(fontSize: 12),
                                  ),
                                  SelectableText(
                                    _lastGeneratedInviteCode!,
                                    textDirection: TextDirection.ltr,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.bold,
                                      fontSize: 16,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            IconButton(
                              onPressed: () async {
                                await Clipboard.setData(
                                  ClipboardData(
                                      text: _lastGeneratedInviteCode!),
                                );
                                if (!context.mounted) return;
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                    content: Text('تم نسخ كود المحصّل'),
                                  ),
                                );
                              },
                              icon: const Icon(Icons.copy_rounded),
                            ),
                          ],
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
                      stream: FirebaseFirestore.instance
                          .collection('stations')
                          .doc(widget.stationId)
                          .collection('collectors')
                          .snapshots(),
                      builder: (context, snapshot) {
                        if (!snapshot.hasData) {
                          return const Padding(
                            padding: EdgeInsets.all(12),
                            child: Center(child: CircularProgressIndicator()),
                          );
                        }
                        final docs = snapshot.data!.docs;
                        if (docs.isEmpty) {
                          return const Padding(
                            padding: EdgeInsets.symmetric(vertical: 8),
                            child: Text(
                              'لا يوجد محصلون مفعلون بعد. أصدر كود محصّل وأرسله للمحصّل لتفعيل جهازه.',
                              style: TextStyle(color: Colors.blueGrey),
                            ),
                          );
                        }

                        return Column(
                          children: docs.map((doc) {
                            final d = doc.data();
                            final active = d['active'] == true;
                            final perms = CollectorPermissions.fromMap(
                              d['permissions'] as Map<String, dynamic>?,
                            );
                            final zones = List<String>.from(
                                d['assignedZones'] ?? const []);

                            return Container(
                              margin: const EdgeInsets.only(bottom: 10),
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                borderRadius: BorderRadius.circular(10),
                                border:
                                    Border.all(color: const Color(0xFFE2E8F0)),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              (d['name'] as String?) ?? '',
                                              style: const TextStyle(
                                                fontWeight: FontWeight.bold,
                                              ),
                                            ),
                                            Text(
                                              '${d['phone'] ?? ''} · الشوارع: ${zones.isEmpty ? 'الكل' : zones.join('، ')}',
                                              style: Theme.of(context)
                                                  .textTheme
                                                  .bodySmall,
                                            ),
                                          ],
                                        ),
                                      ),
                                      Switch(
                                        value: active,
                                        onChanged: (v) =>
                                            _toggleCollectorActive(doc.id, v),
                                      ),
                                    ],
                                  ),
                                  Wrap(
                                    spacing: 6,
                                    children: [
                                      FilterChip(
                                        label: const Text('تسجيل القراءات'),
                                        selected: perms.canRecordReadings,
                                        onSelected: (v) =>
                                            _updateCollectorPermissions(
                                          doc.id,
                                          CollectorPermissions(
                                            canRecordReadings: v,
                                            canCollectCash:
                                                perms.canCollectCash,
                                            canSendInvoices:
                                                perms.canSendInvoices,
                                            canViewDebts: perms.canViewDebts,
                                          ),
                                        ),
                                      ),
                                      FilterChip(
                                        label: const Text('تحصيل النقد'),
                                        selected: perms.canCollectCash,
                                        onSelected: (v) =>
                                            _updateCollectorPermissions(
                                          doc.id,
                                          CollectorPermissions(
                                            canRecordReadings:
                                                perms.canRecordReadings,
                                            canCollectCash: v,
                                            canSendInvoices:
                                                perms.canSendInvoices,
                                            canViewDebts: perms.canViewDebts,
                                          ),
                                        ),
                                      ),
                                      FilterChip(
                                        label: const Text('إرسال الفواتير'),
                                        selected: perms.canSendInvoices,
                                        onSelected: (v) =>
                                            _updateCollectorPermissions(
                                          doc.id,
                                          CollectorPermissions(
                                            canRecordReadings:
                                                perms.canRecordReadings,
                                            canCollectCash:
                                                perms.canCollectCash,
                                            canSendInvoices: v,
                                            canViewDebts: perms.canViewDebts,
                                          ),
                                        ),
                                      ),
                                      FilterChip(
                                        label: const Text('عرض المتأخرات'),
                                        selected: perms.canViewDebts,
                                        onSelected: (v) =>
                                            _updateCollectorPermissions(
                                          doc.id,
                                          CollectorPermissions(
                                            canRecordReadings:
                                                perms.canRecordReadings,
                                            canCollectCash:
                                                perms.canCollectCash,
                                            canSendInvoices:
                                                perms.canSendInvoices,
                                            canViewDebts: v,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            );
                          }).toList(),
                        );
                      },
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showCreateInviteDialog(BuildContext context) async {
    final nameCtrl = TextEditingController();
    final phoneCtrl = TextEditingController();
    final zonesCtrl = TextEditingController();
    bool canRecordReadings = true;
    bool canCollectCash = true;
    bool canSendInvoices = true;
    bool canViewDebts = true;

    await showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('إصدار كود تفعيل محصّل جديد'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameCtrl,
                  decoration: const InputDecoration(labelText: 'اسم المحصّل'),
                ),
                TextField(
                  controller: phoneCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'رقم الهاتف'),
                ),
                TextField(
                  controller: zonesCtrl,
                  decoration: const InputDecoration(
                    labelText: 'الشوارع/الحارات (مفصولة بفاصلة)',
                  ),
                ),
                const SizedBox(height: 10),
                CheckboxListTile(
                  value: canRecordReadings,
                  title: const Text('تسجيل القراءات والتصوير'),
                  onChanged: (v) =>
                      setDialogState(() => canRecordReadings = v ?? true),
                ),
                CheckboxListTile(
                  value: canCollectCash,
                  title: const Text('تحصيل النقد وإصدار السندات'),
                  onChanged: (v) =>
                      setDialogState(() => canCollectCash = v ?? true),
                ),
                CheckboxListTile(
                  value: canSendInvoices,
                  title: const Text('إرسال فواتير واتساب / SMS'),
                  onChanged: (v) =>
                      setDialogState(() => canSendInvoices = v ?? true),
                ),
                CheckboxListTile(
                  value: canViewDebts,
                  title: const Text('عرض المتأخرات السابقة'),
                  onChanged: (v) =>
                      setDialogState(() => canViewDebts = v ?? true),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('إلغاء'),
            ),
            FilledButton(
              onPressed: () async {
                if (nameCtrl.text.trim().length < 2 ||
                    phoneCtrl.text.trim().length < 7) {
                  return;
                }
                final code = await _createCollectorInvite(
                  name: nameCtrl.text.trim(),
                  phone: phoneCtrl.text.trim(),
                  zonesCsv: zonesCtrl.text.trim(),
                  permissions: CollectorPermissions(
                    canRecordReadings: canRecordReadings,
                    canCollectCash: canCollectCash,
                    canSendInvoices: canSendInvoices,
                    canViewDebts: canViewDebts,
                  ),
                );
                if (mounted) {
                  setState(() => _lastGeneratedInviteCode = code);
                }
                if (ctx.mounted) Navigator.pop(ctx);
              },
              child: const Text('إصدار الكود'),
            ),
          ],
        ),
      ),
    );
  }
}

class _KpiCard extends StatelessWidget {
  final String title;
  final String value;
  const _KpiCard({required this.title, required this.value});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            title,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Colors.blueGrey.shade600,
                ),
          ),
          Text(
            value,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
          ),
        ],
      ),
    );
  }
}
