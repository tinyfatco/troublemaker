/**
 * WorkspaceLayout — chat plus a movable agent canvas.
 *
 * Left:   File explorer (collapsible)
 * Canvas: Terminal, Desktop, Calendar, Preview, or FileViewer
 * Chat:   Awareness stream + chat input
 *
 * Panels are resizable via drag handles.
 */

import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfig } from '../hooks/useConfig';
import { useAwarenessStream } from '../hooks/useAwarenessStream';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { TerminalPane } from './TerminalPane';
import { DesktopPane } from './DesktopPane';
import { CalendarPane } from './CalendarPane';
import { AwarenessPane } from './AwarenessPane';
import { UploadZone } from './UploadZone';
import { HeaderStatus } from './HeaderStatus';

type CanvasMode = 'terminal' | 'desktop' | 'calendar' | 'preview';
type CanvasPlacement = 'left' | 'right' | 'top' | 'bottom';

const CANVAS_PLACEMENTS: CanvasPlacement[] = ['left', 'top', 'right', 'bottom'];

export function WorkspaceLayout() {
  const { config, isLoading: configLoading } = useConfig();
  const awarenessStream = useAwarenessStream();
  const [canvasModeOverride, setCanvasModeOverride] = useState<CanvasMode | null>(null);
  const capabilities = config.capabilities || {};
  const terminalAvailable = capabilities.terminal !== false;
  const desktopAvailable = capabilities.desktop === true;
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
    { mode: 'calendar' as const, available: true, title: 'Calendar canvas' },
    { mode: 'preview' as const, available: true, title: 'Preview canvas' },
  ];
  const requestedCanvasMode = canvasModeOverride ?? interactiveMode ?? 'calendar';
  const canvasMode = canvasModes.some((item) => item.mode === requestedCanvasMode && item.available)
    ? requestedCanvasMode
    : canvasModes.find((item) => item.available)?.mode ?? null;
  const hasCanvas = canvasModes.some((item) => item.available);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [awarenessCollapsed, setAwarenessCollapsed] = useState(false);
  const [canvasCollapsed, setCanvasCollapsed] = useState(true);
  const [canvasPlacement, setCanvasPlacement] = useState<CanvasPlacement>('left');
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [awarenessWidth, setAwarenessWidth] = useState(360);

  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'sidebar' | 'awareness' | null>(null);

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

  const handleAwarenessDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = 'awareness';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();

      if (draggingRef.current === 'sidebar') {
        setSidebarWidth(Math.max(160, Math.min(400, e.clientX - rect.left)));
      } else if (draggingRef.current === 'awareness') {
        setAwarenessWidth(Math.max(280, Math.min(600, rect.right - e.clientX)));
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
  }, []);

  const showCanvasMode = (mode: CanvasMode) => {
    const item = canvasModes.find((entry) => entry.mode === mode);
    if (!item?.available) return;
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
    <div className="workspace-controls" aria-label="Canvas controls">
      {hasCanvas && (
        <button
          className={`workspace-control-btn ${!canvasCollapsed ? 'active' : ''}`}
          onClick={toggleCanvas}
          title={canvasCollapsed ? 'Show canvas' : 'Hide canvas'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="14" height="14" rx="1" stroke="currentColor" strokeWidth="1.5" />
            {!canvasCollapsed && (
              <path d="M5 1v14M5 8h10" stroke="currentColor" strokeWidth="1.5" />
            )}
          </svg>
        </button>
      )}
      {canvasModes.map((item) => (
        <button
          key={item.mode}
          className={`workspace-control-btn ${canvasMode === item.mode && !canvasCollapsed ? 'active' : ''}`}
          onClick={() => showCanvasMode(item.mode)}
          title={item.title}
          disabled={!item.available}
        >
          <CanvasModeIcon mode={item.mode} />
        </button>
      ))}
      {!canvasCollapsed && hasCanvas && (
        <div className="canvas-placement-controls" aria-label="Canvas placement">
          {CANVAS_PLACEMENTS.map((placement) => (
            <button
              key={placement}
              className={`workspace-control-btn ${canvasPlacement === placement ? 'active' : ''}`}
              onClick={() => setCanvasPlacement(placement)}
              title={`Canvas ${placement} of chat`}
            >
              <CanvasPlacementIcon placement={placement} />
            </button>
          ))}
        </div>
      )}
      <button
        className={`workspace-control-btn ${!awarenessCollapsed ? 'active' : ''}`}
        onClick={toggleAwareness}
        title={awarenessCollapsed ? 'Show chat' : 'Hide chat'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="9" y="1" width="6" height="14" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <path d="M1 4h5M1 8h5M1 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <button className="workspace-control-btn" onClick={toggleTheme} title="Toggle theme">
        {isDark ? '\u2600' : '\u263D'}
      </button>
    </div>
  );

  const SidebarControls = () => (
    <div className="sidebar-controls" aria-label="Workspace controls">
      <CanvasControls />
    </div>
  );

  const CanvasPanel = () => {
    if (viewingFile) {
      return <FileViewer path={viewingFile} onClose={closeFileViewer} />;
    }
    if (configLoading && !canvasModeOverride) {
      return (
        <div className="desktop-pane">
          <div className="desktop-placeholder">
            <span className="tool-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
          </div>
        </div>
      );
    }
    if (!canvasMode) {
      return (
        <div className="desktop-pane">
          <div className="desktop-placeholder">Canvas unavailable</div>
        </div>
      );
    }
    if (canvasMode === 'desktop') {
      return <DesktopPane />;
    }
    if (canvasMode === 'calendar') {
      return <CalendarPane />;
    }
    if (canvasMode === 'preview') {
      return (
        <CanvasPlaceholder
          title="Preview"
          subtitle="Live app and generated UI preview placeholder"
        />
      );
    }
    return <TerminalPane />;
  };

  const isCanvasVertical = canvasPlacement === 'top' || canvasPlacement === 'bottom';
  const canvasFirst = canvasPlacement === 'left' || canvasPlacement === 'top';
  const showCanvas = !canvasCollapsed && hasCanvas;
  const chatStyle: CSSProperties = showCanvas && !isCanvasVertical ? { width: awarenessWidth } : { flex: 1 };

  const CanvasRegion = () => showCanvas ? (
    <div className="canvas-panel">
      <CanvasPanel />
    </div>
  ) : null;

  const ChatRegion = () => !awarenessCollapsed ? (
    <div className="awareness-sidebar" style={chatStyle}>
      <AwarenessPane stream={awarenessStream} />
    </div>
  ) : null;

  const HorizontalChatResize = () => (
    showCanvas && !isCanvasVertical && !awarenessCollapsed
      ? <div className="resize-handle" onMouseDown={handleAwarenessDragStart} />
      : null
  );

  return (
    <div className="workspace-root">
      <header className="workspace-header">
        <div className="header-left">
          <button className="header-btn" onClick={toggleSidebar} title="Toggle files">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {/* agent name removed */}
          <CanvasControls />
        </div>
        <div className="header-right">
          <HeaderStatus stream={awarenessStream} />
        </div>
      </header>

      {upload.FileInput}
      <div className="workspace-body" ref={containerRef} {...upload.dragProps}>
        {/* Left: File Explorer */}
        {!sidebarCollapsed && (
          <>
            <div className="sidebar-panel" style={{ width: sidebarWidth }}>
              <SidebarControls />
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
          {canvasFirst && <CanvasRegion />}
          {!canvasFirst && <ChatRegion />}
          <HorizontalChatResize />
          {!canvasFirst && <CanvasRegion />}
          {canvasFirst && <ChatRegion />}
          {awarenessCollapsed && !showCanvas && (
            <div className="workspace-empty-surface">
              <span>Open chat or canvas</span>
            </div>
          )}
          </div>
      </div>

      {/* Upload drag overlay */}
      {upload.isDragging && (
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
      {upload.uploading && (
        <div className="upload-toast">Uploading...</div>
      )}
      {upload.error && (
        <div className="upload-toast upload-toast-error">{upload.error}</div>
      )}

      {/* Mobile drawer overlay */}
      {mobileDrawerOpen && (
        <>
          <div className="mobile-overlay" onClick={() => setMobileDrawerOpen(false)} />
          <div className="mobile-drawer">
            <SidebarControls />
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

function CanvasModeIcon({ mode }: { mode: CanvasMode }) {
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

function CanvasPlacementIcon({ placement }: { placement: CanvasPlacement }) {
  const isTop = placement === 'top';
  const isRight = placement === 'right';
  const isBottom = placement === 'bottom';
  const isLeft = placement === 'left';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="1" stroke="currentColor" strokeWidth="1.2" />
      {isLeft && <path d="M6 1.5v13" stroke="currentColor" strokeWidth="1.2" />}
      {isRight && <path d="M10 1.5v13" stroke="currentColor" strokeWidth="1.2" />}
      {isTop && <path d="M1.5 6h13" stroke="currentColor" strokeWidth="1.2" />}
      {isBottom && <path d="M1.5 10h13" stroke="currentColor" strokeWidth="1.2" />}
      <rect
        x={isRight ? 10 : 1.5}
        y={isBottom ? 10 : 1.5}
        width={isLeft || isRight ? 4.5 : 13}
        height={isTop || isBottom ? 4.5 : 13}
        fill="currentColor"
        opacity="0.18"
      />
    </svg>
  );
}
