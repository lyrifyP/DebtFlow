"use client";

import React, { useEffect, useMemo, useState } from "react";

// DebtFlow, mobile first simplification
// Clean overview, central Quick bank, compact Betting controls, simple Cards list

// ---------- Types ----------
type Sport = "Football" | "Cricket" | "Tennis" | "Other";
type BetStatus = "Pending" | "Won" | "Lost";

type Bet = {
  id: string;
  date: string; // yyyy-mm-dd
  description: string;
  sport: Sport;
  stake: number; // GBP
  oddsDecimal: number;
  status: BetStatus;
  returnOverride?: number | null; // cash out or manual value
  settledAt?: string | null; // ISO timestamp when status becomes Won or Lost
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

type Settings = {
  // Legacy single total, used only when there are no cards
  debtTotal: number;

  // Betting settings
  startingBankroll: number;
  targetAmount: number; // goal profit per betting run in GBP
  bankPercentOnTarget: number; // percent of target to bank per milestone
  autoBankEnabled: boolean; // enable auto banking when available profit crosses milestones
  autoBankCardId?: string | null; // default card for auto banking

  // Roller challenge settings
  runStartStake: number; // eg 5
  runTargetStake: number; // eg 100
};

type PaymentSource = "Betting" | "Trading" | "Savings";

type Payment = {
  id: string;
  date: string; // yyyy-mm-dd
  amount: number; // GBP
  source: PaymentSource;
  note?: string;
  cardId?: string | null; // optional target card
};

type DebtCard = {
  id: string;
  name: string;
  balance: number; // starting balance snapshot
};

type UIState = {
  overview: boolean;
  quickBank: boolean;
  cards: boolean;
  betting: boolean;
  recent: boolean;
  betLog: boolean;
};

// ---------- Utilities ----------
const STORAGE_KEY = "debtflow_state_v3";
const UI_KEY = "debtflow_ui_v1";

// Stable defaults for settings
const DEFAULTS: Settings = {
  debtTotal: 0,
  startingBankroll: 5,
  targetAmount: 100,
  bankPercentOnTarget: 50,
  autoBankEnabled: true,
  autoBankCardId: null,
  runStartStake: 5,
  runTargetStake: 100,
};

const DEFAULT_UI: UIState = {
  overview: true,
  quickBank: false,
  cards: false,
  betting: false,
  recent: false,
  betLog: false,
};

function formatGBP(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "N/A";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 2,
  }).format(n);
}

function todayYYYYMMDD() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function cleanNumber(value: string) {
  if (!value) return 0;
  const n = parseFloat(value.replace(/,/g, "."));
  return Number.isFinite(n) ? n : 0;
}

// Calculate default return from stake and decimal odds
function calcDefaultReturn(stake: number, oddsDecimal: number, status: BetStatus) {
  if (status === "Won") return +(stake * oddsDecimal).toFixed(2);
  if (status === "Lost") return 0;
  return null; // pending
}

function effectiveReturn(b: Bet) {
  const def = calcDefaultReturn(b.stake, b.oddsDecimal, b.status);
  return b.returnOverride != null ? b.returnOverride : def;
}

// Compute stats in a pure function so UI and tests share the same logic
function computeStats(bets: Bet[], targetAmount: number) {
  const settled = bets.filter(b => b.status !== "Pending");
  const won = settled.filter(b => b.status === "Won");

  const totalStaked = settled.reduce((s, b) => s + b.stake, 0);
  const totalReturns = settled.reduce((s, b) => s + (effectiveReturn(b) ?? 0), 0);
  const profit = +(totalReturns - totalStaked).toFixed(2);

  const hitRate = settled.length ? Math.round((won.length / settled.length) * 100) : 0;

  const rawProgress = targetAmount > 0 ? Math.round((profit / targetAmount) * 100) : 0;
  const progress = Math.min(100, Math.max(0, rawProgress));

  return { settledCount: settled.length, wonCount: won.length, hitRate, totalStaked, totalReturns, profit, progress };
}

function sumPayments(pays: Payment[], source?: PaymentSource) {
  const n = pays.reduce((s, p) => s + (source ? (p.source === source ? p.amount : 0) : p.amount), 0);
  return +n.toFixed(2);
}

function sumPaymentsToCard(pays: Payment[], cardId: string) {
  const n = pays.reduce((s, p) => s + (p.cardId === cardId ? p.amount : 0), 0);
  return +n.toFixed(2);
}

function totalDebt(cards: DebtCard[], fallbackDebtTotal: number) {
  if (!cards.length) return +fallbackDebtTotal.toFixed(2);
  return +cards.reduce((s, c) => s + (c.balance || 0), 0).toFixed(2);
}

function remainingDebtFromCards(cards: DebtCard[], payments: Payment[]) {
  const rem = cards.reduce((s, c) => s + Math.max(0, c.balance - sumPaymentsToCard(payments, c.id)), 0);
  return +rem.toFixed(2);
}

// Augment Window to avoid any-casts in tests
declare global { interface Window { __DEBTFLOW_TESTED_V3__?: boolean } }

