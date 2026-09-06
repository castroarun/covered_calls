import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';
import styles from './BlueskyPaper.module.css';

/* CAPITAL DESK (/app/capital) — the one page that owns every rupee in and out.
   Renamed from "Sleeves 50-50" on 05-Sep-2026: the book is three systems on a
   TN 40 / OA 40 / IPO 20 target, so a name describing a two-way even split had
   stopped being true.

   It carries the target allocation and its drift, the deposit router, deposits and
   withdrawals for every book, the dividend policy, and the comparison of the sleeves
   over their common history. Money controls live HERE and not on the book pages, so
   there is exactly one place to look and one path to audit.

   Every flow dispatches to the book's own hardened implementation; this page derives
   no split of its own and touches no trading logic. */

type MomNav = { d: string; nav: number; bench: number | null };
type MomState = { navcurve: MomNav[]; nav: number; capital: number; total_return_pct: number;
  gate: string; mode?: string; inception?: string };
type BsNav = { date: string; nav: number; bench: number | null };
type BsFeed = {
  nav_curve: BsNav[]; nav: number; capital: number; ret_pct: number; gate_weak: boolean;
  cagr_pct: number; max_dd_pct: number; n_trades: number; win_pct: number;
  n_live_trades: number; provenance: string; study: string;
};
/* The TIME-WEIGHTED curve. True North was funded from Rs2.98L to Rs9.07L inside this
   window, so raw NAV is not a return series -- book_curve() backs each day's flow out
   before chaining, which is the only reason the two sleeves can share an axis. */
type TnBook = { d: string; nav: number; r: number };
type TnBench = { book: TnBook[]; inception: string; series: Record<string, unknown> };

const pct = (n: number | null | undefined) =>
  n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

function monthKey(d: string) { return d.slice(0, 7); }

function blend5050(dates: string[], a: number[], b: number[]) {
  /* 50-50, rebalanced at each month boundary. */
  const out: number[] = [];
  let wA = 0.5, wB = 0.5, base = 100;
  let aRef = a[0], bRef = b[0], lastM = monthKey(dates[0]);
  for (let i = 0; i < dates.length; i++) {
    const m = monthKey(dates[i]);
    if (m !== lastM) {
      base = out[i - 1];
      aRef = a[i - 1]; bRef = b[i - 1];
      wA = 0.5; wB = 0.5; lastM = m;
    }
    out.push(base * (wA * (a[i] / aRef) + wB * (b[i] / bRef)));
  }
  return out;
}

function corrMonthly(dates: string[], a: number[], b: number[]) {
  const idx: number[] = [];
  for (let i = 1; i < dates.length; i++)
    if (monthKey(dates[i]) !== monthKey(dates[i - 1])) idx.push(i - 1);
  idx.push(dates.length - 1);
  const ra: number[] = [], rb: number[] = [];
  for (let k = 1; k < idx.length; k++) {
    ra.push(a[idx[k]] / a[idx[k - 1]] - 1);
    rb.push(b[idx[k]] / b[idx[k - 1]] - 1);
  }
  const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

function stats(series: number[], dates: string[]) {
  const yrs = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 3.15576e10;
  const cagr = (Math.pow(series[series.length - 1] / series[0], 1 / yrs) - 1) * 100;
  let peak = series[0], dd = 0;
  for (const v of series) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  return { cagr, dd: dd * 100, total: (series[series.length - 1] / series[0] - 1) * 100 };
}

function MultiCurve({ dates, lines }: { dates: string[]; lines: { name: string; v: number[]; color: string; dash?: string }[] }) {
  const W = 780, H = 260, P = 8;
  const all = lines.flatMap((l) => l.v);
  const lo = Math.min(...all), hi = Math.max(...all);
  const x = (i: number) => P + (i / (dates.length - 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)) * (H - 2 * P);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} preserveAspectRatio="none" style={{ height: 260 }}>
      {lines.map((l) => (
        <path key={l.name} fill="none" stroke={l.color} strokeWidth={l.name.includes('blend') ? 2.4 : 1.4}
              strokeDasharray={l.dash} d={l.v.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
      ))}
    </svg>
  );
}

type Flow = { ts: string; kind: string; amount: number; via?: string };
type BookStatus = { name: string; kind?: string; capital?: number | null; cash?: number | null;
  liquid?: number | null; nav?: number | null; positions?: number;
  flows?: Flow[]; error?: string; note?: string };
type AllocRow = { book: string; value: number; target_pct: number; current_pct: number;
  target_value: number; gap: number };
type Allocation = { total: number; base: string; ipo_status: string; rows: AllocRow[];
  changelog: { date: string; text: string }[] };
