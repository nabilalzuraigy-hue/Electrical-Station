import 'package:intl/intl.dart';

class YerCurrencyFormatter {
  static final NumberFormat _numberFormat = NumberFormat('#,##0', 'en_US');
  static final NumberFormat _kwhFormat = NumberFormat('#,##0.##', 'en_US');

  static String formatYer(num amount) {
    return '${_numberFormat.format(amount.round())} ريال يمني';
  }

  static String formatCompactYer(num amount) {
    return '${_numberFormat.format(amount.round())} ر.ي';
  }

  static String formatKwh(num kwh) {
    return '${_kwhFormat.format(kwh)} ك.و.س';
  }
}
