/**
 * useVoiceChat - browser mic capture + OpenAI Realtime WebRTC voice agent.
 *
 * Realtime owns the live voice turn. This hook does not bridge completed
 * transcripts into the text /web/chat agent path.
 */

import { useState, useRef, useCallback } from 'react';
import { createRealtimeClientSecret } from '../console-api';

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const REALTIME_MODEL = 'gpt-realtime-2';
const TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
const DEFAULT_REALTIME_VOICE = 'marin';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export interface UseVoiceChatReturn {
  state: VoiceState;
  partial: string;
  transcript: string;
  assistantText: string;
  cloudEvent: string;
  start: () => Promise<void>;
  stop: () => void;
  error: string | null;
}

type RealtimeEvent = Record<string, unknown> & { type?: string };

export function useVoiceChat(): UseVoiceChatReturn {
  const [state, setState] = useState<VoiceState>('idle');
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [cloudEvent, setCloudEvent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const outputActiveRef = useRef(false);
  const partialRef = useRef('');
  const sessionIdRef = useRef(0);

  const sendRealtimeEvent = useCallback((event: Record<string, unknown>): boolean => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify(event));
    return true;
  }, []);

  const cancelRealtimeOutput = useCallback(() => {
    if (!outputActiveRef.current) return;
    sendRealtimeEvent({ type: 'response.cancel' });
    outputActiveRef.current = false;
  }, [sendRealtimeEvent]);

  const stop = useCallback(() => {
    sessionIdRef.current += 1;
    outputActiveRef.current = false;
    partialRef.current = '';

    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
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
        sendRealtimeEvent(createRealtimeSessionUpdate(DEFAULT_REALTIME_VOICE));
        setState('connecting');
        break;
      case 'session.updated':
        setState('listening');
        break;
      case 'input_audio_buffer.speech_started':
        partialRef.current = '';
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
        setState(outputActiveRef.current ? 'speaking' : 'thinking');
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        setError('Realtime transcription failed.');
        setState('error');
        break;
      case 'response.created':
        outputActiveRef.current = true;
        setAssistantText('');
        setState('speaking');
        break;
      case 'response.output_item.added':
        outputActiveRef.current = true;
        setState('speaking');
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
      case 'response.text.delta': {
        const delta = String(event.delta ?? '');
        if (delta) setAssistantText((prev) => prev + delta);
        outputActiveRef.current = true;
        setState('speaking');
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done':
      case 'response.text.done': {
        const text = String(event.transcript ?? event.text ?? '').trim();
        if (text) setAssistantText(text);
        break;
      }
      case 'response.done':
      case 'response.output_audio.done':
      case 'response.audio.done':
        outputActiveRef.current = false;
        setState('listening');
        break;
      case 'error':
        setError(openAIErrorMessage(event));
        setState('error');
        break;
      default:
        break;
    }
  }, [cancelRealtimeOutput, sendRealtimeEvent]);

  const start = useCallback(async () => {
    if (state !== 'idle' && state !== 'error') return;
    if (!('RTCPeerConnection' in window) || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support Realtime voice.');
      setState('error');
      return;
    }

    setState('connecting');
    setError(null);
    setPartial('');
    setTranscript('');
    setAssistantText('');
    setCloudEvent('');

    const sessionId = sessionIdRef.current + 1;
    sessionIdRef.current = sessionId;
    try {
      const clientSecret = await createRealtimeClientSecret({
        voice: DEFAULT_REALTIME_VOICE,
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
      audio.playsInline = true;
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
        sendRealtimeEvent(createRealtimeSessionUpdate(DEFAULT_REALTIME_VOICE));
        setState('listening');
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mic access denied');
      setState('error');
      stop();
    }
  }, [handleRealtimeEvent, sendRealtimeEvent, state, stop]);

  return { state, partial, transcript, assistantText, cloudEvent, start, stop, error };
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
        'For this first shipped slice, you have no tools. If the user asks you to build, deploy, inspect files, or change state, say briefly that voice actions are not wired yet and ask them to use text chat for that action.',
        'Do not mention transcripts, transport, or implementation details unless Alex asks.',
      ].join('\n'),
      tools: [],
      tool_choice: 'none',
      parallel_tool_calls: false,
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
