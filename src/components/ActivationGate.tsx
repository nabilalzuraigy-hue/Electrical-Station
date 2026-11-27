import React, { useState } from 'react';
import { Eye, EyeOff, Lock, ShieldAlert, ShieldCheck, User } from 'lucide-react';
import { CLOUD_ADMIN_TOKEN } from '../lib/cloudAdminStore';
import {
  auth,
  formatAuthError,
  isAuthorizedAdminUser,
  resolveDeveloperAdminEmail,
  signInDeveloperWithEmailPassword,
  signInWithGooglePopup,
  signOutUser,
} from '../lib/firebase';
import { loginUnified, type UnifiedLoginResult } from '../lib/offlineDb';
import { PWAInstallPrompt } from './PWAInstallPrompt';

interface ActivationGateProps {
  onAuthenticated: (result: UnifiedLoginResult) => void;
}

export const ActivationGate: React.FC<ActivationGateProps> = ({
  onAuthenticated,
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() && !password.trim()) {
      setError('يرجى إدخال اسم المستخدم وكلمة المرور.');
      return;
    }

    const developerEmail = resolveDeveloperAdminEmail(username);
    if (developerEmail) {
      if (!password) {
        setError('يرجى إدخال كلمة المرور لحساب المطور.');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const user = await signInDeveloperWithEmailPassword(
          developerEmail,
          password,
        );
        if (!isAuthorizedAdminUser(user)) {
          await signOutUser();
          setError('هذا الحساب غير مصرح له بدخول الأدمن المطور.');
          return;
        }
        onAuthenticated({
          kind: 'admin',
          token: CLOUD_ADMIN_TOKEN,
          name: 'الأدمن المطور',
        });
      } catch (err) {
        setError(formatAuthError(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await loginUnified({ username, password });
      onAuthenticated(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'بيانات الدخول غير صحيحة.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleAdminLogin = async () => {
    setGoogleSubmitting(true);
    setError(null);
    try {
      if (isAuthorizedAdminUser(auth.currentUser)) {
        onAuthenticated({
          kind: 'admin',
          token: CLOUD_ADMIN_TOKEN,
          name: 'الأدمن المطور',
        });
        return;
      }
      const user = await signInWithGooglePopup();
      if (!isAuthorizedAdminUser(user)) {
        await signOutUser();
        setError(
          `الحساب (${user.email || 'غير معروف'}) غير مصرح له بدخول الأدمن المطور.`,
        );
        return;
      }
      onAuthenticated({
        kind: 'admin',
        token: CLOUD_ADMIN_TOKEN,
        name: 'الأدمن المطور',
      });
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setGoogleSubmitting(false);
    }
  };

  return (
    <div
      dir="rtl"
      className="relative min-h-[100dvh] w-full overflow-x-hidden bg-gradient-to-br from-[#041224] via-[#062738] to-[#053328] flex flex-col items-center justify-center safe-top safe-bottom px-4 py-8 sm:px-6 sm:py-10"
    >
      {/* Ambient Electric Green & Blue Light Glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -right-28 h-[440px] w-[440px] rounded-full bg-emerald-400/20 blur-[120px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-36 -left-24 h-[460px] w-[460px] rounded-full bg-sky-500/20 blur-[130px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[320px] w-[520px] rounded-full bg-teal-400/10 blur-[110px]"
      />

      <div className="relative z-10 w-full max-w-md space-y-8">
        {/* Top Large Brand Logo & Subtitle */}
        <header className="animate-login-header text-center space-y-3">
          <div className="inline-flex items-center justify-center gap-3">
            <span
              aria-hidden="true"
              className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-gradient-to-br from-emerald-400 via-teal-400 to-sky-500 text-slate-950 inline-flex items-center justify-center shadow-lg shadow-emerald-500/30 text-2xl sm:text-3xl shrink-0"
            >
              ⚡
            </span>
            <h1 className="font-display text-2xl sm:text-4xl font-bold text-white tracking-tight leading-snug">
              محطات الكهرباء التجارية
            </h1>
          </div>
          <p className="text-base sm:text-lg font-medium text-emerald-100/90">
            نظام اتمتة موحدة للكهرباء
          </p>
        </header>

        {/* Centered Elevated White Card */}
        <main className="animate-login-card bg-white rounded-3xl shadow-[0_30px_75px_-15px_rgba(0,0,0,0.65)] p-7 sm:p-10">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label
                htmlFor="login-username"
                className="block text-base sm:text-lg font-bold text-slate-800"
              >
                اسم المستخدم
              </label>
              <div className="relative">
                <User className="w-5 h-5 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="login-username"
                  type="text"
                  dir="auto"
                  autoComplete="username"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    if (error) setError(null);
                  }}
                  className="w-full min-h-[54px] pr-12 pl-4 py-3 text-lg sm:text-xl font-bold placeholder:font-medium placeholder:text-base text-slate-900 bg-slate-50/70 border border-slate-300 rounded-2xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition-colors"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="login-password"
                className="block text-base sm:text-lg font-bold text-slate-800"
              >
                كلمة المرور
              </label>
              <div className="relative">
                <Lock className="w-5 h-5 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  dir="auto"
                  autoComplete="current-password"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  className="w-full min-h-[54px] pr-12 pl-14 py-3 text-lg sm:text-xl font-bold placeholder:font-medium placeholder:text-base text-slate-900 bg-slate-50/70 border border-slate-300 rounded-2xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={
                    showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'
                  }
                  className="absolute left-1.5 top-1/2 -translate-y-1/2 w-11 h-11 rounded-xl flex items-center justify-center text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 transition-colors cursor-pointer"
                >
                  {showPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 text-sm font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-2xl p-3.5">
                <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || googleSubmitting}
              className="btn-shine w-full min-h-[56px] py-3.5 px-6 rounded-2xl bg-gradient-to-l from-emerald-600 via-emerald-500 to-teal-600 hover:from-emerald-500 hover:via-emerald-500 hover:to-teal-500 active:scale-[0.985] disabled:opacity-60 text-white text-lg sm:text-xl font-bold shadow-lg shadow-emerald-600/30 transition-all duration-150 cursor-pointer"
            >
              {submitting ? 'جاري التحقق...' : 'دخول'}
            </button>

            <div className="pt-1 space-y-2.5">
              <div className="relative flex items-center justify-center">
                <div className="w-full border-t border-slate-200" />
                <span className="bg-white px-3 text-xs font-medium text-slate-400">
                  أو
                </span>
              </div>
              <button
                type="button"
                disabled={submitting || googleSubmitting}
                onClick={() => void handleGoogleAdminLogin()}
                className="w-full min-h-[48px] py-2.5 px-4 rounded-2xl bg-slate-900 hover:bg-slate-800 active:scale-[0.985] disabled:opacity-60 text-white text-sm sm:text-base font-bold inline-flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                {googleSubmitting
                  ? 'جاري التحقق عبر Google...'
                  : 'دخول الأدمن المطور (Google)'}
              </button>
            </div>

            <p className="text-xs sm:text-sm text-slate-500 text-center pt-1">
              الدخول مخصص للموظفين والمحصلين فقط
            </p>
          </form>
        </main>

        <PWAInstallPrompt variant="banner" darkSurface />
      </div>
    </div>
  );
};
