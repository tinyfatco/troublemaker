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
