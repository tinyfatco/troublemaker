/**
 * WorkspaceLayout — chat plus a movable agent canvas.
 *
 * Left:   File explorer (collapsible)
 * Canvas: Terminal, Desktop, Calendar, Preview, or FileViewer
 * Chat:   Awareness stream + chat input
 *
 * Panels are resizable via drag handles.
 */

import { useState, useRef, useCallback, useEffect, type CSSProperties, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfig } from '../hooks/useConfig';
import { useAwarenessStream } from '../hooks/useAwarenessStream';
import { useDisplayProjects } from '../hooks/useDisplayProjects';
import { usePersistentState } from '../hooks/usePersistentState';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { TerminalPane } from './TerminalPane';
import { DesktopPane } from './DesktopPane';
import { CalendarPane } from './CalendarPane';
import { DisplayPane } from './DisplayPane';
import { AwarenessPane } from './AwarenessPane';
import { UploadZone } from './UploadZone';
import { HeaderStatus } from './HeaderStatus';
import { isEmbedMode } from '../console-api';

type BuiltInCanvasMode = 'terminal' | 'desktop' | 'calendar' | 'preview';
type CanvasMode = BuiltInCanvasMode | `project:${string}`;
type CanvasPlacement = 'left' | 'right' | 'top' | 'bottom';

const CANVAS_PLACEMENTS: CanvasPlacement[] = ['left', 'top', 'right', 'bottom'];
const MIN_CANVAS_SPLIT = 8;
const MAX_CANVAS_SPLIT = 92;
const BUILT_IN_CANVAS_MODES: BuiltInCanvasMode[] = ['terminal', 'desktop', 'calendar', 'preview'];

function clampCanvasSplit(value: number): number {
  return Math.max(MIN_CANVAS_SPLIT, Math.min(MAX_CANVAS_SPLIT, value));
}

