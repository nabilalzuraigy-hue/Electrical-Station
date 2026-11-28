import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import {
  checkBoundCodeStatus,
  loadStationLocalState,
  loginAdminWithGoogle,
  loginWithAccessCode,
  saveStationLocalState,
  type StationLocalState,
  type UnifiedLoginResult,
} from '../lib/offlineDb';
import {
  formatAuthError,
  signInWithGooglePopup,
} from '../lib/firebase';
import {
  clearDevicePinForReset,
  getDeviceBinding,
  isValidFourDigitPin,
  normalizePinDigits,
  saveDeveloperSession,
  saveDeviceBinding,
  updateDeviceBindingAccess,
  verifyDevicePin,
  type DeviceCodeBinding,
} from '../lib/devicePinAuth';
import type { AccessCodeRecord } from '../types/station';

interface ActivationGateProps {
  onAuthenticated: (result: UnifiedLoginResult) => void;
}

type GateScreenMode =
  | 'loading'
  | 'code_entry'
  | 'pin_setup'
  | 'pin_unlock'
  | 'developer_login';

interface PendingActivationPayload {
  token: string;
  access: AccessCodeRecord;
  state: StationLocalState;
}

export const ActivationGate: React.FC<ActivationGateProps> = ({
  onAuthenticated,
}) => {
  const [mode, setMode] = useState<GateScreenMode>('loading');
  const [binding, setBinding] = useState<DeviceCodeBinding | null>(null);
  const [pendingActivation, setPendingActivation] =
    useState<PendingActivationPayload | null>(null);

  // 1. Code activation input
  const [codeInput, setCodeInput] = useState('');

  // 2. Local 4-digit PIN setup & unlock
  const [pinInput, setPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [showPin, setShowPin] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoNotice, setInfoNotice] = useState<string | null>(null);
  const [codeDeactivated, setCodeDeactivated] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const existingBinding = await getDeviceBinding();
      if (!active) return;

      if (!existingBinding) {
        setMode('code_entry');
        return;
      }

      setBinding(existingBinding);

      if (!existingBinding.pinHash) {
        setInfoNotice('أنشئ رمز PIN جديداً من 4 أرقام لهذا الجهاز.');
        setMode('pin_setup');
        return;
      }

      setMode('pin_unlock');

      // Quietly verify code status & PIN reset state with Firestore when online
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        const statusRes = await checkBoundCodeStatus(
          existingBinding.boundCode,
          existingBinding.boundAt,
        );
        if (!active) return;
        if (statusRes.status === 'deactivated') {
          setCodeDeactivated(true);
          setError('تم إلغاء تفعيل هذا الكود من قِبل المطور. تواصل مع الإدارة.');
        } else if (statusRes.status === 'pin_reset') {
          const cleared = await clearDevicePinForReset();
          if (!active) return;
          if (cleared) setBinding(cleared);
          setPinInput('');
          setConfirmPinInput('');
          setError(null);
          setInfoNotice(
            'قام المطور بإعادة تعيين رمز PIN الخاص بك. أنشئ رمز PIN جديداً من 4 أرقام.',
          );
          setMode('pin_setup');
        } else if (statusRes.status === 'ok') {
          await updateDeviceBindingAccess(statusRes.access);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const handleVerifyActivationCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = codeInput.trim().toUpperCase();
    if (cleaned.length < 4) {
      setError('يرجى إدخال كود التفعيل الصحيح.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setInfoNotice(null);
    try {
      const res = await loginWithAccessCode(cleaned);
      if (!res.access.active) {
        setError('تم إلغاء تفعيل هذا الكود من قِبل المطور.');
        return;
      }
      setPendingActivation({
        token: res.token,
        access: res.access,
        state: res.state,
      });
      setPinInput('');
      setConfirmPinInput('');
      setInfoNotice('تم التحقق من الكود بنجاح. أنشئ الآن رمز PIN من 4 أرقام لحفظه على هاتفك.');
      setMode('pin_setup');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'كود التفعيل غير صحيح أو غير مفعّل.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const buildLocalFallbackState = async (
    access: AccessCodeRecord,
  ): Promise<StationLocalState> => {
    const cached = await loadStationLocalState(access.stationId);
    if (cached) return cached;
    const fallbackState: StationLocalState = {
      station: {
        stationId: access.stationId,
        stationName: access.stationName || 'المحطة',
        kwhPriceYer: 450,
        minimumFeeYer: 1000,
        mainGeneratorKwh: 0,
        licenseCode: access.code,
        licenseStatus: 'active',
        maxCollectors: 25,
        maxSubscribers: 10000,
        ownerUid: 'developer_admin',
        updatedAt: access.updatedAt || new Date().toISOString(),
      },
      collectors:
        access.role === 'collector'
          ? [
              {
                id: access.code,
                code: access.code,
                name: access.name,
                email: '',
                phone: access.phone,
                assignedZones: access.assignedZones ?? [],
                permissions: access.permissions,
                active: access.active,
                inviteCode: access.code,
                createdAt: access.createdAt,
              },
            ]
          : [],
      subscribers: [],
      readings: [],
      receipts: [],
      alerts: [],
      expenses: [],
      collectorLocations: [],
    };
    await saveStationLocalState(fallbackState);
    return fallbackState;
  };

  const handleSaveNewPin = async (e: React.FormEvent) => {
    e.preventDefault();
    const pin4 = normalizePinDigits(pinInput);
    const confirm4 = normalizePinDigits(confirmPinInput);

    if (!isValidFourDigitPin(pin4)) {
      setError('يجب أن يتكون رمز PIN من 4 أرقام فقط.');
      return;
    }
    if (pin4 !== confirm4) {
      setError('رمزا PIN غير متطابقين. تأكد من إدخال نفس الأرقام الأربعة.');
      return;
    }

    const targetAccess = pendingActivation?.access ?? binding?.cachedAccess;
    if (!targetAccess) {
      setError('انتهت جلسة التفعيل. أعد إدخال كود التفعيل.');
      setMode('code_entry');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await saveDeviceBinding({ access: targetAccess, pin4 });

      let token = pendingActivation?.token ?? `cloud_${targetAccess.code}`;
      let access = targetAccess;
      let state = pendingActivation?.state;

      if (!state) {
        try {
          const onlineRes = await loginWithAccessCode(targetAccess.code);
          token = onlineRes.token;
          access = onlineRes.access;
          state = onlineRes.state;
        } catch {
          state = await buildLocalFallbackState(targetAccess);
        }
      }

      onAuthenticated({
        kind: 'staff',
        token,
        access,
        state,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'تعذر حفظ رمز PIN على الجهاز.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handlePinUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!binding) {
      setMode('code_entry');
      return;
    }
    if (codeDeactivated) {
      setError('تم إلغاء تفعيل هذا الكود من قِبل المطور. تواصل مع الإدارة.');
      return;
    }

    const pin4 = normalizePinDigits(pinInput);
    if (!isValidFourDigitPin(pin4)) {
      setError('أدخل رمز PIN المكون من 4 أرقام.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setInfoNotice(null);
    try {
      const pinMatches = await verifyDevicePin(binding, pin4);
      if (!pinMatches) {
        setError('رمز PIN غير صحيح. حاول مرة أخرى.');
        return;
      }

      // Check Firestore / server status if online
      const statusRes = await checkBoundCodeStatus(
        binding.boundCode,
        binding.boundAt,
      );

      if (statusRes.status === 'deactivated') {
        setCodeDeactivated(true);
        setError('تم إلغاء تفعيل هذا الكود من قِبل المطور. تواصل مع الإدارة.');
        return;
      }

      if (statusRes.status === 'pin_reset') {
        await clearDevicePinForReset();
        setPinInput('');
        setConfirmPinInput('');
        setInfoNotice(
          'قام المطور بإعادة تعيين رمز PIN الخاص بك. أنشئ رمز PIN جديداً من 4 أرقام.',
        );
        setMode('pin_setup');
        return;
      }

      if (statusRes.status === 'ok') {
        await updateDeviceBindingAccess(statusRes.access);
        onAuthenticated({
          kind: 'staff',
          token: statusRes.token,
          access: statusRes.access,
          state: statusRes.state,
        });
        return;
      }

      // Offline unlock using locally cached state on the phone
      const localState = await buildLocalFallbackState(binding.cachedAccess);
      onAuthenticated({
        kind: 'staff',
        token: `cloud_${binding.boundCode}`,
        access: binding.cachedAccess,
        state: localState,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'تعذر التحقق من رمز PIN.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeveloperGoogleLogin = async () => {
    setSubmitting(true);
    setError(null);
    setInfoNotice(null);
    try {
      const user = await signInWithGooglePopup();
      const idToken = await user.getIdToken();
      const res = await loginAdminWithGoogle(idToken);
      await saveDeveloperSession({ token: res.token, name: res.name });
      onAuthenticated({
        kind: 'admin',
        token: res.token,
        name: res.name,
      });
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (mode === 'loading') {
    return (
      <div
        dir="rtl"
        className="min-h-[100dvh] w-full bg-gradient-to-br from-[#041224] via-[#062738] to-[#053328] flex flex-col items-center justify-center px-4 text-white"
      >
        <div className="bg-white/10 backdrop-blur-md border border-emerald-400/25 rounded-2xl px-6 py-5 text-center space-y-2 shadow-xl">
          <div className="w-10 h-10 mx-auto rounded-xl bg-emerald-400/20 text-emerald-300 inline-flex items-center justify-center">
            <Zap className="w-5 h-5 animate-pulse" />
          </div>
          <p className="text-sm font-bold text-white">جاري تجهيز التطبيق...</p>
        </div>
      </div>
    );
  }

  return (
    <div
      dir="rtl"
      className="min-h-[100dvh] w-full bg-gradient-to-br from-[#041224] via-[#062738] to-[#053328] flex flex-col items-center justify-center px-4 py-8 safe-top safe-bottom"
    >
      {/* Top Brand */}
      <div className="text-center mb-6 space-y-2">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-400/20 border border-emerald-400/40 text-emerald-300 inline-flex items-center justify-center shadow-lg">
          <Zap className="w-8 h-8" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
          نظام إدارة الكهرباء التجارية
        </h1>
        <p className="text-xs sm:text-sm text-emerald-200/80">
          نظام اتمتة موحدة للكهرباء
        </p>
      </div>

      {/* Main Card */}
      <div className="w-full max-w-md bg-white text-slate-900 rounded-3xl shadow-2xl p-6 sm:p-8 space-y-5">
        {mode === 'code_entry' && (
          <form onSubmit={handleVerifyActivationCode} className="space-y-5">
            <div className="space-y-1">
              <label
                htmlFor="activation-code-input"
                className="block text-sm font-extrabold text-slate-800"
              >
                أدخل كود التفعيل
              </label>
              <div className="relative">
                <KeyRound className="w-5 h-5 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="activation-code-input"
                  type="text"
                  dir="ltr"
                  value={codeInput}
                  onChange={(e) => {
                    setCodeInput(e.target.value.toUpperCase());
                    if (error) setError(null);
                  }}
                  placeholder="MGR-XXXX أو COL-XXXX"
                  autoComplete="off"
                  autoCapitalize="characters"
                  className="w-full min-h-[54px] pr-11 pl-4 py-3 text-center text-lg sm:text-xl font-extrabold tracking-widest font-mono-nums bg-slate-50 border border-slate-300 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                />
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-xs font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-[52px] py-3 px-6 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-base font-extrabold rounded-2xl shadow-md transition-colors cursor-pointer"
            >
              {submitting ? 'جاري التحقق من الكود...' : 'تفعيل والدخول'}
            </button>

            <div className="pt-2 border-t border-slate-100 text-center">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setInfoNotice(null);
                  setMode('developer_login');
                }}
                className="text-xs font-semibold text-slate-500 hover:text-emerald-700 transition-colors cursor-pointer"
              >
                دخول المطور (Google)
              </button>
            </div>
          </form>
        )}

        {mode === 'pin_setup' && (
          <form onSubmit={handleSaveNewPin} className="space-y-4">
            <div className="text-center space-y-1">
              <div className="w-11 h-11 mx-auto rounded-2xl bg-emerald-100 text-emerald-700 inline-flex items-center justify-center">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <h2 className="text-lg font-extrabold text-slate-900">
                إنشاء رمز PIN من 4 أرقام
              </h2>
              {(pendingActivation?.access ?? binding?.cachedAccess) && (
                <p className="text-xs text-slate-600">
                  {(pendingActivation?.access ?? binding?.cachedAccess)?.role ===
                  'manager'
                    ? 'مدير المحطة'
                    : 'المحصّل الميداني'}
                  :{' '}
                  <span className="font-bold text-slate-900">
                    {(pendingActivation?.access ?? binding?.cachedAccess)?.name}
                  </span>
                </p>
              )}
            </div>

            {infoNotice && (
              <div className="flex items-start gap-2 text-xs font-semibold text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                <span>{infoNotice}</span>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="new-pin-input"
                  className="block text-xs font-bold text-slate-700 mb-1"
                >
                  رمز PIN الجديد (4 أرقام)
                </label>
                <div className="relative">
                  <input
                    id="new-pin-input"
                    type={showPin ? 'text' : 'password'}
                    inputMode="numeric"
                    maxLength={4}
                    dir="ltr"
                    value={pinInput}
                    onChange={(e) => {
                      setPinInput(normalizePinDigits(e.target.value));
                      if (error) setError(null);
                    }}
                    placeholder="••••"
                    className="w-full min-h-[54px] px-11 py-2.5 text-center text-2xl font-extrabold tracking-[0.7em] font-mono-nums bg-slate-50 border border-slate-300 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin((v) => !v)}
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    {showPin ? (
                      <EyeOff className="w-5 h-5" />
                    ) : (
                      <Eye className="w-5 h-5" />
                    )}
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="confirm-pin-input"
                  className="block text-xs font-bold text-slate-700 mb-1"
                >
                  تأكيد رمز PIN
                </label>
                <input
                  id="confirm-pin-input"
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={4}
                  dir="ltr"
                  value={confirmPinInput}
                  onChange={(e) => {
                    setConfirmPinInput(normalizePinDigits(e.target.value));
                    if (error) setError(null);
                  }}
                  placeholder="••••"
                  className="w-full min-h-[54px] px-4 py-2.5 text-center text-2xl font-extrabold tracking-[0.7em] font-mono-nums bg-slate-50 border border-slate-300 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                />
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-xs font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-[52px] py-3 px-6 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-base font-extrabold rounded-2xl shadow-md transition-colors cursor-pointer"
            >
              {submitting ? 'جاري الحفظ والدخول...' : 'حفظ PIN وربط الجهاز والدخول'}
            </button>
          </form>
        )}

        {mode === 'pin_unlock' && binding && (
          <form onSubmit={handlePinUnlock} className="space-y-5">
            <div className="text-center space-y-1">
              <div className="w-11 h-11 mx-auto rounded-2xl bg-emerald-100 text-emerald-700 inline-flex items-center justify-center">
                <Lock className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-extrabold text-slate-900">
                أدخل رمز PIN
              </h2>
              <p className="text-xs text-slate-600">
                {binding.role === 'manager' ? 'مدير المحطة' : 'المحصّل'}:{' '}
                <span className="font-bold text-slate-900">{binding.name}</span>
              </p>
            </div>

            <div>
              <div className="relative">
                <input
                  id="unlock-pin-input"
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={4}
                  dir="ltr"
                  autoFocus
                  value={pinInput}
                  onChange={(e) => {
                    setPinInput(normalizePinDigits(e.target.value));
                    if (error) setError(null);
                  }}
                  placeholder="••••"
                  className="w-full min-h-[58px] px-11 py-3 text-center text-3xl font-extrabold tracking-[0.75em] font-mono-nums bg-slate-50 border border-slate-300 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                />
                <button
                  type="button"
                  onClick={() => setShowPin((v) => !v)}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  {showPin ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-xs font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || codeDeactivated}
              className="w-full min-h-[52px] py-3 px-6 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-base font-extrabold rounded-2xl shadow-md transition-colors cursor-pointer"
            >
              {submitting ? 'جاري الفتح...' : 'دخول'}
            </button>
          </form>
        )}

        {mode === 'developer_login' && (
          <div className="space-y-4">
            <div className="text-center space-y-1">
              <div className="w-11 h-11 mx-auto rounded-2xl bg-slate-900 text-emerald-400 inline-flex items-center justify-center">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <h2 className="text-lg font-extrabold text-slate-900">
                دخول المطور بحساب Google
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                مخصص للأدمن المطور فقط للوصول إلى قاعدة البيانات السحابية وإدارة الأكواد والمحطات.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-xs font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleDeveloperGoogleLogin()}
              className="w-full min-h-[52px] py-3 px-6 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-extrabold rounded-2xl shadow-md transition-colors cursor-pointer inline-flex items-center justify-center gap-2"
            >
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              {submitting ? 'جاري المصادقة عبر Google...' : 'المتابعة بحساب Google للمطور'}
            </button>

            <div className="pt-1 text-center">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode('code_entry');
                }}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                العودة إلى كود التفعيل
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
