import type {
  AgentBridge,
  AgentEvent,
  AgentHealth,
  AgentTask,
  ContinueAgentInput,
  StartAgentInput,
} from '@easybi-studio/contracts';

/**
 * InnosAgentBridge (plan §13, stage 9 preparation).
 *
 * Reserved provider that will map Innos's event stream onto the frozen Studio
 * AgentEvent contract. It is NOT connected to any Innos service in this release;
 * every method throws NotImplemented so business code can target it uniformly
 * without accidental use. See docs/INNOS_INTEGRATION.md §2 for the event mapping.
 */
const NOT_IMPLEMENTED = 'InnosAgentBridge 尚未接入（阶段 9 仅冻结契约，不连接平台服务）';

export class InnosAgentBridge implements AgentBridge {
  async healthCheck(): Promise<AgentHealth> {
    return { available: false, provider: 'innos', note: NOT_IMPLEMENTED };
  }

  async start(_input: StartAgentInput): Promise<AgentTask> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async continue(_input: ContinueAgentInput): Promise<AgentTask> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async cancel(_taskId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  events(_taskId: string): AsyncIterable<AgentEvent> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
