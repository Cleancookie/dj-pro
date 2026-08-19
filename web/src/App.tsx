import { useEffect, useState } from 'react';
import { Audience } from './pages/Audience';
import { DjBooth } from './pages/DjBooth';

/** Tiny path router — the app has exactly two surfaces. */
function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  return path.startsWith('/admin') ? <DjBooth /> : <Audience />;
}
