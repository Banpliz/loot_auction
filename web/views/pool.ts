// web/views/pool.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';
import { colorHex } from '../format';

interface Winner {
  telegramId: number;
  nickname: string | null;
  quantity: number;
}

interface Item {
  id: number;
  name: string;
  color: string;
  quantity: number;
  imagePath: string;
  status: 'pool' | 'auctioned' | 'removed';
  winners: Winner[];
  claimedByMe: number;
  template: string;
}

let countdownTimer: ReturnType<typeof setInterval> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let eventSource: EventSource | undefined;

// SSE (see src/server/pubsub.ts + the /stream route) pushes the moment anyone's claim
// changes anything, so a viewer sees it essentially instantly instead of waiting out a
// poll interval. The poll stays as a slow fallback for whenever the stream itself drops —
// Telegram's in-app browser isn't always kind to long-lived connections — so a viewer
// still catches up within a reasonable time even if the push never arrives.
const POLL_FALLBACK_MS = 15000;

const winnerLabel = (w: Winner) => escapeHtml(w.nickname ?? '—') + (w.quantity > 1 ? ` ×${w.quantity}` : '');

// The API speaks in plain English error codes (items.ts) — translated here rather than
// server-side so the wire format stays a stable identifier other code and tests can match
// on. Most of these fire when two people click the same lot within the live-update window.
const CLAIM_ERROR_MESSAGES: Record<string, string> = {
  'item is not claimable': 'Лот уже занят или недоступен — список сейчас обновится.',
  'not enough remaining quantity': 'Осталось меньше, чем ты выбрал — список сейчас обновится.',
  'already claimed': 'Ты уже сделал ставку на этот лот.',
  'win limit reached': 'Достигнут лимит побед для этой редкости/категории.',
  'already won in the other category': 'Нельзя — ты уже выиграл в другой категории.',
  'bidding has ended': 'Приём заявок уже завершён.',
};
const claimErrorMessage = (message: string) => CLAIM_ERROR_MESSAGES[message] ?? message;

const renderWinners = (label: string, winners: Winner[]) => `
  <details class="winners">
    <summary>${label} (${winners.length})</summary>
    <p>${winners.map(winnerLabel).join(', ')}</p>
  </details>`;

