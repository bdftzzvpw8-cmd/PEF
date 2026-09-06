# Weekly Reports

Weekly **bonus leaderboard** and **referral commission** reports, rebuilt to read
the new platform's transaction-ledger export.

```
npm test                                     # 40 tests, no dependencies
node bin/report.js bonus     export.csv       # weekly bonus leaderboard
node bin/report.js referrals export.csv       # referral commissions
```

Pass as many export files as you like — they are concatenated and grouped by the
`Player` column, so it works whether the platform exports one file per player or
one file for the whole book. Both `.csv` and `.xlsx` are read natively; there are
no npm dependencies.

## The export

One row per transaction, with columns `Player, Type, ID, Hold Transaction Id,
Credit, Debit, Final Balance, Pending Status, Date, Details, User, Agent,
Actions`. Dates are `MM/DD/YY`.

Only wagers move the numbers:

| Transaction type | Volume | P&L |
| --- | :---: | :---: |
| `Wager Placed` | Σ\|Debit\| | stake |
| `Wager Graded` | — | payout |
| `Promotional Credit` | — | — |
| `Credit Adjustment` | — | — |
| `Balance Carryover` | — | — |
| `Withdrawal (Processor)` | — | — |

**P&L is stated from the house's point of view**: `payouts − stakes`, so a
*negative* figure means the house won and commission may be owed. This matches
the convention the previous reports used.

Referral bonuses are recorded on the ledger but are deliberately excluded from
both volume and P&L — a referrer's commission is calculated on their clients'
betting losses alone.

## Bonus leaderboard

1. Accounts with zero wagering volume are excluded outright.
2. Active accounts are ranked by volume, highest first.
3. Eligible = the top 20%, **but never fewer than 10** accounts (or than exist).
4. The $3,000 pool is split in proportion to volume across the eligible set.
5. Any award over the $500 per-account cap is trimmed, and the overflow
   re-spread among accounts still under the cap, repeating until settled.
6. The cutoff volume is that of the last account to make the cut.

Defaults are overridable: `--pool=3000 --cap=500 --topPct=20 --floor=10`.

> **Cap can ceiling the pool.** An eligible set of *n* accounts can absorb at
> most `n × cap`. With the floor of 10 and a $500 cap that ceiling is $5,000, so
> a $3,000 pool distributes fully — but a smaller set leaves a remainder. The
> report exposes it as `unpaid` and the CLI prints a warning rather than letting
> it disappear.

`--json` emits the leaderboard payload in the shape the collection already
stores: `generated_at`, `week_start`, `week_end`, `volume_threshold`, and the
top ten accounts by rank.

## Referral commissions

Referral edges live on the **referrer's** own ledger: a credit row whose
`Details` read `Referred <CODE>`. One referrer can have many such rows — one per
client they brought in.

Each referrer's clients are looked up by account, their P&L summed, and the
referrer earns **20% of the group's net losses**. A group that is net up for the
players owes nothing. Referrers owed commission sort to the top.

> **Two commission bases.** The per-client *loss share* and the referrer's
> *payable* are not the same number when a referrer has both winning and losing
> clients: the payable nets them against each other, so summing the per-client
> column overstates what is owed. The CSV export carries both, with a `SUBTOTAL`
> row per referrer holding the payable.

Referred clients with no activity in the week are listed at zero rather than
dropped, so a referrer's roster stays visible week to week.

`--csv` writes the export; `--rate=20` overrides the commission rate.

## The week

Taken from the data: the week ends on the latest transaction date present and
runs back six days, matching how the weekly files have always been cut.

## Layout

```
lib/zip.js        minimal zip reader (an .xlsx is a zip of XML)
lib/sheet.js      .csv and .xlsx into row objects
lib/ledger.js     normalize transactions, aggregate players, extract referrals
lib/bonus.js      leaderboard: eligibility, weighting, cap redistribution
lib/referrals.js  referral grouping and commission
bin/report.js     CLI
```

Test fixtures use stand-in account names; no live player data is committed.
