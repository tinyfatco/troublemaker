import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

type PersistentStateOptions<T> = {
  parse?: (value: unknown) => T | null;
  serialize?: (value: T) => unknown;
};

function readPersistentValue<T>(
  key: string,
  fallback: T,
  parse?: (value: unknown) => T | null,
): T {
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;

    const decoded = JSON.parse(raw) as unknown;
    return parse ? parse(decoded) ?? fallback : decoded as T;
  } catch {
    return fallback;
  }
}

export function usePersistentState<T>(
  key: string,
  fallback: T,
  options: PersistentStateOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const { parse, serialize } = options;
  const [value, setValue] = useState<T>(() => readPersistentValue(key, fallback, parse));

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const encoded = serialize ? serialize(value) : value;
      window.localStorage.setItem(key, JSON.stringify(encoded));
    } catch {
      // Preference persistence is best effort; UI state should not break rendering.
    }
  }, [key, serialize, value]);

  return [value, setValue];
}
