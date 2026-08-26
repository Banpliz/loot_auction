// web/views/admin.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';
import { renderEventDetail } from './eventDetail';

interface EventSummary {
  id: number;
  title: string;
  deadlineAt: string | null;
  status: 'open' | 'resolved';
  itemCount: number;
}

const STATUS_LABEL: Record<string, string> = { open: 'Открыт', resolved: 'Разыгран' };

export async function renderAdmin(root: HTMLElement) {
  await showEventList(root);
}

async function showEventList(root: HTMLElement) {
  root.innerHTML = `
    <section>
      <h3>Новый ивент</h3>
      <form id="event-form">
        <input name="title" placeholder="Название ивента" required />
        <label>Длительность приёма заявок (в минутах)
          <input name="durationMinutes" type="number" min="1" placeholder="Например, 25" value="25" required />
        </label>
        <button type="submit" class="btn-block">Создать ивент</button>
      </form>
      <p id="create-error" class="error"></p>
    </section>
    <section>
      <h3>Ивенты</h3>
      <div id="events-list"><p class="spinner-text">Загрузка…</p></div>
    </section>
  `;

  const showError = (elSelector: string, err: unknown) => {
    (root.querySelector(elSelector) as HTMLElement).textContent = (err as Error).message;
  };

  async function loadEvents() {
    const listEl = root.querySelector('#events-list') as HTMLElement;
    const { events } = (await apiFetch('/events')) as { events: EventSummary[] };
    if (events.length === 0) {
      listEl.innerHTML = '<p class="empty-state">Пока нет ни одного ивента</p>';
      return;
    }
    listEl.innerHTML = events
      .map(
        (event) => `
        <div class="event-card" data-id="${event.id}">
          <div class="event-card-info">
            <div class="event-card-title">${escapeHtml(event.title)}</div>
            <div class="event-card-meta">${STATUS_LABEL[event.status] ?? event.status} · ${event.itemCount} лот(ов)</div>
          </div>
          <div class="event-card-actions">
            <button class="btn-secondary btn-sm" data-action="open">Открыть</button>
            <button class="btn-danger btn-sm" data-action="delete">Удалить</button>
          </div>
        </div>`
      )
      .join('');

    listEl.querySelectorAll('[data-action="open"]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = Number((button.closest('.event-card') as HTMLElement).dataset.id);
        renderEventDetail(root, id, () => showEventList(root));
      });
    });

    listEl.querySelectorAll('[data-action="delete"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('.event-card') as HTMLElement;
        const title = card.querySelector('.event-card-title')!.textContent;
        if (!confirm(`Удалить ивент «${title}»? Это удалит все его лоты и заявки.`)) return;
        try {
          await apiFetch(`/events/${card.dataset.id}`, { method: 'DELETE' });
          await loadEvents();
        } catch (err) {
          showError('#create-error', err);
        }
      });
    });
  }

  (root.querySelector('#event-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const event = await apiFetch('/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: fd.get('title'), durationMinutes: Number(fd.get('durationMinutes')) }),
      });
      form.reset();
      (form.elements.namedItem('durationMinutes') as HTMLInputElement).value = '25';
      renderEventDetail(root, event.id, () => showEventList(root));
    } catch (err) {
      showError('#create-error', err);
    }
  });

  await loadEvents();
}
