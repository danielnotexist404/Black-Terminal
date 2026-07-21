# Obsidian Accounting and Fees

Status: mathematical specification draft; values and mechanics require independent economic review.

## Units and definitions

The initial hypothesis uses one settlement asset with `d` decimals (candidate: USDC with its deployed-token decimals verified per chain). Internal arithmetic must use integer fixed-point units and explicitly specified round direction.

At valuation time `t`:

- `C_t`: liquid settlement assets controlled by the vault;
- `V_t`: conservatively valued venue collateral and positions, net of unrealized PnL;
- `R_t`: cumulative realized trading PnL already reflected where applicable;
- `F_t`: funding received minus funding paid;
- `T_t`: trading, execution and transaction costs;
- `L_t`: non-fee liabilities, including known settlement deficits;
- `A_t`: accrued but unpaid protocol/operator fees;
- `W_t`: approved pending-withdrawal liability;
- `Q_t`: reserved liquidity that remains an asset but is unavailable for new risk.

Avoid double counting: the canonical accounting implementation must define whether `V_t` already incorporates `R_t`, `F_t`, and `T_t`. A normalized net asset value is:

`NAV_t = C_t + V_t - L_t - A_t`

`W_t` is either included in `L_t` or disclosed separately—never both. `Q_t` restricts deployable capital but is not subtracted from NAV. `Deployable_t = max(0, NAV_t - W_t - Q_t - requiredMarginBuffer_t)` under the chosen classification.

## Shares and entry

Let `S_t` be total economic shares before a deposit and `NAV_t^safe` the fresh, finalized deposit NAV.

- initial share price: `P_0 = 1 settlement asset per share` in normalized fixed point;
- live share price: `P_t = NAV_t^safe / S_t` when `S_t > 0`;
- shares for deposit `D`: `sharesMinted = floor(D / P_t)`;
- accounted deposit value: `mintValue = sharesMinted × P_t`;
- residual dust follows a disclosed policy; it cannot silently accrue to the operator.

Minting must use a finalized epoch price or a manipulation-resistant asynchronous request/settlement flow. A direct ERC-4626-compatible interface may be exposed only if its preview/conversion semantics remain truthful under locks and asynchronous valuation. ERC-4626 alone does not define tranches, derivative NAV, HWM fees or redemption queues.

## Accounting invariants

Subject to explicitly disclosed mark uncertainty:

`NAV_t = investorClaimValue_t + accruedFeeClaims_t + otherNetClaimants_t`

`sum(trancheShares) = economicShareSupply` unless a documented non-fungible claim representation replaces transferable shares.

Principal is a capital contribution, never performance profit. Deposits, withdrawals and claim transfers do not create trading profit.

No stale or disputed NAV may mint shares, crystallize fees or finalize redemptions. The system enters a paused/settling state until sources recover or the emergency valuation procedure is invoked.

## High-water-mark model

Preferred model for evaluation: a per-tranche HWM expressed as net value per share after previously crystallized fees. Each tranche records:

- shares held;
- entry price;
- current HWM per share;
- fee rate fixed by its term version;
- cumulative crystallized fee and eligible profit;
- rounding carry policy.

At a fee crystallization price `P` for tranche `i`:

`eligibleProfit_i = max(0, (P - HWM_i) × shares_i)`

`performanceFee_i = floor(eligibleProfit_i × feeRate_i)`

`investorNetGain_i = eligibleProfit_i - performanceFee_i`

The investor's redemption value is not “75% of the vault.” Under a 25% fee, the investor receives principal plus 75% of eligible positive net profit, after attributable losses, funding, transaction costs and disclosed liabilities.

After crystallization, the HWM must be adjusted consistently for the fee mechanism so the same profit cannot be charged twice. Two candidate designs require simulation:

1. deduct fee assets/shares and set HWM to the post-fee share price;
2. maintain gross price with a fee-debt index and advance HWM to gross crystallization price.

No implementation choice is made here.

## Numerical examples

### Profit above initial HWM

An investor deposits 1,000 USDC at 1.00 NAV/share and receives 1,000 shares. At settlement the attributable net value before performance fee is 1,200 USDC. Eligible profit is 200, the 25% fee is 50, and the investor claim is 1,150 USDC. Principal is not fee-bearing.

### Loss and recovery

The same tranche falls from 1,000 to 800. No performance fee is due. It later recovers to 1,000; no fee is due because it has not exceeded its HWM. It then reaches 1,100; only the 100 gain above the HWM is eligible, producing a 25 fee and a 1,075 investor claim, subject to the final HWM accounting design.

### Deposit after gains

Vault share price is 1.20. A new investor deposits 1,200 and receives 1,000 shares with an entry/HWM of 1.20. Existing gains are not charged to the new investor and are not redistributed by the deposit.

### Deposit after losses

Vault price is 0.80. A new 800 deposit receives 1,000 shares and starts with an HWM of 0.80. Existing investors retain their own higher HWM; the new investor does not receive a free recovery band. This is why a single vault-wide HWM is insufficient.

### Multiple tranches

Tony's first 1,000-share tranche has HWM 1.00 and his later 500-share tranche has HWM 1.20. At price 1.30, eligible gross profit is `(0.30×1,000) + (0.10×500) = 350`; the 25% fee is 87.50 and Tony retains 262.50 of eligible profit. Each tranche remains independently rounded and settled.

### Partial redemption

If 400 of 1,000 shares are redeemed, crystallization applies proportionally to those shares. The remaining 600 shares retain a mathematically equivalent HWM and fee history. Redemption must not reset the remaining HWM or enable fee avoidance.

## Fee edge cases

- Funding and transaction costs reduce net profit before performance fees.
- Protocol fees, if any, require a separate disclosed basis and cannot be hidden inside performance profit.
- Operator replacement does not reset HWM; allocation of accrued fees between operators requires a published rule.
- Emergency settlement charges no performance fee on unverified or stale gains.
- Fee rounding should round against the fee recipient; aggregate dust must be bounded, disclosed and periodically reconciled.
- Fee recipient must be a registered address subject to governance delay; changing it cannot alter the fee rate or redirect principal.

## Price and oracle failure

Every NAV records sources, observation times, confidence/staleness thresholds and valuation method for open positions. If any material source is stale, divergent or unavailable, state becomes `NAV_STALE`; deposits, fee crystallization and final redemptions stop. Conservative emergency marks and haircut rules remain an unresolved constitutional decision.
