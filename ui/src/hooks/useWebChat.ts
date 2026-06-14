/**
 * useWebChat — SSE streaming for the active web chat turn.
 *
 * Sends messages via POST /api/v2/agents/:id/messages and reads token-level SSE events.
 * Returns an in-progress AwarenessEntry that the ChatPane renders at the
 * bottom of the awareness stream. Completed slash-command turns are retained
 * locally because they do not always produce durable context.jsonl entries.
 */

import { useState, useCallback, useRef } from 'react';
import { postMessageUrl, stopActiveMessage } from '../console-api';
import { createStreamRequestGate } from '../streamRequestGate';
import { debugStream, summarizeEntry, summarizeEvent } from '../streamDebug';
import type { AwarenessEntry } from '../types';
import { getWebChatStreamEffect, reduceWebChatStreamEntry } from '../webChatStream';
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
  /** Completed local web turns that are not guaranteed to appear in context.jsonl */
  localEntries: AwarenessEntry[];
  /** The user's message, shown optimistically while streaming */
  userEntry: AwarenessEntry | null;
  /** The assistant's in-progress response */
  streamingEntry: AwarenessEntry | null;
  isStreaming: boolean;
  status: StreamStatus;
  error: string | null;
  startedAt: string | null;
  sendMessage: (text: string, options?: SendMessageOptions) => void;
  abortStream: () => void;
  clearError: () => void;
}

export interface SendMessageOptions {
  source?: string;
  sourceEventType?: string;
  channelId?: string;
  freshContext?: boolean;
  sessionId?: string;
}

function cleanSearchParam(params: URLSearchParams, key: string, maxLength = 2000): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value.slice(0, maxLength) : undefined;
}

function currentProjectContext(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;

  const params = new URLSearchParams(window.location.search);
  const slug = cleanSearchParam(params, 'tf_project_slug', 80);
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,63}[a-z0-9])?$/.test(slug)) return undefined;

  const project: Record<string, string> = { slug };
  const siteId = cleanSearchParam(params, 'tf_project_site_id', 80) || cleanSearchParam(params, 'tf_project_id', 80);
  const displayName = cleanSearchParam(params, 'tf_project_name', 160);
  const previewUrl = cleanSearchParam(params, 'tf_project_preview', 600);
  const productionUrl = cleanSearchParam(params, 'tf_project_production', 600);
  const state = cleanSearchParam(params, 'tf_project_state', 80);
  const workspacePath = cleanSearchParam(params, 'tf_project_workspace', 300);
  const latestDeploymentUrl = cleanSearchParam(params, 'tf_project_deploy', 600);
  const latestDeploymentState = cleanSearchParam(params, 'tf_project_deploy_state', 80);

  if (siteId) project.siteId = siteId;
  if (displayName) project.displayName = displayName;
  if (previewUrl) project.previewUrl = previewUrl;
  if (productionUrl) project.productionUrl = productionUrl;
  if (state) project.state = state;
  if (workspacePath) project.workspacePath = workspacePath;
  if (latestDeploymentUrl) project.latestDeploymentUrl = latestDeploymentUrl;
  if (latestDeploymentState) project.latestDeploymentState = latestDeploymentState;

  return project;
}

