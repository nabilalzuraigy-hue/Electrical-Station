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
  <title>الدليل الشامل لنظام إدارة محطات الكهرباء التجارية</title>
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
      line-height: 1.6;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    h1, h2, h3, h4 {
      font-family: 'Cairo', 'IBM Plex Sans Arabic', sans-serif;
      margin: 0;
    }
    .page-break {
      page-break-before: always;
    }
    .hero {
      background: linear-gradient(135deg, #041224 0%, #062738 52%, #053328 100%);
      color: #ffffff;
      padding: 24px 26px;
      border-radius: 16px;
      margin-bottom: 16px;
    }
    .hero-badge {
      display: inline-block;
      font-size: 12px;
      font-weight: 700;
      color: #a7f3d0;
      margin-bottom: 6px;
    }
    .hero h1 {
      font-size: 24px;
      font-weight: 800;
      margin-bottom: 6px;
    }
    .hero p {
      margin: 0;
      font-size: 13px;
      color: #e2e8f0;
    }
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 16px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 12px;
    }
    .card {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 12px 14px;
      background: #f8fafc;
      page-break-inside: avoid;
    }
    .card h3 {
      font-size: 13.5px;
      color: #0f766e;
      margin-bottom: 4px;
    }
    .card p {
      margin: 0;
      font-size: 11.8px;
      color: #334155;
    }
    .section-block {
      border: 1px solid #cbd5e1;
      border-radius: 16px;
      padding: 16px 18px;
      margin-bottom: 16px;
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 8px;
      margin-bottom: 12px;
    }
    .section-head h2 {
      font-size: 17px;
      color: #0f172a;
    }
    .section-tag {
      font-size: 11.5px;
      font-weight: 700;
      color: #0f766e;
      background: #f0fdfa;
      border: 1px solid #99f6e4;
      padding: 2px 10px;
      border-radius: 999px;
    }
    .media-split {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 14px;
      align-items: start;
    }
    .photo {
      width: 100%;
      border-radius: 12px;
      border: 1px solid #cbd5e1;
      object-fit: cover;
      max-height: 210px;
    }
    .steps {
      margin: 0;
      padding: 0 18px 0 0;
      font-size: 12px;
      color: #1e293b;
    }
    .steps li {
      margin-bottom: 6px;
    }
    .sub-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px 12px;
      page-break-inside: avoid;
    }
    .sub-box h4 {
      font-size: 12.5px;
      color: #0f172a;
      margin-bottom: 4px;
    }
    .sub-box ul {
      margin: 0;
      padding: 0 16px 0 0;
      font-size: 11.5px;
      color: #334155;
    }
    .sub-box li {
      margin-bottom: 3px;
    }
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-top: 12px;
    }
    .kpi-box {
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 9px 10px;
      background: #ffffff;
    }
    .kpi-label {
      font-size: 10.5px;
      color: #64748b;
    }
    .kpi-val {
      font-size: 13.5px;
      font-weight: 700;
      color: #0f172a;
      margin-top: 2px;
    }
    .footer-note {
      text-align: center;
      font-size: 11px;
      color: #64748b;
      margin-top: 14px;
      border-top: 1px solid #e2e8f0;
      padding-top: 8px;
    }
  </style>
