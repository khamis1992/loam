'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowLeftRight, ChevronLeft, ChevronRight, Database, Home, Layers, Lightbulb,
  Plus, Trash2, Wallet,
} from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';

type TransactionType = 'income' | 'expense';
type View = 'overview' | 'transactions' | 'budgets' | 'insights';

interface Transaction {
  id: string;
  description: string;
  category: string;
  amount: number;
  date: string;
  type: TransactionType;
}

const STORAGE_KEY = 'loam:budget-template:v1';
const MONTHS = ['October 2026', 'November 2026', 'December 2026'];
const CATEGORIES = ['Housing', 'Dining', 'Transport', 'Shopping', 'Entertainment', 'Income'];
const BUDGETS: Record<string, number> = { Housing: 1200, Dining: 500, Transport: 300, Shopping: 450, Entertainment: 200 };
const COLORS = ['#13bfa8', '#61a5fa', '#a78bfa', '#f4b261', '#f27d98'];

const INITIAL_TRANSACTIONS: Transaction[] = [
  { id: 'salary', description: 'Salary', category: 'Income', amount: 5250, date: '2026-11-01', type: 'income' },
  { id: 'rent', description: 'Rent', category: 'Housing', amount: 1200, date: '2026-11-03', type: 'expense' },
  { id: 'dining', description: 'Dining out', category: 'Dining', amount: 420, date: '2026-11-08', type: 'expense' },
  { id: 'transport', description: 'Transport', category: 'Transport', amount: 230, date: '2026-11-10', type: 'expense' },
  { id: 'shopping', description: 'Shopping', category: 'Shopping', amount: 483.93, date: '2026-11-12', type: 'expense' },
  { id: 'entertainment', description: 'Entertainment', category: 'Entertainment', amount: 300, date: '2026-11-15', type: 'expense' },
];

const money = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function SummaryCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={clsx('rounded-xl border p-4', accent ? 'border-[#13bfa8]/30 bg-[#102b31]' : 'border-white/10 bg-[#0f1c2e]')}>
      <div className="mb-4 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-white/50">
        <span>{label}</span>
        <Wallet className="size-3.5" />
      </div>
      <p className="text-2xl font-semibold text-white">{money(value)}</p>
    </div>
  );
}

function SpendingChart({ transactions, monthLabel }: { transactions: Transaction[]; monthLabel: string }) {
  const points = useMemo(() => {
    const days = [1, 5, 10, 15, 20, 25, 30];
    let cumulative = 0;
    const values = days.map((day) => {
      cumulative += transactions
        .filter((item) => item.type === 'expense' && Number(item.date.slice(-2)) <= day)
        .reduce((sum, item) => sum + item.amount, 0);
      return cumulative;
    });
    const max = Math.max(...values, 1);
    return values.map((value, index) => `${(index / 6) * 600},${170 - (value / max) * 140}`).join(' ');
  }, [transactions]);

  return (
    <section className="rounded-xl border border-white/10 bg-[#0f1c2e] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('Cash flow over time')}</h3>
        <span className="text-[10px] text-[#13bfa8]">{t(monthLabel)}</span>
      </div>
      <svg viewBox="0 0 600 180" className="h-40 w-full" role="img" aria-label={t('Cash flow over time')}>
        <defs>
          <linearGradient id="cash-flow-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#13bfa8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#13bfa8" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[40, 80, 120, 160].map((y) => <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="rgba(255,255,255,.06)" />)}
        <path d={`M0,170 L${points.replaceAll(' ', ' L')} L600,170 Z`} fill="url(#cash-flow-fill)" />
        <polyline points={points} fill="none" stroke="#13bfa8" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </section>
  );
}

