import 'package:flutter/material.dart';

import '../../services/auth_service.dart';
import '../collector/collector_route_screen.dart';
import '../manager/manager_dashboard_screen.dart';
import '../subscriber/subscriber_portal_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final AuthService _authService = AuthService();
  final TextEditingController _codeController = TextEditingController();
  bool _loading = false;
  bool _needsActivation = false;
  bool _isCollectorCode = false;
  String? _error;

  Future<void> _signInAndRoute() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final cred = await _authService.signInWithGoogle();
      if (cred == null || !mounted) return;
      final session = await _authService.resolveUserSession();
      if (!mounted) return;

      if (session.role == AppUserRole.unactivated) {
        setState(() => _needsActivation = true);
        return;
      }

      _navigateToSession(session);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _redeemCode() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final session = _isCollectorCode
          ? await _authService.redeemCollectorInviteCode(_codeController.text)
          : await _authService.redeemStationLicenseCode(_codeController.text);
      if (!mounted) return;
      _navigateToSession(session);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _navigateToSession(ResolvedUserSession session) {
    if (session.role == AppUserRole.collector && session.stationId != null) {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => CollectorRouteScreen(
            stationId: session.stationId!,
            collectorProfile: session.collectorProfile,
          ),
        ),
      );
    } else if (session.stationId != null) {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) =>
              ManagerDashboardScreen(stationId: session.stationId!),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(
                    Icons.bolt_rounded,
                    size: 52,
                    color: Color(0xFF0F766E),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'نظام محطات الكهرباء التجارية',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'نسخة مستقلة ومعزولة بالتراخيص والأكواد لمحطات الكهرباء في اليمن',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Colors.blueGrey.shade600,
                        ),
                  ),
                  const SizedBox(height: 28),
                  if (!_needsActivation) ...[
                    FilledButton.icon(
                      onPressed: _loading ? null : _signInAndRoute,
                      icon: const Icon(Icons.login_rounded),
                      label: Text(_loading
                          ? 'جاري التحقق من الترخيص...'
                          : 'تسجيل الدخول بحساب Google'),
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(50),
                      ),
                    ),
                  ] else ...[
                    SegmentedButton<bool>(
                      segments: const [
                        ButtonSegment(
                          value: false,
                          label: Text('كود مدير محطة'),
                        ),
                        ButtonSegment(
                          value: true,
                          label: Text('كود محصّل'),
                        ),
                      ],
                      selected: {_isCollectorCode},
                      onSelectionChanged: (s) {
                        setState(() => _isCollectorCode = s.first);
                      },
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: _codeController,
                      textDirection: TextDirection.ltr,
                      decoration: InputDecoration(
                        labelText: _isCollectorCode
                            ? 'كود تفعيل المحصّل (COL-XXXX-XXXX)'
                            : 'كود ترخيص المحطة (YEM-XXXX-XXXX)',
                        border: const OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 14),
                    FilledButton.icon(
                      onPressed: _loading ? null : _redeemCode,
                      icon: const Icon(Icons.verified_user_rounded),
                      label: Text(
                          _loading ? 'جاري التفعيل...' : 'تفعيل النسخة والدخول'),
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(50),
                      ),
                    ),
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _error!,
                      style: const TextStyle(color: Colors.red, fontSize: 12),
                    ),
                  ],
                  const SizedBox(height: 24),
                  const Divider(),
                  const SizedBox(height: 16),
                  TextButton.icon(
                    onPressed: () {
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => const SubscriberPortalScreen(),
                        ),
                      );
                    },
                    icon: const Icon(Icons.receipt_long_rounded),
                    label: const Text('بوابة المشترك (دخول برقم العداد والهاتف)'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
