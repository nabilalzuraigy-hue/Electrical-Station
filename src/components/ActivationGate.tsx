import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import {
  loginUnified,
  type UnifiedLoginResult,
} from '../lib/offlineDb';

interface ActivationGateProps {
  onAuthenticated: (result: UnifiedLoginResult) => void;
}

export const ActivationGate: React.FC<ActivationGateProps> = ({
  onAuthenticated,
}) => {
  const [credential, setCredential] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!credential.trim()) {
      setError('يرجى إدخال بيانات الدخول.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await loginUnified(credential);
      onAuthenticated(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'بيانات الدخول غير صحيحة.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[60vh] flex items-center justify-center py-8">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-sm p-7 sm:p-9 space-y-6">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 text-center">
          محطات الكهرباء التجارية
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            dir="auto"
            autoComplete="off"
            spellCheck={false}
            value={credential}
            onChange={(e) => {
              setCredential(e.target.value);
              if (error) setError(null);
            }}
            aria-label="محطات الكهرباء التجارية"
            className="w-full min-h-[48px] px-4 py-2.5 text-base text-center border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600"
          />

          {error && (
            <div className="flex items-start gap-2 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg p-3">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-[48px] py-3 px-4 bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white text-base font-bold rounded-xl transition-colors cursor-pointer"
          >
            {submitting ? 'جاري التحقق...' : 'دخول'}
          </button>
        </form>
      </div>
    </div>
  );
};
