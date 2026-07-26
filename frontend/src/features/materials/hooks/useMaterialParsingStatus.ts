'use client';

import { useEffect, useState } from 'react';
import { materialsService } from '../services/materialsService';

export function useMaterialParsingStatus(projectId: string): boolean {
  const [hasParsing, setHasParsing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const check = async () => {
      try {
        const parsing = await materialsService.hasFilesBeingParsed(projectId);
        if (cancelled) return;
        setHasParsing(parsing);
        if (parsing) timer = window.setTimeout(check, 5_000);
      } catch {
        if (!cancelled) setHasParsing(false);
      }
    };

    void check();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [projectId]);

  return hasParsing;
}
