import React from 'react';

// "Fri 6:00 PM – Sun 11:59 PM" must never wrap inside "Fri 6:00 PM" (it
// did on a 390 px banner). Each time, with its weekday and date when it has
// them, is kept on one line; the text itself is unchanged, so a test or a
// screen reader reads the same words.
const CLOCK = /((?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?: [A-Z][a-z]{2} \d{1,2},)? )?\d{1,2}:\d{2} [AP]M(?: ET)?)/;

export function NoBreakTimes({ text }) {
  return String(text ?? '').split(CLOCK).map((part, i) => (
    i % 2 ? <span key={i} style={{ whiteSpace: 'nowrap' }}>{part}</span> : part
  ));
}
