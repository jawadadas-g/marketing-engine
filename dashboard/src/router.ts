import { useEffect, useState } from 'preact/hooks';

/**
 * The whole router. A hash route is a path and a query, and the browser's own
 * back button works without anything else.
 */
export type Route = { path: string; query: URLSearchParams };

function read(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/overview';
  const [path, query] = raw.split('?');
  return { path: path || '/overview', query: new URLSearchParams(query ?? '') };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function href(path: string, query: Record<string, string | undefined> = {}): string {
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== '');
  const search = entries.length
    ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`
    : '';
  return `#${path}${search}`;
}

export function go(path: string, query: Record<string, string | undefined> = {}): void {
  window.location.hash = href(path, query).slice(1);
}

/** The first segment, for marking the nav. */
export function section(path: string): string {
  return `/${path.split('/').filter(Boolean)[0] ?? ''}`;
}