export async function renderPool(root: HTMLElement) {
  if (countdownTimer) clearInterval(countdownTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (eventSource) eventSource.close();
  root.innerHTML = '<p class="spinner-text">Загрузка…</p>';

  const data = await apiFetch('/events/current');
  if (!data.event) {
    root.innerHTML = '<p class="empty-state">Пока нет активного ивента.</p>';
    // No event yet doesn't mean none ever will be — an admin starting one should show up
    // here right away rather than leaving the viewer stuck on this screen until they
    // manually reopen the app.
    eventSource = new EventSource('/stream');
    eventSource.onmessage = () => renderPool(root);
    return;
  }

  root.innerHTML = `
    <p id="deadline" class="countdown"></p>
    <div class="lots"></div>
  `;

  const deadlineEl = root.querySelector('#deadline') as HTMLElement;
  const deadlineAt: Date | null = data.event.deadlineAt ? new Date(data.event.deadlineAt) : null;
  let biddingClosed = deadlineAt ? deadlineAt.getTime() < Date.now() : false;

  const allItems = data.items as Item[];
  const listEl = root.querySelector('.lots') as HTMLElement;

  // Invasion's blue lots allow winning up to 2 units per event (see winLimitGroup in
  // events.ts), so — unlike every other lot, claimed one unit at a time — a blue lot with
  // at least 2 left offers a quick -1+ stepper to reserve both in a single claim. This only
  // applies under the invasion win-limit rule: feast groups its cap by category instead, so
  // a feast lot's color says nothing about how many of it one person may take.
  const claimControl = (item: Item) => {
    const maxPick = Math.min(item.quantity, 2);
    if (item.template === 'invasion' && item.color === 'blue' && maxPick > 1) {
      return `
        <div class="claim-stepper" data-max="${maxPick}" data-qty="1">
          <button type="button" data-action="stepper-dec" class="btn-sm btn-secondary">−</button>
          <span class="claim-stepper__value">1</span>
          <button type="button" data-action="stepper-inc" class="btn-sm btn-secondary">+</button>
          <button type="button" data-action="claim" class="btn-sm">Забрать</button>
        </div>`;
    }
    return `<button data-action="claim" class="btn-sm">Ставка</button>`;
  };

  const renderItem = (item: Item) => `
      <div class="lot-row" data-id="${item.id}" style="border-left: 4px solid ${item.status === 'auctioned' ? 'var(--text-muted)' : colorHex(item.color)}">
        <img src="/uploads/${item.imagePath}" alt="${escapeHtml(item.name) || 'Лот'}" />
        <div class="lot-row__info">
          ${item.name ? `<p class="lot-row__name">${escapeHtml(item.name)}</p>` : ''}
          ${item.quantity > 1 ? `<span class="qty-tag">×${item.quantity}</span>` : ''}
        </div>
        ${
          item.status === 'auctioned'
            ? `${
                item.winners.length > 0 ? renderWinners('Забрали', item.winners) : `<p class="badge">Раскуплено: —</p>`
              }${
                item.claimedByMe && !biddingClosed
                  ? `<button data-action="unclaim" class="btn-sm btn-secondary">Отменить</button>`
                  : ''
              }`
            : biddingClosed
              ? item.winners.length > 0
                ? renderWinners('Приём заявок завершён', item.winners)
                : `<p class="badge">Приём заявок окончен</p>`
              : item.claimedByMe
                ? `<button data-action="unclaim" class="btn-sm btn-secondary">Отменить</button>`
                : claimControl(item)
        }
      </div>`;

  function renderList() {
    // A background poll can land while someone has bumped a stepper to 2 but not yet
    // pressed "Забрать" — rebuilding the row from scratch would silently reset their pick
    // back to 1, and they'd claim less than they meant to without noticing. Snapshot every
    // stepper's current pick before the rebuild and restore it after, clamped to whatever
    // the item's new max allows (it may have shrunk if someone else claimed a unit).
    const pickedQty = new Map<number, number>();
    listEl.querySelectorAll('.lot-row').forEach((row) => {
      const stepper = row.querySelector('.claim-stepper') as HTMLElement | null;
      if (stepper) pickedQty.set(Number((row as HTMLElement).dataset.id), Number(stepper.dataset.qty));
    });

    listEl.innerHTML = allItems.length === 0 ? '<p class="empty-state">Лоты ещё не загружены</p>' : allItems.map(renderItem).join('');

    listEl.querySelectorAll('.lot-row').forEach((row) => {
      const id = Number((row as HTMLElement).dataset.id);
      const picked = pickedQty.get(id);
      const stepper = row.querySelector('.claim-stepper') as HTMLElement | null;
      if (picked === undefined || !stepper) return;
      const restored = Math.min(picked, Number(stepper.dataset.max));
      stepper.dataset.qty = String(restored);
      (stepper.querySelector('.claim-stepper__value') as HTMLElement).textContent = String(restored);
    });

    // Stepper +/- only adjusts local state (how many units the confirm click below will
    // request) — no network call until "Забрать"/"Ставка"/"Отменить" is actually pressed.
    listEl.querySelectorAll('[data-action="stepper-inc"], [data-action="stepper-dec"]').forEach((button) => {
      button.addEventListener('click', () => {
        const stepper = button.closest('.claim-stepper') as HTMLElement;
        const max = Number(stepper.dataset.max);
        const current = Number(stepper.dataset.qty);
        const next = button.getAttribute('data-action') === 'stepper-inc' ? Math.min(max, current + 1) : Math.max(1, current - 1);
        stepper.dataset.qty = String(next);
        (stepper.querySelector('.claim-stepper__value') as HTMLElement).textContent = String(next);
      });
    });

    listEl.querySelectorAll('[data-action="claim"], [data-action="unclaim"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.lot-row') as HTMLElement;
        const id = Number(itemEl.dataset.id);
        const action = button.getAttribute('data-action');
        const stepper = itemEl.querySelector('.claim-stepper') as HTMLElement | null;
        const quantity = stepper ? Number(stepper.dataset.qty) : 1;
        try {
          await apiFetch(`/items/${id}/claim`, {
            method: action === 'claim' ? 'POST' : 'DELETE',
            ...(action === 'claim' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quantity }) } : {}),
          });
          // Refetch and re-render just the list in place — reloading the whole page
          // here (as this used to, via renderPool) resets scroll to the top, forcing
          // the user to scroll back down to find the lot they just bid on.
          const fresh = await apiFetch('/events/current');
          allItems.splice(0, allItems.length, ...(fresh.items as Item[]));
          renderList();
        } catch (err) {
          alert(claimErrorMessage((err as Error).message));
          // The click landed on stale state (someone else got there first, or the count
          // shrank) — pull the real state right now instead of leaving the same stale
          // button up for another click to bounce off, or making the user wait for the
          // next push/poll tick.
          refreshIfChanged();
        }
      });
    });
  }

  renderList();

  const updateCountdown = () => {
    if (!deadlineAt) {
      deadlineEl.style.display = 'none';
      return;
    }
    const msLeft = deadlineAt.getTime() - Date.now();
    deadlineEl.textContent =
      msLeft > 0
        ? `⏳ Приём заявок до ${deadlineAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
        : 'Приём заявок окончен';
    // Only the transition matters — re-rendering every tick would fight the user's
    // scroll position for no reason once nothing has changed.
    if (msLeft <= 0 && !biddingClosed) {
      biddingClosed = true;
      renderList();
    }
  };
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);

  async function refreshIfChanged() {
    if (document.hidden) return;
    let fresh;
    try {
      fresh = await apiFetch('/events/current');
    } catch {
      return; // transient network hiccup — try again next time, don't interrupt the user
    }
    // The event itself changed (a new one started, this one was deleted, or its deadline
    // moved) — simplest correct thing is to reload the whole view rather than patch it.
    if (fresh.event?.id !== data.event.id || fresh.event?.deadlineAt !== data.event.deadlineAt) {
      renderPool(root);
      return;
    }
    const freshItems = fresh.items as Item[];
    if (JSON.stringify(freshItems) !== JSON.stringify(allItems)) {
      allItems.splice(0, allItems.length, ...freshItems);
      renderList();
    }
  }

  pollTimer = setInterval(refreshIfChanged, POLL_FALLBACK_MS);

  eventSource = new EventSource('/stream');
  eventSource.onmessage = refreshIfChanged;
}
