import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import { App } from './App';

// Deliberately NOT wrapped in <StrictMode>: it double-invokes effects, which would tear down and
// recreate the YouTube iframe players on every mount and make dev playback unusable.
createRoot(document.getElementById('root')!).render(<App />);
