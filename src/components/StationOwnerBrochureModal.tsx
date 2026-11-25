import React, { useState } from 'react';
import { Download, FileText, Printer, X } from 'lucide-react';
import {
  BROCHURE_IMAGES,
  downloadStationBrochureHtml,
  printStationBrochurePdf,
} from '../lib/stationBrochurePdf';

interface StationOwnerBrochureModalProps {
  open: boolean;
  onClose: () => void;
}

export const StationOwnerBrochureModal: React.FC<
  StationOwnerBrochureModalProps
> = ({ open, onClose }) => {
  const [printing, setPrinting] = useState(false);

  if (!open) return null;

  const handlePrintPdf = async () => {
    setPrinting(true);
    try {
      await printStationBrochurePdf();
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/75 flex items-center justify-center p-3 sm:p-6 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl overflow-hidden my-auto max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50">
          <div>
            <h2 className="text-base sm:text-lg font-bold text-slate-900 flex items-center gap-2">
              <FileText className="w-5 h-5 text-teal-700" />
              الدليل الشامل لأصحاب المحطات — المحصّل ومدير المحطة (PDF بالصور)
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              يشمل جميع خصائص ومميزات عمل المحصّل الميداني ولوحة مدير المحطة وبوابة المشترك
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={printing}
              onClick={() => void handlePrintPdf()}
              className="min-h-[40px] px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold rounded-lg inline-flex items-center gap-2 cursor-pointer"
            >
              <Printer className="w-4 h-4" />
              {printing ? 'جاري تجهيز PDF...' : 'حفظ / طباعة كملف PDF'}
            </button>
            <button
              type="button"
              onClick={() => void downloadStationBrochureHtml()}
              className="min-h-[40px] px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-100 text-slate-800 text-xs font-medium rounded-lg inline-flex items-center gap-2 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              تنزيل نسخة جاهزة
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق المعاينة"
              className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-200 hover:text-slate-900 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-5 sm:p-7 overflow-y-auto space-y-6 text-right">
          {/* Hero Summary */}
          <div className="rounded-2xl bg-gradient-to-br from-[#041224] via-[#062738] to-[#053328] text-white p-6 space-y-2">
            <div className="text-xs font-bold text-emerald-300">
              ⚡ نظام اتمتة موحدة للكهرباء
            </div>
            <h3 className="text-xl sm:text-2xl font-bold">
              لماذا تختار محطتك نظام إدارة الكهرباء التجارية؟
            </h3>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
              منصة ميدانية ومحاسبية متكاملة تجمع بين القراءة الذكية للعدادات في أصعب الظروف، الرقابة الفورية ضد التلاعب، كشف فاقد المولد، التحصيل النقدي والسندات، وعزل صلاحيات كل مستخدم بدقة تامة (أوفلاين وأونلاين).
            </p>
          </div>

          {/* Step 1: Collector */}
          <div className="border border-slate-200 rounded-2xl p-5 space-y-4">
            <h4 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
              1. خصائص ومميزات عمل المحصّل الميداني
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
              <ol className="md:col-span-7 list-decimal pr-5 space-y-2 text-xs sm:text-sm text-slate-700 leading-relaxed">
                <li>
                  <strong>خط السير والبحث السريع:</strong> دخول بكود المحصّل لحاراته المخصصة فقط، بحث بآخر 3–4 أرقام أو الاسم، وخيار استيراد كشف Excel قديم من ذاكرة الهاتف.
                </li>
                <li>
                  <strong>الفلاش التلقائي وتحسين الصورة:</strong> تشغيل الفلاش تلقائياً في الإضاءة الضعيفة، وتحسين الصورة (رفع التباين، إزالة الظل والغبار، تكبير الأرقام مرتين، وأبيض وأسود) مع ضغطها محلياً (&lt; 150 KB).
                </li>
                <li>
                  <strong>قراءة 3 مرات وثقة ≥ 85%:</strong> القراءة بأكثر من محرك OCR واعتماد المتكرر مرتين بثقة ≥ 85% مع رفض القفزات غير المنطقية وطلب إعادة التصوير.
                </li>
                <li>
                  <strong>المراجعة والحالات الخاصة:</strong> تأكيد القراءة أو تعديلها يدوياً (مع توثيق الأصل والجديد وإشعار فوري للمدير)، قبول المطابقة للسابقة كـ «استهلاك صفر - بيت مغلق»، وتوقيف الأقل لاختيار السبب (تغيير العداد وتصوير الجديد، تصفير، أو خطأ سابق) بموافقة المدير.
                </li>
                <li>
                  <strong>القبض والفواتير والمزامنة:</strong> حساب الفاتورة آلياً وإصدار سند قبض، إرسال عبر واتساب أو SMS، عمل كامل أوفلاين ومزامنة بدفعات (20 سجل/دفعة &lt; 2 MB) أو نسخ بالكيبل USB.
                </li>
              </ol>
              <div className="md:col-span-5">
                <img
                  src={BROCHURE_IMAGES.collector}
                  alt="تطبيق المحصّل الميداني لتصوير وقراءة العداد"
                  referrerPolicy="no-referrer"
                  className="w-full rounded-xl border border-slate-200 object-cover aspect-[4/3]"
                />
              </div>
            </div>
          </div>

          {/* Step 2: Manager */}
          <div className="border border-slate-200 rounded-2xl p-5 space-y-4">
            <h4 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
              2. خصائص ومميزات لوحة مدير المحطة
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
              <ol className="md:col-span-7 list-decimal pr-5 space-y-2 text-xs sm:text-sm text-slate-700 leading-relaxed">
                <li>
                  <strong>لوحة مستقلة ومعزولة:</strong> يدخل المدير للوحاته الإدارية فقط دون ظهور تطبيق المحصّل أو الأكواد البرمجية، مع تحديث حي كل 15 ثانية وشارة لعدد الإشعارات المعلقة.
                </li>
                <li>
                  <strong>قائمة «التعديلات المشبوهة» والإشعارات الفورية:</strong> مرتبة زمنياً وتعرض اسم المحصّل والمشترك، الرقم الأصلي من OCR والجديد والفارق، سبب النقص وتفاصيل العداد الجديد، وصورة العداد القابلة للتكبير، مع أزرار <strong>قبول التعديل</strong> أو <strong>رفض التعديل</strong>.
                </li>
                <li>
                  <strong>تنبيه أصفر للاستهلاك الشاذ وكشف الفاقد:</strong> تنبيه أصفر تلقائي عند تجاوز الاستهلاك 3 أضعاف متوسط آخر 3 أشهر، ومقارنة المباع مع عداد المولد الرئيسي لحساب نسبة الفاقد %.
                </li>
                <li>
                  <strong>4 مؤشرات وإدارة التعرفة:</strong> المشتركون، المباع مقابل المولد، النقد المحصّل، والمتأخرات، مع تعديل سعر الكيلووات والحد الأدنى وتوليد المولد الرئيسي.
                </li>
                <li>
                  <strong>إدارة المحصّلين وسجل المشتركين وExcel:</strong> تفعيل/إيقاف المحصّلين وضبط صلاحياتهم الأربع، البحث والفلترة في السجل مع وسوم «بيت مغلق» و«بانتظار المدير»، وتصدير التقرير المالي الكامل Excel.
                </li>
              </ol>
              <div className="md:col-span-5">
                <img
                  src={BROCHURE_IMAGES.manager}
                  alt="لوحة مدير المحطة ومراقبة الفاقد والتقارير"
                  referrerPolicy="no-referrer"
                  className="w-full rounded-xl border border-slate-200 object-cover aspect-video"
                />
              </div>
            </div>
          </div>

          {/* Step 3: Subscriber */}
          <div className="border border-slate-200 rounded-2xl p-5 space-y-4">
            <h4 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
              3. شفافية المشترك وسجل السداد
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
              <ol className="md:col-span-7 list-decimal pr-5 space-y-2 text-xs sm:text-sm text-slate-700 leading-relaxed">
                <li>
                  يدخل المشترك باسمه المسجل في كشف Excel ورقم هاتفه فقط دون تعقيد.
                </li>
                <li>
                  يعرض النظام القراءة المعتمدة من المدير فقط، الاستهلاك (أو «استهلاك صفر - بيت مغلق»)، مبلغ الفاتورة، المتبقي المستحق، وسجل سندات القبض الكامل.
                </li>
              </ol>
              <div className="md:col-span-5">
                <img
                  src={BROCHURE_IMAGES.subscriber}
                  alt="استعلام المشترك عن الفاتورة وسندات القبض"
                  referrerPolicy="no-referrer"
                  className="w-full rounded-xl border border-slate-200 object-cover aspect-[4/3]"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