</head>
<body>
  <div class="hero">
    <div class="hero-badge">⚡ نظام اتمتة موحدة للكهرباء — الدليل الشامل لأصحاب المحطات</div>
    <h1>نظام إدارة محطات الكهرباء التجارية</h1>
    <p>منصة ميدانية ومحاسبية متكاملة تجمع بين القراءة الذكية للعدادات في أصعب الظروف، الرقابة الفورية الصارمة ضد التلاعب، كشف فاقد التوليد، التحصيل النقدي والسندات، وعزل صلاحيات كل مستخدم بدقة تامة (أوفلاين وأونلاين).</p>
  </div>

  <div class="grid-3">
    <div class="card">
      <h3>1. OCR فائق الحساسية</h3>
      <p>معالجة تلقائية للصورة (تباين، إزالة ظل وغبار، تكبير 2×، أبيض وأسود) مع فلاش تلقائي، وقراءة 3 مرات بأكثر من محرك بثقة ≥ 85%.</p>
    </div>
    <div class="card">
      <h3>2. حماية كاملة ضد التلاعب</h3>
      <p>إشعار فوري للمدير عند أي تعديل يدوي أو قراءة أقل من السابقة مع الصورة والفارق، ولا تُعتمد أي قراءة معدلة إلا بموافقة المدير.</p>
    </div>
    <div class="card">
      <h3>3. كشف الفاقد والاستهلاك الشاذ</h3>
      <p>مقارنة إجمالي المباع مع عداد المولد الرئيسي لحساب نسبة الفاقد، وتنبيه أصفر فوري لأي استهلاك يتجاوز 3 أضعاف متوسط 3 أشهر.</p>
    </div>
    <div class="card">
      <h3>4. يعمل أوفلاين بأقل استهلاك بيانات</h3>
      <p>حفظ الصور محلياً بحجم &lt; 150 KB، ومزامنة القراءات النصية على دفعات آمنة (20 سجل/دفعة بحجم &lt; 2 MB) مع خيار النقل بكيبل USB.</p>
    </div>
    <div class="card">
      <h3>5. عزل تام بين المحطات والأدوار</h3>
      <p>لكل محطة قاعدة بيانات مستقلة، ويدخل المدير للوحاته الإدارية فقط دون اختلاط بتطبيق المحصّل أو لوحة الأكواد.</p>
    </div>
    <div class="card">
      <h3>6. تقارير Excel وفواتير فورية</h3>
      <p>تصدير التقرير المالي الشامل بضغطة زر، وإرسال الفاتورة وسند القبض للمشترك عبر واتساب أو SMS مباشرة من الميدان.</p>
    </div>
  </div>

  <!-- Section 1: Collector App -->
  <div class="section-block">
    <div class="section-head">
      <h2>أولاً: خصائص ومميزات عمل المحصّل الميداني (خطوة بخطوة)</h2>
      <span class="section-tag">تطبيق المحصّل الميداني</span>
    </div>

    <div class="media-split">
      <ol class="steps">
        <li><strong>خط السير المخصص والبحث السريع:</strong> يدخل المحصّل بكوده فيظهر له مشتركو الحارات المخصصة له فقط مرتبين حسب تسلسل البيوت، مع البحث الفوري بآخر 3–4 أرقام من العداد أو الاسم أو الحارة، وزر إضافي لاستيراد كشف Excel قديم من ذاكرة هاتفه.</li>
        <li><strong>الكاميرا المباشرة والفلاش التلقائي:</strong> عند فتح الكاميرا يظهر إطار لتوجيه أرقام العداد، ويفحص التطبيق شدة الإضاءة ليشغّل الفلاش تلقائياً في الأماكن المظلمة (مع زر تحكم يدوي بالفلاش).</li>
        <li><strong>تحسين الصورة وتقليص الحجم:</strong> يعالج التطبيق الصورة تلقائياً قبل القراءة (رفع التباين، إزالة الظل والغبار، تكبير منطقة الأرقام مرتين، والتحويل لأبيض وأسود مع زر معاينة الصورة المكبّرة)، ويضغط الصورة لأقل من 150 KB في ذاكرة الهاتف.</li>
        <li><strong>القراءة الثلاثية وبوابة الثقة ≥ 85%:</strong> يقرأ الرقم 3 مرات بأكثر من محرك OCR ويعرض نتيجة كل محرك ونسبة التطابق؛ ولا يقبل الرقم إلا بتطابق قراءتين وبثقة ≥ 85% وخلوّه من قفزات غير منطقية، وإلا يرفضه ويطلب إعادة التصوير.</li>
        <li><strong>المراجعة والتأكيد أو التعديل اليدوي الموثّق:</strong> يختار المحصّل «تأكيد القراءة» أو «تعديل يدوي»؛ وعند التعديل اليدوي تُسجل بيانات التدقيق (الأصل من OCR، الجديد، الفارق، اسم المحصّل، والوقت) ويُرسل إشعار فوري للمدير بانتظار موافقته.</li>
      </ol>
      <img class="photo" src="${collectorSrc}" alt="تطبيق المحصّل الميداني لتصوير وقراءة العداد" />
    </div>

    <div class="grid-2">
      <div class="sub-box">
        <h4>معالجة الحالات الميدانية الخاصة تلقائياً</h4>
        <ul>
          <li><strong>البيت المغلق / السفر:</strong> إذا ساوت القراءة الجديدة القراءة السابقة تماماً تُقبل وتُسجّل كـ «استهلاك صفر - بيت مغلق».</li>
          <li><strong>القراءة أقل من السابقة:</strong> تتوقف القراءة وتظهر نافذة لاختيار السبب (تم تغيير العداد بعداد جديد، تم تصفير العداد، أو خطأ في القراءة السابقة).</li>
          <li><strong>تغيير العداد:</strong> يُلزم المحصّل بتصوير العداد الجديد وإدخال رقمه الجديد وقراءته الافتتاحية، وتُرفع فوراً لموافقة المدير.</li>
          <li><strong>تنبيه الاستهلاك الشاذ:</strong> تنبيه أصفر فوري للمحصّل والمدير إذا تجاوز الاستهلاك 3 أضعاف متوسط آخر 3 أشهر.</li>
        </ul>
      </div>
      <div class="sub-box">
        <h4>التحصيل، الفواتير، والمزامنة المرنة</h4>
        <ul>
          <li><strong>الحساب الآلي وسند القبض:</strong> حساب الاستهلاك والحد الأدنى والمتأخرات تلقائياً، وتسجيل المدفوع نقداً بسند قبض فوري (وفق صلاحيات المحصّل).</li>
          <li><strong>إرسال الفاتورة بضغطة زر:</strong> تجهيز نص الفاتورة الكامل وإرساله فوراً عبر واتساب أو SMS أو نسخه للحافظة.</li>
          <li><strong>العمل أوفلاين والدفعات الآمنة:</strong> حفظ كل العمليات محلياً عند انقطاع الشبكة، ثم رفع القراءات النصية بدفعات (20 سجل/دفعة) عبر شريط تقدم واضح.</li>
          <li><strong>النسخ بالكيبل (USB):</strong> زر مخصص لحفظ قراءات المحصّل كملف Excel لنقلها للكمبيوتر عند الحاجة.</li>
        </ul>
      </div>
    </div>
  </div>

  <!-- Section 2: Manager Dashboard -->
  <div class="section-block page-break">
    <div class="section-head">
      <h2>ثانياً: خصائص ومميزات لوحة مدير المحطة</h2>
      <span class="section-tag">لوحة مدير المحطة</span>
    </div>

    <div class="media-split">
      <ol class="steps">
        <li><strong>قائمة «التعديلات المشبوهة والتنبيهات الفورية»:</strong> تصله مرتبة حسب الوقت مع تحديث آلي كل 15 ثانية وشارة بعدد الإشعارات المعلقة، وتعرض التعديلات اليدوية والقراءات الأقل من السابقة (مع سبب النقص وتفاصيل العداد الجديد) مع اسم المحصّل والمشترك، الرقم الأصلي، الجديد، الفارق، وصورة العداد القابلة للتكبير، وأزرار <strong>قبول التعديل</strong> أو <strong>رفض التعديل</strong>.</li>
        <li><strong>التنبيه الأصفر للاستهلاك المرتفع:</strong> إشعار أصفر مميز لأي مشترك يتجاوز استهلاكه 3 أضعاف متوسط آخر 3 أشهر مع مقارنة الرقمين وزر «إقرار المراجعة» لاكتشاف الأعطال أو الأخطاء مبكراً.</li>
        <li><strong>إدارة التعرفة وقراءة المولد الرئيسي:</strong> ضبط اسم المحطة، سعر الكيلووات (ر.ي)، الحد الأدنى للاشتراك، وإدخال إجمالي توليد المولد الرئيسي للشهر ليُقارن تلقائياً بالمباع.</li>
        <li><strong>متابعة المحصّلين وتحديد الصلاحيات الأربع:</strong> عرض جميع محصّلي المحطة ومناطقهم وأكوادهم، مع زر إيقاف/تفعيل فوري لأي محصّل، والتحكم بصلاحياته الأربع: (تسجيل القراءات، تحصيل نقدي، إرسال فواتير، عرض المتأخرات).</li>
        <li><strong>سجل المشتركين وتصدير Excel الشامل:</strong> جدول مرتّب بخط السير مع البحث بالاسم أو العداد والفلترة بالحارة، وعرض القراءة السابقة والحالية ووسوم «استهلاك صفر - بيت مغلق» أو «بانتظار موافقة المدير»، وزر لتصدير التقرير المالي الكامل Excel.</li>
      </ol>
      <img class="photo" src="${managerSrc}" alt="لوحة مدير المحطة ومراقبة الفاقد والتقارير" />
    </div>

    <div class="kpi-row">
      <div class="kpi-box">
        <div class="kpi-label">المؤشر 1 · المشتركون</div>
        <div class="kpi-val">إجمالي المسجلين</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">المؤشر 2 · كشف الفاقد</div>
        <div class="kpi-val">المباع مقابل المولد %</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">المؤشر 3 · الصندوق</div>
        <div class="kpi-val">إجمالي النقد المحصّل</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">المؤشر 4 · الديون</div>
        <div class="kpi-val">المتأخرات غير المسددة</div>
      </div>
    </div>
  </div>

  <!-- Section 3: Subscriber Portal -->
  <div class="section-block">
    <div class="section-head">
      <h2>ثالثاً: بوابة شفافية المشترك وتقليل الخلافات</h2>
      <span class="section-tag">بوابة المشترك</span>
    </div>
    <div class="media-split">
      <ol class="steps">
        <li><strong>استعلام مباشر بالاسم والهاتف:</strong> يدخل المشترك اسمه الكامل ورقم هاتفه المسجل في كشف المحطة دون الحاجة لكلمات مرور معقدة.</li>
        <li><strong>اعتماد القراءات الموثقة فقط:</strong> يعرض النظام القراءة السابقة والحالية المعتمدة من المدير فقط، كمية الاستهلاك (أو «استهلاك صفر - بيت مغلق»)، مبلغ الفاتورة، والرصيد المتبقي.</li>
        <li><strong>سجل سندات القبض الكامل:</strong> يطّلع المشترك على تاريخ كل سداد وقيمته واسم المحصّل، مما يمنع الجدل ويرفع نسبة الالتزام بالسداد.</li>
      </ol>
      <img class="photo" src="${subscriberSrc}" alt="المشترك يراجع الفاتورة وسندات القبض" />
    </div>
  </div>

  <div class="footer-note">
    نظام إدارة الكهرباء التجارية · نظام اتمتة موحدة للكهرباء · الدليل الكامل لمميزات المحصّل ولوحة مدير المحطة
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
