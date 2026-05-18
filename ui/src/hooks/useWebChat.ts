/**
 * useWebChat — SSE streaming for the active web chat turn.
 *
 * Sends messages via POST /api/v2/agents/:id/messages and reads token-level SSE events.
 * Returns a single in-progress AwarenessEntry that the ChatPane renders
 * at the bottom of the awareness stream. When the turn completes,
 * streamingEntry goes null — the completed entry arrives via the
 * awareness stream (from context.jsonl).
 */

import { useState, useCallback, useRef } from 'react';
import { postMessageUrl, stopActiveMessage } from '../console-api';
import type { AwarenessEntry } from '../types';
import { shouldSendAsSteering } from '../webChatRouting';

export type StreamStatus =
  | 'idle'
  | 'waking'
  | 'connecting'
  | 'steering'
  | 'streaming'
  | 'tool_running'
  | 'stopping'
  | 'error';

export interface UseWebChatReturn {
  /** The user's message, shown optimistically while streaming */
  userEntry: AwarenessEntry | null;
  /** The assistant's in-progress response */
  streamingEntry: AwarenessEntry | null;
  isStreaming: boolean;
  status: StreamStatus;
  error: string | null;
  startedAt: string | null;
  sendMessage: (text: string) => void;
  abortStream: () => void;
  clearError: () => void;
}

export function useWebChat(): UseWebChatReturn {
  const [userEntry, setUserEntry] = useState<AwarenessEntry | null>(null);
  const [streamingEntry, setStreamingEntry] = useState<AwarenessEntry | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendSteeringMessage = useCallback(async (trimmed: string) => {
    const now = new Date().toISOString();
    const user: AwarenessEntry = {
      id: `live-user-${Date.now()}`,
      type: 'message',
      timestamp: now,
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      channel: 'web',
      userName: 'user',
      strippedText: trimmed,
    };

    setUserEntry(user);
    setError(null);
    setStatus('steering');

    try {
      const response = await fetch(postMessageUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `HTTP ${response.status}`);
      }

      if (response.body) {
        const endedWithError = await readSseResponse(response, setStreamingEntry, setStatus, setError);
        if (endedWithError) return;
      }

      setStatus(abortControllerRef.current ? 'streaming' : 'idle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      setStatus('error');
    }
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (shouldSendAsSteering(trimmed, !!abortControllerRef.current)) {
      void sendSteeringMessage(trimmed);
      return;
    }

    const now = new Date().toISOString();

    // Optimistic user entry
    const user: AwarenessEntry = {
      id: `live-user-${Date.now()}`,
      type: 'message',
      timestamp: now,
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      channel: 'web',
      userName: 'user',
      strippedText: trimmed,
    };

    // Empty assistant entry — filled by SSE tokens
    const assistant: AwarenessEntry = {
      id: `live-assistant-${Date.now()}`,
      type: 'message',
      timestamp: now,
      role: 'assistant',
      content: [],
      isStreaming: true,
    };

    setUserEntry(user);
    setStreamingEntry(assistant);
    setIsStreaming(true);
    setStatus('connecting');
    setError(null);
    setStartedAt(now);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let endedWithError = false;

    try {
      // Retry loop for cold starts
      let response: Response | null = null;
      for (let attempt = 1; attempt <= 30; attempt++) {
        response = await fetch(postMessageUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed }),
          signal: controller.signal,
        });
        if (response.status === 503) {
          setStatus('connecting');
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        break;
      }

      if (!response || !response.ok) {
        const errText = response ? await response.text() : 'No response';
        throw new Error(errText || `HTTP ${response?.status}`);
      }

      if (!response.body) throw new Error('No response body');

      endedWithError = await readSseResponse(response, setStreamingEntry, setStatus, setError);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError(null);
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        endedWithError = true;
        setError(msg);
        setStatus('error');
        setStreamingEntry((prev) => {
          if (!prev) return null;
          const hasContent = prev.content?.some((c) => c.type === 'text' && c.text.trim());
          if (hasContent) return { ...prev, isStreaming: false };
          return { ...prev, content: [{ type: 'text', text: 'Failed to get response.' }], isStreaming: false };
        });
      }
    } finally {
      // Keep streamingEntry with isStreaming=false — it becomes the rendered
      // version. The SSE duplicate gets filtered out in AwarenessPane.
      setStreamingEntry((prev) => prev ? { ...prev, isStreaming: false } : null);
      setIsStreaming(false);
      setStatus(endedWithError ? 'error' : 'idle');
      setStartedAt(null);
      abortControllerRef.current = null;
    }
  }, [sendSteeringMessage]);

  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      setStatus('stopping');
      stopActiveMessage().catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to stop active run');
      });
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStreamingEntry((prev) => prev ? { ...prev, isStreaming: false } : null);
    setIsStreaming(false);
    setStatus('idle');
    setStartedAt(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  return { userEntry, streamingEntry, isStreaming, status, error, startedAt, sendMessage, abortStream, clearError };
}

