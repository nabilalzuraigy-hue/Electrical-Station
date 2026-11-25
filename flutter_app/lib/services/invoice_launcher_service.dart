import 'package:url_launcher/url_launcher.dart';

class InvoiceLauncherService {
  static String buildArabicInvoiceMessage({
    required String subscriberName,
    required String meterNumber,
    required double previousReading,
    required double currentReading,
    required double consumptionKwh,
    required double currentBillYer,
    required double previousDebtYer,
    required double totalDueYer,
    required String stationName,
  }) {
    return 'عزيزي المشترك $subscriberName، قراءة عدادك رقم $meterNumber: '
        'السابقة ${previousReading.toStringAsFixed(0)}، '
        'الحالية ${currentReading.toStringAsFixed(0)}، '
        'الاستهلاك ${consumptionKwh.toStringAsFixed(1)} كيلو، '
        'مبلغ الاستهلاك ${currentBillYer.toStringAsFixed(0)} ريال، '
        'المتأخرات ${previousDebtYer.toStringAsFixed(0)} ريال، '
        'الإجمالي المستحق: ${totalDueYer.toStringAsFixed(0)} ريال. '
        'محطة $stationName';
  }

  static String normalizeYemenPhone(String phone) {
    final digits = phone.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.startsWith('967')) return digits;
    if (digits.startsWith('0')) return '967${digits.substring(1)}';
    if (digits.length == 9) return '967$digits';
    return digits;
  }

  static Future<bool> openWhatsAppInvoice({
    required String phone,
    required String message,
  }) async {
    final normalized = normalizeYemenPhone(phone);
    final uri = Uri.parse(
      'https://wa.me/$normalized?text=${Uri.encodeComponent(message)}',
    );
    return launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  static Future<bool> openSmsInvoice({
    required String phone,
    required String message,
  }) async {
    final normalized = normalizeYemenPhone(phone);
    final uri = Uri(
      scheme: 'sms',
      path: '+$normalized',
      queryParameters: {'body': message},
    );
    return launchUrl(uri);
  }
}
