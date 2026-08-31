import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import type { DesktopApi, InitializeCareerInput } from '../../../shared/contracts'

export const emptyCareerSnapshot = {
  persistenceMode: 'encrypted' as const,
  vaultAccess: { status: 'ready' as const, message: null },
  workspace: null,
  sources: [],
  proposals: [],
  facts: [],
  jobs: [],
  resumeDrafts: [],
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

export const desktopApi: DesktopApi = {
  runtime: {
    info: vi.fn().mockResolvedValue({
      appVersion: '0.1.0-test',
      platform: 'win32',
      encryptionAvailable: true,
      persistenceMode: 'encrypted',
    }),
  },
  files: {
    selectEvidence: vi.fn().mockResolvedValue([]),
  },
  external: {
    open: vi.fn().mockResolvedValue(true),
  },
  demo: {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue({ saved: true, savedAt: '2026-08-31T00:00:00.000Z' }),
    clear: vi.fn().mockResolvedValue(undefined),
  },
  career: {
    snapshot: vi.fn().mockResolvedValue({ ok: true, value: emptyCareerSnapshot }),
    initialize: vi.fn().mockImplementation((input: InitializeCareerInput) =>
      Promise.resolve({
        ok: true,
        value: {
          ...emptyCareerSnapshot,
          workspace: {
            id: 'workspace-test',
            profileId: 'profile-test',
            name: `${input.displayName}的职业库`,
            displayName: input.displayName,
            targetRoles: [input.targetRole],
            locale: 'zh-CN' as const,
          },
        },
      }),
    ),
    importEvidence: vi.fn().mockResolvedValue({
      ok: true,
      value: { items: [], snapshot: emptyCareerSnapshot },
    }),
    extractFacts: vi.fn().mockResolvedValue({ ok: true, value: emptyCareerSnapshot }),
    acceptProposal: vi.fn().mockResolvedValue({ ok: true, value: emptyCareerSnapshot }),
    updateFactPermissions: vi.fn().mockResolvedValue({ ok: true, value: emptyCareerSnapshot }),
    interview: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        question: '请继续描述你亲自完成的部分。',
        rationale: '补全行动证据',
        proposalIds: [],
        snapshot: emptyCareerSnapshot,
      },
    }),
    analyzeJob: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'TEST_NOT_CONFIGURED', message: '测试未配置岗位返回值。', retryable: false },
    }),
    buildResume: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'TEST_NOT_CONFIGURED', message: '测试未配置简历返回值。', retryable: false },
    }),
    tailorResume: vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'TEST_NOT_CONFIGURED',
        message: '测试未配置定制简历返回值。',
        retryable: false,
      },
    }),
    approveResumeClaim: vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'TEST_NOT_CONFIGURED',
        message: '测试未配置简历事实确认返回值。',
        retryable: false,
      },
    }),
    exportResume: vi.fn().mockResolvedValue({
      ok: true,
      value: { saved: false, filePath: null, filename: 'resume.txt' },
    }),
    deleteVault: vi.fn().mockResolvedValue({
      ok: true,
      value: { deleted: false, cleanupPending: false, snapshot: emptyCareerSnapshot },
    }),
    exportVault: vi.fn().mockResolvedValue({
      ok: true,
      value: { exported: false, directoryPath: null, documentCount: 0 },
    }),
  },
  codex: {
    status: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        availability: 'offline',
        authMode: null,
        planType: null,
        message: '测试环境保持离线。',
        retryAt: null,
      },
    }),
    login: vi.fn().mockResolvedValue({
      ok: true,
      value: { started: false, openedBrowser: false, message: '测试环境不启动登录。' },
    }),
    rateLimits: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        available: false,
        planType: null,
        primaryUsedPercent: null,
        primaryResetsAt: null,
        secondaryUsedPercent: null,
        secondaryResetsAt: null,
      },
    }),
    logout: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        availability: 'auth_required',
        authMode: null,
        planType: null,
        message: '已退出。',
        retryAt: null,
      },
    }),
  },
}

Object.defineProperty(window, 'bossHunter', {
  configurable: true,
  value: desktopApi,
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
