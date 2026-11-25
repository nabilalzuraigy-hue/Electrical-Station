export function formatYer(amount: number): string {
  const rounded = Math.round(Number.isFinite(amount) ? amount : 0);
  return `${new Intl.NumberFormat('en-US').format(rounded)} ريال يمني`;
}

export function formatCompactYer(amount: number): string {
  const rounded = Math.round(Number.isFinite(amount) ? amount : 0);
  return `${new Intl.NumberFormat('en-US').format(rounded)} ر.ي`;
}

export function formatKwh(kwh: number): string {
  const safe = Number.isFinite(kwh) ? kwh : 0;
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(safe)} ك.و.س`;
}

export function normalizeYemenPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.startsWith('967')) return digits;
  if (digits.startsWith('0')) return `967${digits.slice(1)}`;
  if (digits.length === 9) return `967${digits}`;
  return digits;
}

export function buildArabicInvoiceMessage(params: {
  subscriberName: string;
  meterNumber: string;
  previousReading: number;
  currentReading: number;
  consumptionKwh: number;
  currentBillYer: number;
  previousDebtYer: number;
  totalDueYer: number;
  stationName: string;
}): string {
  return (
    `عزيزي المشترك ${params.subscriberName}، قراءة عدادك رقم ${params.meterNumber}: ` +
    `السابقة ${Math.round(params.previousReading)}، ` +
    `الحالية ${Math.round(params.currentReading)}، ` +
    `الاستهلاك ${params.consumptionKwh.toFixed(1)} كيلو، ` +
    `مبلغ الاستهلاك ${Math.round(params.currentBillYer)} ريال، ` +
    `المتأخرات ${Math.round(params.previousDebtYer)} ريال، ` +
    `الإجمالي المستحق: ${Math.round(params.totalDueYer)} ريال. ` +
    `محطة ${params.stationName}`
  );
}

export function getWhatsAppInvoiceUrl(phone: string, message: string): string {
  const normalized = normalizeYemenPhone(phone);
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

export function getSmsInvoiceUrl(phone: string, message: string): string {
  const normalized = normalizeYemenPhone(phone);
  return `sms:+${normalized}?body=${encodeURIComponent(message)}`;
}

export async function compressImageUnder150Kb(
  source: File | Blob | string,
): Promise<{ dataUrl: string; sizeKb: number }> {
  const img = new Image();
  img.crossOrigin = 'anonymous';

  const objectUrl =
    typeof source === 'string' ? source : URL.createObjectURL(source);

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('تعذر تحميل صورة العداد للضغط'));
    img.src = objectUrl;
  });

  const maxWidth = 960;
  const scale = img.width > maxWidth ? maxWidth / img.width : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context unavailable');
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  if (typeof source !== 'string') {
    URL.revokeObjectURL(objectUrl);
  }

  let quality = 0.72;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  let byteLength = Math.round((dataUrl.length * 3) / 4);

  while (byteLength > 148 * 1024 && quality > 0.25) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
    byteLength = Math.round((dataUrl.length * 3) / 4);
  }

  return {
    dataUrl,
    sizeKb: Number((byteLength / 1024).toFixed(1)),
  };
}
