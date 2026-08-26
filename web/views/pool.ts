// web/views/pool.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';
import { colorHex } from '../format';

interface Item {
  id: number;
  name: string;
  price: string;
  color: string;
  imagePath: string;
  status: 'pool' | 'auctioned' | 'removed';
  winnerNickname: string | null;
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
    <input id="search" type="search" placeholder="Поиск лота по названию…" />
    <div class="lots"></div>
  `;

  const deadlineEl = root.querySelector('#deadline') as HTMLElement;
  const deadlineAt: Date | null = data.event.deadlineAt ? new Date(data.event.deadlineAt) : null;
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
  };
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);

  const allItems = data.items as Item[];
  const listEl = root.querySelector('.lots') as HTMLElement;
  const renderItem = (item: Item) => `
      <div class="lot-row" data-id="${item.id}" style="border-left: 4px solid ${colorHex(item.color)}">
        <img src="/uploads/${item.imagePath}" alt="${escapeHtml(item.name)}" />
        <div class="lot-row__info">
          <p class="lot-row__name">${escapeHtml(item.name) || '—'}</p>
          ${item.price ? `<span class="price-tag">🪙 ${escapeHtml(item.price)}</span>` : ''}
        </div>
        ${
          item.status === 'auctioned'
            ? `<p class="badge">Разыграно: ${item.winnerNickname ? escapeHtml(item.winnerNickname) : '—'}</p>`
            : `<button data-action="${item.claimedByMe ? 'unclaim' : 'claim'}" class="btn-sm ${item.claimedByMe ? 'btn-secondary' : ''}">${
                item.claimedByMe ? 'Отменить' : 'Ставка'
              }</button>`
        }
      </div>`;

  function renderFiltered(query: string) {
    const matches = allItems.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));
    listEl.innerHTML =
      allItems.length === 0
        ? '<p class="empty-state">Лоты ещё не загружены</p>'
        : matches.length === 0
          ? '<p class="empty-state">Ничего не найдено</p>'
          : matches.map(renderItem).join('');

    listEl.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.lot-row') as HTMLElement;
        const id = itemEl.dataset.id;
        const action = button.getAttribute('data-action');
        try {
          await apiFetch(`/items/${id}/claim`, { method: action === 'claim' ? 'POST' : 'DELETE' });
          await renderPool(root);
        } catch (err) {
          alert((err as Error).message);
        }
      });
    });
  }

  (root.querySelector('#search') as HTMLInputElement).addEventListener('input', (e) => {
    renderFiltered((e.target as HTMLInputElement).value);
  });

  renderFiltered('');
}
