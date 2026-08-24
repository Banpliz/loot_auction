// web/views/pool.ts
import { apiFetch } from '../api';

interface Item {
  id: number;
  name: string;
  imagePath: string;
  status: 'pool' | 'auctioned' | 'removed';
  winnerNickname: string | null;
  claimedByMe: number;
}

let countdownTimer: ReturnType<typeof setInterval> | undefined;

export async function renderPool(root: HTMLElement) {
  if (countdownTimer) clearInterval(countdownTimer);
  root.innerHTML = '<p>Загрузка...</p>';

  const data = await apiFetch('/events/current');
  if (!data.event) {
    root.innerHTML = '<p>Пока нет активного ивента.</p>';
    return;
  }

  root.innerHTML = `<p id="deadline"></p><div class="items"></div>`;

  const deadlineEl = root.querySelector('#deadline') as HTMLElement;
  const deadlineAt: Date | null = data.event.deadlineAt ? new Date(data.event.deadlineAt) : null;
  const updateCountdown = () => {
    if (!deadlineAt) {
      deadlineEl.textContent = '';
      return;
    }
    const msLeft = deadlineAt.getTime() - Date.now();
    deadlineEl.textContent =
      msLeft > 0
        ? `Приём заявок до ${deadlineAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
        : 'Приём заявок окончен';
  };
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);

  const itemsEl = root.querySelector('.items') as HTMLElement;
  itemsEl.innerHTML = (data.items as Item[])
    .map(
      (item) => `
      <div class="item" data-id="${item.id}">
        <img src="/uploads/${item.imagePath}" alt="${item.name}" />
        <p>${item.name}</p>
        ${
          item.status === 'auctioned'
            ? `<p class="badge">Разыграно: ${item.winnerNickname ?? '—'}</p>`
            : `<button data-action="${item.claimedByMe ? 'unclaim' : 'claim'}">${
                item.claimedByMe ? 'Отказаться' : 'Хочу'
              }</button>`
        }
      </div>`
    )
    .join('');

  itemsEl.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', async () => {
      const itemEl = button.closest('.item') as HTMLElement;
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
