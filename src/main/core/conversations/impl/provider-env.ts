import type { AgentProviderId } from '@shared/core/agents/agent-provider-registry';
import type { ProviderCustomConfig } from '@shared/core/app-settings';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPENCODE_ALLOW_ALL_PERMISSIONS = JSON.stringify({ '*': 'allow' });
const GEMINI_TRUST_WORKSPACE = 'true';

export function resolveProviderEnv(
  providerConfig: ProviderCustomConfig | undefined,
  options: { providerId?: AgentProviderId; autoApprove?: boolean; effort?: string } = {}
): Record<string, string> | undefined {
  const env: Record<string, string> = {};

  if (options.providerId === 'opencode' && options.autoApprove) {
    env.OPENCODE_PERMISSION = OPENCODE_ALLOW_ALL_PERMISSIONS;
  }

  if (options.providerId === 'gemini' && options.autoApprove) {
    env.GEMINI_CLI_TRUST_WORKSPACE = GEMINI_TRUST_WORKSPACE;
  }

  for (const [key, value] of Object.entries(providerConfig?.env ?? {})) {
    if (ENV_NAME_PATTERN.test(key)) env[key] = value;
  }

  // Per-task Claude Code reasoning effort; set last so it wins over any per-org env default.
  // `ultracode` is session-only and applied via a CLI arg (see effortSessionArgs), not the env.
  if (options.effort && options.effort !== 'ultracode') {
    env.CLAUDE_CODE_EFFORT_LEVEL = options.effort;
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Extra CLI args implied by a per-task effort selection. `ultracode` can only be enabled
 * via `--settings '{"ultracode":true}'` (it sets xhigh + workflow orchestration); the other
 * levels go through the CLAUDE_CODE_EFFORT_LEVEL env var instead.
 */
export function effortSessionArgs(effort?: string): string[] {
  return effort === 'ultracode' ? ['--settings', '{"ultracode":true}'] : [];
}
