import { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, Zap } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AdminLicensingPanel } from './components/AdminLicensingPanel';
import { ActivationGate } from './components/ActivationGate';
import { ManagerDashboard } from './components/ManagerDashboard';
import { CollectorApp } from './components/CollectorApp';
import { SubscriberPortal } from './components/SubscriberPortal';
import { FlutterCodeExplorer } from './components/FlutterCodeExplorer';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { OfflineIndicator } from './components/OfflineIndicator';
import {
  auth,
  getFirebaseAdminIdToken,
  isAuthorizedAdminUser,
  signOutUser,
  subscribeToAuth,
  testFirestoreConnection,
} from './lib/firebase';
import { CLOUD_ADMIN_TOKEN, isCloudAdminToken } from './lib/cloudAdminStore';
import {
  loadAdminStoreFromFirestore,
  saveAdminStoreToFirestore,
} from './lib/firestoreBackup';
import {
  fetchCloudAutoBackup,
  restoreCloudAutoBackup,
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
  const [authInitialized, setAuthInitialized] = useState(false);
  const autoSyncLockRef = useRef(false);

  const runSilentGlobalCloudSync = useCallback(async () => {
    if (autoSyncLockRef.current) return;
    if (isCloudAdminToken(adminToken)) return;
    const currentUser = auth.currentUser;
    if (!isAuthorizedAdminUser(currentUser)) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    autoSyncLockRef.current = true;
    try {
      const firebaseIdToken = await getFirebaseAdminIdToken(currentUser);
      if (!firebaseIdToken && !adminToken) return;

      const serverSnapshot = await fetchCloudAutoBackup({
        adminToken,
        firebaseIdToken,
      });

      if (!serverSnapshot.hasData) {
        const cloudSnap = await loadAdminStoreFromFirestore();
        if (
          cloudSnap &&
          (cloudSnap.stationCount > 0 || cloudSnap.codeCount > 0)
        ) {
          await restoreCloudAutoBackup({
            adminToken,
            firebaseIdToken,
            backup: cloudSnap.backup,
            mode: 'merge',
          });
        }
      } else {
        await saveAdminStoreToFirestore(serverSnapshot);
      }
    } catch {
      // Non-blocking automatic sync
    } finally {
      autoSyncLockRef.current = false;
    }
  }, [adminToken]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const unsub = subscribeToAuth((user) => {
      setAuthInitialized(true);
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (isAuthorizedAdminUser(user)) {
        setAdminToken((prev) => prev || CLOUD_ADMIN_TOKEN);
        setActiveTab((prev) => (prev === 'activation' ? 'admin' : prev));
        void runSilentGlobalCloudSync();
        intervalId = setInterval(() => {
          void runSilentGlobalCloudSync();
        }, 45000);
      } else {
        setAdminToken((prev) => (isCloudAdminToken(prev) ? null : prev));
      }
    });
    return () => {
      unsub();
      if (intervalId) clearInterval(intervalId);
    };
  }, [runSilentGlobalCloudSync]);

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
      void runSilentGlobalCloudSync();
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
    if (isCloudAdminToken(adminToken)) {
      void signOutUser();
    }
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
      ? stationState.collectors.find(
          (c) => c.id === accessRecord.code || c.code === accessRecord.code,
        )
      : undefined;

  if (!isLoggedIn && !authInitialized) {
    return (
      <div
        dir="rtl"
        className="min-h-[100dvh] w-full bg-gradient-to-br from-[#041224] via-[#062738] to-[#053328] flex flex-col items-center justify-center px-4 text-white"
      >
        <div className="bg-white/10 backdrop-blur-md border border-emerald-400/25 rounded-2xl px-6 py-5 text-center space-y-2 shadow-xl">
          <div className="w-10 h-10 mx-auto rounded-xl bg-emerald-400/20 text-emerald-300 inline-flex items-center justify-center">
            <Zap className="w-5 h-5 animate-pulse" />
          </div>
          <p className="text-sm font-bold text-white">
            جاري استعادة جلسة الدخول...
          </p>
        </div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <>
        <ActivationGate onAuthenticated={handleUnifiedAuth} />
        <OfflineIndicator />
      </>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 safe-top bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 min-h-16 py-2 flex items-center justify-between gap-2 sm:gap-6">
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
            className="inline-flex items-center gap-2 sm:gap-2.5 text-sm sm:text-xl font-extrabold tracking-tight text-slate-900 min-w-0"
          >
            <span className="w-8 h-8 rounded-lg bg-teal-700 text-white inline-flex items-center justify-center shrink-0">
              <Zap className="w-4 h-4" />
            </span>
            <span className="truncate">نظام إدارة الكهرباء التجارية</span>
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

              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                <PWAInstallPrompt variant="header" />
                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-3 sm:px-4 py-2 text-xs font-bold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
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

      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 py-5 sm:py-8 space-y-5">
        <PWAInstallPrompt variant="banner" />
        {syncNotice && (
          <div className="px-4 py-3 text-xs font-medium bg-teal-50 border border-teal-200 text-teal-900 rounded-lg">
            {syncNotice}
          </div>
        )}

        {activeTab === 'subscriber' && subscriberResult ? (
          <SubscriberPortal
            state={stationState}
            initialResult={subscriberResult}
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
            collectorAccess={accessRecord}
          />
        ) : adminToken ? (
          <AdminLicensingPanel
            adminToken={adminToken}
            onAdminAuthenticated={(tok) => {
              setAdminToken(tok);
              setActiveTab('admin');
            }}
            onLogoutAdmin={handleLogout}
          />
        ) : (
          <ActivationGate onAuthenticated={handleUnifiedAuth} />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white safe-bottom">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 text-center text-xs font-medium text-slate-600">
          نظام اتمتة موحدة للكهرباء
        </div>
      </footer>
      <OfflineIndicator />
    </div>
  );
}

export default function App() {
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);

  useEffect(() => {
    void testFirestoreConnection();
    const onQuota = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  return (
    <ErrorBoundary>
      {mapsQuotaExceeded && (
        <div
          dir="ltr"
          className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm"
        >
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}
      <StationWorkspace />
    </ErrorBoundary>
  );
}
