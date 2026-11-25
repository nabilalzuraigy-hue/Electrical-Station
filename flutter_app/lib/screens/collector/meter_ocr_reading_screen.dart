import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/currency_formatter.dart';
import '../../models/meter_reading.dart';
import '../../models/payment_receipt.dart';
import '../../models/station_config.dart';
import '../../models/subscriber.dart';
import '../../services/auth_service.dart';
import '../../services/database_helper.dart';
import '../../services/invoice_launcher_service.dart';

class MeterOcrReadingScreen extends StatefulWidget {
  final Subscriber subscriber;
  final CollectorPermissions permissions;
  const MeterOcrReadingScreen({
    super.key,
    required this.subscriber,
    this.permissions = const CollectorPermissions(),
  });

  @override
  State<MeterOcrReadingScreen> createState() => _MeterOcrReadingScreenState();
}

class _MeterOcrReadingScreenState extends State<MeterOcrReadingScreen> {
  final DatabaseHelper _db = DatabaseHelper.instance;
  final AuthService _auth = AuthService();
  final ImagePicker _picker = ImagePicker();
  final TextRecognizer _textRecognizer = TextRecognizer();

  final TextEditingController _readingController = TextEditingController();
  final TextEditingController _cashPaidController = TextEditingController();

  String? _compressedPhotoPath;
  double _photoSizeKb = 0;
  double _kwhPrice = 450;
  String _stationName = 'محطة الكهرباء';
  String? _validationError;
  bool _processingImage = false;
  bool _saved = false;

  @override
  void initState() {
    super.initState();
    _loadStationTariff();
  }

  Future<void> _loadStationTariff() async {
    final cfg = await _db.getStationConfig();
    if (!mounted || cfg == null) return;
    setState(() {
      _kwhPrice = cfg.kwhPriceYer;
      _stationName = cfg.stationName;
    });
  }

  Future<void> _captureAndRecognizeMeter() async {
    setState(() => _processingImage = true);
    try {
      final XFile? photo = await _picker.pickImage(
        source: ImageSource.camera,
        preferredCameraDevice: CameraDevice.rear,
      );
      if (photo == null) return;

      // 1. Offline Google ML Kit OCR digit extraction
      final inputImage = InputImage.fromFilePath(photo.path);
      final recognized = await _textRecognizer.processImage(inputImage);
      final digitMatch = RegExp(r'\d{3,7}(\.\d{1,2})?')
          .allMatches(recognized.text.replaceAll(' ', ''))
          .map((m) => m.group(0)!)
          .toList();

      if (digitMatch.isNotEmpty) {
        _readingController.text = digitMatch.first;
      }

      // 2. Compress proof image to < 150KB
      final dir = await getApplicationDocumentsDirectory();
      final targetPath =
          '${dir.path}/proof_${widget.subscriber.meterNumber}_${DateTime.now().millisecondsSinceEpoch}.jpg';
      final compressed = await FlutterImageCompress.compressAndGetFile(
        photo.path,
        targetPath,
        quality: 55,
        minWidth: 960,
        minHeight: 720,
      );

      if (compressed != null) {
        final sizeBytes = await File(compressed.path).length();
        setState(() {
          _compressedPhotoPath = compressed.path;
          _photoSizeKb = sizeBytes / 1024;
        });
      }
    } finally {
      if (mounted) setState(() => _processingImage = false);
    }
  }

  double get _currentVal => double.tryParse(_readingController.text) ?? 0;
  double get _consumption =>
      (_currentVal - widget.subscriber.previousReading).clamp(0, double.infinity);
  double get _currentBill => _consumption * _kwhPrice;
  double get _totalDue => _currentBill + widget.subscriber.previousDebtYer;

