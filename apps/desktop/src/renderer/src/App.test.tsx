import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, vi } from 'vitest'
import type { CareerSnapshot } from '../../shared/contracts'
import App from './App'
import { DemoStoreProvider } from './store/DemoStore'
import { ToastProvider } from './components/ui/Toast'
import { RealCareerStoreProvider } from './store/RealCareerStore'
import { desktopApi, emptyCareerSnapshot } from './test/setup'

const personalSnapshot = {
  ...emptyCareerSnapshot,
  workspace: {
    id: 'workspace-real',
    profileId: 'profile-real',
    name: '小林的职业库',
    displayName: '小林',
    targetRoles: ['产品经理'],
    locale: 'zh-CN' as const,
  },
  sources: [
    {
      id: 'document-1',
      name: '项目复盘.txt',
      kind: 'text',
      mimeType: 'text/plain',
      size: 120,
      status: 'imported',
      requiresOcr: false,
      importedAt: '2026-08-31T00:00:00.000Z',
      fragmentCount: 2,
      characterCount: 86,
    },
  ],
  proposals: [],
  facts: [],
  jobs: [],
  resumeDrafts: [],
}

beforeEach(() => {
  vi.mocked(desktopApi.career.snapshot).mockResolvedValue({
    ok: true,
    value: emptyCareerSnapshot,
  })
  vi.mocked(desktopApi.career.importEvidence).mockResolvedValue({
    ok: true,
    value: { items: [], snapshot: emptyCareerSnapshot },
  })
  vi.mocked(desktopApi.codex.status).mockResolvedValue({
    ok: true,
    value: {
      availability: 'offline',
      authMode: null,
      planType: null,
      message: '测试环境保持离线。',
      retryAt: null,
    },
  })
})

function renderApp() {
  return render(
    <DemoStoreProvider>
      <RealCareerStoreProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </RealCareerStoreProvider>
    </DemoStoreProvider>,
  )
}

