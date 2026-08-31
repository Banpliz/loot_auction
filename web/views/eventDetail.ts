// web/views/eventDetail.ts
import { apiFetch } from '../api';
import { getTelegramWebApp } from '../telegram';
import { escapeHtml } from '../escape-html';
import { ITEM_COLORS, ITEM_CATEGORIES, colorHex } from '../format';

interface Winner {
  telegramId: number;
  nickname: string | null;
}

interface AdminItem {
  id: number;
  name: string;
  color: string;
  category: string;
  quantity: number;
  imagePath: string;
  status: 'pool' | 'auctioned' | 'removed';
  winners: Winner[];
}

const STATUS_LABEL: Record<string, string> = { pool: 'В пуле', auctioned: 'Раскуплено', removed: 'Убран' };
const EVENT_STATUS_LABEL: Record<string, string> = { draft: 'Черновик', open: 'Открыт', resolved: 'Завершён' };

// Real phone screenshots can be several MB — over a slow/unstable mobile connection
// through the ngrok tunnel that's long enough to drop mid-transfer (the actual cause of
// the upload 503s: the connection breaks before the file even fully arrives, independent
// of how long the server takes to process it). Re-encoding as a smaller JPEG cuts the
// transfer time proportionally; extraction reads proportional crop boxes, so shrinking
// doesn't affect accuracy. This alone can't fix a genuinely bad connection — see the
// retry loop below for that.
async function compressForUpload(file: File, maxWidth = 720, quality = 0.7): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), 'image/jpeg', quality);
  });
}