export function useWebChat(): UseWebChatReturn {
  const [localEntries, setLocalEntries] = useState<AwarenessEntry[]>([]);
  const [userEntry, setUserEntry] = useState<AwarenessEntry | null>(null);
  const [streamingEntry, setStreamingEntry] = useState<AwarenessEntry | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeStreamingEntryRef = useRef<AwarenessEntry | null>(null);
  const requestGateRef = useRef(createStreamRequestGate());

  const setActiveStreamingEntry: React.Dispatch<React.SetStateAction<AwarenessEntry | null>> = useCallback((next) => {
    const value = typeof next === 'function'
      ? (next as (prev: AwarenessEntry | null) => AwarenessEntry | null)(activeStreamingEntryRef.current)
      : next;
    activeStreamingEntryRef.current = value;
    debugStream('active-entry:set', { next: summarizeEntry(value) });
    setStreamingEntry(value);
  }, []);

  const activateStreamingEntry = useCallback((label: string, assistant: AwarenessEntry): number => {
    const requestId = requestGateRef.current.activate();
    debugStream(`request:${label}:activate`, {
      requestId,
      previous: summarizeEntry(activeStreamingEntryRef.current),
      next: summarizeEntry(assistant),
    });
    setActiveStreamingEntry(assistant);
    return requestId;
  }, [setActiveStreamingEntry]);

  const makeScopedStreamControls = useCallback((requestId: number) => {
    const isActive = () => requestGateRef.current.isActive(requestId);
    const stalePayload = () => ({ requestId, activeRequestId: requestGateRef.current.current() });

    return {
      isActive,
      setEntry: ((next) => {
        if (!isActive()) {
          debugStream('request:stale-entry:ignored', stalePayload());
          return;
        }
        setActiveStreamingEntry(next);
      }) as React.Dispatch<React.SetStateAction<AwarenessEntry | null>>,
      setStatus: (next: StreamStatus) => {
        if (!isActive()) {
          debugStream('request:stale-status:ignored', { ...stalePayload(), status: next });
          return;
        }
        setStatus(next);
      },
      setError: (next: string | null) => {
        if (!isActive()) {
          debugStream('request:stale-error:ignored', { ...stalePayload(), hasError: !!next });
          return;
        }
        setError(next);
      },
    };
  }, [setActiveStreamingEntry]);

  const sendSteeringMessage = useCallback(async (trimmed: string, options: SendMessageOptions = {}) => {
    const now = new Date().toISOString();
    const user: AwarenessEntry = {
      id: `live-user-${Date.now()}`,
      type: 'message',
      timestamp: now,
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      channel: options.channelId || 'web',
      userName: options.source || 'user',
      strippedText: trimmed,
    };

    const assistant: AwarenessEntry = {
      id: `live-assistant-steer-${Date.now()}`,
      type: 'message',
      timestamp: now,
      role: 'assistant',
      content: [],
      isStreaming: true,
    };

    const requestId = activateStreamingEntry('steering', assistant);
    const controls = makeScopedStreamControls(requestId);
    const controller = new AbortController();
    let endedWithError = false;

    setUserEntry(user);
    setError(null);
    setIsStreaming(true);
    setStatus('steering');
    setStartedAt(now);
    abortControllerRef.current = controller;
    debugStream('send:steering:start', {
      requestId,
      textLen: trimmed.length,
      hasActiveRequest: !!abortControllerRef.current,
      activeEntry: summarizeEntry(activeStreamingEntryRef.current),
    });

    try {
      const response = await fetch(postMessageUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createMessagePayload(trimmed, options)),
        signal: controller.signal,
      });
      debugStream('send:steering:response', {
        requestId,
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type'),
      });

      if (!controls.isActive()) return;

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `HTTP ${response.status}`);
      }

      if (response.body) {
        endedWithError = await readSseResponse(response, controls.setEntry, controls.setStatus, controls.setError);
        if (endedWithError) return;
      }

      controls.setStatus(abortControllerRef.current ? 'streaming' : 'idle');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        debugStream('send:steering:abort', { requestId });
        controls.setError(null);
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        debugStream('send:steering:error', { requestId, message: msg });
        endedWithError = true;
        controls.setError(msg);
        controls.setStatus('error');
        controls.setEntry((prev) => {
          if (!prev) return null;
          const hasContent = prev.content?.some((c) => c.type === 'text' && c.text.trim());
          if (hasContent) return { ...prev, isStreaming: false };
          return { ...prev, content: [{ type: 'text', text: 'Failed to get response.' }], isStreaming: false };
        });
      }
    } finally {
      debugStream('send:steering:finally', {
        requestId,
        active: controls.isActive(),
        endedWithError,
        finalAssistant: summarizeEntry(activeStreamingEntryRef.current),
      });
      if (!controls.isActive()) return;
      setActiveStreamingEntry((prev) => prev ? { ...prev, isStreaming: false } : null);
      setIsStreaming(false);
      setStatus(endedWithError ? 'error' : 'idle');
      setStartedAt(null);
      abortControllerRef.current = null;
    }
  }, [activateStreamingEntry, makeScopedStreamControls, setActiveStreamingEntry]);

  const sendMessage = useCallback(async (text: string, options: SendMessageOptions = {}) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!options.freshContext && shouldSendAsSteering(trimmed, !!abortControllerRef.current)) {
      void sendSteeringMessage(trimmed, options);
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
      channel: options.channelId || 'web',
      userName: options.source || 'user',
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

    const requestId = activateStreamingEntry('normal', assistant);
    const controls = makeScopedStreamControls(requestId);

    setUserEntry(user);
    setIsStreaming(true);
    setStatus('connecting');
    setError(null);
    setStartedAt(now);
    debugStream('send:normal:start', {
      requestId,
      textLen: trimmed.length,
      assistant: summarizeEntry(assistant),
      hadActiveRequest: !!abortControllerRef.current,
    });

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let endedWithError = false;

    try {
      // Retry loop for cold starts
      let response: Response | null = null;
      for (let attempt = 1; attempt <= 30; attempt++) {
        debugStream('send:normal:attempt', { requestId, attempt });
        response = await fetch(postMessageUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createMessagePayload(trimmed, options)),
          signal: controller.signal,
        });
        debugStream('send:normal:response', {
          requestId,
          attempt,
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type'),
        });
        if (!controls.isActive()) return;
        if (response.status === 503) {
          controls.setStatus('connecting');
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

      endedWithError = await readSseResponse(response, controls.setEntry, controls.setStatus, controls.setError);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        debugStream('send:normal:abort', { requestId });
        controls.setError(null);
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        debugStream('send:normal:error', { requestId, message: msg });
        endedWithError = true;
        controls.setError(msg);
        controls.setStatus('error');
        controls.setEntry((prev) => {
          if (!prev) return null;
          const hasContent = prev.content?.some((c) => c.type === 'text' && c.text.trim());
          if (hasContent) return { ...prev, isStreaming: false };
          return { ...prev, content: [{ type: 'text', text: 'Failed to get response.' }], isStreaming: false };
        });
      }
    } finally {
      const active = controls.isActive();
      const finalAssistant = activeStreamingEntryRef.current
        ? { ...activeStreamingEntryRef.current, isStreaming: false }
        : null;
      debugStream('send:normal:finally', {
        requestId,
        active,
        endedWithError,
        finalAssistant: summarizeEntry(finalAssistant),
      });
      if (!active) return;
      if (trimmed.startsWith('/')) {
        setLocalEntries((prev) => appendLocalSlashTurn(prev, user, finalAssistant));
        setUserEntry(null);
        setActiveStreamingEntry(null);
      } else {
        // Keep streamingEntry with isStreaming=false — it becomes the rendered
        // version. The SSE duplicate gets filtered out in AwarenessPane.
        setActiveStreamingEntry((prev) => prev ? { ...prev, isStreaming: false } : null);
      }
      setIsStreaming(false);
      setStatus(endedWithError ? 'error' : 'idle');
      setStartedAt(null);
      abortControllerRef.current = null;
    }
  }, [activateStreamingEntry, makeScopedStreamControls, sendSteeringMessage, setActiveStreamingEntry]);

  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      debugStream('send:abort', {
        requestId: requestGateRef.current.current(),
        activeEntry: summarizeEntry(activeStreamingEntryRef.current),
      });
      requestGateRef.current.deactivate();
      setStatus('stopping');
      stopActiveMessage().catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to stop active run');
      });
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setActiveStreamingEntry((prev) => prev ? { ...prev, isStreaming: false } : null);
    setIsStreaming(false);
    setStatus('idle');
    setStartedAt(null);
  }, [setActiveStreamingEntry]);

  const clearError = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  return { localEntries, userEntry, streamingEntry, isStreaming, status, error, startedAt, sendMessage, abortStream, clearError };
}

