import 'package:firebase_messaging/firebase_messaging.dart';

class FcmService {
  final FirebaseMessaging _messaging = FirebaseMessaging.instance;

  Future<void> initializeAndSubscribeMeter(String meterNumber) async {
    await _messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    final topic = 'meter_${meterNumber.replaceAll(RegExp(r'[^a-zA-Z0-9_-]'), '_')}';
    await _messaging.subscribeToTopic(topic);
  }

  Stream<RemoteMessage> get onForegroundMessage => FirebaseMessaging.onMessage;
}
