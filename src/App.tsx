import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { LogIn, LogOut } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AdminLicensingPanel } from './components/AdminLicensingPanel';
import { ActivationGate } from './components/ActivationGate';
import { ManagerDashboard } from './components/ManagerDashboard';
import { CollectorApp } from './components/CollectorApp';
import { SubscriberPortal } from './components/SubscriberPortal';
import { FlutterCodeExplorer } from './components/FlutterCodeExplorer';
import {
  signInWithGooglePopup,
  signOutUser,
  subscribeToAuth,
  testFirestoreConnection,
} from './lib/firebase';
import {
  fetchIsolatedStationState,
  isSuperAdminUser,
  loadStationLocalState,
  resolveUserRoleBinding,
  saveStationLocalState,
  syncStationPendingToFirestore,
  type StationLocalState,
} from './lib/offlineDb';
import type { AppRoleTab, UserRoleBinding } from './types/station';

function StationWorkspace() {
  const [activeTab, setActiveTab] = useState<AppRoleTab>('activation');
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [roleBinding, setRoleBinding] = useState<UserRoleBinding | null>(null);
  const [stationState, setStationState] = useState<StationLocalState | null>(
    null,
  );
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const isSuperAdmin = isSuperAdminUser(user);

  const loadWorkspaceForBinding = useCallback(
    async (binding: UserRoleBinding, currentUser: User) => {
      setLoadingWorkspace(true);
      try {
        const loaded = await fetchIsolatedStationState({
          stationId: binding.stationId,
          role: binding.role,
          uid: currentUser.uid,
        });
        setStationState(loaded);
        setActiveTab(binding.role === 'collector' ? 'collector' : 'manager');
      } catch {
        const cached = loadStationLocalState(binding.stationId);
        if (cached) {
          setStationState(cached);
          setActiveTab(binding.role === 'collector' ? 'collector' : 'manager');
        }
      } finally {
        setLoadingWorkspace(false);
      }
    },
    [],
  );

  useEffect(() => {
    void testFirestoreConnection();
    const unsubscribe = subscribeToAuth(async (u) => {
      setUser(u);
      setAuthReady(true);

      if (!u) {
        setRoleBinding(null);
        setStationState(null);
        return;
      }

      if (isSuperAdminUser(u)) {
        setActiveTab('admin');
      }

      try {
        const binding = await resolveUserRoleBinding(u.uid);
        setRoleBinding(binding);
        if (binding) {
          await loadWorkspaceForBinding(binding, u);
        } else if (!isSuperAdminUser(u)) {
          setActiveTab('activation');
        }
      } catch {
        setRoleBinding(null);
      }
    });
    return () => unsubscribe();
  }, [loadWorkspaceForBinding]);

  const handleUpdateState = (next: StationLocalState) => {
    setStationState(next);
    saveStationLocalState(next);
  };

  const handleSyncNow = async () => {
    if (!user || !stationState || !roleBinding) return;
    setIsSyncing(true);
    setSyncNotice(null);
    try {
      const { updatedState, syncedCount } = await syncStationPendingToFirestore(
        stationState,
        user,
        roleBinding.role,
      );
      setStationState(updatedState);
      setSyncNotice(
        `تمت المزامنة السحابية لنسخة ${updatedState.station.stationName} (${syncedCount} سجل).`,
      );
      setTimeout(() => setSyncNotice(null), 4000);
    } catch (err) {
      setSyncNotice(
        err instanceof Error ? err.message : 'تعذر إتمام المزامنة السحابية',
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const handleActivated = async (binding: UserRoleBinding) => {
    setRoleBinding(binding);
    if (user) {
      await loadWorkspaceForBinding(binding, user);
    }
  };

  const navItems: Array<{ id: AppRoleTab; label: string }> = [
    ...(isSuperAdmin
      ? [{ id: 'admin' as const, label: 'لوحة الأدمن والتراخيص' }]
      : []),
    ...(!isSuperAdmin && !roleBinding
      ? [{ id: 'activation' as const, label: 'تفعيل النسخة' }]
      : []),
    ...(roleBinding?.role === 'manager' && stationState
      ? [
          { id: 'manager' as const, label: 'لوحة المدير' },
          { id: 'collector' as const, label: 'تطبيق المحصّل' },
        ]
      : []),
    ...(roleBinding?.role === 'collector' && stationState
      ? [{ id: 'collector' as const, label: 'تطبيق المحصّل' }]
      : []),
    { id: 'subscriber' as const, label: 'بوابة المشترك' },
    ...(isSuperAdmin || roleBinding?.role === 'manager'
      ? [{ id: 'flutter' as const, label: 'الكود والتحميل' }]
      : []),
  ];

  const activeCollector =
    roleBinding?.role === 'collector' && user && stationState
      ? stationState.collectors.find((c) => c.id === user.uid)
      : undefined;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar: 3-Zone Contract */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              if (isSuperAdmin) setActiveTab('admin');
              else if (roleBinding?.role === 'manager') setActiveTab('manager');
              else if (roleBinding?.role === 'collector')
                setActiveTab('collector');
              else setActiveTab('subscriber');
            }}
            className="text-base sm:text-lg font-bold text-slate-900 whitespace-nowrap shrink-0"
          >
            كهرباء اليمن التجارية
          </a>

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
            {user ? (
              <button
                type="button"
                onClick={() => void signOutUser()}
                className="px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                خروج ({user.displayName?.split(' ')[0] || 'الحساب'})
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await signInWithGooglePopup();
                }}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" />
                دخول السحابة
              </button>
            )}
          </div>
        </div>

        {/* Mobile Role Bar */}
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
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {syncNotice && (
          <div className="mb-6 px-4 py-3 text-xs font-medium bg-teal-50 border border-teal-200 text-teal-900 rounded-lg">
            {syncNotice}
          </div>
        )}

        {!authReady || loadingWorkspace ? (
          <div className="py-20 text-center text-sm text-slate-500">
            جاري التحقق من الترخيص وبيانات المحطة المعزولة...
          </div>
        ) : activeTab === 'subscriber' ? (
          <SubscriberPortal state={stationState} />
        ) : activeTab === 'admin' && isSuperAdmin ? (
          <AdminLicensingPanel />
        ) : activeTab === 'flutter' &&
          (isSuperAdmin || roleBinding?.role === 'manager') ? (
          <FlutterCodeExplorer />
        ) : !user || !roleBinding || !stationState ? (
          <ActivationGate
            user={user}
            onSignIn={async () => {
              await signInWithGooglePopup();
            }}
            onActivated={handleActivated}
            onOpenSubscriberPortal={() => setActiveTab('subscriber')}
          />
        ) : activeTab === 'manager' && roleBinding.role === 'manager' ? (
          <ManagerDashboard
            state={stationState}
            onUpdateState={handleUpdateState}
            onSyncNow={handleSyncNow}
            isSyncing={isSyncing}
          />
        ) : activeTab === 'collector' ? (
          <CollectorApp
            state={stationState}
            onUpdateState={handleUpdateState}
            onSyncNow={handleSyncNow}
            isSyncing={isSyncing}
            isSignedIn={Boolean(user)}
            activeCollector={activeCollector}
            isManagerPreview={roleBinding.role === 'manager'}
          />
        ) : (
          <ActivationGate
            user={user}
            onSignIn={async () => {
              await signInWithGooglePopup();
            }}
            onActivated={handleActivated}
            onOpenSubscriberPortal={() => setActiveTab('subscriber')}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <span>
            نظام إدارة محطات الكهرباء التجارية في اليمن · العملة: الريال اليمني (YER)
          </span>
          <span>نسخ محطات مستقلة ومعزولة بالتراخيص</span>
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
