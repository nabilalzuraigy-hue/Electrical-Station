import 'dart:io';

import 'package:excel/excel.dart';
import 'package:file_picker/file_picker.dart';
import 'package:path_provider/path_provider.dart';

import '../models/meter_reading.dart';
import '../models/payment_receipt.dart';
import '../models/subscriber.dart';

class ExcelService {
  Future<List<Subscriber>> pickAndParseSubscribersExcel() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['xlsx'],
    );
    if (result == null || result.files.single.path == null) {
      return [];
    }

    final bytes = await File(result.files.single.path!).readAsBytes();
    final excel = Excel.decodeBytes(bytes);
    if (excel.tables.isEmpty) return [];

    final sheet = excel.tables.values.first;
    if (sheet.rows.length < 2) return [];

    final headerRow = sheet.rows.first
        .map((c) => c?.value?.toString().trim().toLowerCase() ?? '')
        .toList();

    int colIndex(String expected, int fallback) {
      final idx = headerRow.indexOf(expected);
      return idx >= 0 ? idx : fallback;
    }

    final meterIdx = colIndex('meter_number', 0);
    final nameIdx = colIndex('subscriber_name', 1);
    final phoneIdx = colIndex('phone', 2);
    final prevReadIdx = colIndex('previous_reading', 3);
    final prevDebtIdx = colIndex('previous_debt', 4);
    final zoneIdx = colIndex('zone_street', 5);
    final seqIdx = colIndex('sequence_order', 6);

    final now = DateTime.now();
    final subscribers = <Subscriber>[];

    for (var i = 1; i < sheet.rows.length; i++) {
      final row = sheet.rows[i];
      String cellStr(int idx) =>
          idx < row.length ? (row[idx]?.value?.toString().trim() ?? '') : '';
      double cellNum(int idx) => double.tryParse(cellStr(idx)) ?? 0;

      final meterNumber = cellStr(meterIdx);
      final subscriberName = cellStr(nameIdx);
      if (meterNumber.isEmpty || subscriberName.isEmpty) continue;

      final prevReading = cellNum(prevReadIdx);
      subscribers.add(
        Subscriber(
          id: 'sub_${meterNumber.replaceAll(RegExp(r'[^a-zA-Z0-9_-]'), '_')}',
          meterNumber: meterNumber,
          subscriberName: subscriberName,
          phone: cellStr(phoneIdx),
          previousReading: prevReading,
          currentReading: prevReading,
          previousDebtYer: cellNum(prevDebtIdx),
          zoneStreet: cellStr(zoneIdx).isEmpty ? 'غير محدد' : cellStr(zoneIdx),
          sequenceOrder: cellNum(seqIdx).toInt() > 0 ? cellNum(seqIdx).toInt() : i,
          syncStatus: 'pending',
          updatedAt: now,
        ),
      );
    }

    return subscribers;
  }

  Future<File> exportFinancialReport({
    required String stationName,
    required List<Subscriber> subscribers,
    required List<MeterReading> readings,
    required List<PaymentReceipt> receipts,
  }) async {
    final excel = Excel.createExcel();
    final sheet = excel['تقرير_المحطة'];
    excel.delete('Sheet1');

    sheet.appendRow([
      TextCellValue('رقم العداد'),
      TextCellValue('اسم المشترك'),
      TextCellValue('رقم الهاتف'),
      TextCellValue('الحارة / الشارع'),
      TextCellValue('القراءة السابقة'),
      TextCellValue('القراءة الحالية'),
      TextCellValue('الاستهلاك (ك.و.س)'),
      TextCellValue('المتأخرات الحالية (ريال يمني)'),
    ]);

    for (final sub in subscribers) {
      final consumption = (sub.currentReading - sub.previousReading).clamp(0, double.infinity);
      sheet.appendRow([
        TextCellValue(sub.meterNumber),
        TextCellValue(sub.subscriberName),
        TextCellValue(sub.phone),
        TextCellValue(sub.zoneStreet),
        DoubleCellValue(sub.previousReading),
        DoubleCellValue(sub.currentReading),
        DoubleCellValue(consumption.toDouble()),
        DoubleCellValue(sub.previousDebtYer),
      ]);
    }

    final dir = await getApplicationDocumentsDirectory();
    final outFile = File(
        '${dir.path}/report_${DateTime.now().millisecondsSinceEpoch}.xlsx');
    final bytes = excel.encode();
    if (bytes != null) {
      await outFile.writeAsBytes(bytes, flush: true);
    }
    return outFile;
  }
}