function createMessagePayload(message: string, options: SendMessageOptions): Record<string, unknown> {
  const project = currentProjectContext();
  const channelId = options.channelId || (project?.slug ? `project:${project.slug}:web` : undefined);
  return {
    message,
    ...(options.source ? { source: options.source } : {}),
    ...(options.sourceEventType ? { sourceEventType: options.sourceEventType } : {}),
    ...(channelId ? { channelId } : {}),
    ...(options.freshContext ? { fresh_context: true } : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    ...(project ? { project } : {}),
  };
}

const LOCAL_SLASH_ENTRY_LIMIT = 40;

function appendLocalSlashTurn(
  entries: AwarenessEntry[],
  user: AwarenessEntry,
  assistant: AwarenessEntry | null,
): AwarenessEntry[] {
  const next = [...entries, user];
  if (assistant && hasRenderableContent(assistant)) {
    next.push(assistant);
  }
  return next.slice(-LOCAL_SLASH_ENTRY_LIMIT);
}

function hasRenderableContent(entry: AwarenessEntry): boolean {
  return !!entry.content?.some((block) => {
    if (block.type === 'text') return block.text.trim().length > 0;
    if (block.type === 'thinking') return block.thinking.trim().length > 0;
    return block.type === 'toolCall' || block.type === 'toolOutput' || block.type === 'toolResult';
  });
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
  let chunkCount = 0;
  let eventCount = 0;
  debugStream('sse:read:start', {
    status: response.status,
    contentType: response.headers.get('content-type'),
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      debugStream('sse:read:done', { chunkCount, eventCount, remainingBufferLen: buffer.length });
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    chunkCount += 1;
    debugStream('sse:chunk', {
      chunkCount,
      bytes: value?.byteLength ?? 0,
      bufferLen: buffer.length,
    });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') {
        debugStream('sse:event:done', { eventCount });
        continue;
      }
      eventCount += 1;
      const result = processEvent(data, setEntry, setStatus, setError);
      if (result.endedWithError) endedWithError = true;
      if (result.completed) {
        await reader.cancel().catch(() => undefined);
        debugStream('sse:event:completed', { eventCount });
        return endedWithError;
      }
    }
  }

  if (buffer.startsWith('data: ')) {
    const remaining = buffer.slice(6);
    if (remaining !== '[DONE]') {
      eventCount += 1;
      debugStream('sse:remaining', { eventCount, bytes: remaining.length });
      const result = processEvent(remaining, setEntry, setStatus, setError);
      if (result.endedWithError) endedWithError = true;
      if (result.completed) {
        debugStream('sse:remaining:completed', { eventCount });
        return endedWithError;
      }
    } else {
      debugStream('sse:remaining:done', { eventCount });
    }
  }

  debugStream('sse:read:end', { chunkCount, eventCount, endedWithError });
  return endedWithError;
}

function processEvent(
  data: string,
  setEntry: React.Dispatch<React.SetStateAction<AwarenessEntry | null>>,
  setStatus: (s: StreamStatus) => void,
  setError: (e: string | null) => void,
): { endedWithError: boolean; completed: boolean } {
  try {
    const parsed = JSON.parse(data);
    const effect = getWebChatStreamEffect(parsed);
    debugStream('sse:event', {
      event: summarizeEvent(parsed),
      effect,
    });
    if (effect.status) setStatus(effect.status);
    if (effect.error !== undefined) setError(effect.error);

    setEntry((prev) => {
      const next = reduceWebChatStreamEntry(prev, parsed);
      debugStream('sse:reduce', {
        eventType: parsed.type,
        prev: summarizeEntry(prev),
        next: summarizeEntry(next),
      });
      return next;
    });
    return { endedWithError: !!effect.endedWithError, completed: !!effect.completed };
  } catch (err) {
    debugStream('sse:event:parse-error', {
      message: err instanceof Error ? err.message : 'Non-JSON SSE event',
      preview: data.slice(0, 200),
    });
    // Non-JSON — skip
  }
  return { endedWithError: false, completed: false };
}