type FlowsStatus = { books: Record<string, BookStatus>; allocation: Allocation; note: string };
type RouteLeg = { book: string; amount: number };
type RoutePlan = { amount: number; legs: RouteLeg[]; notes: string[] };

const BOOK_LABEL: Record<string, string> = {
  truenorth: 'True North', openalpha: 'Open Alpha', ipo: 'IPO base',
};

function AllocationPanel({ a }: { a: Allocation }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>
        Target allocation — {a.rows.map((r) => `${BOOK_LABEL[r.book] ?? r.book} ${r.target_pct}`).join(' / ')}
      </div>
      <div className={styles.sub} style={{ marginBottom: 10 }}>
        {BOOK_LABEL[a.base] ?? a.base} is the base: it is never sold to rebalance. Arriving cash
        goes to whichever book is furthest below its share.
        {a.ipo_status === 'paper' && ' IPO is on paper, so its share is earmarked in the liquid ETF.'}
      </div>
      <table className={styles.tbl}>
        <thead>
          <tr><th className={styles.txt}>Book</th><th>Value</th><th>Now</th>
            <th>Target</th><th>Target ₹</th><th>Gap</th></tr>
        </thead>
        <tbody>
          {a.rows.map((r) => (
            <tr key={r.book}>
              <td className={styles.txt}>{BOOK_LABEL[r.book] ?? r.book}</td>
              <td>{rup(r.value)}</td>
              <td>{r.current_pct}%</td>
              <td className={styles.muted}>{r.target_pct}%</td>
              <td className={styles.muted}>{rup(r.target_value)}</td>
              <td className={r.gap >= 0 ? styles.pos : styles.neg}>
                {r.gap >= 0 ? '+' : '−'}{rup(Math.abs(r.gap)).slice(1)}
              </td>
            </tr>
          ))}
          <tr>
            <td className={styles.txt}><b>Total</b></td>
            <td><b>{rup(a.total)}</b></td>
            <td colSpan={4} className={styles.muted}>
              a positive gap is money the book still needs
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AllocationDesk() {
  const [a, setA] = useState<Allocation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    apiGet<Allocation>('/api/sleeves/allocation').then(setA)
      .catch((e) => setErr(String(e)));
  }, []);
  if (err) return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>Target allocation</div>
      <p className={styles.note}>unavailable: {err}</p>
    </div>
  );
  if (!a) return null;
  return <AllocationPanel a={a} />;
}