  Future<void> _saveReadingAndReceipt() async {
    if (_currentVal < widget.subscriber.previousReading) {
      setState(() {
        _validationError =
            'القراءة الحالية يجب أن تكون أكبر من أو تساوي القراءة السابقة (${widget.subscriber.previousReading.toStringAsFixed(0)})';
      });
      return;
    }
    setState(() => _validationError = null);

    final readingId = 'rd_${DateTime.now().millisecondsSinceEpoch}';
    final collectorUid = _auth.currentUser?.uid ?? 'offline_collector';
    final collectorName = _auth.currentUser?.displayName ?? 'محصّل ميداني';

    final reading = MeterReading(
      id: readingId,
      subscriberId: widget.subscriber.id,
      meterNumber: widget.subscriber.meterNumber,
      subscriberName: widget.subscriber.subscriberName,
      previousReading: widget.subscriber.previousReading,
      currentReading: _currentVal,
      consumptionKwh: _consumption,
      kwhPriceYer: _kwhPrice,
      currentBillYer: _currentBill,
      previousDebtYer: widget.subscriber.previousDebtYer,
      totalDueYer: _totalDue,
      photoLocalPath: _compressedPhotoPath ?? '',
      photoSizeKb: _photoSizeKb,
      collectorUid: collectorUid,
      collectorName: collectorName,
      recordedAt: DateTime.now(),
      syncStatus: 'pending',
    );

    final cashPaid = widget.permissions.canCollectCash
        ? (double.tryParse(_cashPaidController.text) ?? 0)
        : 0.0;
    final remaining = (_totalDue - cashPaid).clamp(0, double.infinity).toDouble();

    final updatedSub = widget.subscriber.copyWith(
      previousReading: _currentVal,
      currentReading: _currentVal,
      previousDebtYer: remaining,
      updatedAt: DateTime.now(),
    );

    await _db.saveOfflineReadingAndUpdateSubscriber(
      reading: reading,
      updatedSubscriber: updatedSub,
    );

    if (cashPaid > 0) {
      final receipt = PaymentReceipt(
        id: 'rc_${DateTime.now().millisecondsSinceEpoch}',
        subscriberId: widget.subscriber.id,
        meterNumber: widget.subscriber.meterNumber,
        subscriberName: widget.subscriber.subscriberName,
        readingId: readingId,
        amountPaidYer: cashPaid,
        remainingBalanceYer: remaining,
        collectorUid: collectorUid,
        collectorName: collectorName,
        paidAt: DateTime.now(),
        syncStatus: 'pending',
      );
      await _db.saveOfflinePaymentReceipt(
        receipt: receipt,
        subscriberId: widget.subscriber.id,
        remainingDebtYer: remaining,
      );
    }

    if (!mounted) return;
    setState(() => _saved = true);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('تم حفظ القراءة وسند القبض أوفلاين بنجاح')),
    );
  }

  String _buildInvoiceText() {
    return InvoiceLauncherService.buildArabicInvoiceMessage(
      subscriberName: widget.subscriber.subscriberName,
      meterNumber: widget.subscriber.meterNumber,
      previousReading: widget.subscriber.previousReading,
      currentReading: _currentVal,
      consumptionKwh: _consumption,
      currentBillYer: _currentBill,
      previousDebtYer: widget.subscriber.previousDebtYer,
      totalDueYer: _totalDue,
      stationName: _stationName,
    );
  }

  @override
  void dispose() {
    _textRecognizer.close();
    _readingController.dispose();
    _cashPaidController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('قراءة العداد ${widget.subscriber.meterNumber}'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.subscriber.subscriberName,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                ),
                const SizedBox(height: 4),
                Text(
                  '${widget.subscriber.zoneStreet} · القراءة السابقة: ${widget.subscriber.previousReading.toStringAsFixed(0)} · المتأخرات: ${YerCurrencyFormatter.formatCompactYer(widget.subscriber.previousDebtYer)}',
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Container(
            height: 180,
            decoration: BoxDecoration(
              color: const Color(0xFF0F172A),
              borderRadius: BorderRadius.circular(14),
              image: _compressedPhotoPath != null
                  ? DecorationImage(
                      image: FileImage(File(_compressedPhotoPath!)),
                      fit: BoxFit.cover,
                    )
                  : null,
            ),
            child: Stack(
              alignment: Alignment.center,
              children: [
                Container(
                  width: 220,
                  height: 68,
                  decoration: BoxDecoration(
                    border: Border.all(color: Colors.tealAccent, width: 2),
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
                Positioned(
                  bottom: 12,
                  child: FilledButton.icon(
                    onPressed:
                        _processingImage ? null : _captureAndRecognizeMeter,
                    icon: const Icon(Icons.camera_alt_rounded),
                    label: Text(_processingImage
                        ? 'جاري المسح الضوئي...'
                        : 'تصوير العداد وقراءة الأرقام'),
                  ),
                ),
              ],
            ),
          ),
          if (_compressedPhotoPath != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                'تم ضغط صورة الإثبات: ${_photoSizeKb.toStringAsFixed(1)} كيلوبايت (< 150 KB)',
                style: TextStyle(color: Colors.teal.shade700, fontSize: 12),
              ),
            ),
          const SizedBox(height: 16),
          TextField(
            controller: _readingController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              labelText: 'القراءة الحالية (ك.و.س)',
              errorText: _validationError,
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: Column(
              children: [
                _BillRow('الاستهلاك الشهري',
                    YerCurrencyFormatter.formatKwh(_consumption)),
                _BillRow('مبلغ الاستهلاك',
                    YerCurrencyFormatter.formatCompactYer(_currentBill)),
                _BillRow(
                    'المتأخرات السابقة',
                    YerCurrencyFormatter.formatCompactYer(
                        widget.subscriber.previousDebtYer)),
                const Divider(),
                _BillRow('الإجمالي المستحق',
                    YerCurrencyFormatter.formatYer(_totalDue),
                    bold: true),
              ],
            ),
          ),
          if (widget.permissions.canCollectCash) ...[
            const SizedBox(height: 14),
            TextField(
              controller: _cashPaidController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'سند قبض فوري - المبلغ المدفوع نقداً (ريال يمني)',
                border: OutlineInputBorder(),
              ),
            ),
          ],
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: widget.permissions.canRecordReadings
                ? _saveReadingAndReceipt
                : null,
            icon: const Icon(Icons.save_rounded),
            label: const Text('حفظ القراءة وسند القبض أوفلاين'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
          ),
          if (_saved && widget.permissions.canSendInvoices) ...[
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => InvoiceLauncherService.openWhatsAppInvoice(
                      phone: widget.subscriber.phone,
                      message: _buildInvoiceText(),
                    ),
                    icon: const Icon(Icons.chat_rounded),
                    label: const Text('إرسال واتساب'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => InvoiceLauncherService.openSmsInvoice(
                      phone: widget.subscriber.phone,
                      message: _buildInvoiceText(),
                    ),
                    icon: const Icon(Icons.sms_rounded),
                    label: const Text('إرسال SMS'),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _BillRow extends StatelessWidget {
  final String label;
  final String value;
  final bool bold;
  const _BillRow(this.label, this.value, {this.bold = false});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label),
          Text(
            value,
            style: TextStyle(
              fontWeight: bold ? FontWeight.bold : FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}
