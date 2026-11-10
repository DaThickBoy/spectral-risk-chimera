// Guided tour step (ui-guidelines §8): a non-modal card rendered inline above the section it
// explains, so it never overlays a figure. Focus moves to its heading on every step (which also
// scrolls it into view); Escape ends the tour. Text comes from `tour.ts` only.
import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { TourStep } from '../tour.js';

export function TourCard(props: {
  readonly step: TourStep;
  readonly index: number; // a step position, not a financial value
  readonly count: number;
  readonly onBack: () => void;
  readonly onNext: () => void;
  readonly onEnd: () => void;
}): ReactElement {
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Focus alone does not scroll when the heading is already on screen (for example a card
    // that starts near the bottom of the viewport), which left the explanation and controls
    // below the fold. Focus without scrolling, then position the card explicitly:
    // - fully visible already: leave the page where it is (no jump between nearby steps);
    // - otherwise: align the card to the top, so its explanation, its controls, and the
    //   section it explains (directly below it) are all on screen.
    // `instant` never animates, which also satisfies prefers-reduced-motion. jsdom has no
    // scrollIntoView, so the call is guarded.
    heading.current?.focus({ preventScroll: true });
    const element = card.current;
    if (element !== null && typeof element.scrollIntoView === 'function') {
      const box = element.getBoundingClientRect();
      const fullyVisible = box.top >= 0 && box.bottom <= window.innerHeight;
      if (!fullyVisible) element.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
    }
  }, [props.index]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onEnd();
    }
  };
  const last = props.index === props.count - 1;
  return (
    <section
      ref={card}
      className="tour-card"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      data-testid="tour-card"
    >
      {/* Visual progress line; screen readers get the same words inside the heading, which is
          where focus lands on every step (and which names the region, so it never duplicates
          the name of the section it explains). */}
      <p className="tour-progress" aria-hidden="true">
        Guided tour · step {String(props.index + 1)} of {String(props.count)}
      </p>
      <h2 id={titleId} ref={heading} tabIndex={-1}>
        <span className="visually-hidden">
          Guided tour, step {String(props.index + 1)} of {String(props.count)}:{' '}
        </span>
        {props.step.title}
      </h2>
      {props.step.body.map((line) => (
        <p key={line} className="tour-line">
          {line}
        </p>
      ))}
      <div className="tour-actions">
        <button type="button" onClick={props.onBack} disabled={props.index === 0}>
          Back
        </button>
        <button type="button" onClick={last ? props.onEnd : props.onNext} data-testid="tour-next">
          {last ? 'Finish' : 'Next'}
        </button>
        <button type="button" className="tour-end" onClick={props.onEnd} data-testid="tour-end">
          End tour
        </button>
      </div>
    </section>
  );
}