function parseCanvasMode(value: unknown): CanvasMode | null {
  if (typeof value !== 'string') return null;
  if (BUILT_IN_CANVAS_MODES.includes(value as BuiltInCanvasMode)) return value as BuiltInCanvasMode;
  if (/^project:[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) return value as `project:${string}`;
  return null;
}

function parseCanvasModePreference(value: unknown): CanvasMode | null {
  return value === null ? null : parseCanvasMode(value);
}

function parseCanvasPlacement(value: unknown): CanvasPlacement | null {
  return typeof value === 'string' && CANVAS_PLACEMENTS.includes(value as CanvasPlacement)
    ? value as CanvasPlacement
    : null;
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseNumberInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : null;
}

function projectCanvasMode(projectId: string): CanvasMode {
  return `project:${projectId}`;
}

function projectIdFromCanvasMode(mode: CanvasMode | null): string | null {
  return typeof mode === 'string' && mode.startsWith('project:')
    ? mode.slice('project:'.length)
    : null;
}

export function WorkspaceLayout() {
  const embedMode = isEmbedMode();
  const { config, isLoading: configLoading } = useConfig();
  const awarenessStream = useAwarenessStream();
  const displayProjectsQuery = useDisplayProjects(!embedMode);
  const displayProjects = displayProjectsQuery.data?.projects ?? [];
  const [canvasModeOverride, setCanvasModeOverride] = usePersistentState<CanvasMode | null>(
    'troublemaker.ui.canvasMode',
    null,
    { parse: parseCanvasModePreference },
  );
  const capabilities = config.capabilities || {};
  const filesAvailable = !embedMode && capabilities.files !== false;
  const terminalAvailable = !embedMode && capabilities.terminal !== false;
  const desktopAvailable = !embedMode && capabilities.desktop === true;
  const calendarAvailable = !embedMode && capabilities.calendar !== false;
  const displayAvailable = !embedMode && capabilities.display !== false;
  const interactiveMode =
    config.display_mode === 'desktop' && desktopAvailable
      ? 'desktop'
      : terminalAvailable
        ? 'terminal'
        : desktopAvailable
          ? 'desktop'
          : null;
  const canvasModes = [
    { mode: 'terminal' as const, available: terminalAvailable, title: 'Terminal canvas' },
    { mode: 'desktop' as const, available: desktopAvailable, title: 'Desktop canvas' },
    { mode: 'calendar' as const, available: calendarAvailable, title: 'Calendar canvas' },
    { mode: 'preview' as const, available: displayAvailable, title: 'Display projects' },
  ];
  const isCanvasModeAvailable = (mode: CanvasMode | null): mode is CanvasMode => {
    if (!mode) return false;
    const projectId = projectIdFromCanvasMode(mode);
    if (projectId) return displayProjects.some((project) => project.id === projectId);
    return canvasModes.some((item) => item.mode === mode && item.available);
  };
  const requestedCanvasMode = canvasModeOverride ?? interactiveMode ?? 'calendar';
  const canvasMode = isCanvasModeAvailable(requestedCanvasMode)
    ? requestedCanvasMode
    : canvasModes.find((item) => item.available)?.mode ?? null;
  const selectedDisplayProjectId = projectIdFromCanvasMode(canvasMode);
  const selectedDisplayProject = selectedDisplayProjectId
    ? displayProjects.find((project) => project.id === selectedDisplayProjectId) ?? null
    : null;
  const hasCanvas = !embedMode && (canvasModes.some((item) => item.available) || displayProjects.length > 0);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState(
    'troublemaker.ui.sidebarCollapsed',
    true,
    { parse: parseBoolean },
  );
  const [awarenessCollapsed, setAwarenessCollapsed] = usePersistentState(
    'troublemaker.ui.awarenessCollapsed',
    false,
    { parse: parseBoolean },
  );
  const [canvasCollapsed, setCanvasCollapsed] = usePersistentState(
    'troublemaker.ui.canvasCollapsed',
    true,
    { parse: parseBoolean },
  );
  const [canvasPlacement, setCanvasPlacement] = usePersistentState<CanvasPlacement>(
    'troublemaker.ui.canvasPlacement',
    'left',
    { parse: parseCanvasPlacement },
  );
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = usePersistentState(
    'troublemaker.ui.sidebarWidth',
    220,
    { parse: (value) => parseNumberInRange(value, 160, 400) },
  );
  const [canvasSplitPercent, setCanvasSplitPercent] = usePersistentState(
    'troublemaker.ui.canvasSplitPercent',
    58,
    { parse: (value) => parseNumberInRange(value, MIN_CANVAS_SPLIT, MAX_CANVAS_SPLIT) },
  );

  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'sidebar' | 'canvas' | null>(null);

  // File upload — target the currently-selected directory, or 'attachments' by default
  const uploadTargetDir = selectedPath
    ? (selectedPath.includes('.') ? selectedPath.split('/').slice(0, -1).join('/') || 'attachments' : selectedPath)
    : 'attachments';

  const upload = UploadZone({
    targetDir: uploadTargetDir,
    onUploaded: () => {
      // Invalidate all file tree queries to refresh
      queryClient.invalidateQueries({ queryKey: ['files'] });
    },
  });
  const uploadEnabled = filesAvailable;

  const handleFileSelect = (path: string) => {
    setSelectedPath(path);
    setViewingFile(path);
    setCanvasCollapsed(false);
    setMobileDrawerOpen(false);
  };

  const closeFileViewer = () => {
    setViewingFile(null);
  };

  const toggleSidebar = () => {
    if (!filesAvailable) return;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
      setMobileDrawerOpen(!mobileDrawerOpen);
    } else {
      setSidebarCollapsed(!sidebarCollapsed);
    }
  };

  const toggleAwareness = () => {
    setAwarenessCollapsed(!awarenessCollapsed);
  };

  const toggleTheme = () => {
    const newDark = !isDark;
    document.documentElement.classList.toggle('dark', newDark);
    localStorage.setItem('theme', newDark ? 'dark' : 'light');
    setIsDark(newDark);
  };

  // Drag resize handlers
  const handleSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = 'sidebar';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleCanvasDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = 'canvas';
    document.body.style.cursor = canvasPlacement === 'top' || canvasPlacement === 'bottom'
      ? 'row-resize'
      : 'col-resize';
    document.body.style.userSelect = 'none';
  }, [canvasPlacement]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();

      if (draggingRef.current === 'sidebar') {
        setSidebarWidth(Math.max(160, Math.min(400, e.clientX - rect.left)));
      } else if (draggingRef.current === 'canvas') {
        let canvasPixels: number;
        let totalPixels: number;

        switch (canvasPlacement) {
          case 'right':
            canvasPixels = rect.right - e.clientX;
            totalPixels = rect.width;
            break;
          case 'top':
            canvasPixels = e.clientY - rect.top;
            totalPixels = rect.height;
            break;
          case 'bottom':
            canvasPixels = rect.bottom - e.clientY;
            totalPixels = rect.height;
            break;
          case 'left':
          default:
            canvasPixels = e.clientX - rect.left;
            totalPixels = rect.width;
            break;
        }

        if (totalPixels > 0) {
          setCanvasSplitPercent(clampCanvasSplit((canvasPixels / totalPixels) * 100));
        }
      }
    };

    const handleMouseUp = () => {
      draggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [canvasPlacement]);

  const showCanvasMode = (mode: CanvasMode) => {
    if (!isCanvasModeAvailable(mode)) return;
    setCanvasModeOverride(mode);
    setViewingFile(null);
    setCanvasCollapsed(false);
  };

  const toggleCanvas = () => {
    if (!hasCanvas) return;
    const next = !canvasCollapsed;
    setCanvasCollapsed(next);
    // If hiding canvas and chat is also hidden, show chat.
    if (next && awarenessCollapsed) {
      setAwarenessCollapsed(false);
    }
  };

  const CanvasControls = () => (
    <div className="workspace-controls" aria-label="Workspace view controls">
      {hasCanvas && (
        <button
          className={`workspace-control-btn workspace-toggle-btn ${!canvasCollapsed ? 'active' : ''}`}
          onClick={toggleCanvas}
          title={canvasCollapsed ? 'Show canvas' : 'Hide canvas'}
        >
          Canvas
        </button>
      )}
      <div className="workspace-mode-switcher" role="group" aria-label="Canvas views">
        {canvasModes.map((item) => (
          <button
            key={item.mode}
            className={`workspace-control-btn workspace-mode-btn ${canvasMode === item.mode && !canvasCollapsed ? 'active' : ''}`}
            onClick={() => showCanvasMode(item.mode)}
            title={item.title}
            disabled={!item.available}
          >
            {canvasModeLabel(item.mode)}
          </button>
        ))}
        {displayProjects.map((project) => {
          const mode = projectCanvasMode(project.id);
          return (
            <button
              key={project.id}
              className={`workspace-control-btn workspace-mode-btn display-project-btn ${canvasMode === mode && !canvasCollapsed ? 'active' : ''}`}
              onClick={() => showCanvasMode(mode)}
              title={project.title}
              style={{ '--display-project-accent': project.accent || 'var(--accent)' } as CSSProperties}
            >
              {project.title}
            </button>
          );
        })}
      </div>
      {!canvasCollapsed && hasCanvas && (
        <label className="canvas-placement-control">
          <span>Side</span>
          <select
            value={canvasPlacement}
            onChange={(event) => setCanvasPlacement(event.target.value as CanvasPlacement)}
            aria-label="Canvas placement"
          >
            {CANVAS_PLACEMENTS.map((placement) => (
              <option key={placement} value={placement}>
                {placement}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        className={`workspace-control-btn workspace-toggle-btn ${!awarenessCollapsed ? 'active' : ''}`}
        onClick={toggleAwareness}
        title={awarenessCollapsed ? 'Show chat' : 'Hide chat'}
      >
        Chat
      </button>
      <button className="workspace-control-btn workspace-toggle-btn" onClick={toggleTheme} title="Toggle theme">
        {isDark ? 'Light' : 'Dark'}
      </button>
    </div>
  );

  const isCanvasVertical = canvasPlacement === 'top' || canvasPlacement === 'bottom';
  const canvasFirst = canvasPlacement === 'left' || canvasPlacement === 'top';
  const showCanvas = !canvasCollapsed && hasCanvas;
  const canvasStyle: CSSProperties = showCanvas
    ? { flex: `0 0 ${canvasSplitPercent}%` }
    : {};
  const chatStyle: CSSProperties = showCanvas
    ? { flex: `0 0 ${100 - canvasSplitPercent}%` }
    : { flex: 1 };

  let canvasPanelContent: ReactNode;
  if (viewingFile) {
    canvasPanelContent = <FileViewer path={viewingFile} onClose={closeFileViewer} />;
  } else if (configLoading && !canvasModeOverride) {
    canvasPanelContent = (
      <div className="desktop-pane">
        <div className="desktop-placeholder">
          <span className="tool-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
        </div>
      </div>
    );
  } else if (!canvasMode) {
    canvasPanelContent = (
      <div className="desktop-pane">
        <div className="desktop-placeholder">Canvas unavailable</div>
      </div>
    );
  } else if (canvasMode === 'desktop') {
    canvasPanelContent = <DesktopPane />;
  } else if (canvasMode === 'calendar') {
    canvasPanelContent = <CalendarPane />;
  } else if (canvasMode === 'preview') {
    canvasPanelContent = (
      <CanvasPlaceholder
        title="Display"
        subtitle={displayProjectsQuery.isLoading ? 'Loading display projects...' : 'Add projects in display/projects'}
      />
    );
  } else if (selectedDisplayProject) {
    canvasPanelContent = <DisplayPane project={selectedDisplayProject} />;
  } else {
    canvasPanelContent = <TerminalPane />;
  }

  const canvasRegion = showCanvas ? (
    <div className="canvas-panel" style={canvasStyle}>
      {canvasPanelContent}
    </div>
  ) : null;

  const chatRegion = !awarenessCollapsed ? (
    <div className="awareness-sidebar" style={chatStyle}>
      <AwarenessPane
        stream={awarenessStream}
        agentName={config.agent_name}
        allowCommands={!embedMode}
        allowSettings={!embedMode}
        allowVoice={!embedMode && capabilities.voice !== false}
        showChannels={!embedMode}
      />
    </div>
  ) : null;

  const canvasResizeHandle = showCanvas && !awarenessCollapsed
    ? (
      <div
        className={`resize-handle canvas-split-handle ${isCanvasVertical ? 'resize-handle-vertical' : ''}`}
        onMouseDown={handleCanvasDragStart}
      />
    )
    : null;

  return (
    <div className={`workspace-root ${embedMode ? 'embed-mode' : ''}`}>
      <header className="workspace-header">
        <div className="header-left">
          {filesAvailable && (
            <button
              className={`header-btn header-text-btn ${!sidebarCollapsed || mobileDrawerOpen ? 'active' : ''}`}
              onClick={toggleSidebar}
              title="Toggle files"
            >
              Files
            </button>
          )}
          {embedMode ? (
            <div className="embed-brand" aria-label={config.agent_name}>
              <span className="embed-brand-mark">TF</span>
              <span className="embed-brand-copy">
                <span className="embed-brand-title">{config.agent_name}</span>
              </span>
            </div>
          ) : (
            <CanvasControls />
          )}
        </div>
        <div className="header-right">
          <HeaderStatus stream={awarenessStream} />
        </div>
      </header>

      {uploadEnabled && upload.FileInput}
      <div className="workspace-body" ref={containerRef} {...(uploadEnabled ? upload.dragProps : {})}>
        {/* Left: File Explorer */}
        {filesAvailable && !sidebarCollapsed && (
          <>
            <div className="sidebar-panel" style={{ width: sidebarWidth }}>
              <div className="sidebar-header">
                <span className="sidebar-title">Files</span>
                <button className="upload-btn" onClick={upload.openFilePicker} title="Upload files" disabled={upload.uploading}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
              <FileTree selectedPath={selectedPath} onFileSelect={handleFileSelect} />
            </div>
            <div className="resize-handle" onMouseDown={handleSidebarDragStart} />
          </>
        )}

        <div className={`workspace-surface canvas-${canvasPlacement}`}>
          {canvasFirst && canvasRegion}
          {!canvasFirst && chatRegion}
          {canvasResizeHandle}
          {!canvasFirst && canvasRegion}
          {canvasFirst && chatRegion}
          {awarenessCollapsed && !showCanvas && (
            <div className="workspace-empty-surface">
              <span>Open chat or canvas</span>
            </div>
          )}
          </div>
      </div>

      {/* Upload drag overlay */}
      {uploadEnabled && upload.isDragging && (
        <div className="upload-overlay">
          <div className="upload-overlay-content">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Drop files to upload</span>
          </div>
        </div>
      )}

      {/* Upload progress/error toast */}
      {uploadEnabled && upload.uploading && (
        <div className="upload-toast">Uploading...</div>
      )}
      {uploadEnabled && upload.error && (
        <div className="upload-toast upload-toast-error">{upload.error}</div>
      )}

      {/* Mobile drawer overlay */}
      {filesAvailable && mobileDrawerOpen && (
        <>
          <div className="mobile-overlay" onClick={() => setMobileDrawerOpen(false)} />
          <div className="mobile-drawer">
            <div className="sidebar-header">
              <span className="sidebar-title">Files</span>
            </div>
            <FileTree selectedPath={selectedPath} onFileSelect={handleFileSelect} />
          </div>
        </>
      )}
    </div>
  );
}

function canvasModeLabel(mode: BuiltInCanvasMode): string {
  switch (mode) {
    case 'desktop':
      return 'Desktop';
    case 'calendar':
      return 'Calendar';
    case 'preview':
      return 'Display';
    case 'terminal':
    default:
      return 'Terminal';
  }
}

function CanvasPlaceholder({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="canvas-placeholder">
      <div className="canvas-placeholder-icon">
        <CanvasModeIcon mode={title === 'Calendar' ? 'calendar' : 'preview'} />
      </div>
      <div className="canvas-placeholder-copy">
        <span className="canvas-placeholder-title">{title}</span>
        <span className="canvas-placeholder-subtitle">{subtitle}</span>
      </div>
    </div>
  );
}

function CanvasModeIcon({ mode }: { mode: BuiltInCanvasMode }) {
  if (mode === 'desktop') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="2" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <path d="M4 14h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (mode === 'calendar') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="3" width="12" height="11" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <path d="M2 6h12M5 1.5v3M11 1.5v3M5 9h1M8 9h1M11 9h1M5 12h1M8 12h1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (mode === 'preview') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M1.5 8s2.2-4 6.5-4 6.5 4 6.5 4-2.2 4-6.5 4-6.5-4-6.5-4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M4 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 11h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