function SpendingMix({ transactions }: { transactions: Transaction[] }) {
  const expenses = transactions.filter((item) => item.type === 'expense');
  const total = expenses.reduce((sum, item) => sum + item.amount, 0);
  const categories = CATEGORIES.slice(0, -1).map((category) => ({
    category,
    amount: expenses.filter((item) => item.category === category).reduce((sum, item) => sum + item.amount, 0),
  })).filter((item) => item.amount > 0);
  const circumference = 2 * Math.PI * 70;
  let offset = 0;

  return (
    <section className="rounded-xl border border-white/10 bg-[#0f1c2e] p-4">
      <h3 className="mb-3 text-sm font-medium">{t('Spending mix')}</h3>
      <div className="flex items-center justify-center gap-6">
        <svg viewBox="0 0 180 180" className="size-36" role="img" aria-label={t('Spending mix')}>
          <circle cx="90" cy="90" r="70" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="20" />
          {categories.map((item, index) => {
            const length = total ? (item.amount / total) * circumference : 0;
            const circle = (
              <circle
                key={item.category}
                cx="90" cy="90" r="70" fill="none" stroke={COLORS[index % COLORS.length]} strokeWidth="20"
                strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset}
                transform="rotate(-90 90 90)"
              />
            );
            offset += length;
            return circle;
          })}
          <text x="90" y="86" textAnchor="middle" fill="white" fontSize="14" fontWeight="600">{money(total)}</text>
          <text x="90" y="105" textAnchor="middle" fill="rgba(255,255,255,.45)" fontSize="10">{t('Spent')}</text>
        </svg>
        <div className="flex flex-col gap-2">
          {categories.map((item, index) => (
            <div key={item.category} className="flex items-center gap-2 text-[10px] text-white/60">
              <span className="size-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
              <span>{t(item.category)}</span>
              <span className="ms-2 text-white/35">{total ? Math.round((item.amount / total) * 100) : 0}%</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function BudgetApp({ compact = false }: { compact?: boolean }) {
  const [transactions, setTransactions] = useState<Transaction[]>(INITIAL_TRANSACTIONS);
  const [view, setView] = useState<View>('overview');
  const [monthIndex, setMonthIndex] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<TransactionType>('expense');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Transaction[];
        if (Array.isArray(parsed)) setTransactions(parsed);
      }
    } catch {
      setTransactions(INITIAL_TRANSACTIONS);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (loaded) localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
  }, [loaded, transactions]);

  const monthKey = `2026-${String(monthIndex + 10).padStart(2, '0')}`;
  const monthTransactions = transactions.filter((item) => item.date.startsWith(monthKey));
  const income = monthTransactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
  const spent = monthTransactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
  const totalBudget = Object.values(BUDGETS).reduce((sum, value) => sum + value, 0);
  const recent = [...monthTransactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

  const addTransaction = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(amount);
    if (!description.trim() || !Number.isFinite(value) || value <= 0) return;
    setTransactions((items) => [...items, {
      id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      description: description.trim(), category, amount: value, date: `${monthKey}-16`, type,
    }]);
    setDescription('');
    setAmount('');
    setType('expense');
    setFormOpen(false);
  };

  const navItems: Array<{ id: View; label: string; icon: typeof Home }> = [
    { id: 'overview', label: 'Overview', icon: Home },
    { id: 'transactions', label: 'Transactions', icon: ArrowLeftRight },
    { id: 'budgets', label: 'Budgets', icon: Layers },
    { id: 'insights', label: 'Insights', icon: Lightbulb },
  ];

  return (
    <div className={clsx('flex h-full min-h-[430px] overflow-hidden bg-[#08111f] font-sans text-white', compact && 'text-[12px]')}>
      <aside className={clsx('flex shrink-0 flex-col items-center gap-2 border-e border-white/10 py-4', compact ? 'w-14' : 'w-48 px-3')}>
        <div className="mb-5 flex size-9 items-center justify-center rounded-xl border border-[#13bfa8]/40 bg-[#102b31] text-[#13bfa8]">
          <Wallet className="size-5" />
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              aria-label={t(item.label)}
              className={clsx(
                'flex items-center gap-3 rounded-lg py-2 text-white/45 hover:bg-white/5 hover:text-white',
                compact ? 'w-9 justify-center' : 'w-full px-3',
                view === item.id && 'bg-[#13bfa8]/15 text-[#13bfa8]',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!compact && <span className="text-xs">{t(item.label)}</span>}
            </button>
          );
        })}
        <div className="mt-auto">
          <Database className="size-4 text-white/35" />
        </div>
      </aside>

      <main className={clsx('min-w-0 flex-1 overflow-y-auto', compact ? 'p-4' : 'p-6')}>
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="mb-1 text-[9px] uppercase tracking-[0.2em] text-[#13bfa8]">{t('Your financial picture')} · {t(MONTHS[monthIndex])}</p>
            <h2 className={clsx('font-medium', compact ? 'text-xl' : 'text-2xl')}>{t('Your money, in focus.')}</h2>
            <p className="mt-1 text-xs text-white/45">{t('A clearer view of what came in, what went out, and what’s next.')}</p>
          </div>
          <button
            type="button"
            onClick={() => setFormOpen((value) => !value)}
            className="flex shrink-0 items-center gap-2 rounded-lg bg-[#55e6c1] px-3 py-2 text-xs font-semibold text-[#06231d] hover:bg-[#70edcf]"
          >
            <Plus className="size-4" /> {t('Add transaction')}
          </button>
        </div>

        <div className="mb-5 flex items-center justify-between rounded-lg border border-white/10 bg-[#0f1c2e] p-1">
          <button type="button" disabled={monthIndex === 0} onClick={() => setMonthIndex((value) => value - 1)} aria-label={t('Previous month')} className="rounded-md p-1.5 text-white/50 hover:bg-white/5 disabled:opacity-20">
            <ChevronLeft className="size-4 rtl:rotate-180" />
          </button>
          <span className="text-xs text-white/65">{t(MONTHS[monthIndex])}</span>
          <button type="button" disabled={monthIndex === MONTHS.length - 1} onClick={() => setMonthIndex((value) => value + 1)} aria-label={t('Next month')} className="rounded-md p-1.5 text-white/50 hover:bg-white/5 disabled:opacity-20">
            <ChevronRight className="size-4 rtl:rotate-180" />
          </button>
        </div>

        {formOpen && (
          <form onSubmit={addTransaction} className="mb-5 grid gap-2 rounded-xl border border-[#13bfa8]/25 bg-[#102b31] p-3 sm:grid-cols-[1.5fr_1fr_1fr_.8fr_auto]">
            <input required aria-label={t('Description')} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('Description')} className="rounded-lg border border-white/10 bg-[#0f1c2e] px-2.5 py-2 text-xs text-white outline-none placeholder:text-white/30" />
            <select aria-label={t('Category')} value={category} onChange={(event) => setCategory(event.target.value)} className="rounded-lg border border-white/10 bg-[#0f1c2e] px-2 py-2 text-xs text-white">
              {CATEGORIES.map((item) => <option key={item} value={item}>{t(item)}</option>)}
            </select>
            <select aria-label={t('Type')} value={type} onChange={(event) => setType(event.target.value as TransactionType)} className="rounded-lg border border-white/10 bg-[#0f1c2e] px-2 py-2 text-xs text-white">
              <option value="expense">{t('Expense')}</option>
              <option value="income">{t('Income')}</option>
            </select>
            <input required aria-label={t('Amount')} type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t('Amount')} className="rounded-lg border border-white/10 bg-[#0f1c2e] px-2.5 py-2 text-xs text-white outline-none placeholder:text-white/30" />
            <button type="submit" className="rounded-lg bg-[#55e6c1] px-3 py-2 text-xs font-semibold text-[#06231d]">{t('Add')}</button>
          </form>
        )}

        {view === 'overview' && (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard label={t('Left after spending')} value={income - spent} accent />
              <SummaryCard label={t('Income')} value={income} />
              <SummaryCard label={t('Spent')} value={spent} />
              <SummaryCard label={t('Budget left')} value={totalBudget - spent} />
            </div>
            <div className="grid gap-3 xl:grid-cols-[1.6fr_1fr]">
              <SpendingChart transactions={monthTransactions} monthLabel={MONTHS[monthIndex]} />
              <SpendingMix transactions={monthTransactions} />
            </div>
          </>
        )}

        {view === 'budgets' && (
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(BUDGETS).map(([name, budget]) => {
              const used = monthTransactions.filter((item) => item.type === 'expense' && item.category === name).reduce((sum, item) => sum + item.amount, 0);
              const percentage = Math.min(100, (used / budget) * 100);
              return (
                <section key={name} className="rounded-xl border border-white/10 bg-[#0f1c2e] p-4">
                  <div className="mb-2 flex justify-between text-sm"><span>{t(name)}</span><span>{money(used)} / {money(budget)}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-[#13bfa8]" style={{ width: `${percentage}%` }} /></div>
                </section>
              );
            })}
          </div>
        )}

        {view === 'insights' && (
          <section className="rounded-xl border border-white/10 bg-[#0f1c2e] p-5">
            <h3 className="mb-3 text-sm font-medium">{t('Plain-English insights')}</h3>
            <p className="text-sm leading-6 text-white/60">
              {spent === 0 ? t('No spending recorded for this month yet.') : t('Dining represents {percent}% of spending in this view.', { percent: Math.round((monthTransactions.filter((item) => item.category === 'Dining' && item.type === 'expense').reduce((sum, item) => sum + item.amount, 0) / spent) * 100) })}
            </p>
            <p className="mt-2 text-sm leading-6 text-white/60">{t('You have {amount} left after spending.', { amount: money(income - spent) })}</p>
          </section>
        )}

        {(view === 'overview' || view === 'transactions') && (
          <section className="mt-4 rounded-xl border border-white/10 bg-[#0f1c2e] p-4">
            <h3 className="mb-3 text-sm font-medium">{t('Recent transactions')}</h3>
            {recent.length === 0 ? (
              <p className="py-5 text-center text-xs text-white/35">{t('No transactions this month.')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {recent.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 rounded-lg px-2 py-2 text-xs hover:bg-white/5">
                    <span className={clsx('size-2 shrink-0 rounded-full', item.type === 'income' ? 'bg-[#55e6c1]' : 'bg-[#f27d98]')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.description}</span>
                      <span className="text-[10px] text-white/35">{t(item.category)} · {item.date}</span>
                    </span>
                    <span className={item.type === 'income' ? 'text-[#55e6c1]' : 'text-white/70'}>
                      {item.type === 'income' ? '+' : '-'}{money(item.amount)}
                    </span>
                    <button type="button" aria-label={t('Delete {description}', { description: item.description })} onClick={() => setTransactions((items) => items.filter((candidate) => candidate.id !== item.id))} className="rounded-md p-1 text-white/30 hover:bg-white/10 hover:text-white">
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
