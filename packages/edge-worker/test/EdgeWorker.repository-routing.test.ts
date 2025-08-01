import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EdgeWorker } from '../src/EdgeWorker.js'
import type { EdgeWorkerConfig, RepositoryConfig } from '../src/types.js'
import { LinearClient } from '@linear/sdk'
import { ClaudeRunner } from 'cyrus-claude-runner'
import { NdjsonClient } from 'cyrus-ndjson-client'
import { SharedApplicationServer } from '../src/SharedApplicationServer.js'
import { AgentSessionManager } from '../src/AgentSessionManager.js'
import type { LinearAgentSessionCreatedWebhook } from 'cyrus-core'
import { isAgentSessionCreatedWebhook } from 'cyrus-core'

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn()
}))

// Mock dependencies
vi.mock('cyrus-ndjson-client')
vi.mock('cyrus-claude-runner')
vi.mock('@linear/sdk')
vi.mock('../src/SharedApplicationServer.js')
vi.mock('../src/AgentSessionManager.js')
vi.mock('cyrus-core', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    isAgentSessionCreatedWebhook: vi.fn(),
    PersistenceManager: vi.fn().mockImplementation(() => ({
      loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
      saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined)
    }))
  }
})
vi.mock('file-type')

describe('EdgeWorker - Repository Routing', () => {
  let edgeWorker: EdgeWorker
  let mockConfig: EdgeWorkerConfig
  let mockNdjsonClient: any
  let mockLinearClient: any
  let mockClaudeRunner: any
  let mockAgentSessionManager: any
  let mockSharedServer: any
  let onSessionStartSpy: any

  beforeEach(() => {
    vi.clearAllMocks()

    // Mock NdjsonClient
    mockNdjsonClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      on: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true)
    }
    vi.mocked(NdjsonClient).mockImplementation(() => mockNdjsonClient)

    // Mock LinearClient
    mockLinearClient = {
      issue: vi.fn().mockImplementation((id: string) => ({
        id,
        identifier: 'TEST-123',
        title: 'Test Issue',
        description: 'Test Description',
        url: 'https://linear.app/test/issue/TEST-123',
        state: Promise.resolve({ name: 'Todo', type: 'unstarted' }),
        team: Promise.resolve({ id: 'team-1', key: 'TEST' }),
        labels: vi.fn().mockResolvedValue({ nodes: [] }),
        branchName: 'test-branch'
      })),
      createAgentActivity: vi.fn().mockResolvedValue({ success: true })
    }
    vi.mocked(LinearClient).mockImplementation(() => mockLinearClient)

    // Mock ClaudeRunner
    mockClaudeRunner = {
      startStreaming: vi.fn().mockResolvedValue({
        sessionId: 'test-session',
        startedAt: new Date()
      }),
      stop: vi.fn(),
      updatePromptVersions: vi.fn()
    }
    vi.mocked(ClaudeRunner).mockImplementation(() => mockClaudeRunner)

    // Mock AgentSessionManager
    mockAgentSessionManager = {
      createLinearAgentSession: vi.fn(),
      addClaudeRunner: vi.fn(),
      getSession: vi.fn(),
      getAllClaudeRunners: vi.fn().mockReturnValue([]),
      serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
      restoreState: vi.fn()
    }
    vi.mocked(AgentSessionManager).mockImplementation(() => mockAgentSessionManager)

    // Mock SharedApplicationServer
    mockSharedServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      registerOAuthCallbackHandler: vi.fn()
    }
    vi.mocked(SharedApplicationServer).mockImplementation(() => mockSharedServer)

    // Mock isAgentSessionCreatedWebhook
    vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(true)

    // Create spy for session start events
    onSessionStartSpy = vi.fn()

    // Basic config with multiple repositories
    mockConfig = {
      proxyUrl: 'http://localhost:3000',
      repositories: [
        {
          id: 'ceedar',
          name: 'Ceedar Repository',
          linearToken: 'token-ceedar',
          linearWorkspaceId: 'workspace-ceedar',
          linearWorkspaceName: 'Ceedar Workspace',
          teamKeys: ['CEE'],
          repositoryPath: '/path/to/ceedar',
          workspaceBaseDir: '/tmp/ceedar',
          baseBranch: 'main'
        },
        {
          id: 'bookkeeping',
          name: 'Bookkeeping Repository',
          linearToken: 'token-bookkeeping',
          linearWorkspaceId: 'workspace-bookkeeping',
          linearWorkspaceName: 'Bookkeeping Workspace',
          teamKeys: ['BOOK'],
          repositoryPath: '/path/to/bookkeeping',
          workspaceBaseDir: '/tmp/bookkeeping',
          baseBranch: 'main'
        },
        {
          id: 'shared-workspace',
          name: 'Shared Workspace Repository',
          linearToken: 'token-shared',
          linearWorkspaceId: 'workspace-shared',
          linearWorkspaceName: 'Shared Workspace',
          repositoryPath: '/path/to/shared',
          workspaceBaseDir: '/tmp/shared',
          baseBranch: 'main'
        }
      ],
      handlers: {
        onSessionStart: onSessionStartSpy
      }
    }
  })

  afterEach(async () => {
    if (edgeWorker) {
      await edgeWorker.stop()
    }
  })

  it('should route agent session webhook to correct repository via team key', async () => {
    edgeWorker = new EdgeWorker(mockConfig)
    
    // Create webhook for CEE team (should route to ceedar repository)
    const ceeWebhook: LinearAgentSessionCreatedWebhook = {
      type: 'AppUserNotification',
      action: 'agentSessionCreated',
      createdAt: new Date().toISOString(),
      organizationId: 'workspace-ceedar',
      oauthClientId: 'test-oauth-client',
      appUserId: 'test-app-user',
      agentSession: {
        id: 'session-123',
        issue: {
          id: 'issue-cee-123',
          identifier: 'CEE-123',
          title: 'Test Issue',
          team: {
            key: 'CEE',
            name: 'Ceedar Team'
          }
        }
      }
    }

    // Call the public method directly to test routing logic
    const result = await edgeWorker.findRepositoryForWebhook(ceeWebhook, mockConfig.repositories)

    // Verify the correct repository was returned
    expect(result).toBeTruthy()
    expect(result?.id).toBe('ceedar')
  })

  it('should route agent session webhook to correct repository via issue identifier parsing', async () => {
    edgeWorker = new EdgeWorker(mockConfig)

    // Create webhook without team key but with identifiable issue ID
    const bookWebhook: LinearAgentSessionCreatedWebhook = {
      type: 'AppUserNotification',
      action: 'agentSessionCreated',
      createdAt: new Date().toISOString(),
      organizationId: 'workspace-bookkeeping',
      oauthClientId: 'test-oauth-client',
      appUserId: 'test-app-user',
      agentSession: {
        id: 'session-456',
        issue: {
          id: 'issue-book-456',
          identifier: 'BOOK-456', // Should match BOOK team key
          title: 'Bookkeeping Issue'
          // No team key provided - should fallback to parsing identifier
        }
      }
    }

    // Call the public method directly to test routing logic
    const result = await edgeWorker.findRepositoryForWebhook(bookWebhook, mockConfig.repositories)

    // Verify the correct repository was returned
    expect(result).toBeTruthy()
    expect(result?.id).toBe('bookkeeping')
  })

  it('should fallback to workspace-based routing when no team keys match', async () => {
    edgeWorker = new EdgeWorker(mockConfig)

    // Create webhook with unmatched team key - should fallback to workspace routing
    const fallbackWebhook: LinearAgentSessionCreatedWebhook = {
      type: 'AppUserNotification',
      action: 'agentSessionCreated',
      createdAt: new Date().toISOString(),
      organizationId: 'workspace-shared', // Matches shared-workspace repository
      oauthClientId: 'test-oauth-client',
      appUserId: 'test-app-user',
      agentSession: {
        id: 'session-789',
        issue: {
          id: 'issue-other-789',
          identifier: 'OTHER-789', // No team key matches this
          title: 'Other Issue',
          team: {
            key: 'OTHER', // Not in any repository's teamKeys
            name: 'Other Team'
          }
        }
      }
    }

    // Call the public method directly to test routing logic
    const result = await edgeWorker.findRepositoryForWebhook(fallbackWebhook, mockConfig.repositories)

    // Should route to shared-workspace repository based on workspace ID
    expect(result).toBeTruthy()
    expect(result?.id).toBe('shared-workspace')
  })

  it('should prefer team-based routing over workspace routing', async () => {
    // Create config where multiple repos share same workspace but have different team keys
    const sharedWorkspaceConfig: EdgeWorkerConfig = {
      ...mockConfig,
      repositories: [
        {
          id: 'frontend',
          name: 'Frontend Repository',
          linearToken: 'token-shared',
          linearWorkspaceId: 'workspace-shared', // Same workspace
          teamKeys: ['FRONT'],
          repositoryPath: '/path/to/frontend',
          workspaceBaseDir: '/tmp/frontend',
          baseBranch: 'main'
        },
        {
          id: 'backend',
          name: 'Backend Repository',
          linearToken: 'token-shared',
          linearWorkspaceId: 'workspace-shared', // Same workspace
          teamKeys: ['BACK'],
          repositoryPath: '/path/to/backend',
          workspaceBaseDir: '/tmp/backend',
          baseBranch: 'main'
        }
      ],
      handlers: {
        onSessionStart: onSessionStartSpy
      }
    }

    edgeWorker = new EdgeWorker(sharedWorkspaceConfig)

    // Create webhook with FRONT team key
    const frontendWebhook: LinearAgentSessionCreatedWebhook = {
      type: 'AppUserNotification',
      action: 'agentSessionCreated',
      createdAt: new Date().toISOString(),
      organizationId: 'workspace-shared',
      oauthClientId: 'test-oauth-client',
      appUserId: 'test-app-user',
      agentSession: {
        id: 'session-front',
        issue: {
          id: 'issue-front-123',
          identifier: 'FRONT-123',
          title: 'Frontend Issue',
          team: {
            key: 'FRONT',
            name: 'Frontend Team'
          }
        }
      }
    }

    // Call the public method directly to test routing logic
    const result = await edgeWorker.findRepositoryForWebhook(frontendWebhook, sharedWorkspaceConfig.repositories)

    // Should route to frontend repository based on team key, not workspace fallback
    expect(result).toBeTruthy()
    expect(result?.id).toBe('frontend')
  })
})