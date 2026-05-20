import { useCallback, useEffect, useState } from 'react';
import { fetchDisplayPreviewUrl, readFile } from '../../console-api';
import type { DisplayProject } from './displayProjectAdapter';

interface DisplayPaneProps {
  project: DisplayProject;
}

export function DisplayPane({ project }: DisplayPaneProps) {
  if (project.kind === 'html') {
    return <GeneratedHtmlPane project={project} />;
  }

  return <PreviewPane project={project} />;
}

function PreviewPane({ project }: DisplayPaneProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setStatus('loading');
    setError(null);
    setSrc(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      if (!project.preview) {
        setStatus('error');
        setError('Missing preview configuration');
        return;
      }

      try {
        const previewUrl = await fetchDisplayPreviewUrl({
          id: project.id,
          port: project.preview.port,
          path: project.preview.path,
        });
        if (!cancelled) {
          setSrc(previewUrl);
          setStatus('ready');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Preview is unavailable');
          setStatus('error');
        }
      }
    }

    loadPreview();
    return () => { cancelled = true; };
  }, [attempt, project.id, project.preview]);

  if (status === 'error') {
    return (
      <div className="display-pane">
        <DisplayToolbar project={project} src={src} />
        <div className="display-placeholder">
          <span className="display-placeholder-title">{project.title}</span>
          <span className="display-placeholder-subtitle">{error || 'Preview is unavailable'}</span>
          <button className="terminal-reconnect-btn" onClick={retry}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="display-pane">
      <DisplayToolbar project={project} src={src} />
      {status === 'loading' && (
        <div className="display-placeholder">
          <span className="tool-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
          <span className="display-placeholder-subtitle">Opening preview...</span>
        </div>
      )}
      {src && (
        <iframe
          className="display-iframe"
          src={src}
          title={project.title}
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}

function GeneratedHtmlPane({ project }: DisplayPaneProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const entryPath = `${project.projectPath}/${project.entry || 'index.html'}`;

    readFile(entryPath)
      .then((content) => {
        if (!cancelled) {
          setHtml(content);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Display file is unavailable');
        }
      });

    return () => { cancelled = true; };
  }, [project.entry, project.projectPath]);

  return (
    <div className="display-pane">
      <DisplayToolbar project={project} />
      {error && (
        <div className="display-placeholder">
          <span className="display-placeholder-title">{project.title}</span>
          <span className="display-placeholder-subtitle">{error}</span>
        </div>
      )}
      {!error && html === null && (
        <div className="display-placeholder">
          <span className="tool-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
          <span className="display-placeholder-subtitle">Loading display...</span>
        </div>
      )}
      {html !== null && (
        <iframe
          className="display-iframe"
          srcDoc={html}
          title={project.title}
          sandbox="allow-forms allow-modals allow-popups allow-scripts"
        />
      )}
    </div>
  );
}

function DisplayToolbar({ project, src }: { project: DisplayProject; src?: string | null }) {
  return (
    <div className="display-toolbar">
      <div className="display-toolbar-title">
        <span
          className="display-toolbar-dot"
          style={{ backgroundColor: project.accent || 'var(--accent)' }}
        />
        <span>{project.title}</span>
      </div>
      {src && (
        <a className="display-toolbar-link" href={src} target="_blank" rel="noreferrer" title="Open in new tab">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8A1.5 1.5 0 0 0 13 12.5V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M9 2h5v5M8 8l5.5-5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      )}
    </div>
  );
}
