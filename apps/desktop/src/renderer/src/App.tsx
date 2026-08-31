import { useEffect, useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import { RealOperationBanner } from './components/RealOperationBanner'
import { useDemoStore } from './store/DemoStore'
import { useRealCareerStore } from './store/RealCareerStore'
import type { PageKey } from './store/types'
import { HomePage } from './pages/HomePage'
import { InboxPage } from './pages/InboxPage'
import { InterviewPage } from './pages/InterviewPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { OpportunitiesPage } from './pages/OpportunitiesPage'
import { ProfilePage } from './pages/ProfilePage'
import { ProgressPage } from './pages/ProgressPage'
import { ResumeStudioPage } from './pages/ResumeStudioPage'
import { LockedVaultPage } from './pages/RealSettingsPage'
import { SettingsPage } from './pages/SettingsPage'

function CurrentPage({ page, navigate }: { page: PageKey; navigate: (page: PageKey) => void }) {
  switch (page) {
    case 'home':
      return <HomePage navigate={navigate} />
    case 'profile':
      return <ProfilePage />
    case 'interview':
      return <InterviewPage />
    case 'opportunities':
      return <OpportunitiesPage navigate={navigate} />
    case 'resume':
      return <ResumeStudioPage />
    case 'progress':
      return <ProgressPage />
    case 'inbox':
      return <InboxPage />
    case 'settings':
      return <SettingsPage />
  }
}

export default function App() {
  const { workspace: demoWorkspace, hydrated } = useDemoStore()
  const realCareer = useRealCareerStore()
  const { bridgeAvailable, chooseDemo, mode } = realCareer
  const [activePage, setActivePage] = useState<PageKey>('home')

  useEffect(() => {
    if (
      hydrated &&
      !bridgeAvailable &&
      mode === 'uninitialized' &&
      demoWorkspace.onboardingCompleted
    ) {
      chooseDemo()
    }
  }, [bridgeAvailable, chooseDemo, demoWorkspace.onboardingCompleted, hydrated, mode])

  if (!hydrated || realCareer.mode === 'checking') {
    return (
      <main className="startup-state" aria-labelledby="startup-title">
        <div className="brand-mark brand-mark--large" aria-hidden="true">
          证
        </div>
        <h1 id="startup-title">正在打开本地工作区</h1>
        <p role="status">正在检查个人职业库的实际保存模式与演示快照…</p>
      </main>
    )
  }

  if (realCareer.snapshot?.vaultAccess.status === 'locked') return <LockedVaultPage />

  const needsOnboarding =
    realCareer.mode === 'uninitialized' ||
    (realCareer.mode === 'personal' && realCareer.onboardingPending) ||
    (realCareer.mode === 'demo' && !demoWorkspace.onboardingCompleted)

  if (needsOnboarding) return <OnboardingPage />

  const personalWorkspace = realCareer.snapshot?.workspace
  const isPersonal = realCareer.mode === 'personal' && Boolean(personalWorkspace)

  return (
    <AppShell
      activePage={activePage}
      onNavigate={setActivePage}
      workspaceKind={isPersonal ? 'personal' : 'demo'}
      workspaceName={
        isPersonal ? (personalWorkspace?.name ?? '个人职业库') : demoWorkspace.workspaceName
      }
      {...(isPersonal && realCareer.snapshot
        ? { persistenceMode: realCareer.snapshot.persistenceMode }
        : {})}
    >
      <div className="page-host">
        {isPersonal ? <RealOperationBanner /> : null}
        <CurrentPage page={activePage} navigate={setActivePage} />
      </div>
    </AppShell>
  )
}
