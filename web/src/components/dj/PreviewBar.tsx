import { previewStop, previewToggle, usePreview, usePreviewMount } from '../../lib/engine';
import { useMonitor } from '../../lib/store';
import './PreviewBar.css';

/**
 * The audition strip. It holds the preview iframe, which is why it renders as soon as anything is
 * being previewed and not before: an iframe with nothing in it is a big red YouTube play button
 * sitting in the booth for no reason.
 *
 * The preview is on the cue bus only, so it is inaudible with CUE MIX hard over on MASTER. That is
 * correct behaviour, not a fault — but it looks like a fault, so say so on the strip.
 */
export function PreviewBar() {
  const p = usePreview();
  const mount = usePreviewMount();
  const [mon] = useMonitor();
  const silent = mon.cueMix <= 0.001 || mon.cueVol <= 0.001;

  if (!p.videoId) return null;

  return (
    <div className={`pv${silent ? ' is-silent' : ''}`}>
      <div className="pv-screen" ref={mount} />
      <div className="pv-meta">
        <span className="pv-lbl">Preview</span>
        <span className="pv-title" title={p.title || p.videoId}>
          {p.title || p.videoId}
        </span>
        {silent && (
          <span className="pv-warn" title="The preview only feeds the cue bus — turn CUE MIX towards CUE to hear it">
            turn up CUE MIX
          </span>
        )}
      </div>
      <button
        type="button"
        className="pv-btn"
        title={p.playing ? 'Pause the preview' : 'Play the preview'}
        aria-label={p.playing ? 'Pause the preview' : 'Play the preview'}
        onClick={previewToggle}
      >
        {p.playing ? '❚❚' : '▶'}
      </button>
      <button type="button" className="pv-x" title="Stop previewing" aria-label="Stop previewing" onClick={previewStop}>
        ✕
      </button>
    </div>
  );
}
