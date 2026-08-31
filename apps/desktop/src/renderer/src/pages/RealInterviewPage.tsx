import { Bot, CheckCircle2, RefreshCw, Send, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { InterviewMessageInput } from '../../../shared/contracts'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { Field, FieldGroup } from '../components/ui/Field'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useRealCareerStore } from '../store/RealCareerStore'

const availabilityCopy = {
  ready: { label: '可用', tone: 'success' as const },
  auth_required: { label: '需要登录', tone: 'warning' as const },
  rate_limited: { label: '额度受限', tone: 'warning' as const },
  offline: { label: '离线', tone: 'neutral' as const },
}

export function RealInterviewPage() {
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const snapshot = realCareer.snapshot
  const availableFacts = useMemo(
    () => snapshot?.facts.filter((fact) => fact.aiAllowed) ?? [],
    [snapshot?.facts],
  )
  const [messages, setMessages] = useState<InterviewMessageInput[]>([])
  const [answer, setAnswer] = useState('')
  const [selectedFactIds, setSelectedFactIds] = useState<string[]>([])
  const [consentOpen, setConsentOpen] = useState(false)
  const [lastRationale, setLastRationale] = useState<string | null>(null)

  const codex = realCareer.codexStatus
  const codexReady = codex?.availability === 'ready'
  const outboundMessages = answer.trim()
    ? [...messages, { role: 'user' as const, content: answer.trim() }]
    : messages

  const toggleFact = (factId: string) => {
    setSelectedFactIds((current) =>
      current.includes(factId)
        ? current.filter((candidate) => candidate !== factId)
        : [...current, factId],
    )
  }

  const send = async () => {
    if (!answer.trim() || !codexReady) return
    const sent = outboundMessages
    const result = await realCareer.interview({ messages: sent, factIds: selectedFactIds })
    if (!result.ok) return
    setMessages([...sent, { role: 'assistant', content: result.value.question }])
    setLastRationale(result.value.rationale)
    setAnswer('')
    setConsentOpen(false)
    show(
      result.value.proposalIds.length
        ? `AI 返回追问，并新增 ${result.value.proposalIds.length} 条待核验候选。`
        : 'AI 已返回下一条追问；没有自动新增已核验事实。',
    )
  }

  if (!snapshot?.workspace) return null

  return (
    <div className="page-stack">
      <PageHeader
        title="AI 深访"
        description="每次发送前都列出消息与事实范围；回答只会生成追问或待核验候选。"
        actions={
          <Button
            variant="secondary"
            onClick={() => void realCareer.refreshCodex()}
            disabled={realCareer.busy === 'codex-status'}
          >
            <RefreshCw aria-hidden="true" size={17} />
            刷新连接
          </Button>
        }
      />

      <div className="connection-strip" role="status">
        <span>
          <strong>Codex</strong>
          {codex?.message ?? '正在读取真实连接状态…'}
        </span>
        {codex ? (
          <StatusBadge tone={availabilityCopy[codex.availability].tone}>
            {availabilityCopy[codex.availability].label}
          </StatusBadge>
        ) : (
          <StatusBadge tone="neutral">检查中</StatusBadge>
        )}
      </div>

      <div className="interview-layout real-interview-layout">
        <section className="interview-thread" aria-labelledby="real-interview-thread-title">
          <div className="section-heading">
            <div>
              <h2 id="real-interview-thread-title">围绕真实经历追问</h2>
              <p>本机保留当前对话；发送时会把下面列出的消息交给 Codex。</p>
            </div>
          </div>
          <ol className="conversation" aria-label="个人深访对话" aria-live="polite">
            <li data-speaker="ai">
              <span>
                <Bot aria-hidden="true" />
              </span>
              <div>
                <strong>职业访谈助手</strong>
                <p>选一段经历，从“当时要解决什么问题”开始。不要猜测数字。</p>
              </div>
            </li>
            {messages.map((message, index) => (
              <li
                data-speaker={message.role === 'user' ? 'user' : 'ai'}
                key={`${message.role}-${index}`}
              >
                <span>
                  {message.role === 'user' ? (
                    <UserRound aria-hidden="true" />
                  ) : (
                    <Bot aria-hidden="true" />
                  )}
                </span>
                <div>
                  <strong>{message.role === 'user' ? '你' : '职业访谈助手'}</strong>
                  <p>{message.content}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="interview-composer">
            <Field label="你的回答" hint="提交前还会显示完整发送范围；未知数字可以留空。">
              <textarea
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                rows={5}
                maxLength={12_000}
                placeholder="例如：我负责招募受访者、主持访谈，并把观察整理成三类问题……"
              />
            </Field>
            <Button
              onClick={() => setConsentOpen(true)}
              disabled={!answer.trim() || !codexReady || realCareer.busy === 'interview'}
            >
              <Send aria-hidden="true" size={17} />
              核对并发送 {outboundMessages.length} 条消息、{selectedFactIds.length} 条事实
            </Button>
            {!codexReady ? (
              <p className="safety-copy">Codex 未处于可用状态，当前回答仍留在本机且不会发送。</p>
            ) : null}
          </div>
        </section>

        <aside className="interview-notes" aria-labelledby="interview-evidence-title">
          <div className="section-heading">
            <div>
              <h2 id="interview-evidence-title">本次可引用事实</h2>
              <p>这里只列出你已允许 AI 使用的核验事实。</p>
            </div>
          </div>
          <FieldGroup legend="选择随下一次消息发送的事实">
            <div className="fact-permission-list">
              {availableFacts.map((fact) => (
                <label className="check-row" key={fact.id}>
                  <input
                    type="checkbox"
                    checked={selectedFactIds.includes(fact.id)}
                    onChange={() => toggleFact(fact.id)}
                  />
                  <span>
                    <strong>{fact.title}</strong>
                    <small>{fact.claim}</small>
                  </span>
                </label>
              ))}
              {!availableFacts.length ? (
                <div className="empty-state compact">
                  <CheckCircle2 aria-hidden="true" />
                  <h3>没有 AI 可用事实</h3>
                  <p>可先在职业档案中核验事实并单独授权。</p>
                </div>
              ) : null}
            </div>
          </FieldGroup>
          {lastRationale ? (
            <div className="notice">
              <strong>本轮追问依据：</strong> {lastRationale}
            </div>
          ) : null}
          <div className="notice">深访不是心理咨询或职业诊断，也不会替你确认事实。</div>
        </aside>
      </div>

      <Dialog
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        title="确认发送给 Codex"
        description="这是本次独立授权；关闭对话框不会发送。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConsentOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void send()} disabled={realCareer.busy === 'interview'}>
              {realCareer.busy === 'interview' ? '正在等待 Codex…' : '确认本次发送'}
            </Button>
          </>
        }
      >
        <div className="consent-summary">
          <strong>将发送的内容</strong>
          <ul>
            <li>{outboundMessages.length} 条对话消息（含当前回答）</li>
            <li>{selectedFactIds.length} 条已核验且允许 AI 使用的事实</li>
            <li>不发送未选择事实、原始资料文件或招聘平台数据</li>
          </ul>
          <details>
            <summary>查看本次消息正文</summary>
            <ol className="consent-message-list">
              {outboundMessages.map((message, index) => (
                <li key={`${message.role}-${index}`}>
                  <strong>{message.role === 'user' ? '你' : 'AI'}：</strong> {message.content}
                </li>
              ))}
            </ol>
          </details>
        </div>
      </Dialog>
    </div>
  )
}