describe('desktop app semantics', () => {
  it('offers a truthful first-run flow and enters a keyboard-navigable workspace', async () => {
    const user = userEvent.setup()
    renderApp()

    expect(
      await screen.findByRole('heading', { name: '先建立可信的职业事实，再开始写简历' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '跳过设置，直接查看演示' }))

    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content')
    expect(screen.getByRole('button', { name: '首页' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('内容来自本地演示数据，不代表真实连接状态')).toBeInTheDocument()
  })

  it('opens the resume studio and exposes source provenance', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByRole('heading', { name: '先建立可信的职业事实，再开始写简历' })
    await user.click(screen.getByRole('button', { name: '跳过设置，直接查看演示' }))
    await user.click(screen.getByRole('button', { name: '简历工作室' }))

    expect(screen.getByRole('heading', { name: '简历工作室' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '来源检查器' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('导出已受限')
  })

  it('creates and imports into a truthful personal workspace without implying AI upload', async () => {
    const user = userEvent.setup()
    vi.mocked(desktopApi.career.importEvidence).mockResolvedValue({
      ok: true,
      value: {
        items: [
          {
            name: '项目复盘.txt',
            status: 'imported',
            documentId: 'document-1',
            fragmentCount: 2,
            characterCount: 86,
            message: '已导入 2 个文本片段。',
          },
        ],
        snapshot: personalSnapshot,
      },
    })
    renderApp()

    await screen.findByRole('heading', { name: '先建立可信的职业事实，再开始写简历' })
    await user.type(screen.getByRole('textbox', { name: /怎么称呼你/ }), '小林')
    await user.type(screen.getByRole('textbox', { name: /当前目标岗位/ }), '产品经理')
    await user.click(screen.getByRole('button', { name: '创建个人加密工作区' }))
    expect(await screen.findByText('小林的个人加密工作区')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '选择资料' }))
    expect((await screen.findAllByText('项目复盘.txt')).length).toBeGreaterThan(0)
    expect(screen.getByText('资料已写入个人职业库，尚未发送给 AI。')).toBeInTheDocument()
  })

  it('requires explicit acknowledgement before creating a temporary memory workspace', async () => {
    const user = userEvent.setup()
    const memorySnapshot = { ...emptyCareerSnapshot, persistenceMode: 'memory-only' as const }
    const createdMemorySnapshot = {
      ...personalSnapshot,
      persistenceMode: 'memory-only' as const,
      sources: [],
    }
    vi.mocked(desktopApi.career.snapshot).mockResolvedValue({ ok: true, value: memorySnapshot })
    vi.mocked(desktopApi.career.initialize).mockResolvedValue({
      ok: true,
      value: createdMemorySnapshot,
    })
    renderApp()

    await screen.findByText(/当前系统加密不可用/)
    await user.type(screen.getByRole('textbox', { name: /怎么称呼你/ }), '小林')
    await user.type(screen.getByRole('textbox', { name: /当前目标岗位/ }), '产品经理')
    const createButton = screen.getByRole('button', { name: '创建临时内存工作区' })
    expect(createButton).toBeDisabled()
    expect(screen.queryByText('个人加密工作区', { exact: true })).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /我理解这是临时内存工作区/ }))
    expect(createButton).toBeEnabled()
    await user.click(createButton)

    expect(await screen.findByText('小林的临时内存工作区')).toBeInTheDocument()
    expect(screen.getByText('仅本次运行')).toBeInTheDocument()
    expect(screen.queryByText('个人加密工作区', { exact: true })).not.toBeInTheDocument()
  })

  it('shows a locked vault instead of a shadow workspace and offers deletion without export', async () => {
    const user = userEvent.setup()
    const lockedSnapshot: CareerSnapshot = {
      ...emptyCareerSnapshot,
      vaultAccess: {
        status: 'locked',
        message: '系统安全加密当前不可用，已有本机职业库已锁定且未被打开。',
      },
    }
    const deletedSnapshot: CareerSnapshot = {
      ...emptyCareerSnapshot,
      persistenceMode: 'memory-only',
    }
    vi.mocked(desktopApi.career.snapshot).mockResolvedValue({ ok: true, value: lockedSnapshot })
    vi.mocked(desktopApi.career.deleteVault).mockResolvedValue({
      ok: true,
      value: { deleted: true, cleanupPending: false, snapshot: deletedSnapshot },
    })
    renderApp()

    expect(await screen.findByRole('heading', { name: '已有职业库已安全锁定' })).toBeInTheDocument()
    expect(screen.getByText(/不能新建、修改或导出/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '导出全部个人数据' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '创建个人加密工作区' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '永久删除锁定职业库' }))
    expect(screen.getByRole('dialog', { name: '永久删除锁定职业库？' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '继续至系统确认' }))

    await waitFor(() => expect(desktopApi.career.deleteVault).toHaveBeenCalledTimes(1))
    expect(
      await screen.findByRole('heading', { name: '先建立可信的职业事实，再开始写简历' }),
    ).toBeInTheDocument()
  })

  it('shows real profile data and asks for document-scoped extraction consent', async () => {
    const user = userEvent.setup()
    vi.mocked(desktopApi.career.snapshot).mockResolvedValue({ ok: true, value: personalSnapshot })
    renderApp()

    expect(await screen.findByText('个人加密工作区')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '职业档案' }))
    expect(screen.getByText('项目复盘.txt')).toBeInTheDocument()
    expect(screen.getByText(/尚未发送给 AI/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '提取候选事实' }))
    expect(screen.getByRole('dialog', { name: '允许 AI 读取这份资料？' })).toBeInTheDocument()
    expect(screen.getByText('2 个文本片段')).toBeInTheDocument()
    expect(screen.getByText('86 个字符')).toBeInTheDocument()
  })

  it('revokes verified-fact AI and resume permissions through the real career bridge', async () => {
    const user = userEvent.setup()
    const fact = {
      id: 'fact-1',
      revisionId: 'revision-1',
      category: 'project',
      title: '访谈研究',
      claim: '组织 18 名学生完成访谈与可用性测试。',
      sourceCount: 1,
      sources: [],
      aiAllowed: true,
      resumeAllowed: true,
      sensitivity: 'standard' as const,
    }
    const factSnapshot: CareerSnapshot = { ...personalSnapshot, facts: [fact] }
    const revokedSnapshot: CareerSnapshot = {
      ...factSnapshot,
      facts: [{ ...fact, aiAllowed: false, resumeAllowed: false }],
    }
    vi.mocked(desktopApi.career.snapshot).mockResolvedValue({ ok: true, value: factSnapshot })
    vi.mocked(desktopApi.career.updateFactPermissions)
      .mockResolvedValueOnce({
        ok: true,
        value: { ...factSnapshot, facts: [{ ...fact, aiAllowed: false }] },
      })
      .mockResolvedValueOnce({ ok: true, value: revokedSnapshot })
    renderApp()

    await screen.findByText('个人加密工作区')
    await user.click(screen.getByRole('button', { name: '职业档案' }))
    const aiSwitch = screen.getByRole('switch', { name: '访谈研究：允许 AI 使用' })
    const resumeSwitch = screen.getByRole('switch', { name: '访谈研究：允许用于简历' })
    expect(aiSwitch).toBeChecked()
    expect(resumeSwitch).toBeChecked()

    await user.click(aiSwitch)
    await waitFor(() =>
      expect(desktopApi.career.updateFactPermissions).toHaveBeenNthCalledWith(1, {
        factId: 'fact-1',
        aiAllowed: false,
        resumeAllowed: true,
      }),
    )
    await user.click(resumeSwitch)
    await waitFor(() =>
      expect(desktopApi.career.updateFactPermissions).toHaveBeenNthCalledWith(2, {
        factId: 'fact-1',
        aiAllowed: false,
        resumeAllowed: false,
      }),
    )
    expect(screen.getByText('AI 禁用')).toBeInTheDocument()
    expect(screen.getByText('简历禁用')).toBeInTheDocument()
  })

  it('reviews Codex-tailored resume text against the original fact before export', async () => {
    const user = userEvent.setup()
    const resumeSnapshot: CareerSnapshot = {
      ...personalSnapshot,
      facts: [
        {
          id: 'fact-1',
          revisionId: 'revision-1',
          category: 'project',
          title: '访谈研究',
          claim: '组织 18 名学生完成访谈与可用性测试。',
          sourceCount: 1,
          sources: [
            {
              documentId: 'document-1',
              fragmentId: 'fragment-1',
              page: null,
              section: '研究过程',
              quote: '组织 18 名学生完成访谈与可用性测试。',
            },
          ],
          aiAllowed: true,
          resumeAllowed: true,
          sensitivity: 'standard',
        },
        {
          id: 'fact-local-only',
          revisionId: 'revision-local-only',
          category: 'project',
          title: '本机专用事实',
          claim: '完成一份仅允许在本机简历中使用的项目复盘。',
          sourceCount: 1,
          sources: [],
          aiAllowed: false,
          resumeAllowed: true,
          sensitivity: 'sensitive',
        },
      ],
      jobs: [
        {
          id: 'job-1',
          company: '北辰智造',
          title: '用户研究员',
          location: '上海',
          salary: null,
          source: 'manual',
          capturedAt: '2026-08-31T00:00:00.000Z',
          evidenceCoverage: 100,
          requirements: [],
          learningActions: [],
        },
      ],
      resumeDrafts: [
        {
          versionId: 'resume-1',
          jobId: 'job-1',
          name: '北辰智造定制版',
          exported: false,
          validationValid: false,
          blockingIssues: ['该表述偏离原事实文字，必须由你逐条确认真实后才能导出'],
          atsText: '小林\n组织 18 名学生完成访谈与可用性测试。',
          sections: [
            {
              id: 'section-1',
              kind: 'project',
              title: '项目经历',
              claims: [
                {
                  id: 'claim-1',
                  text: '围绕消费硬件场景，组织 18 名学生完成访谈与可用性测试。',
                  revisionId: 'revision-1',
                  originalText: '组织 18 名学生完成访谈与可用性测试。',
                  rationale: '保留原数字与行动，只补充岗位语境。',
                  reviewRequired: true,
                  reviewed: false,
                  reviewedAt: null,
                },
              ],
            },
          ],
        },
      ],
    }
    vi.mocked(desktopApi.career.snapshot).mockResolvedValue({ ok: true, value: resumeSnapshot })
    vi.mocked(desktopApi.codex.status).mockResolvedValue({
      ok: true,
      value: {
        availability: 'ready',
        authMode: 'chatgpt',
        planType: 'plus',
        message: 'Codex 可用。',
        retryAt: null,
      },
    })
    renderApp()

    await screen.findByText('个人加密工作区')
    await user.click(screen.getByRole('button', { name: '简历工作室' }))
    expect(screen.getByRole('button', { name: '仅用原事实生成' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '用 Codex 定制草稿' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /访谈研究/u }))
    await user.click(screen.getByRole('checkbox', { name: /本机专用事实/u }))
    expect(screen.getByRole('button', { name: '仅用原事实生成' })).toBeEnabled()
    expect(await screen.findByRole('button', { name: '用 Codex 定制草稿' })).toBeEnabled()
    expect(screen.getByText('原事实表述')).toBeInTheDocument()
    expect(screen.getByText('保留原数字与行动，只补充岗位语境。')).toBeInTheDocument()
    const sourceDraft = resumeSnapshot.resumeDrafts[0]!
    const reviewedDraft = {
      ...sourceDraft,
      validationValid: true,
      blockingIssues: [],
      sections: sourceDraft.sections.map((section) => ({
        ...section,
        claims: section.claims.map((claim) => ({
          ...claim,
          reviewed: true,
          reviewedAt: '2026-08-31T01:00:00.000Z',
        })),
      })),
    }
    const reviewedSnapshot = { ...resumeSnapshot, resumeDrafts: [reviewedDraft] }
    vi.mocked(desktopApi.career.approveResumeClaim).mockResolvedValue({
      ok: true,
      value: { confirmed: true, draft: reviewedDraft, snapshot: reviewedSnapshot },
    })
    await user.click(screen.getByRole('button', { name: '逐条确认此改写完全真实' }))
    await waitFor(() =>
      expect(desktopApi.career.approveResumeClaim).toHaveBeenCalledWith({
        versionId: 'resume-1',
        claimId: 'claim-1',
      }),
    )
    expect(await screen.findByText(/已逐条确认真实/u)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '用 Codex 定制草稿' }))
    expect(screen.getByRole('dialog', { name: '确认用 Codex 定制草稿' })).toBeInTheDocument()
    expect(screen.getByText('1 条同时允许 AI 与简历使用的事实')).toBeInTheDocument()
    expect(screen.getByText('1 条已选事实因未允许 AI 使用而排除')).toBeInTheDocument()
    expect(screen.getByText(/访谈研究：组织 18 名学生完成访谈与可用性测试/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '继续至系统确认' }))
    await waitFor(() =>
      expect(desktopApi.career.tailorResume).toHaveBeenCalledWith(
        expect.objectContaining({ factIds: ['fact-1'] }),
      ),
    )
  })
})
