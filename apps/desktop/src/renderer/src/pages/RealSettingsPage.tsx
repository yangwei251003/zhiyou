import {
  CircleAlert,
  DatabaseZap,
  Download,
  KeyRound,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CodexStatusSummary, RuntimeInfo } from '../../../shared/contracts'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useRealCareerStore } from '../store/RealCareerStore'

const codexAvailability: Record<
  CodexStatusSummary['availability'],
  { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }
> = {
  ready: { label: '已连接', tone: 'success' },
  auth_required: { label: '需要登录', tone: 'neutral' },
  rate_limited: { label: '额度受限', tone: 'warning' },
  offline: { label: '离线', tone: 'danger' },
}

function formatResetTime(value: string | null): string {
  if (!value) return '未提供'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatUsage(value: number | null, resetAt: string | null): string {
  if (value === null) return '未提供'
  return `已使用 ${Math.round(value)}%，${formatResetTime(resetAt)} 重置`
}

function formatAuthMode(value: CodexStatusSummary['authMode'] | undefined): string {
  if (value === 'chatgpt') return 'ChatGPT 账号'
  if (value === 'api_key') return 'API Key'
  return '未连接'
}

export function LockedVaultPage() {
  const { snapshot, busy, error, deleteVault } = useRealCareerStore()
  const { show } = useToast()
  const [deleteOpen, setDeleteOpen] = useState(false)

  const handleDelete = async () => {
    const result = await deleteVault()
    if (!result.ok) return
    setDeleteOpen(false)
    if (!result.value.deleted) {
      show('已取消永久删除，锁定的职业库保持不变。', 'warning')
      return
    }
    show(
      result.value.cleanupPending
        ? '密钥已删除，不可解密残片将在下次启动继续清理。'
        : '锁定的本机职业库已删除。',
      result.value.cleanupPending ? 'warning' : 'success',
    )
  }

  return (
    <main className="startup-state" aria-labelledby="locked-vault-title">
      <div className="brand-mark brand-mark--large" aria-hidden="true">
        锁
      </div>
      <h1 id="locked-vault-title">已有职业库已安全锁定</h1>
      <p role="status">
        {snapshot?.vaultAccess.message ??
          '系统安全加密当前不可用，BossHunter 未打开磁盘上的旧资料。'}
      </p>
      <div className="notice notice--danger">
        <CircleAlert aria-hidden="true" size={18} />
        <span>
          为避免空白内存库遮蔽旧资料，现在不能新建、修改或导出。请恢复 Windows 系统加密后重启应用。
        </span>
      </div>
      {error ? (
        <div className="notice notice--danger" role="alert">
          <CircleAlert aria-hidden="true" size={18} />
          <span>{error.message}</span>
        </div>
      ) : null}
      <Button
        variant="danger"
        disabled={busy === 'delete-vault'}
        onClick={() => setDeleteOpen(true)}
      >
        <Trash2 aria-hidden="true" size={17} />
        永久删除锁定职业库
      </Button>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="永久删除锁定职业库？"
        description="无需解密也可删除精确的 BossHunter 资料目录；下一步系统还会再次请你确认"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              保留锁定资料
            </Button>
            <Button
              variant="danger"
              disabled={busy === 'delete-vault'}
              onClick={() => void handleDelete()}
            >
              继续至系统确认
            </Button>
          </>
        }
      >
        <ul className="dialog-checklist">
          <li>删除后不能再恢复这个本机职业库。</li>
          <li>不会删除你先前导出的文件、系统备份或磁盘快照。</li>
          <li>当前无法解密，因此不能在删除前生成新的明文导出。</li>
        </ul>
      </Dialog>
    </main>
  )
}

