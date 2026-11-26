import React, { useState } from 'react';
import { Download, Laptop, Share, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallPromptProps {
  variant?: 'banner' | 'header';
  darkSurface?: boolean;
}

export const PWAInstallPrompt: React.FC<PWAInstallPromptProps> = ({
  variant = 'banner',
  darkSurface = false,
}) => {
  const {
    isInstallable,
    isInstalled,
    isIOS,
    isAndroid,
    isSamsungBrowser,
    install,
  } = usePWAInstall();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('pwa_banner_dismissed') === '1';
    } catch {
      return false;
    }
  });
  const [showGuideModal, setShowGuideModal] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handlePrimaryClick = async () => {
    if (isInstallable) {
      const accepted = await install();
      if (accepted) return;
    }
    setShowGuideModal(true);
  };

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem('pwa_banner_dismissed', '1');
    } catch {
      // ignore storage failure
    }
  };

  const guideModal = showGuideModal && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs p-4"
      onClick={() => setShowGuideModal(false)}
    >
      <div
        dir="rtl"
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 space-y-4 text-right"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="w-10 h-10 rounded-xl bg-teal-700 text-white inline-flex items-center justify-center shrink-0">
              {isIOS || isAndroid ? (
                <Smartphone className="w-5 h-5" />
              ) : (
                <Laptop className="w-5 h-5" />
              )}
            </span>
            <div>
              <h3 className="text-lg font-bold text-slate-900">
                تثبيت التطبيق على جهازك
              </h3>
              <p className="text-xs text-slate-500">
                {isIOS
                  ? 'هواتف آيفون وآيباد (Safari)'
                  : isAndroid
                    ? 'هواتف سامسونج والأندرويد'
                    : 'أجهزة اللابتوب والكمبيوتر'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowGuideModal(false)}
            aria-label="إغلاق"
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {isIOS ? (
          <ol className="space-y-3 text-sm font-semibold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl p-4 list-decimal pr-6">
            <li>
              اضغط على زر <strong>المشاركة</strong>{' '}
              <Share className="w-4 h-4 inline-block text-teal-700 mx-0.5" />{' '}
              في شريط متصفح Safari.
            </li>
            <li>
              مرّر للأسفل واختر <strong>«إضافة إلى الصفحة الرئيسية»</strong>{' '}
              (Add to Home Screen).
            </li>
            <li>
              اضغط <strong>«إضافة»</strong> ليظهر التطبيق بأيقونته الكاملة على
              شاشتك.
            </li>
          </ol>
        ) : isAndroid ? (
          <ol className="space-y-3 text-sm font-semibold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl p-4 list-decimal pr-6">
            <li>
              اضغط على قائمة المتصفح{' '}
              <strong>{isSamsungBrowser ? '☰' : '⋮'}</strong> في أعلى أو أسفل
              الشاشة.
            </li>
            <li>
              اختر <strong>«تثبيت التطبيق»</strong> أو{' '}
              <strong>«إضافة الصفحة إلى الشاشة الرئيسية»</strong>.
            </li>
            <li>
              اضغط <strong>«تثبيت»</strong> لفتح النظام بملء الشاشة وحتى بدون
              إنترنت.
            </li>
          </ol>
        ) : (
          <ol className="space-y-3 text-sm font-semibold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl p-4 list-decimal pr-6">
            <li>
              من شريط العنوان أعلى متصفح Chrome أو Edge، اضغط على أيقونة{' '}
              <strong>التثبيت (Install)</strong>.
            </li>
            <li>
              أو افتح قائمة المتصفح <strong>⋮</strong> ثم اختر{' '}
              <strong>«تثبيت نظام إدارة الكهرباء التجارية»</strong>.
            </li>
          </ol>
        )}

        <button
          type="button"
          onClick={() => setShowGuideModal(false)}
          className="w-full min-h-[46px] rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-sm font-bold transition-colors cursor-pointer"
        >
          حسناً، فهمت
        </button>
      </div>
    </div>
  );

  if (variant === 'header') {
    return (
      <>
        <button
          type="button"
          onClick={() => void handlePrimaryClick()}
          className="px-3 py-2 text-xs font-bold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />
          <span>تثبيت التطبيق</span>
        </button>
        {guideModal}
      </>
    );
  }

  if (dismissed) {
    return guideModal || null;
  }

  return (
    <>
      <div
        role="region"
        aria-label="تثبيت التطبيق"
        className={`w-full rounded-2xl border p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all ${
          darkSurface
            ? 'bg-white/12 backdrop-blur-md border-emerald-400/35 text-white shadow-lg shadow-black/25'
            : 'bg-teal-50 border-teal-200 text-slate-900 shadow-xs'
        }`}
      >
        <div className="flex items-start sm:items-center gap-3 min-w-0">
          <span
            className={`w-10 h-10 rounded-xl inline-flex items-center justify-center shrink-0 ${
              darkSurface
                ? 'bg-emerald-500 text-slate-950'
                : 'bg-teal-700 text-white'
            }`}
          >
            <Download className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <p
              className={`text-sm sm:text-base font-bold leading-snug ${
                darkSurface ? 'text-white' : 'text-slate-900'
              }`}
            >
              ثبّت تطبيق محطات الكهرباء على جهازك
            </p>
            <p
              className={`text-xs sm:text-sm mt-0.5 leading-snug ${
                darkSurface ? 'text-emerald-100/90' : 'text-slate-600'
              }`}
            >
              يفتح بملء الشاشة وبوضوح تام على سامسونج وآيفون واللابتوب ويعمل
              أوفلاين.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
          <button
            type="button"
            onClick={() => void handlePrimaryClick()}
            className={`min-h-[42px] px-4 py-2 rounded-xl text-xs sm:text-sm font-bold inline-flex items-center gap-2 whitespace-nowrap cursor-pointer transition-colors ${
              darkSurface
                ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                : 'bg-teal-700 hover:bg-teal-800 text-white'
            }`}
          >
            <Download className="w-4 h-4" />
            <span>
              {isInstallable
                ? 'تثبيت التطبيق الآن'
                : isIOS
                  ? 'طريقة التثبيت على آيفون'
                  : 'تثبيت التطبيق'}
            </span>
          </button>

          <button
            type="button"
            onClick={handleDismiss}
            aria-label="إخفاء رسالة التثبيت"
            className={`w-9 h-9 rounded-lg inline-flex items-center justify-center cursor-pointer transition-colors ${
              darkSurface
                ? 'text-emerald-100/80 hover:bg-white/10 hover:text-white'
                : 'text-slate-500 hover:bg-teal-100 hover:text-slate-900'
            }`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      {guideModal}
    </>
  );
};
