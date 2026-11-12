/** Persisted AI workspace contracts. All credentials remain in the main process. */
export const WORKSPACE_IPC = {
  conversationDelete: 'workspace:conversation-delete', conversationsList: 'workspace:conversations-list', conversationCreate: 'workspace:conversation-create',
  conversationRename: 'workspace:conversation-rename', conversationGet: 'workspace:conversation-get',
  agentSend: 'workspace:send', agentRunGet: 'workspace:run-get', agentDecide: 'workspace:decide',
  agentStop: 'workspace:stop', agentAttachmentChoose: 'workspace:attachment-choose',
  agentResourceGet: 'workspace:resource-get',
  agentBackgroundList: 'workspace:background-list', agentBackgroundRetry: 'workspace:background-retry'
} as const
export type ResourceKind = 'email' | 'info' | 'daily' | 'article' | 'item' | 'reminder'
export interface ResourceReference { kind: ResourceKind; id: number; title: string }
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string }
export interface ChatAttachment { id: string; conversationId: string; name: string; size: number; mediaType: string; status: 'ready' | 'failed'; error?: string; extractedChars: number; createdAt: string }
export interface WorkspaceMessage { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; references: ResourceReference[]; attachments: ChatAttachment[]; createdAt: string; runId: string | null }
export type AgentRunStatus = 'running' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled'
export interface AgentStep { id: string; runId: string; tool: string; args: Record<string, unknown>; status: 'completed' | 'failed' | 'waiting_confirmation' | 'denied'; result: string; risk: 'read' | 'normal' | 'high'; createdAt: string }
/** 模型本轮的思考/推理记录；按 seq 顺序展示，可折叠。 */
export interface AgentThought { id: string; seq: number; content: string; createdAt: string }
export interface AgentRun { id: string; conversationId: string; status: AgentRunStatus; summary: string; steps: AgentStep[]; thoughts: AgentThought[]; createdAt: string; updatedAt: string }
export interface ConversationDetail { conversation: Conversation; messages: WorkspaceMessage[]; runs: AgentRun[] }
export interface AgentSendInput { conversationId: string; content: string; references?: ResourceReference[]; attachmentIds?: string[]; requestId: string }
export interface AgentResourceDetail { reference: ResourceReference; content: string; offset: number; totalChars: number; hasMore: boolean }
export interface BackgroundJob { id:number; sourceKey:string; status:string; attempts:number; result:string; updatedAt:string }
export interface WorkspaceApi {
  agentBackgroundList(): Promise<BackgroundJob[]>
  agentBackgroundRetry(id:number): Promise<BackgroundJob[]>
  conversationDelete(id: string): Promise<void>
  conversationsList(keyword?: string): Promise<Conversation[]>
  conversationCreate(title?: string): Promise<Conversation>
  conversationRename(id: string, title: string): Promise<Conversation>
  conversationGet(id: string): Promise<ConversationDetail>
  agentSend(input: AgentSendInput): Promise<AgentRun>
  agentRunGet(id: string): Promise<AgentRun>
  agentDecide(runId: string, stepId: string, approved: boolean): Promise<AgentRun>
  agentStop(runId: string): Promise<AgentRun>
  agentAttachmentChoose(conversationId: string): Promise<{ ok: boolean; message: string; attachments: ChatAttachment[] }>
  agentResourceGet(reference: ResourceReference, offset?: number): Promise<AgentResourceDetail>
}
