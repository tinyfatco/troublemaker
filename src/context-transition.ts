import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
export interface ContextTransition {
 version: 1; id: string; kind: 'handoff' | 'compaction';
 trigger: 'agent' | 'user' | 'context_limit' | 'idle_closeout' | 'cache_recovery';
 state: 'preparing' | 'completed' | 'failed' | 'aborted' | 'skipped';
 revision: number; startedAt: string; updatedAt: string;
 tokensBefore?: number; tokensAfter?: number; retainedMessages?: number;
}
export function transitionPath(workspace: string): string { return join(workspace, 'awareness', 'context-transitions.json'); }
export function readContextTransitions(workspace: string): ContextTransition[] {
 const path = transitionPath(workspace);
 if (!existsSync(path)) return [];
 const value = JSON.parse(readFileSync(path, 'utf8'));
 if (!Array.isArray(value)) throw new Error('Invalid context transition store');
 return value;
}
/** Publish only bounded public metadata, never the private summary or archive path. */
export function saveContextTransition(workspace: string, value: ContextTransition): void {
 const entries = readContextTransitions(workspace);
 const old = entries.find(x => x.id === value.id);
 if (old && old.revision >= value.revision) return;
 if (old && old.state !== 'preparing') return;
 const path = transitionPath(workspace); mkdirSync(dirname(path), { recursive: true });
 const next = [...entries.filter(x => x.id !== value.id), value].sort((a,b) => a.startedAt.localeCompare(b.startedAt));
 const temporary = `${path}.tmp`; const fd = openSync(temporary, 'w', 0o600);
 try { writeFileSync(fd, JSON.stringify(next.slice(-512))); fsyncSync(fd); } finally { closeSync(fd); }
 renameSync(temporary, path);
 const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
