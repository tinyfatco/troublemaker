/**
 * useVoiceChat - browser mic capture for Realtime 2 and turn-based voice.
 *
 * Realtime 2 gets a compact context handoff plus narrow read/search tools.
 * Turn-based voice uses the existing /voice/stream canonical agent path.
 */

import { useState, useRef, useCallback } from 'react';
import { apiUrl } from '../api';
import { createRealtimeClientSecret, executeWorkspaceTool, fetchAwarenessBacklog, fetchRealtimeVoicePreference } from '../console-api';
import {
  REALTIME_CONTEXT_BACKLOG_LIMIT,
  buildRealtimeContextHandoff,
  createRealtimeContextItem,
  createRealtimeTruncationConfig,
  isBenignRealtimeCancellationError,
  mergeRealtimeContextEntries,
  parseRealtimeContextBacklog,
  type RealtimeContextHandoff,
} from '../realtimeContext';
import type { AwarenessEntry } from '../types';

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const REALTIME_MODEL = 'gpt-realtime-2';
const TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
const DEFAULT_REALTIME_VOICE = 'marin';
const TURN_VOICE_SAMPLE_RATE = 16000;

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';
export type VoiceMode = 'realtime' | 'turn';

export interface UseVoiceChatReturn {
  state: VoiceState;
  mode: VoiceMode;
  partial: string;
  transcript: string;
  assistantText: string;
  localEntries: AwarenessEntry[];
  cloudEvent: string;
  start: () => Promise<void>;
  stop: () => void;
  setMode: (mode: VoiceMode) => void;
  toggleMode: () => void;
  error: string | null;
}

export interface UseVoiceChatOptions {
  contextEntries?: AwarenessEntry[];
}

type RealtimeEvent = Record<string, unknown> & { type?: string };

interface RealtimeFunctionCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

const PCM_CAPTURE_WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(input[0].slice());
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