// ============================================================================
// SSE event → update streaming AwarenessEntry
// ============================================================================

async function readSseResponse(
  response: Response,
  setEntry: React.Dispatch<React.SetStateAction<AwarenessEntry | null>>,
  setStatus: (s: StreamStatus) => void,
  setError: (e: string | null) => void,
): Promise<boolean> {
  if (!response.body) return false;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let endedWithError = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      if (processEvent(data, setEntry, setStatus, setError)) endedWithError = true;
    }
  }

  if (buffer.startsWith('data: ')) {
    const remaining = buffer.slice(6);
    if (remaining !== '[DONE]') {
      if (processEvent(remaining, setEntry, setStatus, setError)) endedWithError = true;
    }
  }

  return endedWithError;
}

function processEvent(
  data: string,
  setEntry: React.Dispatch<React.SetStateAction<AwarenessEntry | null>>,
  setStatus: (s: StreamStatus) => void,
  setError: (e: string | null) => void,
): boolean {
  try {
    const parsed = JSON.parse(data);

    // Token-level streaming deltas — append to last block of same type
    if (parsed.type === 'text_delta' && parsed.delta) {
      setStatus('streaming');
      setEntry((prev) => {
        if (!prev) return prev;
        const content = [...(prev.content || [])];
        const last = content[content.length - 1];
        if (last && last.type === 'text') {
          content[content.length - 1] = { ...last, text: last.text + parsed.delta };
        } else {
          content.push({ type: 'text' as const, text: parsed.delta });
        }
        return { ...prev, content };
      });
    } else if (parsed.type === 'thinking_delta' && parsed.delta) {
      setStatus('streaming');
      setEntry((prev) => {
        if (!prev) return prev;
        const content = [...(prev.content || [])];
        const last = content[content.length - 1];
        if (last && last.type === 'thinking') {
          content[content.length - 1] = { ...last, thinking: (last as any).thinking + parsed.delta };
        } else {
          content.push({ type: 'thinking' as const, thinking: parsed.delta });
        }
        return { ...prev, content };
      });
    // Complete content blocks from message_end — replace delta-built content
    } else if (parsed.type === 'text' && parsed.text) {
      setEntry((prev) => {
        if (!prev) return prev;
        // Replace all text blocks with the final complete version
        const nonText = (prev.content || []).filter((c) => c.type !== 'text');
        return { ...prev, content: [...nonText, { type: 'text' as const, text: parsed.text }] };
      });
    } else if (parsed.type === 'thinking' && parsed.thinking) {
      setEntry((prev) => {
        if (!prev) return prev;
        // Replace all thinking blocks with the final complete version
        const nonThinking = (prev.content || []).filter((c) => c.type !== 'thinking');
        return { ...prev, content: [{ type: 'thinking' as const, thinking: parsed.thinking }, ...nonThinking] };
      });
    } else if (parsed.type === 'toolCall') {
      setStatus('tool_running');
      setEntry((prev) => {
        if (!prev) return prev;
        return { ...prev, content: [...(prev.content || []), {
          type: 'toolCall' as const,
          id: parsed.id || `tool-${Date.now()}`,
          name: parsed.name,
          arguments: parsed.arguments || {},
        }] };
      });
    } else if (parsed.type === 'toolResult') {
      setStatus('streaming');
      setEntry((prev) => {
        if (!prev) return prev;
        return { ...prev, content: [...(prev.content || []), {
          type: 'toolResult' as const,
          toolCallId: parsed.toolCallId || '',
          result: parsed.result || '',
          isError: parsed.isError,
        }] };
      });
    } else if (parsed.type === 'status') {
      if (parsed.status === 'waking') {
        setStatus('waking');
      } else if (parsed.status === 'connecting' || parsed.status === 'container') {
        setStatus('connecting');
      } else if (parsed.status === 'steering') {
        setStatus('steering');
      }
    } else if (parsed.type === 'error') {
      const message = parsed.message || 'Stream error';
      setStatus('error');
      setError(message);
      setEntry((prev) => {
        if (!prev) return prev;
        const hasContent = prev.content?.some((c) => c.type === 'text' && c.text.trim());
        if (hasContent) return { ...prev, isStreaming: false };
        return { ...prev, content: [{ type: 'text' as const, text: message }], isStreaming: false };
      });
      return true;
    }
    // heartbeat and run_complete are ignored
  } catch {
    // Non-JSON — skip
  }
  return false;
}
