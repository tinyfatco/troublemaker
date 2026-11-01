export const TOOL_AUTO_COLLAPSE_DELAY_MS = 220;

export function shouldAutoOpenToolDetails(hasDetails: boolean, isRunning?: boolean): boolean {
  return hasDetails && !!isRunning;
}

export function shouldAutoCollapseToolDetails(
  hasAutoExpanded: boolean,
  isRunning?: boolean,
  collapseRequested?: boolean,
): boolean {
  return hasAutoExpanded && !isRunning && !!collapseRequested;
}

export function isToolDetailsExpanded(hasDetails: boolean, manualOpen: boolean, autoOpen: boolean): boolean {
  return hasDetails && (manualOpen || autoOpen);
}

/** A streaming output box keeps following new lines while its reader is within a line of the bottom. */
export function shouldStickToolOutputToBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 16): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * Late-growing chat content (a Paint card image decoding, a tool box opening)
 * re-follows the bottom only for a reader who is still pinned there. A reader
 * who scrolled up is left where they are.
 */
export function shouldFollowExpandingContent(state: {
  backlogDone: boolean;
  isLoadingMore: boolean;
  pinnedToBottom: boolean;
  nearBottom: boolean;
}): boolean {
  if (!state.backlogDone || state.isLoadingMore) return false;
  return state.pinnedToBottom || state.nearBottom;
}

/** Scroll position after a user scroll event: scrolling up off the bottom unpins; reaching the bottom re-pins. */
export function nextPinnedToBottom(pinned: boolean, scrollingUp: boolean, atBottom: boolean): boolean {
  if (scrollingUp && !atBottom) return false;
  if (atBottom) return true;
  return pinned;
}

/** A newly arrived entry or live streaming snaps instantly; a smooth scroll lags behind a just-sent card. */
export function liveFollowBehavior(isStreaming: boolean, isNewEntry: boolean): ScrollBehavior {
  return isStreaming || isNewEntry ? 'instant' : 'smooth';
}

