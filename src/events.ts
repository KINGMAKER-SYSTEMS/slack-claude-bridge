type Listener = (event: BridgeEvent) => void;

export type BridgeEvent =
  | { kind: "log"; data: any }
  | { kind: "portal_user"; convoId: string; text: string; ts: number }
  | { kind: "portal_assistant_start"; convoId: string; ts: number }
  | { kind: "portal_assistant_delta"; convoId: string; chunk: string }
  | {
      kind: "portal_tool_use";
      convoId: string;
      name: string;
      input?: any;
      ts: number;
    }
  | {
      kind: "portal_tool_result";
      convoId: string;
      name: string;
      isError?: boolean;
      ts: number;
    }
  | {
      kind: "portal_assistant_done";
      convoId: string;
      text: string;
      sessionId: string | null;
      ts: number;
    }
  | { kind: "portal_error"; convoId: string; message: string; ts: number }
  | { kind: "portal_reset"; convoId: string; ts: number }
  | { kind: "context_update"; key: string; ts: number };

class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: BridgeEvent) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {}
    }
  }
}

export const bus = new EventBus();
