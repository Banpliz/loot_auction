// web/views/pool.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';
import { colorHex } from '../format';

interface Winner {
  telegramId: number;
  nickname: string | null;
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
  const renderItem = (item: Item) => `
      <div class="lot-row" data-id="${item.id}" style="border-left: 4px solid ${item.status === 'auctioned' ? 'var(--border)' : colorHex(item.color)}">
        <img src="/uploads/${item.imagePath}" alt="${escapeHtml(item.name) || 'Лот'}" />
        <div class="lot-row__info">
          ${item.name ? `<p class="lot-row__name">${escapeHtml(item.name)}</p>` : ''}
          ${item.quantity > 1 ? `<span class="qty-tag">×${item.quantity}</span>` : ''}
        </div>
        ${
          item.status === 'auctioned'
            ? item.winners.length > 0
              ? `<details class="winners">
                   <summary>Забрали (${item.winners.length})</summary>
                   <p>${item.winners.map((w) => escapeHtml(w.nickname ?? '—')).join(', ')}</p>
                 </details>`
              : `<p class="badge">Раскуплено: —</p>`
            : biddingClosed
              ? `<p class="badge">Приём заявок окончен</p>`
              : item.claimedByMe
                ? `<button data-action="unclaim" class="btn-sm btn-secondary">Отменить</button>`
                : `<button data-action="claim" class="btn-sm">Ставка</button>`
        }
      </div>`;

  function renderList() {
    listEl.innerHTML = allItems.length === 0 ? '<p class="empty-state">Лоты ещё не загружены</p>' : allItems.map(renderItem).join('');

    listEl.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.lot-row') as HTMLElement;
        const id = Number(itemEl.dataset.id);
        const action = button.getAttribute('data-action');
        try {
          await apiFetch(`/items/${id}/claim`, { method: action === 'claim' ? 'POST' : 'DELETE' });
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
