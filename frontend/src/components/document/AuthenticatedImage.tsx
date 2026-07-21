'use client';

/**
 * V3 Phase 8.5 — Authenticated <img> replacement.
 *
 * <img src=...> tags cannot send Authorization: Bearer headers, so they
 * 401 on protected page-image endpoints (GET /api/v1/documents/{id}/pages/{n}).
 * This component fetches the bytes with the bearer token, builds a blob
 * URL, and renders <img src={blobUrl}>. Releases the blob URL on unmount
 * or src change.
 */

import { useEffect, useRef, useState } from 'react';
import { getAccessToken } from '@/lib/api';

interface AuthenticatedImageProps {
  src: string;
  alt: string;
  className?: string;
  onLoad?: (event: { currentTarget: HTMLImageElement }) => void;
  onError?: () => void;
}

export function AuthenticatedImage({
  src,
  alt,
  className,
  onLoad,
  onError,
}: AuthenticatedImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // When the blob fetch fails but the endpoint is reachable unauthenticated,
  // fall back to a plain <img>. A cross-origin <img> is not subject to the
  // CORS read restrictions a fetch() is, so this recovers the page render
  // instead of leaving Source View with nothing to draw bboxes on.
  const [useDirectSrc, setUseDirectSrc] = useState(false);
  const currentUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setBlobUrl(null);
    setUseDirectSrc(false);

    const token = getAccessToken();

    // No token => nothing to attach, so the fetch+blob indirection buys us
    // nothing and only adds a CORS-mode request that can fail where a plain
    // <img> would not. Render the <img> directly instead.
    if (!token) {
      setUseDirectSrc(true);
      return () => {
        cancelled = true;
      };
    }

    const headers: Record<string, string> = {
      Accept: 'image/*',
      Authorization: `Bearer ${token}`,
    };

    fetch(src, { headers })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = url;
        setBlobUrl(url);
      })
      .catch(() => {
        if (cancelled) return;
        setUseDirectSrc(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src, onError]);

  useEffect(() => {
    return () => {
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
    };
  }, []);

  if (error) {
    return (
      <div
        className={className}
        role="img"
        aria-label={`Failed to load: ${alt}`}
      />
    );
  }

  if (useDirectSrc) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={alt}
        className={className}
        onLoad={(e) => onLoad?.({ currentTarget: e.currentTarget })}
        onError={() => {
          setError(true);
          onError?.();
        }}
      />
    );
  }

  if (!blobUrl) {
    return <div className={className} role="img" aria-label={`Loading: ${alt}`} />;
  }

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={blobUrl}
      alt={alt}
      className={className}
      onLoad={(e) => onLoad?.({ currentTarget: e.currentTarget })}
    />
  );
}
