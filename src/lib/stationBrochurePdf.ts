import collectorImg from '../assets/images/collector_meter_capture_1795621741764.jpg';
import managerImg from '../assets/images/manager_station_desk_1795621741063.jpg';
import subscriberImg from '../assets/images/subscriber_bill_receipt_1795621740847.jpg';

export const BROCHURE_IMAGES = {
  collector: collectorImg,
  manager: managerImg,
  subscriber: subscriberImg,
};

async function imageUrlToDataUri(url: string): Promise<string> {
  try {
    const absUrl = new URL(url, window.location.origin).href;
    const res = await fetch(absUrl);
    const blob = await res.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () =>
        resolve(typeof reader.result === 'string' ? reader.result : absUrl);
      reader.onerror = () => resolve(absUrl);
      reader.readAsDataURL(blob);
    });
  } catch {
    return url;
  }
}

export async function buildStationBrochureHtml(): Promise<string> {
  const [collectorSrc, managerSrc, subscriberSrc] = await Promise.all([
    imageUrlToDataUri(collectorImg),
    imageUrlToDataUri(managerImg),
    imageUrlToDataUri(subscriberImg),
  ]);

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <title>دليل نظام إدارة الكهرباء التجارية لأصحاب المحطات</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@600;700;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    @page {
      size: A4;
      margin: 12mm;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: 'IBM Plex Sans Arabic', 'Cairo', Tahoma, Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      line-height: 1.65;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    h1, h2, h3 {
      font-family: 'Cairo', 'IBM Plex Sans Arabic', sans-serif;
      margin: 0;
    }
    .page-break {
      page-break-before: always;
    }
    .hero {
      background: linear-gradient(135deg, #041224 0%, #062738 52%, #053328 100%);
      color: #ffffff;
      padding: 28px;
      border-radius: 18px;
      margin-bottom: 20px;
    }
    .hero-badge {
      display: inline-block;
      font-size: 12px;
      font-weight: 700;
      color: #a7f3d0;
      margin-bottom: 8px;
    }
    .hero h1 {
      font-size: 26px;
      font-weight: 800;
      margin-bottom: 8px;
    }
    .hero p {
      margin: 0;
      font-size: 14px;
      color: #e2e8f0;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 18px;
    }
    .card {
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      padding: 16px;
      background: #f8fafc;
    }
    .card h3 {
      font-size: 15px;
      color: #0f766e;
      margin-bottom: 6px;
    }
    .card p {
      margin: 0;
      font-size: 12.5px;
      color: #334155;
    }
    .section-block {
      border: 1px solid #cbd5e1;
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 18px;
      page-break-inside: avoid;
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 10px;
      margin-bottom: 14px;
    }
    .section-head h2 {
      font-size: 18px;
      color: #0f172a;
    }
    .section-tag {
      font-size: 12px;
      font-weight: 700;
      color: #0f766e;
    }
    .media-split {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 16px;
      align-items: start;
    }
    .photo {
      width: 100%;
      border-radius: 12px;
      border: 1px solid #cbd5e1;
      object-fit: cover;
      max-height: 220px;
    }
    .steps {
      margin: 0;
      padding: 0 18px 0 0;
      font-size: 12.5px;
      color: #1e293b;
    }
    .steps li {
      margin-bottom: 8px;
    }
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-top: 14px;
    }
    .kpi-box {
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 10px;
      background: #ffffff;
    }
    .kpi-label {
      font-size: 11px;
      color: #64748b;
    }
    .kpi-val {
      font-size: 15px;
      font-weight: 700;
      color: #0f172a;
      margin-top: 3px;
    }
    .footer-note {
      text-align: center;
      font-size: 11.5px;
      color: #64748b;
      margin-top: 18px;
      border-top: 1px solid #e2e8f0;
      padding-top: 10px;
    }
  </style>
</head>
<body>
  <div class="hero">
    <div class="hero-badge">⚡ نظام اتمتة موحدة للكهرباء</div>
    <h1>نظام إدارة محطات الكهرباء التجارية</h1>
    <p>منصة متكاملة لإدارة المشتركين، قراءة العدادات في أصعب ظروف الإضاءة بدقة OCR ثلاثية المحركات، نظام إشعارات فوري ورقابة صارمة ضد التلاعب، كشف فاقد الطاقة مقارنة بالمولد الرئيسي، والتحصيل المالي الدقيق لكل محطة مستقلة ومعزولة.</p>
  </div>

  <div class="grid-2">
    <div class="card">
      <h3>1. قراءة OCR فائقة الحساسية في الظروف الصعبة</h3>
      <p>يعالج النظام الصورة تلقائياً قبل القراءة (رفع التباين، إزالة الظل والغبار، تكبير الأرقام مرتين، والتحويل لأبيض وأسود) مع تشغيل الفلاش تلقائياً في الإضاءة الضعيفة، ثم يقرأ الرقم 3 مرات بأكثر من محرك ولا يقبله إلا بتطابق مرتين وبثقة ≥ 85%.</p>
    </div>
    <div class="card">
      <h3>2. رقابة فورية ومنع التلاعب بالقراءات</h3>
      <p>يرفض النظام أي قفزة غير منطقية، وإذا عدّل المحصّل الرقم يدوياً يُسجَّل التعديل ويُرسل إشعار فوري للمدير بالرقم الأصلي والجديد والفرق والصورة، ولا تُعتمد القراءة في حساب المشترك إلا بموافقة المدير.</p>
    </div>
    <div class="card">
      <h3>3. يعمل أوفلاين ويوفر الإنترنت بسرعة فائقة</h3>
      <p>لا يتوقف المحصّل عند انقطاع الشبكة؛ تُضغط الصور لأقل من 150 كيلوبايت وتُحفظ في الهاتف، وترتفع القراءات النصية على دفعات آمنة (20 قراءة بالدفعة) بحجم لا يتجاوز 2 ميغابايت لآلاف المشتركين، مع خيار النسخ عبر كيبل USB.</p>
    </div>
    <div class="card">
      <h3>4. كشف الفاقد والاستهلاك الشاذ</h3>
      <p>يقارن النظام إجمالي المباع مع عداد المولد الرئيسي لكشف الفاقد، ويرسل للمدير «تنبيهاً أصفراً» تلقائياً إذا تجاوز استهلاك أي مشترك 3 أضعاف متوسط آخر 3 أشهر، كما يوثق حالات السفر كـ «استهلاك صفر - بيت مغلق».</p>
    </div>
  </div>

  <div class="section-block">
    <div class="section-head">
      <h2>أولاً: كيف تتم عملية قراءة العداد من المحصّل الميداني؟</h2>
      <span class="section-tag">تطبيق المحصّل الميداني</span>
    </div>
    <div class="media-split">
      <ol class="steps">
        <li><strong>تسجيل الدخول وخط السير:</strong> يدخل المحصّل بكوده الخاص، فيظهر له كشف المشتركين مرتباً حسب تسلسل البيوت والحارات المخصصة له فقط، مع البحث بآخر 3 أو 4 أرقام من العداد أو الاسم أو الهاتف (وإمكانية استيراد كشف Excel قديم من ذاكرة الهاتف).</li>
        <li><strong>تحسين الصورة والفلاش التلقائي:</strong> عند فتح الكاميرا يفحص التطبيق الإضاءة ويشغّل الفلاش تلقائياً إذا كانت الإضاءة ضعيفة، ثم يعالج الصورة (إزالة الظل والغبار + تكبير منطقة الأرقام + أبيض وأسود) ويحفظ نسخة مضغوطة (&lt; 150 KB).</li>
        <li><strong>قراءة ثلاثية وبوابة ثقة ≥ 85%:</strong> يقرأ النظام الرقم 3 مرات بأكثر من محرك OCR ويعتمد الرقم المتكرر مرتين على الأقل؛ وإذا كانت الثقة أقل من 85% أو كان الفارق عن القراءة السابقة غير منطقي، يرفض الرقم ويطلب إعادة التصوير فوراً.</li>
        <li><strong>المراجعة، التعديل اليدوي، والحالات الخاصة:</strong> يراجع المحصّل الرقم عبر زر «تأكيد القراءة» أو «تعديل يدوي» (مع توثيق الأصل والجديد والوقت وإرسال إشعار فوري للمدير). وإذا كانت القراءة تساوي السابقة تُقبل كـ «استهلاك صفر - بيت مغلق»؛ وإذا كانت أقل من السابقة تتوقف القراءة لاختيار السبب (تغيير العداد وتصوير العداد الجديد وإدخال رقمه وقراءته الافتتاحية، أو تصفير العداد، أو خطأ سابق) وترفع لموافقة المدير.</li>
        <li><strong>القبض، الفاتورة، والمزامنة:</strong> يسجل المحصّل سند القبض النقدي ويرسل الفاتورة عبر واتساب أو SMS، ثم يزامن القراءات أو ينسخها بالكيبل (USB) بملف Excel.</li>
      </ol>
      <img class="photo" src="${collectorSrc}" alt="المحصّل الميداني يصور العداد" />
    </div>
  </div>

  <div class="section-block page-break">
    <div class="section-head">
      <h2>ثانياً: ماذا يظهر لمدير المحطة في لوحته؟</h2>
      <span class="section-tag">لوحة مدير المحطة</span>
    </div>
    <div class="media-split">
      <ol class="steps">
        <li><strong>قائمة «التعديلات المشبوهة» والإشعارات الفورية:</strong> تصله فوراً مرتبة حسب الوقت كل عمليات التعديل اليدوي أو القراءات الأقل من السابقة، متضمنةً اسم المحصّل والمشترك، الرقم الأصلي من OCR، الرقم الجديد، الفرق، وقت التعديل، وصورة العداد القابلة للتكبير، مع أزرار <strong>قبول التعديل</strong> أو <strong>رفض التعديل</strong> (ولا تُعتمد القراءة إلا بموافقته).</li>
        <li><strong>تنبيهات الاستهلاك المرتفع (التنبيه الأصفر):</strong> إشعار أصفر واضح لأي مشترك يتجاوز استهلاكه 3 أضعاف متوسط آخر 3 أشهر لمراجعته المبكرة قبل صدور الاعتراضات.</li>
        <li><strong>4 مؤشرات فورية وإدارة التعرفة:</strong> عدد المشتركين، المباع مقابل عداد المولد ونسبة الفاقد %، النقد المحصّل، والمتأخرات، مع ضبط سعر الكيلووات والحد الأدنى وقراءة المولد الرئيسي.</li>
        <li><strong>الرقابة الكاملة على المحصّلين والتقارير:</strong> تفعيل أو إيقاف حساب أي محصّل والتحكم بصلاحياته الأربع، وعرض السجل المحدّث بحالات «استهلاك صفر - بيت مغلق» أو «بانتظار موافقة المدير»، مع تصدير التقرير المالي الكامل Excel.</li>
      </ol>
      <img class="photo" src="${managerSrc}" alt="لوحة مدير المحطة والتقارير" />
    </div>
    <div class="kpi-row">
      <div class="kpi-box">
        <div class="kpi-label">دقة القراءة المتعددة</div>
        <div class="kpi-val">3 قراءات ≥ 85%</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">حماية ضد التلاعب</div>
        <div class="kpi-val">موافقة المدير إلزامية</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">كشف الاستهلاك الشاذ</div>
        <div class="kpi-val">تنبيه أصفر &gt; 3×</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">التقارير المحاسبية</div>
        <div class="kpi-val">تصدير Excel بضغطة زر</div>
      </div>
    </div>
  </div>

  <div class="section-block">
    <div class="section-head">
      <h2>ثالثاً: بوابة شفافية المشترك وتقليل الخلافات</h2>
      <span class="section-tag">استعلام المشترك</span>
    </div>
    <div class="media-split">
      <ol class="steps">
        <li><strong>استعلام سهل بدون تعقيد:</strong> يدخل المشترك اسمه الكامل ورقم هاتفه المسجل في كشف المحطة فقط.</li>
        <li><strong>عرض الفواتير المعتمدة فقط:</strong> يرى القراءة السابقة والحالية المعتمدة من الإدارة فقط، كمية الاستهلاك (أو «استهلاك صفر - بيت مغلق»)، مبلغ الفاتورة، الرصيد المتبقي، وسجل سندات القبض باسم المحصّل وتاريخ السداد.</li>
        <li><strong>ثقة كاملة مع الإدارة:</strong> توثيق كل قراءة بالصورة ومراجعتها ثلاثياً يمنع أي جدل أو أخطاء بشرية ويرفع نسبة السداد والانضباط لدى المشتركين.</li>
      </ol>
      <img class="photo" src="${subscriberSrc}" alt="المشترك يراجع الفاتورة" />
    </div>
  </div>

  <div class="footer-note">
    نظام إدارة الكهرباء التجارية · نظام اتمتة موحدة للكهرباء · دليل تعريفي محدّث لأصحاب المحطات
  </div>
</body>
</html>`;
}

export async function printStationBrochurePdf(): Promise<void> {
  const html = await buildStationBrochureHtml();
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc || !iframe.contentWindow) {
    document.body.removeChild(iframe);
    throw new Error('تعذر تجهيز نافذة طباعة PDF.');
  }

  doc.open();
  doc.write(html);
  doc.close();

  await new Promise<void>((resolve) => {
    const imgs = Array.from(doc.images);
    if (imgs.length === 0) {
      setTimeout(resolve, 350);
      return;
    }
    let settled = 0;
    const done = () => {
      settled++;
      if (settled >= imgs.length) setTimeout(resolve, 350);
    };
    imgs.forEach((img) => {
      if (img.complete) done();
      else {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }
    });
    setTimeout(resolve, 2500);
  });

  const cleanup = () => {
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 1000);
  };

  iframe.contentWindow.addEventListener('afterprint', cleanup, { once: true });
  iframe.contentWindow.focus();
  iframe.contentWindow.print();
  setTimeout(cleanup, 15000);
}

export async function downloadStationBrochureHtml(): Promise<void> {
  const html = await buildStationBrochureHtml();
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'دليل_نظام_محطات_الكهرباء_التجارية.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
