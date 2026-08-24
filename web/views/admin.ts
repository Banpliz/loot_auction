// web/views/admin.ts
import { apiFetch } from '../api';
import { getTelegramWebApp } from '../telegram';
import { escapeHtml } from '../escape-html';

export async function renderAdmin(root: HTMLElement) {
  root.innerHTML = `
    <section>
      <h3>Новый ивент</h3>
      <form id="event-form">
        <input name="title" placeholder="Название ивента" required />
        <input name="durationMinutes" type="number" placeholder="Минут на приём заявок" value="25" required />
        <button type="submit">Создать</button>
      </form>
    </section>
    <section>
      <h3>Загрузить скриншот</h3>
      <form id="screenshot-form">
        <input name="rows" type="number" placeholder="Строк" required />
        <input name="cols" type="number" placeholder="Столбцов" required />
        <input name="file" type="file" accept="image/*" required />
        <button type="submit">Нарезать</button>
      </form>
    </section>
    <section>
      <h3>Текущий ивент</h3>
      <div id="event-items"></div>
      <button id="resolve-btn">Разыграть всё</button>
    </section>
    <section>
      <h3>Настройки</h3>
      <form id="settings-form">
        <label>Лимит заявок на человека:
          <input name="maxSimultaneousClaims" type="number" required />
        </label>
        <button type="submit">Сохранить</button>
      </form>
    </section>
    <p id="admin-error" class="error"></p>
  `;

  const errorEl = root.querySelector('#admin-error') as HTMLElement;
  const showError = (err: unknown) => {
    errorEl.textContent = (err as Error).message;
  };

  async function loadEventItems() {
    const current = await apiFetch('/events/current');
    const itemsEl = root.querySelector('#event-items') as HTMLElement;
    if (!current.event) {
      itemsEl.innerHTML = '<p>Нет активного ивента</p>';
      return;
    }
    itemsEl.innerHTML = `<p>${escapeHtml(current.event.title)} — ${current.event.status}</p>` +
      current.items
        .map(
          (item: any) => `
          <div class="admin-item" data-id="${item.id}">
            <img src="/uploads/${item.imagePath}" />
            <input value="${escapeHtml(item.name)}" data-role="name" />
            <button data-action="save-name">Сохранить имя</button>
            <button data-action="remove">Убрать</button>
            <span>${item.status}</span>
          </div>`
        )
        .join('');

    itemsEl.querySelectorAll('[data-action="save-name"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.admin-item') as HTMLElement;
        const name = (itemEl.querySelector('[data-role="name"]') as HTMLInputElement).value;
        try {
          await apiFetch(`/items/${itemEl.dataset.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          });
        } catch (err) {
          showError(err);
        }
      });
    });

    itemsEl.querySelectorAll('[data-action="remove"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.admin-item') as HTMLElement;
        try {
          await apiFetch(`/items/${itemEl.dataset.id}`, { method: 'DELETE' });
          await loadEventItems();
        } catch (err) {
          showError(err);
        }
      });
    });
  }

  (root.querySelector('#event-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      await apiFetch('/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: fd.get('title'), durationMinutes: Number(fd.get('durationMinutes')) }),
      });
      await loadEventItems();
    } catch (err) {
      showError(err);
    }
  });

  (root.querySelector('#screenshot-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    try {
      const current = await apiFetch('/events/current');
      if (!current.event) throw new Error('Сначала создай ивент');
      const webApp = getTelegramWebApp();
      const res = await fetch(`/api/events/${current.event.id}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': webApp.initData },
        body: new FormData(form),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await loadEventItems();
      form.reset();
    } catch (err) {
      showError(err);
    }
  });

  (root.querySelector('#resolve-btn') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      const current = await apiFetch('/events/current');
      if (!current.event) throw new Error('Нет активного ивента');
      await apiFetch(`/events/${current.event.id}/resolve`, { method: 'POST' });
      await loadEventItems();
    } catch (err) {
      showError(err);
    }
  });

  const settingsForm = root.querySelector('#settings-form') as HTMLFormElement;
  const currentSettings = await apiFetch('/settings');
  (settingsForm.elements.namedItem('maxSimultaneousClaims') as HTMLInputElement).value = String(
    currentSettings.maxSimultaneousClaims
  );
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxSimultaneousClaims: Number(new FormData(settingsForm).get('maxSimultaneousClaims')) }),
      });
    } catch (err) {
      showError(err);
    }
  });

  await loadEventItems();
}
