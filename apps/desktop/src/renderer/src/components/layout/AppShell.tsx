import { CircleAlert, Menu, PanelLeftClose, PanelLeftOpen, ShieldCheck } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import type { PageKey } from '../../store/types'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Navigation } from './Navigation'

export function AppShell({
  activePage,
  onNavigate,
  workspaceName,
  workspaceKind,
  persistenceMode,
  children,
}: {
  activePage: PageKey
  onNavigate: (page: PageKey) => void
  workspaceName: string
  workspaceKind: 'personal' | 'demo'
  persistenceMode?: 'encrypted' | 'memory-only'
  children: ReactNode
}) {
  const isNarrow = useMediaQuery('(max-width: 900px)')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    const main = document.getElementById('main-content')
    if (main) {
      main.scrollTop = 0
      main.scrollLeft = 0
    }
    main?.focus()
  }, [activePage])

  const navigate = (page: PageKey) => {
    onNavigate(page)
    setMobileNavOpen(false)
  }
  const memoryOnly = workspaceKind === 'personal' && persistenceMode === 'memory-only'

  return (
    <div className="app-shell" data-sidebar-collapsed={collapsed}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      {!isNarrow ? (
        <aside className="sidebar" aria-label="应用侧栏">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              证
            </div>
            {collapsed ? null : (
              <div>
                <strong>BossHunter Next</strong>
                <span>职业证据台</span>
              </div>
            )}
          </div>
          <Navigation activePage={activePage} collapsed={collapsed} onNavigate={navigate} />
          <div className="sidebar-footer">
            {collapsed ? null : (
              <div className="locality-note">
                {memoryOnly ? (
                  <CircleAlert aria-hidden="true" size={17} />
                ) : (
                  <ShieldCheck aria-hidden="true" size={17} />
                )}
                <span>
                  {workspaceKind === 'personal'
                    ? memoryOnly
                      ? '临时内存工作区'
                      : '个人加密工作区'
                    : '本地演示工作区'}
                </span>
              </div>
            )}
            <Button
              variant="quiet"
              size="small"
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" size={18} />
              ) : (
                <>
                  <PanelLeftClose aria-hidden="true" size={18} />
                  <span>收起侧栏</span>
                </>
              )}
            </Button>
          </div>
        </aside>
      ) : null}

      <div className="workspace-frame">
        <header className="workspace-bar">
          {isNarrow ? (
            <Button
              variant="quiet"
              size="small"
              aria-label="打开导航"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu aria-hidden="true" size={20} />
            </Button>
          ) : null}
          <div className="workspace-bar__identity">
            <strong>{workspaceName}</strong>
            <span>
              {workspaceKind === 'personal'
                ? memoryOnly
                  ? '内容只保留在本次运行；退出应用后全部丢失'
                  : '内容来自本机职业库；AI 连接与额度以实时状态为准'
                : '内容来自本地演示数据，不代表真实连接状态'}
            </span>
          </div>
          <div className="workspace-mode" aria-label="当前模式">
            {workspaceKind === 'personal' ? (memoryOnly ? '临时内存' : '个人加密') : '演示'}
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>

      <Dialog
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        title="前往"
        description="选择工作区页面"
        variant="drawer"
      >
        <Navigation activePage={activePage} onNavigate={navigate} />
      </Dialog>
    </div>
  )
}
