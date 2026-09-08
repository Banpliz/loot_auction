// web/views/results.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';
import { ITEM_COLORS, colorHex } from '../format';

interface Won {
  name: string;
  color: string;
  imagePath: string;
  quantity: number;
}

interface Participant {
  telegramId: number;
  nickname: string | null;
  won: Won[];
}

// Most lots never get a name typed in by the admin (see HANDOFF.md) — falling back to
// "без названия" for every single one of them just repeats the same useless word down
// the whole list, so fall back to the color instead, at least telling entries apart.
const wonLabel = (w: Won) => {
  const label = escapeHtml(w.name) || ITEM_COLORS.find((c) => c.value === w.color)?.label || '?';
  return `
    <span class="results-row__won-item">
      <img src="/uploads/${w.imagePath}" alt="" />
      <span style="color:${colorHex(w.color)}">${label}${w.quantity > 1 ? ` ×${w.quantity}` : ''}</span>
    </span>`;
};

export async function renderResults(root: HTMLElement, eventId: number, onBack: () => void) {
  root.innerHTML = '<p class="spinner-text">Загрузка…</p>';
  const { results } = (await apiFetch(`/events/${eventId}/results`)) as { results: Participant[] };

  root.innerHTML = `
    <button id="back-btn" class="back-btn">← К лотам</button>
    <section>
      <h3>Итоги аукциона</h3>
      ${
        results.length === 0
          ? '<p class="empty-state">Никто не подавал заявок в этом ивенте.</p>'
          : `<div class="results-list">
              ${results
                .map(
                  (p) => `
                <div class="results-row">
                  <span class="results-row__name">${escapeHtml(p.nickname ?? '—')}</span>
                  <span class="results-row__won">${p.won.length === 0 ? '—' : p.won.map(wonLabel).join(', ')}</span>
                </div>`
                )
                .join('')}
            </div>`
      }
    </section>
  `;

  (root.querySelector('#back-btn') as HTMLButtonElement).addEventListener('click', onBack);
}