export function RealSettingsPage() {
  const {
    snapshot,
    busy,
    codexStatus,
    codexRateLimits,
    refreshCodex,
    loginCodex,
    logoutCodex,
    exportVault,
    deleteVault,
  } = useRealCareerStore()
  const { show } = useToast()
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [runtimeFailed, setRuntimeFailed] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [lastExportPath, setLastExportPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const api = window.bossHunter
    if (!api) return
    const load = async () => {
      try {
        const value = await api.runtime.info()
        if (!cancelled) setRuntime(value)
      } catch {
        if (!cancelled) setRuntimeFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const permissionCounts = useMemo(() => {
    const facts = snapshot?.facts ?? []
    return {
      total: facts.length,
      ai: facts.filter((fact) => fact.aiAllowed).length,
      resume: facts.filter((fact) => fact.resumeAllowed).length,
      sensitive: facts.filter((fact) => fact.sensitivity !== 'standard').length,
    }
  }, [snapshot?.facts])

  const codexPresentation = codexStatus
    ? codexAvailability[codexStatus.availability]
    : { label: '正在检查', tone: 'neutral' as const }
  const codexBusy = busy === 'codex-status' || busy === 'codex-login' || busy === 'codex-logout'
  const memoryOnly = snapshot?.persistenceMode === 'memory-only'

  const handleRefresh = async () => {
    const result = await refreshCodex()
    if (result.ok) show('已刷新 Codex 连接状态。')
  }

  const handleLogin = async () => {
    const result = await loginCodex()
    if (!result.ok) return
    if (result.value.started) {
      show(
        result.value.message ||
          (result.value.openedBrowser
            ? '已打开登录流程。请在浏览器完成后返回刷新状态。'
            : '登录流程已启动，但未能自动打开浏览器。'),
        result.value.openedBrowser ? 'success' : 'warning',
      )
    } else {
      show(result.value.message || '登录流程未启动。', 'warning')
    }
  }

  const handleLogout = async () => {
    const result = await logoutCodex()
    if (!result.ok) return
    setLogoutOpen(false)
    show(result.value.message || '已退出 Codex 连接。')
  }

  const handleExport = async () => {
    const result = await exportVault()
    if (!result.ok) return
    setExportOpen(false)
    if (!result.value.exported) {
      show('已取消导出，未生成明文副本。', 'warning')
      return
    }
    setLastExportPath(result.value.directoryPath)
    show(`已导出 ${result.value.documentCount} 份资料的个人数据副本。`)
  }

  const handleDelete = async () => {
    const result = await deleteVault()
    if (!result.ok) return
    setDeleteOpen(false)
    if (!result.value.deleted) {
      show('已取消永久删除，个人工作区保持不变。', 'warning')
      return
    }
    show(
      result.value.cleanupPending
        ? '密钥已删除、数据不可恢复，但仍有不可解密残片等待下次启动清理。'
        : '本机个人工作区已删除。',
      result.value.cleanupPending ? 'warning' : 'success',
    )
  }

  return (
    <div className="page-stack settings-page">
      <PageHeader
        title="连接与隐私"
        description="连接状态必须可验证；资料按事实逐条授权，不会默认发给 AI。"
      />

      <section className="settings-section" aria-labelledby="personal-codex-settings-title">
        <div className="settings-section__heading">
          <div>
            <KeyRound aria-hidden="true" />
            <span>
              <h2 id="personal-codex-settings-title">Codex 连接</h2>
              <p>用于深访、岗位分析和简历建议，不获得投递或消息发送权限。</p>
            </span>
          </div>
          <StatusBadge tone={codexPresentation.tone}>{codexPresentation.label}</StatusBadge>
        </div>
        <dl className="definition-grid">
          <div>
            <dt>认证方式</dt>
            <dd>{formatAuthMode(codexStatus?.authMode)}</dd>
          </div>
          <div>
            <dt>账号方案</dt>
            <dd>{codexStatus?.planType ?? codexRateLimits?.planType ?? '未提供'}</dd>
          </div>
          <div>
            <dt>主额度</dt>
            <dd>
              {codexRateLimits?.available
                ? formatUsage(codexRateLimits.primaryUsedPercent, codexRateLimits.primaryResetsAt)
                : '不可用'}
            </dd>
          </div>
          <div>
            <dt>次额度</dt>
            <dd>
              {codexRateLimits?.available
                ? formatUsage(
                    codexRateLimits.secondaryUsedPercent,
                    codexRateLimits.secondaryResetsAt,
                  )
                : '不可用'}
            </dd>
          </div>
        </dl>
        {codexStatus ? (
          <div
            className={codexStatus.availability === 'offline' ? 'notice notice--danger' : 'notice'}
            role="status"
          >
            <ShieldCheck aria-hidden="true" size={18} />
            <span>
              {codexStatus.message}
              {codexStatus.retryAt ? ` 可重试时间：${formatResetTime(codexStatus.retryAt)}。` : ''}
            </span>
          </div>
        ) : null}
        <div className="settings-actions">
          {codexStatus?.availability === 'auth_required' ? (
            <Button disabled={codexBusy} onClick={() => void handleLogin()}>
              <KeyRound aria-hidden="true" size={17} />
              浏览器登录
            </Button>
          ) : null}
          <Button variant="secondary" disabled={codexBusy} onClick={() => void handleRefresh()}>
            <RefreshCw aria-hidden="true" size={17} />
            刷新状态
          </Button>
          {codexStatus?.authMode ? (
            <Button variant="quiet" disabled={codexBusy} onClick={() => setLogoutOpen(true)}>
              <LogOut aria-hidden="true" size={17} />
              退出连接
            </Button>
          ) : null}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="personal-permission-title">
        <div className="settings-section__heading">
          <div>
            <LockKeyhole aria-hidden="true" />
            <span>
              <h2 id="personal-permission-title">事实权限</h2>
              <p>此处是当前已核验事实的实际授权统计，权限需在职业证据台中逐条修改。</p>
            </span>
          </div>
        </div>
        <dl className="definition-grid">
          <div>
            <dt>已核验事实</dt>
            <dd>{permissionCounts.total} 条</dd>
          </div>
          <div>
            <dt>允许 AI 使用</dt>
            <dd>{permissionCounts.ai} 条</dd>
          </div>
          <div>
            <dt>允许写入简历</dt>
            <dd>{permissionCounts.resume} 条</dd>
          </div>
          <div>
            <dt>敏感事实</dt>
            <dd>{permissionCounts.sensitive} 条</dd>
          </div>
        </dl>
        <div className="notice">
          <ShieldCheck aria-hidden="true" size={18} />
          即使已连接 Codex，只有标记为“允许 AI 使用”且在当次操作中明确选中的事实才会发送。
        </div>
      </section>

      <section className="settings-section" aria-labelledby="personal-local-data-title">
        <div className="settings-section__heading">
          <div>
            <DatabaseZap aria-hidden="true" />
            <span>
              <h2 id="personal-local-data-title">
                {memoryOnly ? '临时内存工作区' : '个人加密工作区'}
              </h2>
              <p>
                {memoryOnly
                  ? '资料、事实、岗位和简历只保留在本次运行的内存中。'
                  : '资料、事实、岗位和简历版本由本机职业库管理。'}
              </p>
            </span>
          </div>
          <StatusBadge tone={snapshot?.persistenceMode === 'encrypted' ? 'success' : 'warning'}>
            {memoryOnly ? '仅本次运行 · 退出即丢失' : '系统加密'}
          </StatusBadge>
        </div>
        <dl className="definition-grid">
          <div>
            <dt>工作区</dt>
            <dd>{snapshot?.workspace?.name ?? '未命名'}</dd>
          </div>
          <div>
            <dt>应用版本</dt>
            <dd>{runtime?.appVersion ?? (runtimeFailed ? '读取失败' : '读取中')}</dd>
          </div>
          <div>
            <dt>个人资料</dt>
            <dd>{snapshot?.sources.length ?? 0} 份</dd>
          </div>
          <div>
            <dt>岗位 / 简历</dt>
            <dd>
              {snapshot?.jobs.length ?? 0} 个 / {snapshot?.resumeDrafts.length ?? 0} 份
            </dd>
          </div>
        </dl>
        {memoryOnly ? (
          <div className="notice notice--danger" role="status">
            <DatabaseZap aria-hidden="true" size={18} />
            当前没有持久化保存。退出应用后，这个工作区的全部内容会丢失；需要保留时请先导出全部个人数据。
          </div>
        ) : null}
        <div className="notice">
          <ShieldCheck aria-hidden="true" size={18} />
          Codex 认证信息由官方工具管理，不会写入个人职业库或随资料导出。
        </div>
        {lastExportPath ? (
          <div className="notice" role="status">
            <Download aria-hidden="true" size={18} />
            <span>最近导出位置：{lastExportPath}</span>
          </div>
        ) : null}
        <div className="settings-actions">
          <Button
            variant="secondary"
            disabled={busy === 'export-vault'}
            onClick={() => setExportOpen(true)}
          >
            <Download aria-hidden="true" size={17} />
            导出全部个人数据
          </Button>
          <Button
            variant="danger"
            disabled={busy === 'delete-vault'}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 aria-hidden="true" size={17} />
            永久删除个人工作区
          </Button>
        </div>
      </section>

      <Dialog
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        title="退出 Codex 连接？"
        description="退出后将无法继续深访、岗位分析或简历建议，本机职业库不受影响"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLogoutOpen(false)}>
              取消
            </Button>
            <Button disabled={busy === 'codex-logout'} onClick={() => void handleLogout()}>
              确认退出
            </Button>
          </>
        }
      >
        <p>不会删除已导入资料、已核验事实或简历版本。</p>
      </Dialog>

      <Dialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="导出全部个人数据？"
        description="导出目录中的副本是明文，不再受 BossHunter 本机加密保护"
        footer={
          <>
            <Button variant="secondary" onClick={() => setExportOpen(false)}>
              取消
            </Button>
            <Button disabled={busy === 'export-vault'} onClick={() => void handleExport()}>
              选择目录并导出
            </Button>
          </>
        }
      >
        <ul className="dialog-checklist">
          <li>导出包含已导入的原始资料、职业事实、岗位与简历版本。</li>
          <li>不包含 Codex 账号凭据、平台 Cookie 或系统密钥。</li>
          <li>请只保存在你信任的目录，并自行管理该明文副本。</li>
        </ul>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="永久删除个人工作区？"
        description="这会永久删除本机职业库；下一步系统还会再次请你确认"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              保留工作区
            </Button>
            <Button
              variant="danger"
              disabled={busy === 'delete-vault'}
              onClick={() => void handleDelete()}
            >
              继续至系统确认
            </Button>
          </>
        }
      >
        <div className="notice notice--danger">
          <Trash2 aria-hidden="true" size={18} />
          <span>
            将删除 {snapshot?.sources.length ?? 0} 份资料、{snapshot?.facts.length ?? 0} 条事实、
            {snapshot?.jobs.length ?? 0} 个岗位与 {snapshot?.resumeDrafts.length ?? 0}{' '}
            份简历版本。此操作无法撤销。
          </span>
        </div>
        <ul className="dialog-checklist">
          <li>删除只针对 BossHunter 当前本机职业库。</li>
          <li>不会删除你先前导出的明文副本、系统备份或快照。</li>
          <li>这不是对磁盘历史块的物理擦除。</li>
        </ul>
      </Dialog>
    </div>
  )
}
