import type { AgentProviderId } from '@shared/core/agents/agent-provider-registry';
import type { AgentStatus } from '@shared/core/agents/agentEvents';

export const MAX_CONVERSATION_TITLE_LENGTH = 100;

export type Conversation = {
  id: string;
  projectId: string;
  taskId: string;
  providerId: AgentProviderId;
  title: string;
  lastInteractedAt: string | null;
  resume?: boolean;
  autoApprove?: boolean;
  /** Claude Code reasoning effort level injected as CLAUDE_CODE_EFFORT_LEVEL at spawn. */
  effort?: string;
  /** Provider-native session id captured at runtime for per-chat resume. */
  providerSessionId?: string;
  isInitialConversation: boolean | null;
  agentStatus?: AgentStatus | null;
  agentStatusSeen?: boolean;
};

export type RenameConversationParams = {
  conversationId: string;
  newTitle: string;
};

export type CreateConversationParams = {
  id: string;
  projectId: string;
  taskId: string;
  provider: AgentProviderId;
  title: string;
  autoApprove?: boolean;
  effort?: string;
  isInitialConversation?: boolean;
  initialSize?: { cols: number; rows: number };
  initialPrompt?: string;
};
