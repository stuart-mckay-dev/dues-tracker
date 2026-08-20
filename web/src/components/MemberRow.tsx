import type { RosterEntry } from "../api";
import { rowAmount, rowClass } from "../format";
import { navigate } from "../router";

/**
 * One roster line. The dollar figure and the month count sit together in the
 * right-hand column — dollars are what gets collected, months are what gets
 * said out loud to the member.
 */
export function MemberRow({
  entry,
  subtitle,
}: {
  entry: RosterEntry;
  subtitle?: string;
}) {
  const amount = rowAmount(entry.standing);

  return (
    <li>
      <button class={`row ${rowClass(entry.standing)}`} onClick={() => navigate(`/member/${entry.id}`)}>
        <span class="row-main">
          <span class="row-name">{entry.displayName}</span>
          <span class="row-sub">{subtitle ?? entry.standing.summary}</span>
        </span>
        <span class="row-amount money">
          {amount.primary}
          <span class="months">{amount.secondary}</span>
        </span>
      </button>
    </li>
  );
}