export async function renderEventDetail(root: HTMLElement, eventId: number, onBack: () => void) {
  root.innerHTML = '<p class="spinner-text">Загрузка…</p>';
  const data = await apiFetch(`/events/${eventId}`);

  const status: 'draft' | 'open' | 'resolved' = data.event.status;

  root.innerHTML = `
    <button id="back-btn" class="back-btn">← Все ивенты</button>
    <section>
      <div class="section-title">
        <h3>${escapeHtml(data.event.title)}</h3>
        <span class="status-pill">${EVENT_STATUS_LABEL[status] ?? status}</span>
      </div>
      <p style="color:var(--text-muted)">
        ${data.event.deadlineAt ? `Приём заявок до ${new Date(data.event.deadlineAt).toLocaleString('ru-RU')}` : ''}
      </p>
    </section>
    ${
      status === 'draft'
        ? `
    <section>
      <h3>Загрузить скриншоты аукциона</h3>
      <p style="color:var(--text-muted);font-size:0.85rem">
        Можно выбрать сразу несколько скриншотов — все они должны показывать одинаковое
        количество строк. Приложение порежет их на лоты, определит цвет редкости и само
        объединит одинаковые на вид предметы в один лот с количеством («Кол-во»). Ставка
        бронирует один экземпляр лота сразу — кто раньше нажал, тому и досталось; когда
        «Кол-во» дойдёт до нуля, лот станет серым и недоступным для ставок. Проверь
        получившееся кол-во и поправь, если распозналось не то. Название не распознаётся
        автоматически — впиши вручную только если по иконке не понятно, что за лот
        (например, у сундуков одного вида, но разного уровня — учти, что такие лоты тоже
        объединятся в один, раз иконка совпадает, так что кол-во и пометку для них стоит
        проверить особенно внимательно). Цену не показываем — участники и так видят её в
        игре. Редактировать лоты можно, пока не нажата «Начать аукцион» — после старта
        список блокируется.
      </p>
      <form id="screenshot-form">
        <div class="field-row">
          <input name="rows" type="number" min="1" max="50" placeholder="Строк на каждом скрине" required />
          <select name="template" required>
            <option value="feast">Пир победы</option>
            <option value="invasion">Аукцион вторжения</option>
          </select>
        </div>
        <input name="file" type="file" accept="image/*" multiple required />
        <button type="submit" class="btn-block">Загрузить</button>
      </form>
      <p id="upload-error" class="error"></p>
      <p id="upload-status" style="color:var(--text-muted);font-size:0.85rem"></p>
    </section>`
        : ''
    }
    <section>
      <div class="section-title"><h3>Лоты</h3></div>
      ${status === 'draft' ? `<input id="lot-search" type="search" placeholder="Поиск лота по названию…" />` : ''}
      <div id="event-items"></div>
      ${
        status === 'draft'
          ? `
      <label style="margin-top:0.75rem">Длительность приёма заявок (в минутах)
        <input id="start-duration" type="number" min="1" value="25" required />
      </label>
      <button id="start-btn" class="btn-block" style="margin-top:0.5rem">Начать аукцион</button>
      <p id="start-error" class="error"></p>`
          : status === 'open'
            ? `
      <button id="finish-btn" class="btn-block" style="margin-top:0.75rem">Завершить аукцион</button>
      <p id="finish-error" class="error"></p>`
            : ''
      }
    </section>
  `;

  (root.querySelector('#back-btn') as HTMLButtonElement).addEventListener('click', onBack);

  let allItems: AdminItem[] = [];
  // Set while admin is picking a merge target: escape hatch for dedup misses across
  // separate screenshot uploads (see dedup.ts) — the algorithm can't always tell
  // "same item, different photo" from "different item" reliably, so admin merges
  // by hand. Click "Слить" on the duplicate, then "Сюда" on the lot to keep.
  let mergeSourceId: number | null = null;

  function renderItemsFiltered(query: string) {
    const itemsEl = root.querySelector('#event-items') as HTMLElement;
    if (allItems.length === 0) {
      itemsEl.innerHTML = '<p class="empty-state">Пока нет лотов — загрузи скриншот выше</p>';
      return;
    }
    const matches = allItems.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));
    if (matches.length === 0) {
      itemsEl.innerHTML = '<p class="empty-state">Ничего не найдено</p>';
      return;
    }
    itemsEl.innerHTML = `<div class="items">${matches
      .map((item) => {
        const isSource = item.id === mergeSourceId;
        const mergeButton =
          item.status !== 'pool'
            ? ''
            : isSource
              ? '<button class="btn-secondary btn-sm" data-action="merge-cancel">Отмена</button>'
              : mergeSourceId !== null
                ? '<button class="btn btn-sm" data-action="merge-target">Сюда</button>'
                : '<button class="btn-secondary btn-sm" data-action="merge-start">Слить</button>';
        return `
        <div class="admin-item${isSource ? ' admin-item-merge-source' : ''}" data-id="${item.id}" style="border-left: 4px solid ${colorHex(item.color)}">
          <img src="/uploads/${item.imagePath}" />
          <input value="${escapeHtml(item.name)}" data-role="name" placeholder="Пометка (не обязательно, напр. «III»)" />
          <div class="field-row">
            <input value="${item.quantity}" data-role="quantity" type="number" min="1" placeholder="Кол-во" />
            <select data-role="color">
              ${ITEM_COLORS.map(
                (c) => `<option value="${c.value}" ${item.color === c.value ? 'selected' : ''}>${c.label}</option>`
              ).join('')}
            </select>
            <select data-role="category" title="Только для пира победы: лимит на камни закалки — 3, на остальное — 1">
              ${ITEM_CATEGORIES.map(
                (c) => `<option value="${c.value}" ${item.category === c.value ? 'selected' : ''}>${c.label}</option>`
              ).join('')}
            </select>
          </div>
          <span class="status-pill">${STATUS_LABEL[item.status]}${
            item.winners.length > 0 ? ' · ' + item.winners.map((w) => escapeHtml(w.nickname ?? '—')).join(', ') : ''
          }</span>
          <div class="admin-item-actions">
            <button class="btn-secondary btn-sm" data-action="save">Сохранить</button>
            <button class="btn-danger btn-sm" data-action="remove">Убрать</button>
            ${mergeButton}
          </div>
        </div>`;
      })
      .join('')}</div>`;

    itemsEl.querySelectorAll('[data-action="save"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.admin-item') as HTMLElement;
        const name = (itemEl.querySelector('[data-role="name"]') as HTMLInputElement).value;
        const color = (itemEl.querySelector('[data-role="color"]') as HTMLSelectElement).value;
        const category = (itemEl.querySelector('[data-role="category"]') as HTMLSelectElement).value;
        const quantity = Number((itemEl.querySelector('[data-role="quantity"]') as HTMLInputElement).value) || 1;
        try {
          await apiFetch(`/items/${itemEl.dataset.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, color, category, quantity }),
          });
        } catch (err) {
          (root.querySelector('#upload-error') as HTMLElement).textContent = (err as Error).message;
        }
      });
    });

    itemsEl.querySelectorAll('[data-action="remove"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.admin-item') as HTMLElement;
        try {
          await apiFetch(`/items/${itemEl.dataset.id}`, { method: 'DELETE' });
          await loadItems();
        } catch (err) {
          (root.querySelector('#upload-error') as HTMLElement).textContent = (err as Error).message;
        }
      });
    });

    itemsEl.querySelectorAll('[data-action="merge-start"]').forEach((button) => {
      button.addEventListener('click', () => {
        const itemEl = button.closest('.admin-item') as HTMLElement;
        mergeSourceId = Number(itemEl.dataset.id);
        renderItemsFiltered((root.querySelector('#lot-search') as HTMLInputElement).value);
      });
    });

    itemsEl.querySelectorAll('[data-action="merge-cancel"]').forEach((button) => {
      button.addEventListener('click', () => {
        mergeSourceId = null;
        renderItemsFiltered((root.querySelector('#lot-search') as HTMLInputElement).value);
      });
    });

    itemsEl.querySelectorAll('[data-action="merge-target"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.admin-item') as HTMLElement;
        const sourceId = mergeSourceId;
        mergeSourceId = null;
        try {
          await apiFetch(`/items/${sourceId}/merge`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ intoId: Number(itemEl.dataset.id) }),
          });
          await loadItems();
        } catch (err) {
          (root.querySelector('#upload-error') as HTMLElement).textContent = (err as Error).message;
          renderItemsFiltered((root.querySelector('#lot-search') as HTMLInputElement).value);
        }
      });
    });
  }

  function renderReadOnlyItems() {
    const itemsEl = root.querySelector('#event-items') as HTMLElement;
    if (allItems.length === 0) {
      itemsEl.innerHTML = '<p class="empty-state">Лотов нет</p>';
      return;
    }
    itemsEl.innerHTML = `<div class="items">${allItems
      .map((item) => {
        const colorLabel = ITEM_COLORS.find((c) => c.value === item.color)?.label ?? item.color;
        const categoryLabel = ITEM_CATEGORIES.find((c) => c.value === item.category)?.label ?? item.category;
        return `
        <div class="admin-item" data-id="${item.id}">
          <img src="/uploads/${item.imagePath}" />
          <p>${escapeHtml(item.name) || '—'}</p>
          <span class="status-pill">
            ${colorLabel} · ${categoryLabel} · Осталось ${item.quantity} · ${STATUS_LABEL[item.status]}
            ${item.winners.length > 0 ? ' · ' + item.winners.map((w) => escapeHtml(w.nickname ?? '—')).join(', ') : ''}
          </span>
        </div>`;
      })
      .join('')}</div>`;
  }

  async function loadItems() {
    const current = await apiFetch(`/events/${eventId}`);
    allItems = current.items;
    if (status === 'draft') {
      renderItemsFiltered((root.querySelector('#lot-search') as HTMLInputElement).value);
    } else {
      renderReadOnlyItems();
    }
  }

  if (status === 'draft') {
    (root.querySelector('#lot-search') as HTMLInputElement).addEventListener('input', (e) => {
      renderItemsFiltered((e.target as HTMLInputElement).value);
    });
  }

  if (status === 'draft') {
    (root.querySelector('#screenshot-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
      const errorEl = root.querySelector('#upload-error') as HTMLElement;
      const statusEl = root.querySelector('#upload-status') as HTMLElement;
      errorEl.textContent = '';
      statusEl.textContent = '';

      const rows = (form.elements.namedItem('rows') as HTMLInputElement).value;
      const template = (form.elements.namedItem('template') as HTMLSelectElement).value;
      const files = Array.from((form.elements.namedItem('file') as HTMLInputElement).files ?? []);
      if (files.length === 0) return;

      submitBtn.disabled = true;
      const failed: string[] = [];
      const webApp = getTelegramWebApp();

      const MAX_ATTEMPTS = 3;

      // One screenshot per request, uploaded one at a time — a big multipart body with
      // many real screenshots is exactly what was timing out (mobile connection / ngrok
      // tunnel dropping mid-transfer on a large upload). Small requests are far less
      // likely to get cut off, and a single failed file doesn't take the rest down with it.
      // Each file also gets a few retries — on a flaky connection a dropped attempt often
      // just succeeds on the next try, without the admin having to notice and redo it.
      for (let i = 0; i < files.length; i++) {
        let lastError: Error | undefined;
        let succeeded = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !succeeded; attempt++) {
          const attemptLabel = attempt > 1 ? ` (попытка ${attempt} из ${MAX_ATTEMPTS})` : '';
          try {
            statusEl.textContent = `Сжимаю ${i + 1} из ${files.length}${attemptLabel}…`;
            submitBtn.textContent = `Сжимаю ${i + 1} из ${files.length}…`;
            const compressed = await compressForUpload(files[i]);

            statusEl.textContent = `Загружаю ${i + 1} из ${files.length}${attemptLabel}…`;
            submitBtn.textContent = `Загружаю ${i + 1} из ${files.length}…`;
            const fd = new FormData();
            fd.append('rows', rows);
            fd.append('template', template);
            fd.append('file', compressed, files[i].name.replace(/\.\w+$/, '.jpg'));

            const res = await fetch(`/api/events/${eventId}/screenshots`, {
              method: 'POST',
              headers: { 'x-telegram-init-data': webApp.initData },
              body: fd,
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({ error: `Ошибка ${res.status}` }));
              throw new Error(body.error ?? `Ошибка ${res.status}`);
            }
            await loadItems();
            succeeded = true;
          } catch (err) {
            lastError = err as Error;
            if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
          }
        }

        if (!succeeded) failed.push(`${files[i].name}: ${lastError?.message}`);
      }

      submitBtn.disabled = false;
      submitBtn.textContent = 'Загрузить';
      form.reset();

      if (failed.length > 0) {
        errorEl.textContent = `Не загрузилось (${failed.length} из ${files.length}): ${failed.join('; ')}`;
      }
      const okCount = files.length - failed.length;
      statusEl.textContent = okCount > 0 ? `Загружено ${okCount} из ${files.length}.` : '';
    });
  }

  if (status === 'draft') {
    (root.querySelector('#start-btn') as HTMLButtonElement).addEventListener('click', async () => {
      const durationMinutes = Number((root.querySelector('#start-duration') as HTMLInputElement).value);
      try {
        await apiFetch(`/events/${eventId}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ durationMinutes }),
        });
        renderEventDetail(root, eventId, onBack);
      } catch (err) {
        (root.querySelector('#start-error') as HTMLElement).textContent = (err as Error).message;
      }
    });
  }

  if (status === 'open') {
    (root.querySelector('#finish-btn') as HTMLButtonElement).addEventListener('click', async () => {
      if (!confirm('Завершить приём заявок? Дальше никто не сможет поставить или отменить ставку.')) return;
      try {
        await apiFetch(`/events/${eventId}/finish`, { method: 'POST' });
        renderEventDetail(root, eventId, onBack);
      } catch (err) {
        (root.querySelector('#finish-error') as HTMLElement).textContent = (err as Error).message;
      }
    });
  }

  await loadItems();
}
