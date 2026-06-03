/**
 * useVoiceChat — browser mic capture + Troublemaker Realtime 2 bridge.
 *
 * Captures mic audio as PCM 16-bit 24kHz, streams it to /voice/realtime,
 * receives PCM 24kHz assistant audio back, and renders transcript/control
 * events from the same bridge used by the Mac app.
 */

import { useState, useRef, useCallback } from 'react';
import { apiUrl } from '../api';

const REALTIME_SAMPLE_RATE = 24000;
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

const WORKLET_CODE = `
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

function getRealtimeWsUrl(): string {
  const url = new URL(apiUrl('/voice/realtime'), window.location.href);
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

function pcm16ToFloat32(data: ArrayBuffer): Float32Array {
  const view = new DataView(data);
  const samples = Math.floor(view.byteLength / 2);
  const floats = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    floats[i] = view.getInt16(i * 2, true) / 32768;
  }
  return floats;
}

export function useVoiceChat(): UseVoiceChatReturn {
  const [state, setState] = useState<VoiceState>('idle');
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [cloudEvent, setCloudEvent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const muteNodeRef = useRef<GainNode | null>(null);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playbackCursorRef = useRef(0);
  const suppressMicRef = useRef(false);

  const interruptPlayback = useCallback(() => {
    for (const source of playbackSourcesRef.current) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    playbackSourcesRef.current = [];
    playbackCursorRef.current = audioCtxRef.current?.currentTime || 0;
    suppressMicRef.current = false;
  }, []);

  const playPcm16 = useCallback((data: ArrayBuffer) => {
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state === 'closed' || data.byteLength < 2) return;

    const samples = pcm16ToFloat32(data);
    const buffer = ctx.createBuffer(1, samples.length, REALTIME_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + 0.02, playbackCursorRef.current || 0);
    playbackCursorRef.current = startAt + buffer.duration;
    playbackSourcesRef.current.push(source);
    suppressMicRef.current = true;

    source.onended = () => {
      playbackSourcesRef.current = playbackSourcesRef.current.filter((item) => item !== source);
      if (playbackSourcesRef.current.length === 0) suppressMicRef.current = false;
    };
    source.start(startAt);
  }, []);

  const stop = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ }
      wsRef.current.close();
      wsRef.current = null;
    }

    interruptPlayback();

    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    muteNodeRef.current?.disconnect();
    muteNodeRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;

    setState('idle');
    setPartial('');
    setCloudEvent('');
  }, [interruptPlayback]);

  const start = useCallback(async () => {
    if (state !== 'idle' && state !== 'error') return;

    setState('connecting');
    setError(null);
    setPartial('');
    setTranscript('');
    setAssistantText('');
    setCloudEvent('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: REALTIME_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE });
      audioCtxRef.current = audioCtx;
      playbackCursorRef.current = audioCtx.currentTime;

      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
      workletNodeRef.current = workletNode;
      const muteNode = audioCtx.createGain();
      muteNode.gain.value = 0;
      muteNodeRef.current = muteNode;
      source.connect(workletNode);
      workletNode.connect(muteNode);
      muteNode.connect(audioCtx.destination);

      const ws = new WebSocket(getRealtimeWsUrl());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'start', voice: DEFAULT_REALTIME_VOICE }));
        setState('connecting');
        workletNode.port.onmessage = (event: MessageEvent) => {
          if (ws.readyState !== WebSocket.OPEN || suppressMicRef.current) return;
          ws.send(floatToPcm16(event.data as Float32Array));
        };
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          setState('speaking');
          playPcm16(event.data);
          return;
        }

        try {
          const msg = JSON.parse(String(event.data)) as Record<string, string>;
          switch (msg.type) {
            case 'connecting':
              setState('connecting');
              break;
            case 'listening':
              setState('listening');
              break;
            case 'transcribing':
            case 'barge_in':
              setState('transcribing');
              break;
            case 'thinking':
              setState('thinking');
              break;
            case 'speaking':
              setState('speaking');
              break;
            case 'partial':
              setPartial(msg.text || '');
              break;
            case 'transcript':
              setTranscript(msg.text || '');
              setPartial('');
              setAssistantText('');
              break;
            case 'assistant_text_delta':
              setAssistantText((prev) => prev + (msg.text || ''));
              break;
            case 'assistant_text':
              setAssistantText(msg.text || '');
              break;
            case 'cloud_event':
              setCloudEvent(msg.message || '');
              break;
            case 'interrupt_audio':
              interruptPlayback();
              break;
            case 'error':
              setError(msg.message || 'Realtime voice error');
              setState('error');
              break;
          }
        } catch {
          // Ignore malformed control frames.
        }
      };

      ws.onclose = () => {
        stop();
      };

      ws.onerror = () => {
        setError('Realtime voice connection failed');
        setState('error');
        stop();
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mic access denied');
      setState('error');
      stop();
    }
  }, [state, stop, playPcm16, interruptPlayback]);

  return { state, partial, transcript, assistantText, cloudEvent, start, stop, error };
}
