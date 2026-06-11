import { describe, expect, it } from 'vitest';
import { effortSessionArgs, resolveProviderEnv } from './provider-env';

describe('resolveProviderEnv', () => {
  it('returns valid provider environment variables', () => {
    expect(
      resolveProviderEnv({
        env: {
          ANTHROPIC_BASE_URL: 'https://example.test',
          _TOKEN: 'secret',
          'INVALID-NAME': 'ignored',
          '1TOKEN': 'ignored',
        },
      })
    ).toEqual({
      ANTHROPIC_BASE_URL: 'https://example.test',
      _TOKEN: 'secret',
    });
  });

  it('returns undefined when no valid provider environment variables exist', () => {
    expect(resolveProviderEnv(undefined)).toBeUndefined();
    expect(resolveProviderEnv({ env: { 'INVALID-NAME': 'ignored' } })).toBeUndefined();
  });

  it('sets inline opencode permissions when auto-approve is enabled', () => {
    expect(resolveProviderEnv(undefined, { providerId: 'opencode', autoApprove: true })).toEqual({
      OPENCODE_PERMISSION: '{"*":"allow"}',
    });
  });

  it('does not set inline opencode permissions when auto-approve is disabled', () => {
    expect(
      resolveProviderEnv(undefined, { providerId: 'opencode', autoApprove: false })
    ).toBeUndefined();
  });

  it('sets Gemini workspace trust when auto-approve is enabled', () => {
    expect(resolveProviderEnv(undefined, { providerId: 'gemini', autoApprove: true })).toEqual({
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    });
  });

  it('does not set Gemini workspace trust when auto-approve is disabled', () => {
    expect(
      resolveProviderEnv(undefined, { providerId: 'gemini', autoApprove: false })
    ).toBeUndefined();
  });

  it('preserves custom opencode permissions when auto-approve is enabled', () => {
    expect(
      resolveProviderEnv(
        { env: { OPENCODE_PERMISSION: '{"edit":"allow","bash":"ask"}' } },
        { providerId: 'opencode', autoApprove: true }
      )
    ).toEqual({
      OPENCODE_PERMISSION: '{"edit":"allow","bash":"ask"}',
    });
  });

  it('does not set inline opencode permissions for other providers', () => {
    expect(
      resolveProviderEnv(undefined, { providerId: 'claude', autoApprove: true })
    ).toBeUndefined();
  });

  it('injects CLAUDE_CODE_EFFORT_LEVEL for a standard effort level', () => {
    expect(resolveProviderEnv(undefined, { providerId: 'claude', effort: 'high' })).toEqual({
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
    });
  });

  it('does not set the effort env var for ultracode (applied via a CLI arg instead)', () => {
    expect(
      resolveProviderEnv(undefined, { providerId: 'claude', effort: 'ultracode' })
    ).toBeUndefined();
  });
});

describe('effortSessionArgs', () => {
  it('returns the ultracode --settings arg for ultracode', () => {
    expect(effortSessionArgs('ultracode')).toEqual(['--settings', '{"ultracode":true}']);
  });

  it('returns no args for standard levels or when unset', () => {
    expect(effortSessionArgs('high')).toEqual([]);
    expect(effortSessionArgs(undefined)).toEqual([]);
  });
});
