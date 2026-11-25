import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../models/station_config.dart';

enum AppUserRole { admin, manager, collector, unactivated }

class ResolvedUserSession {
  final AppUserRole role;
  final String? stationId;
  final String? stationName;
  final CollectorProfile? collectorProfile;

  const ResolvedUserSession({
    required this.role,
    this.stationId,
    this.stationName,
    this.collectorProfile,
  });
}

class AuthService {
  static const String superAdminEmail = 'nabilalzuraigy@gmail.com';
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;

  User? get currentUser => _auth.currentUser;
  Stream<User?> get authStateChanges => _auth.authStateChanges();

  Future<UserCredential?> signInWithGoogle() async {
    final GoogleSignInAccount? googleUser = await GoogleSignIn().signIn();
    if (googleUser == null) return null;

    final GoogleSignInAuthentication googleAuth =
        await googleUser.authentication;
    final OAuthCredential credential = GoogleAuthProvider.credential(
      accessToken: googleAuth.accessToken,
      idToken: googleAuth.idToken,
    );
    return _auth.signInWithCredential(credential);
  }

  Future<ResolvedUserSession> resolveUserSession() async {
    final user = _auth.currentUser;
    if (user == null) {
      return const ResolvedUserSession(role: AppUserRole.unactivated);
    }

    if (user.email?.toLowerCase() == superAdminEmail) {
      return const ResolvedUserSession(role: AppUserRole.admin);
    }

    final roleSnap =
        await _firestore.collection('userRoles').doc(user.uid).get();
    if (!roleSnap.exists) {
      return const ResolvedUserSession(role: AppUserRole.unactivated);
    }

    final data = roleSnap.data()!;
    final roleStr = data['role'] as String?;
    final stationId = data['stationId'] as String?;
    final stationName = data['stationName'] as String?;

    if (stationId == null || stationId.isEmpty) {
      return const ResolvedUserSession(role: AppUserRole.unactivated);
    }

    if (roleStr == 'collector') {
      final colDoc = await _firestore
          .collection('stations')
          .doc(stationId)
          .collection('collectors')
          .doc(user.uid)
          .get();

      CollectorProfile? profile;
      if (colDoc.exists) {
        final c = colDoc.data()!;
        profile = CollectorProfile(
          id: colDoc.id,
          name: (c['name'] as String?) ?? '',
          email: (c['email'] as String?) ?? '',
          phone: (c['phone'] as String?) ?? '',
          assignedZones: List<String>.from(c['assignedZones'] ?? const []),
          permissions: CollectorPermissions.fromMap(
            c['permissions'] as Map<String, dynamic>?,
          ),
          active: c['active'] == true,
        );
      }

      return ResolvedUserSession(
        role: AppUserRole.collector,
        stationId: stationId,
        stationName: stationName,
        collectorProfile: profile,
      );
    }

    return ResolvedUserSession(
      role: AppUserRole.manager,
      stationId: stationId,
      stationName: stationName,
    );
  }

  Future<ResolvedUserSession> redeemStationLicenseCode(
    String rawCode, {
    String? customStationName,
  }) async {
    final user = _auth.currentUser;
    if (user == null) throw Exception('يجب تسجيل الدخول أولاً');
    final code = rawCode.trim().toUpperCase();

    final licRef = _firestore.collection('licenses').doc(code);
    final licSnap = await licRef.get();
    if (!licSnap.exists) {
      throw Exception('كود الترخيص غير موجود');
    }

    final lic = licSnap.data()!;
    if (lic['status'] != 'unused') {
      throw Exception('كود الترخيص مستخدم مسبقاً أو موقوف');
    }

    final stationId = lic['stationId'] as String;
    final stationName = (customStationName?.trim().isNotEmpty == true)
        ? customStationName!.trim()
        : lic['stationName'] as String;

    final batch = _firestore.batch();
    batch.update(licRef, {
      'status': 'active',
      'activatedByUid': user.uid,
      'activatedByEmail': user.email ?? '',
      'activatedAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    });
    batch.set(_firestore.collection('stations').doc(stationId), {
      'stationName': stationName,
      'kwhPriceYer': 450,
      'minimumFeeYer': 0,
      'mainGeneratorKwh': 0,
      'licenseCode': code,
      'licenseStatus': 'active',
      'maxCollectors': lic['maxCollectors'] ?? 5,
      'maxSubscribers': lic['maxSubscribers'] ?? 1500,
      'ownerUid': user.uid,
      'updatedAt': FieldValue.serverTimestamp(),
    });
    batch.set(_firestore.collection('userRoles').doc(user.uid), {
      'role': 'manager',
      'stationId': stationId,
      'stationName': stationName,
      'codeUsed': code,
      'active': true,
      'updatedAt': FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return ResolvedUserSession(
      role: AppUserRole.manager,
      stationId: stationId,
      stationName: stationName,
    );
  }

  Future<ResolvedUserSession> redeemCollectorInviteCode(String rawCode) async {
    final user = _auth.currentUser;
    if (user == null) throw Exception('يجب تسجيل الدخول أولاً');
    final code = rawCode.trim().toUpperCase();

    final invRef = _firestore.collection('collectorInvites').doc(code);
    final invSnap = await invRef.get();
    if (!invSnap.exists) {
      throw Exception('كود تفعيل المحصّل غير صحيح');
    }

    final inv = invSnap.data()!;
    if (inv['status'] != 'unused') {
      throw Exception('كود المحصّل مستخدم مسبقاً أو ملغى');
    }

    final stationId = inv['stationId'] as String;
    final stationName = inv['stationName'] as String;

    final batch = _firestore.batch();
    batch.update(invRef, {
      'status': 'claimed',
      'claimedByUid': user.uid,
      'claimedAt': FieldValue.serverTimestamp(),
    });
    batch.set(
      _firestore
          .collection('stations')
          .doc(stationId)
          .collection('collectors')
          .doc(user.uid),
      {
        'name': inv['collectorName'],
        'email': user.email ?? '',
        'phone': inv['phone'],
        'assignedZones': inv['assignedZones'] ?? const [],
        'permissions': inv['permissions'],
        'active': true,
        'inviteCode': code,
        'createdAt': FieldValue.serverTimestamp(),
      },
    );
    batch.set(_firestore.collection('userRoles').doc(user.uid), {
      'role': 'collector',
      'stationId': stationId,
      'stationName': stationName,
      'codeUsed': code,
      'active': true,
      'updatedAt': FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return resolveUserSession();
  }

  Future<void> signOut() async {
    await GoogleSignIn().signOut();
    await _auth.signOut();
  }
}