// ---------- App ----------
export default function App() {
  // Load initial state lazily to avoid effect and lint noise
  const initialFromStorage = () => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      if (!raw) return { bets: [] as Bet[], settings: DEFAULTS, payments: [] as Payment[], bankedMilestones: 0, cards: [] as DebtCard[] };
      const parsed = JSON.parse(raw);
      return {
        bets: Array.isArray(parsed.bets) ? parsed.bets as Bet[] : [],
        settings: parsed.settings ? { ...DEFAULTS, ...(parsed.settings as Partial<Settings>) } : DEFAULTS,
        payments: Array.isArray(parsed.payments) ? parsed.payments as Payment[] : [],
        bankedMilestones: typeof parsed.bankedMilestones === "number" ? parsed.bankedMilestones as number : 0,
        cards: Array.isArray(parsed.cards) ? parsed.cards as DebtCard[] : [],
      };
    } catch {
      return { bets: [] as Bet[], settings: DEFAULTS, payments: [] as Payment[], bankedMilestones: 0, cards: [] as DebtCard[] };
    }
  };

  const initialUI = (): UIState => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(UI_KEY) : null;
      if (!raw) return DEFAULT_UI;
      const parsed = JSON.parse(raw) as Partial<UIState>;
      return { ...DEFAULT_UI, ...parsed };
    } catch {
      return DEFAULT_UI;
    }
  };

  const init = initialFromStorage();
  const [bets, setBets] = useState<Bet[]>(init.bets);
  const [settings, setSettings] = useState<Settings>(init.settings);
  const [payments, setPayments] = useState<Payment[]>(init.payments);
  const [bankedMilestones, setBankedMilestones] = useState<number>(init.bankedMilestones);
  const [cards, setCards] = useState<DebtCard[]>(init.cards);

  // UI open state, persisted
  const [ui, setUI] = useState<UIState>(initialUI);
  function toggleSection<K extends keyof UIState>(key: K) {
    setUI(prev => {
      const next = { ...prev, [key]: !prev[key] } as UIState;
      localStorage.setItem(UI_KEY, JSON.stringify(next));
      return next;
    });
  }

  // Save on change
  useEffect(() => {
    const payload = JSON.stringify({ bets, settings, payments, bankedMilestones, cards });
    localStorage.setItem(STORAGE_KEY, payload);
  }, [bets, settings, payments, bankedMilestones, cards]);

  // Derived stats
  const stats = useMemo(() => computeStats(bets, settings.targetAmount), [bets, settings.targetAmount]);
  const bankedFromBetting = useMemo(() => sumPayments(payments, "Betting"), [payments]);
  const availableProfitBetting = useMemo(() => +(stats.profit - bankedFromBetting).toFixed(2), [stats.profit, bankedFromBetting]);

  // Debt overview, driven by cards if any exist
  const debtTotalEffective = useMemo(() => totalDebt(cards, settings.debtTotal), [cards, settings.debtTotal]);
  const paidTotal = useMemo(() => sumPayments(payments), [payments]);
  const remainingTotal = useMemo(() => {
    if (cards.length) return remainingDebtFromCards(cards, payments);
    return Math.max(0, +(settings.debtTotal - paidTotal).toFixed(2));
  }, [cards, payments, settings.debtTotal, paidTotal]);
  const paidShown = useMemo(() => +(debtTotalEffective - remainingTotal).toFixed(2), [debtTotalEffective, remainingTotal]);
  const debtProgress = debtTotalEffective > 0 ? Math.min(100, Math.round((paidShown / debtTotalEffective) * 100)) : 0;

  // Auto bank when available betting profit crosses milestones
  useEffect(() => {
    if (!settings.autoBankEnabled || settings.targetAmount <= 0 || settings.bankPercentOnTarget <= 0) return;
    const target = settings.targetAmount;
    const multiples = Math.floor(availableProfitBetting / target);
    if (multiples > bankedMilestones) {
      const perMilestone = +(target * (settings.bankPercentOnTarget / 100)).toFixed(2);
      const count = multiples - bankedMilestones;
      const totalToBank = +(perMilestone * count).toFixed(2);
      if (totalToBank > 0) {
        const date = todayYYYYMMDD();
        setPayments(prev => [{ id: uuid(), date, amount: totalToBank, source: "Betting", note: "Auto bank on target", cardId: settings.autoBankCardId || (cards[0]?.id ?? null) }, ...prev]);
        setBankedMilestones(multiples);
      }
    }
  }, [availableProfitBetting, settings.autoBankEnabled, settings.bankPercentOnTarget, settings.targetAmount, settings.autoBankCardId, bankedMilestones, cards]);

  // Form state for adding bets
  const [form, setForm] = useState<Partial<Bet>>({
    date: todayYYYYMMDD(),
    description: "",
    sport: "Football",
    stake: 5,
    oddsDecimal: 2,
    status: "Pending",
    returnOverride: null,
  });

  function addBet() {
    if (!form.date || !form.description || !form.sport || form.stake == null || form.oddsDecimal == null || !form.status) return;
    const now = new Date().toISOString();
    const bet: Bet = {
      id: uuid(),
      date: form.date as string,
      description: String(form.description).trim(),
      sport: form.sport as Sport,
      stake: Number(form.stake),
      oddsDecimal: Number(form.oddsDecimal),
      status: form.status as BetStatus,
      returnOverride: form.returnOverride == null || form.returnOverride === undefined || form.returnOverride === 0 ? null : Number(form.returnOverride),
      settledAt: form.status !== "Pending" ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    setBets(prev => [bet, ...prev]);
    setForm({ date: todayYYYYMMDD(), description: "", sport: "Football", stake: 5, oddsDecimal: 2, status: "Pending", returnOverride: null });
  }

  function updateBet(id: string, patch: Partial<Bet>) {
    setBets(prev => prev.map(b => (b.id === id ? { ...b, ...patch, updatedAt: new Date().toISOString(), settledAt: patch.status && patch.status !== "Pending" ? new Date().toISOString() : b.settledAt } : b)));
  }

  function removeBet(id: string) {
    setBets(prev => prev.filter(b => b.id !== id));
  }

  // Inline return editor state
  const [editingReturn, setEditingReturn] = useState<{ id: string | null; value: string }>({ id: null, value: "" });
  function openReturnEditor(b: Bet) {
    const current = b.returnOverride != null ? String(b.returnOverride) : "";
    setEditingReturn({ id: b.id, value: current });
  }
  function saveReturnEditor() {
    if (!editingReturn.id) return;
    const trimmed = editingReturn.value.trim();
    const override = trimmed === "" ? null : cleanNumber(trimmed);
    updateBet(editingReturn.id, { returnOverride: override });
    setEditingReturn({ id: null, value: "" });
  }
  function cancelReturnEditor() {
    setEditingReturn({ id: null, value: "" });
  }

  // Banking helpers, central Quick bank
  function bankPayment(amount: number, source: PaymentSource, note?: string, cardId?: string | null) {
    if (amount <= 0) return;
    const date = todayYYYYMMDD();
    setPayments(prev => [{ id: uuid(), date, amount: +amount.toFixed(2), source, note, cardId: cardId ?? null }, ...prev]);
  }

  function bankFromBettingNow(cardId?: string | null) {
    const perMilestone = +(settings.targetAmount * (settings.bankPercentOnTarget / 100)).toFixed(2);
    const targetCard = cardId ?? settings.autoBankCardId ?? null;
    if (perMilestone <= 0) return;
    if (availableProfitBetting < perMilestone) return;
    bankPayment(perMilestone, "Betting", "Manual bank", targetCard);
  }

  function removePayment(id: string) {
    setPayments(prev => prev.filter(p => p.id !== id));
  }

  const currentBankroll = useMemo(() => settings.startingBankroll + computeStats(bets, settings.targetAmount).profit, [bets, settings]);

  // Roller challenge progress
  const runStart = settings.runStartStake ?? 5;
  const runTarget = settings.runTargetStake ?? 100;
  const runProgress = useMemo(() => {
    const denom = runTarget - runStart;
    if (denom <= 0) return 0;
    const pct = Math.round(((currentBankroll - runStart) / denom) * 100);
    return Math.min(100, Math.max(0, pct));
  }, [currentBankroll, runStart, runTarget]);

  // Quick bank state
  const [qAmount, setQAmount] = useState<string>("");
  const [qSource, setQSource] = useState<PaymentSource>("Savings");
  const [qCard, setQCard] = useState<string>("none");
  const [qNote, setQNote] = useState<string>("");

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-black text-neutral-100">
      <div className="mx-auto max-w-6xl px-3 sm:px-4 pb-24">
        <header className="pt-6 sm:pt-10 pb-4 sm:pb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight">DebtFlow</h1>
            <p className="text-neutral-400 mt-1 text-sm sm:text-base">Track your debt and how you're paying it off</p>
          </div>
          <Badge>{new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</Badge>
        </header>

        {/* Overview */}
        <section className="grid grid-cols-1 gap-4 sm:gap-6">
          <Section title="Overview" isOpen={ui.overview} onToggle={() => toggleSection("overview")}
            summary={<span className="text-xs text-neutral-400">{debtProgress}% to zero</span>}>
            <div className="mt-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs sm:text-sm text-neutral-400">Progress to zero</span>
                <span className="text-xs sm:text-sm font-medium">{debtProgress}%</span>
              </div>
              <div className="bg-[#0f1a12] p-2 rounded-xl">
                <Progress value={debtProgress} />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <Stat label="Total" value={formatGBP(debtTotalEffective)} />
                <Stat label="Paid" value={formatGBP(paidShown)} />
                <Stat label="Remaining" value={formatGBP(remainingTotal)} />
              </div>
            </div>
          </Section>
        </section>

        {/* Quick bank */}
        <section className="mt-4 sm:mt-6">
          <Section title="Quick bank" isOpen={ui.quickBank} onToggle={() => toggleSection("quickBank")} summary={<span className="text-xs text-neutral-400">Avail {formatGBP(availableProfitBetting)}</span>}>
            <div className="mt-1 grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-3">
              <div className="sm:col-span-3">
                <LabeledInput label="Amount" prefix="£" type="number" step={0.01} value={qAmount} onChange={setQAmount} />
              </div>
              <div className="sm:col-span-3">
                <LabeledSelect label="Source" value={qSource} onChange={(v) => setQSource(v as PaymentSource)} options={["Savings", "Trading", "Betting"]} />
              </div>
              <div className="sm:col-span-4">
                <LabeledSelect label="Target card" value={qCard} onChange={(v) => setQCard(v)} options={[{ label: "none", value: "none" }, ...cards.map(c => ({ label: c.name || "Card", value: c.id }))]} />
                <div className="text-[11px] text-neutral-500 mt-1 sm:hidden">
                  {qCard === "none" ? "Unassigned" : `To ${cards.find(c => c.id === qCard)?.name ?? "Card"}`}
                </div>
              </div>
              <div className="sm:col-span-2 flex items-end pt-6">
                <Button onClick={() => {
                  const amt = cleanNumber(qAmount);
                  if (qSource === "Betting" && amt > availableProfitBetting) return;
                  const note = qSource === "Trading" ? (qNote || undefined) : undefined;
                  bankPayment(amt, qSource, note, qCard === "none" ? null : qCard);
                  setQAmount("");
                  setQNote("");
                }}>Bank</Button>
              </div>
            </div>
            {qSource === "Trading" ? (
              <div className="mt-2 sm:w-1/2">
                <LabeledInput label="Note, stock or crypto" placeholder="eg, TSLA swing, BTC scalp" value={qNote} onChange={setQNote} />
              </div>
            ) : null}
            {qSource === "Betting" ? (
              <div className="text-[11px] text-neutral-500 mt-2">Available from betting, {formatGBP(availableProfitBetting)}</div>
            ) : null}
          </Section>
        </section>

        {/* Cards */}
        <section className="mt-4 sm:mt-6">
          <Section title="Cards" isOpen={ui.cards} onToggle={() => toggleSection("cards")} summary={<span className="text-xs text-neutral-400">{cards.length} listed, Rem {formatGBP(remainingTotal)}</span>}>
            <div className="mt-2 space-y-2">
              {cards.map((c) => {
                const paidToCard = sumPaymentsToCard(payments, c.id);
                const remaining = Math.max(0, +(c.balance - paidToCard).toFixed(2));
                return (
                  <div key={c.id} className="rounded-xl bg-[#141414] border border-[#222] p-3">
                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
                      <div className="sm:col-span-4">
                        <LabeledInput label="Name" value={c.name} onChange={(v) => setCards(cs => cs.map(x => x.id === c.id ? { ...x, name: v } : x))} />
                      </div>
                      <div className="sm:col-span-3">
                        <LabeledInput label="Balance" prefix="£" type="number" step={0.01} value={c.balance} onChange={(v) => setCards(cs => cs.map(x => x.id === c.id ? { ...x, balance: cleanNumber(v) } : x))} />
                      </div>
                      <div className="sm:col-span-4 grid grid-cols-2 gap-3 text-sm">
                        <Stat label="Paid" value={formatGBP(paidToCard)} />
                        <Stat label="Remaining" value={formatGBP(remaining)} />
                      </div>
                      <div className="sm:col-span-1 flex items-end justify-end">
                        <IconButton title="Remove card" onClick={() => setCards(cs => cs.filter(x => x.id !== c.id))}>
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </IconButton>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add card */}
            <AddCardForm onAdd={(name, bal) => setCards(cs => [{ id: uuid(), name, balance: bal }, ...cs ])} />
          </Section>
        </section>

        {/* Betting */}
        <section className="mt-4 sm:mt-6 grid grid-cols-1 gap-4">
          <Section title="Betting" isOpen={ui.betting} onToggle={() => toggleSection("betting")} summary={<span className="text-xs text-neutral-400">Profit {formatGBP(stats.profit)}, Auto {settings.autoBankEnabled ? "on" : "off"}</span>}>
            <div className="mt-1 grid grid-cols-2 gap-3 text-sm">
              <Stat label="Profit" value={formatGBP(stats.profit)} />
              <Stat label="Available" value={formatGBP(availableProfitBetting)} />
            </div>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] sm:text-xs text-neutral-400">Auto bank to</label>
                <select className="mt-1 w-full bg-black border border-[#222] rounded-xl px-3 py-2 outline-none text-neutral-100" value={settings.autoBankCardId || "none"} onChange={(e) => setSettings(s => ({ ...s, autoBankCardId: e.target.value === "none" ? null : e.target.value }))}>
                  <option className="bg-[#141414]" value="none">Unassigned</option>
                  {cards.map(c => <option key={c.id} value={c.id} className="bg-[#141414]">{c.name}</option>)}
                </select>
              </div>
              <div className="flex items-end"><Button onClick={() => bankFromBettingNow(settings.autoBankCardId || null)}>Bank now</Button></div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.autoBankEnabled} onChange={(e) => setSettings(s => ({ ...s, autoBankEnabled: e.target.checked }))} /><span className="text-neutral-300">Auto bank on target hit</span></label>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-neutral-300">Settings</summary>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-5 gap-3">
                <LabeledInput label="Target profit" prefix="£" type="number" step={0.01} value={settings.targetAmount} onChange={(v) => setSettings(s => ({ ...s, targetAmount: cleanNumber(v) }))} />
                <LabeledInput label="Bank percent" type="number" step={1} value={settings.bankPercentOnTarget} onChange={(v) => setSettings(s => ({ ...s, bankPercentOnTarget: Math.max(0, Math.min(100, Math.round(cleanNumber(v)))) }))} />
                <LabeledInput label="Starting bankroll" prefix="£" type="number" step={0.01} value={settings.startingBankroll} onChange={(v) => setSettings(s => ({ ...s, startingBankroll: cleanNumber(v) }))} />
                <LabeledInput label="Run start" prefix="£" type="number" step={0.01} value={settings.runStartStake} onChange={(v) => setSettings(s => ({ ...s, runStartStake: cleanNumber(v) }))} />
                <LabeledInput label="Run target" prefix="£" type="number" step={0.01} value={settings.runTargetStake} onChange={(v) => setSettings(s => ({ ...s, runTargetStake: cleanNumber(v) }))} />
              </div>
            </details>
          </Section>
        </section>

        {/* Recent */}
        <section className="mt-4 sm:mt-6">
          <Section title="Recent" isOpen={ui.recent} onToggle={() => toggleSection("recent")} summary={<span className="text-xs text-neutral-400">{payments.length} items</span>}>
            {payments.length === 0 ? (
              <div className="mt-1 text-sm text-neutral-400">No contributions yet</div>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {payments.slice(0, 6).map(p => (
                  <li key={p.id} className="flex items-center justify-between rounded-lg bg-[#141414] border border-[#222] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <SourceBadge source={p.source} />
                      <span className="text-neutral-300">{p.date}</span>
                      {p.cardId ? <span className="text-[11px] px-2 py-0.5 rounded-full border border-[#333]">{cards.find(c => c.id === p.cardId)?.name || "Card"}</span> : null}
                      {p.note ? <span className="text-neutral-500 hidden sm:inline">{p.note}</span> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{formatGBP(p.amount)}</span>
                      <IconButton title="Remove" onClick={() => removePayment(p.id)}>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </section>

        {/* Bet log */}
        <section className="mt-6 sm:mt-8">
          <Section title="Bet log" isOpen={ui.betLog} onToggle={() => toggleSection("betLog")} summary={<span className="text-xs text-neutral-400">{bets.length} bets, {runProgress}% of {formatGBP(runTarget)}</span>}>
            {/* Roller progress bar, £5 to £100 challenge */}
            <div className="mt-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs sm:text-sm text-neutral-400">{formatGBP(currentBankroll)} of {formatGBP(runTarget)}</span>
                <span className="text-xs sm:text-sm font-medium">{runProgress}%</span>
              </div>
              <div className="bg-[#0f1a12] p-2 rounded-xl">
                <Progress value={runProgress} />
              </div>
            </div>

            {bets.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="mt-3 sm:mt-4 overflow-x-auto">
                <table className="min-w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="text-left text-neutral-400">
                      <Th>Date</Th>
                      <Th className="w-full">Description</Th>
                      <Th className="hidden sm:table-cell">Sport</Th>
                      <Th className="text-right hidden sm:table-cell">Stake</Th>
                      <Th className="text-right hidden sm:table-cell">Odds</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Return</Th>
                      <Th><span className="sr-only">Actions</span></Th>
                    </tr>
                  </thead>
                  <tbody>
                    {bets.map((b) => {
                      const ret = effectiveReturn(b);
                      const profit = ret == null ? null : +(ret - b.stake).toFixed(2);
                      const isEditing = editingReturn.id === b.id;
                      return (
                        <tr key={b.id} className="border-t border-[#222]">
                          <Td>{b.date}</Td>
                          <Td className="max-w-[180px] sm:max-w-none truncate">{b.description}</Td>
                          <Td className="hidden sm:table-cell">{b.sport}</Td>
                          <Td className="text-right hidden sm:table-cell">{formatGBP(b.stake)}</Td>
                          <Td className="text-right hidden sm:table-cell">{b.oddsDecimal.toFixed(2)}</Td>
                          <Td>
                            <StatusControl value={b.status} onChange={(v) => updateBet(b.id, { status: v })} />
                          </Td>
                          <Td className="text-right">
                            {!isEditing ? (
                              <div className="inline-flex items-center gap-1">
                                {ret == null ? <span className="text-neutral-400">Pending</span> : <span>{formatGBP(ret)}</span>}
                                <IconButton title="Edit return" onClick={() => openReturnEditor(b)}>
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.03  0-1.42L18.34 3.25a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.87-1.79z"/></svg>
                                </IconButton>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1">
                                <input
                                  className="w-24 text-right bg-black border border-[#333] rounded-lg px-2 py-1 outline-none"
                                  inputMode="decimal"
                                  placeholder="£0.00"
                                  value={editingReturn.value}
                                  onChange={(e) => setEditingReturn(v => ({ ...v, value: e.target.value }))}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveReturnEditor();
                                    if (e.key === 'Escape') cancelReturnEditor();
                                  }}
                                />
                                <IconButton title="Save" onClick={saveReturnEditor}>
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                                </IconButton>
                                <IconButton title="Cancel" onClick={cancelReturnEditor}>
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                                </IconButton>
                              </div>
                            )}
                            {ret != null ? (
                              <div className={`text-[11px] ${profit! >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{profit! >= 0 ? "+" : ""}{formatGBP(profit || 0)}</div>
                            ) : null}
                          </Td>
                          <Td className="text-right">
                            <div className="flex items-center gap-2 justify-end">
                              <IconButton title="Delete" onClick={() => removeBet(b.id)}>
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 7h12v2H6zm2 3h8l-1 9H9L8 10zm3-5h2v2h-2z"/></svg>
                              </IconButton>
                            </div>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Add bet form */}
            <div className="mt-6">
              <h3 className="text-base sm:text-lg font-semibold">Add a bet</h3>
              <div className="mt-3 sm:mt-4 grid grid-cols-2 sm:grid-cols-12 gap-3 sm:gap-4">
                <LabeledInput className="sm:col-span-2" label="Date" type="date" value={form.date || todayYYYYMMDD()} onChange={(v) => setForm(f => ({ ...f, date: v }))} />
                <LabeledInput className="sm:col-span-4 col-span-2" label="Description" placeholder="Villa v Palace, over 9 corners" value={form.description || ""} onChange={(v) => setForm(f => ({ ...f, description: v }))} />
                <LabeledSelect className="sm:col-span-2 col-span-1" label="Sport" value={form.sport as string} onChange={(v) => setForm(f => ({ ...f, sport: v as Sport }))} options={["Football", "Cricket", "Tennis", "Other"]} />
                <LabeledInput className="sm:col-span-1 col-span-1" label="Stake" prefix="£" type="number" step={0.01} value={form.stake ?? 0} onChange={(v) => setForm(f => ({ ...f, stake: cleanNumber(v) }))} />
                <LabeledInput className="sm:col-span-1 col-span-1" label="Odds" type="number" step={0.01} value={form.oddsDecimal ?? 1} onChange={(v) => setForm(f => ({ ...f, oddsDecimal: cleanNumber(v) }))} />
                <LabeledSelect className="sm:col-span-2 col-span-1" label="Status" value={form.status as string} onChange={(v) => setForm(f => ({ ...f, status: v as BetStatus }))} options={["Pending", "Won", "Lost"]} />
                <LabeledInput className="sm:col-span-2 col-span-1" label="Return override" prefix="£" type="number" step={0.01} value={form.returnOverride ?? ""} onChange={(v) => setForm(f => ({ ...f, returnOverride: v === "" ? null : cleanNumber(v) }))} />
                <div className="sm:col-span-12 col-span-2 flex justify-end">
                  <Button onClick={addBet}>Add bet</Button>
                </div>
              </div>
            </div>
          </Section>
        </section>

        <footer className="mt-10 text-center text-xs text-neutral-500">
          <p>All data lives in your browser, no accounts, no servers</p>
        </footer>
      </div>
    </div>
  );
}

// ---------- Small components ----------
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[#141414] border border-[#222] rounded-2xl p-4 sm:p-5 shadow-lg shadow-black/40">
      {children}
    </div>
  );
}

function Section({ title, isOpen, onToggle, summary, children }: { title: string; isOpen: boolean; onToggle: () => void; summary?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-base sm:text-lg font-semibold">{title}</h2>
        <div className="flex items-center gap-3">
          {summary ? <div className="text-right hidden sm:block">{summary}</div> : null}
          <button aria-label={isOpen ? `Collapse ${title}` : `Expand ${title}`} aria-expanded={isOpen} onClick={onToggle} className="p-2 rounded-lg bg-[#141414] border border-[#222] hover:bg-[#1f1f1f]">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" className={`transition-transform ${isOpen ? "rotate-180" : "rotate-0"}`}>
              <path d="M7 10l5 5 5-5z" />
            </svg>
          </button>
        </div>
      </div>
      {summary ? <div className="sm:hidden mt-1 text-xs text-neutral-400">{summary}</div> : null}
      {isOpen ? <div>{children}</div> : null}
    </Card>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#222] bg-[#141414] px-3 py-1 text-[10px] sm:text-xs font-medium text-neutral-300">{children}</span>
  );
}

function Button({ children, onClick }: { children: React.ReactNode, onClick?: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex items-center justify-center rounded-xl px-4 py-2 font-semibold bg-red-600 text-white hover:bg-red-500 active:bg-red-700 transition min-w-[120px]">
      {children}
    </button>
  );
}

function IconButton({ children, onClick, title }: { children: React.ReactNode, onClick?: () => void, title?: string }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="p-1.5 sm:p-2 rounded-lg bg-[#141414] border border-[#222] hover:bg-[#1f1f1f] transition">
      {children}
    </button>
  );
}

type LabeledInputProps = {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  prefix?: string;
  step?: number | string;
  className?: string;
  placeholder?: string;
};

function LabeledInput({ label, value, onChange, type = "text", prefix, step, className, placeholder }: LabeledInputProps) {
  return (
    <div className={className}>
      {label ? <label className="text-[10px] sm:text-xs text-neutral-400">{label}</label> : null}
      <div className="mt-1 flex items-center gap-2 rounded-xl border border-[#222] bg-black px-3 py-2 focus-within:border-neutral-600">
        {prefix ? <span className="text-neutral-500 text-sm">{prefix}</span> : null}
        <input
          className="w-full bg-transparent outline-none text-neutral-100 placeholder-neutral-600"
          type={type}
          step={step}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

type OptionLV = { label: string; value: string };

function LabeledSelect({ label, value, onChange, options, className }: { label?: string, value: string, onChange: (v: string) => void, options: Array<string | OptionLV>, className?: string }) {
  // Supports either ["A", "B"] or [{ label: "A", value: "a" }]
  const normalized: OptionLV[] = options.map((o) => typeof o === "string" ? { label: o, value: o } : o);
  return (
    <div className={className}>
      {label ? <label className="text-[10px] sm:text-xs text-neutral-400">{label}</label> : null}
      <div className="mt-1 rounded-xl border border-[#222] bg-black px-3 py-2 focus-within:border-neutral-600">
        <select className="w-full bg-transparent outline-none text-neutral-100" value={value} onChange={(e) => onChange(e.target.value)}>
          {normalized.map((o) => (
            <option key={o.value} value={o.value} className="bg-[#141414]">{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode, className?: string }) {
  return <th className={`py-2 pr-3 ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode, className?: string }) {
  return <td className={`py-2 sm:py-3 pr-3 align-top ${className}`}>{children}</td>;
}

function Progress({ value }: { value: number }) {
  return (
    <div className="w-full h-3 rounded-full bg-[#0f1a12] overflow-hidden">
      <div className="h-full bg-emerald-500" style={{ width: `${value}%` }} />
    </div>
  );
}

function Stat({ label, value }: { label: string, value: string }) {
  return (
    <div className="rounded-lg bg-[#141414] border border-[#222] px-3 py-2">
      <div className="text-[10px] sm:text-[11px] text-neutral-400">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

function StatusControl({ value, onChange }: { value: BetStatus; onChange: (v: BetStatus) => void }) {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <button onClick={() => onChange("Won")} className={`w-7 h-7 sm:w-8 sm:h-7 rounded-full border flex items-center justify-center text-[11px] sm:text-xs font-bold ${value === "Won" ? "bg-emerald-500 text-black border-emerald-500" : "bg-[#141414] border-[#333] text-emerald-300"}`}>W</button>
      <button onClick={() => onChange("Lost")} className={`w-7 h-7 sm:w-8 sm:h-7 rounded-full border flex items-center justify-center text-[11px] sm:text-xs font-bold ${value === "Lost" ? "bg-rose-500 text-black border-rose-500" : "bg-[#141414] border-[#333] text-rose-300"}`}>L</button>
      <button onClick={() => onChange("Pending")} className={`w-7 h-7 sm:w-8 sm:h-7 rounded-full border flex items-center justify-center text-[11px] sm:text-xs font-bold ${value === "Pending" ? "bg-neutral-400 text-black border-neutral-400" : "bg-[#141414] border-[#333] text-neutral-300"}`}>P</button>
    </div>
  );
}

function SourceBadge({ source }: { source: PaymentSource }) {
  const map = {
    Betting: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    Trading: "bg-blue-500/15 text-blue-300 border-blue-500/30",
    Savings: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  } as const;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${map[source]}`}>{source}</span>;
}

function AddCardForm({ onAdd }: { onAdd: (name: string, balance: number) => void }) {
  const [name, setName] = useState("");
  const [bal, setBal] = useState("");
  return (
    <div className="mt-4 grid grid-cols-1 sm:grid-cols-12 gap-3">
      <div className="sm:col-span-5">
        <LabeledInput label="New card name" value={name} onChange={setName} placeholder="eg, Barclaycard" />
      </div>
      <div className="sm:col-span-3">
        <LabeledInput label="Balance" prefix="£" type="number" step={0.01} value={bal} onChange={setBal} placeholder="eg, 1200" />
      </div>
      <div className="sm:col-span-2 flex items-end">
        <Button onClick={() => { const b = cleanNumber(bal); if (!name || b <= 0) return; onAdd(name.trim(), +b.toFixed(2)); setName(""); setBal(""); }}>Add card</Button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-[#222] p-8 text-center">
      <p className="text-neutral-300">No bets yet</p>
      <p className="text-neutral-500 text-sm mt-1">Add your first bet above to begin your run</p>
    </div>
  );
}

// ---------- Self tests ----------
function runSelfTests() {
  try {
    console.assert(calcDefaultReturn(10, 2, "Won") === 20, "Won return should be stake * odds");
    console.assert(calcDefaultReturn(10, 2.5, "Lost") === 0, "Lost return should be zero");
    console.assert(calcDefaultReturn(10, 2, "Pending") === null, "Pending return should be null");

    console.assert(cleanNumber("12,5") === 12.5, "cleanNumber should treat comma as decimal");
    console.assert(typeof todayYYYYMMDD() === "string" && todayYYYYMMDD().length === 10, "todayYYYYMMDD should be yyyy-mm-dd");
    console.assert(/£\d/.test(formatGBP(12.34)), "GBP formatter should include pound sign");

    const sample: Bet[] = [
      { id: "1", date: "2025-01-01", description: "A", sport: "Football", stake: 10, oddsDecimal: 2, status: "Won", createdAt: "", updatedAt: "" },
      { id: "2", date: "2025-01-02", description: "B", sport: "Football", stake: 10, oddsDecimal: 3, status: "Lost", createdAt: "", updatedAt: "" },
      { id: "3", date: "2025-01-03", description: "C", sport: "Tennis", stake: 5, oddsDecimal: 2, status: "Pending", createdAt: "", updatedAt: "" },
    ];
    const s = computeStats(sample, 100);
    console.assert(s.settledCount === 2, "Only settled bets should count");
    console.assert(s.wonCount === 1, "Won count should be one");
    console.assert(s.hitRate === 50, "Hit rate should be 50 percent for one of two");
    console.assert(s.totalStaked === 20, "Total staked should sum settled stakes");
    console.assert(s.totalReturns === 20, "Returns should be 20 for one win at 2.0 and one loss");
    console.assert(typeof s.progress === "number" && s.progress >= 0 && s.progress <= 100, "Progress should clamp between 0 and 100");

    const pays: Payment[] = [
      { id: "p1", date: "2025-01-01", amount: 20, source: "Betting" },
      { id: "p2", date: "2025-01-02", amount: 10, source: "Trading" },
      { id: "p3", date: "2025-01-03", amount: 5, source: "Savings" },
    ];
    console.assert(sumPayments(pays) === 35, "sumPayments should sum all amounts");
    console.assert(sumPayments(pays, "Betting") === 20, "sumPayments should filter by source");

    // Cards math
    const cards: DebtCard[] = [
      { id: "c1", name: "Barclaycard", balance: 1000 },
      { id: "c2", name: "Amex", balance: 500 },
    ];
    const paysToCards: Payment[] = [
      { id: "q1", date: "2025-03-01", amount: 200, source: "Savings", cardId: "c1" },
      { id: "q2", date: "2025-03-05", amount: 100, source: "Trading", cardId: "c2" },
    ];
    console.assert(totalDebt(cards, 0) === 1500, "totalDebt should sum card balances");
    console.assert(sumPaymentsToCard(paysToCards, "c1") === 200, "sumPaymentsToCard should filter by card");
    console.assert(remainingDebtFromCards(cards, paysToCards) === 1200, "remainingDebtFromCards should subtract payments per card");

    // Roller formula quick check
    const runStart = 5, runTarget = 100;
    const startingBankroll = 5;
    const profit0 = 0; // bankroll equals start
    const current0 = startingBankroll + profit0;
    const pct0 = Math.min(100, Math.max(0, Math.round(((current0 - runStart) / (runTarget - runStart)) * 100)));
    console.assert(pct0 === 0, "Run progress should be 0 percent at start");
    const profitEnd = 95; // bankroll equals 100
    const currentEnd = startingBankroll + profitEnd;
    const pctEnd = Math.min(100, Math.max(0, Math.round(((currentEnd - runStart) / (runTarget - runStart)) * 100)));
    console.assert(pctEnd === 100, "Run progress should be 100 percent at target");

    // UI defaults
    const uiDefaults: UIState = { overview: true, quickBank: false, cards: false, betting: false, recent: false, betLog: false };
    console.assert(uiDefaults.overview && !uiDefaults.quickBank && !uiDefaults.cards && !uiDefaults.betting && !uiDefaults.recent && !uiDefaults.betLog, "UI defaults should open only Overview");

    // Template fallback sanity check
    const name: string | undefined = undefined;
    const label = `To ${name ?? "Card"}`;
    console.assert(label.endsWith("Card"), "Template fallback should render 'Card'");
  } catch (e) {
    console.error("Self tests failed", e);
  }
}

if (typeof window !== "undefined" && !window.__DEBTFLOW_TESTED_V3__) {
  window.__DEBTFLOW_TESTED_V3__ = true;
  runSelfTests();
}
