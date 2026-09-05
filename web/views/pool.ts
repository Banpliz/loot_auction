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
}

let countdownTimer: ReturnType<typeof setInterval> | undefined;

const winnerLabel = (w: Winner) => escapeHtml(w.nickname ?? '—') + (w.quantity > 1 ? ` ×${w.quantity}` : '');

const renderWinners = (label: string, winners: Winner[]) => `
  <details class="winners">
    <summary>${label} (${winners.length})</summary>
    <p>${winners.map(winnerLabel).join(', ')}</p>
  </details>`;

export async function renderPool(root: HTMLElement) {
  if (countdownTimer) clearInterval(countdownTimer);
  root.innerHTML = '<p class="spinner-text">Загрузка…</p>';

  const data = await apiFetch('/events/current');
  if (!data.event) {
    root.innerHTML = '<p class="empty-state">Пока нет активного ивента.</p>';
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

  // Blue lots allow winning up to 2 units per event (see winLimitGroup in events.ts),
  // so — unlike every other lot, claimed one unit at a time — a blue lot with at least
  // 2 left offers a quick -1+ stepper to reserve both in a single claim. The server still
  // enforces the real cap (someone already holding 1 blue elsewhere gets a plain error).
  const claimControl = (item: Item) => {
    const maxPick = Math.min(item.quantity, 2);
    if (item.color === 'blue' && maxPick > 1) {
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
    listEl.innerHTML = allItems.length === 0 ? '<p class="empty-state">Лоты ещё не загружены</p>' : allItems.map(renderItem).join('');

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
          alert((err as Error).message);
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
}
