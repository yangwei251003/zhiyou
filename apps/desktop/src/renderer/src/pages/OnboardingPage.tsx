import {
  Check,
  CircleAlert,
  Database,
  FilePlus2,
  LockKeyhole,
  Sparkles,
  UploadCloud,
} from 'lucide-react'
import { useState } from 'react'
import type { InitializeCareerInput } from '../../../shared/contracts'
import { Button } from '../components/ui/Button'
import { Field, FieldGroup } from '../components/ui/Field'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useToast } from '../components/ui/Toast'
import { useDemoStore } from '../store/DemoStore'
import { useRealCareerStore } from '../store/RealCareerStore'

const steps = ['导入资料', '核验事实', '确认边界']

export function OnboardingPage() {
  const { workspace: demoWorkspace, dispatch } = useDemoStore()
  const realCareer = useRealCareerStore()
  const { show } = useToast()
  const [step, setStep] = useState(0)
  const [displayName, setDisplayName] = useState('')
  const [targetRole, setTargetRole] = useState('')
  const [location, setLocation] = useState('')
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)
  const [memoryOnlyAcknowledged, setMemoryOnlyAcknowledged] = useState(false)

  const personalWorkspace = realCareer.snapshot?.workspace
  const personalMode = realCareer.mode === 'personal' && Boolean(personalWorkspace)
  const memoryOnly = realCareer.snapshot?.persistenceMode === 'memory-only'
  const workspaceLabel = memoryOnly ? '临时内存工作区' : '个人加密工作区'

  const createPersonalWorkspace = async () => {
    const trimmedName = displayName.trim()
    const trimmedRole = targetRole.trim()
    if (!trimmedName || !trimmedRole) {
      show('请先填写称呼和目标岗位。', 'warning')
      return
    }
    const input: InitializeCareerInput = {
      displayName: trimmedName,
      targetRole: trimmedRole,
      ...(location.trim() ? { location: location.trim() } : {}),
    }
    const result = await realCareer.initialize(input)
    if (result.ok) {
      show(
        result.value.persistenceMode === 'memory-only'
          ? '临时内存工作区已创建。资料只保留在本次运行，退出后全部丢失。'
          : '个人加密工作区已创建。接下来导入的资料将进入本机职业库。',
        result.value.persistenceMode === 'memory-only' ? 'warning' : 'success',
      )
    }
  }

  const selectFiles = async () => {
    if (!personalMode) {
      show(`请先创建${workspaceLabel}；演示模式不会冒充真实导入。`, 'warning')
      return
    }
    const result = await realCareer.importEvidence()
    if (!result.ok) return
    const imported = result.value.items.filter((item) => item.status === 'imported').length
    const needsOcr = result.value.items.filter((item) => item.status === 'needs_ocr').length
    const rejected = result.value.items.filter((item) => item.status === 'rejected').length
    if (!result.value.items.length) {
      show('没有选择资料，个人职业库没有变化。', 'warning')
      return
    }
    show(`导入 ${imported} 份，待 OCR ${needsOcr} 份，拒绝 ${rejected} 份。`)
  }

  const finish = () => {
    if (personalMode) {
      realCareer.completePersonalOnboarding()
      return
    }
    realCareer.chooseDemo()
    dispatch({ type: 'completeOnboarding' })
  }

  const skipToDemo = () => {
    realCareer.chooseDemo()
    dispatch({ type: 'completeOnboarding' })
  }

  return (
    <main className="onboarding-shell">
      <section className="onboarding-intro" aria-labelledby="onboarding-title">
        <div className="brand-mark brand-mark--large" aria-hidden="true">
          证
        </div>
        <p className="product-name">BossHunter Next · 职业证据台</p>
        <h1 id="onboarding-title">先建立可信的职业事实，再开始写简历</h1>
        <p className="lead">
          资料和对话只会产生“待核验事实”。只有你确认过的内容，才能进入岗位简历。
        </p>
        <ul className="principle-list">
          <li>
            <Check aria-hidden="true" size={18} />
            每条表述都能回到来源
          </li>
          <li>
            <Check aria-hidden="true" size={18} />
            AI 不猜数字、不补造技能
          </li>
          <li>
            <Check aria-hidden="true" size={18} />
            敏感偏好默认不进入公开简历
          </li>
        </ul>
      </section>

      <section className="onboarding-work" aria-labelledby="onboarding-step-title">
        <ol className="stepper" aria-label="首次设置进度">
          {steps.map((label, index) => (
            <li
              key={label}
              aria-current={index === step ? 'step' : undefined}
              data-complete={index < step}
            >
              <span>{index < step ? <Check aria-hidden="true" size={15} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {realCareer.error ? (
          <div className="operation-banner operation-banner--error" role="alert">
            <CircleAlert aria-hidden="true" size={18} />
            <div>
              <strong>{realCareer.error.code}</strong>
              <span>{realCareer.error.message}</span>
            </div>
            <Button variant="quiet" size="small" onClick={realCareer.clearError}>
              知道了
            </Button>
          </div>
        ) : null}

        {step === 0 ? (
          <div className="onboarding-step">
            <UploadCloud aria-hidden="true" size={28} />
            <h2 id="onboarding-step-title">从建立个人库开始</h2>
            <p>
              {memoryOnly
                ? '当前系统加密不可用。资料只保留在本次运行的内存中，退出应用后会全部丢失。'
                : '个人库使用本机加密存储。上传只做本地导入，不会自动发给 AI 或招聘平台。'}
            </p>

            {!personalMode ? (
              <div className="personal-setup-form">
                <Field label="怎么称呼你" required>
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    autoComplete="name"
                    placeholder="例如：林知夏"
                  />
                </Field>
                <Field label="当前目标岗位" required hint="之后可以为不同岗位创建独立分析。">
                  <input
                    value={targetRole}
                    onChange={(event) => setTargetRole(event.target.value)}
                    placeholder="例如：用户研究员"
                  />
                </Field>
                <Field label="期望城市" hint="选填，不会写入公开简历。">
                  <input
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="例如：上海"
                  />
                </Field>
                {memoryOnly ? (
                  <FieldGroup legend="临时保存确认">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={memoryOnlyAcknowledged}
                        onChange={(event) => setMemoryOnlyAcknowledged(event.target.checked)}
                      />
                      <span>
                        <strong>我理解这是临时内存工作区</strong>
                        <small>退出应用后，已导入资料、事实、岗位和简历都会全部丢失。</small>
                      </span>
                    </label>
                  </FieldGroup>
                ) : null}
                <Button
                  onClick={() => void createPersonalWorkspace()}
                  disabled={
                    !realCareer.bridgeAvailable ||
                    !displayName.trim() ||
                    !targetRole.trim() ||
                    (memoryOnly && !memoryOnlyAcknowledged) ||
                    realCareer.busy === 'initialize'
                  }
                >
                  <Database aria-hidden="true" size={18} />
                  {realCareer.busy === 'initialize' ? '正在创建…' : `创建${workspaceLabel}`}
                </Button>
                {!realCareer.bridgeAvailable ? (
                  <div className="notice">
                    当前构建未加载真实职业库服务。你仍可使用下方的演示流程，界面不会伪装创建成功。
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="personal-workspace-created" role="status">
                <Database aria-hidden="true" size={20} />
                <div>
                  <strong>
                    {personalWorkspace?.displayName}的{workspaceLabel}
                  </strong>
                  <span>目标：{personalWorkspace?.targetRoles.join('、') || '待补充'}</span>
                </div>
                <StatusBadge tone={memoryOnly ? 'warning' : 'success'}>
                  {memoryOnly ? '仅本次运行' : '已创建'}
                </StatusBadge>
              </div>
            )}

            <Button
              variant={personalMode ? 'primary' : 'secondary'}
              onClick={() => void selectFiles()}
              disabled={realCareer.busy === 'import'}
            >
              <FilePlus2 aria-hidden="true" size={18} />
              {realCareer.busy === 'import' ? '正在导入…' : '选择资料'}
            </Button>

            <div className="source-summary" aria-label="已加入的资料">
              <strong>
                {personalMode ? realCareer.snapshot?.sources.length : demoWorkspace.sources.length}{' '}
                份资料
              </strong>
              <span>
                {personalMode
                  ? realCareer.snapshot?.sources.map((source) => source.name).join('、') ||
                    '尚未导入'
                  : `${demoWorkspace.sources.map((source) => source.name).join('、')}（演示预览）`}
              </span>
            </div>

            {realCareer.importReport.length ? (
              <div className="import-result-stack" role="status">
                <ul className="import-report" aria-label="最近导入结果">
                  {realCareer.importReport.map((item) => (
                    <li key={`${item.name}-${item.documentId ?? item.message}`}>
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {memoryOnly && item.status === 'imported'
                            ? '已载入本次运行的内存；退出应用后会丢失。'
                            : item.message}
                        </small>
                      </span>
                      <StatusBadge
                        tone={
                          item.status === 'imported'
                            ? 'success'
                            : item.status === 'needs_ocr'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {item.status === 'imported'
                          ? '已导入'
                          : item.status === 'needs_ocr'
                            ? '需要 OCR'
                            : '已拒绝'}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
                <div className={memoryOnly ? 'notice notice--danger' : 'notice'}>
                  {memoryOnly
                    ? '资料只保留在本次运行的临时内存工作区，尚未发送给 AI；退出后会丢失。'
                    : '资料已写入个人职业库，尚未发送给 AI。'}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="onboarding-step">
            <Sparkles aria-hidden="true" size={28} />
            <h2 id="onboarding-step-title">先核验三条候选事实</h2>
            <p>“模型信心”不等于真实。确认前，它们不会进入可导出的简历。</p>
            <div className="onboarding-facts">
              {personalMode
                ? realCareer.snapshot?.proposals.slice(0, 3).map((proposal) => (
                    <div key={proposal.id}>
                      <div>
                        <strong>{proposal.claim}</strong>
                        <span>模型信心 {Math.round(proposal.confidence * 100)}%</span>
                      </div>
                      <StatusBadge tone="warning">待到职业档案核验</StatusBadge>
                    </div>
                  ))
                : demoWorkspace.facts.slice(0, 3).map((fact) => (
                    <div key={fact.id}>
                      <div>
                        <strong>{fact.statement}</strong>
                        <span>模型信心 {Math.round(fact.confidence * 100)}%</span>
                      </div>
                      <div className="inline-actions">
                        <StatusBadge tone={fact.status === 'verified' ? 'success' : 'warning'}>
                          {fact.status === 'verified' ? '已核验' : '待核验'}
                        </StatusBadge>
                        {fact.status !== 'verified' ? (
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() =>
                              dispatch({
                                type: 'setFactStatus',
                                factId: fact.id,
                                status: 'verified',
                              })
                            }
                          >
                            确认为真实
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
              {personalMode && !realCareer.snapshot?.proposals.length ? (
                <div className="empty-state compact">
                  <strong>还没有待核验事实</strong>
                  <span>进入工作区后，可在明确同意后从资料提取。</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="onboarding-step">
            <LockKeyhole aria-hidden="true" size={28} />
            <h2 id="onboarding-step-title">确认 AI 与隐私边界</h2>
            <p>
              {personalMode
                ? '个人库与 AI 授权互相独立。每次提取、深访和简历生成都会重新展示数据范围。'
                : '当前是本地演示。连接真实 AI 前，系统会再次展示要发送的资料范围。'}
            </p>
            {personalMode ? (
              <FieldGroup legend="进入前确认">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={privacyAcknowledged}
                    onChange={(event) => setPrivacyAcknowledged(event.target.checked)}
                  />
                  <span>
                    <strong>我理解上传、AI 访问和简历可用是三种独立授权</strong>
                    <small>接受候选事实时还可单独关闭 AI 使用或简历使用。</small>
                  </span>
                </label>
              </FieldGroup>
            ) : (
              <FieldGroup legend="允许 AI 使用的内容">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={demoWorkspace.privacy.allowAiForVerifiedFacts}
                    onChange={(event) =>
                      dispatch({
                        type: 'setPrivacy',
                        key: 'allowAiForVerifiedFacts',
                        value: event.target.checked,
                      })
                    }
                  />
                  <span>
                    <strong>已核验的职业事实</strong>
                    <small>用于岗位分析和简历建议</small>
                  </span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={demoWorkspace.privacy.allowAiForPrivateFacts}
                    onChange={(event) =>
                      dispatch({
                        type: 'setPrivacy',
                        key: 'allowAiForPrivateFacts',
                        value: event.target.checked,
                      })
                    }
                  />
                  <span>
                    <strong>标记为私密的偏好</strong>
                    <small>默认关闭，不建议用于简历生成</small>
                  </span>
                </label>
              </FieldGroup>
            )}
            <div className="notice">
              {personalMode
                ? memoryOnly
                  ? '这是临时内存工作区，退出即丢失；创建工作区不代表已登录 Codex。'
                  : '创建个人库不代表已登录 Codex，也不会自动消耗模型额度。'
                : '完成本步骤只进入演示工作区，不代表已登录 Codex，也不会消耗任何模型额度。'}
            </div>
          </div>
        ) : null}

        <footer className="onboarding-actions">
          <Button
            variant="quiet"
            disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            上一步
          </Button>
          {step < steps.length - 1 ? (
            <Button onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))}>
              继续
            </Button>
          ) : (
            <Button onClick={finish} disabled={personalMode && !privacyAcknowledged}>
              {personalMode ? `进入${workspaceLabel}` : '进入职业证据台'}
            </Button>
          )}
        </footer>
        <button
          className="demo-skip"
          type="button"
          onClick={skipToDemo}
          disabled={Boolean(realCareer.busy)}
        >
          跳过设置，直接查看演示
        </button>
      </section>
    </main>
  )
}
