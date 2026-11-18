import React, { useRef } from 'react';
import { EarningsPage } from './EarningsPage.jsx';
import { InvoicesPage } from './InvoicesPage.jsx';

// ── Money: Earnings, then Billing ─────────────────────────────
// Spec 2026-11-16 Part 2: a platform admin's Earnings and Billing tabs become
// two sections of one tab, one heading each. Both pages render exactly as they
// did as tabs. Earnings' "invoicable tows" card used to switch to the Billing
// tab; here it scrolls to the Billing section instead.
export function MoneyPage({ earnings, invoices, onNavigate }) {
  const billingRef = useRef(null);
  const go = (tab) => {
    if (tab === 'invoices') billingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (onNavigate) onNavigate(tab);
  };
  return (
    <div className="ap-money" data-testid="money">
      <section className="ap-money-sec" aria-labelledby="ap-money-earnings">
        <h1 id="ap-money-earnings" className="section-title ap-title">Earnings</h1>
        <EarningsPage {...earnings} onNavigate={go} />
      </section>
      <section className="ap-money-sec" aria-labelledby="ap-money-billing" ref={billingRef}>
        <h2 id="ap-money-billing" className="section-title ap-title">Billing</h2>
        <InvoicesPage {...invoices} />
      </section>
    </div>
  );
}

export default MoneyPage;
