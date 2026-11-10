// Contextual help (roadmap S4): a native disclosure button next to a label. Enter or Space
// toggles it (native button), Escape closes it and keeps focus on the button. The explanation is
// rendered inline below the label only while open, so it never covers a figure, and it is
// linked with `aria-controls` only while it exists.
import { useId, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { GLOSSARY } from '../glossary.js';
import type { GlossaryKey } from '../glossary.js';

export function Help({ term }: { readonly term: GlossaryKey }): ReactElement {
  const [open, setOpen] = useState(false);
  const id = useId();
  const entry = GLOSSARY[term];
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };
  return (
    <span className="help">
      <button
        type="button"
        className="help-button"
        aria-label={`What is ${entry.term}?`}
        aria-expanded={open}
        {...(open ? { 'aria-controls': id } : {})}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
        data-testid={`help-${term}`}
      >
        ?
      </button>
      {open ? (
        <span id={id} role="note" className="help-panel" data-testid={`help-${term}-panel`}>
          <span className="help-line">
            <span className="help-kind">In general:</span> {entry.general}
          </span>
          <span className="help-line">
            <span className="help-kind">In this dashboard:</span> {entry.app}
          </span>
        </span>
      ) : null}
    </span>
  );
}
