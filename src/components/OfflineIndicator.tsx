import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWAInstall';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 safe-bottom flex items-center gap-2 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-bold text-white shadow-lg">
      <WifiOff className="w-4 h-4 shrink-0" />
      <span>وضع أوفلاين — يتم العمل على البيانات المحفوظة محلياً</span>
    </div>
  );
};
