/** No runtime action until an exact-prompt restore probe is available. */
export interface CacheResumeSettings { enabled: boolean; idleMinutes: number; maxResumeTokens: number; }
export function parseCacheResumeSettings(raw: unknown): CacheResumeSettings {
 const v = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
 const number = (key: string, fallback: number, min: number, max: number) => typeof v[key] === 'number' && Number.isFinite(v[key]) ? Math.max(min, Math.min(max, Math.floor(v[key] as number))) : fallback;
 return {enabled: v.enabled === true, idleMinutes: number('idleMinutes', 15, 1, 1440), maxResumeTokens: number('maxResumeTokens', 5000, 512, 10000)};
}
export function decideCacheResume(settings: CacheResumeSettings, input: {
 interactive: boolean; idleMinutes: number; restore: 'ram' | 'ssd' | 'miss' | 'unknown';
 exactPromptVerified: boolean; checkpointTokens?: number; checkpointCoversTail: boolean;
}): 'unchanged' | 'restore' | 'checkpoint_while_warm' | 'resume_checkpoint' | 'defer_unattended' | 'ask_user' {
 if (!settings.enabled) return 'unchanged';
 if (!input.exactPromptVerified || input.restore === 'unknown') return input.interactive ? 'ask_user' : 'defer_unattended';
 if (input.restore === 'ram' && !input.interactive && input.idleMinutes >= settings.idleMinutes) return 'checkpoint_while_warm';
 if (input.restore === 'ram' || input.restore === 'ssd') return 'restore';
 if (input.checkpointCoversTail && input.checkpointTokens !== undefined && input.checkpointTokens <= settings.maxResumeTokens) return 'resume_checkpoint';
 return input.interactive ? 'ask_user' : 'defer_unattended';
}
