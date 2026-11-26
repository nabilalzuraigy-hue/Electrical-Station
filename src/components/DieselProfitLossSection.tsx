import React, { useMemo, useState } from 'react';
import {
  Flame,
  Lock,
  Plus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  addDieselExpenseInCloud,
  saveStationLocalState,
  type StationLocalState,
} from '../lib/offlineDb';
import { formatCompactYer, formatYer } from '../lib/formatters';
import type { ExpenseCategory } from '../types/station';

interface DieselProfitLossSectionProps {
  state: StationLocalState;
  staffToken: string;
  onUpdateState: (next: StationLocalState) => void;
}

const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  diesel: 'ديزل / وقود المولد',
  oil_maintenance: 'زيوت وقطع غيار وصيانة',
  salaries: 'رواتب وأجور',
  other: 'مصاريف تشغيلية أخرى',
};

export const DieselProfitLossSection: React.FC<DieselProfitLossSectionProps> = ({
  state,
  staffToken,
  onUpdateState,
}) => {
  const [revenueBasis, setRevenueBasis] = useState<'collected' | 'billed'>(
    'collected',
  );
  const [category, setCategory] = useState<ExpenseCategory>('diesel');
  const [date, setDate] = useState<string>(
    () => new Date().toISOString().slice(0, 10),
  );
  const [litersInput, setLitersInput] = useState('');
  const [pricePerLiterInput, setPricePerLiterInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const expenses = state.expenses ?? [];

  const summary = useMemo(() => {
    const collectedCashYer = state.receipts.reduce(
      (sum, rc) => sum + rc.amountPaidYer,
      0,
    );
    const totalBilledYer = state.readings
      .filter((r) => r.approvalStatus !== 'rejected')
      .reduce((sum, r) => sum + r.currentBillYer, 0);

    const activeRevenueYer =
      revenueBasis === 'collected' ? collectedCashYer : totalBilledYer;

    let dieselCostYer = 0;
    let totalLiters = 0;
    let otherExpensesYer = 0;

    expenses.forEach((exp) => {
      if (exp.category === 'diesel') {
        dieselCostYer += exp.amountYer;
        totalLiters += exp.liters ?? 0;
      } else {
        otherExpensesYer += exp.amountYer;
      }
    });

    const totalExpensesYer = dieselCostYer + otherExpensesYer;
    const netProfitYer = activeRevenueYer - totalExpensesYer;
    const profitMarginPct =
      activeRevenueYer > 0 ? (netProfitYer / activeRevenueYer) * 100 : 0;
    const avgCostPerLiter =
      totalLiters > 0 ? Math.round(dieselCostYer / totalLiters) : 0;
    const dieselCostPerGenKwh =
      state.station.mainGeneratorKwh > 0
        ? Math.round(dieselCostYer / state.station.mainGeneratorKwh)
        : 0;

    return {
      collectedCashYer,
      totalBilledYer,
      activeRevenueYer,
      dieselCostYer,
      totalLiters,
      otherExpensesYer,
      totalExpensesYer,
      netProfitYer,
      profitMarginPct,
      avgCostPerLiter,
      dieselCostPerGenKwh,
    };
  }, [
    state.receipts,
    state.readings,
    state.station.mainGeneratorKwh,
    expenses,
    revenueBasis,
  ]);

  const handleLitersOrPriceChange = (nextLiters: string, nextPrice: string) => {
    setLitersInput(nextLiters);
    setPricePerLiterInput(nextPrice);
    const l = Number(nextLiters);
    const p = Number(nextPrice);
    if (
      category === 'diesel' &&
      Number.isFinite(l) &&
      Number.isFinite(p) &&
      l > 0 &&
      p > 0
    ) {
      setAmountInput(String(Math.round(l * p)));
    }
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const amountVal = Math.round(Number(amountInput) || 0);
    if (amountVal <= 0) {
      setErrorMsg('يرجى إدخال مبلغ صحيح أكبر من الصفر.');
      return;
    }

    const litersVal =
      category === 'diesel' && Number(litersInput) > 0
        ? Number(litersInput)
        : undefined;
    const priceVal =
      category === 'diesel' && Number(pricePerLiterInput) > 0
        ? Number(pricePerLiterInput)
        : undefined;

    setSubmitting(true);
    try {
      const saved = await addDieselExpenseInCloud({
        staffToken,
        stationId: state.station.stationId,
        date,
        category,
        liters: litersVal,
        pricePerLiterYer: priceVal,
        amountYer: amountVal,
        note: noteInput.trim(),
      });
      const nextState: StationLocalState = {
        ...state,
        expenses: [saved, ...expenses],
      };
      await saveStationLocalState(nextState);
      onUpdateState(nextState);
      setLitersInput('');
      setPricePerLiterInput('');
      setAmountInput('');
      setNoteInput('');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'تعذر تسجيل المصروف في الخادم.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const isProfit = summary.netProfitYer >= 0;

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Flame className="w-5 h-5 text-amber-600" />
            حساب الديزل والربح والخسارة
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            متابعة كميات وتكلفة الديزل والمصاريف التشغيلية ومقارنتها بالإيرادات لمعرفة صافي الربح أو الخسارة
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start lg:self-auto">
          <button
            type="button"
            onClick={() => setRevenueBasis('collected')}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              revenueBasis === 'collected'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            حسب النقد المحصّل
          </button>
          <button
            type="button"
            onClick={() => setRevenueBasis('billed')}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              revenueBasis === 'billed'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            حسب إجمالي الفواتير
          </button>
        </div>
      </div>

      {/* P&L KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="border border-slate-200 rounded-xl p-4 space-y-1.5">
          <span className="text-xs font-medium text-slate-500">
            {revenueBasis === 'collected'
              ? 'الإيرادات (النقد المحصّل)'
              : 'الإيرادات (الفواتير الصادرة)'}
          </span>
          <div className="text-xl font-bold text-teal-800 font-mono-nums">
            {formatCompactYer(summary.activeRevenueYer)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono-nums">
            {revenueBasis === 'collected'
              ? `إجمالي الفواتير: ${formatCompactYer(summary.totalBilledYer)}`
              : `النقد المحصّل: ${formatCompactYer(summary.collectedCashYer)}`}
          </div>
        </div>

        <div className="border border-slate-200 rounded-xl p-4 space-y-1.5">
          <span className="text-xs font-medium text-slate-500">
            تكلفة الديزل المسجلة
          </span>
          <div className="text-xl font-bold text-amber-800 font-mono-nums">
            {formatCompactYer(summary.dieselCostYer)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono-nums">
            {summary.totalLiters > 0
              ? `${summary.totalLiters.toLocaleString('en-US')} لتر · متوسط ${summary.avgCostPerLiter} ر.ي/لتر`
              : 'لم تُسجّل لترات ديزل بعد'}
          </div>
        </div>

        <div className="border border-slate-200 rounded-xl p-4 space-y-1.5">
          <span className="text-xs font-medium text-slate-500">
            مصاريف الصيانة والرواتب
          </span>
          <div className="text-xl font-bold text-slate-900 font-mono-nums">
            {formatCompactYer(summary.otherExpensesYer)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono-nums">
            {summary.dieselCostPerGenKwh > 0
              ? `تكلفة الديزل للكيلو المولّد: ${summary.dieselCostPerGenKwh} ر.ي`
              : `إجمالي المصاريف: ${formatCompactYer(summary.totalExpensesYer)}`}
          </div>
        </div>

        <div
          className={`border rounded-xl p-4 space-y-1.5 ${
            isProfit
              ? 'bg-emerald-50/70 border-emerald-200'
              : 'bg-rose-50/70 border-rose-200'
          }`}
        >
          <span className="text-xs font-bold flex items-center gap-1.5 text-slate-700">
            {isProfit ? (
              <TrendingUp className="w-4 h-4 text-emerald-700" />
            ) : (
              <TrendingDown className="w-4 h-4 text-rose-700" />
            )}
            {isProfit ? 'صافي ربح المحطة' : 'خسارة صافية'}
          </span>
          <div
            className={`text-xl font-extrabold font-mono-nums ${
              isProfit ? 'text-emerald-800' : 'text-rose-800'
            }`}
          >
            {isProfit ? '+' : '-'}
            {formatCompactYer(Math.abs(summary.netProfitYer))}
          </div>
          <div
            className={`text-[11px] font-bold font-mono-nums ${
              isProfit ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {isProfit ? 'ربح' : 'عجز'} بنسبة{' '}
            {Math.abs(summary.profitMarginPct).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Add Diesel / Expense Form */}
      <form
        onSubmit={handleAddExpense}
        className="border border-slate-200 bg-slate-50/70 rounded-xl p-4 space-y-4"
      >
        <div className="text-sm font-bold text-slate-900">
          إضافة فاتورة ديزل أو مصروف تشغيلي جديد
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              البند / الفئة
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              className="w-full min-h-[46px] px-3 py-2 text-sm font-bold border border-slate-300 rounded-lg bg-white"
            >
              <option value="diesel">ديزل / وقود</option>
              <option value="oil_maintenance">زيوت وصيانة</option>
              <option value="salaries">رواتب وأجور</option>
              <option value="other">مصاريف أخرى</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              التاريخ
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full min-h-[46px] px-3 py-2 text-sm font-bold font-mono-nums border border-slate-300 rounded-lg bg-white"
            />
          </div>

          {category === 'diesel' && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  الكمية (لتر)
                </label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={litersInput}
                  onChange={(e) =>
                    handleLitersOrPriceChange(
                      e.target.value,
                      pricePerLiterInput,
                    )
                  }
                  placeholder="مثال: 1000"
                  className="w-full min-h-[46px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  سعر اللتر (ر.ي)
                </label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={pricePerLiterInput}
                  onChange={(e) =>
                    handleLitersOrPriceChange(litersInput, e.target.value)
                  }
                  placeholder="مثال: 650"
                  className="w-full min-h-[46px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 rounded-lg bg-white"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              الإجمالي (ريال يمني)
            </label>
            <input
              type="number"
              min={1}
              required
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder="المبلغ بالريال"
              className="w-full min-h-[46px] px-3 py-2 text-base font-bold font-mono-nums border border-slate-300 rounded-lg bg-white"
            />
          </div>

          <div
            className={
              category === 'diesel' ? 'sm:col-span-2 lg:col-span-1' : 'sm:col-span-2 lg:col-span-2'
            }
          >
            <label className="block text-xs font-medium text-slate-700 mb-1">
              ملاحظة / البيان
            </label>
            <input
              type="text"
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="مثال: توريد صهريج ديزل المولد 1"
              className="w-full min-h-[46px] px-3 py-2 text-sm font-bold border border-slate-300 rounded-lg bg-white"
            />
          </div>
        </div>

        {errorMsg && (
          <p className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
            {errorMsg}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="min-h-[44px] px-5 py-2 text-xs font-bold bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white rounded-lg inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {submitting ? 'جاري التسجيل...' : 'تسجيل في دفتر المصاريف'}
          </button>
        </div>
      </form>

      {/* Expenses Ledger Table */}
      <div className="overflow-x-auto border border-slate-200 rounded-xl">
        <table className="w-full text-sm text-right">
          <thead className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
            <tr>
              <th className="py-3 px-4 font-medium">التاريخ</th>
              <th className="py-3 px-4 font-medium">البند</th>
              <th className="py-3 px-4 font-medium">الكمية / السعر</th>
              <th className="py-3 px-4 font-medium">المبلغ</th>
              <th className="py-3 px-4 font-medium">البيان</th>
              <th className="py-3 px-4 font-medium text-left">الحماية</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {expenses.map((exp) => (
              <tr key={exp.id} className="hover:bg-slate-50/70">
                <td className="py-3 px-4 font-mono-nums text-xs text-slate-600">
                  {exp.date}
                </td>
                <td className="py-3 px-4 font-bold text-slate-900">
                  {CATEGORY_LABELS[exp.category] || exp.category}
                </td>
                <td className="py-3 px-4 font-mono-nums text-xs text-slate-600">
                  {exp.liters
                    ? `${exp.liters} لتر${exp.pricePerLiterYer ? ` × ${exp.pricePerLiterYer} ر.ي` : ''}`
                    : '—'}
                </td>
                <td className="py-3 px-4 font-mono-nums font-bold text-rose-800">
                  {formatYer(exp.amountYer)}
                </td>
                <td className="py-3 px-4 text-xs text-slate-700">
                  {exp.note || '—'}
                </td>
                <td className="py-3 px-4 text-left">
                  <span
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500"
                    title="المسح مقتصر على الأدمن المطور فقط"
                  >
                    <Lock className="w-3.5 h-3.5 text-slate-400" />
                    محمي (المطور فقط)
                  </span>
                </td>
              </tr>
            ))}
            {expenses.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-xs text-slate-500">
                  لا توجد مصاريف ديزل أو تشغيل مسجلة حتى الآن. أضف أول فاتورة ديزل لحساب صافي الربح والخسارة تلقائياً.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
