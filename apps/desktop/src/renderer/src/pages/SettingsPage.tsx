import {
  DatabaseZap,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RuntimeInfo } from '../../../shared/contracts'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { FieldGroup } from '../components/ui/Field'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'
import { RealSettingsPage } from './RealSettingsPage'

export function SettingsPage() {
  const { mode } = useRealCareerStore()
  return mode === 'personal' ? <RealSettingsPage /> : <DemoSettingsPage />
}

function DemoSettingsPage() {
  const { workspace, dispatch } = useDemoStore()
  const { show } = useToast()
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)

  useEffect(() => {
    const api = window.bossHunter
    if (!api) return
    void api.runtime.info().then(setRuntime)
  }, [])

  const openDocs = async () => {
    const opened = await window.bossHunter?.external.open(
      'https://openai.com/index/unlocking-the-codex-harness/',
    )
    if (!opened) show('该链接不在应用外链白名单内。', 'warning')
  }

  const enableDemoCodex = () => {
    dispatch({ type: 'setCodexDemo' })
    setConnectOpen(false)
    show('已启用本地 Codex 交互演示；这不代表真实账号登录或额度可用。')
  }

  const resetDemo = async () => {
    await window.bossHunter?.demo.clear()
    dispatch({ type: 'reset' })
    setResetOpen(false)
    show('演示数据已重置。')
  }

  return (
    <div className="page-stack settings-page">
      <PageHeader
        title="连接与隐私"
        description="连接状态必须可验证；未连接、限额或失败都不会伪装成在线。"
      />

      <section className="settings-section" aria-labelledby="codex-settings-title">
        <div className="settings-section__heading">
          <div>
            <KeyRound aria-hidden="true" />
            <span>
              <h2 id="codex-settings-title">Codex 连接</h2>
              <p>用于深访、岗位分析和简历建议，不拥有任何外部执行权限。</p>
            </span>
          </div>
          <StatusBadge tone={workspace.codexMode === 'demo_only' ? 'info' : 'neutral'}>
            {workspace.codexMode === 'demo_only' ? '仅本地演示' : '未连接'}
          </StatusBadge>
        </div>
        <dl className="definition-grid">
          <div>
            <dt>真实账号</dt>
            <dd>未登录</dd>
          </div>
          <div>
            <dt>额度状态</dt>
            <dd>不可用</dd>
          </div>
          <div>
            <dt>工具权限</dt>
            <dd>未授予</dd>
          </div>
          <div>
            <dt>数据范围</dt>
            <dd>仅用户明确选择的事实</dd>
          </div>
        </dl>
        <div className="settings-actions">
          <Button onClick={() => setConnectOpen(true)}>查看连接说明</Button>
          <Button variant="quiet" onClick={() => void openDocs()}>
            <ExternalLink aria-hidden="true" size={17} />
            官方说明
          </Button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="privacy-settings-title">
        <div className="settings-section__heading">
          <div>
            <LockKeyhole aria-hidden="true" />
            <span>
              <h2 id="privacy-settings-title">AI 数据范围</h2>
              <p>每种资料按用途授权，不使用模糊的“一键同意”。</p>
            </span>
          </div>
        </div>
        <FieldGroup legend="允许发送给已连接 AI 的内容">
          <label className="switch-row">
            <span>
              <strong>已核验职业事实</strong>
              <small>用于岗位分析、深访和简历建议</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={workspace.privacy.allowAiForVerifiedFacts}
              onChange={(event) =>
                dispatch({
                  type: 'setPrivacy',
                  key: 'allowAiForVerifiedFacts',
                  value: event.target.checked,
                })
              }
            />
          </label>
          <label className="switch-row">
            <span>
              <strong>私密偏好与限制</strong>
              <small>默认关闭；不会写入公开简历</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={workspace.privacy.allowAiForPrivateFacts}
              onChange={(event) =>
                dispatch({
                  type: 'setPrivacy',
                  key: 'allowAiForPrivateFacts',
                  value: event.target.checked,
                })
              }
            />
          </label>
          <label className="switch-row">
            <span>
              <strong>匿名诊断信息</strong>
              <small>默认关闭；不包含简历、HR 消息或认证信息</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={workspace.privacy.diagnosticsEnabled}
              onChange={(event) =>
                dispatch({
                  type: 'setPrivacy',
                  key: 'diagnosticsEnabled',
                  value: event.target.checked,
                })
              }
            />
          </label>
        </FieldGroup>
      </section>

      <section className="settings-section" aria-labelledby="local-data-title">
        <div className="settings-section__heading">
          <div>
            <DatabaseZap aria-hidden="true" />
            <span>
              <h2 id="local-data-title">本地数据</h2>
              <p>演示快照只在系统加密能力可用时持久化。</p>
            </span>
          </div>
          {runtime ? (
            <StatusBadge tone={runtime.encryptionAvailable ? 'success' : 'warning'}>
              {runtime.encryptionAvailable ? '系统加密可用' : '仅内存模式'}
            </StatusBadge>
          ) : (
            <StatusBadge tone="neutral">正在检查</StatusBadge>
          )}
        </div>
        <dl className="definition-grid">
          <div>
            <dt>应用版本</dt>
            <dd>{runtime?.appVersion ?? '读取中'}</dd>
          </div>
          <div>
            <dt>运行平台</dt>
            <dd>{runtime?.platform ?? '读取中'}</dd>
          </div>
          <div>
            <dt>持久化</dt>
            <dd>
              {runtime?.persistenceMode === 'encrypted' ? '系统加密快照' : '不持久化敏感演示数据'}
            </dd>
          </div>
          <div>
            <dt>遥测</dt>
            <dd>{workspace.privacy.diagnosticsEnabled ? '用户已开启' : '关闭'}</dd>
          </div>
        </dl>
        <div className="notice">
          <ShieldCheck aria-hidden="true" size={18} />
          平台 Cookie、Codex 凭据和浏览器资料目录永远不进入此工作区或备份。
        </div>
        <Button variant="danger" onClick={() => setResetOpen(true)}>
          <RotateCcw aria-hidden="true" size={17} />
          重置演示数据
        </Button>
      </section>

      <Dialog
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        title="连接 Codex 前必须知道"
        description="当前按钮只启用界面演示，不会启动 OAuth 或读取本机认证文件"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConnectOpen(false)}>
              取消
            </Button>
            <Button onClick={enableDemoCodex}>启用本地交互演示</Button>
          </>
        }
      >
        <ul className="dialog-checklist">
          <li>真实版本只使用官方浏览器或设备授权。</li>
          <li>登录代表连接 AI 能力，不是注册 BossHunter 账号。</li>
          <li>连接后仍逐次展示将发送的资料范围。</li>
          <li>AI 不获得投递、发送简历或回复 HR 的权限。</li>
        </ul>
      </Dialog>

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="重置演示数据？"
        description="这会清除本地演示快照并重新显示首次引导，无法撤销"
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetOpen(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void resetDemo()}>
              确认重置
            </Button>
          </>
        }
      >
        <p>真实版本的删除流程还会提供导出、派生事实处理方式和可验证的删除回执。</p>
      </Dialog>
    </div>
  )
}
