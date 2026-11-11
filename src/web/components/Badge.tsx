// Status badges (ui-guidelines 4): every state has a text label; colour is never the only signal.
import { createContext, useContext, type ReactElement } from 'react';

export const ReplayContext = createContext(false);

export type BadgeTone = 'current' | 'demo' | 'warning' | 'critical' | 'unavailable' | 'neutral' | 'info';

const ICON: Readonly<Record<BadgeTone, string>> = {
  current: '\u25CF', // filled circle
  demo: '\u25C7', // outlined diamond
  warning: '\u25B2', // triangle
  critical: '\u25A0', // square
  unavailable: '\u2014', // dash
  neutral: '\u25CB', // circle
  info: '\u25CB',
};

export function Badge(props: {
  readonly tone: BadgeTone;
  readonly label: string;
  readonly title?: string;
}): ReactElement {
  const replay = useContext(ReplayContext);
  const label = replay && props.label === 'CURRENT' ? 'Fresh at replay time' : props.label;
  return (
    <span className={`badge badge-${props.tone}`} title={props.title}>
      <span aria-hidden="true" className="badge-icon">
        {ICON[props.tone]}
      </span>
      {label}
    </span>
  );
}

/** Tone of a validity or data status code. */
export function toneOf(code: string): BadgeTone {
  switch (code) {
    case 'CURRENT':
    case 'OK':
    case 'VALUED':
    case 'IDENTITY':
      return 'current';
    case 'DEMO':
    case 'DEMO_DATA':
      return 'demo';
    case 'STALE':
    case 'STALE_INPUTS':
    case 'LAST_VALID':
    case 'FX_STALE':
    case 'REDUCED_LOOKBACK':
    case 'MARKET_DATA_STALE':
      return 'warning';
    case 'UNAVAILABLE':
    case 'FX_UNAVAILABLE':
    case 'EXPOSURE_UNAVAILABLE':
    case 'NOT_CONFIGURED':
    case 'PRICE_UNAVAILABLE':
      return 'unavailable';
    default:
      return 'neutral';
  }
}
