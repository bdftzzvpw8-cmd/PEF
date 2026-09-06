# Weekly Reports

Weekly **bonus leaderboard** and **referral commission** reports, rebuilt to read
the new platform's transaction-ledger export.

```
npm test                                       # 77 tests, no dependencies
node bin/report.js bonus     <exports...>      # weekly bonus leaderboard
node bin/report.js referrals <exports...>      # referral commissions
node bin/report.js verify    <exports...>      # structural checks only
```

Pass any mix of files; `.csv` and `.xlsx` are both read natively and there are no
npm dependencies.

## The two exports

The platform emits two shapes, and the reports need both.

### Transaction ledger

One row per transaction: `Player, Type, ID, Hold Transaction Id, Credit, Debit,
Final Balance, Pending Status, Date, Details, User, Agent, Actions`. Dates are
`MM/DD/YY`. This is the **only** source of wagering volume, and where referral
rows live. It appears to be exported per player.

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

### Periodic (weekly) summary

A hierarchical grid covering the whole book, whose `Group` column is an indented
tree — agent group, then account, then bet type:

```
 -> BITCOINBAY
 -> BITCOINBAY -> BTCB50
 -> BITCOINBAY -> BTCB50 -> PreMatch
```

Bet types map onto the categories the reports have always used: `PreMatch` →
sports, `InPlay` → live, and `Betsoft` / `TFUSION` / `PLAYGLOBE` → casino.
Anything unrecognised falls to *other*.

**Casino products are excluded from both reports.** They neither rank a client
on the leaderboard nor earn a referrer commission. The list lives in one place —
`EXCLUDED_BET_TYPES` in `lib/periodic.js` — and `--include-casino` puts them back
for comparison.

> Only `Betsoft` is a recognised casino provider by name. `TFUSION` and
> `PLAYGLOBE` were classified by inference; nothing in the export states what
> they are. Between them they carry $1,692 of a $14,136 book, so if either is
> actually a sportsbook product, move it out of that list — every figure follows
> automatically.

Each account keeps what the exclusion removed (`excludedPnl`, `excludedBetTypes`)
and the export's own untouched account figure (`reportedPnl`), so the two can
always be reconciled. The structural checks deliberately ignore the exclusion:
they verify the file, not the policy.

This file has no volume, so it cannot rank the bonus leaderboard on its own. It
carries three traps, each verified against a live export rather than assumed —
`lib/periodic.js` handles all three, and `report.js verify` re-checks them on
every new file:

1. **Every bet-type row is followed by a blank-`Group` row repeating it.**
   Counting those doubles every figure.
2. **The column headed with the week range is the negated, truncated `Total`.**
   P&L is read from `Total`, which has the sign and the precision.
3. **`Pending` and `End Balance` are inflated.** They are account-level values
   repeated on each bet-type row, which the grid then sums into the account row
   — so an account with three bet types shows three times its real balance. The
   de-duplicated leaf value is reported, with the grid's own figure kept
   alongside as `endBalanceReported` / `pendingReported`.

   *Confirmed against live data: account GD070's ledger closes at 0.84, matching
   the leaf value 0.846, not the 2.538 on its account row.*

### Combining them

`lib/load.js` merges whatever you pass. Volume and referral edges come from the
ledger; bet-type P&L and whole-book coverage come from the periodic summary.
Where both describe an account, **the periodic P&L wins** — the ledger reflects
only graded wagers, so it understates the week while bets are still open. Both
figures are kept (`periodicPnl`, `ledgerPnl`) so the gap stays visible.

## Bonus leaderboard

Ranked on **volume** — each client's wins and losses totalled across their bet
types. The client with the most is #1. The periodic summary alone is enough.

A client who won $500 on PreMatch and lost $400 InPlay counts for **$900**, not
$100: the two are added, never netted against each other. That measures how much
action the client put through, which is what the leaderboard has always
rewarded.

1. Accounts with no action at all are excluded outright.
2. Qualifying accounts are ranked by that total, largest first.
3. Eligible = the top 20%, **but never fewer than 10** accounts (or than exist).
4. The $3,000 pool is split in proportion to the same total.
5. Any award over the $500 per-account cap is trimmed, and the overflow
   re-spread among accounts still under the cap, repeating until settled.
6. The cutoff is the total of the last account to make the cut.

### Totalling, at both levels

Wins and losses are added together rather than netted — **within** each client,
across their bet types, and **across** clients for the book total. On a live
week the difference is an order of magnitude:

| | |
| --- | --- |
| Totalled, per client then summed (`total_volume`) | **$14,135.59** |
| Netted within each client, then summed | $10,656.59 |
| Netted throughout (`net_pnl`) | $1,558.55 |

The last is what the export's own grand-total row reports: $6,107 of player wins
cancels $4,549 of house wins, and inside individual clients a losing product
cancels a winning one. `total_volume` and `net_pnl` are both in the payload so
the two can be reconciled rather than mistaken for each other.

Ten of the thirty-nine accounts in the live export are affected. The starkest is
an account whose net P&L is $28 — near enough invisible — but which ran $237
against $209 across two products, so it carries $446 of action and makes the top
ten.

Two other bases exist for comparison. `--basis=abs_pnl` nets each client's bet
types before taking the magnitude — on live data that shrinks the book total from
$14,135.59 to $10,656.59 and changes who holds the top ten. `--basis=wagered` is
the original ranking on amount staked, which needs ledger files. Other defaults
are overridable too: `--pool=3000 --cap=500 --topPct=20 --floor=10`.

> **Cap can ceiling the pool.** An eligible set of *n* accounts can absorb at
> most `n × cap`. With the floor of 10 and a $500 cap that ceiling is $5,000, so
> a $3,000 pool distributes fully — but a smaller set leaves a remainder. The
> report exposes it as `unpaid` and the CLI prints a warning rather than letting
> it disappear.

`--json` emits the leaderboard payload in the shape the collection already
stores: `generated_at`, `week_start`, `week_end`, `volume_threshold`,
`total_volume`, `net_pnl`, and the top ten accounts by rank.

> **`volume_threshold` no longer holds a volume.** The key keeps its name so
> existing consumers do not break, but it now carries the cutoff for whichever
> metric ranked the board. A new `threshold_basis` field (`abs_pnl` or `volume`)
> says which — anything displaying that number as "cutoff volume" needs its
> label updated.

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
lib/ledger.js     transaction ledger: players, volume, referral edges
lib/periodic.js   periodic summary: bet-type P&L, plus its three quirks
lib/load.js       merge whatever exports are supplied into one week
lib/bonus.js      leaderboard: eligibility, weighting, cap redistribution
lib/referrals.js  referral grouping and commission
bin/report.js     CLI
```

Test fixtures use stand-in account names; no live player data is committed.