function FundsPanel() {
  const [st, setSt] = useState<FlowsStatus | null>(null);
  const [amt, setAmt] = useState('');
  const [kind, setKind] = useState<'deposit' | 'withdraw'>('deposit');
  const [target, setTarget] = useState<'auto' | 'truenorth' | 'openalpha' | 'ipo'>('auto');
  const [route, setRoute] = useState<RoutePlan | null>(null);
  const [plans, setPlans] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => apiGet<FlowsStatus>('/api/sleeves/status').then(setSt)
    .catch((e) => setMsg('status unavailable: ' + String(e)));
  useEffect(() => { load(); }, []);

  const call = (url: string, body: any) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(body), credentials: 'include' })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

  /* Legs come from the SERVER's router when target is auto, so the split that is
     previewed is the split that executes — the page never re-derives it. */
  const buildLegs = async (n: number): Promise<RouteLeg[]> => {
    if (target !== 'auto') return [{ book: target, amount: n }];
    const r = await call('/api/sleeves/allocation/route', { amount: n });
    if (!r.ok) throw new Error(r.data?.error || 'router failed');
    setRoute(r.data as RoutePlan);
    return (r.data as RoutePlan).legs;
  };

  const preview = async () => {
    const n = Number(amt);
    if (!n || n <= 0) { setMsg('enter a positive amount'); return; }
    setBusy(true); setMsg(null); setPlans(null); setRoute(null);
    try {
      const legs = await buildLegs(n);
      const out = [];
      for (const l of legs) {
        const r = await call('/api/sleeves/' + l.book + '/' + kind,
                             { amount: Math.round(l.amount), dry_run: true });
        out.push({ book: l.book, amount: l.amount, ...r });
      }
      setPlans(out);
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  };

  /* Multi-leg safety. Previously two legs fired sequentially under a single confirm, so
     a failure on the second left the first applied with no record and no reversal. Now
     every leg must pass its own dry run BEFORE anything executes, and if a leg still
     fails mid-flight we stop immediately and report exactly what was applied and what
     was not. The books are separate stores, so true atomicity is not available —
     pretending otherwise would be worse than saying so plainly. */
  const execute = async () => {
    if (!plans || !plans.length) return;
    const bad = plans.filter((p) => !p.ok || p.data?.feasible === false);
    if (bad.length) {
      setMsg('cannot execute — ' + bad.map((b) => BOOK_LABEL[b.book] ?? b.book).join(', ')
             + ' failed the dry run. Nothing was sent.');
      return;
    }
    const n = Number(amt);
    const live = plans.some((p) => p.book === 'truenorth');
    const warn = live ? 'True North is a LIVE book and its leg may place REAL orders.\n\n' : '';
    const lines = plans.map((p) => '  ' + (BOOK_LABEL[p.book] ?? p.book) + ': Rs '
      + Math.round(p.amount).toLocaleString('en-IN')).join('\n');
    if (!window.confirm(warn + kind + ' Rs ' + n.toLocaleString('en-IN')
        + ' split as:\n' + lines + '\n\nProceed?')) return;
    setBusy(true);
    const applied: string[] = [], skipped: string[] = [];
    let halted = false;
    for (const p of plans) {
      const label = BOOK_LABEL[p.book] ?? p.book;
      if (halted) { skipped.push(label); continue; }
      const r = await call('/api/sleeves/' + p.book + '/' + kind,
                           { amount: Math.round(p.amount), dry_run: false })
        .catch((e) => ({ ok: false, data: { error: String(e) } }));
      if (r.ok) applied.push(label + ' ' + rup(p.amount));
      else { halted = true; skipped.push(label + ' FAILED: ' + (r.data?.error || 'error')); }
    }
    setMsg(halted
      ? 'PARTIAL — applied: ' + (applied.join(', ') || 'nothing') + ' · NOT applied: '
        + skipped.join(', ') + '. Reverse the applied legs manually to undo the whole flow.'
      : 'Done — ' + applied.join(' · '));
    setPlans(null); setRoute(null); setAmt(''); setBusy(false); load();
  };

  const books = st?.books ?? {};
  const sel: React.CSSProperties = { padding: '7px 10px', borderRadius: 6,
    border: '1px solid var(--hairline, #ccc)', background: 'var(--surface)',
    color: 'var(--ink)', fontSize: 13 };
  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>Funds — every rupee in and out</div>
      <div className={styles.sub} style={{ marginBottom: 10 }}>
        {Object.entries(books).filter(([k]) => k !== 'openalpha_model').map(([k, b]) => (
          <span key={k} style={{ marginRight: 14 }}>
            <b>{b.name}</b>{' '}
            {b.error ? <span className={styles.neg}>unavailable</span>
              : <>capital {rup(b.capital)} · liquid {rup(b.liquid ?? b.cash)}</>}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={kind} onChange={(e) => { setKind(e.target.value as any); setPlans(null); }} style={sel}>
          <option value="deposit">Deposit</option>
          <option value="withdraw">Withdraw</option>
        </select>
        <select value={target} onChange={(e) => { setTarget(e.target.value as any); setPlans(null); }} style={sel}>
          <option value="auto">Route to target (40/40/20)</option>
          <option value="truenorth">True North only</option>
          <option value="openalpha">Open Alpha only</option>
          <option value="ipo">IPO base only</option>
        </select>
        <input value={amt} onChange={(e) => { setAmt(e.target.value); setPlans(null); }}
               placeholder="amount Rs" style={{ ...sel, width: 130 }} />
        <button style={{ ...sel, cursor: 'pointer', fontWeight: 600 }} disabled={busy} onClick={preview}>Preview</button>
        {plans && <button style={{ ...sel, cursor: 'pointer', fontWeight: 700 }} disabled={busy} onClick={execute}>Confirm &amp; execute</button>}
      </div>
      {route && route.notes.map((n, i) => (
        <p key={i} className={styles.note} style={{ marginBottom: 2 }}>{n}</p>
      ))}
      {plans && plans.map((pl, i) => (
        <p key={i} className={styles.note}>
          <b>{BOOK_LABEL[pl.book] ?? pl.book} — {rup(pl.amount)}:</b>{' '}
          {pl.ok
            ? (Array.isArray(pl.data.plan)
                ? pl.data.plan.map((s: any) => typeof s === 'string' ? s
                    : [s.action, s.qty, s.source ?? s.symbol, '(' + rup(s.value) + ')']
                        .filter(Boolean).join(' ')).join(' → ')
                : JSON.stringify(pl.data).slice(0, 220))
            : (pl.data.error || 'preview failed')}
        </p>
      ))}
      {msg && <p className={styles.note}><b>{msg}</b></p>}
      {Object.entries(books).filter(([, b]) => (b.flows ?? []).length).map(([k, b]) => (
        <p key={k} className={styles.note}>
          {b.name} flows: {(b.flows ?? []).slice(-4).map((f) =>
            f.kind + ' ' + rup(f.amount) + ' (' + String(f.ts).slice(0, 10) + ')').join(' · ')}
        </p>
      ))}
      <p className={styles.note}>
        Preview → confirm → execute, the same contract True North's own cash panel uses. Each leg
        runs that book's hardened flow: positions are never force-sold, and a withdrawal that
        cannot be funded is refused rather than partially filled.
      </p>
    </div>
  );
}

type DivBook = { book: string; initialized: boolean; note?: string; hwm?: number;
  cap?: number | null; reserve?: number; ledger?: any[] };
type DivStatus = { policy: { baseline: number; cap_growth_q: number; reserve_rate_pa: number };
  truenorth: DivBook; openalpha: DivBook };

function rup(n: number | null | undefined) {
  return n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function HowItWorksModal({ onClose }: { onClose: () => void }) {
  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 60,
               display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 640, maxHeight: '85vh', overflowY: 'auto', borderRadius: 10,
                 background: 'var(--surface, #16181d)', color: 'var(--ink, #e8e8e8)',
                 border: '1px solid var(--hairline, #333)', padding: '22px 26px',
                 fontSize: 13.5, lineHeight: 1.65 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Where the 25% carve-out comes in</div>
          <button onClick={onClose}
            style={{ border: 'none', background: 'transparent', color: 'inherit',
                     fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <p><b>It comes in nowhere in the trading loop — and that's deliberate.</b> Both
        engines size positions as a % of current NAV: a closed trade's profit lands in
        cash, sweeps into CASHIETF, and the next entry is sized off the bigger book. The
        engines have no concept of "distributable."</p>
        <ol style={{ paddingLeft: 20, margin: '10px 0' }}>
          <li style={{ marginBottom: 8 }}><b>Between record dates (91 days at a time):
          nothing changes.</b> The engine trades the full book and 100% of booked profit
          reinvests, exactly as coded. No per-trade skimming — that would starve
          compounding and add churn.</li>
          <li style={{ marginBottom: 8 }}><b>On the quarter-end record date only</b>, the
          dividend engine (a separate 19:15 cron) does the accounting: NAV vs the
          high-water mark — flow-adjusted, so your own deposits never count as "profit" —
          then entitlement = 25% of the excess, then the smoothed cap (last dividend
          +7.5%/qtr; surplus banks into the equalization reserve).</li>
          <li style={{ marginBottom: 8 }}><b>The money physically leaves the way a
          withdrawal does</b>: from cash + CASHIETF redemption only. Positions are never
          force-sold. The paid amount goes to the distribution pool (the notice carries
          the Zerodha Console amount for the bank leg); the reserve sits in its own
          liquid pocket outside book NAV.</li>
          <li style={{ marginBottom: 8 }}><b>From the next cycle the engine simply sizes
          off the smaller NAV.</b> To the trading loop a dividend is indistinguishable
          from a withdrawal you made yourself — which is why no engine code was touched.</li>
          <li><b>Edge rule:</b> if the book is fully deployed and liquid cash is less
          than the entitlement, the outflow is clipped to what's liquid — capital is
          never invaded and nothing is ever force-sold to pay a dividend.</li>
        </ol>
        <p style={{ opacity: 0.75, marginBottom: 0 }}>Policy evidence: research/142
        <code> dividend_sim_v2.py</code> variant E — 10-yr sim on ₹10L: ₹21.7L paid,
        ending NAV ₹1.14Cr + ₹15.6L reserve, 24 consecutive rising quarterly payouts
        2020-Q4 → 2026 through two drawdowns.</p>
      </div>
    </div>
  );
}

type SimRow = { year: number; q: (number | null)[]; src: string[]; profit: number;
  total: number; reserve: number };
type SimFeed = { policy: string; seed_capital: number; rows: SimRow[]; total_paid: number;
  total_profit: number; end_nav: number; end_reserve: number; note: string };

function DividendsCard() {
  const [dv, setDv] = useState<DivStatus | null>(null);
  const [sim, setSim] = useState<SimFeed | null>(null);
  const [showSim, setShowSim] = useState(false);
  const [prev, setPrev] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHow, setShowHow] = useState(false);
  useEffect(() => {
    apiGet<DivStatus>('/api/sleeves/dividends').then(setDv).catch(() => setDv(null));
    fetch('/app/dividend_sim.json').then((x) => x.json()).then(setSim).catch(() => setSim(null));
  }, []);
  const preview = () => {
    setBusy(true);
    fetch('/api/sleeves/dividends/preview', { method: 'POST', credentials: 'include' })
      .then((r) => r.json()).then(setPrev).finally(() => setBusy(false));
  };
  const row = (b: DivBook, label: string) => (
    <div style={{ flex: '1 1 260px' }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {b.initialized ? (
        <div className={styles.sub}>
          High-water mark {rup(b.hwm)} · dividend line {b.cap ? `${rup(b.cap)}/qtr` : 'not yet seeded'} ·
          reserve {rup(b.reserve)}
          {b.ledger && b.ledger.length > 0 && (
            <div style={{ marginTop: 4 }}>
              {b.ledger.slice(-4).map((r: any, i: number) => (
                <div key={i}>{r.quarter}: paid {rup(r.paid)} ({r.source}
                  {r.liquidity_clipped ? ', liquidity-clipped' : ''})</div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.sub}>Not yet initialized — HWM seeds at contributed capital on the
          first declaration run.</div>
      )}
    </div>
  );
  return (
    <div className={styles.card} id="dividends">
      <div className={styles.cardTitle} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
        Dividends — quarterly high-water-mark policy
        <a onClick={(e) => { e.preventDefault(); setShowHow(true); }} href="#"
          style={{ fontSize: 12, fontWeight: 500, textDecoration: 'underline', cursor: 'pointer' }}>
          how the carve-out works
        </a>
      </div>
      {showHow && <HowItWorksModal onClose={() => setShowHow(false)} />}
      <p className={styles.note}>
        25% of new profit above the flow-adjusted HWM leaves the book each quarter; the payout is
        capped at last dividend +7.5%/qtr (a smooth, stepping income line); boom surplus banks into
        a liquid equalization reserve (~6% p.a.) that keeps the line paying through profitless
        quarters. Capital is never invaded and positions are never force-sold. Declarations run
        automatically after each quarter end and fire the intimation email / desktop alert with the
        Console withdrawal amount.
      </p>
      {dv ? (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {row(dv.truenorth, 'True North')}
          {row(dv.openalpha, 'Open Alpha')}
        </div>
      ) : (
        <p className={styles.note}>
          Live HWM / reserve / ledger state arrives with the 15:40 IST service reload
          (deferred-restart armed). Anchored today: True North HWM ₹9,37,525 (contributed
          capital — currently underwater, so it correctly pays nothing until recovery),
          Open Alpha HWM ₹9,17,628 (NAV at adoption — backfilled history is capital, never
          distributable). First declaration: 30-Sep-2026, 19:15 cron.
        </p>
      )}
      <div style={{ marginTop: 10 }}>
        <button disabled={busy || !dv} onClick={preview}
          style={{ padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                   border: '1px solid var(--hairline, #ccc)', background: 'var(--surface)', color: 'var(--ink)' }}>
          Preview next declaration (dry run)
        </button>
      </div>
      {sim && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--hairline, rgba(0,0,0,0.12))', paddingTop: 12 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); setShowSim(!showSim); }}
             style={{ fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
            {showSim ? '▾' : '▸'} What this policy would have paid — 10-year rehearsal
          </a>
          <span style={{ fontSize: 12.5, color: 'var(--ink-muted,#888)', marginLeft: 8 }}>
            ₹10L seed → ₹{(sim.total_paid / 100000).toFixed(1)}L paid out · book ends
            ₹{(sim.end_nav / 100000).toFixed(1)}L + ₹{(sim.end_reserve / 100000).toFixed(1)}L reserve
          </span>
          {showSim && (
            <div style={{ marginTop: 10 }}>
              <div style={{ overflowX: 'auto' }}>
                <table className={styles.tbl}
                       style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', width: 'auto' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', paddingRight: 14 }}>Year</th>
                      <th style={{ textAlign: 'right', paddingLeft: 18 }}>Q1</th>
                      <th style={{ textAlign: 'right', paddingLeft: 18 }}>Q2</th>
                      <th style={{ textAlign: 'right', paddingLeft: 18 }}>Q3</th>
                      <th style={{ textAlign: 'right', paddingLeft: 18 }}>Q4</th>
                      <th style={{ textAlign: 'right', paddingLeft: 26, whiteSpace: 'nowrap' }}>Year paid</th>
                      <th style={{ textAlign: 'right', paddingLeft: 26, whiteSpace: 'nowrap' }}>New profit<br />above HWM</th>
                      <th style={{ textAlign: 'right', paddingLeft: 26, whiteSpace: 'nowrap' }}>Reserve<br />at year end</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sim.rows.map((r) => (
                      <tr key={r.year}>
                        <td style={{ fontWeight: 600, textAlign: 'left', paddingRight: 14 }}>{r.year}</td>
                        {r.q.map((v, i) => (
                          <td key={i} style={{ textAlign: 'right', paddingLeft: 18, whiteSpace: 'nowrap' }}>
                            {v == null ? '—' : Math.round(v).toLocaleString('en-IN')}
                            {r.src[i] === 'reserve' && v ? (
                              <sup title="paid from the equalization reserve — no new profit that quarter"
                                   style={{ color: 'var(--brand-amber,#C97B20)' }}>r</sup>
                            ) : null}
                          </td>
                        ))}
                        <td style={{ textAlign: 'right', paddingLeft: 26, fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {r.total.toLocaleString('en-IN')}</td>
                        <td style={{ textAlign: 'right', paddingLeft: 26, whiteSpace: 'nowrap',
                                     color: r.profit === 0 ? 'var(--accent-neg,#A32D2D)' : 'inherit' }}>
                          {r.profit.toLocaleString('en-IN')}</td>
                        <td style={{ textAlign: 'right', paddingLeft: 26, whiteSpace: 'nowrap',
                                     color: 'var(--ink-muted,#888)' }}>
                          {r.reserve.toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: '2px solid var(--hairline,rgba(0,0,0,0.14))', fontWeight: 700 }}>
                      <td style={{ textAlign: 'left', paddingRight: 14 }}>Total</td>
                      <td colSpan={4} />
                      <td style={{ textAlign: 'right', paddingLeft: 26, whiteSpace: 'nowrap' }}>
                        {sim.total_paid.toLocaleString('en-IN')}</td>
                      <td style={{ textAlign: 'right', paddingLeft: 26, whiteSpace: 'nowrap' }}>
                        {sim.total_profit.toLocaleString('en-IN')}</td>
                      <td style={{ textAlign: 'right', paddingLeft: 26, whiteSpace: 'nowrap' }}>
                        {sim.end_reserve.toLocaleString('en-IN')}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className={styles.note}>
                <sup style={{ color: 'var(--brand-amber,#C97B20)' }}>r</sup> = bridged by the equalization
                reserve (a quarter with no new profit). Read the profit column against the payouts: the policy
                distributes ~25% of genuinely new profit, so a zero-profit year pays only what the reserve can
                bridge — 2018–19 and 2022 show that working. {sim.note}
              </p>
            </div>
          )}
        </div>
      )}

      {prev && ['truenorth', 'openalpha'].map((k) => {
        const p = prev[k];
        return (
          <p key={k} className={styles.note}>
            <b>{k === 'truenorth' ? 'True North' : 'Open Alpha'}:</b>{' '}
            {p?.skipped ? p.skipped :
              p?.declaration ? `NAV ${rup(p.declaration.nav)} vs HWM ${rup(p.declaration.flow_adjusted_hwm_before)} → ` +
                `new profit ${rup(p.declaration.new_profit)} → would pay ${rup(p.declaration.paid)} ` +
                `(${p.declaration.source}), reserve after ${rup(p.declaration.reserve_after)}`
              : 'no data'}
          </p>
        );
      })}
    </div>
  );
}

export default function CapitalDesk() {
  const [mom, setMom] = useState<MomState | null>(null);
  const [bs, setBs] = useState<BsFeed | null>(null);
  const [tn, setTn] = useState<TnBench | null>(null);
  useEffect(() => {
    apiGet<MomState>('/api/momentum-paper/state').then(setMom).catch(() => setMom(null));
    fetch('/app/bluesky_paper.json').then((r) => r.json()).then(setBs).catch(() => setBs(null));
    apiGet<TnBench>('/api/momentum-paper/benchmarks').then(setTn).catch(() => setTn(null));
  }, []);

  /* Drive True North off the TIME-WEIGHTED curve, never off NAV: deposits are not
     returns. Falls back to nothing rather than to NAV, because a wrong line is worse
     than a missing one. */
  const tMap = new Map((tn?.book ?? []).map((r) => [r.d, r]));
  const rows = (bs?.nav_curve ?? []).filter((r) => tMap.has(r.date));
  const enough = rows.length >= 25;

  const win = rows.length;
  const tnFirst = rows.length ? tMap.get(rows[0].date)! : null;
  const tnLast = rows.length ? tMap.get(rows[rows.length - 1].date)! : null;
  /* r is cumulative-since-inception in %, so the window return chains the two ends. */
  const tnWin = tnFirst && tnLast
    ? ((1 + tnLast.r / 100) / (1 + tnFirst.r / 100) - 1) * 100 : null;
  const oaWin = rows.length ? (rows[rows.length - 1].nav / rows[0].nav - 1) * 100 : null;
  const nbFirst = rows.find((r) => r.bench != null)?.bench ?? null;
  const nbLast = [...rows].reverse().find((r) => r.bench != null)?.bench ?? null;
  const nbWin = nbFirst && nbLast ? (nbLast / nbFirst - 1) * 100 : null;

  function ddOf(v: number[]) {
    let peak = v[0] ?? 1, d = 0;
    for (const x of v) { peak = Math.max(peak, x); d = Math.min(d, x / peak - 1); }
    return d * 100;
  }
  const tnDD = rows.length ? ddOf(rows.map((r) => 1 + tMap.get(r.date)!.r / 100)) : null;
  const oaDD = rows.length ? ddOf(rows.map((r) => r.nav)) : null;

  const cell = (v: number | null) =>
    v == null ? <span className={styles.muted}>—</span>
      : <b className={v >= 0 ? styles.pos : styles.neg}>{pct(v)}</b>;

  let combined: React.ReactNode = null;
  if (enough && mom && bs && tn) {
    const dates = rows.map((r) => r.date);
    const bV = rows.map((r) => 100 * r.nav / rows[0].nav);
    /* time-weighted, so the funding that took this book from Rs2.98L to Rs9.07L
       inside the window does not masquerade as +205% of performance */
    const mV = rows.map((r) => 100 * (1 + tMap.get(r.date)!.r / 100) / (1 + tnFirst!.r / 100));
    const benchRaw = rows.map((r) => r.bench);
    const b0 = benchRaw.find((v) => v != null) ?? 1;
    const nV = benchRaw.map((v) => (v == null ? NaN : 100 * v / (b0 as number)));
    const blend = blend5050(dates, mV, bV);
    const sM = stats(mV, dates), sB = stats(bV, dates), sX = stats(blend, dates);
    const corr = corrMonthly(dates, mV, bV);
    combined = (
      <>
        <div className={styles.tiles}>
          <div className={styles.tile}><div>True North</div>
            <b className={sM.total >= 0 ? styles.pos : styles.neg}>{pct(sM.total)}</b></div>
          <div className={styles.tile}><div>Open Alpha</div>
            <b className={sB.total >= 0 ? styles.pos : styles.neg}>{pct(sB.total)}</b></div>
          <div className={styles.tile}><div>50-50 blend</div>
            <b className={sX.total >= 0 ? styles.pos : styles.neg}>{pct(sX.total)}</b></div>
          <div className={styles.tile}><div>Blend CAGR</div><b>{pct(sX.cagr)}</b></div>
          <div className={styles.tile}><div>Blend MaxDD</div><b className={styles.neg}>{pct(sX.dd)}</b></div>
          <div className={styles.tile}><div>Monthly corr</div><b>{corr == null ? '—' : corr.toFixed(2)}</b></div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            Growth of 100 (log) — gold = 50-50 blend · green = True North · blue = Open Alpha · dashed = NIFTYBEES
          </div>
          <MultiCurve dates={dates} lines={[
            { name: 'NIFTYBEES', v: nV.map((v) => (isNaN(v) ? 100 : v)), color: 'var(--ink-muted)', dash: '4 3' },
            { name: 'True North', v: mV, color: '#1f9d55' },
            { name: 'Open Alpha', v: bV, color: '#3b82d6' },
            { name: '50-50 blend', v: blend, color: '#d4a017' },
          ]} />
        </div>
      </>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>Capital Desk</h1>
          <div className={styles.sub}>
            Every rupee in and out, and the target it is working toward · {win} overlapping
            trading days
            {bs && bs.n_live_trades === 0
              ? ' — True North LIVE against the Open Alpha reference model'
              : ' of common live history'}
          </div>
        </div>
      </div>

      <div className={styles.tiles}>
        <div className={styles.tile}><div>Portfolio NAV</div>
          <b>{mom && bs ? '₹' + Math.round(mom.nav + bs.nav).toLocaleString('en-IN') : '…'}</b></div>
        <div className={styles.tile}><div>True North NAV</div>
          <b>{mom ? '₹' + Math.round(mom.nav).toLocaleString('en-IN') : '…'}</b></div>
        <div className={styles.tile}><div>Open Alpha NAV</div>
          <b>{bs ? '₹' + Math.round(bs.nav).toLocaleString('en-IN') : '…'}</b></div>
        <div className={styles.tile}><div>Overlapping days</div><b>{win || '…'}</b></div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>
          Each sleeve over the SAME {win} days — measured the same way
        </div>
        <table className={styles.tbl}>
          <thead>
            <tr><th className={styles.txt}>&nbsp;</th><th>True North</th><th>Open Alpha</th>
              <th>NIFTYBEES</th></tr>
          </thead>
          <tbody>
            <tr><td className={styles.txt}>Money at risk</td>
              <td>{mom?.mode === 'LIVE' ? 'LIVE · real' : 'paper'}</td>
              <td>paper</td><td className={styles.muted}>index</td></tr>
            <tr><td className={styles.txt}>Record over this window</td>
              <td>live</td>
              <td className={styles.neg}>{bs && bs.n_live_trades === 0 ? 'BACKFILL' : 'live'}</td>
              <td className={styles.muted}>actual</td></tr>
            <tr><td className={styles.txt}>Return</td>
              <td>{cell(tnWin)}</td><td>{cell(oaWin)}</td><td>{cell(nbWin)}</td></tr>
            <tr><td className={styles.txt}>Max drawdown</td>
              <td>{cell(tnDD)}</td><td>{cell(oaDD)}</td><td className={styles.muted}>—</td></tr>
            <tr><td className={styles.txt}>vs NIFTYBEES</td>
              <td>{cell(tnWin != null && nbWin != null ? tnWin - nbWin : null)}</td>
              <td>{cell(oaWin != null && nbWin != null ? oaWin - nbWin : null)}</td>
              <td className={styles.muted}>—</td></tr>
          </tbody>
        </table>
        <p className={styles.note}>
          True North's return is <b>time-weighted</b> — the book was funded from ₹2.98L to
          ₹9.07L inside this window, and raw NAV would show that ₹6L of deposits as +205% of
          performance. <b>No figure here is annualised.</b> {win} days is not a year, and
          scaling it up is how a −3% becomes a headline in either direction.
        </p>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Backtest evidence — simulated, and not a live record</div>
        <table className={styles.tbl}>
          <thead>
            <tr><th className={styles.txt}>&nbsp;</th><th>True North</th><th>Open Alpha</th>
              <th>50-50 blend</th></tr>
          </thead>
          <tbody>
            <tr><td className={styles.txt}>Period</td>
              <td>2005→2026</td><td>2020→2026</td><td>2006→2026</td></tr>
            <tr><td className={styles.txt}>CAGR</td>
              <td>31.8%</td><td>{pct(bs?.cagr_pct ?? null)}</td><td>33.0%</td></tr>
            <tr><td className={styles.txt}>Max drawdown</td>
              <td className={styles.neg}>−31.6%</td>
              <td className={styles.neg}>{pct(bs?.max_dd_pct ?? null)}</td>
              <td className={styles.neg}>−27.5%</td></tr>
            <tr><td className={styles.txt}>Trades · win rate</td>
              <td className={styles.muted}>—</td>
              <td>{bs ? `${bs.n_trades} · ${bs.win_pct}%` : '—'}</td>
              <td className={styles.muted}>—</td></tr>
            <tr><td className={styles.txt}>Total return</td>
              <td className={styles.muted}>—</td>
              <td>{pct(bs?.ret_pct ?? null)}</td>
              <td className={styles.muted}>—</td></tr>
            <tr><td className={styles.txt}>Study</td>
              <td><a className={styles.studyLink} href="/app/backtest/nifty250-momentum-video">research/75</a></td>
              <td><a className={styles.studyLink} href="/app/backtest/bluesky-ath-breakout-research142">research/142</a></td>
              <td className={styles.muted}>—</td></tr>
          </tbody>
        </table>
        <p className={styles.note}>
          <b>Open Alpha's {pct(bs?.ret_pct ?? null)} is a {bs ? '6.7' : ''}-year simulation, not
          money made.</b> It used to sit in the header beside True North's live nineteen days,
          where the eye read one row and saw one comparison. A total return only means something
          next to the years it took, so it lives here with its period attached and never in a
          tile of its own.
        </p>
      </div>

      {combined ?? (
        <div className={styles.card}>
          <div className={styles.cardTitle}>Combined performance — building</div>
          <p className={styles.note}>
            The blended curve appears once the two books share ≥25 overlapping trading days
            ({win} so far — True North's own curve starts {tn?.inception ?? '10-Aug-2026'}).
            The backtested blend (33.0% CAGR at −27.5% DD, 2006→2026) is on the{' '}
            <a href="/app/backtest/bluesky-ath-breakout-research142">study page</a>, and the
            live scoreboard above is what actually exists so far.
          </p>
        </div>
      )}

      <AllocationDesk />
      <FundsPanel />
      <DividendsCard />
    </div>
  );
}
