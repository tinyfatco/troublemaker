/**
 * useDateCache - Cache Date objects to prevent unnecessary re-renders
 */

import { useRef, useCallback } from 'react';
import { toDateString, fromDateString } from '@plain-calendar/core';

interface DateCache {
  get(key: string): Date | undefined;
  getOrCreate(key: string): Date;
  getForDate(date: Date): Date;
  clear(): void;
  size(): number;
}

/**
 * Hook for caching Date objects by their string representation.
 * Prevents creating new Date objects on every render for the same date.
 */
export function useDateCache(maxSize: number = 100): DateCache {
  const cacheRef = useRef<Map<string, Date>>(new Map());
  const accessOrderRef = useRef<string[]>([]);

  const evictOldest = useCallback(() => {
    const cache = cacheRef.current;
    const accessOrder = accessOrderRef.current;
    
    while (cache.size >= maxSize && accessOrder.length > 0) {
      const oldest = accessOrder.shift();
      if (oldest) {
        cache.delete(oldest);
      }
    }
  }, [maxSize]);

  const updateAccessOrder = useCallback((key: string) => {
    const accessOrder = accessOrderRef.current;
    const index = accessOrder.indexOf(key);
    if (index > -1) {
      accessOrder.splice(index, 1);
    }
    accessOrder.push(key);
  }, []);

  const get = useCallback((key: string): Date | undefined => {
    const cached = cacheRef.current.get(key);
    if (cached) {
      updateAccessOrder(key);
    }
    return cached;
  }, [updateAccessOrder]);

  const getOrCreate = useCallback((key: string): Date => {
    const cached = cacheRef.current.get(key);
    if (cached) {
      updateAccessOrder(key);
      return cached;
    }

    evictOldest();
    
    const date = fromDateString(key);
    if (!date) {
      throw new Error(`Invalid date string: ${key}`);
    }
    
    cacheRef.current.set(key, date);
    updateAccessOrder(key);
    return date;
  }, [evictOldest, updateAccessOrder]);

  const getForDate = useCallback((date: Date): Date => {
    const key = toDateString(date);
    const cached = cacheRef.current.get(key);
    if (cached) {
      updateAccessOrder(key);
      return cached;
    }

    evictOldest();
    
    // Store normalized date (start of day)
    const normalized = new Date(date);
    normalized.setHours(12, 0, 0, 0);
    
    cacheRef.current.set(key, normalized);
    updateAccessOrder(key);
    return normalized;
  }, [evictOldest, updateAccessOrder]);

  const clear = useCallback(() => {
    cacheRef.current.clear();
    accessOrderRef.current = [];
  }, []);

  const size = useCallback(() => {
    return cacheRef.current.size;
  }, []);

  return {
    get,
    getOrCreate,
    getForDate,
    clear,
    size,
  };
}

export default useDateCache;
