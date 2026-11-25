import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import { KeyRound, LogIn, ShieldAlert, UserCheck } from 'lucide-react';
import {
  redeemCollectorInviteCode,
  redeemStationLicenseCode,
} from '../lib/offlineDb';
import type { UserRoleBinding } from '../types/station';

interface ActivationGateProps {
  user: User | null;
  onSignIn: () => Promise<void>;
  onActivated: (binding: UserRoleBinding) => Promise<void>;
  onOpenSubscriberPortal: () => void;
}

export const ActivationGate: React.FC<ActivationGateProps> = ({
  user,
  onSignIn,
  onActivated,
  onOpenSubscriberPortal,
}) => {
  const [mode, setMode] = useState<'manager' | 'collector'>('manager');
  const [code, setCode] = useState('');
  const [customStationName, setCustomStationName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSubmitting(true);
    setError(null);
    try {
      const binding =
        mode === 'manager'
          ? await redeemStationLicenseCode({
              codeInput: code,
              user,
              customStationName,
            })
          : await redeemCollectorInviteCode({
              inviteCodeInput: code,
              user,
            });
      await onActivated(binding);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تفعيل الكود.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto py-8 space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-slate-900">
            تفعيل النسخة المستقلة للمحطة
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            يعمل النظام بنظام التراخيص المعزولة: يفعّل الأدمن نسخة مدير المحطة بكود ترخيص خاص، ويحدد مدير المحطة صلاحيات وأكواد المحصّلين التابعين له فقط.
          </p>
        </div>

        {!user ? (
          <div className="space-y-4 pt-2">
            <button
              type="button"
              onClick={() => void onSignIn()}
              className="w-full min-h-[48px] px-4 py-3 bg-teal-700 hover:bg-teal-800 text-white text-sm font-bold rounded-lg inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <LogIn className="w-4 h-4" />
              تسجيل الدخول بحساب Google للمتابعة
            </button>
            <div className="text-center text-xs text-slate-500">
              إذا كنت مشتركاً وتريد استعراض فاتورتك وصورة العداد، انتقل مباشرة إلى بوابة المشترك.
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  setMode('manager');
                  setError(null);
                }}
                className={`flex-1 py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  mode === 'manager'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                كود ترخيص مدير محطة
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('collector');
                  setError(null);
                }}
                className={`flex-1 py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  mode === 'collector'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                كود تفعيل محصّل ميداني
              </button>
            </div>

            <form onSubmit={handleActivate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {mode === 'manager'
                    ? 'كود ترخيص المحطة (صادر من الأدمن)'
                    : 'كود تفعيل المحصّل (صادر من مدير المحطة)'}
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder={
                      mode === 'manager' ? 'YEM-XXXX-XXXX' : 'COL-XXXX-XXXX'
                    }
                    dir="ltr"
                    className="w-full min-h-[46px] pr-9 pl-3 py-2 text-sm font-mono-nums font-bold tracking-wider border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              {mode === 'manager' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    اسم المحطة المعتمد (اختياري للتعديل)
                  </label>
                  <input
                    type="text"
                    value={customStationName}
                    onChange={(e) => setCustomStationName(e.target.value)}
                    placeholder="اتركه فارغاً لاستخدام الاسم المسجل في الترخيص"
                    className="w-full min-h-[44px] px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg p-3">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[48px] py-3 px-4 bg-teal-700 hover:bg-teal-800 text-white text-sm font-bold rounded-lg inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <UserCheck className="w-4 h-4" />
                {submitting
                  ? 'جاري التحقق والتفعيل...'
                  : mode === 'manager'
                    ? 'تفعيل النسخة المستقلة للمحطة'
                    : 'تفعيل حساب المحصّل والربط بالمحطة'}
              </button>
            </form>
          </div>
        )}

        <div className="border-t border-slate-200 pt-4 flex items-center justify-between text-xs">
          <span className="text-slate-500">هل أنت مشترك بالمحطة؟</span>
          <button
            type="button"
            onClick={onOpenSubscriberPortal}
            className="font-semibold text-teal-700 hover:text-teal-800 underline underline-offset-4 cursor-pointer"
          >
            الدخول إلى بوابة المشترك برقم العداد والهاتف
          </button>
        </div>
      </div>
    </div>
  );
};
