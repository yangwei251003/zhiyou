import { ExternalLink, Inbox, LockKeyhole, MessageSquareText, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Field'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'

export function InboxPage() {
  const { workspace, dispatch } = useDemoStore()
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const [selectedId, setSelectedId] = useState(workspace.inbox[0]?.id ?? '')
  const selected = workspace.inbox.find((thread) => thread.id === selectedId)
  const [draft, setDraft] = useState(selected?.draft || selected?.suggestedReply || '')

  useEffect(() => {
    setDraft(selected?.draft || selected?.suggestedReply || '')
  }, [selected])

  if (realCareer.mode === 'personal') {
    return (
      <div className="page-stack">
        <PageHeader
          title="HR 收件箱"
          description="平台连接尚未开放；这里不会展示演示消息，也不会假装正在监测招聘平台。"
        />
        <section className="unavailable-feature" aria-labelledby="personal-inbox-title">
          <LockKeyhole aria-hidden="true" />
          <div>
            <StatusBadge tone="neutral">平台连接未开放</StatusBadge>
            <h2 id="personal-inbox-title">没有可验证的真实消息来源</h2>
            <p>
              未来即使接入招聘平台，AI 也只能准备待审草稿；收件人、附件和最终发送仍由你在平台确认。
            </p>
          </div>
        </section>
      </div>
    )
  }

  const saveDraft = () => {
    if (!selected) return
    dispatch({ type: 'saveReplyDraft', threadId: selected.id, draft })
    show('已保存为待手动发送。没有向招聘平台发送任何内容。')
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="HR 收件箱"
        description="查看消息、核对建议并保存草稿。发送始终在招聘平台由你亲自完成。"
      />

      <div className="inbox-layout">
        <aside className="thread-list" aria-labelledby="thread-list-title">
          <div className="section-heading">
            <div>
              <h2 id="thread-list-title">待处理消息</h2>
              <p>
                {workspace.inbox.filter((thread) => thread.state === 'needs_review').length}{' '}
                条需要确认
              </p>
            </div>
          </div>
          {workspace.inbox.map((thread) => (
            <button
              type="button"
              key={thread.id}
              data-selected={thread.id === selectedId}
              onClick={() => setSelectedId(thread.id)}
            >
              <span>{thread.company}</span>
              <strong>{thread.sender}</strong>
              <small>{thread.message}</small>
              <time>{thread.receivedAt}</time>
            </button>
          ))}
          {!workspace.inbox.length ? (
            <div className="empty-state compact">
              <Inbox aria-hidden="true" />
              <h3>暂无消息</h3>
              <p>这里不会主动启动平台监测。</p>
            </div>
          ) : null}
        </aside>

        <section className="message-panel" aria-labelledby="message-title">
          {selected ? (
            <>
              <header>
                <div>
                  <span>
                    {selected.company} · {selected.title}
                  </span>
                  <h2 id="message-title">{selected.sender}</h2>
                </div>
                <StatusBadge tone={selected.state === 'needs_review' ? 'warning' : 'info'}>
                  {selected.state === 'needs_review' ? '待确认' : '草稿已保存'}
                </StatusBadge>
              </header>
              <article className="incoming-message">
                <span>HR · {selected.receivedAt}</span>
                <p>{selected.message}</p>
              </article>
              <div className="suggestion-note">
                <MessageSquareText aria-hidden="true" size={18} />
                <div>
                  <strong>建议依据</strong>
                  <p>只使用了已核验的访谈经历；没有补造业务数据或公司认知。</p>
                </div>
              </div>
              <Field
                label="待手动发送的回复草稿"
                hint="保存后仍需前往招聘平台检查收件人、正文和附件。"
              >
                <textarea
                  rows={7}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </Field>
              <div className="message-actions">
                <Button onClick={saveDraft} disabled={!draft.trim()}>
                  <Save aria-hidden="true" size={18} />
                  保存为待手动发送
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    show('演示版没有连接招聘平台。请在连接器明确可用后再打开外部页面。', 'warning')
                  }
                >
                  <ExternalLink aria-hidden="true" size={18} />
                  打开招聘平台
                </Button>
              </div>
              <p className="safety-copy">BossHunter Next 不会把“保存草稿”描述成“已回复”。</p>
            </>
          ) : (
            <div className="empty-state">
              <Inbox aria-hidden="true" />
              <h2>选择一条消息</h2>
              <p>查看对话和建议来源。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
