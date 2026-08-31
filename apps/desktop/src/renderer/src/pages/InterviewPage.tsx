import { ArrowRight, Bot, CheckCircle2, UserRound } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Field'
import { useToast } from '../components/ui/Toast'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'
import { RealInterviewPage } from './RealInterviewPage'

const prompts = [
  '当时真正要解决的问题是什么？',
  '你本人具体做了什么，而不是团队整体做了什么？',
  '最大的限制或取舍是什么？',
  '如果不能量化，能否描述范围、复杂度、速度或责任边界？',
]

export function InterviewPage() {
  const { workspace, dispatch } = useDemoStore()
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const [promptIndex, setPromptIndex] = useState(0)
  const [answer, setAnswer] = useState('')

  if (realCareer.mode === 'personal') return <RealInterviewPage />

  const submit = () => {
    if (!answer.trim()) return
    dispatch({ type: 'addInterviewProposal', answer })
    setAnswer('')
    setPromptIndex((value) => Math.min(prompts.length - 1, value + 1))
    show('已生成一条待核验事实，不会自动写入简历。')
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="AI 深访"
        description="用具体故事认识自己的经历。对话只产生候选事实，不替代你的确认。"
      />

      <div className="interview-layout">
        <section className="interview-thread" aria-labelledby="interview-thread-title">
          <div className="section-heading">
            <div>
              <h2 id="interview-thread-title">校园二手交易项目</h2>
              <p>围绕一段经历逐步追问。</p>
            </div>
          </div>
          <ol className="conversation" aria-label="深访对话">
            <li data-speaker="ai">
              <span>
                <Bot aria-hidden="true" />
              </span>
              <div>
                <strong>职业访谈助手</strong>
                <p>先不要总结能力。请回到当时：你们为什么要做这个项目？</p>
              </div>
            </li>
            <li data-speaker="user">
              <span>
                <UserRound aria-hidden="true" />
              </span>
              <div>
                <strong>你</strong>
                <p>校内二手群信息很零散，我们想降低学生发布和筛选商品的成本。</p>
              </div>
            </li>
            <li data-speaker="ai">
              <span>
                <Bot aria-hidden="true" />
              </span>
              <div>
                <strong>职业访谈助手</strong>
                <p>{prompts[promptIndex]}</p>
              </div>
            </li>
            {workspace.interviewNotes.map((note, index) => (
              <li data-speaker="user" key={`${note}-${index}`}>
                <span>
                  <UserRound aria-hidden="true" />
                </span>
                <div>
                  <strong>你</strong>
                  <p>{note}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="interview-composer">
            <Field label="你的回答" hint="只写你能确认的事实；不知道的数字可以留空。">
              <textarea
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                rows={5}
                placeholder="例如：我负责招募受访者、主持访谈，并把观察整理成三类问题……"
              />
            </Field>
            <Button onClick={submit} disabled={!answer.trim()}>
              生成待核验事实 <ArrowRight aria-hidden="true" size={18} />
            </Button>
          </div>
        </section>

        <aside className="interview-notes" aria-labelledby="interview-notes-title">
          <div className="section-heading">
            <div>
              <h2 id="interview-notes-title">本轮已发现</h2>
              <p>仍需逐条核验。</p>
            </div>
          </div>
          <ul>
            {workspace.facts
              .filter((fact) => fact.status === 'proposed')
              .map((fact) => (
                <li key={fact.id}>
                  <CheckCircle2 aria-hidden="true" size={18} />
                  <div>
                    <strong>{fact.statement}</strong>
                    <span>{fact.detail}</span>
                  </div>
                </li>
              ))}
          </ul>
          <div className="notice">深访不是心理咨询或职业诊断；它只帮助你把经历说具体。</div>
        </aside>
      </div>
    </div>
  )
}
