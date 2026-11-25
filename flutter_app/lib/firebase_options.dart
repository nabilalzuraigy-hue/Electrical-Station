import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  static const String firestoreDatabaseId = '(default)';

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      return web;
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions are not supported for this platform.',
        );
    }
  }

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyD4VX6i8bI67lfp8pXfNtAS3suXPolBVjY',
    appId: '1:479970825408:web:ac783bf0eaad05bdeb4925',
    messagingSenderId: '479970825408',
    projectId: 'electricity-station-f5a90',
    authDomain: 'electricity-station-f5a90.firebaseapp.com',
    storageBucket: 'electricity-station-f5a90.firebasestorage.app',
  );

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyD4VX6i8bI67lfp8pXfNtAS3suXPolBVjY',
    appId: '1:479970825408:web:ac783bf0eaad05bdeb4925',
    messagingSenderId: '479970825408',
    projectId: 'electricity-station-f5a90',
    storageBucket: 'electricity-station-f5a90.firebasestorage.app',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyD4VX6i8bI67lfp8pXfNtAS3suXPolBVjY',
    appId: '1:479970825408:web:ac783bf0eaad05bdeb4925',
    messagingSenderId: '479970825408',
    projectId: 'electricity-station-f5a90',
    storageBucket: 'electricity-station-f5a90.firebasestorage.app',
    iosBundleId: 'com.yemenpower.station',
  );
}
