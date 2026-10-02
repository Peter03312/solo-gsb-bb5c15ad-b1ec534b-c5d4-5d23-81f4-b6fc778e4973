import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { CollationView, DocumentSummary } from './types';
import { HomePage } from './pages/HomePage';
import { Workspace } from './pages/Workspace';
import { EditionViewer } from './pages/EditionViewer';
import { EditionDiffPage } from './pages/EditionDiffPage';

type Route =
  | { name: 'home' }
  | { name: 'doc'; id: number }
  | { name: 'edition'; id: number; no: number }
  | { name: 'diff'; id: number; no: number };

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  if (route.name === 'home') {
    return <HomePage onOpen={(id) => setRoute({ name: 'doc', id })} />;
  }
  if (route.name === 'edition') {
    return (
      <EditionViewer
        docId={route.id}
        editionNo={route.no}
        onBack={() => setRoute({ name: 'doc', id: route.id })}
        onHome={() => setRoute({ name: 'home' })}
        onDiff={() => setRoute({ name: 'diff', id: route.id, no: route.no })}
      />
    );
  }
  if (route.name === 'diff') {
    return (
      <EditionDiffPage
        docId={route.id}
        editionNo={route.no}
        onBack={() => setRoute({ name: 'doc', id: route.id })}
        onHome={() => setRoute({ name: 'home' })}
      />
    );
  }
  return (
    <Workspace
      docId={route.id}
      onHome={() => setRoute({ name: 'home' })}
      onOpenEdition={(no) => setRoute({ name: 'edition', id: route.id, no })}
      onOpenDiff={(no) => setRoute({ name: 'diff', id: route.id, no })}
      onOpenDocument={(id) => setRoute({ name: 'doc', id })}
    />
  );
}

/** 公共：带“过期版本 409”提示的写操作包装。 */
export function useActionFeedback() {
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<void>, okMsg?: string) => {
    setError(null);
    setIssues(null);
    setNotice(null);
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setIssues(e.details ?? null);
      } else {
        setError(String(e));
      }
    }
  }, []);

  return { error, issues, notice, setError, setNotice, run };
}

export type ViewLoader = () => Promise<CollationView>;
export type { DocumentSummary };
export { api };
