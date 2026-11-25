import { useState } from 'react';
import { LogOut, Zap } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AdminLicensingPanel } from './components/AdminLicensingPanel';
import { ActivationGate } from './components/ActivationGate';
import { ManagerDashboard } from './components/ManagerDashboard';
import { CollectorApp } from './components/CollectorApp';
import { SubscriberPortal } from './components/SubscriberPortal';
import { FlutterCodeExplorer } from './components/FlutterCodeExplorer';
import {
  saveStationLocalState,
  syncStationPendingBatches,
  type StationLocalState,
  type UnifiedLoginResult,
} from './lib/offlineDb';
import type {
  AccessCodeRecord,
  AppRoleTab,
  SubscriberLookupResult,
  SyncProgress,
} from './types/station';

function StationWorkspace() {
  const [activeTab, setActiveTab] = useState<AppRoleTab>('activation');
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [staffToken, setStaffToken] = useState<string | null>(null);
  const [accessRecord, setAccessRecord] = useState<AccessCodeRecord | null>(
    null,
  );
  const [stationState, setStationState] = useState<StationLocalState | null>(
    null,
  );
  const [subscriberResult, setSubscriberResult] =
    useState<SubscriberLookupResult | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const isLoggedIn = Boolean(
    adminToken || (staffToken && accessRecord) || subscriberResult,
  );

  const handleUpdateState = (next: StationLocalState) => {
    setStationState(next);
    void saveStationLocalState(next);
  };

  const handleSyncNow = async () => {
    if (!staffToken || !stationState || !accessRecord) return;
    setIsSyncing(true);
    setSyncNotice(null);
    setSyncProgress(null);
    try {
      const { updatedState, syncedCount } = await syncStationPendingBatches({
        state: stationState,
        staffToken,
        role: accessRecord.role,
        onProgress: (p) => setSyncProgress(p),
      });
      setStationState(updatedState);
      setSyncNotice(
        `تمت المزامنة الآمنة لنسخة ${updatedState.station.stationName} (${syncedCount} سجل).`,
      );
      setTimeout(() => setSyncNotice(null), 4000);
    } catch (err) {
      setSyncNotice(
        err instanceof Error ? err.message : 'تعذر إتمام المزامنة السحابية',
      );
    } finally {
      setIsSyncing(false);
      setSyncProgress(null);
    }
  };

  const handleUnifiedAuth = (result: UnifiedLoginResult) => {
    if (result.kind === 'admin') {
      setAdminToken(result.token);
      setActiveTab('admin');
      return;
    }
    if (result.kind === 'staff') {
      setStaffToken(result.token);
      setAccessRecord(result.access);
      setStationState(result.state);
      setActiveTab(result.access.role === 'collector' ? 'collector' : 'manager');
      return;
    }
    setSubscriberResult(result.result);
    setActiveTab('subscriber');
  };

  const handleLogout = () => {
    setAdminToken(null);
    setStaffToken(null);
    setAccessRecord(null);
    setStationState(null);
    setSubscriberResult(null);
    setActiveTab('activation');
  };

  const navItems: Array<{ id: AppRoleTab; label: string }> = isLoggedIn
    ? [
        ...(adminToken ? [{ id: 'admin' as const, label: 'لوحة الإدارة' }] : []),
        ...(accessRecord?.role === 'manager' && stationState
          ? [{ id: 'manager' as const, label: 'لوحة المدير' }]
          : []),
        ...(accessRecord?.role === 'collector' && stationState
          ? [{ id: 'collector' as const, label: 'تطبيق المحصّل' }]
          : []),
        ...(subscriberResult
          ? [{ id: 'subscriber' as const, label: 'تفاصيل الفاتورة' }]
          : []),
        ...(adminToken
          ? [{ id: 'flutter' as const, label: 'الكود والتحميل' }]
          : []),
      ]
    : [];

  const activeCollector =
    accessRecord?.role === 'collector' && stationState
      ? stationState.collectors.find((c) => c.id === accessRecord.code)
      : undefined;

  if (!isLoggedIn) {
    return <ActivationGate onAuthenticated={handleUnifiedAuth} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              if (adminToken) setActiveTab('admin');
              else if (accessRecord?.role === 'manager') setActiveTab('manager');
              else if (accessRecord?.role === 'collector')
                setActiveTab('collector');
              else if (subscriberResult) setActiveTab('subscriber');
              else setActiveTab('activation');
            }}
            className="inline-flex items-center gap-2.5 text-lg sm:text-xl font-extrabold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            <span className="w-8 h-8 rounded-lg bg-teal-700 text-white inline-flex items-center justify-center shrink-0">
              <Zap className="w-4 h-4" />
            </span>
            <span>نظام إدارة الكهرباء التجارية</span>
          </a>

          {isLoggedIn && (
            <>
              <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
                {navItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    className={`py-1 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                      activeTab === item.id
                        ? 'text-teal-700 font-semibold border-b-2 border-teal-700'
                        : 'hover:text-slate-900'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>

              <div className="shrink-0">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  خروج
                </button>
              </div>
            </>
          )}
        </div>

        {/* Mobile Role Bar (only shown after login) */}
        {isLoggedIn && navItems.length > 1 && (
          <div className="md:hidden border-t border-slate-100 px-3 py-2 flex items-center gap-1 overflow-x-auto">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`px-3 py-2 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === item.id
                    ? 'bg-teal-700 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {syncNotice && (
          <div className="mb-6 px-4 py-3 text-xs font-medium bg-teal-50 border border-teal-200 text-teal-900 rounded-lg">
            {syncNotice}
          </div>
        )}

        {activeTab === 'subscriber' ? (
          <SubscriberPortal
            state={stationState}
            initialResult={subscriberResult}
          />
        ) : activeTab === 'admin' && adminToken ? (
          <AdminLicensingPanel
            adminToken={adminToken}
            onAdminAuthenticated={(tok) => setAdminToken(tok)}
            onLogoutAdmin={handleLogout}
          />
        ) : activeTab === 'flutter' && adminToken ? (
          <FlutterCodeExplorer />
        ) : activeTab === 'manager' &&
          accessRecord?.role === 'manager' &&
          stationState &&
          staffToken ? (
          <ManagerDashboard
            state={stationState}
            staffToken={staffToken}
            onUpdateState={handleUpdateState}
            onSyncNow={handleSyncNow}
            isSyncing={isSyncing}
            syncProgress={syncProgress}
          />
        ) : activeTab === 'collector' &&
          accessRecord?.role === 'collector' &&
          stationState &&
          staffToken ? (
          <CollectorApp
            state={stationState}
            staffToken={staffToken}
            onUpdateState={handleUpdateState}
            onSyncNow={handleSyncNow}
            isSyncing={isSyncing}
            syncProgress={syncProgress}
            activeCollector={activeCollector}
          />
        ) : (
          <ActivationGate onAuthenticated={handleUnifiedAuth} />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 text-center text-xs font-medium text-slate-600">
          نظام اتمتة موحدة للكهرباء
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <StationWorkspace />
    </ErrorBoundary>
  );
}
