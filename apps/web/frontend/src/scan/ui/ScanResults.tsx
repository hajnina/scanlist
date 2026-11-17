/**
 * Scan results panel (card C5): source chips, hero card, ranked rows.
 *
 * Pure presentation — the hero comes straight from `state.hero`, which the controller filled from
 * ts-core's `decideTop()` output (`topId`, nullable). Nothing here re-scores, re-sorts or re-decides
 * a match: a null hero renders the honest "no confident match" card instead of inventing a winner.
 *
 * `data-flip-id` on every row is the FLIP hook (`flip.ts` measures these before/after a tick).
 */

import type { RefObject } from "preact";

import { FilledButton, TickBox } from "../../ui/md";
import { formatScore } from "./ranking";
import type { ScanRow } from "./ranking";
import type { ScanUiState } from "./controller";

export interface ScanResultsProps {
  state: ScanUiState;
  /** Commit one row (the hero button and every row checkbox go through here). Never automatic. */
  onTick: (row: ScanRow) => void;
  /** The `<ul>` whose rows FLIP measures. */
  listRef?: RefObject<HTMLUListElement>;
  /** Label of the most recently committed row, shown as a short confirmation. */
  lastTick?: string | null;
}

function SourceChips(props: { state: ScanUiState }) {
  return (
    <ul class="scan-chips" aria-label="Live scan sources">
      {props.state.chips.map((chip) => (
        <li
          key={chip.key}
          class={`scan-chip ${chip.active ? "is-active" : ""}`}
          data-source={chip.key}
        >
          <span class="scan-chip-label">{chip.label}</span>
          <span class="scan-chip-detail">{chip.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function HeroCard(props: ScanResultsProps) {
  const { state } = props;
  const hero = state.hero;

  if (hero !== null) {
    return (
      <section class="card hero-card scan-hero scan-hero-match spring-in" aria-live="polite">
        <h2 class="section-label">BEST MATCH</h2>
        <p class="hero-number scan-hero-name">
          <span class="hero-value">{hero.name}</span>
          {hero.amount !== "" && <span class="hero-unit">{hero.amount}</span>}
        </p>
        <p class="hero-meta">{state.heroStatus}</p>
        <FilledButton label={`Tick ${hero.name}`} onClick={() => props.onTick(hero)} />
        {props.lastTick != null && <p class="scan-confirm">Ticked {props.lastTick} ✓</p>}
      </section>
    );
  }

  if (state.phase === "preparing") {
    const percent =
      state.prepared.total === 0
        ? 100
        : Math.round((state.prepared.done / state.prepared.total) * 100);
    return (
      <section class="card hero-card scan-hero scan-hero-empty spring-in" aria-live="polite">
        <h2 class="section-label">READING YOUR LIST</h2>
        <p class="hero-meta">
          Embedding {state.prepared.done}/{state.prepared.total} items before the first rank tick.
        </p>
        <span class="progress-bar progress-large" aria-hidden="true">
          <span class="progress-fill" style={{ width: `${percent}%` }} />
        </span>
      </section>
    );
  }

  return (
    <section class="card hero-card scan-hero scan-hero-empty spring-in" aria-live="polite">
      <h2 class="section-label">NO CONFIDENT MATCH</h2>
      <p class="hero-meta">{state.heroStatus}</p>
      <p class="hint">
        Auto-ranking never ticks anything: the button appears only when one item clears the ranker's
        margin and score gates.
      </p>
      {props.lastTick != null && <p class="scan-confirm">Ticked {props.lastTick} ✓</p>}
    </section>
  );
}

export function ScanResults(props: ScanResultsProps) {
  const { state } = props;

  return (
    <div class="scan-results">
      <SourceChips state={state} />
      <HeroCard {...props} />

      <section class="scan-rank" aria-labelledby="scan-rank-heading">
        <h2 class="section-label" id="scan-rank-heading">
          RANKED LIST
        </h2>
        {state.rows.length === 0 ? (
          <p class="empty-state">This list has no items to rank yet.</p>
        ) : (
          <ul class="items scan-rows" ref={props.listRef}>
            {state.rows.map((row) => {
              const amount = row.amount;
              return (
                <li
                  key={row.id}
                  data-flip-id={row.id}
                  class={`item scan-row spring-in ${row.done ? "is-done" : ""} ${
                    row.isHero ? "is-hero" : ""
                  }`}
                >
                  <TickBox
                    checked={row.done}
                    label={`${row.done ? "Untick" : "Tick"} ${row.name}`}
                    onChange={() => props.onTick(row)}
                  />
                  <span class="item-body">
                    <span class="item-line">
                      <span class="item-name">{row.name}</span>
                      {amount !== "" && <span class="amount">{amount}</span>}
                    </span>
                    {row.note !== null && <span class="item-note">{row.note}</span>}
                  </span>
                  {row.score !== null && !row.done && (
                    <span class="scan-score" aria-label={`similarity ${formatScore(row.score)}`}>
                      {formatScore(row.score)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