export function useVoiceChat(options: UseVoiceChatOptions = {}): UseVoiceChatReturn {
  const [state, setState] = useState<VoiceState>('idle');
  const [mode, setModeState] = useState<VoiceMode>('realtime');
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [localEntries, setLocalEntries] = useState<AwarenessEntry[]>([]);
  const [cloudEvent, setCloudEvent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const turnWsRef = useRef<WebSocket | null>(null);
  const turnAudioCtxRef = useRef<AudioContext | null>(null);
  const turnWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const turnSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const turnMuteNodeRef = useRef<GainNode | null>(null);
  const turnAudioChunksRef = useRef<BlobPart[]>([]);
  const turnPlaybackRef = useRef<HTMLAudioElement | null>(null);
  const turnPlaybackUrlRef = useRef<string | null>(null);
  const turnSuppressMicRef = useRef(false);
  const outputActiveRef = useRef(false);
  const partialRef = useRef('');
  const assistantTextRef = useRef('');
  const activeUserEntryIdRef = useRef<string | null>(null);
  const activeAssistantEntryIdRef = useRef<string | null>(null);
  const activeToolEntryIdsRef = useRef<Map<string, string>>(new Map());
  const activeVoiceRef = useRef(DEFAULT_REALTIME_VOICE);
  const entrySequenceRef = useRef(0);
  const sessionIdRef = useRef(0);
  const modeRef = useRef<VoiceMode>('realtime');
  const contextEntriesRef = useRef<AwarenessEntry[]>([]);
  const pendingContextHandoffRef = useRef<RealtimeContextHandoff | null>(null);
  const contextHandoffSentRef = useRef(false);

  contextEntriesRef.current = options.contextEntries || [];

  const nextEntryId = useCallback((role: string) => {
    entrySequenceRef.current += 1;
    return `voice-${role}-${Date.now()}-${entrySequenceRef.current}`;
  }, []);

  const appendLocalEntry = useCallback((entry: AwarenessEntry) => {
    setLocalEntries((prev) => [...prev, entry].slice(-LOCAL_VOICE_ENTRY_LIMIT));
  }, []);

  const updateLocalEntry = useCallback((id: string, update: (entry: AwarenessEntry) => AwarenessEntry) => {
    setLocalEntries((prev) => prev.map((entry) => entry.id === id ? update(entry) : entry));
  }, []);

  const ensureUserEntry = useCallback((text = ''): string => {
    if (activeUserEntryIdRef.current) return activeUserEntryIdRef.current;
    const id = nextEntryId('user');
    activeUserEntryIdRef.current = id;
    appendLocalEntry(createVoiceUserEntry(id, text, true));
    return id;
  }, [appendLocalEntry, nextEntryId]);

  const updateUserEntryText = useCallback((text: string, isStreaming: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = ensureUserEntry(trimmed);
    updateLocalEntry(id, (entry) => ({
      ...entry,
      content: [{ type: 'text', text: trimmed }],
      strippedText: trimmed,
      isStreaming,
    }));
  }, [ensureUserEntry, updateLocalEntry]);

  const ensureAssistantEntry = useCallback((): string => {
    if (activeAssistantEntryIdRef.current) return activeAssistantEntryIdRef.current;
    const id = nextEntryId('assistant');
    activeAssistantEntryIdRef.current = id;
    assistantTextRef.current = '';
    appendLocalEntry(createVoiceAssistantEntry(id, '', true));
    return id;
  }, [appendLocalEntry, nextEntryId]);

  const updateAssistantEntryText = useCallback((text: string, isStreaming: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = ensureAssistantEntry();
    updateLocalEntry(id, (entry) => ({
      ...entry,
      content: [{ type: 'text', text: trimmed }],
      isStreaming,
    }));
  }, [ensureAssistantEntry, updateLocalEntry]);

  const finishAssistantEntry = useCallback(() => {
    const id = activeAssistantEntryIdRef.current;
    if (!id) return;
    updateLocalEntry(id, (entry) => ({ ...entry, isStreaming: false }));
    activeAssistantEntryIdRef.current = null;
    assistantTextRef.current = '';
  }, [updateLocalEntry]);

  const appendToolCallEntry = useCallback((call: RealtimeFunctionCall) => {
    const id = nextEntryId('tool');
    activeToolEntryIdsRef.current.set(call.callId, id);
    appendLocalEntry(createVoiceToolEntry(id, call, true));
  }, [appendLocalEntry, nextEntryId]);

  const finishToolCallEntry = useCallback((callId: string, result: string, isError: boolean) => {
    const id = activeToolEntryIdsRef.current.get(callId);
    if (!id) return;
    activeToolEntryIdsRef.current.delete(callId);
    updateLocalEntry(id, (entry) => {
      const content = (entry.content || []).filter((block) => !(block.type === 'toolResult' && block.toolCallId === callId));
      return {
        ...entry,
        content: [
          ...content,
          { type: 'toolResult' as const, toolCallId: callId, result, isError },
        ],
        isStreaming: false,
      };
    });
  }, [updateLocalEntry]);

  const sendRealtimeEvent = useCallback((event: Record<string, unknown>): boolean => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify(event));
    return true;
  }, []);

  const appendContextNotice = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    appendLocalEntry(createVoiceNoticeEntry(nextEntryId('context'), clean));
  }, [appendLocalEntry, nextEntryId]);

  const sendRealtimeContextHandoff = useCallback(() => {
    const handoff = pendingContextHandoffRef.current;
    if (!handoff || contextHandoffSentRef.current) return;
    if (!sendRealtimeEvent(createRealtimeContextItem(handoff))) return;
    contextHandoffSentRef.current = true;
    if (handoff.warning) {
      setCloudEvent(handoff.warning);
      appendContextNotice(handoff.warning);
    } else {
      setCloudEvent('Realtime voice has current context.');
    }
  }, [appendContextNotice, sendRealtimeEvent]);

  const setMode = useCallback((nextMode: VoiceMode) => {
    if (state !== 'idle' && state !== 'error') return;
    modeRef.current = nextMode;
    setModeState(nextMode);
    setCloudEvent(nextMode === 'realtime'
      ? 'Realtime 2 voice selected.'
      : 'Turn-based voice selected.');
  }, [state]);

  const toggleMode = useCallback(() => {
    setMode(modeRef.current === 'realtime' ? 'turn' : 'realtime');
  }, [setMode]);

  const cancelRealtimeOutput = useCallback(() => {
    if (!outputActiveRef.current) return;
    sendRealtimeEvent({ type: 'response.cancel' });
    outputActiveRef.current = false;
    finishAssistantEntry();
  }, [finishAssistantEntry, sendRealtimeEvent]);

  const handleRealtimeFunctionCalls = useCallback(async (calls: RealtimeFunctionCall[]) => {
    if (calls.length === 0) return;

    setState('thinking');
    for (const call of calls) {
      const args = normalizeRealtimeToolArgs(call.name, call.arguments);
      const normalizedCall = { ...call, arguments: args };
      appendToolCallEntry(normalizedCall);

      let output: unknown;
      let isError = false;
      try {
        const result = await executeWorkspaceTool(call.name, args);
        isError = !result.ok;
        output = result.ok ? result : { ok: false, error: result.error || 'Tool execution failed.' };
      } catch (err) {
        isError = true;
        output = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      finishToolCallEntry(call.callId, realtimeToolResultText(output), isError);
      const sent = sendRealtimeEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify(output),
        },
      });
      if (!sent) {
        setError('Realtime voice data channel closed before tool results could be sent.');
        setState('error');
        return;
      }
    }

    assistantTextRef.current = '';
    setAssistantText('');
    if (!sendRealtimeEvent({ type: 'response.create' })) {
      setError('Realtime voice data channel closed before the tool response could continue.');
      setState('error');
      return;
    }
    setState('thinking');
  }, [appendToolCallEntry, finishToolCallEntry, sendRealtimeEvent]);

  const stop = useCallback(() => {
    sessionIdRef.current += 1;
    outputActiveRef.current = false;
    partialRef.current = '';
    assistantTextRef.current = '';
    const activeUserId = activeUserEntryIdRef.current;
    const activeAssistantId = activeAssistantEntryIdRef.current;
    const activeToolIds = new Set(activeToolEntryIdsRef.current.values());
    if (activeUserId || activeAssistantId || activeToolIds.size > 0) {
      setLocalEntries((prev) => prev.map((entry) => (
        entry.id === activeUserId || entry.id === activeAssistantId || activeToolIds.has(entry.id)
          ? { ...entry, isStreaming: false }
          : entry
      )));
    }
    activeUserEntryIdRef.current = null;
    activeAssistantEntryIdRef.current = null;
    activeToolEntryIdsRef.current.clear();
    pendingContextHandoffRef.current = null;
    contextHandoffSentRef.current = false;

    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    turnWsRef.current?.close();
    turnWsRef.current = null;
    turnWorkletNodeRef.current?.disconnect();
    turnWorkletNodeRef.current = null;
    turnSourceNodeRef.current?.disconnect();
    turnSourceNodeRef.current = null;
    turnMuteNodeRef.current?.disconnect();
    turnMuteNodeRef.current = null;
    if (turnAudioCtxRef.current && turnAudioCtxRef.current.state !== 'closed') {
      turnAudioCtxRef.current.close().catch(() => {});
    }
    turnAudioCtxRef.current = null;
    turnAudioChunksRef.current = [];
    turnSuppressMicRef.current = false;
    turnPlaybackRef.current?.pause();
    turnPlaybackRef.current = null;
    if (turnPlaybackUrlRef.current) {
      URL.revokeObjectURL(turnPlaybackUrlRef.current);
      turnPlaybackUrlRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.srcObject = null;
      audioElementRef.current.remove();
      audioElementRef.current = null;
    }

    setState('idle');
    setPartial('');
    setCloudEvent('');
  }, []);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    switch (event.type) {
      case 'session.created':
        sendRealtimeEvent(createRealtimeSessionUpdate(activeVoiceRef.current));
        setState('connecting');
        break;
      case 'session.updated':
        sendRealtimeContextHandoff();
        setState('listening');
        break;
      case 'input_audio_buffer.speech_started':
        partialRef.current = '';
        activeUserEntryIdRef.current = null;
        setPartial('');
        cancelRealtimeOutput();
        setState('transcribing');
        break;
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
        if (!outputActiveRef.current) setState('thinking');
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const delta = String(event.delta ?? '');
        partialRef.current += delta;
        setPartial(partialRef.current);
        updateUserEntryText(partialRef.current, true);
        setState('transcribing');
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(event.transcript ?? '').trim();
        partialRef.current = '';
        setPartial('');
        if (!text) break;
        setTranscript(text);
        setAssistantText('');
        updateUserEntryText(text, false);
        activeUserEntryIdRef.current = null;
        setState(outputActiveRef.current ? 'speaking' : 'thinking');
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        setError('Realtime transcription failed.');
        setState('error');
        break;
      case 'response.created':
        outputActiveRef.current = true;
        activeAssistantEntryIdRef.current = null;
        assistantTextRef.current = '';
        setAssistantText('');
        ensureAssistantEntry();
        setState('speaking');
        break;
      case 'response.output_item.added':
        outputActiveRef.current = true;
        ensureAssistantEntry();
        setState('speaking');
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
      case 'response.text.delta': {
        const delta = String(event.delta ?? '');
        if (delta) {
          assistantTextRef.current += delta;
          setAssistantText(assistantTextRef.current);
          updateAssistantEntryText(assistantTextRef.current, true);
        }
        outputActiveRef.current = true;
        setState('speaking');
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done':
      case 'response.text.done': {
        const text = String(event.transcript ?? event.text ?? '').trim();
        if (text) {
          assistantTextRef.current = text;
          setAssistantText(text);
          updateAssistantEntryText(text, false);
        }
        break;
      }
      case 'response.output_audio.done':
      case 'response.audio.done':
        outputActiveRef.current = false;
        break;
      case 'response.done':
        outputActiveRef.current = false;
        finishAssistantEntry();
        {
          const functionCalls = getRealtimeFunctionCalls(event);
          if (functionCalls.length > 0) {
            void handleRealtimeFunctionCalls(functionCalls);
            break;
          }
        }
        setState('listening');
        break;
      case 'error':
        if (isBenignRealtimeCancellationError(event)) {
          outputActiveRef.current = false;
          break;
        }
        setError(openAIErrorMessage(event));
        setState('error');
        break;
      default:
        break;
    }
  }, [cancelRealtimeOutput, ensureAssistantEntry, finishAssistantEntry, handleRealtimeFunctionCalls, sendRealtimeContextHandoff, sendRealtimeEvent, updateAssistantEntryText, updateUserEntryText]);

  const playTurnAudio = useCallback(() => {
    const chunks = turnAudioChunksRef.current;
    turnAudioChunksRef.current = [];
    if (chunks.length === 0) {
      finishAssistantEntry();
      setState('listening');
      return;
    }

    turnPlaybackRef.current?.pause();
    if (turnPlaybackUrlRef.current) URL.revokeObjectURL(turnPlaybackUrlRef.current);
    const url = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
    const audio = new Audio(url);
    turnPlaybackRef.current = audio;
    turnPlaybackUrlRef.current = url;
    turnSuppressMicRef.current = true;
    setState('speaking');
    audio.onended = () => {
      turnSuppressMicRef.current = false;
      if (turnPlaybackRef.current === audio) turnPlaybackRef.current = null;
      if (turnPlaybackUrlRef.current === url) {
        URL.revokeObjectURL(url);
        turnPlaybackUrlRef.current = null;
      }
      finishAssistantEntry();
      setState('listening');
    };
    audio.onerror = () => {
      turnSuppressMicRef.current = false;
      finishAssistantEntry();
      setState('listening');
    };
    audio.play().catch(() => {
      turnSuppressMicRef.current = false;
      finishAssistantEntry();
      setState('listening');
    });
  }, [finishAssistantEntry]);

  const startRealtimeVoice = useCallback(async (sessionId: number) => {
    if (!('RTCPeerConnection' in window) || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support Realtime voice.');
      setState('error');
      return;
    }

    const [selectedVoice, contextHandoff] = await Promise.all([
      fetchRealtimeVoicePreference(),
      loadRealtimeContextHandoff(contextEntriesRef.current),
    ]);
    activeVoiceRef.current = selectedVoice;
    pendingContextHandoffRef.current = contextHandoff;
    contextHandoffSentRef.current = false;
    if (sessionIdRef.current !== sessionId) return;

    const clientSecret = await createRealtimeClientSecret({
      voice: selectedVoice,
      ttlSeconds: 600,
    });
    if (sessionIdRef.current !== sessionId) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audioElementRef.current = audio;
    document.body.appendChild(audio);

    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0];
      audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (sessionIdRef.current !== sessionId) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setError('Realtime voice connection failed.');
        setState('error');
      }
    };

    for (const track of stream.getAudioTracks()) {
      pc.addTrack(track, stream);
    }

    const dc = pc.createDataChannel('oai-events');
    dcRef.current = dc;
    dc.onopen = () => {
      if (sessionIdRef.current !== sessionId) return;
      sendRealtimeEvent(createRealtimeSessionUpdate(activeVoiceRef.current));
      setState('connecting');
    };
    dc.onmessage = (message) => {
      try {
        handleRealtimeEvent(JSON.parse(String(message.data)) as RealtimeEvent);
      } catch {
        // Ignore malformed Realtime events.
      }
    };
    dc.onerror = () => {
      setError('Realtime voice data channel failed.');
      setState('error');
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (sessionIdRef.current !== sessionId) return;
    if (!offer.sdp) throw new Error('Could not create a Realtime voice offer.');

    const answerResponse = await fetch(OPENAI_REALTIME_CALLS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });
    if (!answerResponse.ok) {
      throw new Error(await readRealtimeAnswerError(answerResponse));
    }

    await pc.setRemoteDescription({
      type: 'answer',
      sdp: await answerResponse.text(),
    });
  }, [handleRealtimeEvent, sendRealtimeEvent]);

  const startTurnVoice = useCallback(async (sessionId: number) => {
    if (!navigator.mediaDevices?.getUserMedia || !('AudioContext' in window) || !('WebSocket' in window)) {
      setError('This browser does not support turn-based voice.');
      setState('error');
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: TURN_VOICE_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    const audioCtx = new AudioContext({ sampleRate: TURN_VOICE_SAMPLE_RATE });
    turnAudioCtxRef.current = audioCtx;
    const workletUrl = URL.createObjectURL(new Blob([PCM_CAPTURE_WORKLET_CODE], { type: 'application/javascript' }));
    await audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    const source = audioCtx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
    const muteNode = audioCtx.createGain();
    muteNode.gain.value = 0;
    turnSourceNodeRef.current = source;
    turnWorkletNodeRef.current = workletNode;
    turnMuteNodeRef.current = muteNode;
    source.connect(workletNode);
    workletNode.connect(muteNode);
    muteNode.connect(audioCtx.destination);

    const ws = new WebSocket(getTurnVoiceWsUrl());
    ws.binaryType = 'arraybuffer';
    turnWsRef.current = ws;
    turnAudioChunksRef.current = [];

    ws.onopen = () => {
      if (sessionIdRef.current !== sessionId) return;
      setCloudEvent('Turn-based voice uses the normal agent path.');
      setState('listening');
      workletNode.port.onmessage = (event: MessageEvent) => {
        if (ws.readyState !== WebSocket.OPEN || turnSuppressMicRef.current) return;
        ws.send(floatToPcm16(event.data as Float32Array));
      };
    };
    ws.onmessage = (message) => {
      if (message.data instanceof ArrayBuffer) {
        turnAudioChunksRef.current.push(message.data);
        setState('speaking');
        return;
      }

      try {
        const event = JSON.parse(String(message.data)) as Record<string, unknown>;
        const type = String(event.type || '');
        if (type === 'partial') {
          const text = String(event.text || '');
          partialRef.current = text;
          setPartial(text);
          updateUserEntryText(text, true);
        } else if (type === 'transcript') {
          const text = String(event.text || '').trim();
          partialRef.current = '';
          setPartial('');
          if (text) {
            setTranscript(text);
            updateUserEntryText(text, false);
            activeUserEntryIdRef.current = null;
          }
          setState('thinking');
        } else if (type === 'assistant_text') {
          const text = String(event.text || '').trim();
          if (text) {
            assistantTextRef.current = text;
            setAssistantText(text);
            updateAssistantEntryText(text, true);
          }
        } else if (type === 'thinking') {
          setState('thinking');
        } else if (type === 'speaking') {
          setState('speaking');
        } else if (type === 'listening') {
          playTurnAudio();
        } else if (type === 'error') {
          setError(String(event.message || 'Turn-based voice error'));
          setState('error');
        }
      } catch {
        // Ignore malformed turn-based voice events.
      }
    };
    ws.onerror = () => {
      setError('Turn-based voice connection failed.');
      setState('error');
    };
    ws.onclose = () => {
      if (sessionIdRef.current === sessionId) stop();
    };
  }, [playTurnAudio, stop, updateAssistantEntryText, updateUserEntryText]);

  const start = useCallback(async () => {
    if (state !== 'idle' && state !== 'error') return;

    setState('connecting');
    setError(null);
    setPartial('');
    setTranscript('');
    setAssistantText('');
    setCloudEvent('');

    const sessionId = sessionIdRef.current + 1;
    sessionIdRef.current = sessionId;
    try {
      if (modeRef.current === 'turn') {
        await startTurnVoice(sessionId);
      } else {
        await startRealtimeVoice(sessionId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mic access denied');
      setState('error');
      stop();
    }
  }, [startRealtimeVoice, startTurnVoice, state, stop]);

  return { state, mode, partial, transcript, assistantText, localEntries, cloudEvent, start, stop, setMode, toggleMode, error };
}

const LOCAL_VOICE_ENTRY_LIMIT = 80;

async function loadRealtimeContextHandoff(contextEntries: AwarenessEntry[]): Promise<RealtimeContextHandoff | null> {
  try {
    const backlog = await fetchAwarenessBacklog(REALTIME_CONTEXT_BACKLOG_LIMIT);
    const entries = mergeRealtimeContextEntries(
      parseRealtimeContextBacklog(backlog.lines),
      contextEntries,
    );
    return buildRealtimeContextHandoff(entries, {
      model: REALTIME_MODEL,
      totalEntryCount: Math.max(backlog.total, entries.length),
    });
  } catch {
    return buildRealtimeContextHandoff(contextEntries, {
      model: REALTIME_MODEL,
      totalEntryCount: contextEntries.length,
    });
  }
}

function getTurnVoiceWsUrl(): string {
  const url = new URL(apiUrl('/voice/stream'), window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function floatToPcm16(float32: Float32Array): ArrayBuffer {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16.buffer;
}

function createVoiceUserEntry(id: string, text: string, isStreaming: boolean): AwarenessEntry {
  return {
    id,
    type: 'message',
    timestamp: new Date().toISOString(),
    role: 'user',
    content: text ? [{ type: 'text', text }] : [],
    channel: 'voice',
    userName: 'you',
    strippedText: text,
    isStreaming,
  };
}

function createVoiceAssistantEntry(id: string, text: string, isStreaming: boolean): AwarenessEntry {
  return {
    id,
    type: 'message',
    timestamp: new Date().toISOString(),
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    model: REALTIME_MODEL,
    isStreaming,
  };
}

function createVoiceNoticeEntry(id: string, text: string): AwarenessEntry {
  return {
    id,
    type: 'message',
    timestamp: new Date().toISOString(),
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: REALTIME_MODEL,
    isStreaming: false,
  };
}

function createVoiceToolEntry(id: string, call: RealtimeFunctionCall, isStreaming: boolean): AwarenessEntry {
  return {
    id,
    type: 'message',
    timestamp: new Date().toISOString(),
    role: 'assistant',
    content: [{ type: 'toolCall', id: call.callId, name: call.name, arguments: call.arguments }],
    model: REALTIME_MODEL,
    isStreaming,
  };
}

function getRealtimeFunctionCalls(event: RealtimeEvent): RealtimeFunctionCall[] {
  const response = isRecord(event.response) ? event.response : undefined;
  const output = Array.isArray(response?.output) ? response.output : [];
  const calls: RealtimeFunctionCall[] = [];

  for (const item of output) {
    if (!isRecord(item) || item.type !== 'function_call') continue;
    const callId = typeof item.call_id === 'string' ? item.call_id : '';
    const name = typeof item.name === 'string' ? item.name : '';
    if (!callId || !name) continue;
    calls.push({
      callId,
      name,
      arguments: parseRealtimeFunctionArguments(item.arguments),
    });
  }

  return calls;
}

function parseRealtimeFunctionArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRealtimeToolArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };
  if (tool === 'edit') {
    if (typeof next.oldText !== 'string' && typeof next.old_text === 'string') next.oldText = next.old_text;
    if (typeof next.newText !== 'string' && typeof next.new_text === 'string') next.newText = next.new_text;
  }
  if (typeof next.label !== 'string' || !next.label.trim()) {
    next.label = `Realtime ${tool}`;
  }
  return next;
}

function realtimeToolResultText(output: unknown): string {
  if (isRecord(output) && output.ok === false) {
    const error = output.error;
    return typeof error === 'string' && error.trim() ? error : 'Tool execution failed.';
  }

  const result = isRecord(output) && 'result' in output ? output.result : output;
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : undefined;
  if (content) {
    const text = content
      .map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n');
    if (text.trim()) return text;
  }

  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function realtimeWorkspaceToolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      type: 'function',
      name: 'read',
      description: "Read a file from Zip's workspace when current file contents are necessary for a voice answer.",
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Brief user-facing reason for reading this file.' },
          path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
          offset: { type: 'number', description: 'Optional 1-indexed starting line.' },
          limit: { type: 'number', description: 'Optional maximum number of lines to read.' },
        },
        required: ['label', 'path'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_context_briefing',
      description: "Return a compact briefing of Zip's identity, memory files, and recent persisted activity. Use this before answering questions that depend on TinyFat or Zip context.",
      parameters: {
        type: 'object',
        properties: {
          recentLimit: { type: 'number', description: 'Maximum recent context entries to include. Default 10, max 24.' },
          maxChars: { type: 'number', description: 'Maximum briefing characters. Default 4000, max 8000.' },
        },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'search_context',
      description: "Search Zip's persisted awareness, adapter log, and memory files for prior chats, names, projects, decisions, or specific terms from past context.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Case-insensitive text to search for in Zip's persisted context and chat logs." },
          source: { type: 'string', description: 'Optional source: all, awareness, log, or memory. Defaults to all.' },
          limit: { type: 'number', description: 'Maximum matching entries to return. Default 12, max 30.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

function createRealtimeSessionUpdate(voice: string): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: REALTIME_MODEL,
      output_modalities: ['audio'],
      instructions: [
        "You are Zip, TinyFat's live voice agent.",
        'Speak directly to Alex in a concise, natural voice.',
        'You are running in the TinyFat web workspace voice UI.',
        'You receive a compact current-context handoff when the session starts.',
        'Use get_context_briefing and search_context for TinyFat, Zip, prior-chat, memory, or relationship context instead of guessing.',
        'Use read only when current file contents are necessary for a spoken answer.',
        'Do not write files, edit files, run shell commands, or act like the full normal agent runtime from Realtime voice.',
        'For broad build, edit, verification, or tool-heavy work, tell Alex to use turn-based voice or text chat.',
        'Keep answers tight and spoken. Do not mention transcripts, transport, or implementation details unless Alex asks.',
      ].join('\n'),
      tools: realtimeWorkspaceToolDefinitions(),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_output_tokens: 4096,
      truncation: createRealtimeTruncationConfig(REALTIME_MODEL),
      audio: {
        input: {
          noise_reduction: { type: 'far_field' },
          turn_detection: {
            type: 'server_vad',
            create_response: true,
            interrupt_response: true,
            prefix_padding_ms: 250,
            silence_duration_ms: 450,
            threshold: 0.6,
          },
          transcription: { model: TRANSCRIPTION_MODEL },
        },
        output: {
          voice,
          speed: 1.0,
        },
      },
    },
  };
}

async function readRealtimeAnswerError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await response.json().catch(() => null) as any;
    const message = body?.error?.message || body?.error_description || body?.error;
    if (message) return `Realtime voice failed (${response.status}): ${message}`;
  }
  const text = await response.text().catch(() => '');
  return `Realtime voice failed (${response.status})${text ? `: ${text}` : ''}`;
}

function openAIErrorMessage(event: RealtimeEvent): string {
  const error = event.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  const message = event.message;
  return typeof message === 'string' && message.trim() ? message : 'Realtime voice error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
