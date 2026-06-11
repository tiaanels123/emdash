import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import {
  FileSystemError,
  FileSystemErrorCodes,
  type FileSystemProvider,
} from '@main/core/fs/types';
import { ClaudeTrustService } from './claude-trust-service';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockRename = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    rename: mockRename,
    rm: mockRm,
  },
}));

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: vi.fn() },
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: mockWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Local trust configs are written with the host platform's path semantics, so
// expected paths are derived from the same fixture inputs via node:path
// (on Windows, '/home/local-user' joins/resolves with backslashes and a drive letter).
const LOCAL_HOME = '/home/local-user';
const CLAUDE_CONFIG_PATH = path.join(LOCAL_HOME, '.claude.json');
const COPILOT_CONFIG_PATH = path.join(LOCAL_HOME, '.copilot', 'config.json');

function notFound(pathName: string): FileSystemError {
  return new FileSystemError(
    `File not found: ${pathName}`,
    FileSystemErrorCodes.NOT_FOUND,
    pathName
  );
}

function makeService(overrides: { autoTrustWorktrees?: boolean } = {}): ClaudeTrustService {
  return new ClaudeTrustService({
    getTaskSettings: () =>
      Promise.resolve({ autoTrustWorktrees: overrides.autoTrustWorktrees ?? true }),
  });
}

function makeRemoteFs(
  overrides: Partial<Pick<FileSystemProvider, 'realPath' | 'read' | 'write'>> = {}
): Pick<FileSystemProvider, 'realPath' | 'read' | 'write'> {
  return {
    realPath: vi.fn(async (p: string) => p),
    read: vi.fn().mockRejectedValue(notFound('/home/remote-user/.claude.json')),
    write: vi.fn().mockResolvedValue({ success: true, bytesWritten: 0 }),
    ...overrides,
  };
}

describe('ClaudeTrustService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('skips providers without trust config', async () => {
    const service = makeService();

    await service.maybeAutoTrustLocal({
      providerId: 'codex',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('skips when auto-trust is disabled', async () => {
    const service = makeService({ autoTrustWorktrees: false });

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('trusts Claude worktrees when forced even if auto-trust is disabled', async () => {
    const service = makeService({ autoTrustWorktrees: false });

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
      force: true,
    });

    expect(mockReadFile).toHaveBeenCalledWith(CLAUDE_CONFIG_PATH, 'utf8');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('writes local config atomically when missing', async () => {
    const service = makeService();
    const relPath = './relative/path';

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: relPath,
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockMkdir).toHaveBeenCalledWith(path.dirname(CLAUDE_CONFIG_PATH), { recursive: true });
    expect(mockRename).toHaveBeenCalledTimes(1);

    const [tmpPath, content] = mockWriteFile.mock.calls[0];
    const [renameFrom, renameTo] = mockRename.mock.calls[0];
    expect(tmpPath).toContain(`${CLAUDE_CONFIG_PATH}.`);
    expect(tmpPath).toContain('.tmp');
    expect(renameFrom).toBe(tmpPath);
    expect(renameTo).toBe(CLAUDE_CONFIG_PATH);

    const written = JSON.parse(String(content));
    expect(written.projects[path.resolve(relPath)]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('adds Copilot trusted folders', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue(JSON.stringify({ trustedFolders: ['/already/trusted'] }));

    await service.maybeAutoTrustLocal({
      providerId: 'copilot',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockMkdir).toHaveBeenCalledWith(path.dirname(COPILOT_CONFIG_PATH), { recursive: true });
    const [tmpPath, content] = mockWriteFile.mock.calls[0];
    const [renameFrom, renameTo] = mockRename.mock.calls[0];
    expect(tmpPath).toContain(`${COPILOT_CONFIG_PATH}.`);
    expect(renameFrom).toBe(tmpPath);
    expect(renameTo).toBe(COPILOT_CONFIG_PATH);
    expect(JSON.parse(String(content)).trustedFolders).toEqual([
      '/already/trusted',
      path.resolve('/tmp/worktree'),
    ]);
  });

  it('does not rewrite Copilot config when folder is already trusted', async () => {
    const service = makeService();
    // The service trusts the resolved cwd, so the already-trusted entry must match it.
    mockReadFile.mockResolvedValue(
      JSON.stringify({ trustedFolders: [path.resolve('/tmp/worktree')] })
    );

    await service.maybeAutoTrustLocal({
      providerId: 'copilot',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('is idempotent when already trusted', async () => {
    const service = makeService();
    // The service trusts the resolved cwd, so the already-trusted entry must match it.
    const trustedPath = path.resolve('/already/trusted');
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        projects: {
          [trustedPath]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      })
    );

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: trustedPath,
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('refuses to overwrite corrupt JSON and logs a warning', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue('{ invalid json');

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'ClaudeTrustService: refusing to overwrite corrupt Claude config',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('refuses to overwrite non-object config root', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue(JSON.stringify([1, 2, 3]));

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'ClaudeTrustService: refusing to overwrite non-object Claude config root'
    );
  });

  it('serializes concurrent calls so no trust entry is lost', async () => {
    const service = makeService();
    let callCount = 0;

    mockReadFile.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return null;
      const [, content] = mockWriteFile.mock.calls[0];
      return String(content);
    });

    await Promise.all([
      service.maybeAutoTrustLocal({
        providerId: 'claude',
        cwd: '/worktree/a',
        homedir: '/home/local-user',
      }),
      service.maybeAutoTrustLocal({
        providerId: 'claude',
        cwd: '/worktree/b',
        homedir: '/home/local-user',
      }),
    ]);

    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    const secondWriteContent = JSON.parse(String(mockWriteFile.mock.calls[1][1]));
    expect(secondWriteContent.projects[path.resolve('/worktree/a')]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
    expect(secondWriteContent.projects[path.resolve('/worktree/b')]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('writes ssh config and renames tmp file remotely', async () => {
    const service = makeService();
    const remoteFs = makeRemoteFs({
      realPath: vi.fn().mockResolvedValue('/remote/worktree'),
    });

    const ctx: IExecutionContext = {
      root: undefined,
      supportsLocalSpawn: false,
      exec: vi.fn().mockImplementation(async (command: string, args: string[] = []) => {
        if (command === 'sh') {
          return { stdout: '/home/remote-user', stderr: '' };
        }
        if (command === 'mv') {
          expect(args[0]).toContain('/home/remote-user/.claude.json.');
          expect(args[1]).toBe('/home/remote-user/.claude.json');
          return { stdout: '', stderr: '' };
        }
        if (command === 'mkdir') {
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
      execStreaming: vi.fn(),
      dispose: vi.fn(),
    };

    await service.maybeAutoTrustSsh({
      providerId: 'claude',
      cwd: '/remote/worktree',
      ctx,
      remoteFs,
    });

    expect(remoteFs.read).toHaveBeenCalledWith(
      '/home/remote-user/.claude.json',
      expect.any(Number)
    );
    expect(remoteFs.write).toHaveBeenCalledTimes(1);
    const [tmpPath, content] = vi.mocked(remoteFs.write).mock.calls[0];
    expect(tmpPath).toContain('/home/remote-user/.claude.json.');
    const written = JSON.parse(String(content));
    expect(written.projects['/remote/worktree']).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
    expect(ctx.exec).toHaveBeenCalledWith('mv', [tmpPath, '/home/remote-user/.claude.json']);
  });
});
