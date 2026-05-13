/**
 * useConfig — fetch workspace configuration from the portable console API.
 * Returns display_mode ('terminal' | 'desktop') and agent_name.
 * Retries on 503 (workspace not ready during cold start).
 */

import { useState, useEffect } from 'react';
import { fetchWorkspaceStatus } from '../console-api';

export interface WorkspaceConfig {
  display_mode: 'terminal' | 'desktop';
  agent_name: string;
  capabilities: Record<string, boolean>;
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  display_mode: 'terminal',
  agent_name: 'agent',
  capabilities: { terminal: true, desktop: false, awareness: true, files: true, messages: true },
};

export function useConfig() {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Retry up to 15 times (covers ~30s cold start)
      for (let attempt = 0; attempt < 15; attempt++) {
        if (cancelled) return;
        try {
          const data = await fetchWorkspaceStatus();
          if (!cancelled) {
            setConfig({
              display_mode: data.display_mode === 'desktop' ? 'desktop' : 'terminal',
              agent_name: data.agent_name || 'agent',
              capabilities: data.capabilities || DEFAULT_CONFIG.capabilities,
            });
            setIsLoading(false);
          }
          return;
        } catch (err) {
          if (attempt === 14 && !cancelled) {
            setError(err instanceof Error ? err.message : 'Config error');
            setIsLoading(false);
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return {
    config: config ?? DEFAULT_CONFIG,
    isLoading,
    error,
  };
}
