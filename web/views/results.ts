// web/views/results.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';
import { colorHex } from '../format';

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

// Most lots never get a name typed in by the admin (see HANDOFF.md) — repeating the
// rarity color as a text label next to every single icon was just as noisy as "без
// названия" was (nearly every lot is the same color). The icon alone tells them apart;
// only a real, admin-typed name is worth showing as text.
const wonLabel = (w: Won) => `
    <span class="results-row__won-item">
      <img src="/uploads/${w.imagePath}" alt="" style="border-color:${colorHex(w.color)}" />
      ${w.name ? `<span>${escapeHtml(w.name)}</span>` : ''}${w.quantity > 1 ? `<span>×${w.quantity}</span>` : ''}
    </span>`;

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
