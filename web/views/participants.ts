// web/views/participants.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';

interface Participant {
  telegramId: number;
  username: string | null;
  gameNickname: string | null;
  status: 'pending' | 'approved' | 'banned';
}

const whoLabel = (p: Participant) =>
  `${escapeHtml(p.gameNickname ?? '—')}${p.username ? ` (@${escapeHtml(p.username)})` : ''}`;

export async function renderParticipants(root: HTMLElement) {
  root.innerHTML = '<p class="spinner-text">Загрузка…</p>';

  async function load() {
    const { participants } = (await apiFetch('/participants')) as { participants: Participant[] };
    const pending = participants.filter((p) => p.status === 'pending' && p.gameNickname);
    const approved = participants.filter((p) => p.status === 'approved');
    const banned = participants.filter((p) => p.status === 'banned');

    root.innerHTML = `
      <section>
        <h3>Заявки на рассмотрении</h3>
        <div id="pending-list">${
          pending.length === 0
            ? '<p class="empty-state">Нет новых заявок</p>'
            : pending
                .map(
                  (p) => `
              <div class="admin-item" data-id="${p.telegramId}">
                <p>${whoLabel(p)}</p>
                <div class="admin-item-actions">
                  <button class="btn-sm" data-action="approve">Одобрить</button>
                  <button class="btn-danger btn-sm" data-action="ban">Отклонить</button>
                </div>
              </div>`
                )
                .join('')
        }</div>
      </section>
      <section>
        <h3>Участники</h3>
        <div id="approved-list">${
          approved.length === 0
            ? '<p class="empty-state">Пока никого нет</p>'
            : approved
                .map(
                  (p) => `
              <div class="admin-item" data-id="${p.telegramId}">
                <p>${whoLabel(p)}</p>
                <div class="admin-item-actions">
                  <button class="btn-danger btn-sm" data-action="ban">Исключить</button>
                </div>
              </div>`
                )
                .join('')
        }</div>
      </section>
      <section>
        <h3>Отклонённые / исключённые</h3>
        <div id="banned-list">${
          banned.length === 0
            ? '<p class="empty-state">Список пуст</p>'
            : banned
                .map(
                  (p) => `
              <div class="admin-item" data-id="${p.telegramId}">
                <p>${whoLabel(p)}</p>
                <div class="admin-item-actions">
                  <button class="btn-secondary btn-sm" data-action="unban">Вернуть в очередь</button>
                </div>
              </div>`
                )
                .join('')
        }</div>
      </section>
      <p id="participants-error" class="error"></p>
    `;

    root.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const telegramId = (button.closest('.admin-item') as HTMLElement).dataset.id;
        const action = button.getAttribute('data-action');
        try {
          await apiFetch(`/participants/${telegramId}/${action}`, { method: 'POST' });
          await load();
        } catch (err) {
          (root.querySelector('#participants-error') as HTMLElement).textContent = (err as Error).message;
        }
      });
    });
  }

  await load();
}
