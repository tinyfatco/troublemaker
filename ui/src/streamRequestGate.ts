export interface StreamRequestGate {
  activate: () => number;
  current: () => number;
  isActive: (requestId: number) => boolean;
  deactivate: (requestId?: number) => boolean;
}

export function createStreamRequestGate(): StreamRequestGate {
  let nextRequestId = 0;
  let activeRequestId = 0;

  return {
    activate: () => {
      nextRequestId += 1;
      activeRequestId = nextRequestId;
      return activeRequestId;
    },
    current: () => activeRequestId,
    isActive: (requestId: number) => requestId !== 0 && activeRequestId === requestId,
    deactivate: (requestId = activeRequestId) => {
      if (activeRequestId !== requestId) return false;
      activeRequestId = 0;
      return true;
    },
  };
}
